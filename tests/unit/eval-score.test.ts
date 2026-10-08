import { describe, expect, it } from "vitest";
import { parseEvalCsv, renderReport, scoreField, scoreUrl, summarise, textMatches } from "@/lib/eval/score";
import type { AdapterResult, ExtractResponse, Field, SourceType } from "@/lib/types";

const f = <T,>(value: T | null, confidence: Field<T>["confidence"] = "high", evidence = "test"): Field<T> => ({ value, confidence, evidence });

function result(over: Partial<AdapterResult> = {}): AdapterResult {
  return {
    adapter: "test",
    title: f("Principal designer role"),
    provider: f("Institution of Civil Engineers (ICE)"),
    sourceType: f<SourceType>("article"),
    theme: f("Safety and risk management"),
    durationMinutes: f(15),
    publishedAt: f("2025-04-02"),
    eventDate: f<string>(null, "missing"),
    providerCpdHours: f<number>(null, "missing"),
    flags: { upcoming: false, recording: false },
    notes: [],
    ...over,
  };
}

const ok = (r: AdapterResult): ExtractResponse => ({ status: "ok", url: "https://x.test/", message: "Read the page.", result: r });

describe("parseEvalCsv", () => {
  it("treats blank cells as not scored", () => {
    const rows = parseEvalCsv("url,title,provider,sourceType,durationMinutes,publishedAt,eventDate,theme\nhttps://a.test/,My title,,video,15,,,\n");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expected).toEqual({ title: "My title", sourceType: "video", durationMinutes: "15" });
  });
  it("reports unreadable dates and durations as CSV problems, not silently", () => {
    const rows = parseEvalCsv("url,publishedAt,durationMinutes\nhttps://a.test/,tomorrow-ish,lots\n");
    expect(rows[0]?.problems).toHaveLength(2);
    expect(rows[0]?.expected).toEqual({});
  });
  it("skips empty rows, handles BOM and quoted commas", () => {
    const rows = parseEvalCsv('﻿url,title\n\nhttps://a.test/,"Roads, signs and lines"\n');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.expected.title).toBe("Roads, signs and lines");
  });
  it("needs a url column", () => {
    expect(() => parseEvalCsv("title\nx\n")).toThrow(/url/);
  });
});

describe("scoring", () => {
  it("matches titles ignoring case, punctuation and site suffixes", () => {
    expect(textMatches("Principal Designer Role", "principal designer role | ICE")).toBe(true);
    expect(textMatches("Something else", "Principal designer role")).toBe(false);
    expect(textMatches("", "x")).toBe(false);
  });
  it("scores correct, wrong and not found", () => {
    const r = result({ durationMinutes: f<number>(null, "missing"), publishedAt: f("2025-04-03") });
    expect(scoreField("title", "Principal designer role", r).outcome).toBe("correct");
    expect(scoreField("publishedAt", "02/04/2025", r).outcome).toBe("wrong");
    expect(scoreField("durationMinutes", "15", r).outcome).toBe("not_found");
    expect(scoreField("sourceType", "article", r).outcome).toBe("correct");
    expect(scoreField("theme", "Safety and risk management", r).outcome).toBe("correct");
  });
  it("allows one minute either way for durations", () => {
    expect(scoreField("durationMinutes", "16", result()).outcome).toBe("correct");
    expect(scoreField("durationMinutes", "20", result()).outcome).toBe("wrong");
    expect(scoreField("durationMinutes", "0h 15m", result()).outcome).toBe("correct");
  });
  it("counts a page that could not be read as not found for every scored field", () => {
    const row = { url: "https://blocked.test/", expected: { title: "T", durationMinutes: "10" }, problems: [] };
    const s = scoreUrl(row, { status: "blocked", url: row.url, message: "This site doesn't allow automated reading.", result: null });
    expect(s.status).toBe("blocked");
    expect(s.fields.map((x) => x.outcome)).toEqual(["not_found", "not_found"]);
  });
  it("measures how often High was right, and shows the wrong High values", () => {
    const row = { url: "https://a.test/", expected: { title: "Principal designer role", provider: "Someone else" }, problems: [] };
    const scored = scoreUrl(row, ok(result()));
    const s = summarise([scored]);
    expect(s.high).toEqual({ checked: 2, correct: 1 });
    const report = renderReport([scored], "2026-10-08T00:00:00Z");
    expect(report).toMatch(/50%/);
    expect(report).toMatch(/Wrong values/);
    expect(report).toMatch(/Someone else/);
    expect(report).not.toMatch(/\bverified\b/i);
    expect(report).toMatch(/only the URLs/i);
  });
  it("says plainly when nothing was scored", () => {
    const report = renderReport([scoreUrl({ url: "https://a.test/", expected: {}, problems: [] }, ok(result()))], "now");
    expect(report).toMatch(/Nothing was scored/);
  });
});
