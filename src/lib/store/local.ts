import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { getEnv } from "@/lib/env";
import type { Entry, EntryInput, UserSettings } from "@/lib/types";
import type { AiUsageResult, Store } from "./types";
import {
  StoreError,
  StoreInputError,
  assertDateOrder,
  assertMonth,
  compareEntriesNewestFirst,
  defaultSettings,
  normaliseCap,
  parseStoredEntry,
  parseStoredSettings,
  validateEntryInput,
  validateEntryPatch,
  validateSettings,
} from "./mapping";

/**
 * Local demo store: one JSON file. Meant for trying the app on one machine, not for hosting.
 *
 * Safety rules:
 *  - Every operation (reads too) goes through one promise queue per file, so two requests in the same
 *    server process cannot interleave and lose each other's changes. The queue is kept on globalThis so
 *    separate route bundles in one Next.js process share it.
 *  - A write goes to a temporary file in the same folder and is renamed over the real file, so a reader
 *    never sees half a file and a crash leaves the old file in place.
 *  - A file that cannot be read as a CPD Logger database is never overwritten. A copy is kept next to it
 *    as "<file>.corrupt-<timestamp>" and the operation fails with a message saying what to do.
 *  - Rows that cannot be used (hand-edited mistakes) are left out of results with a warning that gives a
 *    count only. Before the next write a copy of the original file is kept, so nothing is lost silently.
 *    The same goes for a file that holds only blank space. A leading byte-order mark (some Windows editors add one)
 *    is ignored. A deleted entry whose "deletedAt" was edited into something unreadable stays deleted.
 *  - Those copies hold people's data, so deleteLocalAccount also removes the deleted account from them.
 *  - A deleted account cannot be written to again by a stale session: its id is remembered (as a hash, so the id
 *    itself leaves the file). With the requireAccount option, an id nobody signed in with cannot write either.
 *
 * Limit: the queue protects one server process. Two separate processes writing the same file at once can
 * still lose an update. That is acceptable for a single-user demo and is why this is not the hosted store.
 */

export const DEFAULT_LOCAL_DB_PATH = ".data/local-db.json";

export interface LocalStoreOptions {
  /** Clock, for tests. */
  now?: () => Date;
  /**
   * When true, saving settings, adding entries and counting AI calls fail with "not signed in" unless an account with
   * that id exists (see findOrCreateLocalAccount). Without it, any non-empty id is accepted, which suits direct use and
   * tests; the app should set it so a cookie holding an id nobody signed in with cannot create data. Reads are never refused.
   */
  requireAccount?: boolean;
}

interface AccountRecord {
  id: string;
  createdAt: string;
}

interface UserRecord {
  settings: UserSettings;
  entries: Entry[];
  aiUsage: Map<string, number>;
}

interface Db {
  accounts: Map<string, AccountRecord>;
  users: Map<string, UserRecord>;
  /** Hashes of the ids of deleted accounts, oldest first, so a stale session cannot write for one. */
  deletedAccounts: Set<string>;
  /** Rows left out because they could not be used. */
  dropped: number;
  /** The file held nothing but blank space: keep a copy of it before it is written over. */
  copyBeforeWrite: boolean;
}

interface SharedState {
  queues: Map<string, Promise<void>>;
  warned: Map<string, number>;
  /** Copies already made, by file size and time, so the same bad file is not copied again. Value: the copy's name. */
  backedUp: Map<string, string>;
}

const STATE_KEY = Symbol.for("cpd-logger.local-store.state");

function shared(): SharedState {
  const g = globalThis as unknown as Record<symbol, SharedState | undefined>;
  let state = g[STATE_KEY];
  if (!state) {
    state = { queues: new Map(), warned: new Map(), backedUp: new Map() };
    g[STATE_KEY] = state;
  }
  return state;
}

export function resolveLocalDbPath(filePath?: string): string {
  const configured = filePath ?? getEnv().CPD_LOCAL_DB ?? DEFAULT_LOCAL_DB_PATH;
  return path.resolve(configured);
}

/** Run a task after every earlier task for the same file has finished. A failed task does not block the next. */
function enqueue<T>(file: string, task: () => Promise<T>): Promise<T> {
  const st = shared();
  const previous = st.queues.get(file) ?? Promise.resolve();
  const run = previous.then(task);
  st.queues.set(
    file,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function emptyUser(): UserRecord {
  return { settings: defaultSettings(), entries: [], aiUsage: new Map() };
}

function emptyDb(): Db {
  return { accounts: new Map(), users: new Map(), deletedAccounts: new Set(), dropped: 0, copyBeforeWrite: false };
}

const MAX_DELETED_ACCOUNTS = 10_000;
const HASH_RE = /^[0-9a-f]{64}$/;

/** A one-way fingerprint of an account id. Remembering this, not the id, means deleting an account leaves no id behind. */
function idHash(userId: string): string {
  return createHash("sha256").update(`cpd-logger-account:${userId}`).digest("hex");
}

function rememberDeleted(db: Db, userId: string): void {
  db.deletedAccounts.delete(idHash(userId));
  db.deletedAccounts.add(idHash(userId));
  while (db.deletedAccounts.size > MAX_DELETED_ACCOUNTS) {
    const oldest = db.deletedAccounts.values().next().value;
    if (oldest === undefined) break;
    db.deletedAccounts.delete(oldest);
  }
}

function accountExists(db: Db, userId: string): boolean {
  for (const account of db.accounts.values()) if (account.id === userId) return true;
  return false;
}

/**
 * The "deletedAt" of a stored row. Missing or null means live. A readable time is kept. Anything else was edited by
 * hand into something unreadable: the entry stays deleted (dated by its own last change), because showing a deleted
 * entry again, and exporting it, is worse than hiding one that can still be restored from the bin.
 */
function readDeletedAt(raw: Record<string, unknown>): unknown {
  const value = raw.deletedAt;
  if (value === undefined || value === null) return null;
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return value;
  const usable = [raw.updatedAt, raw.createdAt].find((t): t is string => typeof t === "string" && !Number.isNaN(Date.parse(t)));
  return usable ?? value;
}

// ---------------------------------------------------------------------------------------------
// Reading

function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, "-");
}

/** Copy the file next to itself so nothing is lost. Returns the copy's file name, or null if it could not be made. */
async function keepCopy(file: string, now: Date, kind: "corrupt"): Promise<string | null> {
  try {
    const info = await fs.stat(file);
    const key = `${file}|${info.size}|${info.mtimeMs}`;
    const st = shared();
    const existing = st.backedUp.get(key);
    if (existing) return existing;
    const dest = `${file}.${kind}-${stamp(now)}`;
    await fs.copyFile(file, dest, fs.constants.COPYFILE_EXCL);
    try {
      await fs.chmod(dest, 0o600);
    } catch {
      // Not every file system supports modes.
    }
    st.backedUp.set(key, path.basename(dest));
    return path.basename(dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return path.basename(`${file}.${kind}-${stamp(now)}`);
    return null;
  }
}

function damagedMessage(file: string, copyName: string | null): string {
  const where = path.relative(process.cwd(), file) || file;
  const copy = copyName
    ? `A copy was kept as "${copyName}" next to it.`
    : "A copy could not be made, so make one yourself before you change anything.";
  return (
    `The local database file (${where}) could not be read, so CPD Logger left it exactly as it is. ${copy} ` +
    "Fix the file, or move it away to start with an empty database, then try again."
  );
}

function newerVersionMessage(file: string): string {
  const where = path.relative(process.cwd(), file) || file;
  return `The local database file (${where}) was written by a different version of CPD Logger, so it was left unchanged. Use the matching version, or move the file away to start again.`;
}

function validMonth(m: string): boolean {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(m);
}

function parseDb(parsed: Record<string, unknown>): Db {
  const db = emptyDb();

  const accounts = parsed.accounts;
  if (isRecord(accounts)) {
    for (const [rawEmail, value] of Object.entries(accounts)) {
      const email = rawEmail.trim().toLowerCase();
      if (!isRecord(value) || typeof value.id !== "string" || value.id === "" || typeof value.createdAt !== "string" || email === "" || db.accounts.has(email)) {
        db.dropped += 1;
        continue;
      }
      db.accounts.set(email, { id: value.id, createdAt: value.createdAt });
    }
  }

  const users = parsed.users;
  if (isRecord(users)) {
    for (const [userId, value] of Object.entries(users)) {
      if (!isRecord(value) || userId === "") {
        db.dropped += 1;
        continue;
      }
      const rec = emptyUser();
      rec.settings = parseStoredSettings(value.settings);
      if (Array.isArray(value.entries)) {
        const seen = new Set<string>();
        for (const raw of value.entries) {
          // The owner is the key the row sits under, whatever a hand edit says.
          const entry = isRecord(raw) ? parseStoredEntry({ ...raw, userId, deletedAt: readDeletedAt(raw) }) : null;
          if (!entry || seen.has(entry.id)) {
            db.dropped += 1;
            continue;
          }
          seen.add(entry.id);
          rec.entries.push(entry);
        }
      }
      if (isRecord(value.aiUsage)) {
        for (const [month, n] of Object.entries(value.aiUsage)) {
          if (validMonth(month) && typeof n === "number" && Number.isInteger(n) && n >= 0) rec.aiUsage.set(month, n);
          else db.dropped += 1;
        }
      }
      db.users.set(userId, rec);
    }
  }

  const deleted = parsed.deletedAccounts;
  if (deleted !== undefined) {
    if (Array.isArray(deleted)) {
      for (const hash of deleted) {
        if (typeof hash === "string" && HASH_RE.test(hash)) db.deletedAccounts.add(hash);
        else db.dropped += 1;
      }
    } else {
      db.dropped += 1;
    }
  }
  return db;
}

async function readDb(file: string, now: Date): Promise<Db> {
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyDb();
    throw new StoreError("failed", `The local database file could not be read (${(err as NodeJS.ErrnoException).code ?? "unknown error"}). Check the folder exists and CPD Logger may read it.`);
  }
  if (raw.length === 0) return emptyDb();
  // Some Windows editors put a byte-order mark first. It is not damage.
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
  if (raw.trim() === "") {
    // Blank space only: treat as empty, but keep a copy of it before it is written over.
    const blankDb = emptyDb();
    blankDb.copyBeforeWrite = true;
    return blankDb;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new StoreError("failed", damagedMessage(file, await keepCopy(file, now, "corrupt")));
  }
  if (!isRecord(parsed)) throw new StoreError("failed", damagedMessage(file, await keepCopy(file, now, "corrupt")));
  if (parsed.version !== 1) {
    if (typeof parsed.version === "number" && parsed.version > 1) throw new StoreError("failed", newerVersionMessage(file));
    throw new StoreError("failed", damagedMessage(file, await keepCopy(file, now, "corrupt")));
  }
  if ((parsed.accounts !== undefined && !isRecord(parsed.accounts)) || (parsed.users !== undefined && !isRecord(parsed.users))) {
    throw new StoreError("failed", damagedMessage(file, await keepCopy(file, now, "corrupt")));
  }

  const db = parseDb(parsed);
  if (db.dropped > 0) {
    const st = shared();
    if (st.warned.get(file) !== db.dropped) {
      st.warned.set(file, db.dropped);
      console.warn(`CPD Logger: ${db.dropped} unusable row${db.dropped === 1 ? " was" : "s were"} left out of the local database file. A copy of the file is kept before the next save.`);
    }
  } else {
    shared().warned.delete(file);
  }
  return db;
}

// ---------------------------------------------------------------------------------------------
// Writing

function serialise(db: Db): string {
  const accounts = Object.fromEntries(db.accounts);
  const users = Object.fromEntries(
    [...db.users].map(([id, u]) => [id, { settings: u.settings, entries: u.entries, aiUsage: Object.fromEntries(u.aiUsage) }]),
  );
  const out: Record<string, unknown> = { version: 1, accounts, users };
  if (db.deletedAccounts.size > 0) out.deletedAccounts = [...db.deletedAccounts];
  return JSON.stringify(out, null, 2) + "\n";
}

/** Write a file by way of a temporary file in the same folder, so a reader never sees half of it. Throws the raw error. */
async function writeFileAtomic(target: string, content: string): Promise<void> {
  const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(tmp, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  try {
    await fs.chmod(target, 0o600);
  } catch {
    // Not every file system supports modes.
  }
}

async function writeDb(file: string, db: Db, now: Date): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  if (db.dropped > 0) {
    // The unusable rows are not written back, so keep the original file first.
    const copy = await keepCopy(file, now, "corrupt");
    if (!copy) throw new StoreError("failed", "Some rows in the local database file could not be used and a backup copy could not be made, so nothing was saved. Fix the file or free some disk space, then try again.");
  } else if (db.copyBeforeWrite) {
    const copy = await keepCopy(file, now, "corrupt");
    if (!copy) throw new StoreError("failed", "The local database file held only blank space and a backup copy of it could not be made, so nothing was saved. Move the file away or free some disk space, then try again.");
  }
  try {
    await writeFileAtomic(file, serialise(db));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new StoreError("failed", `The local database file could not be saved${code ? ` (${code})` : ""}. Check there is disk space and CPD Logger may write to the .data folder.`);
  }
}

/** Read, change, and write back only if something changed, all inside the queue. */
function transact<T>(file: string, now: () => Date, fn: (db: Db) => { result: T; changed: boolean }): Promise<T> {
  return enqueue(file, async () => {
    const at = now();
    const db = await readDb(file, at);
    const { result, changed } = fn(db);
    if (changed) await writeDb(file, db, at);
    return result;
  });
}

function requireUser(userId: string): void {
  if (typeof userId !== "string" || userId === "") throw new StoreError("not_signed_in", "You are not signed in. Sign in and try again.");
}

/**
 * The record to write to for this user. Refuses an account that was deleted (a stale session must not bring its data
 * back) and, with requireAccount, an id that no account has.
 */
function getOrCreateUser(db: Db, userId: string, requireAccount: boolean): UserRecord {
  if (db.deletedAccounts.has(idHash(userId)) || (requireAccount && !accountExists(db, userId))) {
    throw new StoreError("not_signed_in", "You are not signed in. Sign in and try again.");
  }
  let rec = db.users.get(userId);
  if (!rec) {
    rec = emptyUser();
    db.users.set(userId, rec);
  }
  return rec;
}

// ---------------------------------------------------------------------------------------------
// The store

export function createLocalStore(filePath?: string, opts: LocalStoreOptions = {}): Store {
  const file = resolveLocalDbPath(filePath);
  const now = opts.now ?? (() => new Date());
  const requireAccount = opts.requireAccount === true;

  /** The input must already have passed validateEntryInput. */
  function build(userId: string, valid: EntryInput, at: string): Entry {
    return { ...valid, id: randomUUID(), userId, createdAt: at, updatedAt: at, deletedAt: null };
  }

  return {
    async getSettings(userId) {
      requireUser(userId);
      return transact(file, now, (db) => ({ result: db.users.get(userId)?.settings ?? defaultSettings(), changed: false }));
    },

    async saveSettings(userId, settings) {
      requireUser(userId);
      const valid = validateSettings(settings);
      return transact(file, now, (db) => {
        getOrCreateUser(db, userId, requireAccount).settings = valid;
        return { result: valid, changed: true };
      });
    },

    async listEntries(userId, opts2) {
      requireUser(userId);
      const includeDeleted = opts2?.includeDeleted === true;
      return transact(file, now, (db) => {
        const entries = (db.users.get(userId)?.entries ?? []).filter((e) => includeDeleted || e.deletedAt === null);
        return { result: [...entries].sort(compareEntriesNewestFirst), changed: false };
      });
    },

    /** Includes soft-deleted entries, so a bin or an undo can show them. Another user's id returns null. */
    async getEntry(userId, id) {
      requireUser(userId);
      return transact(file, now, (db) => ({ result: db.users.get(userId)?.entries.find((e) => e.id === id) ?? null, changed: false }));
    },

    async createEntry(userId, input) {
      requireUser(userId);
      const valid = validateEntryInput(input);
      return transact(file, now, (db) => {
        const entry = build(userId, valid, now().toISOString());
        getOrCreateUser(db, userId, requireAccount).entries.push(entry);
        return { result: entry, changed: true };
      });
    },

    /** All or nothing: if one row is not acceptable, none are saved. */
    async createEntries(userId, inputs) {
      requireUser(userId);
      if (!Array.isArray(inputs)) throw new StoreInputError("The entries must be a list.");
      const valid = inputs.map((i) => validateEntryInput(i));
      if (valid.length === 0) return [];
      return transact(file, now, (db) => {
        const at = now().toISOString();
        const created = valid.map((v) => build(userId, v, at));
        getOrCreateUser(db, userId, requireAccount).entries.push(...created);
        return { result: created, changed: true };
      });
    },

    /** Updates a live entry. A soft-deleted or unknown entry returns null. id, userId, createdAt and deletedAt cannot be changed. */
    async updateEntry(userId, id, patch) {
      requireUser(userId);
      const valid = validateEntryPatch(patch);
      return transact(file, now, (db) => {
        const rec = db.users.get(userId);
        const idx = rec ? rec.entries.findIndex((e) => e.id === id) : -1;
        const current = rec && idx >= 0 ? rec.entries[idx] : undefined;
        if (!rec || !current || current.deletedAt !== null) return { result: null, changed: false };
        if (Object.keys(valid).length === 0) return { result: current, changed: false };
        const next: Entry = { ...current, ...valid, id: current.id, userId: current.userId, createdAt: current.createdAt, deletedAt: null, updatedAt: now().toISOString() };
        assertDateOrder(next.dateCompleted, next.dateEnd);
        rec.entries[idx] = next;
        return { result: next, changed: true };
      });
    },

    async softDeleteEntry(userId, id) {
      requireUser(userId);
      return transact(file, now, (db) => {
        const rec = db.users.get(userId);
        const idx = rec ? rec.entries.findIndex((e) => e.id === id) : -1;
        const current = rec && idx >= 0 ? rec.entries[idx] : undefined;
        if (!rec || !current) return { result: null, changed: false };
        if (current.deletedAt !== null) return { result: current, changed: false };
        const at = now().toISOString();
        const next: Entry = { ...current, deletedAt: at, updatedAt: at };
        rec.entries[idx] = next;
        return { result: next, changed: true };
      });
    },

    async restoreEntry(userId, id) {
      requireUser(userId);
      return transact(file, now, (db) => {
        const rec = db.users.get(userId);
        const idx = rec ? rec.entries.findIndex((e) => e.id === id) : -1;
        const current = rec && idx >= 0 ? rec.entries[idx] : undefined;
        if (!rec || !current) return { result: null, changed: false };
        if (current.deletedAt === null) return { result: current, changed: false };
        const next: Entry = { ...current, deletedAt: null, updatedAt: now().toISOString() };
        rec.entries[idx] = next;
        return { result: next, changed: true };
      });
    },

    /** Removes this user's entries, settings and AI usage. The sign-in account stays; deleteLocalAccount removes that. */
    async deleteAllUserData(userId) {
      requireUser(userId);
      await transact(file, now, (db) => ({ result: undefined, changed: db.users.delete(userId) }));
    },

    async getAiUsage(userId, month, cap): Promise<AiUsageResult> {
      requireUser(userId);
      assertMonth(month);
      const limit = normaliseCap(cap);
      return transact(file, now, (db) => {
        const used = db.users.get(userId)?.aiUsage.get(month) ?? 0;
        return { result: { allowed: used < limit, used, cap: limit }, changed: false };
      });
    },

    /** Adds one call only while used < cap. The check and the add happen in one queued step, so they cannot race. */
    async incrementAiUsage(userId, month, cap): Promise<AiUsageResult> {
      requireUser(userId);
      assertMonth(month);
      const limit = normaliseCap(cap);
      return transact<AiUsageResult>(file, now, (db) => {
        const used = db.users.get(userId)?.aiUsage.get(month) ?? 0;
        if (used >= limit) return { result: { allowed: false, used, cap: limit }, changed: false };
        getOrCreateUser(db, userId, requireAccount).aiUsage.set(month, used + 1);
        return { result: { allowed: true, used: used + 1, cap: limit }, changed: true };
      });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Accounts for the local sign-in cookie flow

export function normaliseEmail(email: string): string {
  const e = typeof email === "string" ? email.trim().toLowerCase() : "";
  if (e.length === 0 || e.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(e)) {
    throw new StoreInputError("Enter a valid email address, for example name@example.com.");
  }
  return e;
}

/**
 * The same random id every time for the same email (lower-cased and trimmed). This is demo-mode sign-in:
 * it does not prove the person owns the address, and the address is only kept in the local file.
 */
export async function findOrCreateLocalAccount(email: string, filePath?: string): Promise<{ id: string; email: string }> {
  const normalised = normaliseEmail(email);
  const file = resolveLocalDbPath(filePath);
  return transact(file, () => new Date(), (db) => {
    const existing = db.accounts.get(normalised);
    if (existing) return { result: { id: existing.id, email: normalised }, changed: false };
    const id = randomUUID();
    db.accounts.set(normalised, { id, createdAt: new Date().toISOString() });
    return { result: { id, email: normalised }, changed: true };
  });
}

/**
 * The account behind a session cookie, or null when there is none (never signed in, or deleted).
 * Read only: it never creates anything, so a stale cookie cannot bring a deleted account back.
 */
export async function getLocalAccountById(userId: string, filePath?: string): Promise<{ id: string; email: string } | null> {
  if (typeof userId !== "string" || userId.length < 8 || userId.length > 64) return null;
  const file = resolveLocalDbPath(filePath);
  return transact(file, () => new Date(), (db) => {
    for (const [email, account] of db.accounts) {
      if (account.id === userId) return { result: { id: account.id, email }, changed: false };
    }
    return { result: null, changed: false };
  });
}

// ---------------------------------------------------------------------------------------------
// Deleting an account

type CopyVerdict = { action: "keep" } | { action: "rewrite"; text: string } | { action: "delete" };

/**
 * Decide what to do with the text of one ".corrupt-" backup copy when an account is deleted.
 * A copy that is still a database has the account (and any other account under the same email) taken out of it and
 * everything else is left as it was. A copy that cannot be read as one (it was kept because it did not parse) cannot
 * be cleaned piece by piece, so it is removed if it mentions the account at all.
 */
function scrubCopyText(raw: string, userId: string, emails: readonly string[]): CopyVerdict {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  const lower = text.toLowerCase();
  const idLower = userId.toLowerCase();
  // A random id is safe to look for anywhere in the text; a short one could match by chance and destroy a good copy.
  const idIsDistinctive = userId.length >= 16;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!isRecord(parsed)) {
    const mentionsEmail = emails.some((e) => e !== "" && lower.includes(e.toLowerCase()));
    return (idIsDistinctive && lower.includes(idLower)) || mentionsEmail ? { action: "delete" } : { action: "keep" };
  }

  const emailSet = new Set(emails.map((e) => e.trim().toLowerCase()));
  const ids = new Set([userId]);
  let changed = false;
  if (isRecord(parsed.accounts)) {
    for (const [key, value] of Object.entries(parsed.accounts)) {
      const accountId = isRecord(value) && typeof value.id === "string" ? value.id : undefined;
      if (accountId === userId || emailSet.has(key.trim().toLowerCase())) {
        if (accountId) ids.add(accountId);
        delete parsed.accounts[key];
        changed = true;
      }
    }
  }
  if (isRecord(parsed.users)) {
    for (const id of ids) {
      if (Object.hasOwn(parsed.users, id)) {
        delete parsed.users[id];
        changed = true;
      }
    }
  }
  const out = changed ? JSON.stringify(parsed, null, 2) + "\n" : text;
  // The id still turns up somewhere else (a row filed under the wrong key, say): that copy cannot be cleaned safely.
  if (idIsDistinctive && out.toLowerCase().includes(idLower)) return { action: "delete" };
  return changed ? { action: "rewrite", text: out } : { action: "keep" };
}

/**
 * Take a deleted account out of every "<file>.corrupt-*" backup copy next to the database. Returns how many copies
 * were changed or removed. Throws if one could not be cleaned, so "delete my account" never claims more than it did.
 */
async function scrubBackupCopies(file: string, userId: string, emails: readonly string[]): Promise<number> {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.corrupt-`;
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw new StoreError("failed", "The account was removed, but the folder holding backup copies of the database could not be read to clean them. Check CPD Logger may read the .data folder, then try again.");
  }
  let touched = 0;
  const failed: string[] = [];
  for (const name of names.filter((n) => n.startsWith(prefix)).sort()) {
    const copy = path.join(dir, name);
    try {
      const verdict = scrubCopyText(await fs.readFile(copy, "utf8"), userId, emails);
      if (verdict.action === "rewrite") await writeFileAtomic(copy, verdict.text);
      else if (verdict.action === "delete") await fs.rm(copy, { force: true });
      if (verdict.action !== "keep") touched += 1;
    } catch {
      failed.push(name);
    }
  }
  if (failed.length > 0) {
    throw new StoreError(
      "failed",
      `The account was removed, but ${failed.length === 1 ? "a backup copy" : "some backup copies"} of the database (${failed.join(", ")}) could not be cleaned of its data. Delete ${failed.length === 1 ? "that file" : "those files"} by hand.`,
    );
  }
  if (touched > 0) {
    console.warn(`CPD Logger: removed a deleted account's data from ${touched} backup cop${touched === 1 ? "y" : "ies"} of the local database file.`);
  }
  return touched;
}

/**
 * Removes the account and all of its data, including its data in the ".corrupt-*" backup copies kept next to the file
 * (they are copies of this file, so they would otherwise keep a deleted person's email and entries). Returns true if
 * there was anything to remove. The account's id is remembered as a hash so a stale session cannot write for it again.
 */
export async function deleteLocalAccount(userId: string, filePath?: string): Promise<boolean> {
  requireUser(userId);
  const file = resolveLocalDbPath(filePath);
  return enqueue(file, async () => {
    const at = new Date();
    const db = await readDb(file, at);
    const emails: string[] = [];
    let removed = db.users.delete(userId);
    for (const [email, account] of [...db.accounts]) {
      if (account.id === userId) {
        db.accounts.delete(email);
        emails.push(email);
        removed = true;
      }
    }
    if (removed) {
      rememberDeleted(db, userId);
      await writeDb(file, db, at);
    }
    // After the write: the write itself can make a new backup copy of the file as it was, with this account still in it.
    const cleaned = await scrubBackupCopies(file, userId, emails);
    return removed || cleaned > 0;
  });
}
