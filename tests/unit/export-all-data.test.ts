import { describe, expect, it } from "vitest";
import { ALL_DATA_VERSION, allDataFilename, buildAllData } from "@/lib/export/all-data";
import type { Entry, UserSettings } from "@/lib/types";
import { makeEntry, makeSettings, NOW } from "./export-test-helpers";

const settings = makeSettings({
  name: "Test Person",
  customFields: [{ key: "cert", label: "Certificate", type: "text" }],
});

describe("buildAllData", () => {
  const live = makeEntry({
    title: "Test live entry",
    url: "https://example.test/x",
    provider: "Test provider",
    hours: 2,
    theme: "Energy",
    notes: "My own notes",
    aiAssisted: true,
    custom: { cert: "C-1" },
    confidence: { title: { level: "high", evidence: "From your file" } },
    benefits: { helped: "H", future: "F", nextYear: "N" },
  });
  const bin = makeEntry({ title: "Test binned entry", deletedAt: "2026-04-01T10:00:00.000Z", dateCompleted: "2026-01-01" });

  it("includes the settings, every entry with all its fields, and entries in the bin flagged as deleted", () => {
    const data = buildAllData({ settings, entries: [live, bin], now: NOW });
    expect(data.app).toBe("CPD Logger");
    expect(data.version).toBe(ALL_DATA_VERSION);
    expect(data.exportedAt).toBe("2026-10-07T12:00:00.000Z");
    expect(data.settings).toEqual({
      name: "Test Person",
      jobRole: "Test job role",
      responsibilities: "Test responsibilities",
      sector: "Test sector",
      activeProfiles: ["ice", "istructe", "custom"],
      customFields: [{ key: "cert", label: "Certificate", type: "text" }],
    });
    expect(data.counts).toEqual({ entries: 2, live: 1, deleted: 1 });
    expect(data.entries).toHaveLength(2);
    const l = data.entries.find((e) => e.id === live.id);
    const b = data.entries.find((e) => e.id === bin.id);
    expect(l?.deleted).toBe(false);
    expect(l?.deletedAt).toBeNull();
    expect(b?.deleted).toBe(true);
    expect(b?.deletedAt).toBe("2026-04-01T10:00:00.000Z");
    // every Entry field except the internal user id is present
    const expectedKeys = Object.keys(live).filter((k) => k !== "userId");
    for (const k of expectedKeys) expect(l).toHaveProperty(k);
    expect(l?.benefits).toEqual({ helped: "H", future: "F", nextYear: "N" });
    expect(l?.confidence).toEqual({ title: { level: "high", evidence: "From your file" } });
    expect(l?.custom).toEqual({ cert: "C-1" });
    expect(l?.notes).toBe("My own notes");
    expect(l?.aiAssisted).toBe(true);
  });

  it("is plain JSON: it survives a round trip unchanged", () => {
    const data = buildAllData({ settings, entries: [live, bin], now: NOW });
    expect(JSON.parse(JSON.stringify(data))).toEqual(data);
  });

  it("has no user id, no email and no keys", () => {
    const data = buildAllData({ settings, entries: [live, bin], now: NOW });
    const text = JSON.stringify(data);
    expect(text).not.toContain("user-1");
    expect(text).not.toMatch(/userId|email|apiKey|api_key|secret|token|password|service_role|ANTHROPIC|SUPABASE|YOUTUBE/i);
  });

  it("copies fields by name, so extra properties on the objects cannot leak", () => {
    const sneaky = { ...live, apiKey: "sk-test-should-not-appear", email: "someone@example.test" } as Entry;
    const sneakySettings = { ...settings, serviceRoleKey: "service-role-should-not-appear", email: "x@example.test" } as UserSettings;
    const text = JSON.stringify(buildAllData({ settings: sneakySettings, entries: [sneaky], now: NOW }));
    expect(text).not.toContain("should-not-appear");
    expect(text).not.toContain("someone@");
    expect(text).not.toContain("x@example");
  });

  it("sorts by date then id so the file does not depend on input order", () => {
    const a = makeEntry({ dateCompleted: "2026-02-02", id: "b" });
    const b = makeEntry({ dateCompleted: "2026-02-02", id: "a" });
    const c = makeEntry({ dateCompleted: "2025-12-31", id: "z" });
    expect(buildAllData({ settings, entries: [a, b, c], now: NOW }).entries.map((e) => e.id)).toEqual(["z", "a", "b"]);
    expect(buildAllData({ settings, entries: [c, b, a], now: NOW }).entries.map((e) => e.id)).toEqual(["z", "a", "b"]);
  });

  it("refuses entries from more than one user, and entries that are not the stated user's", () => {
    const mine = makeEntry({ userId: "user-1" });
    const theirs = makeEntry({ userId: "user-2", title: "Someone else" });
    expect(() => buildAllData({ settings, entries: [mine, theirs], now: NOW })).toThrow(/do not all belong to one user/);
    expect(() => buildAllData({ settings, entries: [mine], now: NOW, userId: "user-2" })).toThrow(/do not all belong to one user/);
    expect(() => buildAllData({ settings, entries: [mine], now: NOW, userId: "user-1" })).not.toThrow();
    // the error does not echo the other user's data
    try {
      buildAllData({ settings, entries: [mine, theirs], now: NOW });
    } catch (e) {
      expect(String(e)).not.toContain("Someone else");
      expect(String(e)).not.toContain("user-2");
    }
  });

  it("works for a user with nothing yet, without inventing anything", () => {
    const data = buildAllData({ settings: makeSettings({ name: "", jobRole: "", responsibilities: "", sector: "", customFields: [] }), entries: [], now: NOW });
    expect(data.entries).toEqual([]);
    expect(data.counts).toEqual({ entries: 0, live: 0, deleted: 0 });
    expect(data.settings.name).toBe("");
  });

  it("does not share objects with the input", () => {
    const data = buildAllData({ settings, entries: [live], now: NOW });
    const entry = data.entries[0];
    if (!entry) throw new Error("no entry");
    entry.custom.cert = "changed";
    entry.benefits.helped = "changed";
    expect(live.custom.cert).toBe("C-1");
    expect(live.benefits.helped).toBe("H");
  });

  it("copes with a stored entry that is missing its nested objects", () => {
    const thin = { ...makeEntry({}), benefits: undefined, custom: undefined, confidence: undefined } as unknown as Entry;
    const data = buildAllData({ settings, entries: [thin], now: NOW });
    expect(data.entries[0]?.benefits).toEqual({ helped: "", future: "", nextYear: "" });
    expect(data.entries[0]?.custom).toEqual({});
    expect(data.entries[0]?.confidence).toEqual({});
  });

  it("names the download file with the UK date", () => {
    expect(allDataFilename(NOW)).toBe("cpd-logger-data-2026-10-07.json");
  });
});
