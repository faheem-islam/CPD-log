import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CONFIDENCE_RANK, MERGED_FIELD_KEYS, mergeResults } from "@/lib/adapters/merge";
import { ADAPTERS, SPECIFICITY_BY_ID, selectAdapters } from "@/lib/adapters/registry";
import { emptyResult, field, missing } from "@/lib/adapters/common";
import { eventsAdapter } from "@/lib/adapters/events";
import { genericAdapter } from "@/lib/adapters/generic";
import { govDocsAdapter } from "@/lib/adapters/gov-docs";
import { iceHubAdapter } from "@/lib/adapters/ice-hub";
import { youtubeAdapter } from "@/lib/adapters/youtube";
import type { AdapterResult, Confidence, Field } from "@/lib/types";

const NOW = new Date("2026-10-07T09:00:00Z");
const html = (name: string): string => readFileSync(path.resolve(import.meta.dirname, "../fixtures/html", name), "utf8");
const SPEC = { specific: 50, other: 40, generic: 0 };

function result(adapter: string, patch: Partial<AdapterResult> = {}): AdapterResult {
  return { ...emptyResult(adapter), ...patch };
}

function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

describe("the rank table", () => {
  it("orders high above estimate above low above missing", () => {
    expect(CONFIDENCE_RANK.high).toBeGreaterThan(CONFIDENCE_RANK.estimate);
    expect(CONFIDENCE_RANK.estimate).toBeGreaterThan(CONFIDENCE_RANK.low);
    expect(CONFIDENCE_RANK.low).toBeGreaterThan(CONFIDENCE_RANK.missing);
  });
  it("covers every confidence level and every merged field", () => {
    expect(Object.keys(CONFIDENCE_RANK).sort()).toEqual(["estimate", "high", "low", "missing"]);
    expect([...MERGED_FIELD_KEYS].sort()).toEqual(
      ["durationMinutes", "eventDate", "provider", "providerCpdHours", "publishedAt", "sourceType", "theme", "title"],
    );
  });
});

describe("mergeResults: the best confidence wins", () => {
  it("takes high over estimate over low over missing, whatever the order", () => {
    const levels: Confidence[] = ["missing", "low", "estimate", "high"];
    for (const order of [levels, [...levels].reverse(), ["low", "high", "missing", "estimate"] as Confidence[]]) {
      const results = order.map((c, i) =>
        result(`a${i}`, { durationMinutes: c === "missing" ? missing(`ev ${c}`) : field(10 + i, c, `ev ${c}`) }),
      );
      const merged = mergeResults(results, {});
      expect(merged.durationMinutes.confidence).toBe("high");
      expect(merged.durationMinutes.evidence).toBe("ev high");
    }
  });

  it("lets a High field from a low-specificity adapter beat a Check field from a specific one", () => {
    const specific = result("specific", { title: field("Specific", "low", "guess") });
    const generic = result("generic", { title: field("Generic", "high", "structured data") });
    expect(mergeResults([specific, generic], SPEC).title.value).toBe("Generic");
  });

  it("ranks an Estimate above a Check", () => {
    const a = result("a", { durationMinutes: field(30, "low", "scheduled") });
    const b = result("b", { durationMinutes: field(12, "estimate", "word count") });
    expect(mergeResults([a, b], {}).durationMinutes.value).toBe(12);
    expect(mergeResults([b, a], {}).durationMinutes.value).toBe(12);
  });

  it("ranks anything above missing, including a Check", () => {
    const a = result("a", { provider: missing("nope") });
    const b = result("b", { provider: field("Guess", "low", "from the site name") });
    expect(mergeResults([a, b], { a: 99, b: 1 }).provider).toEqual({ value: "Guess", confidence: "low", evidence: "from the site name" });
  });

  it("merges each field on its own", () => {
    const a = result("a", { title: field("A title", "high", "A"), provider: field("A prov", "low", "A") });
    const b = result("b", { title: field("B title", "low", "B"), provider: field("B prov", "high", "B"), publishedAt: field("2026-01-02", "high", "B") });
    const m = mergeResults([a, b], {});
    expect(m.title.value).toBe("A title");
    expect(m.provider.value).toBe("B prov");
    expect(m.publishedAt.value).toBe("2026-01-02");
  });
});

describe("mergeResults: ties", () => {
  it("goes to the higher-specificity adapter", () => {
    const g = result("generic", { title: field("Generic", "high", "g") });
    const s = result("specific", { title: field("Specific", "high", "s") });
    expect(mergeResults([g, s], SPEC).title.value).toBe("Specific");
    expect(mergeResults([s, g], SPEC).title.value).toBe("Specific");
  });
  it("goes to the one listed first when specificity is equal", () => {
    const a = result("a", { title: field("A", "low", "a") });
    const b = result("b", { title: field("B", "low", "b") });
    expect(mergeResults([a, b], { a: 5, b: 5 }).title.value).toBe("A");
    expect(mergeResults([b, a], { a: 5, b: 5 }).title.value).toBe("B");
  });
  it("treats an adapter missing from the table as the lowest specificity", () => {
    const a = result("known", { title: field("Known", "low", "k") });
    const b = result("unknown", { title: field("Unknown", "low", "u") });
    expect(mergeResults([b, a], { known: 1 }).title.value).toBe("Known");
  });
  it("is not confused by specificity keys that are object prototype names", () => {
    const a = result("constructor", { title: field("C", "low", "c") });
    const b = result("__proto__", { title: field("P", "low", "p") });
    const c = result("toString", { title: field("T", "low", "t") });
    expect(mergeResults([a, b, c], {}).title.value).toBe("C");
    expect(mergeResults([a, b, c], { toString: 3 }).title.value).toBe("T");
  });
  it("ignores a non-numeric specificity", () => {
    const a = result("a", { title: field("A", "low", "a") });
    const b = result("b", { title: field("B", "low", "b") });
    const table = { a: Number.NaN, b: 1 } as Record<string, number>;
    expect(mergeResults([a, b], table).title.value).toBe("B");
  });
  it("keeps the missing evidence of the more specific adapter when everything is missing", () => {
    const g = result("generic", { durationMinutes: missing("We could not find a length for this resource.") });
    const s = result("gov-docs", { durationMinutes: missing("This looks like a landing page for a document.") });
    const merged = mergeResults([g, s], { generic: 0, "gov-docs": 50 });
    expect(merged.durationMinutes.confidence).toBe("missing");
    expect(merged.durationMinutes.evidence).toBe("This looks like a landing page for a document.");
  });
});

describe("mergeResults never upgrades a confidence level", () => {
  const levels: Confidence[] = ["high", "estimate", "low", "missing"];
  const make = (c: Confidence, label: string): Field<string> => (c === "missing" ? missing(label) : field(label, c, label));

  it("returns, for every pair, exactly the better of the two inputs and never a higher level", () => {
    for (const x of levels) {
      for (const y of levels) {
        const merged = mergeResults([result("x", { title: make(x, "x") }), result("y", { title: make(y, "y") })], { x: 1, y: 2 });
        const best = Math.max(CONFIDENCE_RANK[x], CONFIDENCE_RANK[y]);
        expect(CONFIDENCE_RANK[merged.title.confidence]).toBe(best);
        expect(CONFIDENCE_RANK[merged.title.confidence]).toBeLessThanOrEqual(best);
      }
    }
  });

  it("does not raise a field when two adapters agree on the value", () => {
    const a = result("a", { title: field("Same", "low", "a") });
    const b = result("b", { title: field("Same", "low", "b") });
    expect(mergeResults([a, b], {}).title.confidence).toBe("low");
    const c = result("c", { durationMinutes: field(15, "estimate", "c") });
    const d = result("d", { durationMinutes: field(15, "estimate", "d") });
    expect(mergeResults([c, d], {}).durationMinutes.confidence).toBe("estimate");
  });

  it("does not raise a field because of other fields", () => {
    const a = result("a", { title: field("T", "high", "a"), provider: field("P", "low", "a") });
    expect(mergeResults([a, result("b")], {}).provider.confidence).toBe("low");
  });

  it("never gives a non-missing confidence to an empty value, whatever the input says", () => {
    const broken = { value: null, confidence: "high", evidence: "bad" } as Field<string>;
    const merged = mergeResults([result("a", { title: broken })], {});
    expect(merged.title.confidence).toBe("missing");
    expect(merged.title.value).toBeNull();
  });

  it("treats an unknown confidence label as missing", () => {
    const odd = { value: "X", confidence: "certain", evidence: "bad" } as unknown as Field<string>;
    const merged = mergeResults([result("a", { title: odd })], {});
    expect(merged.title.confidence).toBe("missing");
  });

  it("keeps a Check theme at Check when merged with a generic result that has no theme", () => {
    const ice = result("ice-hub", { theme: field("Water", "low", "Guessed from the web address (/cpd/water/). Check it.") });
    const merged = mergeResults([ice, result("generic")], { "ice-hub": 60, generic: 0 });
    expect(merged.theme).toEqual({ value: "Water", confidence: "low", evidence: "Guessed from the web address (/cpd/water/). Check it." });
  });
});

describe("mergeResults: evidence, flags, notes and shape", () => {
  it("keeps the winning evidence untouched", () => {
    const a = result("a", { eventDate: field("2027-03-16", "high", "The page says 16 March 2027.") });
    expect(mergeResults([a], {}).eventDate.evidence).toBe("The page says 16 March 2027.");
  });
  it("ORs the flags", () => {
    const a = result("a", { flags: { upcoming: true, recording: false } });
    const b = result("b", { flags: { upcoming: false, recording: true } });
    expect(mergeResults([a, b], {}).flags).toEqual({ upcoming: true, recording: true });
    expect(mergeResults([result("a"), result("b")], {}).flags).toEqual({ upcoming: false, recording: false });
    expect(mergeResults([a], {}).flags).toEqual({ upcoming: true, recording: false });
  });
  it("ORs the flags from whichever result carries them: first, middle, last or only the second", () => {
    const up = result("up", { flags: { upcoming: true, recording: false } });
    const rec = result("rec", { flags: { upcoming: false, recording: true } });
    const none = () => result("none");
    expect(mergeResults([none(), up], {}).flags.upcoming).toBe(true);
    expect(mergeResults([none(), none(), up], {}).flags.upcoming).toBe(true);
    expect(mergeResults([up, none(), none()], {}).flags.upcoming).toBe(true);
    expect(mergeResults([none(), none(), none()], {}).flags.upcoming).toBe(false);
    expect(mergeResults([none(), rec], {}).flags.recording).toBe(true);
    expect(mergeResults([none(), none(), rec], {}).flags.recording).toBe(true);
    expect(mergeResults([none(), up, rec], {}).flags).toEqual({ upcoming: true, recording: true });
    expect(mergeResults([rec, none(), up], {}).flags).toEqual({ upcoming: true, recording: true });
    // The flags do not depend on which adapter is more specific.
    expect(mergeResults([none(), up], { up: 90, none: 10 }).flags.upcoming).toBe(true);
    expect(mergeResults([up, none()], { up: 1, none: 90 }).flags.upcoming).toBe(true);
  });
  it("concatenates notes in input order and removes duplicates", () => {
    const a = result("a", { notes: ["one", "two"] });
    const b = result("b", { notes: ["two", "three", " one "] });
    expect(mergeResults([a, b], {}).notes).toEqual(["one", "two", "three"]);
  });
  it("drops empty and non-string notes", () => {
    const a = result("a", { notes: ["", "  ", "kept"] });
    (a.notes as unknown[]).push(5, null);
    expect(mergeResults([a], {}).notes).toEqual(["kept"]);
  });
  it("names the adapters, most specific first, without repeats", () => {
    const merged = mergeResults([result("generic"), result("ice-hub"), result("generic")], { "ice-hub": 60, generic: 0 });
    expect(merged.adapter).toBe("ice-hub+generic");
  });
  it("returns an all-missing result for no input", () => {
    const merged = mergeResults([], {});
    for (const k of MERGED_FIELD_KEYS) {
      expect(merged[k].confidence).toBe("missing");
      expect(merged[k].evidence.length).toBeGreaterThan(5);
    }
    expect(merged.notes).toEqual([]);
  });
  it("returns a copy of a single result", () => {
    const a = result("a", { title: field("T", "high", "ev") });
    const merged = mergeResults([a], {});
    expect(merged.title).toEqual(a.title);
    expect(merged.title).not.toBe(a.title);
    merged.title.value = "changed";
    expect(a.title.value).toBe("T");
  });
  it("does not change its inputs", () => {
    const a = deepFreeze(result("a", { title: field("T", "low", "a"), notes: ["n"] }));
    const b = deepFreeze(result("b", { title: field("U", "high", "b"), notes: ["m"] }));
    expect(() => mergeResults([a, b], { a: 1, b: 2 })).not.toThrow();
  });
  it("fills a missing value from the other adapter", () => {
    const a = result("a", { title: field("T", "high", "ev") });
    const b = result("b", { provider: field("P", "low", "ev") });
    const merged = mergeResults([a, b], {});
    expect(merged.title.value).toBe("T");
    expect(merged.provider.value).toBe("P");
    expect(merged.theme.confidence).toBe("missing");
  });
});

describe("selectAdapters and the registry", () => {
  const ids = (u: string) => selectAdapters(new URL(u)).map((a) => a.id);

  it("always ends with the generic adapter, once", () => {
    for (const u of [
      "https://example.com/x",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://knowledgehub.ice.org.uk/cpd/safety-risk/x/",
      "https://www.ice.org.uk/events/x",
      "https://www.gov.uk/guidance/x",
    ]) {
      const list = ids(u);
      expect(list[list.length - 1]).toBe("generic");
      expect(list.filter((i) => i === "generic")).toHaveLength(1);
    }
  });
  it("gives only the generic adapter for an unknown site", () => {
    expect(ids("https://example.com/x")).toEqual(["generic"]);
  });
  it("picks the right specific adapter for each known host", () => {
    expect(ids("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual(["youtube", "generic"]);
    expect(ids("https://youtu.be/dQw4w9WgXcQ")).toEqual(["youtube", "generic"]);
    expect(ids("https://knowledgehub.ice.org.uk/cpd/safety-risk/x/")).toEqual(["ice-hub", "generic"]);
    expect(ids("https://www.ice.org.uk/events/upcoming-events/recording-cpd")).toEqual(["events", "generic"]);
    expect(ids("https://www.ciht.org.uk/events/x")).toEqual(["events", "generic"]);
    expect(ids("https://www.theihe.org/events/x")).toEqual(["events", "generic"]);
    expect(ids("https://www.ilp.org.uk/events/x")).toEqual(["events", "generic"]);
    expect(ids("https://www.adeptnet.org.uk/events/x")).toEqual(["events", "generic"]);
    expect(ids("https://www.roadsafetygb.org.uk/events/x")).toEqual(["events", "generic"]);
    expect(ids("https://www.gov.uk/government/publications/traffic-signs-manual")).toEqual(["gov-docs", "generic"]);
    expect(ids("https://www.legislation.gov.uk/uksi/2020/9999/regulation/3")).toEqual(["gov-docs", "generic"]);
    expect(ids("https://www.standardsforhighways.co.uk/dmrb/search/x")).toEqual(["gov-docs", "generic"]);
  });
  it("does not choose a specific adapter for look-alike hosts or non-event ICE pages", () => {
    expect(ids("https://www.ice.org.uk/about-ice")).toEqual(["generic"]);
    expect(ids("https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ")).toEqual(["generic"]);
    expect(ids("https://knowledgehub.ice.org.uk.evil.example/cpd/")).toEqual(["generic"]);
  });
  it("lists the adapters in a fixed order with the generic one last", () => {
    expect(ADAPTERS.map((a) => a.id)).toEqual(["youtube", "ice-hub", "events", "gov-docs", "generic"]);
  });
  it("gives each adapter an id that matches its specificity table entry, with generic lowest", () => {
    for (const a of ADAPTERS) expect(SPECIFICITY_BY_ID[a.id]).toBe(a.specificity);
    const generic = SPECIFICITY_BY_ID["generic"] ?? Number.NaN;
    expect(generic).toBe(0);
    for (const a of ADAPTERS.filter((x) => x.id !== "generic")) expect(a.specificity).toBeGreaterThan(generic);
    expect(new Set(ADAPTERS.map((a) => a.id)).size).toBe(ADAPTERS.length);
  });
  it("uses the same objects that the modules export", () => {
    expect(ADAPTERS).toEqual([youtubeAdapter, iceHubAdapter, eventsAdapter, govDocsAdapter, genericAdapter]);
  });
});

describe("merging real adapter output (fixtures, not live sites)", () => {
  const runAll = (url: string, body: string) => {
    const adapters = selectAdapters(new URL(url));
    return mergeResults(adapters.map((a) => a.extract({ url, html: body, now: NOW })), SPECIFICITY_BY_ID);
  };

  it("ICE explainer: the hub adapter's High fields hold, and the generic provider guess does not outrank it", () => {
    const m = runAll("https://knowledgehub.ice.org.uk/cpd/safety-risk/principal-designer-role/", html("ice-hub-explainer.html"));
    expect(m.adapter).toBe("ice-hub+generic");
    expect(m.provider).toMatchObject({ value: "Institution of Civil Engineers (ICE)", confidence: "high" });
    expect(m.theme).toMatchObject({ value: "Safety and risk management", confidence: "high" });
    expect(m.durationMinutes).toMatchObject({ value: 15, confidence: "high" });
    expect(m.sourceType.confidence).toBe("high");
    expect(m.title.confidence).toBe("high");
  });

  it("ICE ethics page: the non-exact theme stays Check after the merge", () => {
    const m = runAll("https://knowledgehub.ice.org.uk/cpd/ethics/speaking-up-at-work/", html("ice-hub-ethics.html"));
    expect(m.theme).toMatchObject({ value: "Ethical and professional behaviours", confidence: "low" });
  });

  it("gov.uk landing page: the specific missing evidence about landing pages survives", () => {
    const m = runAll("https://www.gov.uk/government/publications/traffic-signs-manual", html("govuk-publication-landing.html"));
    expect(m.durationMinutes.confidence).toBe("missing");
    expect(m.durationMinutes.evidence).toMatch(/landing page for a document/);
    expect(m.provider).toMatchObject({ value: "Department for Transport", confidence: "high" });
  });

  it("ICE recording: flags come from the events adapter and survive", () => {
    const m = runAll("https://www.ice.org.uk/events/upcoming-events/recording-cpd", html("ice-event-recording.html"));
    expect(m.flags).toEqual({ upcoming: false, recording: true });
    expect(m.durationMinutes).toMatchObject({ value: 60, confidence: "low" });
  });

  it("ICE upcoming event: the generic event reading and the events adapter agree, and the flag is kept", () => {
    const m = runAll("https://www.ice.org.uk/events/upcoming-events/safe-working-near-water/", html("ice-event-upcoming.html"));
    expect(m.flags.upcoming).toBe(true);
    expect(m.eventDate).toMatchObject({ value: "2027-03-16", confidence: "high" });
    expect(m.durationMinutes.confidence).toBe("low");
  });

  it("an unknown site is just the generic result", () => {
    const m = runAll("https://www.example.com/page", html("generic-opengraph-only.html"));
    expect(m.adapter).toBe("generic");
    expect(m.title.value).toBe("Notes on drainage design");
  });
});
