import { describe, expect, it } from "vitest";
import {
  StoreInputError,
  assertDateOrder,
  assertMonth,
  compareEntriesNewestFirst,
  entryInputToRow,
  entryPatchToRow,
  normaliseCap,
  parseStoredEntry,
  parseStoredSettings,
  rowToEntry,
  rowToSettings,
  rowsToEntries,
  settingsToRow,
  validateEntryInput,
  validateEntryPatch,
  validateSettings,
} from "@/lib/store/mapping";
import { DEFAULT_SETTINGS, type Entry, type EntryInput, type UserSettings } from "@/lib/types";

const USER = "11111111-1111-4111-8111-111111111111";
const ID = "22222222-2222-4222-8222-222222222222";

function makeInput(over: Partial<EntryInput> = {}): EntryInput {
  return {
    profile: "ice",
    title: "Test entry one",
    url: "https://example.test/resource",
    provider: "Test provider",
    sourceType: "article",
    publishedAt: "2026-01-10",
    dateCompleted: "2026-03-04",
    dateEnd: null,
    detectedDurationMinutes: 90,
    hours: 1.5,
    hoursConfirmed: true,
    theme: "Delivery excellence",
    category: null,
    structuralSafety: null,
    sustainability: null,
    devPlanRef: "unplanned",
    learningPoints: "Test learning points.",
    benefits: { helped: "a", future: "b", nextYear: "c" },
    developmentGained: "",
    custom: { site: "Test site" },
    notes: "Test notes",
    aiAssisted: false,
    confidence: { title: { level: "high", evidence: "Test evidence" } },
    ...over,
  };
}

function fullEntry(over: Partial<Entry> = {}): Entry {
  return { ...makeInput(), id: ID, userId: USER, createdAt: "2026-03-04T10:00:00.000Z", updatedAt: "2026-03-04T10:00:00.000Z", deletedAt: null, ...over };
}

function expectInputError(fn: () => unknown, mention?: RegExp): StoreInputError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(StoreInputError);
    if (mention) expect((e as Error).message).toMatch(mention);
    return e as StoreInputError;
  }
  throw new Error("Expected the call to throw a StoreInputError");
}

describe("validateEntryInput", () => {
  it("accepts a complete valid entry unchanged", () => {
    expect(validateEntryInput(makeInput())).toEqual(makeInput());
  });

  it("rounds hours to two decimal places", () => {
    expect(validateEntryInput(makeInput({ hours: 1.234 })).hours).toBe(1.23);
    expect(validateEntryInput(makeInput({ hours: 0.125 })).hours).toBe(0.13);
    expect(validateEntryInput(makeInput({ hours: 0 })).hours).toBe(0);
  });

  it("does not turn negative zero into a different number", () => {
    expect(Object.is(validateEntryInput(makeInput({ hours: -0 })).hours, 0)).toBe(true);
  });

  it("drops keys the caller must not set (id, userId, timestamps, deletedAt, anything unknown)", () => {
    const sneaky = { ...makeInput(), id: "x", userId: "y", createdAt: "z", updatedAt: "z", deletedAt: "2026-01-01T00:00:00Z", isAdmin: true };
    const out = validateEntryInput(sneaky) as unknown as Record<string, unknown>;
    for (const k of ["id", "userId", "createdAt", "updatedAt", "deletedAt", "isAdmin"]) expect(out).not.toHaveProperty(k);
  });

  it.each([
    ["negative hours", { hours: -1 }, /Hours/],
    ["NaN hours", { hours: Number.NaN }, /Hours/],
    ["infinite hours", { hours: Number.POSITIVE_INFINITY }, /Hours/],
    ["hours above the column limit", { hours: 10000 }, /Hours/],
    ["hours as text", { hours: "2" as unknown as number }, /Hours/],
    ["a date that does not exist", { dateCompleted: "2026-02-30" }, /Date completed/],
    ["a UK style date", { dateCompleted: "04/03/2026" }, /Date completed/],
    ["an empty date", { dateCompleted: "" }, /Date completed/],
    ["a timestamp instead of a date", { dateCompleted: "2026-03-04T10:00:00Z" }, /Date completed/],
    ["a bad published date", { publishedAt: "yesterday" }, /Published date/],
    ["an unknown profile", { profile: "rics" as never }, /Profile/],
    ["an unknown source type", { sourceType: "podcast" as never }, /Source type/],
    ["a title that is not text", { title: 5 as unknown as string }, /Title/],
    ["a title over the length limit", { title: "x".repeat(1001) }, /Title/],
    ["notes over the length limit", { notes: "x".repeat(20001) }, /Notes/],
    ["custom values that are not text", { custom: { a: 1 as unknown as string } }, /Custom fields/],
    ["an empty custom field name", { custom: { "": "x" } }, /Custom fields/],
    ["benefits missing a key", { benefits: { helped: "a", future: "b" } as never }, /Benefits/],
    ["a confidence level that does not exist", { confidence: { title: { level: "certain", evidence: "" } } as never }, /Confidence/],
    ["hoursConfirmed as text", { hoursConfirmed: "yes" as unknown as boolean }, /Hours confirmed/],
    ["negative detected minutes", { detectedDurationMinutes: -5 }, /Detected length/],
  ])("rejects %s", (_name, over, mention) => {
    expectInputError(() => validateEntryInput(makeInput(over as Partial<EntryInput>)), mention);
  });

  it("drops a __proto__ key from custom and confidence instead of keeping it", () => {
    const custom = JSON.parse('{"__proto__":"x","a":"b"}') as Record<string, string>;
    const confidence = JSON.parse('{"__proto__":{"level":"high","evidence":""}}') as EntryInput["confidence"];
    const out = validateEntryInput(makeInput({ custom, confidence }));
    expect(Object.keys(out.custom)).toEqual(["a"]);
    expect(Object.keys(out.confidence)).toEqual([]);
    expect(Object.getPrototypeOf(out.custom)).toBe(Object.prototype);
  });

  it("rejects an end date before the date completed", () => {
    expectInputError(() => validateEntryInput(makeInput({ dateCompleted: "2026-03-04", dateEnd: "2026-03-03" })), /End date/);
  });

  it("accepts an end date on the same day or later", () => {
    expect(() => validateEntryInput(makeInput({ dateEnd: "2026-03-04" }))).not.toThrow();
    expect(() => validateEntryInput(makeInput({ dateEnd: "2026-03-06" }))).not.toThrow();
  });

  it("rejects things that are not objects", () => {
    for (const bad of [null, undefined, "a string", 5, []]) expectInputError(() => validateEntryInput(bad));
  });

  it("never puts the rejected value in the error message", () => {
    const secret = "sk-ant-api03-SECRETVALUE1234567890";
    const e = expectInputError(() => validateEntryInput(makeInput({ hours: secret as unknown as number })));
    expect(e.message).not.toContain(secret);
    const e2 = expectInputError(() => validateEntryInput(makeInput({ dateCompleted: secret })));
    expect(e2.message).not.toContain(secret);
  });
});

describe("validateEntryPatch", () => {
  it("returns only the fields that were sent", () => {
    expect(validateEntryPatch({ title: "New", hours: 2.005 })).toEqual({ title: "New", hours: 2.01 });
  });

  it("ignores undefined values", () => {
    expect(validateEntryPatch({ title: undefined, notes: "n" })).toEqual({ notes: "n" });
  });

  it("returns an empty object for an empty patch", () => {
    expect(validateEntryPatch({})).toEqual({});
  });

  it("drops id, userId, createdAt, updatedAt and deletedAt", () => {
    const out = validateEntryPatch({ title: "T", id: "x", userId: "y", createdAt: "z", updatedAt: "z", deletedAt: null });
    expect(out).toEqual({ title: "T" });
  });

  it("can set nullable fields to null", () => {
    expect(validateEntryPatch({ theme: null, dateEnd: null })).toEqual({ theme: null, dateEnd: null });
  });

  it("rejects bad values", () => {
    expectInputError(() => validateEntryPatch({ hours: -2 }), /Hours/);
    expectInputError(() => validateEntryPatch({ sourceType: "nope" }), /Source type/);
    expectInputError(() => validateEntryPatch("not an object"));
  });

  it("checks the date order when both dates are in the patch", () => {
    expectInputError(() => validateEntryPatch({ dateCompleted: "2026-05-02", dateEnd: "2026-05-01" }), /End date/);
  });
});

describe("assertDateOrder", () => {
  it("allows null, equal and later end dates and refuses an earlier one", () => {
    expect(() => assertDateOrder("2026-01-02", null)).not.toThrow();
    expect(() => assertDateOrder("2026-01-02", "2026-01-02")).not.toThrow();
    expect(() => assertDateOrder("2026-01-02", "2026-01-03")).not.toThrow();
    expect(() => assertDateOrder("2026-01-02", "2026-01-01")).toThrow(StoreInputError);
  });
});

describe("settings", () => {
  const good: UserSettings = {
    name: "Test Person",
    jobRole: "Engineer",
    responsibilities: "Things",
    sector: "Highways",
    activeProfiles: ["ice", "custom"],
    customFields: [{ key: "site", label: "Site", type: "text" }],
  };

  it("validates good settings", () => {
    expect(validateSettings(good)).toEqual(good);
  });

  it("removes duplicate profiles", () => {
    expect(validateSettings({ ...good, activeProfiles: ["ice", "ice", "custom"] }).activeProfiles).toEqual(["ice", "custom"]);
  });

  it("needs at least one profile", () => {
    expectInputError(() => validateSettings({ ...good, activeProfiles: [] }), /Active profiles/);
  });

  it("refuses unknown profiles", () => {
    expectInputError(() => validateSettings({ ...good, activeProfiles: ["rics"] }), /Active profiles/);
  });

  it("refuses more custom fields than the profile config allows", () => {
    const many = Array.from({ length: 11 }, (_, i) => ({ key: `k${i}`, label: `L${i}`, type: "text" as const }));
    expectInputError(() => validateSettings({ ...good, customFields: many }), /Custom fields/);
  });

  it("refuses two custom fields with the same key", () => {
    expectInputError(() => validateSettings({ ...good, customFields: [good.customFields[0], good.customFields[0]] }), /same key/);
  });

  it("refuses a bad custom field type and a blank label", () => {
    expectInputError(() => validateSettings({ ...good, customFields: [{ key: "a", label: "A", type: "money" }] }));
    expectInputError(() => validateSettings({ ...good, customFields: [{ key: "a", label: "   ", type: "text" }] }));
  });

  it("strips unknown keys from custom field definitions", () => {
    const out = validateSettings({ ...good, customFields: [{ key: "a", label: "A", type: "text", extra: "x" }] });
    expect(out.customFields[0]).toEqual({ key: "a", label: "A", type: "text" });
  });

  it("parseStoredSettings never throws and falls back to defaults", () => {
    for (const bad of [null, undefined, "x", 5, [], { activeProfiles: "ice" }, { customFields: "x" }]) {
      const s = parseStoredSettings(bad);
      expect(s.activeProfiles.length).toBeGreaterThan(0);
      expect(Array.isArray(s.customFields)).toBe(true);
    }
    expect(parseStoredSettings(null)).toEqual(DEFAULT_SETTINGS);
  });

  it("parseStoredSettings keeps good fields and drops bad ones", () => {
    const s = parseStoredSettings({
      name: "Keep",
      jobRole: 5,
      activeProfiles: ["istructe", "rics", "istructe"],
      customFields: [{ key: "a", label: "A", type: "text" }, { key: "a", label: "Dup", type: "text" }, { key: "b", label: "B", type: "bogus" }, "junk"],
    });
    expect(s.name).toBe("Keep");
    expect(s.jobRole).toBe("");
    expect(s.activeProfiles).toEqual(["istructe"]);
    expect(s.customFields).toEqual([{ key: "a", label: "A", type: "text" }]);
  });

  it("returns a fresh copy of the defaults each time", () => {
    const a = parseStoredSettings(null);
    a.activeProfiles.push("custom");
    expect(parseStoredSettings(null).activeProfiles).toEqual(["ice"]);
    expect(DEFAULT_SETTINGS.activeProfiles).toEqual(["ice"]);
  });

  it("maps to and from a database row", () => {
    const row = settingsToRow(USER, good);
    expect(row).toEqual({
      user_id: USER,
      name: "Test Person",
      job_role: "Engineer",
      responsibilities: "Things",
      sector: "Highways",
      active_profiles: ["ice", "custom"],
      custom_fields: [{ key: "site", label: "Site", type: "text" }],
    });
    expect(rowToSettings(row)).toEqual(good);
    expect(rowToSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(rowToSettings({ ...row, custom_fields: null, active_profiles: null })).toEqual({ ...good, activeProfiles: ["ice"], customFields: [] });
  });
});

describe("parseStoredEntry", () => {
  it("reads a valid entry back unchanged", () => {
    expect(parseStoredEntry(fullEntry())).toEqual(fullEntry());
  });

  it("accepts numeric strings and timestamps in other formats", () => {
    const e = parseStoredEntry({ ...fullEntry(), hours: "1.50", detectedDurationMinutes: "90", createdAt: "2026-03-04T10:00:00.123456+00:00" });
    expect(e?.hours).toBe(1.5);
    expect(e?.detectedDurationMinutes).toBe(90);
    expect(e?.createdAt).toBe("2026-03-04T10:00:00.123Z");
  });

  it("normalises a timestamp given for a date column", () => {
    expect(parseStoredEntry({ ...fullEntry(), dateCompleted: "2026-03-04T00:00:00+00:00" })?.dateCompleted).toBe("2026-03-04");
  });

  it.each([
    ["no id", { id: undefined }],
    ["an empty id", { id: "" }],
    ["no user", { userId: undefined }],
    ["no profile", { profile: undefined }],
    ["an unknown profile", { profile: "rics" }],
    ["no title", { title: undefined }],
    ["no date completed", { dateCompleted: undefined }],
    ["an impossible date", { dateCompleted: "2026-13-45" }],
    ["no hours", { hours: undefined }],
    ["negative hours", { hours: -1 }],
    ["hours as words", { hours: "two" }],
    ["no created time", { createdAt: undefined }],
    ["a created time that is not a time", { createdAt: "soon" }],
  ])("returns null for %s", (_n, over) => {
    expect(parseStoredEntry({ ...fullEntry(), ...over })).toBeNull();
  });

  it("returns null for things that are not objects", () => {
    for (const bad of [null, undefined, "x", 4, [], true]) expect(parseStoredEntry(bad)).toBeNull();
  });

  it("falls back to empty values for broken optional fields instead of dropping the row", () => {
    const e = parseStoredEntry({
      ...fullEntry(),
      url: 5,
      provider: {},
      sourceType: "podcast",
      publishedAt: "not a date",
      dateEnd: "also not",
      detectedDurationMinutes: "n/a",
      hoursConfirmed: "yes",
      theme: 7,
      structuralSafety: "maybe",
      devPlanRef: null,
      learningPoints: 9,
      benefits: "text",
      developmentGained: [],
      custom: [1, 2],
      notes: false,
      aiAssisted: "no",
      confidence: 3,
      deletedAt: "never",
    });
    expect(e).not.toBeNull();
    expect(e).toMatchObject({
      url: null,
      provider: null,
      sourceType: "other",
      publishedAt: null,
      dateEnd: null,
      detectedDurationMinutes: null,
      hoursConfirmed: false,
      theme: null,
      structuralSafety: null,
      devPlanRef: "",
      learningPoints: "",
      benefits: { helped: "", future: "", nextYear: "" },
      developmentGained: "",
      custom: {},
      notes: "",
      aiAssisted: false,
      confidence: {},
      deletedAt: null,
    });
  });

  it("keeps the good parts of partly good jsonb values", () => {
    const e = parseStoredEntry({
      ...fullEntry(),
      benefits: { helped: "yes", future: 5, extra: "x" },
      custom: { a: "ok", b: 2, __proto__: "no" },
      confidence: { title: { level: "low", evidence: "e" }, bad: { level: "certain" }, worse: "x" },
    });
    expect(e?.benefits).toEqual({ helped: "yes", future: "", nextYear: "" });
    expect(e?.custom).toEqual({ a: "ok" });
    expect(e?.confidence).toEqual({ title: { level: "low", evidence: "e" } });
  });

  it("does not let a __proto__ key from JSON pollute anything", () => {
    const raw = JSON.parse('{"custom":{"__proto__":"x","safe":"y"}}') as Record<string, unknown>;
    const e = parseStoredEntry({ ...fullEntry(), ...raw });
    expect(Object.keys(e?.custom ?? {})).toEqual(["safe"]);
    expect(({} as Record<string, unknown>).safe).toBeUndefined();
  });

  it("uses the created time when the updated time is missing", () => {
    const { updatedAt: _omit, ...rest } = fullEntry();
    expect(parseStoredEntry(rest)?.updatedAt).toBe("2026-03-04T10:00:00.000Z");
  });
});

describe("database rows", () => {
  it("entryInputToRow uses snake_case, sets user_id and leaves id and timestamps to the database", () => {
    const row = entryInputToRow(USER, makeInput());
    expect(row.user_id).toBe(USER);
    expect(row.deleted_at).toBeNull();
    expect(row).not.toHaveProperty("id");
    expect(row).not.toHaveProperty("created_at");
    expect(row).not.toHaveProperty("updated_at");
    expect(row).toMatchObject({
      source_type: "article",
      published_at: "2026-01-10",
      date_completed: "2026-03-04",
      date_end: null,
      detected_duration_minutes: 90,
      hours: 1.5,
      hours_confirmed: true,
      dev_plan_ref: "unplanned",
      learning_points: "Test learning points.",
      development_gained: "",
      ai_assisted: false,
      structural_safety: null,
    });
    expect(row.benefits).toEqual({ helped: "a", future: "b", nextYear: "c" });
    expect(row.custom).toEqual({ site: "Test site" });
    expect(row.confidence).toEqual({ title: { level: "high", evidence: "Test evidence" } });
    // No camelCase leaks into the row.
    for (const k of Object.keys(row)) expect(k).toMatch(/^[a-z_]+$/);
  });

  it("entryInputToRow covers every EntryInput field", () => {
    const keys = Object.keys(makeInput()).length;
    // 23 input fields, plus user_id and deleted_at.
    expect(Object.keys(entryInputToRow(USER, makeInput())).length).toBe(keys + 2);
  });

  it("entryPatchToRow maps only what is present and never id, user or deleted", () => {
    expect(entryPatchToRow({ title: "T", hours: 2 })).toEqual({ title: "T", hours: 2 });
    expect(entryPatchToRow({})).toEqual({});
    const sneaky = entryPatchToRow({ title: "T", id: "x", userId: "y", deletedAt: null, createdAt: "z" } as unknown as Partial<EntryInput>);
    expect(sneaky).toEqual({ title: "T" });
    expect(entryPatchToRow({ theme: null })).toEqual({ theme: null });
  });

  it("round trips an entry through a row", () => {
    const row = { ...entryInputToRow(USER, makeInput()), id: ID, created_at: "2026-03-04T10:00:00+00:00", updated_at: "2026-03-04T10:00:00+00:00", deleted_at: null };
    expect(rowToEntry(row)).toEqual(fullEntry());
  });

  it("reads a row the way Postgres returns it (numeric strings, microsecond timestamps)", () => {
    const row = {
      id: ID,
      user_id: USER,
      profile: "istructe",
      title: "Row title",
      url: null,
      provider: null,
      source_type: "live_event",
      published_at: null,
      date_completed: "2026-03-04",
      date_end: "2026-03-05",
      detected_duration_minutes: "120.5",
      hours: "2.50",
      hours_confirmed: true,
      theme: null,
      category: "Self-directed study",
      structural_safety: true,
      sustainability: false,
      dev_plan_ref: "unplanned",
      learning_points: "",
      benefits: { helped: "", future: "", nextYear: "" },
      development_gained: "One sentence.",
      custom: {},
      notes: "",
      ai_assisted: true,
      confidence: {},
      created_at: "2026-03-04T10:00:00.123456+00:00",
      updated_at: "2026-03-05T11:30:00.5+00:00",
      deleted_at: "2026-03-06T00:00:00+00:00",
    };
    expect(rowToEntry(row)).toEqual({
      id: ID,
      userId: USER,
      profile: "istructe",
      title: "Row title",
      url: null,
      provider: null,
      sourceType: "live_event",
      publishedAt: null,
      dateCompleted: "2026-03-04",
      dateEnd: "2026-03-05",
      detectedDurationMinutes: 120.5,
      hours: 2.5,
      hoursConfirmed: true,
      theme: null,
      category: "Self-directed study",
      structuralSafety: true,
      sustainability: false,
      devPlanRef: "unplanned",
      learningPoints: "",
      benefits: { helped: "", future: "", nextYear: "" },
      developmentGained: "One sentence.",
      custom: {},
      notes: "",
      aiAssisted: true,
      confidence: {},
      createdAt: "2026-03-04T10:00:00.123Z",
      updatedAt: "2026-03-05T11:30:00.500Z",
      deletedAt: "2026-03-06T00:00:00.000Z",
    });
  });

  it("copes with null jsonb and null text columns", () => {
    const row = { ...entryInputToRow(USER, makeInput()), id: ID, created_at: "2026-03-04T10:00:00Z", updated_at: "2026-03-04T10:00:00Z", benefits: null, custom: null, confidence: null, notes: null, learning_points: null, ai_assisted: null, dev_plan_ref: null };
    const e = rowToEntry(row);
    expect(e).toMatchObject({ benefits: { helped: "", future: "", nextYear: "" }, custom: {}, confidence: {}, notes: "", learningPoints: "", aiAssisted: false, devPlanRef: "" });
  });

  it("rowToEntry returns null for unusable rows and rowsToEntries counts them", () => {
    const good = { ...entryInputToRow(USER, makeInput()), id: ID, created_at: "2026-03-04T10:00:00Z", updated_at: "2026-03-04T10:00:00Z" };
    expect(rowToEntry(null)).toBeNull();
    expect(rowToEntry({ ...good, hours: "abc" })).toBeNull();
    const { entries, dropped } = rowsToEntries([good, { ...good, id: undefined }, "junk", good]);
    expect(entries).toHaveLength(2);
    expect(dropped).toBe(2);
    expect(rowsToEntries(null)).toEqual({ entries: [], dropped: 0 });
  });
});

describe("small helpers", () => {
  it("assertMonth accepts YYYY-MM only", () => {
    expect(() => assertMonth("2026-03")).not.toThrow();
    expect(() => assertMonth("2026-12")).not.toThrow();
    for (const bad of ["2026-13", "2026-00", "2026-3", "26-03", "2026-03-01", "March 2026", "", " 2026-03"]) {
      expect(() => assertMonth(bad)).toThrow(StoreInputError);
    }
  });

  it("normaliseCap treats anything that is not a positive number as zero", () => {
    expect(normaliseCap(5)).toBe(5);
    expect(normaliseCap(5.9)).toBe(5);
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, -Infinity]) expect(normaliseCap(bad)).toBe(0);
  });

  it("compareEntriesNewestFirst sorts by date completed then created time, newest first", () => {
    const a = fullEntry({ id: "a", dateCompleted: "2026-03-01", createdAt: "2026-03-01T10:00:00.000Z" });
    const b = fullEntry({ id: "b", dateCompleted: "2026-03-02", createdAt: "2026-03-01T09:00:00.000Z" });
    const c = fullEntry({ id: "c", dateCompleted: "2026-03-02", createdAt: "2026-03-01T11:00:00.000Z" });
    expect([a, b, c].sort(compareEntriesNewestFirst).map((e) => e.id)).toEqual(["c", "b", "a"]);
  });
});

describe("text Postgres cannot store", () => {
  const NUL = "\u0000";
  const HIGH = "\ud800";
  const LOW = "\udc00";

  it("removes a null character and a lone surrogate from every text field, so both stores keep the same text", () => {
    const out = validateEntryInput(
      makeInput({
        title: `a${NUL}b${HIGH}c${LOW}d`,
        url: null,
        provider: `Pro${NUL}vider`,
        theme: `The${HIGH}me`,
        devPlanRef: `ref${NUL}`,
        learningPoints: `learn${LOW}ing`,
        developmentGained: `dev${NUL}`,
        notes: `no${NUL}tes`,
        benefits: { helped: `h${NUL}`, future: `f${HIGH}`, nextYear: `${LOW}n` },
        custom: { site: `Si${NUL}te` },
        confidence: { title: { level: "high", evidence: `ev${NUL}idence` } },
      }),
    );
    expect(out).toMatchObject({
      title: "abcd",
      provider: "Provider",
      theme: "Theme",
      devPlanRef: "ref",
      learningPoints: "learning",
      developmentGained: "dev",
      notes: "notes",
      benefits: { helped: "h", future: "f", nextYear: "n" },
      custom: { site: "Site" },
      confidence: { title: { level: "high", evidence: "evidence" } },
    });
  });

  it("keeps a valid surrogate pair (an emoji) and every other character", () => {
    const title = "Bridge 🌉 inspection – café 東京";
    expect(validateEntryInput(makeInput({ title })).title).toBe(title);
  });

  it("applies to patches and to settings too", () => {
    expect(validateEntryPatch({ title: `x${NUL}y`, notes: `a${HIGH}b` })).toEqual({ title: "xy", notes: "ab" });
    const settings = validateSettings({
      ...DEFAULT_SETTINGS,
      name: `An${NUL}n`,
      customFields: [{ key: "site", label: `Si${NUL}te`, type: "text" }],
    } satisfies UserSettings);
    expect(settings.name).toBe("Ann");
    expect(settings.customFields).toEqual([{ key: "site", label: "Site", type: "text" }]);
  });

  it("refuses names (keys) that contain them, because removing them could join two names into one", () => {
    expectInputError(() => validateEntryInput(makeInput({ custom: { [`a${NUL}b`]: "x" } })), /field name/);
    expectInputError(() => validateEntryInput(makeInput({ custom: { [`a${HIGH}`]: "x" } })), /field name/);
    expectInputError(() => validateEntryInput(makeInput({ confidence: { [`a${NUL}`]: { level: "high", evidence: "" } } })), /name/);
    expectInputError(() => validateSettings({ ...DEFAULT_SETTINGS, customFields: [{ key: `k${NUL}`, label: "L", type: "text" }] }), /key/);
  });

  it("still counts the length of what it was given", () => {
    expectInputError(() => validateEntryInput(makeInput({ title: `${NUL}${"x".repeat(1000)}` })), /1000 characters or fewer/);
  });
});

describe("the link on an entry", () => {
  const url = (value: unknown) => validateEntryInput(makeInput({ url: value as string | null })).url;

  it("accepts null and ordinary web addresses, as given", () => {
    expect(url(null)).toBeNull();
    for (const good of ["https://example.test/resource", "http://example.test", "HTTPS://EXAMPLE.TEST/A?b=c#d", "https://example.test:8443/x y"]) {
      expect(url(good), good).toBe(good);
    }
  });

  it.each([
    ["javascript:alert(1)"],
    ["JaVaScRiPt:alert(1)"],
    ["file:///etc/passwd"],
    ["data:text/html,<script>alert(1)</script>"],
    ["vbscript:msgbox(1)"],
    ["ftp://example.test/file"],
    ["mailto:someone@example.test"],
    ["//example.test/protocol-relative"],
    ["example.test/no-scheme"],
    ["https://"],
    ["not a url"],
  ])("refuses %s, naming the field", (bad) => {
    expectInputError(() => url(bad), /^Link must be a web address starting with http:\/\/ or https:\/\/\.$/);
    expectInputError(() => validateEntryPatch({ url: bad }), /Link must be a web address/);
  });

  it("refuses a link longer than the limit", () => {
    expectInputError(() => url(`https://example.test/${"a".repeat(4096)}`), /Link must be 4096 characters or fewer/);
    expect(url(`https://example.test/${"a".repeat(4096 - 21)}`)).toHaveLength(4096);
  });

  it("treats a blank link as no link, and trims blank space around a real one", () => {
    expect(url("")).toBeNull();
    expect(url("   \t")).toBeNull();
    expect(url("  https://example.test/x \n")).toBe("https://example.test/x");
  });

  it("refuses something that is not text", () => {
    expectInputError(() => url(5), /Link must be text/);
    expectInputError(() => url(undefined), /Link must be text/);
    expectInputError(() => url({ href: "https://example.test" }), /Link must be text/);
  });

  it("is only checked on the way in: reading a stored row stays lenient", () => {
    expect(parseStoredEntry(fullEntry({ url: "javascript:alert(1)" }))?.url).toBe("javascript:alert(1)");
  });
});

describe("normaliseCap with very large caps", () => {
  it("cuts a cap Postgres could not take to the largest integer it can", () => {
    expect(normaliseCap(99_999_999_999)).toBe(2_147_483_647);
    expect(normaliseCap(2_147_483_648)).toBe(2_147_483_647);
    expect(normaliseCap(Number.MAX_SAFE_INTEGER)).toBe(2_147_483_647);
    expect(normaliseCap(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it("leaves ordinary caps alone", () => {
    expect(normaliseCap(100)).toBe(100);
    expect(normaliseCap(2_147_483_647)).toBe(2_147_483_647);
    expect(normaliseCap(7.9)).toBe(7);
    expect(normaliseCap(0)).toBe(0);
  });
});
