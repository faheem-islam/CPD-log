import { describe, expect, it } from "vitest";
import { ICE_ALL_THEMES, PROFILES } from "@/lib/profiles";
import { composeBenefits } from "@/lib/benefits";
import {
  cellText,
  duplicateKey,
  matchCategory,
  matchTheme,
  normaliseUrl,
  normTitle,
  parseBenefits,
  parseDateCell,
  parseDateText,
  parseHoursCell,
  parseUrlCell,
  parseYesNo,
  textField,
} from "@/lib/import/values";
import type { Cell } from "@/lib/import/types";
import { utc } from "./import-test-helpers";

const c = (v: Cell["v"], link: string | null = null): Cell => ({ v, link });

describe("cellText", () => {
  it("reads strings, numbers, booleans and dates, trimmed", () => {
    expect(cellText(c("  hello   "))).toBe("hello");
    expect(cellText(c(1.5))).toBe("1.5");
    expect(cellText(c(true))).toBe("TRUE");
    expect(cellText(c(utc(2026, 3, 4)))).toBe("2026-03-04");
    expect(cellText(c(null))).toBe("");
    expect(cellText(undefined)).toBe("");
    expect(cellText(c(Number.NaN))).toBe("");
  });
  it("removes zero-width characters and keeps line breaks", () => {
    expect(cellText(c("​ab﻿c\r\nd"))).toBe("abc\nd");
  });
  it("textField takes off one quote that an earlier export put in front of a formula character", () => {
    expect(textField(c("'=1+1"))).toBe("=1+1");
    expect(textField(c("'quoted'"))).toBe("'quoted'");
  });
});

describe("parseDateCell", () => {
  it("reads real date cells by their UTC parts", () => {
    expect(parseDateCell(c(utc(2026, 3, 4)))).toEqual({ kind: "ok", start: "2026-03-04", end: null });
    // 23:30 UTC on the 4th is still the 4th: never shifted by the local timezone.
    expect(parseDateCell(c(new Date(Date.UTC(2026, 2, 4, 23, 30))))).toEqual({ kind: "ok", start: "2026-03-04", end: null });
    expect(parseDateCell(c(new Date(Date.UTC(2026, 2, 4, 0, 0, 1))))).toMatchObject({ start: "2026-03-04" });
  });

  it("reads UK day-first text", () => {
    expect(parseDateCell(c("04/03/2026"))).toMatchObject({ start: "2026-03-04" });
    expect(parseDateCell(c("4.3.26"))).toMatchObject({ start: "2026-03-04" });
    expect(parseDateCell(c("4 March 2026"))).toMatchObject({ start: "2026-03-04" });
    expect(parseDateCell(c("Wed 4th Mar 2026"))).toMatchObject({ start: "2026-03-04" });
    expect(parseDateCell(c("2026-03-04"))).toMatchObject({ start: "2026-03-04" });
    expect(parseDateCell(c("2026-03-04T10:00:00Z"))).toMatchObject({ start: "2026-03-04" });
    expect(parseDateCell(c("03/04/2026"))).toMatchObject({ start: "2026-04-03" });
  });

  it("reads Excel serial numbers, as numbers and as numeric-looking text", () => {
    expect(parseDateCell(c(46085))).toEqual({ kind: "ok", start: "2026-03-04", end: null });
    expect(parseDateCell(c(46085.75))).toMatchObject({ start: "2026-03-04" });
    expect(parseDateCell(c("46085"))).toMatchObject({ start: "2026-03-04" });
    expect(parseDateCell(c(" 46085.5 "))).toMatchObject({ start: "2026-03-04" });
    expect(parseDateCell(c(32874))).toMatchObject({ start: "1990-01-01" });
  });

  it("reads serials in a 1904-date-system workbook", () => {
    // 46085 in the 1900 system is 44623 in the 1904 system.
    expect(parseDateCell(c(44623), true)).toMatchObject({ start: "2026-03-04" });
  });

  it("does not turn a bare year or an unlikely number into a date", () => {
    expect(parseDateCell(c(2026))).toEqual({ kind: "bad", text: "2026" });
    expect(parseDateCell(c("2026"))).toEqual({ kind: "bad", text: "2026" });
    expect(parseDateCell(c(1))).toMatchObject({ kind: "bad" });
    expect(parseDateCell(c(1e9))).toMatchObject({ kind: "bad" });
    expect(parseDateCell(c(-5))).toMatchObject({ kind: "bad" });
    expect(parseDateCell(c(Number.NaN))).toMatchObject({ kind: "bad" });
  });

  it("rejects impossible dates, text and booleans", () => {
    expect(parseDateCell(c("31/02/2026"))).toEqual({ kind: "bad", text: "31/02/2026" });
    expect(parseDateCell(c("13/13/2026"))).toMatchObject({ kind: "bad" });
    expect(parseDateCell(c("yesterday"))).toMatchObject({ kind: "bad" });
    expect(parseDateCell(c("Q1 2026"))).toMatchObject({ kind: "bad" });
    expect(parseDateCell(c("12 March"))).toMatchObject({ kind: "bad" });
    expect(parseDateCell(c(true))).toMatchObject({ kind: "bad" });
    expect(parseDateCell(c(new Date(Number.NaN)))).toMatchObject({ kind: "bad" });
    // A time-only cell is a date in December 1899, which is not a CPD date.
    expect(parseDateCell(c(new Date(Date.UTC(1899, 11, 30, 10, 0))))).toMatchObject({ kind: "bad" });
  });

  it("calls blanks empty", () => {
    expect(parseDateCell(undefined)).toEqual({ kind: "empty" });
    expect(parseDateCell(c(null))).toEqual({ kind: "empty" });
    expect(parseDateCell(c("   "))).toEqual({ kind: "empty" });
    expect(parseDateCell(c("​"))).toEqual({ kind: "empty" });
  });
});

describe("date ranges", () => {
  it.each([
    ["4-6 March 2026", "2026-03-04", "2026-03-06"],
    ["4 - 6 March 2026", "2026-03-04", "2026-03-06"],
    ["4th–6th March 2026", "2026-03-04", "2026-03-06"],
    ["04/03/2026 - 06/03/2026", "2026-03-04", "2026-03-06"],
    ["04/03/2026 to 06/03/2026", "2026-03-04", "2026-03-06"],
    ["04/03/2026 until 06/03/2026", "2026-03-04", "2026-03-06"],
    ["04/03/2026 – 06/03/2026", "2026-03-04", "2026-03-06"],
    ["04/03/2026—06/03/2026", "2026-03-04", "2026-03-06"],
    ["4 March 2026 - 6 March 2026", "2026-03-04", "2026-03-06"],
    ["4 March - 6 March 2026", "2026-03-04", "2026-03-06"],
    ["28 Feb - 2 March 2026", "2026-02-28", "2026-03-02"],
    ["30/12/2025 - 02/01/2026", "2025-12-30", "2026-01-02"],
    ["4/3 - 6/3/2026", "2026-03-04", "2026-03-06"],
    ["4 - 6/03/2026", "2026-03-04", "2026-03-06"],
    ["2026-03-04 to 2026-03-06", "2026-03-04", "2026-03-06"],
    ["2026-03-04/2026-03-06", "2026-03-04", "2026-03-06"],
    ["31 Dec 2025 - 1 Jan 2026", "2025-12-31", "2026-01-01"],
  ])("reads %s", (text, start, end) => {
    expect(parseDateText(text)).toEqual({ kind: "ok", start, end });
  });

  it("uses a one-day range as a single day", () => {
    expect(parseDateText("04/03/2026 - 04/03/2026")).toEqual({ kind: "ok", start: "2026-03-04", end: null });
  });

  it("keeps the first day and says so when the end is before the start", () => {
    const r = parseDateText("06/03/2026 - 04/03/2026");
    expect(r).toMatchObject({ kind: "ok", start: "2026-03-06", end: null });
    expect(r.kind === "ok" ? r.note : "").toMatch(/before the start/);
  });

  it("uses only the start when the end cannot be read", () => {
    expect(parseDateText("04/03/2026 - tbc")).toEqual({ kind: "ok", start: "2026-03-04", end: null });
  });

  it("is not confused by a time range after the date", () => {
    expect(parseDateText("04/03/2026 14:00 - 16:00")).toEqual({ kind: "ok", start: "2026-03-04", end: null });
  });

  it("does not take dashes inside a date for a range", () => {
    expect(parseDateText("04-03-2026")).toEqual({ kind: "ok", start: "2026-03-04", end: null });
    expect(parseDateText("2026-03-04")).toEqual({ kind: "ok", start: "2026-03-04", end: null });
  });

  it("reports text it cannot read, trimmed", () => {
    expect(parseDateText("  not a date  ")).toEqual({ kind: "bad", text: "not a date" });
    expect(parseDateText("")).toEqual({ kind: "empty" });
  });
});

describe("parseHoursCell", () => {
  const hours = (v: Cell["v"], role: "hours" | "minutes" | "duration" = "hours", header = "Hours") => parseHoursCell(c(v), role, header);

  it("reads decimals in an hours column", () => {
    expect(hours(1.5)).toMatchObject({ kind: "ok", hours: 1.5, guessed: false });
    expect(hours("1.5")).toMatchObject({ kind: "ok", hours: 1.5 });
    expect(hours("0.25")).toMatchObject({ kind: "ok", hours: 0.25 });
    expect(hours(" 2 ")).toMatchObject({ kind: "ok", hours: 2 });
    expect(hours(".5")).toMatchObject({ kind: "ok", hours: 0.5 });
  });

  it("reads comma decimals", () => {
    expect(hours("1,5")).toMatchObject({ kind: "ok", hours: 1.5 });
    expect(hours("0,25")).toMatchObject({ kind: "ok", hours: 0.25 });
    expect(hours("1,5 hours")).toMatchObject({ kind: "ok", hours: 1.5 });
    expect(hours("2,5h")).toMatchObject({ kind: "ok", hours: 2.5 });
  });

  it("treats 1,500 as a thousands separator, not a decimal", () => {
    expect(hours("1,500")).toMatchObject({ kind: "ok", hours: 1500 });
  });

  it("reads units", () => {
    expect(hours("1h 30m")).toMatchObject({ hours: 1.5 });
    expect(hours("1 hr 30 min")).toMatchObject({ hours: 1.5 });
    expect(hours("1 hour 30 minutes")).toMatchObject({ hours: 1.5 });
    expect(hours("90 mins")).toMatchObject({ hours: 1.5 });
    expect(hours("90m")).toMatchObject({ hours: 1.5 });
    expect(hours("45 minutes")).toMatchObject({ hours: 0.75 });
    expect(hours("2 hours")).toMatchObject({ hours: 2 });
    expect(hours("1.5 hrs")).toMatchObject({ hours: 1.5 });
    expect(hours("1h30")).toMatchObject({ hours: 1.5 });
    expect(hours("1h")).toMatchObject({ hours: 1 });
    expect(hours("20 mins")).toMatchObject({ hours: 0.33 });
  });

  it("lets a unit override the column: 90 mins in an Hours column is 1.5 hours", () => {
    const r = hours("90 mins", "hours");
    expect(r).toMatchObject({ kind: "ok", hours: 1.5, guessed: false });
    expect((r as { reading?: string }).reading).toBeUndefined();
  });

  it("reads clock times", () => {
    expect(hours("1:30")).toMatchObject({ hours: 1.5 });
    expect(hours("0:45")).toMatchObject({ hours: 0.75 });
    expect(hours("10:00")).toMatchObject({ hours: 10 });
    expect(hours("1:30:00")).toMatchObject({ hours: 1.5 });
  });

  it("reads an Excel time cell (a date on 30 December 1899)", () => {
    expect(hours(new Date(Date.UTC(1899, 11, 30, 1, 30)))).toMatchObject({ hours: 1.5 });
    expect(hours(new Date(Date.UTC(1899, 11, 31, 2, 0)))).toMatchObject({ hours: 26 });
    expect(hours(utc(2026, 3, 4))).toMatchObject({ kind: "bad" });
  });

  it("reads a bare number in a Minutes column as minutes", () => {
    expect(hours(90, "minutes", "Minutes")).toMatchObject({ hours: 1.5, guessed: false });
    expect(hours("45", "minutes", "Mins")).toMatchObject({ hours: 0.75 });
    expect(hours(60, "minutes", "Minutes")).toMatchObject({ hours: 1 });
  });

  it("reads a bare number in a Time or Duration column as hours up to 12 and as minutes above, and says which", () => {
    const h = hours(2, "duration", "Duration");
    expect(h).toMatchObject({ hours: 2, guessed: true });
    expect((h as { reading: string }).reading).toBe('Read "2" in the "Duration" column as 2 hours. Check this is right.');
    const edge = hours(12, "duration", "Time");
    expect(edge).toMatchObject({ hours: 12, guessed: true });
    const m = hours(45, "duration", "Duration");
    expect(m).toMatchObject({ hours: 0.75, guessed: true });
    expect((m as { reading: string }).reading).toBe('Read "45" in the "Duration" column as 45 minutes (0.75 hours). Check this is right.');
    expect(hours(13, "duration", "Time")).toMatchObject({ hours: 0.22 });
    expect(hours("90", "duration", "Time")).toMatchObject({ hours: 1.5, guessed: true });
    // 12.5 is above 12, so it is minutes
    expect(hours(12.5, "duration", "Time")).toMatchObject({ hours: 0.21 });
  });

  it("does not guess when the text gives a unit, even in an ambiguous column", () => {
    const r = hours("2 hours", "duration", "Duration");
    expect(r).toMatchObject({ hours: 2, guessed: false });
    expect((r as { reading?: string }).reading).toBeUndefined();
  });

  it("keeps zero and negative numbers so the checks can block them", () => {
    expect(hours(0)).toMatchObject({ kind: "ok", hours: 0 });
    expect(hours(-1)).toMatchObject({ kind: "ok", hours: -1 });
    expect(hours("-1.5")).toMatchObject({ kind: "ok", hours: -1.5 });
  });

  it("rejects what is not a duration", () => {
    expect(hours("abc")).toEqual({ kind: "bad", text: "abc" });
    expect(hours("10 metres")).toMatchObject({ kind: "bad" });
    expect(hours("2026-03-04")).toMatchObject({ kind: "bad" });
    expect(hours(true)).toMatchObject({ kind: "bad" });
    expect(hours(Number.POSITIVE_INFINITY)).toMatchObject({ kind: "bad" });
    expect(hours("0h")).toMatchObject({ kind: "bad" });
    expect(hours("0 mins")).toMatchObject({ kind: "bad" });
  });

  it("calls blanks empty", () => {
    expect(parseHoursCell(undefined, "hours", "Hours")).toEqual({ kind: "empty" });
    expect(hours(null)).toEqual({ kind: "empty" });
    expect(hours("  ")).toEqual({ kind: "empty" });
  });

  it("rounds to two decimals", () => {
    expect(hours(1.239)).toMatchObject({ hours: 1.24 });
    expect(hours("1h 20m")).toMatchObject({ hours: 1.33 });
  });
});

describe("parseYesNo", () => {
  it("reads yes in its forms", () => {
    for (const v of ["Y", "y", "Yes", "YES", "true", "TRUE", "1", "x", "✓", "✔", "tick"]) {
      expect(parseYesNo(c(v))).toEqual({ kind: "ok", value: true });
    }
    expect(parseYesNo(c(true))).toEqual({ kind: "ok", value: true });
    expect(parseYesNo(c(1))).toEqual({ kind: "ok", value: true });
  });
  it("reads no in its forms", () => {
    for (const v of ["N", "n", "No", "false", "FALSE", "0"]) expect(parseYesNo(c(v))).toEqual({ kind: "ok", value: false });
    expect(parseYesNo(c(false))).toEqual({ kind: "ok", value: false });
    expect(parseYesNo(c(0))).toEqual({ kind: "ok", value: false });
  });
  it("treats dashes, n/a and blanks as not answered", () => {
    for (const v of ["", "  ", "-", "–", "n/a", "N/A", "?", "tbc"]) expect(parseYesNo(c(v))).toEqual({ kind: "empty" });
    expect(parseYesNo(undefined)).toEqual({ kind: "empty" });
  });
  it("reports what it does not understand", () => {
    expect(parseYesNo(c("maybe"))).toEqual({ kind: "bad", text: "maybe" });
    expect(parseYesNo(c(7))).toEqual({ kind: "bad", text: "7" });
  });
});

describe("normaliseUrl and parseUrlCell", () => {
  it("keeps http and https links", () => {
    expect(normaliseUrl("https://example.test/a?b=1#c")).toBe("https://example.test/a?b=1#c");
    expect(normaliseUrl("http://example.test")).toBe("http://example.test");
    expect(normaliseUrl("<https://example.test/a>")).toBe("https://example.test/a");
  });
  it("adds https to a bare web address", () => {
    expect(normaliseUrl("www.example.test/page")).toBe("https://www.example.test/page");
    expect(normaliseUrl("example.test/page")).toBe("https://example.test/page");
    expect(normaliseUrl("ice.example.org.uk")).toBe("https://ice.example.org.uk");
  });
  it("refuses other schemes and non-links", () => {
    for (const bad of ["javascript:alert(1)", "data:text/html,hi", "file:///etc/passwd", "ftp://example.test/a", "mailto:a@example.test", "vbscript:x", "just words", "", "http://", "https://exa mple.test", "localhost:3000/x"]) {
      expect(normaliseUrl(bad)).toBeNull();
    }
  });
  it("removes credentials from a link", () => {
    const u = normaliseUrl("https://user:secret@example.test/path");
    expect(u).toBe("https://example.test/path");
    expect(u).not.toContain("secret");
  });
  it("refuses a very long link", () => {
    expect(normaliseUrl(`https://example.test/${"a".repeat(2100)}`)).toBeNull();
  });
  it("prefers the link behind a hyperlink cell and falls back to the text", () => {
    expect(parseUrlCell(c("Click here", "https://example.test/x"))).toEqual({ kind: "ok", url: "https://example.test/x" });
    expect(parseUrlCell(c("https://example.test/y"))).toEqual({ kind: "ok", url: "https://example.test/y" });
    expect(parseUrlCell(c("Click here"))).toEqual({ kind: "bad", text: "Click here" });
    expect(parseUrlCell(c(null))).toEqual({ kind: "empty" });
    expect(parseUrlCell(undefined)).toEqual({ kind: "empty" });
    expect(parseUrlCell(c("Click here", "javascript:alert(1)"))).toEqual({ kind: "bad", text: "Click here" });
  });
});

describe("matchTheme", () => {
  it("matches exactly, ignoring case and punctuation", () => {
    expect(matchTheme("Safety and risk management", ICE_ALL_THEMES)).toEqual({ kind: "exact", value: "Safety and risk management" });
    expect(matchTheme("  WATER ", ICE_ALL_THEMES)).toEqual({ kind: "exact", value: "Water" });
    expect(matchTheme("Sustainable-development", ICE_ALL_THEMES)).toEqual({ kind: "exact", value: "Sustainable development" });
  });
  it('reads "Safety & risk" as "Safety and risk management"', () => {
    expect(matchTheme("Safety & risk", ICE_ALL_THEMES)).toEqual({ kind: "fuzzy", value: "Safety and risk management" });
    expect(matchTheme("Safety and risk", ICE_ALL_THEMES)).toEqual({ kind: "fuzzy", value: "Safety and risk management" });
    expect(matchTheme("Safety", ICE_ALL_THEMES)).toEqual({ kind: "fuzzy", value: "Safety and risk management" });
  });
  it("uses the aliases in the profile config", () => {
    expect(matchTheme("Ethics", ICE_ALL_THEMES)).toEqual({ kind: "fuzzy", value: "Ethical and professional behaviours" });
    expect(matchTheme("Sustainability", ICE_ALL_THEMES)).toEqual({ kind: "fuzzy", value: "Sustainable development" });
    expect(matchTheme("Delivery", ICE_ALL_THEMES)).toEqual({ kind: "fuzzy", value: "Delivery excellence" });
    expect(matchTheme("safety-risk", ICE_ALL_THEMES)).toEqual({ kind: "fuzzy", value: "Safety and risk management" });
  });
  it("does not guess when the text fits more than one theme", () => {
    expect(matchTheme("Transport and energy", ICE_ALL_THEMES)).toEqual({ kind: "none", text: "Transport and energy" });
    expect(matchTheme("Water and transport", ICE_ALL_THEMES)).toMatchObject({ kind: "none" });
  });
  it("leaves unknown themes unmatched", () => {
    expect(matchTheme("Cooking", ICE_ALL_THEMES)).toEqual({ kind: "none", text: "Cooking" });
    expect(matchTheme("e", ICE_ALL_THEMES)).toMatchObject({ kind: "none" });
  });
  it("calls blanks empty", () => {
    expect(matchTheme("", ICE_ALL_THEMES)).toEqual({ kind: "empty" });
    expect(matchTheme("  - ", ICE_ALL_THEMES)).toEqual({ kind: "empty" });
  });
  it("every exact theme name in the config matches itself", () => {
    for (const t of ICE_ALL_THEMES) expect(matchTheme(t, ICE_ALL_THEMES)).toEqual({ kind: "exact", value: t });
  });
});

describe("matchCategory", () => {
  it("matches the IStructE categories", () => {
    expect(matchCategory("self directed study")).toEqual({ kind: "exact", value: "Self-directed study" });
    expect(matchCategory("Courses")).toEqual({ kind: "fuzzy", value: "Courses, events and seminars" });
    expect(matchCategory("Work based")).toEqual({ kind: "fuzzy", value: "Work-based learning" });
    expect(matchCategory("Horizon broadening")).toEqual({ kind: "exact", value: "Horizon broadening" });
  });
  it("leaves the rest unmatched", () => {
    expect(matchCategory("Gardening")).toEqual({ kind: "none", text: "Gardening" });
    expect(matchCategory("")).toEqual({ kind: "empty" });
    for (const cat of PROFILES.istructe.categories) expect(matchCategory(cat)).toEqual({ kind: "exact", value: cat });
  });
});

describe("parseBenefits", () => {
  it("reads labelled lines back into the three answers", () => {
    const parts = { helped: "One.", future: "Two.", nextYear: "Three." };
    expect(parseBenefits(composeBenefits(parts))).toEqual(parts);
    const two = { helped: "", future: "Only future.", nextYear: "And next year." };
    expect(parseBenefits(composeBenefits(two))).toEqual(two);
  });
  it("puts text without labels in How it helped", () => {
    expect(parseBenefits("It made me think about drainage.")).toEqual({ helped: "It made me think about drainage.", future: "", nextYear: "" });
  });
  it("keeps several lines under their label", () => {
    expect(parseBenefits("How it helped: Line one\nline two\nHow I will use it in future: Later")).toEqual({
      helped: "Line one\nline two",
      future: "Later",
      nextYear: "",
    });
  });
  it("keeps text before the first label", () => {
    expect(parseBenefits("Intro text\nHow I will use it in future: Later")).toEqual({ helped: "Intro text", future: "Later", nextYear: "" });
  });
  it("matches labels with curly apostrophes and other cases", () => {
    expect(parseBenefits("how it will influence next year’s plan: Next")).toEqual({ helped: "", future: "", nextYear: "Next" });
  });
  it("does not treat other colons as labels", () => {
    expect(parseBenefits("Note: this is not a label")).toEqual({ helped: "Note: this is not a label", future: "", nextYear: "" });
  });
  it("returns empty answers for empty text", () => {
    expect(parseBenefits("  ")).toEqual({ helped: "", future: "", nextYear: "" });
  });
});

describe("duplicateKey", () => {
  it("ignores case, punctuation and spacing in the title", () => {
    expect(duplicateKey("2026-03-04", "  Test: Title!! ")).toBe(duplicateKey("2026-03-04", "test title"));
    expect(normTitle("Café – Test")).toBe("café test");
  });
  it("differs by date and by title", () => {
    expect(duplicateKey("2026-03-04", "a")).not.toBe(duplicateKey("2026-03-05", "a"));
    expect(duplicateKey("2026-03-04", "a")).not.toBe(duplicateKey("2026-03-04", "b"));
  });
  it("is null when the date or the title is missing", () => {
    expect(duplicateKey("", "a")).toBeNull();
    expect(duplicateKey("2026-03-04", "  !! ")).toBeNull();
  });
});
