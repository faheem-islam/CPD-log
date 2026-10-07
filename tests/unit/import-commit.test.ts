import { describe, expect, it } from "vitest";
import { IMPORT_LIMITS, ImportError, parseDelimitedText } from "@/lib/import/parse";
import { commitRows, revalidateRows, validateImportRow } from "@/lib/import/revalidate";
import { parseTranscribedText } from "@/lib/import/screenshot";
import type { ImportRow } from "@/lib/import/types";
import { SCREENSHOT_WARNING } from "@/lib/import/validate";
import { validateEntryInput as storeAccepts } from "@/lib/store/mapping";
import type { EntryInput } from "@/lib/types";
import { makeSettings } from "./export-test-helpers";
import { issueKeys, makeCtx, messages } from "./import-test-helpers";

const GOOD = "Learned how to check a drainage design against the standard.";
const HEADER = "Date,Title,Hours,Theme,Key Learning Points";

function parse(lines: string[], c = makeCtx(), header = HEADER) {
  return parseDelimitedText([header, ...lines].join("\n"), c);
}

function edit(row: ImportRow, patch: Partial<EntryInput>): ImportRow {
  return { ...row, input: { ...row.input, ...patch } };
}

function storeRefuses(input: EntryInput): boolean {
  try {
    storeAccepts(input);
    return false;
  } catch {
    return true;
  }
}

/** A message that is safe to show: nothing from the code's own errors. */
const PLAIN = /^(?!.*(undefined|null|TypeError|Cannot read|trim|is not iterable|Object\.)).*$/s;

// ---------------------------------------------------------------------------------------------------------------

describe("commitRows stays fast and bounded", () => {
  const existing = Array.from({ length: 5000 }, (_, i) => ({ dateCompleted: "2025-01-01", title: `Existing entry ${i}` }));
  const ctx = makeCtx({ existing });

  it("commits 2000 rows against 5000 existing entries without building the duplicate keys for every row", () => {
    const lines = Array.from({ length: 2000 }, (_, i) => `04/03/2026,Row ${i},1,Water,${GOOD}`);
    const r = parse(lines, ctx);
    expect(r.rows.every((x) => x.include)).toBe(true);
    const start = performance.now();
    const out = commitRows(r.rows, ctx);
    const ms = performance.now() - start;
    expect(out).toHaveLength(2000);
    expect(ms).toBeLessThan(1500);
  }, 30000);

  it("refuses more than 2000 ticked rows before it checks any of them", () => {
    const row = parse([`04/03/2026,A,1,Water,${GOOD}`]).rows[0] as ImportRow;
    const start = performance.now();
    expect(() => commitRows(Array.from({ length: 30_000 }, () => row), ctx)).toThrowError(expect.objectContaining({ code: "too_many_rows" }));
    expect(performance.now() - start).toBeLessThan(500);
  });

  it("does not count rows that are not ticked", () => {
    const row = parse([`04/03/2026,A,1,Water,${GOOD}`]).rows[0] as ImportRow;
    const unticked = { ...row, include: false };
    expect(commitRows(Array.from({ length: 5000 }, () => unticked), ctx)).toEqual([]);
  });

  it("refuses more than 2000 rows to re-check, too", () => {
    const row = parse([`04/03/2026,A,1,Water,${GOOD}`]).rows[0] as ImportRow;
    expect(() => revalidateRows(Array.from({ length: IMPORT_LIMITS.maxRows + 1 }, () => row), makeCtx())).toThrowError(expect.objectContaining({ code: "too_many_rows" }));
  });
});

describe("a row the importer ticks is a row the store accepts", () => {
  const HEAD = "Date,Title,Hours,Theme,Key Learning Points,Key Benefits/Value added,Provider";
  const row = (over: { title?: string; benefits?: string; provider?: string; points?: string }) =>
    `04/03/2026,${over.title ?? "A"},1,Water,${over.points ?? GOOD},${over.benefits ?? "It helped."},${over.provider ?? "Test provider"}`;
  const make = (over: Parameters<typeof row>[0]) => parse([row(over)], makeCtx(), HEAD).rows[0] as ImportRow;

  it("blocks a 1375-character details cell, a 6000-character benefit and a 600-character provider, with the store's own words", () => {
    const title = make({ title: "t".repeat(1375) });
    expect(title.include).toBe(false);
    expect(messages(title, "title")).toEqual(["Title must be 1000 characters or fewer."]);
    const benefits = make({ benefits: "b".repeat(6000) });
    expect(benefits.include).toBe(false);
    expect(messages(benefits, "benefits")[0]).toMatch(/^Benefits .*must be 5000 characters or fewer\.$/);
    const provider = make({ provider: "p".repeat(600) });
    expect(provider.include).toBe(false);
    expect(messages(provider, "provider")).toEqual(["Provider must be 500 characters or fewer."]);
    const points = make({ points: "l".repeat(20001) });
    expect(points.include).toBe(false);
    expect(messages(points, "learningPoints")[0]).toMatch(/must be 20000 characters or fewer/);
  });

  it("is ticked exactly when the store accepts the row, at and either side of each limit", () => {
    const cases: [string, Parameters<typeof row>[0]][] = [
      ["title 999", { title: "t".repeat(999) }],
      ["title 1000", { title: "t".repeat(1000) }],
      ["title 1001", { title: "t".repeat(1001) }],
      ["benefits 5000", { benefits: "b".repeat(5000) }],
      ["benefits 5001", { benefits: "b".repeat(5001) }],
      ["provider 500", { provider: "p".repeat(500) }],
      ["provider 501", { provider: "p".repeat(501) }],
      ["points 20000", { points: "l".repeat(20000) }],
      ["points 20001", { points: "l".repeat(20001) }],
    ];
    const accepted: string[] = [];
    for (const [label, over] of cases) {
      const r = make(over);
      expect(r.include, label).toBe(!storeRefuses(r.input));
      if (r.include) accepted.push(label);
    }
    expect(accepted).toEqual(["title 999", "title 1000", "benefits 5000", "provider 500", "points 20000"]);
  });

  it("never lets commitRows return a row the store would refuse", () => {
    const rows = [make({}), make({ title: "t".repeat(1375) }), make({ benefits: "b".repeat(6000) }), make({ provider: "p".repeat(600) })];
    const ticked = rows.map((r) => ({ ...r, include: true }));
    expect(() => commitRows(ticked)).toThrowError(/^Row 2 still has a problem: Title must be 1000 characters or fewer\. Fix it, or untick the row to leave it out\.$/);
    for (const out of commitRows([ticked[0] as ImportRow], makeCtx())) expect(storeRefuses(out)).toBe(false);
    for (const bad of ticked.slice(1)) {
      expect(() => commitRows([bad], makeCtx())).toThrowError(expect.objectContaining({ code: "commit_blocked" }));
      expect(() => commitRows([bad])).toThrowError(expect.objectContaining({ code: "commit_blocked" }));
    }
  });

  it("makes an end date before the start date an error on the review screen, and at commit", () => {
    const good = make({});
    const edited = edit(good, { dateEnd: "2026-03-01" });
    const checked = revalidateRows([edited], makeCtx())[0] as ImportRow;
    expect(checked.include).toBe(false);
    expect(issueKeys(checked).filter((k) => k.endsWith(":error"))).toEqual(["dateEnd:error"]);
    expect(messages(checked, "dateEnd")).toEqual(["The end date is before the start date. Change one of the two dates, or clear the end date."]);
    expect(storeRefuses(edited.input)).toBe(true);
    const forced = { ...edited, include: true, issues: [] };
    expect(() => commitRows([forced])).toThrowError(expect.objectContaining({ code: "commit_blocked" }));
    expect(() => commitRows([forced], makeCtx())).toThrowError(/end date is before the start date/);
  });

  it("uses a custom field value over 5000 characters as a row error, naming the field the store names", () => {
    const settings = makeSettings({ customFields: [{ key: "cert", label: "Certificate", type: "text" }] });
    const c = makeCtx({ profile: "custom", settings });
    const r = parseDelimitedText(`Date,Activity,Hours,Certificate\n04/03/2026,A,1,${"c".repeat(5001)}`, c).rows[0] as ImportRow;
    expect(r.include).toBe(false);
    expect(messages(r, "custom")[0]).toMatch(/Custom fields \(cert\) must be 5000 characters or fewer/);
  });

  it("does not stop a row over notes the importer made about itself", () => {
    const long = "x".repeat(2000);
    const r = parse([`${long},A,1,Water,${GOOD}`]).rows[0] as ImportRow;
    expect(r.include).toBe(false);
    const t = parse([`04/03/2026,A,1,${long},${GOOD}`]).rows[0] as ImportRow;
    expect(t.include).toBe(true);
    for (const c of Object.values(t.input.confidence)) expect(c.evidence.length).toBeLessThanOrEqual(1000);
    expect(storeRefuses(t.input)).toBe(false);
  });
});

describe("commitRows does what its messages say", () => {
  const ctx = makeCtx();
  const row = (parse([`04/03/2026,A,1,Water,${GOOD}`]).rows[0] as ImportRow);
  const forged = (patch: Partial<EntryInput>): ImportRow => ({ ...edit(row, patch), include: true });

  it("drops an end date that is not a date, as the warning says it will", () => {
    expect(validateImportRow(forged({ dateEnd: "banana" }).input, "ice", ctx).map((i) => `${i.field}:${i.severity}`)).toEqual(["dateEnd:warning"]);
    const [out] = commitRows([forged({ dateEnd: "banana" })], ctx);
    expect(out?.dateEnd).toBeNull();
    expect(storeRefuses(out as EntryInput)).toBe(false);
  });

  it("drops a link that is not http or https, and says so on the review screen", () => {
    const issues = validateImportRow(forged({ url: "javascript:alert(1)" }).input, "ice", ctx);
    expect(issues.map((i) => `${i.field}:${i.severity}`)).toEqual(["url:warning"]);
    expect(issues[0]?.message).toBe("The link does not start with http:// or https://, so it will be left out.");
    for (const bad of ["javascript:alert(1)", "data:text/html,x", "ftp://example.test/x", "not a link", "//example.test"]) {
      expect(commitRows([forged({ url: bad })], ctx)[0]?.url, bad).toBeNull();
    }
    expect(commitRows([forged({ url: "https://example.test/ok" })], ctx)[0]?.url).toBe("https://example.test/ok");
    expect(commitRows([forged({ url: "https://user:pw@example.test/x" })], ctx)[0]?.url).not.toMatch(/pw/);
  });

  it("puts a source type that is not one of ours back to other", () => {
    expect(commitRows([forged({ sourceType: "<script>" as EntryInput["sourceType"] })], ctx)[0]?.sourceType).toBe("other");
    expect(commitRows([forged({ sourceType: "video" })], ctx)[0]?.sourceType).toBe("video");
  });

  it("does not carry a theme into a profile that has none, or IStructE fields into another profile", () => {
    const custom = makeCtx({ profile: "custom" });
    const [a] = commitRows([forged({ theme: "Water", category: "Self-directed study", structuralSafety: true, sustainability: false, developmentGained: "x" })], custom);
    expect(a).toMatchObject({ profile: "custom", theme: null, category: null, structuralSafety: null, sustainability: null, developmentGained: "" });
    const istructe = makeCtx({ profile: "istructe" });
    expect(commitRows([forged({ theme: "Water" })], istructe)[0]?.theme).toBeNull();
    expect(commitRows([forged({ theme: "Water" })], ctx)[0]?.theme).toBe("Water");
  });

  it("makes the notes about confidence fit the store, whatever the browser sent", () => {
    const confidence = { ok: { level: "high" as const, evidence: "e".repeat(5000) }, [`k${"x".repeat(100)}`]: { level: "low" as const, evidence: "x" }, bad: { level: "certain" as never, evidence: "x" } };
    const [out] = commitRows([forged({ confidence })], ctx);
    expect(Object.keys(out?.confidence ?? {})).toEqual(["ok"]);
    expect(out?.confidence.ok?.evidence).toHaveLength(1000);
    expect(storeRefuses(out as EntryInput)).toBe(false);
  });

  it("returns only rows the store accepts, for every forged value above", () => {
    const patches: Partial<EntryInput>[] = [
      { dateEnd: "banana" },
      { url: "javascript:alert(1)" },
      { sourceType: "<script>" as EntryInput["sourceType"] },
      { theme: "Water", category: "x" },
    ];
    for (const p of patches) for (const out of commitRows([forged(p)], ctx)) expect(storeRefuses(out), JSON.stringify(p)).toBe(false);
  });

  it("without a context, blocks what it cannot drop, because it returns the input as it is", () => {
    expect(() => commitRows([forged({ dateEnd: "banana" })])).toThrowError(expect.objectContaining({ code: "commit_blocked" }));
    expect(() => commitRows([forged({ sourceType: "<script>" as EntryInput["sourceType"] })])).toThrowError(expect.objectContaining({ code: "commit_blocked" }));
  });
});

describe("the first parse's reading warnings stay until the value is changed", () => {
  const ctx = makeCtx();
  const read = (r?: ImportRow) => r?.issues.some((i) => /^Read "(45|90)"/.test(i.message)) ?? false;
  const parsed = () => parseDelimitedText("Date,Title,Duration\n04/03/2026,A,90\n05/03/2026,B,45", ctx);

  it("keeps them on rows that were not edited", () => {
    const r = parsed();
    expect(r.rows.map(read)).toEqual([true, true]);
    const out = revalidateRows(r.rows, ctx);
    expect(out.map(read)).toEqual([true, true]);
    expect(out[0]?.issues.map((i) => i.field)).toContain("hours");
    // and again, after another re-check
    expect(revalidateRows(out, ctx).map(read)).toEqual([true, true]);
  });

  it("drops the warning of the row whose hours were edited, and keeps the other", () => {
    const r = parsed();
    // 90 minutes was read as 1.5 hours. The user changes it to 2.
    const out = revalidateRows([edit(r.rows[0] as ImportRow, { hours: 2 }), r.rows[1] as ImportRow], ctx);
    expect(out.map(read)).toEqual([false, true]);
    // The user has looked at the figure, so the warning does not come back, even if it is changed back to what it was.
    const back = revalidateRows([edit(out[0] as ImportRow, { hours: 1.5 })], ctx);
    expect(read(back[0])).toBe(false);
  });

  it("keeps the warning when a different field of the row is edited", () => {
    const r = parsed();
    const out = revalidateRows([edit(r.rows[0] as ImportRow, { title: "A new title" })], ctx);
    expect(read(out[0])).toBe(true);
  });

  it("keeps a warning about a link that was left out until the link is filled in", () => {
    const r = parseDelimitedText("Date,Title,Hours,Link\n04/03/2026,A,1,see attached", ctx);
    expect(messages(r.rows[0], "url")[0]).toMatch(/does not start with http/);
    expect(messages(revalidateRows(r.rows, ctx)[0], "url")[0]).toMatch(/does not start with http/);
    expect(messages(revalidateRows([edit(r.rows[0] as ImportRow, { url: "https://example.test/x" })], ctx)[0], "url")).toEqual([]);
  });

  it("does not show a warning twice", () => {
    const r = parsed();
    const out = revalidateRows(revalidateRows(r.rows, ctx), ctx);
    const readings = out[0]?.issues.filter((i) => /^Read "90"/.test(i.message)) ?? [];
    expect(readings).toHaveLength(1);
  });

  it("ignores warnings that came back from a browser in the wrong shape, or that are not about the current value", () => {
    const r = parsed();
    const row = r.rows[0] as ImportRow;
    const forgedWarnings = [
      null,
      "text",
      { issue: { severity: "error", field: "hours", message: "Forged error." }, value: JSON.stringify(row.input.hours) },
      { issue: { severity: "warning", field: "hours", message: "x".repeat(501) }, value: JSON.stringify(row.input.hours) },
      { issue: { severity: "warning", field: "hours", message: "Stale." }, value: "999" },
      { issue: { severity: "warning", field: 5, message: "Bad field." }, value: "1" },
    ];
    const out = revalidateRows([{ ...row, parseWarnings: forgedWarnings as unknown as ImportRow["parseWarnings"] }], ctx);
    expect(out[0]?.issues.map((i) => i.message)).not.toEqual(expect.arrayContaining(["Forged error.", "Stale.", "Bad field."]));
    expect(out[0]?.include).toBe(true);
    expect(out[0]?.parseWarnings ?? []).toEqual([]);
    expect(() => revalidateRows([{ ...row, parseWarnings: "nope" as unknown as ImportRow["parseWarnings"] }], ctx)).not.toThrow();
  });
});

describe("a row read from a screenshot keeps its warning after a re-check", () => {
  const md = ["| Date | Title | Hours |", "|---|---|---|", "| 04/03/2026 | A | 1 |", "| 05/03/2026 | B | 2 |"].join("\n");
  const plain = makeCtx();
  const warned = (r?: ImportRow) => r?.issues.filter((i) => i.message === SCREENSHOT_WARNING).length ?? 0;

  it("marks the rows themselves, so the caller does not have to remember", () => {
    const r = parseTranscribedText(md, plain);
    expect(r.rows.every((x) => x.fromScreenshot === true)).toBe(true);
    expect(parseDelimitedText("Date,Title,Hours\n04/03/2026,A,1", plain).rows[0]?.fromScreenshot).toBeUndefined();
  });

  it("shows the warning again with the same context that was used to parse, and after an edit", () => {
    const r = parseTranscribedText(md, plain);
    expect(plain.fromScreenshot).toBeUndefined();
    const again = revalidateRows(r.rows, plain);
    expect(again.map(warned)).toEqual([1, 1]);
    const edited = revalidateRows([edit(r.rows[0] as ImportRow, { hours: 2 }), r.rows[1] as ImportRow], plain);
    expect(edited.map(warned)).toEqual([1, 1]);
    expect(revalidateRows(edited, plain).map(warned)).toEqual([1, 1]);
    expect(edited.every((x) => x.fromScreenshot === true)).toBe(true);
  });

  it("does not add the warning to rows that did not come from a screenshot", () => {
    const r = parseDelimitedText("Date,Title,Hours\n04/03/2026,A,1", plain);
    expect(warned(revalidateRows(r.rows, plain)[0])).toBe(0);
  });

  it("still adds it to every row when the context says so, as before", () => {
    const r = parseDelimitedText("Date,Title,Hours\n04/03/2026,A,1", plain);
    expect(warned(revalidateRows(r.rows, makeCtx({ fromScreenshot: true }))[0])).toBe(1);
  });
});

describe("rows that are not shaped like rows are refused in plain words", () => {
  const ctx = makeCtx();
  const row = parse([`04/03/2026,A,1,Water,${GOOD}`]).rows[0] as ImportRow;
  const bad: [string, unknown][] = [
    ["an input with only a profile", { ...row, input: { profile: "ice" } }],
    ["a null row", null],
    ["a row that is a string", "text"],
    ["a row with no input", { n: 2, include: true, issues: [], duplicate: false }],
    ["benefits that are null", { ...row, input: { ...row.input, benefits: null } }],
    ["custom values that are not text", { ...row, input: { ...row.input, custom: { a: 1 } } }],
  ];

  function thrown(f: () => unknown): ImportError {
    try {
      f();
    } catch (e) {
      expect(e).toBeInstanceOf(ImportError);
      return e as ImportError;
    }
    throw new Error("should have thrown");
  }

  it.each(bad)("revalidateRows refuses %s", (_label, value) => {
    const e = thrown(() => revalidateRows([value as ImportRow], ctx));
    expect(e.code).toBe("commit_blocked");
    expect(e.message).toMatch(/^Row \d+ is not in the expected format\. Reload the page, read the file again, and try again\.$/);
    expect(e.message).toMatch(PLAIN);
  });

  it.each(bad)("commitRows refuses %s", (_label, value) => {
    const e = thrown(() => commitRows([{ ...(value as ImportRow), include: true }]));
    expect(e.code).toBe("commit_blocked");
    expect(e.message).toMatch(PLAIN);
  });

  it("names the row by its number, or by its place in the list when the number is not usable", () => {
    expect(thrown(() => revalidateRows([row, { ...row, n: 17, input: { profile: "ice" } as unknown as EntryInput }], ctx)).message).toMatch(/^Row 17 /);
    expect(thrown(() => revalidateRows([row, { n: "x", input: null } as unknown as ImportRow], ctx)).message).toMatch(/^Row 2 /);
  });

  it("refuses a list that is not a list", () => {
    for (const v of [null, undefined, {}, "rows", 5]) {
      expect(thrown(() => revalidateRows(v as unknown as ImportRow[], ctx)).message).toMatch(PLAIN);
      expect(thrown(() => commitRows(v as unknown as ImportRow[])).message).toMatch(PLAIN);
      expect(thrown(() => commitRows(v as unknown as ImportRow[], ctx)).code).toBe("commit_blocked");
    }
  });

  it("refuses an entry that is not shaped like an entry in validateImportRow", () => {
    for (const v of [{ profile: "ice" }, null, undefined, "text", { ...row.input, hours: "1" }]) {
      const e = thrown(() => validateImportRow(v as unknown as EntryInput, "ice", ctx));
      expect(e.code).toBe("commit_blocked");
      expect(e.message).toMatch(PLAIN);
    }
  });

  it("does not echo a forged issue message that is not text, or is very long", () => {
    const forged = { ...row, include: true, issues: [{ severity: "error", field: "x", message: { toString: "nope" } }] } as unknown as ImportRow;
    expect(thrown(() => commitRows([forged])).message).toBe("Row 2 still has a problem: This row has a problem. Fix it, or untick the row to leave it out.");
    const long = { ...row, include: true, issues: [{ severity: "error", field: "x", message: "m".repeat(5000) }] } as ImportRow;
    expect(thrown(() => commitRows([long])).message.length).toBeLessThan(400);
  });

  it("treats a ticked flag that is not true as not ticked", () => {
    expect(commitRows([{ ...row, include: "yes" as unknown as boolean }])).toEqual([]);
    expect(revalidateRows([{ ...row, include: "yes" as unknown as boolean }], ctx)[0]?.include).toBe(false);
  });
});
