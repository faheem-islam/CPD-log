import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AiCapError, meteredProvider, monthKeyUk, nextResetLabel, withAiMeter } from "@/lib/llm/metering";
import { expandNotes } from "@/lib/llm/expand";
import { TranscribeError, transcribeScreenshot } from "@/lib/llm/transcribe";
import type { LlmProvider, LlmRequest } from "@/lib/llm/types";
import { createLocalStore } from "@/lib/store/local";
import { StoreError } from "@/lib/store/mapping";
import type { AiUsageResult } from "@/lib/store/types";

/** Await a promise that is expected to reject and return what it rejected with. */
async function caught<E extends Error>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (e) {
    return e as E;
  }
  throw new Error("Expected the promise to reject");
}

const USER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MARCH = new Date("2026-03-10T12:00:00.000Z");

function fakeStore(results: AiUsageResult[] | ((month: string, cap: number) => AiUsageResult)) {
  const log: string[] = [];
  const calls: { userId: string; month: string; cap: number }[] = [];
  let i = 0;
  const store = {
    incrementAiUsage: vi.fn(async (userId: string, month: string, cap: number) => {
      log.push("increment");
      calls.push({ userId, month, cap });
      if (typeof results === "function") return results(month, cap);
      const r = results[Math.min(i, results.length - 1)];
      i += 1;
      if (!r) throw new Error("no result configured");
      return r;
    }),
  };
  return { store, log, calls };
}

describe("withAiMeter", () => {
  it("counts the call BEFORE running the model call", async () => {
    const { store, log } = fakeStore([{ allowed: true, used: 1, cap: 5 }]);
    await withAiMeter({ store, userId: USER, cap: 5, now: MARCH }, async () => {
      log.push("model");
      return "done";
    });
    expect(log).toEqual(["increment", "model"]);
  });

  it("returns what the function returns and hands it the usage", async () => {
    const { store } = fakeStore([{ allowed: true, used: 3, cap: 5 }]);
    const seen: AiUsageResult[] = [];
    const out = await withAiMeter({ store, userId: USER, cap: 5, now: MARCH }, async (usage) => {
      seen.push(usage);
      return { answer: 42 };
    });
    expect(out).toEqual({ answer: 42 });
    expect(seen).toEqual([{ allowed: true, used: 3, cap: 5 }]);
  });

  it("sends the user, the UK month and the cap to the store", async () => {
    const { store, calls } = fakeStore([{ allowed: true, used: 1, cap: 7 }]);
    await withAiMeter({ store, userId: USER, cap: 7, now: MARCH }, async () => "ok");
    expect(calls).toEqual([{ userId: USER, month: "2026-03", cap: 7 }]);
  });

  it("accepts the time as a function", async () => {
    const { store, calls } = fakeStore([{ allowed: true, used: 1, cap: 7 }]);
    await withAiMeter({ store, userId: USER, cap: 7, now: () => new Date("2026-08-02T09:00:00Z") }, async () => "ok");
    expect(calls[0]?.month).toBe("2026-08");
  });

  it("uses the current time when none is given", async () => {
    const { store, calls } = fakeStore([{ allowed: true, used: 1, cap: 7 }]);
    await withAiMeter({ store, userId: USER, cap: 7 }, async () => "ok");
    expect(calls[0]?.month).toMatch(/^\d{4}-(0[1-9]|1[0-2])$/);
  });

  it("at the cap throws AiCapError with the agreed wording and does NOT run the model call", async () => {
    const { store } = fakeStore([{ allowed: false, used: 3, cap: 3 }]);
    const fn = vi.fn(async () => "never");
    const err = await caught<AiCapError>(withAiMeter({ store, userId: USER, cap: 3, now: MARCH }, fn));
    expect(err).toBeInstanceOf(AiCapError);
    expect(err.message).toBe("You've used this month's AI allowance (3 calls). It resets on 1 April. You can still type your learning points yourself.");
    expect(err).toMatchObject({ name: "AiCapError", cap: 3, used: 3, resetsOn: "1 April" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("names the right month to reset on, including across the year end", async () => {
    const cases: [string, string][] = [
      ["2026-01-15T12:00:00Z", "1 February"],
      ["2026-06-15T12:00:00Z", "1 July"],
      ["2026-11-15T12:00:00Z", "1 December"],
      ["2026-12-15T12:00:00Z", "1 January"],
    ];
    for (const [when, label] of cases) {
      const { store } = fakeStore([{ allowed: false, used: 2, cap: 2 }]);
      const err = await caught<AiCapError>(withAiMeter({ store, userId: USER, cap: 2, now: new Date(when) }, async () => 1));
      expect(err.message).toContain(`It resets on ${label}.`);
    }
  });

  it("uses the UK calendar month, not UTC", async () => {
    // 23:30 UTC on 31 March 2026 is 00:30 on 1 April in the UK (British Summer Time).
    const bst = fakeStore([{ allowed: true, used: 1, cap: 3 }]);
    await withAiMeter({ store: bst.store, userId: USER, cap: 3, now: new Date("2026-03-31T23:30:00Z") }, async () => 1);
    expect(bst.calls[0]?.month).toBe("2026-04");
    // 23:30 UTC on 31 October 2026 is still 31 October in the UK (clocks went back on 25 October).
    const gmt = fakeStore([{ allowed: true, used: 1, cap: 3 }]);
    await withAiMeter({ store: gmt.store, userId: USER, cap: 3, now: new Date("2026-10-31T23:30:00Z") }, async () => 1);
    expect(gmt.calls[0]?.month).toBe("2026-10");
    // 23:30 UTC on 30 June is 00:30 on 1 July in the UK.
    const june = fakeStore([{ allowed: true, used: 1, cap: 3 }]);
    await withAiMeter({ store: june.store, userId: USER, cap: 3, now: new Date("2026-06-30T23:30:00Z") }, async () => 1);
    expect(june.calls[0]?.month).toBe("2026-07");
    // 23:30 UTC on 31 December is still December in the UK.
    expect(monthKeyUk(new Date("2026-12-31T23:30:00Z"))).toBe("2026-12");
    expect(monthKeyUk(new Date("2027-01-01T00:00:00Z"))).toBe("2027-01");
  });

  it("a cap of zero, below zero or not a number means AI is switched off: a clear message, and the store is not asked", async () => {
    for (const cap of [0, -4, Number.NaN, Number.NEGATIVE_INFINITY]) {
      const { store } = fakeStore([{ allowed: true, used: 1, cap: 1 }]);
      const fn = vi.fn(async () => "never");
      const err = await caught<AiCapError>(withAiMeter({ store, userId: USER, cap, now: MARCH }, fn));
      expect(err).toBeInstanceOf(AiCapError);
      expect(err.message).toMatch(/switched off on this server/);
      expect(err.message).toMatch(/type your learning points yourself/);
      expect(err.cap).toBe(0);
      expect(store.incrementAiUsage).not.toHaveBeenCalled();
      expect(fn).not.toHaveBeenCalled();
    }
  });

  it("if the store fails, passes the error on and does NOT run the model call", async () => {
    const failure = new StoreError("unavailable", "CPD Logger could not reach the database.");
    const store = { incrementAiUsage: vi.fn(async () => Promise.reject(failure)) };
    const fn = vi.fn(async () => "never");
    await expect(withAiMeter({ store, userId: USER, cap: 5, now: MARCH }, fn)).rejects.toBe(failure);
    expect(fn).not.toHaveBeenCalled();
  });

  it("does NOT refund when the model call fails: the call stays counted and the error is the model's", async () => {
    const { store } = fakeStore([{ allowed: true, used: 1, cap: 5 }]);
    const failure = new Error("model blew up");
    await expect(withAiMeter({ store, userId: USER, cap: 5, now: MARCH }, async () => Promise.reject(failure))).rejects.toBe(failure);
    expect(store.incrementAiUsage).toHaveBeenCalledTimes(1);
    expect(Object.keys(store)).toEqual(["incrementAiUsage"]);
  });

  it("counts once per call, not once per retry of the caller", async () => {
    const { store } = fakeStore((_m, cap) => ({ allowed: true, used: 1, cap }));
    await withAiMeter({ store, userId: USER, cap: 5, now: MARCH }, async () => 1);
    await withAiMeter({ store, userId: USER, cap: 5, now: MARCH }, async () => 2);
    expect(store.incrementAiUsage).toHaveBeenCalledTimes(2);
  });
});

describe("nextResetLabel", () => {
  it("gives the first of the next UK month", () => {
    expect(nextResetLabel(new Date("2026-01-01T00:00:00Z"))).toBe("1 February");
    expect(nextResetLabel(new Date("2026-02-28T12:00:00Z"))).toBe("1 March");
    expect(nextResetLabel(new Date("2026-12-31T12:00:00Z"))).toBe("1 January");
    expect(nextResetLabel(new Date("2026-03-31T23:30:00Z"))).toBe("1 May");
  });
});

describe("withAiMeter with the local store", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cpd-meter-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("lets exactly the cap through when many calls arrive at once", async () => {
    const store = createLocalStore(path.join(dir, "db.json"));
    let ran = 0;
    const results = await Promise.allSettled(
      Array.from({ length: 30 }, () =>
        withAiMeter({ store, userId: USER, cap: 8, now: MARCH }, async () => {
          ran += 1;
          return "ok";
        }),
      ),
    );
    expect(ran).toBe(8);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(8);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(rejected).toHaveLength(22);
    for (const r of rejected) expect(r.reason).toBeInstanceOf(AiCapError);
    expect((await store.getAiUsage(USER, "2026-03", 8)).used).toBe(8);
  });

  it("starts again in the next month", async () => {
    const store = createLocalStore(path.join(dir, "db.json"));
    await withAiMeter({ store, userId: USER, cap: 1, now: MARCH }, async () => 1);
    await expect(withAiMeter({ store, userId: USER, cap: 1, now: MARCH }, async () => 1)).rejects.toBeInstanceOf(AiCapError);
    await expect(withAiMeter({ store, userId: USER, cap: 1, now: new Date("2026-04-02T09:00:00Z") }, async () => 1)).resolves.toBe(1);
  });

  it("keeps different users' allowances apart", async () => {
    const store = createLocalStore(path.join(dir, "db.json"));
    const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    await withAiMeter({ store, userId: USER, cap: 1, now: MARCH }, async () => 1);
    await expect(withAiMeter({ store, userId: other, cap: 1, now: MARCH }, async () => 1)).resolves.toBe(1);
  });
});

describe("the allowance message", () => {
  it("says call for an allowance of one and calls for any other", async () => {
    for (const [cap, words] of [[1, "1 call"], [2, "2 calls"], [100, "100 calls"]] as const) {
      const { store } = fakeStore([{ allowed: false, used: cap, cap }]);
      const err = await caught<AiCapError>(withAiMeter({ store, userId: USER, cap, now: MARCH }, async () => 1));
      expect(err.message).toContain(`(${words})`);
      expect(err.message).not.toContain("(1 calls)");
    }
  });
});

describe("meteredProvider", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "cpd-meter-prov-"));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 7)]).toString("base64");
  const NOTES = {
    profile: "ice" as const,
    title: "A title",
    provider: "A provider",
    sourceType: "article" as const,
    theme: "Water",
    notes: "I learned how drainage inspections are scheduled.",
  };

  function model(reply = '{"learningPoints":"I learned how drainage inspections are scheduled.","benefits":{}}') {
    const calls: LlmRequest[] = [];
    const llm: LlmProvider = {
      name: "inner",
      complete: vi.fn(async (req: LlmRequest) => {
        calls.push(req);
        return { text: reply, inputTokens: 3, outputTokens: 4, stopReason: "end_turn" };
      }),
    };
    return { llm, calls };
  }

  it("counts one call before each model call, and passes the request and the answer through unchanged", async () => {
    const { store, log } = fakeStore([{ allowed: true, used: 1, cap: 5 }]);
    const inner = model("hello");
    const llm = meteredProvider(inner.llm, { store, userId: USER, cap: 5, now: MARCH });
    expect(llm.name).toBe("inner");
    const req: LlmRequest = { system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10 };
    const out = await llm.complete(req);
    expect(out).toEqual({ text: "hello", inputTokens: 3, outputTokens: 4, stopReason: "end_turn" });
    expect(inner.calls).toEqual([req]);
    expect(log).toEqual(["increment"]);
  });

  it("does not call the model once the allowance is used up", async () => {
    const { store } = fakeStore([{ allowed: false, used: 5, cap: 5 }]);
    const inner = model();
    const llm = meteredProvider(inner.llm, { store, userId: USER, cap: 5, now: MARCH });
    await expect(llm.complete({ system: "s", messages: [{ role: "user", content: "hi" }], maxTokens: 10 })).rejects.toBeInstanceOf(AiCapError);
    expect(inner.calls).toHaveLength(0);
  });

  it("does not use up the allowance on blank notes, because expandNotes makes no model call for them", async () => {
    const store = createLocalStore(path.join(dir, "db.json"));
    const inner = model();
    const llm = meteredProvider(inner.llm, { store, userId: USER, cap: 5, now: MARCH });
    for (const notes of ["", "   ", "\u200B\n\t"]) await expandNotes({ ...NOTES, notes }, llm);
    expect(inner.calls).toHaveLength(0);
    expect((await store.getAiUsage(USER, "2026-03", 5)).used).toBe(0);
    await expandNotes(NOTES, llm);
    expect(inner.calls).toHaveLength(1);
    expect((await store.getAiUsage(USER, "2026-03", 5)).used).toBe(1);
  });

  it("does not use up the allowance on a screenshot that fails its checks before any model call", async () => {
    const store = createLocalStore(path.join(dir, "db.json"));
    const inner = model("A\tB\n1\t2");
    const llm = meteredProvider(inner.llm, { store, userId: USER, cap: 5, now: MARCH });
    await expect(transcribeScreenshot(llm, { mediaType: "image/png", base64: "not base64!" })).rejects.toBeInstanceOf(TranscribeError);
    await expect(transcribeScreenshot(llm, { mediaType: "image/gif", base64: PNG })).rejects.toBeInstanceOf(TranscribeError);
    expect(inner.calls).toHaveLength(0);
    expect((await store.getAiUsage(USER, "2026-03", 5)).used).toBe(0);
    await transcribeScreenshot(llm, { mediaType: "image/png", base64: PNG });
    expect((await store.getAiUsage(USER, "2026-03", 5)).used).toBe(1);
  });

  it("still counts a call whose answer turns out to be unusable, as withAiMeter does", async () => {
    const store = createLocalStore(path.join(dir, "db.json"));
    const llm = meteredProvider(model("not json").llm, { store, userId: USER, cap: 5, now: MARCH });
    await expect(expandNotes(NOTES, llm)).rejects.toThrow();
    expect((await store.getAiUsage(USER, "2026-03", 5)).used).toBe(1);
  });
});
