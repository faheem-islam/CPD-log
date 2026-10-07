import { describe, expect, it } from "vitest";
import { parseDelimitedText } from "@/lib/import/parse";
import { commitRows, looksLikeEntryInput, revalidateRows, validateImportRow } from "@/lib/import/revalidate";
import { ImportError, type ImportRow } from "@/lib/import/types";
import { SCREENSHOT_WARNING } from "@/lib/import/validate";
import type { EntryInput } from "@/lib/types";
import { makeSettings } from "./export-test-helpers";
import { issueKeys, makeCtx, messages } from "./import-test-helpers";

const GOOD = "Learned how to check a drainage design against the standard.";

function parse(lines: string[], c = makeCtx()) {
  return parseDelimitedText(["Date,Title,Hours,Theme,Key Learning Points", ...lines].join("\n"), c);
}

function edit(row: ImportRow, patch: Partial<EntryInput>): ImportRow {
  return { ...row, input: { ...row.input, ...patch } };
}

describe("validateImportRow", () => {
  const ctx = makeCtx();
  const base = parse([`04/03/2026,A,1,Water,${GOOD}`]).rows[0]?.input as EntryInput;

  it("finds nothing wrong with a clean entry", () => {
    expect(validateImportRow(base, "ice", ctx)).toEqual([]);
  });

  it("re-runs each error", () => {
    expect(issueKeys({ issues: validateImportRow({ ...base, dateCompleted: "" }, "ice", ctx) } as ImportRow)).toEqual(["dateCompleted:error"]);
    expect(issueKeys({ issues: validateImportRow({ ...base, dateCompleted: "2026-02-31" }, "ice", ctx) } as ImportRow)).toEqual(["dateCompleted:error"]);
    expect(issueKeys({ issues: validateImportRow({ ...base, dateCompleted: "04/03/2026" }, "ice", ctx) } as ImportRow)).toEqual(["dateCompleted:error"]);
    expect(validateImportRow({ ...base, title: "   " }, "ice", ctx).map((i) => i.field)).toEqual(["title"]);
    for (const hours of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 24.01]) {
      expect(validateImportRow({ ...base, hours }, "ice", ctx).map((i) => `${i.field}:${i.severity}`), String(hours)).toEqual(["hours:error"]);
    }
    expect(validateImportRow({ ...base, hours: 24 }, "ice", ctx)).toEqual([]);
  });

  it("re-runs each warning", () => {
    expect(validateImportRow({ ...base, hours: 31, dateEnd: "2026-03-06" }, "ice", ctx).map((i) => `${i.field}:${i.severity}`)).toEqual(["hours:warning"]);
    expect(validateImportRow({ ...base, theme: "Cooking" }, "ice", ctx).map((i) => i.field)).toEqual(["theme"]);
    expect(validateImportRow({ ...base, learningPoints: "" }, "ice", ctx).map((i) => i.field)).toEqual(["learningPoints"]);
    expect(validateImportRow({ ...base, learningPoints: "Various things" }, "ice", ctx).map((i) => i.field)).toEqual(["learningPoints"]);
    expect(validateImportRow({ ...base, benefits: { helped: "n/a", future: "", nextYear: "" } }, "ice", ctx).map((i) => i.field)).toEqual(["benefits"]);
    expect(validateImportRow({ ...base, dateCompleted: "2027-01-01" }, "ice", ctx).map((i) => i.message)).toEqual(["This date is in the future. Log CPD after you have done it."]);
    expect(validateImportRow({ ...base, dateEnd: "2026-03-01" }, "ice", ctx).map((i) => i.field)).toEqual(["dateEnd"]);
  });

  it("uses the 24 hours a day limit for ranges", () => {
    expect(validateImportRow({ ...base, hours: 48, dateEnd: "2026-03-05" }, "ice", ctx).filter((i) => i.severity === "error")).toEqual([]);
    expect(validateImportRow({ ...base, hours: 40, dateEnd: "2026-03-05" }, "ice", ctx).map((i) => `${i.field}:${i.severity}`)).toEqual(["hours:warning"]);
    expect(validateImportRow({ ...base, hours: 49, dateEnd: "2026-03-05" }, "ice", ctx).some((i) => i.severity === "error")).toBe(true);
  });

  it("checks the IStructE fields for an IStructE profile", () => {
    const c = makeCtx({ profile: "istructe" });
    const ist: EntryInput = { ...base, profile: "istructe", category: "Gardening", developmentGained: "" };
    expect(validateImportRow(ist, "istructe", c).map((i) => i.field).sort()).toEqual(["category", "developmentGained"]);
    expect(validateImportRow({ ...ist, category: "Self-directed study", developmentGained: GOOD }, "istructe", c)).toEqual([]);
  });

  it("uses the profile it is given, whatever the input says", () => {
    const asIstructe = validateImportRow({ ...base, learningPoints: "", developmentGained: "" }, "istructe", makeCtx({ profile: "istructe" }));
    expect(asIstructe.map((i) => i.field)).toEqual(["developmentGained"]);
  });

  it("spots a duplicate of an existing entry", () => {
    const c = makeCtx({ existing: [{ dateCompleted: "2026-03-04", title: "a" }] });
    expect(validateImportRow(base, "ice", c).map((i) => i.field)).toEqual(["duplicate"]);
  });

  it("keeps the screenshot warning for rows that came from a screenshot", () => {
    const c = makeCtx({ fromScreenshot: true });
    expect(validateImportRow(base, "ice", c).map((i) => i.message)).toEqual([SCREENSHOT_WARNING]);
  });

  it("puts errors before warnings", () => {
    const issues = validateImportRow({ ...base, title: "", theme: "Cooking" }, "ice", ctx);
    expect(issues.map((i) => i.severity)).toEqual(["error", "warning"]);
  });
});

describe("revalidateRows", () => {
  const ctx = makeCtx();

  it("clears an error once the user has fixed it, and ticks the row", () => {
    const r = parse([`04/03/2026,A,0,Water,${GOOD}`]);
    expect(r.rows[0]?.include).toBe(false);
    const fixed = revalidateRows([edit(r.rows[0] as ImportRow, { hours: 1.5 })], ctx);
    expect(fixed[0]?.issues).toEqual([]);
    expect(fixed[0]?.include).toBe(true);
  });

  it("unticks a row that now has an error", () => {
    const r = parse([`04/03/2026,A,1,Water,${GOOD}`]);
    const broken = revalidateRows([edit(r.rows[0] as ImportRow, { title: "" })], ctx);
    expect(broken[0]?.include).toBe(false);
    expect(issueKeys(broken[0])).toEqual(["title:error"]);
  });

  it("keeps a row the user unticked, and a row they ticked", () => {
    const r = parse([`04/03/2026,A,1,Water,${GOOD}`, `05/03/2026,B,1,Water,${GOOD}`]);
    const rows = [{ ...(r.rows[0] as ImportRow), include: false }, r.rows[1] as ImportRow];
    const out = revalidateRows(rows, ctx);
    expect(out.map((x) => x.include)).toEqual([false, true]);
  });

  it("keeps the n of each row and does not change the input it was given", () => {
    const r = parse([`04/03/2026,A,1,Water,${GOOD}`]);
    const before = JSON.stringify(r.rows);
    const out = revalidateRows(r.rows, ctx);
    expect(out[0]?.n).toBe(r.rows[0]?.n);
    expect(JSON.stringify(r.rows)).toBe(before);
  });

  it("finds a duplicate that the edit has just created, between rows of the file", () => {
    const r = parse([`04/03/2026,A,1,Water,${GOOD}`, `05/03/2026,B,1,Water,${GOOD}`]);
    const out = revalidateRows([r.rows[0] as ImportRow, edit(r.rows[1] as ImportRow, { dateCompleted: "2026-03-04", title: "a" })], ctx);
    expect(out[0]?.duplicate).toBe(false);
    expect(out[1]?.duplicate).toBe(true);
    expect(out[1]?.include).toBe(false);
    expect(messages(out[1], "duplicate")[0]).toMatch(/duplicate of row/);
  });

  it("ticks a row again when an edit removes its only problem, a duplicate", () => {
    const c = makeCtx({ existing: [{ dateCompleted: "2026-03-04", title: "A" }] });
    const r = parse([`04/03/2026,A,1,Water,${GOOD}`], c);
    expect(r.rows[0]?.duplicate).toBe(true);
    const out = revalidateRows([edit(r.rows[0] as ImportRow, { title: "A different title" })], c);
    expect(out[0]?.duplicate).toBe(false);
    expect(out[0]?.include).toBe(true);
  });

  it("does not untick a duplicate the user chose to keep", () => {
    const c = makeCtx({ existing: [{ dateCompleted: "2026-03-04", title: "A" }] });
    const r = parse([`04/03/2026,A,1,Water,${GOOD}`], c);
    const ticked = { ...(r.rows[0] as ImportRow), include: true };
    const out = revalidateRows([edit(ticked, { hours: 2 })], c);
    expect(out[0]?.duplicate).toBe(true);
    expect(out[0]?.include).toBe(true);
  });

  it("drops the how-it-was-read warnings once the row has been reviewed, but keeps the screenshot warning", () => {
    const r = parseDelimitedText("Date,Title,Duration\n04/03/2026,A,45", makeCtx({ fromScreenshot: false }));
    expect(r.rows[0]?.issues.some((i) => /Read "45"/.test(i.message))).toBe(true);
    // The user edits the hours: the warning was about a value that is no longer there.
    const out = revalidateRows([edit(r.rows[0] as ImportRow, { hours: 1 })], ctx);
    expect(out[0]?.issues.some((i) => /Read "45"/.test(i.message))).toBe(false);
    const shot = parseDelimitedText("Date,Title,Hours\n04/03/2026,A,1", ctx, { fromScreenshot: true });
    const again = revalidateRows(shot.rows, makeCtx({ fromScreenshot: true }));
    expect(again[0]?.issues.some((i) => i.message === SCREENSHOT_WARNING)).toBe(true);
  });
});

describe("commitRows", () => {
  const ctx = makeCtx();

  it("returns only the ticked rows, as EntryInput, in order", () => {
    const r = parse([`04/03/2026,A,1,Water,${GOOD}`, `05/03/2026,B,1,Water,${GOOD}`, `06/03/2026,C,1,Water,${GOOD}`]);
    const rows = [r.rows[0] as ImportRow, { ...(r.rows[1] as ImportRow), include: false }, r.rows[2] as ImportRow];
    const out = commitRows(rows);
    expect(out.map((e) => e.title)).toEqual(["A", "C"]);
    expect(out[0]).toBe(rows[0]?.input);
  });

  it("returns nothing when nothing is ticked", () => {
    const r = parse([`04/03/2026,A,1,Water,${GOOD}`]);
    expect(commitRows([{ ...(r.rows[0] as ImportRow), include: false }])).toEqual([]);
    expect(commitRows([])).toEqual([]);
  });

  it("throws when a ticked row still has an error, naming the row and what to do", () => {
    const r = parse([`04/03/2026,A,1,Water,${GOOD}`, `05/03/2026,B,0,Water,${GOOD}`]);
    const rows = [r.rows[0] as ImportRow, { ...(r.rows[1] as ImportRow), include: true }];
    try {
      commitRows(rows);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ImportError);
      expect((e as ImportError).code).toBe("commit_blocked");
      expect((e as ImportError).message).toBe("Row 3 still has a problem: Hours must be more than 0. Enter the effective learning time, for example 1.5. Fix it, or untick the row to leave it out.");
    }
  });

  it("lets an unticked row keep its error", () => {
    const r = parse([`04/03/2026,A,0,Water,${GOOD}`]);
    expect(r.rows[0]?.include).toBe(false);
    expect(commitRows(r.rows)).toEqual([]);
  });

  it("does not trust the row's own issue list: edited input with an error blocks even when issues say none", () => {
    const r = parse([`04/03/2026,A,1,Water,${GOOD}`]);
    const forged: ImportRow = { ...(r.rows[0] as ImportRow), include: true, issues: [], input: { ...(r.rows[0]?.input as EntryInput), hours: -5 } };
    expect(() => commitRows([forged])).toThrow(/Row 2 still has a problem/);
    const noTitle: ImportRow = { ...(r.rows[0] as ImportRow), include: true, issues: [], input: { ...(r.rows[0]?.input as EntryInput), title: " " } };
    expect(() => commitRows([noTitle])).toThrow(/Add the activity title/);
    const noDate: ImportRow = { ...(r.rows[0] as ImportRow), include: true, issues: [], input: { ...(r.rows[0]?.input as EntryInput), dateCompleted: "yesterday" } };
    expect(() => commitRows([noDate])).toThrow(/Add the date/);
  });

  it("blocks a ticked row whose error is only in its issue list", () => {
    const r = parse([`04/03/2026,A,1,Water,${GOOD}`]);
    const withIssue: ImportRow = { ...(r.rows[0] as ImportRow), include: true, issues: [{ severity: "error", field: "title", message: "Test error." }] };
    expect(() => commitRows([withIssue])).toThrow(/Test error\./);
  });

  it("lets warnings through", () => {
    const r = parse([`04/03/2026,A,1,Cooking,`]);
    expect(r.rows[0]?.issues.some((i) => i.severity === "warning")).toBe(true);
    expect(commitRows(r.rows)).toHaveLength(1);
  });

  it("with a context, forces the profile and keeps only the user's own custom fields", () => {
    const s = makeSettings({ customFields: [{ key: "cert", label: "Certificate", type: "text" }] });
    const c = makeCtx({ profile: "custom", settings: s });
    const r = parseDelimitedText("Date,Activity,Hours,Certificate\n04/03/2026,A,1,C-1", c);
    const row = r.rows[0] as ImportRow;
    const tampered: ImportRow = { ...row, input: { ...row.input, profile: "ice", custom: { cert: "C-1", other: "should go" } } };
    const out = commitRows([tampered], c);
    expect(out[0]?.profile).toBe("custom");
    expect(out[0]?.custom).toEqual({ cert: "C-1" });
    // For another profile there are no custom values at all.
    const asIce = commitRows([{ ...row, input: { ...row.input, custom: { cert: "x" } } }], makeCtx({ profile: "ice", settings: s }));
    expect(asIce[0]?.custom).toEqual({});
  });

  it("with a context, blocks a ticked row that has an error of its own", () => {
    const r = parse([`04/03/2026,A,1,Water,${GOOD}`]);
    const bad: ImportRow = { ...(r.rows[0] as ImportRow), include: true, issues: [], input: { ...(r.rows[0]?.input as EntryInput), hours: 0 } };
    expect(() => commitRows([bad], ctx)).toThrow(ImportError);
  });

  it("refuses a ticked row whose input is not shaped like an entry, instead of crashing", () => {
    const r = parse([`04/03/2026,A,1,Water,${GOOD}`]);
    const row = r.rows[0] as ImportRow;
    const bad = (patch: Record<string, unknown>): ImportRow => ({ ...row, include: true, input: { ...row.input, ...patch } as unknown as EntryInput });
    for (const patch of [
      { title: 5 },
      { title: undefined },
      { hours: "1.5" },
      { benefits: null },
      { benefits: { helped: 1, future: "", nextYear: "" } },
      { custom: [] },
      { custom: { a: 1 } },
      { confidence: null },
      { profile: "other" },
      { dateCompleted: null },
      { structuralSafety: "yes" },
    ]) {
      try {
        commitRows([bad(patch)]);
        throw new Error(`should have thrown for ${JSON.stringify(patch)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ImportError);
        expect((e as ImportError).code).toBe("commit_blocked");
        expect((e as ImportError).message).toMatch(/^Row 2 is not in the expected format/);
      }
    }
    expect(() => commitRows([{ ...row, include: true, input: null as unknown as EntryInput }])).toThrow(ImportError);
    // issues missing or malformed from the browser do not crash it, and the input is still checked
    expect(commitRows([{ ...row, include: true, issues: undefined as unknown as ImportRow["issues"] }])).toHaveLength(1);
    expect(() => commitRows([{ ...row, include: true, issues: [null, { severity: "error", field: "x", message: "Test error." }] as unknown as ImportRow["issues"] }])).toThrow(/Test error/);
    // an unticked row is not looked at
    expect(commitRows([{ ...bad({ title: 5 }), include: false }])).toEqual([]);
  });

  it("knows what an entry input looks like", () => {
    const input = parse([`04/03/2026,A,1,Water,${GOOD}`]).rows[0]?.input;
    expect(looksLikeEntryInput(input)).toBe(true);
    expect(looksLikeEntryInput({})).toBe(false);
    expect(looksLikeEntryInput("text")).toBe(false);
    expect(looksLikeEntryInput(undefined)).toBe(false);
  });

  it("refuses more than 2000 rows at once", () => {
    const r = parse([`04/03/2026,A,1,Water,${GOOD}`]);
    const row = r.rows[0] as ImportRow;
    const many = Array.from({ length: 2001 }, () => row);
    try {
      commitRows(many);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as ImportError).code).toBe("too_many_rows");
    }
    expect(commitRows(many.slice(0, 2000))).toHaveLength(2000);
  });
});
