import type { SupabaseClient } from "@supabase/supabase-js";
import type { Entry } from "@/lib/types";
import type { AiUsageResult, Store } from "./types";
import {
  StoreError,
  StoreInputError,
  assertMonth,
  entryInputToRow,
  entryPatchToRow,
  normaliseCap,
  rowToEntry,
  rowToSettings,
  rowsToEntries,
  settingsToRow,
  validateEntryInput,
  validateEntryPatch,
  validateSettings,
} from "./mapping";

/**
 * Store backed by Supabase Postgres.
 *
 * Pass the USER-scoped client (the one built from the signed-in user's cookies and the anon key). Row-level
 * security then limits every query to that user's rows. This file also adds `user_id = <id>` to every
 * query as a second, visible guard, so a mistake in a policy would not widen what one request can read.
 * Never pass a service-role client: it would skip row-level security. A client that looks like one is refused.
 *
 * Errors: a failed query becomes a StoreError with a fixed, friendly message. The raw database message is
 * never copied into it, because Postgres messages can quote the row that failed.
 */

const ENTRIES = "cpd_entries";
const SETTINGS = "user_settings";
const PAGE_SIZE = 1000;
const MAX_PAGES = 100;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SupabaseStoreOptions {
  /** Clock, for tests. */
  now?: () => Date;
}

interface PgError {
  message?: string;
  code?: string;
}

interface PgResponse {
  data: unknown;
  error: PgError | null;
  status?: number;
  /** The total number of matching rows, when the query asked for one. */
  count?: number | null;
}

const MSG_SIGN_IN = "Your session has expired, or you are not allowed to do that. Sign in again and try once more.";
const MSG_INVALID = "The database did not accept some of the values, for example hours below 0 or an end date before the start date. Check the form and try again.";
const MSG_SETUP = "The database tables or functions are missing. Run supabase/migrations/0001_init.sql on your Supabase project, then try again.";
const MSG_UNAVAILABLE = "CPD Logger could not reach the database. Check your connection and the Supabase project status, then try again.";
const MSG_FAILED = "The database returned an error. Try again; if it keeps happening, check the Supabase project status and the server log.";
const MSG_BUSY = "The database is busy and turned this request away. Wait a minute and try again.";
const MSG_NOT_FOUND = "The database did not recognise the request. Check NEXT_PUBLIC_SUPABASE_URL, and that supabase/migrations/0001_init.sql has been run on that project, then try again.";
const MSG_CHARACTERS = "The database could not store some of the text, for example because it contains a null or other unsupported character. Remove it and try again.";
const MSG_BAD_ANSWER = "The database sent back an answer CPD Logger could not read, so nothing was changed. Try again; if it keeps happening, check the Supabase project status.";
const MSG_TOO_MANY = "There are more entries than CPD Logger can load in one go, so nothing was shown rather than an incomplete list. Export your log in parts, or contact whoever runs this server.";

/** Pull a short code (like "23514") out of an error, or undefined. Messages are never kept. */
function safeCode(code: unknown): string | undefined {
  return typeof code === "string" && /^[A-Za-z0-9_]{1,12}$/.test(code) ? code : undefined;
}

/**
 * Postgres codes that mean the text itself cannot be stored: 22P05 (a character with no equivalent, such as a null),
 * 22P02 (text that is not valid for the column, such as half of a surrogate pair in JSON) and 22021 (bad UTF-8 bytes).
 */
const CHARACTER_CODES = new Set(["22P05", "22P02", "22021"]);

function toStoreError(error: PgError, status: number | undefined): StoreError {
  const code = safeCode(error.code);
  if (code === "42501" || code === "28000" || (code !== undefined && code.startsWith("PGRST30")) || status === 401 || status === 403) {
    return new StoreError("not_signed_in", MSG_SIGN_IN, code);
  }
  if (status === 429) return new StoreError("unavailable", MSG_BUSY, code);
  if (code !== undefined && CHARACTER_CODES.has(code)) return new StoreError("invalid", MSG_CHARACTERS, code);
  if (code !== undefined && (code.startsWith("22") || code.startsWith("23"))) return new StoreError("invalid", MSG_INVALID, code);
  if (code === "42P01" || code === "42883" || code === "PGRST202" || code === "PGRST205") return new StoreError("failed", MSG_SETUP, code);
  // "Could not reach" is only true when there was no answer at all (status 0) or the server itself failed (5xx).
  if (status === 0 || (status !== undefined && status >= 500)) return new StoreError("unavailable", MSG_UNAVAILABLE, code);
  // With no status and no code there is nothing to go on, so say the least: the database could not be reached.
  if (code === undefined && status === undefined) return new StoreError("unavailable", MSG_UNAVAILABLE, code);
  // A 404 with no database code is not a missing table (that has a code): the address or project is wrong.
  if (status === 404 && code === undefined) return new StoreError("failed", MSG_NOT_FOUND, code);
  return new StoreError("failed", MSG_FAILED, code);
}

/** Run one query and return the whole response. Failures, thrown or returned, become friendly StoreErrors. */
async function execute(op: () => PromiseLike<unknown>): Promise<PgResponse> {
  let res: PgResponse;
  try {
    res = (await op()) as PgResponse;
  } catch {
    throw new StoreError("unavailable", MSG_UNAVAILABLE);
  }
  if (!res || typeof res !== "object") throw new StoreError("failed", MSG_BAD_ANSWER);
  if (res.error) throw toStoreError(res.error, res.status);
  return res;
}

/** Run one query and return its data. */
async function run(op: () => PromiseLike<unknown>): Promise<unknown> {
  return (await execute(op)).data;
}

/** The rows of a list answer. Anything else (an empty or non-JSON body) is a failure, never "no rows". */
function asRows(data: unknown): unknown[] {
  if (!Array.isArray(data)) throw new StoreError("failed", MSG_BAD_ANSWER);
  return data;
}

function requireUser(userId: string): void {
  if (typeof userId !== "string" || !UUID_RE.test(userId)) throw new StoreError("not_signed_in", "You are not signed in. Sign in and try again.");
}

/** True when the key the client was built with is a service-role or secret key. Never reads or reports the key itself. */
function looksLikeServiceRoleClient(client: unknown): boolean {
  const key = (client as { supabaseKey?: unknown } | null)?.supabaseKey;
  if (typeof key !== "string") return false;
  if (key.startsWith("sb_secret_")) return true;
  const parts = key.split(".");
  if (parts.length !== 3 || !parts[1]) return false;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: unknown };
    return payload.role === "service_role";
  } catch {
    return false;
  }
}

function warnDropped(dropped: number): void {
  if (dropped > 0) console.warn(`CPD Logger: ${dropped} row${dropped === 1 ? "" : "s"} from the database could not be read and ${dropped === 1 ? "was" : "were"} left out.`);
}

export function createSupabaseStore(client: SupabaseClient, opts: SupabaseStoreOptions = {}): Store {
  if (looksLikeServiceRoleClient(client)) {
    throw new Error("The Supabase store must be given the signed-in user's client, not the service-role client. Row-level security would be skipped.");
  }
  const now = opts.now ?? (() => new Date());

  function entryOrFail(row: unknown): Entry {
    const entry = rowToEntry(row);
    if (!entry) throw new StoreError("failed", "The entry was saved but the database sent it back in a shape CPD Logger could not read. Reload the page.");
    return entry;
  }

  async function fetchEntry(userId: string, id: string): Promise<Entry | null> {
    if (typeof id !== "string" || !UUID_RE.test(id)) return null;
    // Read as a list of at most one row, not maybeSingle: with maybeSingle an empty answer and "no such row" look the same.
    const rows = asRows(await run(() => client.from(ENTRIES).select("*").eq("id", id).eq("user_id", userId).range(0, 0)));
    const row = rows[0];
    return row ? entryOrFail(row) : null;
  }

  function readAiUsage(data: unknown): { allowed: boolean; used: number } {
    const row = Array.isArray(data) ? data[0] : data;
    if (row && typeof row === "object") {
      const { allowed, used } = row as { allowed?: unknown; used?: unknown };
      if (typeof allowed === "boolean" && typeof used === "number" && Number.isInteger(used) && used >= 0) return { allowed, used };
    }
    throw new StoreError("failed", MSG_FAILED);
  }

  return {
    async getSettings(userId) {
      requireUser(userId);
      // A list of at most one row, so an empty answer is an error and not "no settings saved yet" (which would let a
      // following save overwrite the real settings with the defaults).
      const rows = asRows(await run(() => client.from(SETTINGS).select("*").eq("user_id", userId).range(0, 0)));
      return rowToSettings(rows[0]);
    },

    async saveSettings(userId, settings) {
      requireUser(userId);
      const valid = validateSettings(settings);
      const data = await run(() => client.from(SETTINGS).upsert(settingsToRow(userId, valid), { onConflict: "user_id" }).select().single());
      return data ? rowToSettings(data) : valid;
    },

    async listEntries(userId, opts2) {
      requireUser(userId);
      const includeDeleted = opts2?.includeDeleted === true;
      const entries: Entry[] = [];
      let dropped = 0;
      // The API returns at most a fixed number of rows per request, and the project's own "max rows" setting can make
      // that fewer than PAGE_SIZE. So read from where the last page ended, and stop only when the database's own count
      // says everything has been read (or, if it gave no count, when a page comes back short or empty).
      let offset = 0;
      let complete = false;
      for (let page = 0; page < MAX_PAGES && !complete; page++) {
        const res = await execute(() => {
          let q = client.from(ENTRIES).select("*", { count: "exact" }).eq("user_id", userId);
          if (!includeDeleted) q = q.is("deleted_at", null);
          return q
            .order("date_completed", { ascending: false })
            .order("created_at", { ascending: false })
            .order("id", { ascending: true })
            .range(offset, offset + PAGE_SIZE - 1);
        });
        const rows = asRows(res.data);
        const parsed = rowsToEntries(rows);
        entries.push(...parsed.entries);
        dropped += parsed.dropped;
        offset += rows.length;
        const total = typeof res.count === "number" && Number.isInteger(res.count) && res.count >= 0 ? res.count : null;
        complete = rows.length === 0 || (total !== null ? offset >= total : rows.length < PAGE_SIZE);
      }
      if (!complete) throw new StoreError("failed", MSG_TOO_MANY);
      warnDropped(dropped);
      return entries;
    },

    /** Includes soft-deleted entries. An id that belongs to another user is not visible, so it returns null. */
    async getEntry(userId, id) {
      requireUser(userId);
      return fetchEntry(userId, id);
    },

    async createEntry(userId, input) {
      requireUser(userId);
      const valid = validateEntryInput(input);
      const data = await run(() => client.from(ENTRIES).insert(entryInputToRow(userId, valid)).select().single());
      return entryOrFail(data);
    },

    /** One insert statement, so it is all or nothing. */
    async createEntries(userId, inputs) {
      requireUser(userId);
      if (!Array.isArray(inputs)) throw new StoreInputError("The entries must be a list.");
      const rows = inputs.map((i) => entryInputToRow(userId, validateEntryInput(i)));
      if (rows.length === 0) return [];
      const data = await run(() => client.from(ENTRIES).insert(rows).select());
      const list = Array.isArray(data) ? data : [];
      if (list.length !== rows.length) throw new StoreError("failed", MSG_FAILED);
      return list.map(entryOrFail);
    },

    /** Updates a live entry. A soft-deleted or unknown entry returns null. */
    async updateEntry(userId, id, patch) {
      requireUser(userId);
      const row = entryPatchToRow(validateEntryPatch(patch));
      if (typeof id !== "string" || !UUID_RE.test(id)) return null;
      if (Object.keys(row).length === 0) {
        const current = await fetchEntry(userId, id);
        return current && current.deletedAt === null ? current : null;
      }
      const data = await run(() => client.from(ENTRIES).update(row).eq("id", id).eq("user_id", userId).is("deleted_at", null).select().maybeSingle());
      return data ? entryOrFail(data) : null;
    },

    async softDeleteEntry(userId, id) {
      requireUser(userId);
      if (typeof id !== "string" || !UUID_RE.test(id)) return null;
      const data = await run(() =>
        client.from(ENTRIES).update({ deleted_at: now().toISOString() }).eq("id", id).eq("user_id", userId).is("deleted_at", null).select().maybeSingle(),
      );
      if (data) return entryOrFail(data);
      // Nothing changed: already deleted (return it as it is) or not this user's.
      return fetchEntry(userId, id);
    },

    async restoreEntry(userId, id) {
      requireUser(userId);
      if (typeof id !== "string" || !UUID_RE.test(id)) return null;
      const data = await run(() =>
        client.from(ENTRIES).update({ deleted_at: null }).eq("id", id).eq("user_id", userId).not("deleted_at", "is", null).select().maybeSingle(),
      );
      if (data) return entryOrFail(data);
      return fetchEntry(userId, id);
    },

    /**
     * Deletes this user's entries and settings. AI usage counts (a month and a number, no content) cannot be
     * deleted by the user on purpose, so they could not reset their own allowance; they are removed when the
     * Supabase auth user is deleted (on delete cascade).
     */
    async deleteAllUserData(userId) {
      requireUser(userId);
      await run(() => client.from(ENTRIES).delete().eq("user_id", userId));
      await run(() => client.from(SETTINGS).delete().eq("user_id", userId));
    },

    /** Read-only. The function uses auth.uid(), so the userId argument is not sent. */
    async getAiUsage(userId, month, cap): Promise<AiUsageResult> {
      requireUser(userId);
      assertMonth(month);
      const limit = normaliseCap(cap);
      const data = await run(() => client.rpc("get_ai_usage", { p_month: month }));
      const used = typeof data === "string" ? Number(data) : data;
      if (typeof used !== "number" || !Number.isInteger(used) || used < 0) throw new StoreError("failed", MSG_FAILED);
      return { allowed: used < limit, used, cap: limit };
    },

    /** Atomic in Postgres: adds one call only while under the cap. Uses auth.uid(), never a user id sent from here. */
    async incrementAiUsage(userId, month, cap): Promise<AiUsageResult> {
      requireUser(userId);
      assertMonth(month);
      const limit = normaliseCap(cap);
      const data = await run(() => client.rpc("increment_ai_usage", { p_month: month, p_cap: limit }));
      const { allowed, used } = readAiUsage(data);
      return { allowed, used, cap: limit };
    },
  };
}
