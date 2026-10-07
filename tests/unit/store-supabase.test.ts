import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseStore } from "@/lib/store/supabase";
import { StoreError, StoreInputError } from "@/lib/store/mapping";
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
const FAKE_SECRET = "sk-ant-api03-SECRETSECRETSECRETSECRET";
const FAKE_JWT = "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiIsInN1YiI6InNlY3JldCJ9.c2lnbmF0dXJlLXNlY3JldC12YWx1ZQ";

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

// ---------------------------------------------------------------------------------------------
// A small fake of the parts of the Supabase client the store uses. It behaves like Postgres with
// row-level security on: it only lets the signed-in session user (authUid) see or change their own rows,
// whatever the query says. It also records every call so tests can check what the store asked for.

type Row = Record<string, unknown>;
type Filter = { op: "eq" | "is" | "not"; col: string; val: unknown; neg?: boolean };

interface RecordedCall {
  table: string | null;
  rpc: string | null;
  action: "select" | "insert" | "update" | "upsert" | "delete" | "rpc";
  filters: Filter[];
  payload: unknown;
  args: unknown;
  orders: { col: string; ascending: boolean }[];
  range: [number, number] | null;
  single: boolean;
}

interface FakeOptions {
  authUid: string | null;
  supabaseKey?: string;
}

class FakeWorld {
  tables: Record<string, Row[]> = { cpd_entries: [], user_settings: [] };
  usage = new Map<string, number>();
  calls: RecordedCall[] = [];
  /** When set, the next query returns this error. */
  failNext: { error: Record<string, unknown>; status?: number } | null = null;
  /** When set, the next query throws, like a dropped connection. */
  throwNext = false;
  /** When set, rpc calls return this instead of running. */
  rpcOverride: { data: unknown } | null = null;
  clock = 0;

  constructor(public options: FakeOptions) {}

  nextTimestamp(): string {
    this.clock += 1;
    return new Date(Date.UTC(2026, 2, 4, 10, 0, this.clock)).toISOString();
  }

  visible(table: string): Row[] {
    return (this.tables[table] ?? []).filter((r) => r.user_id === this.options.authUid);
  }
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((f) => {
    const v = row[f.col];
    if (f.op === "eq") return v === f.val;
    if (f.op === "is") return f.val === null ? v === null || v === undefined : v === f.val;
    // not(col, "is", null)
    return !(f.val === null ? v === null || v === undefined : v === f.val);
  });
}

class FakeBuilder implements PromiseLike<unknown> {
  private call: RecordedCall;
  constructor(private world: FakeWorld, table: string | null, rpc: string | null, args?: unknown) {
    this.call = { table, rpc, action: rpc ? "rpc" : "select", filters: [], payload: null, args: args ?? null, orders: [], range: null, single: false };
    world.calls.push(this.call);
  }
  select(_cols?: string) {
    return this;
  }
  insert(payload: unknown) {
    this.call.action = "insert";
    this.call.payload = payload;
    return this;
  }
  update(payload: unknown) {
    this.call.action = "update";
    this.call.payload = payload;
    return this;
  }
  upsert(payload: unknown, opts?: unknown) {
    this.call.action = "upsert";
    this.call.payload = payload;
    this.call.args = opts ?? null;
    return this;
  }
  delete() {
    this.call.action = "delete";
    return this;
  }
  eq(col: string, val: unknown) {
    this.call.filters.push({ op: "eq", col, val });
    return this;
  }
  is(col: string, val: unknown) {
    this.call.filters.push({ op: "is", col, val });
    return this;
  }
  not(col: string, op: string, val: unknown) {
    if (op !== "is") throw new Error("fake supports not(..., 'is', ...) only");
    this.call.filters.push({ op: "not", col, val });
    return this;
  }
  order(col: string, opts?: { ascending?: boolean }) {
    this.call.orders.push({ col, ascending: opts?.ascending !== false });
    return this;
  }
  range(from: number, to: number) {
    this.call.range = [from, to];
    return this;
  }
  maybeSingle() {
    this.call.single = true;
    return this;
  }
  single() {
    this.call.single = true;
    return this;
  }
  then<R1 = unknown, R2 = never>(onfulfilled?: ((v: unknown) => R1 | PromiseLike<R1>) | null, onrejected?: ((r: unknown) => R2 | PromiseLike<R2>) | null): PromiseLike<R1 | R2> {
    return Promise.resolve()
      .then(() => this.execute())
      .then(onfulfilled, onrejected);
  }

  private execute(): unknown {
    const w = this.world;
    if (w.throwNext) {
      w.throwNext = false;
      throw new TypeError(`fetch failed for key ${FAKE_SECRET}`);
    }
    if (w.failNext) {
      const f = w.failNext;
      w.failNext = null;
      return { data: null, error: f.error, status: f.status ?? 400 };
    }
    const c = this.call;
    if (c.rpc) return this.executeRpc();
    const table = c.table ?? "";
    const rows = w.tables[table];
    if (!rows) return { data: null, error: { code: "42P01", message: `relation "${table}" does not exist` }, status: 404 };

    const rlsError = { code: "42501", message: `new row violates row-level security policy for table "${table}" (row: ${FAKE_SECRET})`, details: "Failing row contains (secret)" };
    const out = (data: Row[]): unknown => {
      if (c.single) return { data: data[0] ?? null, error: null, status: 200 };
      return { data, error: null, status: 200 };
    };

    if (c.action === "select") {
      let result = w.visible(table).filter((r) => matches(r, c.filters));
      for (const o of [...c.orders].reverse()) {
        result = [...result].sort((a, b) => {
          const av = String(a[o.col] ?? "");
          const bv = String(b[o.col] ?? "");
          return av === bv ? 0 : (av < bv ? -1 : 1) * (o.ascending ? 1 : -1);
        });
      }
      if (c.range) result = result.slice(c.range[0], c.range[1] + 1);
      return out(result);
    }
    if (c.action === "insert") {
      const list = (Array.isArray(c.payload) ? c.payload : [c.payload]) as Row[];
      const created: Row[] = [];
      for (const r of list) {
        if ((r.user_id ?? w.options.authUid) !== w.options.authUid) return { data: null, error: rlsError, status: 403 };
        const stamp = w.nextTimestamp();
        created.push({ id: crypto.randomUUID(), user_id: w.options.authUid, created_at: stamp, updated_at: stamp, deleted_at: null, ...r });
      }
      rows.push(...created);
      return out(created);
    }
    if (c.action === "update") {
      const targets = w.visible(table).filter((r) => matches(r, c.filters));
      for (const t of targets) Object.assign(t, c.payload as Row, { updated_at: w.nextTimestamp() });
      return out(targets);
    }
    if (c.action === "upsert") {
      const payload = c.payload as Row;
      if (payload.user_id !== w.options.authUid) return { data: null, error: rlsError, status: 403 };
      const existing = rows.find((r) => r.user_id === payload.user_id);
      if (existing) Object.assign(existing, payload, { updated_at: w.nextTimestamp() });
      else rows.push({ ...payload, updated_at: w.nextTimestamp() });
      return out([existing ?? (rows[rows.length - 1] as Row)]);
    }
    // delete
    const doomed = new Set(w.visible(table).filter((r) => matches(r, c.filters)));
    w.tables[table] = rows.filter((r) => !doomed.has(r));
    return out([...doomed]);
  }

  private executeRpc(): unknown {
    const w = this.world;
    const c = this.call;
    if (w.rpcOverride) return { data: w.rpcOverride.data, error: null, status: 200 };
    const uid = w.options.authUid;
    if (!uid) return { data: null, error: { code: "28000", message: "You are not signed in." }, status: 400 };
    const args = c.args as { p_month?: string; p_cap?: number };
    const key = `${uid}|${args.p_month}`;
    const used = w.usage.get(key) ?? 0;
    if (c.rpc === "get_ai_usage") return { data: used, error: null, status: 200 };
    if (c.rpc === "increment_ai_usage") {
      const cap = args.p_cap ?? 0;
      if (cap > 0 && used < cap) {
        w.usage.set(key, used + 1);
        return { data: [{ allowed: true, used: used + 1 }], error: null, status: 200 };
      }
      return { data: [{ allowed: false, used }], error: null, status: 200 };
    }
    return { data: null, error: { code: "42883", message: "function does not exist" }, status: 404 };
  }
}

function fakeClient(world: FakeWorld): SupabaseClient {
  const client = {
    from: (table: string) => new FakeBuilder(world, table, null),
    rpc: (fn: string, args?: unknown) => new FakeBuilder(world, null, fn, args),
    ...(world.options.supabaseKey ? { supabaseKey: world.options.supabaseKey } : {}),
  };
  return client as unknown as SupabaseClient;
}

function setup(authUid: string | null = A, extra: Partial<FakeOptions> = {}) {
  const world = new FakeWorld({ authUid, ...extra });
  const store = createSupabaseStore(fakeClient(world), { now: () => new Date("2026-04-01T12:00:00.000Z") });
  return { world, store };
}

function jwtWithRole(role: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ role })}.c2ln`;
}

describe("always scoped to the user", () => {
  it("adds user_id to every query on entries and settings, even though row-level security would also apply", async () => {
    const { world, store } = setup();
    const e = await store.createEntry(A, makeInput());
    await store.createEntries(A, [makeInput(), makeInput()]);
    await store.listEntries(A);
    await store.listEntries(A, { includeDeleted: true });
    await store.getEntry(A, e.id);
    await store.updateEntry(A, e.id, { title: "x" });
    await store.softDeleteEntry(A, e.id);
    await store.restoreEntry(A, e.id);
    await store.getSettings(A);
    await store.saveSettings(A, DEFAULT_SETTINGS);
    await store.deleteAllUserData(A);

    const queried = world.calls.filter((c) => c.table);
    expect(queried.length).toBeGreaterThan(10);
    for (const call of queried) {
      if (call.action === "insert") {
        const rows = (Array.isArray(call.payload) ? call.payload : [call.payload]) as Row[];
        for (const r of rows) expect(r.user_id).toBe(A);
      } else if (call.action === "upsert") {
        expect((call.payload as Row).user_id).toBe(A);
      } else {
        expect(call.filters, `${call.action} on ${call.table}`).toContainEqual({ op: "eq", col: "user_id", val: A });
      }
    }
  });

  it("filters entry reads, updates and deletes by id AND user_id together", async () => {
    const { world, store } = setup();
    const e = await store.createEntry(A, makeInput());
    world.calls.length = 0;
    await store.getEntry(A, e.id);
    await store.updateEntry(A, e.id, { title: "x" });
    await store.softDeleteEntry(A, e.id);
    for (const call of world.calls) {
      expect(call.filters).toContainEqual({ op: "eq", col: "id", val: e.id });
      expect(call.filters).toContainEqual({ op: "eq", col: "user_id", val: A });
    }
  });

  it("never sends a user id to the database functions (they use auth.uid())", async () => {
    const { world, store } = setup();
    await store.incrementAiUsage(A, "2026-04", 5);
    await store.getAiUsage(A, "2026-04", 5);
    const rpcs = world.calls.filter((c) => c.rpc);
    expect(rpcs.map((c) => c.rpc)).toEqual(["increment_ai_usage", "get_ai_usage"]);
    expect(rpcs[0]?.args).toEqual({ p_month: "2026-04", p_cap: 5 });
    expect(rpcs[1]?.args).toEqual({ p_month: "2026-04" });
    for (const c of rpcs) expect(JSON.stringify(c.args)).not.toContain(A);
  });

  it("relies on row-level security too: another user's session returns nothing, whatever id is asked for", async () => {
    const { world, store } = setup(A);
    const mine = await store.createEntry(A, makeInput({ title: "A's" }));
    // The same data, but the session now belongs to B, and the code asks for A's rows by A's id.
    world.options.authUid = B;
    expect(await store.listEntries(A)).toEqual([]);
    expect(await store.getEntry(A, mine.id)).toBeNull();
    expect(await store.updateEntry(A, mine.id, { title: "hijack" })).toBeNull();
    expect(await store.softDeleteEntry(A, mine.id)).toBeNull();
    expect(await store.restoreEntry(A, mine.id)).toBeNull();
    expect((await store.getSettings(A)).name).toBe("");
    world.options.authUid = A;
    expect((await store.getEntry(A, mine.id))?.title).toBe("A's");
  });

  it("and when the code asks for B's rows with A's session, the filter returns nothing", async () => {
    const { world, store } = setup(A);
    world.tables.cpd_entries?.push({ id: "99999999-9999-4999-8999-999999999999", user_id: B, title: "B's" });
    expect(await store.listEntries(B)).toEqual([]);
    expect(await store.getEntry(B, "99999999-9999-4999-8999-999999999999")).toBeNull();
  });

  it("a forged insert for another user is refused by the policy and becomes a sign-in message", async () => {
    const { store } = setup(A);
    await expect(store.createEntry(B, makeInput())).rejects.toMatchObject({ name: "StoreError", code: "not_signed_in" });
  });

  it("refuses a user id that is not a UUID before any query is made", async () => {
    const { world, store } = setup();
    for (const bad of ["", "not-a-uuid", "1 OR 1=1", "../../etc"]) {
      await expect(store.listEntries(bad)).rejects.toMatchObject({ code: "not_signed_in" });
      await expect(store.createEntry(bad, makeInput())).rejects.toMatchObject({ code: "not_signed_in" });
    }
    expect(world.calls).toHaveLength(0);
  });

  it("returns null for an entry id that is not a UUID, without asking the database", async () => {
    const { world, store } = setup();
    expect(await store.getEntry(A, "not-a-uuid")).toBeNull();
    expect(await store.updateEntry(A, "x'; drop table cpd_entries;--", { title: "x" })).toBeNull();
    expect(await store.softDeleteEntry(A, "")).toBeNull();
    expect(await store.restoreEntry(A, "1")).toBeNull();
    expect(world.calls).toHaveLength(0);
  });
});

describe("the client it is given", () => {
  it("refuses a client built with a service-role JWT", () => {
    const world = new FakeWorld({ authUid: A, supabaseKey: jwtWithRole("service_role") });
    expect(() => createSupabaseStore(fakeClient(world))).toThrow(/service-role/);
  });

  it("refuses a client built with a new-style secret key and never prints the key", () => {
    const secret = "sb_secret_abcdefghijklmnop1234";
    const world = new FakeWorld({ authUid: A, supabaseKey: secret });
    try {
      createSupabaseStore(fakeClient(world));
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/service-role/);
      expect((e as Error).message).not.toContain(secret);
    }
  });

  it("accepts a client built with an anon key", () => {
    const world = new FakeWorld({ authUid: A, supabaseKey: jwtWithRole("anon") });
    expect(() => createSupabaseStore(fakeClient(world))).not.toThrow();
    const world2 = new FakeWorld({ authUid: A, supabaseKey: "sb_publishable_abcdefghijklmnop1234" });
    expect(() => createSupabaseStore(fakeClient(world2))).not.toThrow();
  });

  it("accepts a client that exposes no key at all, and one with a malformed key", () => {
    expect(() => createSupabaseStore(fakeClient(new FakeWorld({ authUid: A })))).not.toThrow();
    expect(() => createSupabaseStore(fakeClient(new FakeWorld({ authUid: A, supabaseKey: "a.b" })))).not.toThrow();
    expect(() => createSupabaseStore(fakeClient(new FakeWorld({ authUid: A, supabaseKey: "a.%%%.c" })))).not.toThrow();
  });
});

describe("entries", () => {
  it("creates an entry and returns it as an Entry", async () => {
    const { world, store } = setup();
    const e = await store.createEntry(A, makeInput({ title: "Hello", hours: 1.234 }));
    expect(e).toMatchObject({ userId: A, title: "Hello", hours: 1.23, deletedAt: null });
    expect(e.id).toMatch(/^[0-9a-f-]{36}$/);
    const insert = world.calls.find((c) => c.action === "insert");
    expect(insert?.payload).toMatchObject({ user_id: A, source_type: "article", date_completed: "2026-03-04", hours: 1.23, deleted_at: null });
    expect(insert?.payload).not.toHaveProperty("id");
    expect(insert?.payload).not.toHaveProperty("created_at");
  });

  it("validates before sending anything", async () => {
    const { world, store } = setup();
    await expect(store.createEntry(A, makeInput({ hours: -1 }))).rejects.toBeInstanceOf(StoreInputError);
    await expect(store.createEntries(A, [makeInput(), makeInput({ dateCompleted: "nope" })])).rejects.toBeInstanceOf(StoreInputError);
    await expect(store.updateEntry(A, "99999999-9999-4999-8999-999999999999", { hours: -1 })).rejects.toBeInstanceOf(StoreInputError);
    expect(world.calls).toHaveLength(0);
  });

  it("createEntries is one insert call and returns every row", async () => {
    const { world, store } = setup();
    const made = await store.createEntries(A, [makeInput({ title: "1" }), makeInput({ title: "2" }), makeInput({ title: "3" })]);
    expect(made.map((e) => e.title)).toEqual(["1", "2", "3"]);
    expect(world.calls.filter((c) => c.action === "insert")).toHaveLength(1);
  });

  it("createEntries with no rows makes no call", async () => {
    const { world, store } = setup();
    expect(await store.createEntries(A, [])).toEqual([]);
    expect(world.calls).toHaveLength(0);
  });

  it("lists live entries, newest first, and asks the database to sort", async () => {
    const { world, store } = setup();
    await store.createEntry(A, makeInput({ title: "old", dateCompleted: "2026-01-01" }));
    await store.createEntry(A, makeInput({ title: "new", dateCompleted: "2026-03-01" }));
    const gone = await store.createEntry(A, makeInput({ title: "gone", dateCompleted: "2026-02-01" }));
    await store.softDeleteEntry(A, gone.id);
    world.calls.length = 0;
    expect((await store.listEntries(A)).map((e) => e.title)).toEqual(["new", "old"]);
    const call = world.calls[0];
    expect(call?.filters).toContainEqual({ op: "is", col: "deleted_at", val: null });
    expect(call?.orders.slice(0, 2)).toEqual([
      { col: "date_completed", ascending: false },
      { col: "created_at", ascending: false },
    ]);
    expect((await store.listEntries(A, { includeDeleted: true })).map((e) => e.title)).toEqual(["new", "gone", "old"]);
    expect(world.calls[1]?.filters).not.toContainEqual({ op: "is", col: "deleted_at", val: null });
  });

  it("reads every page when there are more rows than one request returns", async () => {
    const { world, store } = setup();
    const rows = Array.from({ length: 2500 }, (_, i) => ({
      id: crypto.randomUUID(),
      user_id: A,
      profile: "ice",
      title: `Row ${i}`,
      source_type: "article",
      date_completed: "2026-03-04",
      hours: 1,
      hours_confirmed: true,
      created_at: new Date(Date.UTC(2026, 2, 4, 10, 0, 0, i)).toISOString(),
      updated_at: "2026-03-04T10:00:00.000Z",
      deleted_at: null,
    }));
    world.tables.cpd_entries = rows;
    const list = await store.listEntries(A);
    expect(list).toHaveLength(2500);
    expect(new Set(list.map((e) => e.id)).size).toBe(2500);
    expect(world.calls.map((c) => c.range)).toEqual([[0, 999], [1000, 1999], [2000, 2999]]);
  });

  it("warns with a count only when rows cannot be read, and returns the rest", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { world, store } = setup();
    await store.createEntry(A, makeInput({ title: "fine" }));
    world.tables.cpd_entries?.push({ id: crypto.randomUUID(), user_id: A, title: "SECRET-TITLE", hours: "lots", deleted_at: null });
    const list = await store.listEntries(A);
    expect(list.map((e) => e.title)).toEqual(["fine"]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).not.toContain("SECRET-TITLE");
    warn.mockRestore();
  });

  it("updates only the fields sent, mapped to snake_case, only on live rows", async () => {
    const { world, store } = setup();
    const e = await store.createEntry(A, makeInput());
    world.calls.length = 0;
    const u = await store.updateEntry(A, e.id, { title: "Changed", sourceType: "video", id: "evil", userId: B, deletedAt: "2020-01-01T00:00:00Z" } as Partial<EntryInput>);
    expect(u).toMatchObject({ title: "Changed", sourceType: "video", userId: A, id: e.id, deletedAt: null });
    expect(world.calls[0]?.payload).toEqual({ title: "Changed", source_type: "video" });
    expect(world.calls[0]?.filters).toContainEqual({ op: "is", col: "deleted_at", val: null });
  });

  it("an empty update just returns the live entry", async () => {
    const { store } = setup();
    const e = await store.createEntry(A, makeInput());
    expect(await store.updateEntry(A, e.id, {})).toEqual(e);
    await store.softDeleteEntry(A, e.id);
    expect(await store.updateEntry(A, e.id, {})).toBeNull();
  });

  it("returns null when updating an entry that does not exist or is soft-deleted", async () => {
    const { store } = setup();
    expect(await store.updateEntry(A, "99999999-9999-4999-8999-999999999999", { title: "x" })).toBeNull();
    const e = await store.createEntry(A, makeInput());
    await store.softDeleteEntry(A, e.id);
    expect(await store.updateEntry(A, e.id, { title: "x" })).toBeNull();
  });

  it("getEntry returns a soft-deleted entry (so a bin or undo can show it) and null for a missing one", async () => {
    const { store } = setup();
    const e = await store.createEntry(A, makeInput());
    await store.softDeleteEntry(A, e.id);
    expect((await store.getEntry(A, e.id))?.deletedAt).not.toBeNull();
    expect(await store.getEntry(A, "99999999-9999-4999-8999-999999999999")).toBeNull();
  });
});

describe("soft delete and restore", () => {
  it("soft delete sets deleted_at to the current time and does not remove the row", async () => {
    const { world, store } = setup();
    const e = await store.createEntry(A, makeInput());
    world.calls.length = 0;
    const d = await store.softDeleteEntry(A, e.id);
    expect(d?.deletedAt).toBe("2026-04-01T12:00:00.000Z");
    expect(world.calls[0]).toMatchObject({ action: "update", payload: { deleted_at: "2026-04-01T12:00:00.000Z" } });
    expect(world.calls.some((c) => c.action === "delete")).toBe(false);
    expect(world.tables.cpd_entries).toHaveLength(1);
  });

  it("soft delete only touches rows that are not already deleted, so the first time is kept", async () => {
    const { world, store } = setup();
    const e = await store.createEntry(A, makeInput());
    const first = await store.softDeleteEntry(A, e.id);
    world.calls.length = 0;
    const second = await store.softDeleteEntry(A, e.id);
    expect(second?.deletedAt).toBe(first?.deletedAt);
    expect(world.calls[0]?.filters).toContainEqual({ op: "is", col: "deleted_at", val: null });
  });

  it("restore sets deleted_at back to null, and only for rows that are deleted", async () => {
    const { world, store } = setup();
    const e = await store.createEntry(A, makeInput());
    await store.softDeleteEntry(A, e.id);
    world.calls.length = 0;
    const r = await store.restoreEntry(A, e.id);
    expect(r?.deletedAt).toBeNull();
    expect(world.calls[0]).toMatchObject({ action: "update", payload: { deleted_at: null } });
    expect(world.calls[0]?.filters).toContainEqual({ op: "not", col: "deleted_at", val: null });
    const again = await store.restoreEntry(A, e.id);
    expect(again).toEqual(r);
  });

  it("returns null for unknown entries", async () => {
    const { store } = setup();
    expect(await store.softDeleteEntry(A, "99999999-9999-4999-8999-999999999999")).toBeNull();
    expect(await store.restoreEntry(A, "99999999-9999-4999-8999-999999999999")).toBeNull();
  });
});

describe("settings", () => {
  it("returns the defaults when no row exists", async () => {
    const { store } = setup();
    expect(await store.getSettings(A)).toEqual(DEFAULT_SETTINGS);
  });

  it("saves with an upsert on user_id and reads the settings back", async () => {
    const { world, store } = setup();
    const s: UserSettings = { ...DEFAULT_SETTINGS, name: "Ann", activeProfiles: ["ice", "custom"], customFields: [{ key: "site", label: "Site", type: "text" }] };
    expect(await store.saveSettings(A, s)).toEqual(s);
    const up = world.calls.find((c) => c.action === "upsert");
    expect(up?.args).toEqual({ onConflict: "user_id" });
    expect(up?.payload).toMatchObject({ user_id: A, name: "Ann", active_profiles: ["ice", "custom"], custom_fields: [{ key: "site", label: "Site", type: "text" }] });
    expect(await store.getSettings(A)).toEqual(s);
    await store.saveSettings(A, { ...s, name: "Ann B" });
    expect(world.tables.user_settings).toHaveLength(1);
  });

  it("rejects invalid settings before any query", async () => {
    const { world, store } = setup();
    await expect(store.saveSettings(A, { ...DEFAULT_SETTINGS, activeProfiles: [] })).rejects.toBeInstanceOf(StoreInputError);
    expect(world.calls).toHaveLength(0);
  });
});

describe("deleting all of a user's data", () => {
  it("removes entries (live and deleted) and settings for that user only, and never touches ai_usage", async () => {
    const { world, store } = setup(A);
    const e = await store.createEntry(A, makeInput());
    await store.softDeleteEntry(A, e.id);
    await store.createEntry(A, makeInput());
    await store.saveSettings(A, { ...DEFAULT_SETTINGS, name: "Ann" });
    world.tables.cpd_entries?.push({ id: "99999999-9999-4999-8999-999999999999", user_id: B, title: "B's" });
    world.calls.length = 0;
    await store.deleteAllUserData(A);
    expect(world.tables.cpd_entries?.map((r) => r.user_id)).toEqual([B]);
    expect(world.tables.user_settings).toHaveLength(0);
    expect(world.calls.map((c) => [c.table, c.action])).toEqual([["cpd_entries", "delete"], ["user_settings", "delete"]]);
    for (const c of world.calls) expect(c.filters).toEqual([{ op: "eq", col: "user_id", val: A }]);
  });
});

describe("AI usage", () => {
  it("increments through the database function and stops at the cap", async () => {
    const { store } = setup();
    expect(await store.incrementAiUsage(A, "2026-04", 2)).toEqual({ allowed: true, used: 1, cap: 2 });
    expect(await store.incrementAiUsage(A, "2026-04", 2)).toEqual({ allowed: true, used: 2, cap: 2 });
    expect(await store.incrementAiUsage(A, "2026-04", 2)).toEqual({ allowed: false, used: 2, cap: 2 });
  });

  it("reads usage without incrementing it", async () => {
    const { store } = setup();
    await store.incrementAiUsage(A, "2026-04", 3);
    expect(await store.getAiUsage(A, "2026-04", 3)).toEqual({ allowed: true, used: 1, cap: 3 });
    expect(await store.getAiUsage(A, "2026-04", 3)).toEqual({ allowed: true, used: 1, cap: 3 });
    await store.incrementAiUsage(A, "2026-04", 3);
    await store.incrementAiUsage(A, "2026-04", 3);
    expect(await store.getAiUsage(A, "2026-04", 3)).toEqual({ allowed: false, used: 3, cap: 3 });
  });

  it("sends a cap of zero for a bad cap, so nothing is allowed", async () => {
    const { world, store } = setup();
    for (const cap of [0, -3, Number.NaN]) {
      expect(await store.incrementAiUsage(A, "2026-04", cap)).toEqual({ allowed: false, used: 0, cap: 0 });
    }
    expect(world.calls.every((c) => (c.args as { p_cap: number }).p_cap === 0)).toBe(true);
  });

  it("rejects a bad month before any call", async () => {
    const { world, store } = setup();
    await expect(store.incrementAiUsage(A, "April 2026", 5)).rejects.toBeInstanceOf(StoreInputError);
    await expect(store.getAiUsage(A, "2026-4", 5)).rejects.toBeInstanceOf(StoreInputError);
    expect(world.calls).toHaveLength(0);
  });

  it("fails safely when the function returns something unexpected", async () => {
    const { world, store } = setup();
    for (const data of [null, [], [{}], [{ allowed: "yes", used: 1 }], [{ allowed: true, used: -1 }], [{ allowed: true, used: 1.5 }], "x"]) {
      world.rpcOverride = { data };
      await expect(store.incrementAiUsage(A, "2026-04", 5)).rejects.toBeInstanceOf(StoreError);
    }
    for (const data of [null, "abc", -1, 1.5, {}]) {
      world.rpcOverride = { data };
      await expect(store.getAiUsage(A, "2026-04", 5)).rejects.toBeInstanceOf(StoreError);
    }
  });

  it("accepts a count that comes back as a numeric string, and a single object instead of a list", async () => {
    const { world, store } = setup();
    world.rpcOverride = { data: "4" };
    expect(await store.getAiUsage(A, "2026-04", 5)).toEqual({ allowed: true, used: 4, cap: 5 });
    world.rpcOverride = { data: { allowed: true, used: 2 } };
    expect(await store.incrementAiUsage(A, "2026-04", 5)).toEqual({ allowed: true, used: 2, cap: 5 });
  });
});

describe("errors", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  async function failWith(error: Record<string, unknown>, status?: number): Promise<StoreError> {
    ctx.world.failNext = { error, status };
    try {
      await ctx.store.listEntries(A);
    } catch (e) {
      expect(e).toBeInstanceOf(StoreError);
      return e as StoreError;
    }
    throw new Error("Expected an error");
  }

  const leaky = {
    message: `JWT expired. apikey=${FAKE_JWT} key ${FAKE_SECRET} Failing row contains (SECRET-TITLE, 5)`,
    details: `Key (user_id)=(${A}) with ${FAKE_SECRET}`,
    hint: `use ${FAKE_JWT}`,
  };

  it.each([
    ["a row-level security violation", { code: "42501" }, 403, "not_signed_in", /Sign in again/],
    ["an invalid JWT", { code: "PGRST301" }, 401, "not_signed_in", /Sign in again/],
    ["a 401 with no code", { code: "" }, 401, "not_signed_in", /Sign in again/],
    ["a check constraint", { code: "23514" }, 400, "invalid", /did not accept some of the values/],
    ["a not-null violation", { code: "23502" }, 400, "invalid", /did not accept some of the values/],
    ["a numeric overflow", { code: "22003" }, 400, "invalid", /did not accept some of the values/],
    ["a missing table", { code: "42P01" }, 404, "failed", /Run supabase\/migrations\/0001_init\.sql/],
    ["a missing function", { code: "PGRST202" }, 404, "failed", /Run supabase\/migrations\/0001_init\.sql/],
    ["a server error", { code: "XX000" }, 500, "unavailable", /could not reach the database|returned an error/],
    ["a network failure", { code: "" }, 0, "unavailable", /could not reach the database/],
    ["an unknown code", { code: "P0001" }, 400, "failed", /database returned an error/],
  ])("turns %s into a friendly error", async (_name, code, status, kind, text) => {
    const err = await failWith({ ...leaky, ...code }, status);
    expect(err.code).toBe(kind);
    expect(err.message).toMatch(text);
  });

  it("never copies the database message, details, hint, keys or row data into the error", async () => {
    for (const code of ["42501", "23514", "42P01", "XX000", "P0001", "PGRST301", ""]) {
      const err = await failWith({ ...leaky, code }, 400);
      const everything = [err.message, err.name, String(err), err.stack ?? "", JSON.stringify(err), String(err.cause ?? "")].join("\n");
      expect(everything).not.toContain(FAKE_SECRET);
      expect(everything).not.toContain(FAKE_JWT);
      expect(everything).not.toContain("SECRET-TITLE");
      expect(everything).not.toContain(A);
      expect(everything).not.toContain("apikey");
      expect(err.cause).toBeUndefined();
    }
  });

  it("keeps only a short database code for logging, never a message", async () => {
    expect((await failWith({ ...leaky, code: "23514" }, 400)).dbCode).toBe("23514");
    expect((await failWith({ ...leaky, code: `bad ${FAKE_SECRET}` }, 400)).dbCode).toBeUndefined();
  });

  it("turns a thrown network error into a friendly error without its text", async () => {
    ctx.world.throwNext = true;
    const err = await caught<StoreError>(ctx.store.listEntries(A));
    expect(err).toBeInstanceOf(StoreError);
    expect(err.code).toBe("unavailable");
    expect(err.message).not.toContain(FAKE_SECRET);
    expect(String(err.stack)).not.toContain(FAKE_SECRET);
  });

  it("applies to writes and database function calls too", async () => {
    ctx.world.failNext = { error: { ...leaky, code: "23514" }, status: 400 };
    const e1 = await caught<StoreError>(ctx.store.createEntry(A, makeInput()));
    expect(e1.code).toBe("invalid");
    expect(e1.message).not.toContain(FAKE_SECRET);
    ctx.world.failNext = { error: { ...leaky, code: "28000" }, status: 400 };
    const e2 = await caught<StoreError>(ctx.store.incrementAiUsage(A, "2026-04", 5));
    expect(e2.code).toBe("not_signed_in");
    expect(e2.message).not.toContain(FAKE_JWT);
    ctx.world.failNext = { error: { ...leaky, code: "XX000" }, status: 503 };
    const e3 = await caught<StoreError>(ctx.store.deleteAllUserData(A));
    expect(e3.code).toBe("unavailable");
  });

  it("reports an unreadable saved entry instead of returning garbage", async () => {
    ctx.world.tables.cpd_entries = [{ id: "99999999-9999-4999-8999-999999999999", user_id: A, title: "x", hours: "bad" }];
    const err = await caught<StoreError>(ctx.store.getEntry(A, "99999999-9999-4999-8999-999999999999"));
    expect(err).toBeInstanceOf(StoreError);
    expect(err.message).toMatch(/Reload the page/);
  });
});

// ---------------------------------------------------------------------------------------------
// The same store against the REAL supabase-js client, with only the network stubbed. This checks the
// requests that would actually be sent (paths, filters, headers), which the fake above cannot.

describe("with the real supabase-js client (network stubbed)", () => {
  const ANON = "sb_publishable_abcdefghijklmnop1234";
  const ROW_ID = "99999999-9999-4999-8999-999999999999";
  const row = {
    id: ROW_ID,
    user_id: A,
    profile: "ice",
    title: "Stub row",
    source_type: "article",
    date_completed: "2026-03-04",
    hours: 1,
    hours_confirmed: true,
    created_at: "2026-03-04T10:00:00+00:00",
    updated_at: "2026-03-04T10:00:00+00:00",
    deleted_at: null,
  };

  interface Sent {
    method: string;
    path: string;
    params: URLSearchParams;
    headers: Headers;
    body: unknown;
  }

  async function realSetup() {
    const { createClient } = await import("@supabase/supabase-js");
    const sent: Sent[] = [];
    const stub = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      sent.push({ method, path: url.pathname, params: url.searchParams, headers: new Headers(init?.headers), body: init?.body ? JSON.parse(String(init.body)) : null });
      let payload: unknown = [row];
      if (url.pathname.endsWith("/rpc/increment_ai_usage")) payload = [{ allowed: true, used: 1 }];
      else if (url.pathname.endsWith("/rpc/get_ai_usage")) payload = 3;
      else if (method === "POST" && new Headers(init?.headers).get("accept")?.includes("pgrst.object")) payload = row;
      else if (method === "DELETE") payload = [];
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = createClient("https://abc.supabase.co", ANON, { global: { fetch: stub }, auth: { persistSession: false, autoRefreshToken: false } });
    const store = createSupabaseStore(client, { now: () => new Date("2026-04-01T12:00:00.000Z") });
    return { sent, store };
  }

  it("accepts the real client built with a publishable key", async () => {
    await expect(realSetup()).resolves.toBeDefined();
  });

  it("refuses a real client built with a secret key", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const client = createClient("https://abc.supabase.co", "sb_secret_abcdefghijklmnop1234", { auth: { persistSession: false, autoRefreshToken: false } });
    expect(() => createSupabaseStore(client)).toThrow(/service-role/);
  });

  it("lists with user_id, live-only, newest-first ordering and paging parameters", async () => {
    const { sent, store } = await realSetup();
    const list = await store.listEntries(A);
    expect(list).toHaveLength(1);
    const r = sent[0];
    expect(r?.method).toBe("GET");
    expect(r?.path).toBe("/rest/v1/cpd_entries");
    expect(r?.params.get("user_id")).toBe(`eq.${A}`);
    expect(r?.params.get("deleted_at")).toBe("is.null");
    expect(r?.params.get("order")).toBe("date_completed.desc,created_at.desc,id.asc");
    expect(r?.params.get("limit")).toBe("1000");
    expect(r?.params.get("offset")).toBe("0");
  });

  it("includeDeleted drops only the deleted_at filter", async () => {
    const { sent, store } = await realSetup();
    await store.listEntries(A, { includeDeleted: true });
    expect(sent[0]?.params.get("user_id")).toBe(`eq.${A}`);
    expect(sent[0]?.params.has("deleted_at")).toBe(false);
  });

  it("getEntry filters by id and user_id", async () => {
    const { sent, store } = await realSetup();
    expect((await store.getEntry(A, ROW_ID))?.title).toBe("Stub row");
    expect(sent[0]?.params.get("id")).toBe(`eq.${ROW_ID}`);
    expect(sent[0]?.params.get("user_id")).toBe(`eq.${A}`);
  });

  it("soft delete is a PATCH that sets deleted_at, for a live row of this user only", async () => {
    const { sent, store } = await realSetup();
    await store.softDeleteEntry(A, ROW_ID);
    const r = sent[0];
    expect(r?.method).toBe("PATCH");
    expect(r?.params.get("id")).toBe(`eq.${ROW_ID}`);
    expect(r?.params.get("user_id")).toBe(`eq.${A}`);
    expect(r?.params.get("deleted_at")).toBe("is.null");
    expect(r?.body).toEqual({ deleted_at: "2026-04-01T12:00:00.000Z" });
    expect(r?.headers.get("prefer")).toContain("return=representation");
    expect(sent.some((s) => s.method === "DELETE")).toBe(false);
  });

  it("restore is a PATCH that clears deleted_at, for a deleted row of this user only", async () => {
    const { sent, store } = await realSetup();
    await store.restoreEntry(A, ROW_ID);
    const r = sent[0];
    expect(r?.method).toBe("PATCH");
    expect(r?.params.get("user_id")).toBe(`eq.${A}`);
    expect(r?.params.get("deleted_at")).toBe("not.is.null");
    expect(r?.body).toEqual({ deleted_at: null });
  });

  it("update sends only the changed columns, for a live row of this user", async () => {
    const { sent, store } = await realSetup();
    await store.updateEntry(A, ROW_ID, { title: "Renamed", sourceType: "video" });
    const r = sent[0];
    expect(r?.method).toBe("PATCH");
    expect(r?.body).toEqual({ title: "Renamed", source_type: "video" });
    expect(r?.params.get("user_id")).toBe(`eq.${A}`);
    expect(r?.params.get("deleted_at")).toBe("is.null");
  });

  it("inserts rows with user_id set, one request for several rows", async () => {
    const { sent, store } = await realSetup();
    await store.createEntry(A, makeInput());
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.path).toBe("/rest/v1/cpd_entries");
    expect(sent[0]?.body).toMatchObject({ user_id: A, title: "Test entry", deleted_at: null });
    sent.length = 0;
    await store.createEntries(A, [makeInput(), makeInput()]).catch(() => undefined);
    expect(sent).toHaveLength(1);
    expect(Array.isArray(sent[0]?.body)).toBe(true);
    for (const r of sent[0]?.body as { user_id: string }[]) expect(r.user_id).toBe(A);
  });

  it("saves settings as an upsert on user_id", async () => {
    const { sent, store } = await realSetup();
    await store.saveSettings(A, DEFAULT_SETTINGS);
    expect(sent[0]?.method).toBe("POST");
    expect(sent[0]?.path).toBe("/rest/v1/user_settings");
    expect(sent[0]?.params.get("on_conflict")).toBe("user_id");
    expect(sent[0]?.headers.get("prefer")).toContain("resolution=merge-duplicates");
    expect(sent[0]?.body).toMatchObject({ user_id: A, active_profiles: ["ice"], custom_fields: [] });
  });

  it("calls the database functions with only the month and cap", async () => {
    const { sent, store } = await realSetup();
    expect(await store.incrementAiUsage(A, "2026-04", 5)).toEqual({ allowed: true, used: 1, cap: 5 });
    expect(await store.getAiUsage(A, "2026-04", 5)).toEqual({ allowed: true, used: 3, cap: 5 });
    expect(sent.map((s) => [s.method, s.path, s.body])).toEqual([
      ["POST", "/rest/v1/rpc/increment_ai_usage", { p_month: "2026-04", p_cap: 5 }],
      ["POST", "/rest/v1/rpc/get_ai_usage", { p_month: "2026-04" }],
    ]);
  });

  it("deleteAllUserData deletes by user_id on entries and settings and never calls ai_usage", async () => {
    const { sent, store } = await realSetup();
    await store.deleteAllUserData(A);
    expect(sent.map((s) => [s.method, s.path, s.params.get("user_id")])).toEqual([
      ["DELETE", "/rest/v1/cpd_entries", `eq.${A}`],
      ["DELETE", "/rest/v1/user_settings", `eq.${A}`],
    ]);
  });

  it("sends only the anon key as credentials on every request, never a service-role key", async () => {
    const { sent, store } = await realSetup();
    await store.listEntries(A);
    await store.getEntry(A, ROW_ID);
    await store.softDeleteEntry(A, ROW_ID);
    await store.incrementAiUsage(A, "2026-04", 5);
    await store.deleteAllUserData(A);
    expect(sent.length).toBeGreaterThan(4);
    for (const r of sent) {
      expect(r.headers.get("apikey")).toBe(ANON);
      expect(r.headers.get("authorization")).toBe(`Bearer ${ANON}`);
      expect(r.path.startsWith("/rest/v1/")).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Listing and answers, against the REAL client with a stub server that behaves the way PostgREST does.

describe("listing when the server returns fewer rows than were asked for", () => {
  const ANON = "sb_publishable_abcdefghijklmnop1234";

  function makeRow(i: number): Record<string, unknown> {
    return {
      id: crypto.randomUUID(),
      user_id: A,
      profile: "ice",
      title: `Row ${i}`,
      source_type: "article",
      date_completed: "2026-03-04",
      hours: 1,
      hours_confirmed: true,
      created_at: new Date(Date.UTC(2026, 2, 4, 10, 0, 0, i)).toISOString(),
      updated_at: "2026-03-04T10:00:00.000Z",
      deleted_at: null,
    };
  }

  /** A server that holds `total` rows but never returns more than `maxRows` at once (Supabase's "Max rows" setting). */
  async function cappedServer(maxRows: number, total: number) {
    const { createClient } = await import("@supabase/supabase-js");
    const all = Array.from({ length: total }, (_, i) => makeRow(i));
    const requests: { offset: number; limit: number; wantedCount: boolean }[] = [];
    const stub = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset") ?? 0);
      const limit = Number(url.searchParams.get("limit") ?? total);
      const wantedCount = /count=exact/.test(new Headers(init?.headers).get("prefer") ?? "");
      requests.push({ offset, limit, wantedCount });
      const slice = all.slice(offset, offset + Math.min(limit, maxRows));
      const range = slice.length === 0 ? "*" : `${offset}-${offset + slice.length - 1}`;
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (wantedCount) headers["content-range"] = `${range}/${total}`;
      return new Response(JSON.stringify(slice), { status: offset + slice.length < total ? 206 : 200, headers });
    }) as unknown as typeof fetch;
    const client = createClient("https://abc.supabase.co", ANON, { global: { fetch: stub }, auth: { persistSession: false, autoRefreshToken: false } });
    return { store: createSupabaseStore(client), requests };
  }

  it("still returns every entry when the server's own limit is below the page size", async () => {
    const { store, requests } = await cappedServer(500, 1200);
    const list = await store.listEntries(A);
    expect(list).toHaveLength(1200);
    expect(new Set(list.map((e) => e.id)).size).toBe(1200);
    expect(requests.map((r) => r.offset)).toEqual([0, 500, 1000]);
  });

  it("reads the whole list when the server's limit is far below the page size", async () => {
    const { store } = await cappedServer(37, 1000);
    expect(await store.listEntries(A)).toHaveLength(1000);
  });

  it("makes one request, and asks for a count, when everything fits", async () => {
    const { store, requests } = await cappedServer(1000, 40);
    expect(await store.listEntries(A)).toHaveLength(40);
    expect(requests).toEqual([{ offset: 0, limit: 1000, wantedCount: true }]);
  });

  it("makes one request for an empty log", async () => {
    const { store, requests } = await cappedServer(1000, 0);
    expect(await store.listEntries(A)).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it("reads exactly full pages and stops, without a needless extra request", async () => {
    const { store, requests } = await cappedServer(1000, 2000);
    expect(await store.listEntries(A)).toHaveLength(2000);
    expect(requests.map((r) => r.offset)).toEqual([0, 1000]);
  });

  it("fails rather than return a list it knows is incomplete", async () => {
    // One row at a time out of 5000: after the most pages it will read, most of the log is still unread.
    const { store, requests } = await cappedServer(1, 5000);
    const err = await caught<StoreError>(store.listEntries(A));
    expect(err).toBeInstanceOf(StoreError);
    expect(err.code).toBe("failed");
    expect(err.message).toMatch(/more entries than CPD Logger can load/);
    expect(requests.length).toBe(100);
  });
});

describe("an answer that is not a list or a row", () => {
  const ROW_ID = "99999999-9999-4999-8999-999999999999";

  async function storeAnswering(body: string, status = 200) {
    const { createClient } = await import("@supabase/supabase-js");
    const stub = (async () => new Response(body, { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    const client = createClient("https://abc.supabase.co", "sb_publishable_abcdefghijklmnop1234", { global: { fetch: stub }, auth: { persistSession: false, autoRefreshToken: false } });
    return createSupabaseStore(client);
  }

  it.each([
    ["an empty body", ""],
    ["null", "null"],
    ["an object where a list was expected", '{"rows":[]}'],
    ["a number", "7"],
    ["a string", '"ok"'],
  ])("is an error, never an empty log, settings or entry: %s", async (_name, body) => {
    const store = await storeAnswering(body);
    for (const call of [() => store.listEntries(A), () => store.listEntries(A, { includeDeleted: true }), () => store.getSettings(A), () => store.getEntry(A, ROW_ID)]) {
      const err = await caught<StoreError>(call());
      expect(err).toBeInstanceOf(StoreError);
      expect(err.code).toBe("failed");
      expect(err.message).toMatch(/answer CPD Logger could not read/);
    }
  });

  it("does not let a following save overwrite real settings with the defaults after an empty answer", async () => {
    const store = await storeAnswering("");
    await expect(store.getSettings(A)).rejects.toBeInstanceOf(StoreError);
  });

  it("still treats a real empty list as an empty log, no settings yet, and no such entry", async () => {
    const store = await storeAnswering("[]");
    expect(await store.listEntries(A)).toEqual([]);
    expect(await store.getSettings(A)).toEqual(DEFAULT_SETTINGS);
    expect(await store.getEntry(A, ROW_ID)).toBeNull();
  });
});

describe("saving several entries", () => {
  async function storeReturning(respond: (rows: Record<string, unknown>[]) => unknown) {
    const { createClient } = await import("@supabase/supabase-js");
    const stub = (async (_input: string | URL | Request, init?: RequestInit) => {
      const rows = JSON.parse(String(init?.body ?? "[]")) as Record<string, unknown>[];
      return new Response(JSON.stringify(respond(rows)), { status: 201, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const client = createClient("https://abc.supabase.co", "sb_publishable_abcdefghijklmnop1234", { global: { fetch: stub }, auth: { persistSession: false, autoRefreshToken: false } });
    return createSupabaseStore(client);
  }

  const withIds = (rows: Record<string, unknown>[]) =>
    rows.map((r, i) => ({ ...r, id: crypto.randomUUID(), created_at: `2026-03-04T10:00:0${i}.000Z`, updated_at: "2026-03-04T10:00:00.000Z", deleted_at: null }));

  it("returns every saved row when the database sends back as many as were sent", async () => {
    const store = await storeReturning(withIds);
    const made = await store.createEntries(A, [makeInput({ title: "1" }), makeInput({ title: "2" }), makeInput({ title: "3" })]);
    expect(made.map((e) => e.title)).toEqual(["1", "2", "3"]);
  });

  it("fails when the database sends back fewer rows than were sent, rather than return a short list as if all were saved", async () => {
    const store = await storeReturning((rows) => withIds(rows).slice(0, 2));
    const err = await caught<StoreError>(store.createEntries(A, [makeInput(), makeInput(), makeInput()]));
    expect(err).toBeInstanceOf(StoreError);
    expect(err.code).toBe("failed");
  });

  it("fails when the database sends back more rows than were sent", async () => {
    const store = await storeReturning((rows) => [...withIds(rows), ...withIds(rows)]);
    await expect(store.createEntries(A, [makeInput(), makeInput()])).rejects.toBeInstanceOf(StoreError);
  });

  it("fails when the answer is not a list at all", async () => {
    const store = await storeReturning(() => null);
    await expect(store.createEntries(A, [makeInput()])).rejects.toBeInstanceOf(StoreError);
  });
});

describe("errors that are not about reaching the database", () => {
  let ctx: ReturnType<typeof setup>;
  beforeEach(() => {
    ctx = setup();
  });

  async function failWith(error: Record<string, unknown>, status?: number): Promise<StoreError> {
    ctx.world.failNext = { error, status };
    return caught<StoreError>(ctx.store.listEntries(A));
  }

  it("says a rate limit is the database being busy, and that it is worth trying again", async () => {
    for (const error of [{ message: "slow down" }, { code: "" }, { code: "XX000" }]) {
      const err = await failWith(error, 429);
      expect(err.code).toBe("unavailable");
      expect(err.message).toMatch(/busy/);
      expect(err.message).not.toMatch(/could not reach/);
    }
  });

  it("says a 404 with no database code is about the address or the setup, not about reaching the database", async () => {
    const err = await failWith({ message: "not found" }, 404);
    expect(err.code).toBe("failed");
    expect(err.message).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(err.message).toMatch(/0001_init\.sql/);
    expect(err.message).not.toMatch(/could not reach/);
  });

  it("still sends a 404 that carries a missing-table code to the setup message", async () => {
    const err = await failWith({ code: "42P01" }, 404);
    expect(err.message).toMatch(/tables or functions are missing/);
  });

  it("says another error that came with a reply, but no database code, is an error from the database", async () => {
    for (const status of [400, 405, 409, 422]) {
      const err = await failWith({ message: "bad" }, status);
      expect(err.code, `status ${status}`).toBe("failed");
      expect(err.message, `status ${status}`).toMatch(/database returned an error/);
    }
  });

  it("calls it unreachable only for no reply at all or a server-side failure", async () => {
    for (const status of [0, 500, 502, 503, 504, 540, 599]) {
      const err = await failWith({ message: "<html>bad gateway</html>", code: "" }, status);
      expect(err.code, `status ${status}`).toBe("unavailable");
      expect(err.message, `status ${status}`).toMatch(/could not reach the database/);
    }
  });

  it("says text the database cannot store is a problem with the text, not with the dates or hours", async () => {
    for (const code of ["22P05", "22P02", "22021"]) {
      const err = await failWith({ code }, 400);
      expect(err.code).toBe("invalid");
      expect(err.message).toMatch(/null or other unsupported character/);
      expect(err.message).not.toMatch(/hours below 0/);
      expect(err.dbCode).toBe(code);
    }
    // Other value errors keep the general wording.
    expect((await failWith({ code: "22003" }, 400)).message).toMatch(/hours below 0/);
  });

  /** A client whose every query, however it is built up, answers with `result`. */
  const proxyClient = (result: unknown): SupabaseClient => {
    const chain: unknown = new Proxy(() => undefined, {
      get: (_t, prop) => (prop === "then" ? (resolve: (v: unknown) => unknown) => resolve(result) : chain),
      apply: () => chain,
    });
    return { from: () => chain, rpc: () => chain } as unknown as SupabaseClient;
  };

  it("treats a sign-in code as a sign-in problem even when the reply carried no status", async () => {
    const store = createSupabaseStore(proxyClient({ data: null, error: { code: "42501", message: "denied" } }));
    const err = await caught<StoreError>(store.listEntries(A));
    expect(err.code).toBe("not_signed_in");
    expect(err.dbCode).toBe("42501");
    // With neither a status nor a code there is nothing to go on, so it is reported as unreachable.
    const store2 = createSupabaseStore(proxyClient({ data: null, error: { message: "boom" } }));
    expect((await caught<StoreError>(store2.listEntries(A))).code).toBe("unavailable");
  });

  it("rejects a client reply that is not an object", async () => {
    for (const reply of [undefined, null, "text", 7]) {
      const err = await caught<StoreError>(createSupabaseStore(proxyClient(reply)).getSettings(A));
      expect(err).toBeInstanceOf(StoreError);
      expect(err.message).toMatch(/answer CPD Logger could not read/);
    }
  });
});

describe("values the database cannot take", () => {
  it("removes a null character and a lone surrogate before anything is sent, so the insert cannot fail on them", async () => {
    const { world, store } = setup();
    const e = await store.createEntry(A, makeInput({ title: "a\u0000b\ud800c", notes: "n\u0000", benefits: { helped: "h\udc00", future: "", nextYear: "" } }));
    const insert = world.calls.find((c) => c.action === "insert");
    expect(insert?.payload).toMatchObject({ title: "abc", notes: "n", benefits: { helped: "h", future: "", nextYear: "" } });
    expect(e.title).toBe("abc");
  });

  it("refuses a link that is not a web address, with nothing sent", async () => {
    const { world, store } = setup();
    for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
      await expect(store.createEntry(A, makeInput({ url }))).rejects.toBeInstanceOf(StoreInputError);
      await expect(store.createEntries(A, [makeInput({ url })])).rejects.toBeInstanceOf(StoreInputError);
      await expect(store.updateEntry(A, "99999999-9999-4999-8999-999999999999", { url })).rejects.toBeInstanceOf(StoreInputError);
    }
    expect(world.calls).toHaveLength(0);
  });

  it("sends a cap that is too big for the database as the biggest one it takes, never as it was", async () => {
    const { world, store } = setup();
    const out = await store.incrementAiUsage(A, "2026-04", 99_999_999_999);
    expect(out).toEqual({ allowed: true, used: 1, cap: 2_147_483_647 });
    expect(world.calls.find((c) => c.rpc === "increment_ai_usage")?.args).toEqual({ p_month: "2026-04", p_cap: 2_147_483_647 });
    expect((await store.getAiUsage(A, "2026-04", 1e12)).cap).toBe(2_147_483_647);
  });
});
