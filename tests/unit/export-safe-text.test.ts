import { describe, expect, it } from "vitest";
import { MAX_CELL_CHARS, clampCell, cleanText, neutraliseFormula, safeText, unneutraliseFormula } from "@/lib/export/safe-text";

describe("neutraliseFormula", () => {
  it.each(["=1+1", "+1", "-1", "@a", "\t=x", "\r=x", "=HYPERLINK(\"u\")", "-", "=", "'=x", "''-x"])("puts a quote in front of %j", (t) => {
    expect(neutraliseFormula(t)).toBe(`'${t}`);
  });

  it.each(["", "plain", "a=b", "1+1", "x-y", "email@example.test", " =leading space", "'quoted'", "'", "it's -1"])("leaves %j alone", (t) => {
    expect(neutraliseFormula(t)).toBe(t);
  });
});

describe("unneutraliseFormula", () => {
  it("takes the quote off again, once", () => {
    expect(unneutraliseFormula("'=1+1")).toBe("=1+1");
    expect(unneutraliseFormula("'+1")).toBe("+1");
    expect(unneutraliseFormula("'-x")).toBe("-x");
    expect(unneutraliseFormula("'@x")).toBe("@x");
    expect(unneutraliseFormula("''=1")).toBe("'=1");
    expect(unneutraliseFormula("''")).toBe("''");
  });
  it("leaves other text that starts with a quote", () => {
    expect(unneutraliseFormula("'quoted'")).toBe("'quoted'");
    expect(unneutraliseFormula("'")).toBe("'");
    expect(unneutraliseFormula("plain")).toBe("plain");
  });
  it("undoes neutraliseFormula for any text that needed it", () => {
    for (const t of ["=A1", "+44 123", "-5 degrees", "@mention", "'=A1", "''+1", "plain", "'quoted'", "", "\t=x"]) {
      expect(unneutraliseFormula(neutraliseFormula(t))).toBe(t);
    }
  });
});

describe("cleanText and safeText", () => {
  it("trims, normalises line breaks and removes characters XML cannot hold", () => {
    expect(cleanText("  a\r\nb\rc\u0000\u0001\u000B\u001F d  ")).toBe("a\nb\nc d");
    expect(cleanText(null)).toBe("");
    expect(cleanText(undefined)).toBe("");
    expect(cleanText("tab\tstays")).toBe("tab\tstays");
  });
  it("removes lone surrogates but keeps real emoji pairs", () => {
    expect(cleanText("a\uD83Db")).toBe("ab");
    expect(cleanText("a\uDE00b")).toBe("ab");
    expect(cleanText("ok \u{1F600}")).toBe("ok \u{1F600}");
  });
  it("cleans first so a leading control character cannot hide a formula", () => {
    expect(safeText("\u0000=1+1")).toBe("'=1+1");
    expect(safeText("  =1+1")).toBe("'=1+1");
  });
});

describe("clampCell", () => {
  it("leaves short text alone", () => {
    expect(clampCell("abc")).toEqual({ text: "abc", clamped: false });
    const edge = "x".repeat(MAX_CELL_CHARS);
    expect(clampCell(edge)).toEqual({ text: edge, clamped: false });
  });
  it("shortens long text, ends with an ellipsis and says so", () => {
    const r = clampCell("x".repeat(MAX_CELL_CHARS + 10));
    expect(r.clamped).toBe(true);
    expect(r.text).toHaveLength(MAX_CELL_CHARS);
    expect(r.text.endsWith("…")).toBe(true);
  });
  it("does not cut a surrogate pair in half", () => {
    const s = `${"x".repeat(MAX_CELL_CHARS - 2)}\u{1F600}${"y".repeat(20)}`;
    const r = clampCell(s);
    expect(r.clamped).toBe(true);
    expect(/[\uD800-\uDBFF]…$/.test(r.text)).toBe(false);
  });
});
