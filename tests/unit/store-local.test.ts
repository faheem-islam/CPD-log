import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LOCAL_DB_PATH, createLocalStore, deleteLocalAccount, findOrCreateLocalAccount, resolveLocalDbPath } from "@/lib/store/local";
import { StoreError, StoreInputError } from "@/lib/store/mapping";
import { resetEnvCache } from "@/lib/env";
import { DEFAULT_SETTINGS, type EntryInput, type UserSettings } from "@/lib/types";

/** Await a promise that is expected to reject and return what it rejected with. */
async function caught<E extends Error>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (e) {
    return e as E;
  }
  throw new Error("Expected the promise to reject");
}

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function makeInput(over: Partial<EntryInput> = {}): EntryInput {
  return {
    profile: "ice",
    title: "Test entry",
    url: null,
    provider: null,
    sourceType: "article",
    publishedAt: null,
    dateCompleted: "2026-03-04",
    dateEnd: null,
    detectedDurationMinutes: null,
    hours: 1,
    hoursConfirmed: true,
    theme: null,
    category: null,
    structuralSafety: null,
    sustainability: null,
    devPlanRef: "unplanned",
    learningPoints: "",
    benefits: { helped: "", future: "", nextYear: "" },
    developmentGained: "",
    custom: {},
    notes: "",
    aiAssisted: false,
    confidence: {},
    ...over,
  };
}

/** A clock that moves forward one second every time it is read. */
function ticker(startIso = "2026-03-04T10:00:00.000Z") {
  let t = new Date(startIso).getTime();
  return () => {
    const d = new Date(t);
    t += 1000;
    return d;
  };
}

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cpd-local-store-"));
  file = path.join(dir, "data", "local-db.json");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(
    () => true,
    () => false,
  );
}

async function siblings(): Promise<string[]> {
  return (await fs.readdir(path.dirname(file))).sort();
}

describe("a new store", () => {
  it("treats a missing file as an empty database and does not create it for a read", async () => {
    const store = createLocalStore(file);
    expect(await store.listEntries(A)).toEqual([]);
    expect(await store.getSettings(A)).toEqual(DEFAULT_SETTINGS);
    expect(await store.getEntry(A, "nope")).toBeNull();
    expect(await exists(file)).toBe(false);
  });

  it("treats an empty (zero byte) file as an empty database", async () => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, "");
    expect(await createLocalStore(file).listEntries(A)).toEqual([]);
  });

  it("creates the folder and writes with restricted permissions", async () => {
    await createLocalStore(file).createEntry(A, makeInput());
    const st = await fs.stat(file);
    const dst = await fs.stat(path.dirname(file));
    if (process.platform !== "win32") {
      expect(st.mode & 0o777).toBe(0o600);
      expect(dst.mode & 0o777).toBe(0o700);
    }
  });

  it("leaves no temporary files behind", async () => {
    const store = createLocalStore(file);
    await Promise.all(Array.from({ length: 10 }, (_, i) => store.createEntry(A, makeInput({ title: `T${i}` }))));
    expect(await siblings()).toEqual(["local-db.json"]);
  });

  it("writes a versioned file and no API keys or secrets", async () => {
    await createLocalStore(file).createEntry(A, makeInput());
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
    expect(parsed.version).toBe(1);
    expect(Object.keys(parsed).sort()).toEqual(["accounts", "users", "version"]);
  });
});

describe("path resolution", () => {
  const saved = process.env.CPD_LOCAL_DB;
  afterEach(() => {
    if (saved === undefined) delete process.env.CPD_LOCAL_DB;
    else process.env.CPD_LOCAL_DB = saved;
    resetEnvCache();
  });

  it("uses an explicit path first", () => {
    expect(resolveLocalDbPath("/some/where/db.json")).toBe(path.resolve("/some/where/db.json"));
  });

  it("uses CPD_LOCAL_DB when no path is given", () => {
    process.env.CPD_LOCAL_DB = path.join(dir, "from-env.json");
    resetEnvCache();
    expect(resolveLocalDbPath()).toBe(path.join(dir, "from-env.json"));
  });

  it("treats a blank CPD_LOCAL_DB as unset and uses the default", () => {
    process.env.CPD_LOCAL_DB = "   ";
    resetEnvCache();
    expect(resolveLocalDbPath()).toBe(path.resolve(DEFAULT_LOCAL_DB_PATH));
    expect(DEFAULT_LOCAL_DB_PATH).toBe(".data/local-db.json");
  });
});

describe("entries: create, read, update", () => {
  it("createEntry sets id, userId, timestamps and deletedAt", async () => {
    const store = createLocalStore(file, { now: ticker() });
    const e = await store.createEntry(A, makeInput({ title: "Hello" }));
    expect(e.id).toMatch(UUID_RE);
    expect(e.userId).toBe(A);
    expect(e.title).toBe("Hello");
    expect(e.createdAt).toBe("2026-03-04T10:00:01.000Z");
    expect(e.updatedAt).toBe(e.createdAt);
    expect(e.deletedAt).toBeNull();
    expect(await store.getEntry(A, e.id)).toEqual(e);
  });

  it("ignores an id, userId or timestamps supplied in the input", async () => {
    const store = createLocalStore(file, { now: ticker() });
    const sneaky = { ...makeInput(), id: "mine", userId: B, createdAt: "2000-01-01T00:00:00.000Z", deletedAt: "2000-01-01T00:00:00.000Z" } as EntryInput;
    const e = await store.createEntry(A, sneaky);
    expect(e.id).not.toBe("mine");
    expect(e.userId).toBe(A);
    expect(e.createdAt).not.toContain("2000");
    expect(e.deletedAt).toBeNull();
    expect(await store.listEntries(B)).toEqual([]);
  });

  it("gives every entry its own id", async () => {
    const store = createLocalStore(file);
    const ids = new Set((await Promise.all(Array.from({ length: 20 }, () => store.createEntry(A, makeInput())))).map((e) => e.id));
    expect(ids.size).toBe(20);
  });

  it("rounds hours to two decimals", async () => {
    const e = await createLocalStore(file).createEntry(A, makeInput({ hours: 1.234 }));
    expect(e.hours).toBe(1.23);
  });

  it("rejects an invalid entry with a friendly error and writes nothing", async () => {
    const store = createLocalStore(file);
    await expect(store.createEntry(A, makeInput({ hours: -3 }))).rejects.toBeInstanceOf(StoreInputError);
    await expect(store.createEntry(A, makeInput({ dateCompleted: "04/03/2026" }))).rejects.toThrow(/Date completed/);
    expect(await exists(file)).toBe(false);
  });

  it("refuses a blank user id", async () => {
    const store = createLocalStore(file);
    await expect(store.createEntry("", makeInput())).rejects.toMatchObject({ code: "not_signed_in" });
    await expect(store.listEntries("")).rejects.toBeInstanceOf(StoreError);
  });

  it("createEntries saves all rows in input order, with ids", async () => {
    const store = createLocalStore(file, { now: ticker() });
    const made = await store.createEntries(A, [makeInput({ title: "One" }), makeInput({ title: "Two" }), makeInput({ title: "Three" })]);
    expect(made.map((e) => e.title)).toEqual(["One", "Two", "Three"]);
    expect(new Set(made.map((e) => e.id)).size).toBe(3);
    expect((await store.listEntries(A)).length).toBe(3);
  });

  it("createEntries is all or nothing", async () => {
    const store = createLocalStore(file);
    await store.createEntry(A, makeInput({ title: "Existing" }));
    await expect(store.createEntries(A, [makeInput({ title: "Good" }), makeInput({ hours: -1 })])).rejects.toBeInstanceOf(StoreInputError);
    expect((await store.listEntries(A)).map((e) => e.title)).toEqual(["Existing"]);
  });

  it("createEntries with an empty list does nothing", async () => {
    const store = createLocalStore(file);
    expect(await store.createEntries(A, [])).toEqual([]);
    expect(await exists(file)).toBe(false);
  });

  it("updateEntry changes fields and bumps updatedAt only", async () => {
    const store = createLocalStore(file, { now: ticker() });
    const e = await store.createEntry(A, makeInput({ title: "Before", hours: 1 }));
    const u = await store.updateEntry(A, e.id, { title: "After", hours: 2.5 });
    expect(u).toMatchObject({ id: e.id, userId: A, title: "After", hours: 2.5, createdAt: e.createdAt, deletedAt: null });
    expect(u?.updatedAt).not.toBe(e.updatedAt);
    expect(await store.getEntry(A, e.id)).toEqual(u);
  });

  it("updateEntry cannot change id, userId, createdAt or deletedAt", async () => {
    const store = createLocalStore(file, { now: ticker() });
    const e = await store.createEntry(A, makeInput());
    const patch = { title: "Changed", id: "other-id", userId: B, createdAt: "1999-01-01T00:00:00.000Z", deletedAt: "2026-01-01T00:00:00.000Z", updatedAt: "1999-01-01T00:00:00.000Z" } as Partial<EntryInput>;
    const u = await store.updateEntry(A, e.id, patch);
    expect(u).toMatchObject({ id: e.id, userId: A, createdAt: e.createdAt, deletedAt: null, title: "Changed" });
    expect(u?.updatedAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(await store.listEntries(B)).toEqual([]);
  });

  it("updateEntry with an empty patch changes nothing", async () => {
    const store = createLocalStore(file, { now: ticker() });
    const e = await store.createEntry(A, makeInput());
    expect(await store.updateEntry(A, e.id, {})).toEqual(e);
    expect(await store.updateEntry(A, e.id, { title: undefined })).toEqual(e);
  });

  it("updateEntry can set nullable fields to null", async () => {
    const store = createLocalStore(file);
    const e = await store.createEntry(A, makeInput({ theme: "Water" }));
    expect((await store.updateEntry(A, e.id, { theme: null }))?.theme).toBeNull();
  });

  it("updateEntry rejects bad values and an end date before the start, and keeps the old entry", async () => {
    const store = createLocalStore(file);
    const e = await store.createEntry(A, makeInput({ dateCompleted: "2026-03-10" }));
    await expect(store.updateEntry(A, e.id, { hours: -1 })).rejects.toBeInstanceOf(StoreInputError);
    await expect(store.updateEntry(A, e.id, { dateEnd: "2026-03-01" })).rejects.toThrow(/End date/);
    expect(await store.getEntry(A, e.id)).toEqual(e);
  });

  it("updateEntry returns null for an unknown id", async () => {
    expect(await createLocalStore(file).updateEntry(A, "does-not-exist", { title: "x" })).toBeNull();
  });

  it("updateEntry returns null for a soft-deleted entry", async () => {
    const store = createLocalStore(file);
    const e = await store.createEntry(A, makeInput());
    await store.softDeleteEntry(A, e.id);
    expect(await store.updateEntry(A, e.id, { title: "x" })).toBeNull();
  });
});

describe("user isolation", () => {
  it("one user cannot read, update, delete or restore another user's entry", async () => {
    const store = createLocalStore(file);
    const mine = await store.createEntry(A, makeInput({ title: "A's entry" }));
    expect(await store.getEntry(B, mine.id)).toBeNull();
    expect(await store.updateEntry(B, mine.id, { title: "hijacked" })).toBeNull();
    expect(await store.softDeleteEntry(B, mine.id)).toBeNull();
    expect(await store.restoreEntry(B, mine.id)).toBeNull();
    expect(await store.listEntries(B)).toEqual([]);
    expect(await store.listEntries(B, { includeDeleted: true })).toEqual([]);
    expect(await store.getEntry(A, mine.id)).toMatchObject({ title: "A's entry", deletedAt: null });
  });

  it("keeps settings and AI usage separate", async () => {
    const store = createLocalStore(file);
    await store.saveSettings(A, { ...DEFAULT_SETTINGS, name: "Ann" });
    await store.incrementAiUsage(A, "2026-03", 5);
    expect((await store.getSettings(B)).name).toBe("");
    expect((await store.getAiUsage(B, "2026-03", 5)).used).toBe(0);
    expect((await store.getSettings(A)).name).toBe("Ann");
    expect((await store.getAiUsage(A, "2026-03", 5)).used).toBe(1);
  });

  it("deleteAllUserData removes only that user's data", async () => {
    const store = createLocalStore(file);
    await store.createEntry(A, makeInput());
    await store.createEntry(B, makeInput({ title: "B" }));
    await store.saveSettings(A, { ...DEFAULT_SETTINGS, name: "Ann" });
    await store.incrementAiUsage(A, "2026-03", 5);
    await store.deleteAllUserData(A);
    expect(await store.listEntries(A, { includeDeleted: true })).toEqual([]);
    expect(await store.getSettings(A)).toEqual(DEFAULT_SETTINGS);
    expect((await store.getAiUsage(A, "2026-03", 5)).used).toBe(0);
    expect((await store.listEntries(B)).map((e) => e.title)).toEqual(["B"]);
  });

  it("deleteAllUserData for an unknown user does nothing and does not create the file", async () => {
    await createLocalStore(file).deleteAllUserData(A);
    expect(await exists(file)).toBe(false);
  });
});

describe("soft delete and restore", () => {
  it("soft delete hides an entry from the list but not from getEntry or includeDeleted", async () => {
    const store = createLocalStore(file, { now: ticker() });
    const e = await store.createEntry(A, makeInput());
    const d = await store.softDeleteEntry(A, e.id);
    expect(d?.deletedAt).not.toBeNull();
    expect(await store.listEntries(A)).toEqual([]);
    expect(await store.listEntries(A, { includeDeleted: true })).toHaveLength(1);
    expect((await store.getEntry(A, e.id))?.deletedAt).toBe(d?.deletedAt);
  });

  it("soft delete is idempotent: the first deletion time is kept", async () => {
    const store = createLocalStore(file, { now: ticker() });
    const e = await store.createEntry(A, makeInput());
    const first = await store.softDeleteEntry(A, e.id);
    const second = await store.softDeleteEntry(A, e.id);
    expect(second).toEqual(first);
    expect(second?.deletedAt).toBe(first?.deletedAt);
    expect(second?.updatedAt).toBe(first?.updatedAt);
  });

  it("restore brings an entry back and is idempotent", async () => {
    const store = createLocalStore(file, { now: ticker() });
    const e = await store.createEntry(A, makeInput());
    await store.softDeleteEntry(A, e.id);
    const r1 = await store.restoreEntry(A, e.id);
    expect(r1?.deletedAt).toBeNull();
    const r2 = await store.restoreEntry(A, e.id);
    expect(r2).toEqual(r1);
    expect(await store.listEntries(A)).toHaveLength(1);
  });

  it("restoring a live entry returns it unchanged", async () => {
    const store = createLocalStore(file, { now: ticker() });
    const e = await store.createEntry(A, makeInput());
    expect(await store.restoreEntry(A, e.id)).toEqual(e);
  });

  it("returns null for unknown ids", async () => {
    const store = createLocalStore(file);
    expect(await store.softDeleteEntry(A, "x")).toBeNull();
    expect(await store.restoreEntry(A, "x")).toBeNull();
  });

  it("a soft-deleted entry can be edited again after it is restored", async () => {
    const store = createLocalStore(file);
    const e = await store.createEntry(A, makeInput());
    await store.softDeleteEntry(A, e.id);
    await store.restoreEntry(A, e.id);
    expect((await store.updateEntry(A, e.id, { title: "Back" }))?.title).toBe("Back");
  });
});

describe("listEntries order", () => {
  it("sorts by date completed (newest first), then created time (newest first)", async () => {
    const store = createLocalStore(file, { now: ticker() });
    const a = await store.createEntry(A, makeInput({ title: "a", dateCompleted: "2026-01-10" }));
    const b = await store.createEntry(A, makeInput({ title: "b", dateCompleted: "2026-03-01" }));
    const c = await store.createEntry(A, makeInput({ title: "c", dateCompleted: "2026-03-01" }));
    const d = await store.createEntry(A, makeInput({ title: "d", dateCompleted: "2025-12-31" }));
    expect((await store.listEntries(A)).map((e) => e.title)).toEqual(["c", "b", "a", "d"]);
    expect([a, b, c, d].length).toBe(4);
  });

  it("includes soft-deleted entries in the same order when asked", async () => {
    const store = createLocalStore(file, { now: ticker() });
    await store.createEntry(A, makeInput({ title: "old", dateCompleted: "2026-01-01" }));
    const mid = await store.createEntry(A, makeInput({ title: "mid", dateCompleted: "2026-02-01" }));
    await store.createEntry(A, makeInput({ title: "new", dateCompleted: "2026-03-01" }));
    await store.softDeleteEntry(A, mid.id);
    expect((await store.listEntries(A)).map((e) => e.title)).toEqual(["new", "old"]);
    expect((await store.listEntries(A, { includeDeleted: true })).map((e) => e.title)).toEqual(["new", "mid", "old"]);
  });

  it("does not change the order of equal rows between calls", async () => {
    const store = createLocalStore(file, { now: () => new Date("2026-03-04T10:00:00.000Z") });
    await store.createEntries(A, [makeInput({ title: "1" }), makeInput({ title: "2" }), makeInput({ title: "3" })]);
    const first = (await store.listEntries(A)).map((e) => e.title);
    const second = (await store.listEntries(A)).map((e) => e.title);
    expect(second).toEqual(first);
  });
});

describe("settings", () => {
  const settings: UserSettings = {
    name: "Test Person",
    jobRole: "Engineer",
    responsibilities: "Things",
    sector: "Highways",
    activeProfiles: ["ice", "istructe"],
    customFields: [{ key: "site", label: "Site", type: "text" }],
  };

  it("returns the defaults before anything is saved, as a copy", async () => {
    const store = createLocalStore(file);
    const s = await store.getSettings(A);
    expect(s).toEqual(DEFAULT_SETTINGS);
    s.activeProfiles.push("custom");
    expect((await store.getSettings(A)).activeProfiles).toEqual(["ice"]);
  });

  it("saves and returns settings", async () => {
    const store = createLocalStore(file);
    expect(await store.saveSettings(A, settings)).toEqual(settings);
    expect(await store.getSettings(A)).toEqual(settings);
  });

  it("rejects invalid settings and keeps the old ones", async () => {
    const store = createLocalStore(file);
    await store.saveSettings(A, settings);
    await expect(store.saveSettings(A, { ...settings, activeProfiles: [] })).rejects.toBeInstanceOf(StoreInputError);
    expect(await store.getSettings(A)).toEqual(settings);
  });
});

describe("AI usage and the monthly cap", () => {
  it("counts up to the cap and then refuses without counting", async () => {
    const store = createLocalStore(file);
    expect(await store.getAiUsage(A, "2026-03", 3)).toEqual({ allowed: true, used: 0, cap: 3 });
    expect(await store.incrementAiUsage(A, "2026-03", 3)).toEqual({ allowed: true, used: 1, cap: 3 });
    expect(await store.incrementAiUsage(A, "2026-03", 3)).toEqual({ allowed: true, used: 2, cap: 3 });
    expect(await store.incrementAiUsage(A, "2026-03", 3)).toEqual({ allowed: true, used: 3, cap: 3 });
    expect(await store.incrementAiUsage(A, "2026-03", 3)).toEqual({ allowed: false, used: 3, cap: 3 });
    expect(await store.incrementAiUsage(A, "2026-03", 3)).toEqual({ allowed: false, used: 3, cap: 3 });
    expect(await store.getAiUsage(A, "2026-03", 3)).toEqual({ allowed: false, used: 3, cap: 3 });
  });

  it("keeps each month separate", async () => {
    const store = createLocalStore(file);
    await store.incrementAiUsage(A, "2026-03", 1);
    expect((await store.incrementAiUsage(A, "2026-04", 1)).allowed).toBe(true);
    expect((await store.incrementAiUsage(A, "2026-03", 1)).allowed).toBe(false);
  });

  it("a cap of zero, a negative cap or NaN allows nothing and counts nothing", async () => {
    const store = createLocalStore(file);
    for (const cap of [0, -5, Number.NaN]) {
      expect(await store.incrementAiUsage(A, "2026-03", cap)).toEqual({ allowed: false, used: 0, cap: 0 });
    }
    expect(await exists(file)).toBe(false);
  });

  it("a larger cap later lets counting continue", async () => {
    const store = createLocalStore(file);
    await store.incrementAiUsage(A, "2026-03", 1);
    expect((await store.incrementAiUsage(A, "2026-03", 1)).allowed).toBe(false);
    expect(await store.incrementAiUsage(A, "2026-03", 2)).toEqual({ allowed: true, used: 2, cap: 2 });
  });

  it("rejects a month that is not YYYY-MM", async () => {
    const store = createLocalStore(file);
    for (const bad of ["2026-3", "March", "2026-13", "", "2026-03-01"]) {
      await expect(store.incrementAiUsage(A, bad, 5)).rejects.toBeInstanceOf(StoreInputError);
      await expect(store.getAiUsage(A, bad, 5)).rejects.toBeInstanceOf(StoreInputError);
    }
  });

  it("never lets 60 concurrent increments pass a cap of 10", async () => {
    const store = createLocalStore(file);
    const results = await Promise.all(Array.from({ length: 60 }, () => store.incrementAiUsage(A, "2026-03", 10)));
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect(results.filter((r) => !r.allowed)).toHaveLength(50);
    expect(Math.max(...results.map((r) => r.used))).toBe(10);
    expect((await store.getAiUsage(A, "2026-03", 10)).used).toBe(10);
  });

  it("holds the cap across two store objects on the same file", async () => {
    const one = createLocalStore(file);
    const two = createLocalStore(path.join(path.dirname(file), "..", "data", "local-db.json"));
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? one : two).incrementAiUsage(A, "2026-03", 7)));
    expect(results.filter((r) => r.allowed)).toHaveLength(7);
    expect((await one.getAiUsage(A, "2026-03", 7)).used).toBe(7);
  });

  it("counts different users independently under concurrency", async () => {
    const store = createLocalStore(file);
    const jobs = Array.from({ length: 30 }, (_, i) => store.incrementAiUsage(i % 2 === 0 ? A : B, "2026-03", 5));
    const results = await Promise.all(jobs);
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
    expect((await store.getAiUsage(A, "2026-03", 5)).used).toBe(5);
    expect((await store.getAiUsage(B, "2026-03", 5)).used).toBe(5);
  });
});

describe("concurrent writes", () => {
  it("do not lose data", async () => {
    const store = createLocalStore(file);
    await Promise.all(Array.from({ length: 40 }, (_, i) => store.createEntry(i % 2 === 0 ? A : B, makeInput({ title: `T${i}` }))));
    expect(await store.listEntries(A)).toHaveLength(20);
    expect(await store.listEntries(B)).toHaveLength(20);
  });

  it("do not lose data when mixed with settings, deletes and account changes", async () => {
    const store = createLocalStore(file);
    const seed = await store.createEntry(A, makeInput({ title: "seed" }));
    const jobs: Promise<unknown>[] = [];
    for (let i = 0; i < 15; i++) jobs.push(store.createEntry(A, makeInput({ title: `n${i}` })));
    jobs.push(store.saveSettings(A, { ...DEFAULT_SETTINGS, name: "Ann" }));
    jobs.push(store.softDeleteEntry(A, seed.id));
    jobs.push(findOrCreateLocalAccount("a@example.test", file));
    jobs.push(findOrCreateLocalAccount("b@example.test", file));
    for (let i = 0; i < 10; i++) jobs.push(store.incrementAiUsage(A, "2026-03", 100));
    await Promise.all(jobs);
    expect(await store.listEntries(A)).toHaveLength(15);
    expect(await store.listEntries(A, { includeDeleted: true })).toHaveLength(16);
    expect((await store.getSettings(A)).name).toBe("Ann");
    expect((await store.getAiUsage(A, "2026-03", 100)).used).toBe(10);
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { accounts: Record<string, unknown> };
    expect(Object.keys(parsed.accounts).sort()).toEqual(["a@example.test", "b@example.test"]);
  });

  it("a failed operation does not block the ones after it", async () => {
    const store = createLocalStore(file);
    const bad = store.createEntry(A, makeInput({ hours: -1 }));
    const good = store.createEntry(A, makeInput({ title: "fine" }));
    await expect(bad).rejects.toBeInstanceOf(StoreInputError);
    expect((await good).title).toBe("fine");
  });
});

describe("a file that survives a reopen", () => {
  it("is read by a new store object", async () => {
    const first = createLocalStore(file, { now: ticker() });
    const e = await first.createEntry(A, makeInput({ title: "Persisted" }));
    await first.saveSettings(A, { ...DEFAULT_SETTINGS, name: "Ann" });
    await first.incrementAiUsage(A, "2026-03", 5);
    await first.softDeleteEntry(A, e.id);
    const second = createLocalStore(file);
    expect(await second.getEntry(A, e.id)).toMatchObject({ title: "Persisted", deletedAt: expect.any(String) });
    expect((await second.getSettings(A)).name).toBe("Ann");
    expect((await second.getAiUsage(A, "2026-03", 5)).used).toBe(1);
  });
});

describe("a damaged file", () => {
  async function put(content: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }

  it("is never overwritten: operations fail, the file is unchanged and a .corrupt copy is kept", async () => {
    const garbage = '{"version":1,"accounts":{';
    await put(garbage);
    const store = createLocalStore(file, { now: () => new Date("2026-03-04T10:00:00.000Z") });
    await expect(store.createEntry(A, makeInput())).rejects.toMatchObject({ name: "StoreError", code: "failed" });
    await expect(store.listEntries(A)).rejects.toThrow(/could not be read/);
    expect(await fs.readFile(file, "utf8")).toBe(garbage);
    const copies = (await siblings()).filter((n) => n.startsWith("local-db.json.corrupt-"));
    expect(copies).toEqual(["local-db.json.corrupt-2026-03-04T10-00-00-000Z"]);
    expect(await fs.readFile(path.join(path.dirname(file), copies[0] ?? ""), "utf8")).toBe(garbage);
  });

  it("does not keep adding copies when the same bad file is hit again", async () => {
    await put("not json at all");
    const store = createLocalStore(file);
    for (let i = 0; i < 5; i++) await expect(store.listEntries(A)).rejects.toBeInstanceOf(StoreError);
    expect((await siblings()).filter((n) => n.includes(".corrupt-"))).toHaveLength(1);
  });

  it("always names a copy that exists, even when the same bad file is hit again later", async () => {
    await put("not json");
    const store = createLocalStore(file, { now: ticker() });
    const first = await caught<Error>(store.listEntries(A));
    const second = await caught<Error>(store.listEntries(A));
    const copies = (await siblings()).filter((n) => n.includes(".corrupt-"));
    expect(copies).toHaveLength(1);
    expect(first.message).toContain(`"${copies[0]}"`);
    expect(second.message).toContain(`"${copies[0]}"`);
  });

  it("the message says what happened and what to do, and names no data", async () => {
    await put("[[[");
    const err = await caught<Error>(createLocalStore(file).listEntries(A));
    expect(err.message).toMatch(/left it exactly as it is/);
    expect(err.message).toMatch(/Fix the file, or move it away/);
  });

  it.each([
    ["an array", "[]"],
    ["a string", '"hello"'],
    ["null", "null"],
    ["no version", '{"accounts":{},"users":{}}'],
    ["version 0", '{"version":0,"accounts":{},"users":{}}'],
    ["users that is a list", '{"version":1,"accounts":{},"users":[]}'],
    ["accounts that is a string", '{"version":1,"accounts":"x","users":{}}'],
  ])("treats %s as damaged", async (_name, content) => {
    await put(content);
    await expect(createLocalStore(file).listEntries(A)).rejects.toThrow(/could not be read/);
    expect(await fs.readFile(file, "utf8")).toBe(content);
  });

  it("refuses a newer file version without calling it damaged", async () => {
    const content = '{"version":2,"accounts":{},"users":{}}';
    await put(content);
    await expect(createLocalStore(file).createEntry(A, makeInput())).rejects.toThrow(/different version/);
    expect(await fs.readFile(file, "utf8")).toBe(content);
    expect((await siblings()).filter((n) => n.includes(".corrupt-"))).toHaveLength(0);
  });

  it("works again once the person fixes the file", async () => {
    await put("garbage");
    const store = createLocalStore(file);
    await expect(store.listEntries(A)).rejects.toBeInstanceOf(StoreError);
    await fs.writeFile(file, '{"version":1,"accounts":{},"users":{}}');
    expect(await store.listEntries(A)).toEqual([]);
    await store.createEntry(A, makeInput());
    expect(await store.listEntries(A)).toHaveLength(1);
  });

  it("a damaged file also stops account helpers", async () => {
    await put("garbage");
    await expect(findOrCreateLocalAccount("a@example.test", file)).rejects.toBeInstanceOf(StoreError);
    await expect(deleteLocalAccount(A, file)).rejects.toBeInstanceOf(StoreError);
    expect(await fs.readFile(file, "utf8")).toBe("garbage");
  });
});

describe("a hand-edited file", () => {
  function dbWith(users: Record<string, unknown>, accounts: Record<string, unknown> = {}): string {
    return JSON.stringify({ version: 1, accounts, users });
  }
  async function put(content: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  function validStored(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { ...makeInput({ title: "Kept" }), id: "id-good", userId: A, createdAt: "2026-03-04T10:00:00.000Z", updatedAt: "2026-03-04T10:00:00.000Z", deletedAt: null, ...over };
  }

  it("leaves out unusable rows, warns with a count only, and keeps the good rows", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await put(
      dbWith({
        [A]: {
          settings: { name: "Ann", activeProfiles: ["nonsense"] },
          entries: [validStored(), { id: "broken", title: "SECRET-TITLE-TEXT", hours: "lots" }, "junk", validStored({ id: "id-good" }), null],
          aiUsage: { "2026-03": 4, "March": 2, "2026-04": -1, "2026-05": 1.5 },
        },
        broken: "not an object",
      }),
    );
    const store = createLocalStore(file);
    const list = await store.listEntries(A);
    expect(list.map((e) => e.id)).toEqual(["id-good"]);
    expect((await store.getSettings(A)).name).toBe("Ann");
    expect((await store.getSettings(A)).activeProfiles).toEqual(["ice"]);
    expect((await store.getAiUsage(A, "2026-03", 10)).used).toBe(4);
    expect((await store.getAiUsage(A, "2026-04", 10)).used).toBe(0);
    expect(warn).toHaveBeenCalled();
    const message = String(warn.mock.calls[0]?.[0]);
    expect(message).toMatch(/\d+ unusable rows? w/);
    expect(message).not.toContain("SECRET-TITLE-TEXT");
    expect(message).not.toContain("lots");
  });

  it("does not repeat the warning on every read", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await put(dbWith({ [A]: { entries: [validStored(), "junk"] } }));
    const store = createLocalStore(file);
    for (let i = 0; i < 5; i++) await store.listEntries(A);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("keeps a copy of the original file before the first save that would drop the bad rows", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const original = dbWith({ [A]: { entries: [validStored(), { id: "unusable", title: "Hand typed row" }] } });
    await put(original);
    const store = createLocalStore(file, { now: () => new Date("2026-03-04T10:00:00.000Z") });
    await store.createEntry(A, makeInput({ title: "New" }));
    const copies = (await siblings()).filter((n) => n.includes(".corrupt-"));
    expect(copies).toHaveLength(1);
    expect(await fs.readFile(path.join(path.dirname(file), copies[0] ?? ""), "utf8")).toBe(original);
    expect((await store.listEntries(A)).map((e) => e.title).sort()).toEqual(["Kept", "New"]);
  });

  it("does not write anything (and makes no copy) when only reading", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const original = dbWith({ [A]: { entries: [validStored(), "junk"] } });
    await put(original);
    await createLocalStore(file).listEntries(A);
    expect(await fs.readFile(file, "utf8")).toBe(original);
    expect(await siblings()).toEqual(["local-db.json"]);
  });

  it("takes the owner from the key a row sits under, not from the row", async () => {
    await put(dbWith({ [B]: { entries: [validStored({ userId: A, id: "id-b" })] } }));
    const store = createLocalStore(file);
    expect((await store.listEntries(B))[0]?.userId).toBe(B);
    expect(await store.listEntries(A)).toEqual([]);
  });

  it("drops a second row with a repeated id", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await put(dbWith({ [A]: { entries: [validStored({ title: "First" }), validStored({ title: "Second" })] } }));
    const list = await createLocalStore(file).listEntries(A);
    expect(list.map((e) => e.title)).toEqual(["First"]);
  });

  it("copes with a __proto__ key as a user or account name", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await put(
      '{"version":1,"accounts":{"__proto__":{"id":"x","createdAt":"2026-01-01T00:00:00.000Z"}},"users":{"__proto__":{"entries":[],"settings":{"name":"Evil"}}}}',
    );
    const store = createLocalStore(file);
    expect((await store.getSettings("__proto__")).name).toBe("Evil");
    expect(await store.listEntries(A)).toEqual([]);
    expect(({} as Record<string, unknown>).entries).toBeUndefined();
    expect(Object.getPrototypeOf(await store.getSettings(A))).toBe(Object.prototype);
  });
});

describe("accounts", () => {
  it("returns a stable random id for the same email, whatever the case or spacing", async () => {
    const a = await findOrCreateLocalAccount("Ann@Example.test", file);
    const b = await findOrCreateLocalAccount("  ann@example.TEST  ", file);
    expect(a.id).toMatch(UUID_RE);
    expect(b).toEqual(a);
    expect(a.email).toBe("ann@example.test");
  });

  it("gives different emails different ids", async () => {
    const a = await findOrCreateLocalAccount("a@example.test", file);
    const b = await findOrCreateLocalAccount("b@example.test", file);
    expect(a.id).not.toBe(b.id);
  });

  it("is stable across a reopen", async () => {
    const first = await findOrCreateLocalAccount("a@example.test", file);
    expect(await findOrCreateLocalAccount("a@example.test", file)).toEqual(first);
  });

  it("is not derived from the email", async () => {
    const one = await findOrCreateLocalAccount("a@example.test", path.join(dir, "one.json"));
    const two = await findOrCreateLocalAccount("a@example.test", path.join(dir, "two.json"));
    expect(one.id).not.toBe(two.id);
  });

  it.each(["", "   ", "no-at-sign", "@no-local", "two@@example.test", "spa ce@example.test", `${"a".repeat(250)}@example.test`])("rejects the address %j", async (bad) => {
    await expect(findOrCreateLocalAccount(bad, file)).rejects.toBeInstanceOf(StoreInputError);
  });

  it("returns the same id to concurrent first sign-ins", async () => {
    const ids = await Promise.all(Array.from({ length: 10 }, () => findOrCreateLocalAccount("race@example.test", file)));
    expect(new Set(ids.map((a) => a.id)).size).toBe(1);
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { accounts: Record<string, unknown> };
    expect(Object.keys(parsed.accounts)).toEqual(["race@example.test"]);
  });

  it("deleteLocalAccount removes the account and all of its data, and nobody else's", async () => {
    const store = createLocalStore(file);
    const ann = await findOrCreateLocalAccount("ann@example.test", file);
    const bob = await findOrCreateLocalAccount("bob@example.test", file);
    await store.createEntry(ann.id, makeInput({ title: "Ann's" }));
    await store.saveSettings(ann.id, { ...DEFAULT_SETTINGS, name: "Ann" });
    await store.incrementAiUsage(ann.id, "2026-03", 5);
    await store.createEntry(bob.id, makeInput({ title: "Bob's" }));

    expect(await deleteLocalAccount(ann.id, file)).toBe(true);

    expect(await store.listEntries(ann.id, { includeDeleted: true })).toEqual([]);
    expect(await store.getSettings(ann.id)).toEqual(DEFAULT_SETTINGS);
    expect((await store.getAiUsage(ann.id, "2026-03", 5)).used).toBe(0);
    expect((await store.listEntries(bob.id)).map((e) => e.title)).toEqual(["Bob's"]);
    const text = await fs.readFile(file, "utf8");
    expect(text).not.toContain("ann@example.test");
    expect(text).not.toContain(ann.id);
    const again = await findOrCreateLocalAccount("ann@example.test", file);
    expect(again.id).not.toBe(ann.id);
  });

  it("deleteLocalAccount returns false when there is nothing to delete", async () => {
    expect(await deleteLocalAccount(A, file)).toBe(false);
    expect(await exists(file)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Deleting an account, backup copies and stale sessions

describe("deleting an account and the backup copies of the file", () => {
  const BOB_TITLE = "BOB-PRIVATE-TITLE";
  const BOB_EMAIL = "Bob@Example.com";

  async function put(content: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  async function copies(): Promise<string[]> {
    return (await siblings()).filter((n) => n.startsWith("local-db.json.corrupt-"));
  }
  async function readCopy(name: string): Promise<string> {
    return fs.readFile(path.join(path.dirname(file), name), "utf8");
  }
  /** Two accounts with an entry each, and a junk row hand-edited into Bob's entries. */
  async function seed() {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createLocalStore(file);
    const bob = await findOrCreateLocalAccount(BOB_EMAIL, file);
    const ann = await findOrCreateLocalAccount("ann@example.test", file);
    await store.createEntry(bob.id, makeInput({ title: BOB_TITLE }));
    await store.createEntry(ann.id, makeInput({ title: "ANN-TITLE" }));
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { users: Record<string, { entries: unknown[] }> };
    parsed.users[bob.id]?.entries.push({ junk: true, title: BOB_TITLE });
    await fs.writeFile(file, JSON.stringify(parsed));
    return { store, bob, ann };
  }

  it("removes the account from a copy made when the next write dropped a hand-edited row", async () => {
    const { store, bob, ann } = await seed();
    await store.createEntry(ann.id, makeInput({ title: "ANN-2" })); // this write keeps a copy of the file as edited
    const [name, ...rest] = await copies();
    expect(rest).toEqual([]);
    const before = await readCopy(name ?? "");
    expect(before).toContain(BOB_TITLE);
    expect(before.toLowerCase()).toContain("bob@example.com");

    expect(await deleteLocalAccount(bob.id, file)).toBe(true);

    for (const text of [await readCopy(name ?? ""), await fs.readFile(file, "utf8")]) {
      expect(text).not.toContain(BOB_TITLE);
      expect(text.toLowerCase()).not.toContain("bob@example.com");
      expect(text).not.toContain(bob.id);
    }
    // Nobody else's data was lost from the copy, and it is still a readable database.
    const copy = JSON.parse(await readCopy(name ?? "")) as { version: number; accounts: Record<string, unknown>; users: Record<string, unknown> };
    expect(copy.version).toBe(1);
    expect(Object.keys(copy.accounts)).toEqual(["ann@example.test"]);
    expect(Object.keys(copy.users)).toEqual([ann.id]);
    expect(await readCopy(name ?? "")).toContain("ANN-TITLE");
  });

  it("removes the account from the copy that the delete itself makes, because the delete also drops the hand-edited row", async () => {
    const { bob, ann } = await seed();
    expect(await copies()).toEqual([]);
    expect(await deleteLocalAccount(bob.id, file)).toBe(true);
    const made = await copies();
    expect(made).toHaveLength(1);
    const text = await readCopy(made[0] ?? "");
    expect(text).not.toContain(BOB_TITLE);
    expect(text.toLowerCase()).not.toContain("bob@example.com");
    expect(text).not.toContain(bob.id);
    expect(text).toContain(ann.id);
    expect(text).toContain("ANN-TITLE");
  });

  it("removes a copy that could not be read as a database if it mentions the account, and leaves other copies alone", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = createLocalStore(file);
    const bob = await findOrCreateLocalAccount(BOB_EMAIL, file);
    const ann = await findOrCreateLocalAccount("ann@example.test", file);
    await store.createEntry(bob.id, makeInput({ title: BOB_TITLE }));
    const good = await fs.readFile(file, "utf8");
    await put(good.slice(0, -40)); // cut off: no longer JSON
    await expect(store.listEntries(ann.id)).rejects.toBeInstanceOf(StoreError);
    const [bobCopy] = await copies();
    expect(await readCopy(bobCopy ?? "")).toContain(BOB_TITLE);

    const unrelated = path.join(path.dirname(file), "local-db.json.corrupt-2020-01-01T00-00-00-000Z");
    await fs.writeFile(unrelated, "{ some other broken file with no names in it");
    const notACopy = path.join(path.dirname(file), "local-db.json.bak");
    await fs.writeFile(notACopy, `${BOB_TITLE} ${bob.id}`);
    await put(good);

    expect(await deleteLocalAccount(bob.id, file)).toBe(true);
    expect(await copies()).toEqual(["local-db.json.corrupt-2020-01-01T00-00-00-000Z"]);
    expect(await fs.readFile(unrelated, "utf8")).toBe("{ some other broken file with no names in it");
    expect(await fs.readFile(notACopy, "utf8")).toContain(BOB_TITLE); // not one of CPD Logger's copies
  });

  it("removes a copy that parses but is not a database, if it mentions the account", async () => {
    const { bob } = await seed();
    await put(JSON.stringify({ version: 1, accounts: {}, users: {} }));
    const stray = path.join(path.dirname(file), "local-db.json.corrupt-2021-01-01T00-00-00-000Z");
    await fs.writeFile(stray, JSON.stringify([`notes about ${bob.id}`]));
    await deleteLocalAccount(bob.id, file);
    expect(await copies()).toEqual([]);
  });

  it("keeps copy files private and still deletes the same account again as 'nothing to do'", async () => {
    const { store, bob, ann } = await seed();
    await store.createEntry(ann.id, makeInput({ title: "ANN-2" }));
    await deleteLocalAccount(bob.id, file);
    if (process.platform !== "win32") {
      for (const name of await copies()) expect((await fs.stat(path.join(path.dirname(file), name))).mode & 0o777).toBe(0o600);
    }
    expect(await deleteLocalAccount(bob.id, file)).toBe(false);
  });

  it("cleans the copies on a second try even when the account was already gone from the main file", async () => {
    const { store, bob, ann } = await seed();
    await store.createEntry(ann.id, makeInput({ title: "ANN-2" }));
    const [name] = await copies();
    // The account is gone from the main file, but a copy (made before) still holds it.
    const main = JSON.parse(await fs.readFile(file, "utf8")) as { accounts: Record<string, unknown>; users: Record<string, unknown> };
    delete main.accounts[BOB_EMAIL.toLowerCase()];
    delete main.users[bob.id];
    await put(JSON.stringify(main));
    expect(await deleteLocalAccount(bob.id, file)).toBe(true);
    expect(await readCopy(name ?? "")).not.toContain(BOB_TITLE);
  });

  it("says so, and still removes the account, when a copy cannot be cleaned", async () => {
    const { store, bob, ann } = await seed();
    await store.createEntry(ann.id, makeInput({ title: "ANN-2" }));
    // A directory with a copy's name cannot be read as a file.
    const stuck = path.join(path.dirname(file), "local-db.json.corrupt-2030-01-01T00-00-00-000Z");
    await fs.mkdir(stuck);
    const err = await caught<StoreError>(deleteLocalAccount(bob.id, file));
    expect(err).toBeInstanceOf(StoreError);
    expect(err.message).toContain("local-db.json.corrupt-2030-01-01T00-00-00-000Z");
    expect(err.message).toMatch(/could not be cleaned of its data/);
    expect(await fs.readFile(file, "utf8")).not.toContain(BOB_TITLE);
    // The copies that could be cleaned were cleaned on the first try.
    const [cleaned] = (await copies()).filter((n) => n !== "local-db.json.corrupt-2030-01-01T00-00-00-000Z");
    expect(await readCopy(cleaned ?? "")).not.toContain(BOB_TITLE);
    await fs.rmdir(stuck);
    expect(await deleteLocalAccount(bob.id, file)).toBe(false); // nothing left to remove
  });

  it("removes the same email from a copy even when it is filed there under an older id, along with that older id's data", async () => {
    const { bob } = await seed();
    const OLD_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    const copy = path.join(path.dirname(file), "local-db.json.corrupt-2023-01-01T00-00-00-000Z");
    await fs.writeFile(
      copy,
      JSON.stringify({
        version: 1,
        accounts: { "bob@example.com": { id: OLD_ID, createdAt: "2025-01-01T00:00:00.000Z" }, "other@example.test": { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", createdAt: "2025-01-01T00:00:00.000Z" } },
        users: { [OLD_ID]: { entries: [{ title: "OLD-BOB-TITLE" }] }, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee": { entries: [{ title: "OTHER-TITLE" }] } },
      }),
    );
    await deleteLocalAccount(bob.id, file);
    const text = await fs.readFile(copy, "utf8");
    expect(text.toLowerCase()).not.toContain("bob@example.com");
    expect(text).not.toContain(OLD_ID);
    expect(text).not.toContain("OLD-BOB-TITLE");
    expect(text).toContain("OTHER-TITLE");
  });

  it("removes a whole copy that still carries the account's id somewhere it cannot be cleaned out of, such as a row filed under another key", async () => {
    const { bob, ann } = await seed();
    const copy = path.join(path.dirname(file), "local-db.json.corrupt-2024-01-01T00-00-00-000Z");
    await fs.writeFile(
      copy,
      JSON.stringify({
        version: 1,
        accounts: {},
        users: { [ann.id]: { entries: [{ title: "MISFILED-BOB-ROW", userId: bob.id }] } },
      }),
    );
    await deleteLocalAccount(bob.id, file);
    expect(await exists(copy)).toBe(false);
  });

  it("does not delete a copy because a short user id happens to appear in it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await put(JSON.stringify({ version: 1, accounts: { "short@example.test": { id: "u1", createdAt: "2026-03-04T10:00:00.000Z" } }, users: { u1: { entries: [] } } }));
    const keep = path.join(path.dirname(file), "local-db.json.corrupt-2022-01-01T00-00-00-000Z");
    await fs.writeFile(keep, "this copy mentions u1 and u1 again and some other user u10");
    expect(await deleteLocalAccount("u1", file)).toBe(true);
    expect(await fs.readFile(keep, "utf8")).toContain("u10");
  });
});

describe("a session that outlives its account", () => {
  async function accountWithData() {
    const store = createLocalStore(file);
    const account = await findOrCreateLocalAccount("stale@example.test", file);
    await store.createEntry(account.id, makeInput({ title: "Mine" }));
    await store.saveSettings(account.id, { ...DEFAULT_SETTINGS, name: "Stale" });
    await store.incrementAiUsage(account.id, "2026-03", 5);
    return { store, account };
  }

  it("cannot bring the deleted account's data back by saving, adding or counting", async () => {
    const { store, account } = await accountWithData();
    await deleteLocalAccount(account.id, file);
    const writes = [
      () => store.saveSettings(account.id, { ...DEFAULT_SETTINGS, name: "Back again" }),
      () => store.createEntry(account.id, makeInput({ title: "Back again" })),
      () => store.createEntries(account.id, [makeInput({ title: "Back again" })]),
      () => store.incrementAiUsage(account.id, "2026-03", 5),
    ];
    for (const write of writes) {
      const err = await caught<StoreError>(write());
      expect(err).toBeInstanceOf(StoreError);
      expect(err.code).toBe("not_signed_in");
      expect(err.message).toMatch(/not signed in/);
    }
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as { accounts: object; users: object };
    expect(parsed.accounts).toEqual({});
    expect(parsed.users).toEqual({});
  });

  it("still reads as empty, and other operations on it find nothing and change nothing", async () => {
    const { store, account } = await accountWithData();
    await deleteLocalAccount(account.id, file);
    expect(await store.listEntries(account.id, { includeDeleted: true })).toEqual([]);
    expect(await store.getSettings(account.id)).toEqual(DEFAULT_SETTINGS);
    expect((await store.getAiUsage(account.id, "2026-03", 5)).used).toBe(0);
    expect(await store.updateEntry(account.id, "any", { title: "x" })).toBeNull();
    expect(await store.softDeleteEntry(account.id, "any")).toBeNull();
    expect(await store.restoreEntry(account.id, "any")).toBeNull();
    await expect(store.deleteAllUserData(account.id)).resolves.toBeUndefined();
  });

  it("is remembered across a restart, in the file, without keeping the id or the email", async () => {
    const { account } = await accountWithData();
    await deleteLocalAccount(account.id, file);
    const text = await fs.readFile(file, "utf8");
    expect(text).not.toContain(account.id);
    expect(text).not.toContain("stale@example.test");
    const parsed = JSON.parse(text) as { deletedAccounts: string[] };
    expect(parsed.deletedAccounts).toHaveLength(1);
    expect(parsed.deletedAccounts[0]).toMatch(/^[0-9a-f]{64}$/);
    await expect(createLocalStore(file).createEntry(account.id, makeInput())).rejects.toMatchObject({ code: "not_signed_in" });
  });

  it("does not block anyone else, or a new sign-in with the same email", async () => {
    const { store, account } = await accountWithData();
    const other = await findOrCreateLocalAccount("other@example.test", file);
    await deleteLocalAccount(account.id, file);
    await store.createEntry(other.id, makeInput({ title: "Other" }));
    await store.createEntry(A, makeInput({ title: "Direct id" })); // ids that never had an account still work without requireAccount
    const again = await findOrCreateLocalAccount("stale@example.test", file);
    expect(again.id).not.toBe(account.id);
    await store.createEntry(again.id, makeInput({ title: "Fresh start" }));
    expect((await store.listEntries(again.id)).map((e) => e.title)).toEqual(["Fresh start"]);
    expect((await store.listEntries(other.id)).map((e) => e.title)).toEqual(["Other"]);
  });

  it("only writes the list when something was deleted, so a file with no deletions keeps its three keys", async () => {
    const { account } = await accountWithData();
    expect(Object.keys(JSON.parse(await fs.readFile(file, "utf8")) as object).sort()).toEqual(["accounts", "users", "version"]);
    await deleteLocalAccount("not-an-account", file);
    expect(Object.keys(JSON.parse(await fs.readFile(file, "utf8")) as object).sort()).toEqual(["accounts", "users", "version"]);
    await deleteLocalAccount(account.id, file);
    expect(Object.keys(JSON.parse(await fs.readFile(file, "utf8")) as object).sort()).toEqual(["accounts", "deletedAccounts", "users", "version"]);
  });

  it("treats a damaged list of deleted accounts as damaged rows: kept, counted, and copied before it is rewritten", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const good = "a".repeat(64);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify({ version: 1, accounts: {}, users: {}, deletedAccounts: [good, 7, "short"] }));
    const store = createLocalStore(file);
    expect(await store.listEntries(A)).toEqual([]);
    await store.createEntry(A, makeInput());
    expect((await siblings()).filter((n) => n.includes(".corrupt-"))).toHaveLength(1);
    expect((JSON.parse(await fs.readFile(file, "utf8")) as { deletedAccounts: string[] }).deletedAccounts).toEqual([good]);
  });
});

describe("requireAccount", () => {
  it("refuses to save for an id that no account has, and writes nothing", async () => {
    const strict = createLocalStore(file, { requireAccount: true });
    const writes = [
      () => strict.saveSettings(A, DEFAULT_SETTINGS),
      () => strict.createEntry(A, makeInput()),
      () => strict.createEntries(A, [makeInput()]),
      () => strict.incrementAiUsage(A, "2026-03", 5),
    ];
    for (const write of writes) await expect(write()).rejects.toMatchObject({ name: "StoreError", code: "not_signed_in" });
    expect(await exists(file)).toBe(false);
  });

  it("accepts the ids of accounts that exist, including one made after the store was created", async () => {
    const strict = createLocalStore(file, { requireAccount: true });
    const ann = await findOrCreateLocalAccount("ann@example.test", file);
    await strict.createEntry(ann.id, makeInput({ title: "Ann's" }));
    await strict.saveSettings(ann.id, { ...DEFAULT_SETTINGS, name: "Ann" });
    expect((await strict.incrementAiUsage(ann.id, "2026-03", 5)).used).toBe(1);
    expect((await strict.listEntries(ann.id)).map((e) => e.title)).toEqual(["Ann's"]);
    await expect(strict.createEntry(B, makeInput())).rejects.toMatchObject({ code: "not_signed_in" });
  });

  it("never refuses a read", async () => {
    const strict = createLocalStore(file, { requireAccount: true });
    expect(await strict.listEntries(A)).toEqual([]);
    expect(await strict.getSettings(A)).toEqual(DEFAULT_SETTINGS);
    expect(await strict.getEntry(A, "x")).toBeNull();
    expect((await strict.getAiUsage(A, "2026-03", 5)).used).toBe(0);
  });

  it("is off unless asked for", async () => {
    await expect(createLocalStore(file).createEntry(A, makeInput())).resolves.toBeDefined();
  });
});

describe("hand-edit tolerance", () => {
  async function put(content: string): Promise<void> {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const stored = (over: Record<string, unknown> = {}) => ({
    ...makeInput({ title: "Kept" }),
    id: "id-good",
    userId: A,
    createdAt: "2026-03-04T10:00:00.000Z",
    updatedAt: "2026-03-05T10:00:00.000Z",
    deletedAt: null,
    ...over,
  });
  const dbText = (entries: unknown[]) => JSON.stringify({ version: 1, accounts: {}, users: { [A]: { entries } } });
  const copiesOf = async () => (await siblings()).filter((n) => n.includes(".corrupt-"));

  describe("a file that holds only blank space", () => {
    it("reads as an empty database, and a read leaves the file and the folder alone", async () => {
      await put("  \n\t \r\n");
      expect(await createLocalStore(file).listEntries(A)).toEqual([]);
      expect(await fs.readFile(file, "utf8")).toBe("  \n\t \r\n");
      expect(await siblings()).toEqual(["local-db.json"]);
    });

    it("is copied before the next write replaces it", async () => {
      await put("  \n\t \r\n");
      await createLocalStore(file, { now: () => new Date("2026-03-04T10:00:00.000Z") }).createEntry(A, makeInput({ title: "New" }));
      const copies = await copiesOf();
      expect(copies).toEqual(["local-db.json.corrupt-2026-03-04T10-00-00-000Z"]);
      expect(await fs.readFile(path.join(path.dirname(file), copies[0] ?? ""), "utf8")).toBe("  \n\t \r\n");
      expect((await createLocalStore(file).listEntries(A)).map((e) => e.title)).toEqual(["New"]);
    });

    it("is not copied again by the writes after that", async () => {
      await put("\n\n");
      const store = createLocalStore(file);
      await store.createEntry(A, makeInput({ title: "One" }));
      await store.createEntry(A, makeInput({ title: "Two" }));
      expect(await copiesOf()).toHaveLength(1);
    });

    it("refuses to save, and says why, when the copy cannot be made", async () => {
      await put("\n\n");
      const copy = vi.spyOn(fs, "copyFile").mockRejectedValue(Object.assign(new Error("disk full"), { code: "ENOSPC" }));
      const err = await caught<StoreError>(createLocalStore(file).createEntry(A, makeInput()));
      copy.mockRestore();
      expect(err.message).toMatch(/only blank space and a backup copy of it could not be made/);
      expect(await fs.readFile(file, "utf8")).toBe("\n\n");
    });

    it("is still an empty file with no copy when it has no bytes at all", async () => {
      await put("");
      await createLocalStore(file).createEntry(A, makeInput());
      expect(await copiesOf()).toEqual([]);
    });
  });

  describe("a byte-order mark at the start of the file", () => {
    it("is not damage: the file is read, and no copy is made", async () => {
      await put("﻿" + dbText([stored()]));
      const store = createLocalStore(file);
      expect((await store.listEntries(A)).map((e) => e.id)).toEqual(["id-good"]);
      await store.createEntry(A, makeInput({ title: "Added" }));
      expect(await copiesOf()).toEqual([]);
      const rewritten = await fs.readFile(file, "utf8");
      expect(rewritten.charCodeAt(0)).not.toBe(0xfeff);
      expect(() => JSON.parse(rewritten)).not.toThrow();
      expect((await store.listEntries(A)).map((e) => e.title).sort()).toEqual(["Added", "Kept"]);
    });

    it("on a file with nothing else is an empty database, copied before it is written over", async () => {
      await put("﻿");
      await createLocalStore(file).createEntry(A, makeInput());
      expect(await copiesOf()).toHaveLength(1);
    });

    it("on a file that is damaged apart from the mark is still reported as damaged", async () => {
      await put("﻿{ not json");
      await expect(createLocalStore(file).listEntries(A)).rejects.toThrow(/could not be read/);
      expect(await copiesOf()).toHaveLength(1);
    });
  });

  describe("a deleted entry whose deletedAt was edited", () => {
    it.each([
      ["a word", "garbage"],
      ["a number", 12345],
      ["true", true],
      ["false", false],
      ["an object", { at: "yesterday" }],
      ["a list", ["2026-03-05"]],
      ["an empty string", ""],
      ["a date that does not exist", "2026-13-45T99:99:99Z"],
    ])("stays deleted when it becomes %s", async (_name, deletedAt) => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      await put(dbText([stored({ id: "edited", deletedAt }), stored({ id: "live" })]));
      const store = createLocalStore(file);
      expect((await store.listEntries(A)).map((e) => e.id)).toEqual(["live"]);
      const all = await store.listEntries(A, { includeDeleted: true });
      expect(all.map((e) => e.id).sort()).toEqual(["edited", "live"]);
      expect(all.find((e) => e.id === "edited")?.deletedAt).toBe("2026-03-05T10:00:00.000Z");
      expect(all.find((e) => e.id === "live")?.deletedAt).toBeNull();
      expect(warn).not.toHaveBeenCalled(); // nothing was dropped
      // It can be restored from the bin, like any deleted entry.
      expect((await store.restoreEntry(A, "edited"))?.deletedAt).toBeNull();
      expect((await store.listEntries(A)).map((e) => e.id).sort()).toEqual(["edited", "live"]);
    });

    it("is dated by its creation time when it has no last-change time", async () => {
      const { updatedAt: _omit, ...noUpdatedAt } = stored({ id: "edited", deletedAt: "garbage" });
      await put(dbText([noUpdatedAt]));
      const store = createLocalStore(file);
      expect((await store.listEntries(A)).map((e) => e.id)).toEqual([]);
      const all = await store.listEntries(A, { includeDeleted: true });
      expect(all.map((e) => [e.id, e.deletedAt])).toEqual([["edited", "2026-03-04T10:00:00.000Z"]]);
    });

    it("keeps a readable time as it is, and a missing or null one means live", async () => {
      const { deletedAt: _omit, ...withoutDeletedAt } = stored({ id: "missing" });
      await put(dbText([stored({ id: "gone", deletedAt: "2026-03-06T08:00:00+01:00" }), stored({ id: "null", deletedAt: null }), withoutDeletedAt]));
      const store = createLocalStore(file);
      expect((await store.listEntries(A)).map((e) => e.id).sort()).toEqual(["missing", "null"]);
      expect((await store.getEntry(A, "gone"))?.deletedAt).toBe("2026-03-06T07:00:00.000Z");
    });
  });
});
