import { describe, expect, it } from "vitest";
import {
  DEFAULT_QUERY,
  NO_THEME,
  activeFilterCount,
  filterEntries,
  parseQuery,
  safeHref,
  searchHaystack,
  serialiseQuery,
  sortEntries,
  themeChoices,
  totalHours,
  yearChoices,
  type LogEntry,
  type LogQuery,
} from "@/components/log/log-filters";

let n = 0;
function entry(over: Partial<LogEntry> = {}): LogEntry {
  n += 1;
  return {
    id: `id-${n}`,
    profile: "ice",
    title: `Entry ${n}`,
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
    createdAt: `2026-03-04T10:00:${String(n % 60).padStart(2, "0")}.000Z`,
    updatedAt: "2026-03-04T10:00:00.000Z",
    ...over,
  };
}

const q = (over: Partial<LogQuery> = {}): LogQuery => ({ ...DEFAULT_QUERY, ...over });
const run = (entries: LogEntry[], query: LogQuery) => filterEntries(entries, query, new Map(entries.map((e) => [e.id, searchHaystack(e)])));

describe("Log URL query", () => {
  it("round-trips every filter and the sort", () => {
    const query = q({ q: "bridge deck", year: "2025", log: "istructe", theme: "Self-directed study", type: "video", sort: "hours", dir: "asc" });
    expect(parseQuery(new URLSearchParams(serialiseQuery(query)))).toEqual(query);
  });

  it("leaves out empty filters and the default sort", () => {
    expect(serialiseQuery(DEFAULT_QUERY)).toBe("");
    expect(serialiseQuery(q({ q: "   " }))).toBe("");
    expect(serialiseQuery(q({ sort: "date", dir: "asc" }))).toBe("sort=date-asc");
  });

  it("ignores values it does not recognise", () => {
    const parsed = parseQuery(new URLSearchParams("year=20x5&log=other&type=podcast&sort=colour-up"));
    expect(parsed).toEqual(DEFAULT_QUERY);
  });

  it("counts the search words as one filter and not the sort", () => {
    expect(activeFilterCount(q({ q: "a b", sort: "title", dir: "asc" }))).toBe(1);
    expect(activeFilterCount(q({ q: "a", year: "2026", log: "ice", theme: "Water", type: "video" }))).toBe(5);
  });
});

describe("Log search and filters", () => {
  const list = [
    entry({ title: "Smart motorways", provider: "National Highways", theme: "Transport" }),
    entry({ title: "Flood resilience", notes: "Remember the ZEBRA crossing example", theme: "Water" }),
    entry({ title: "Retaining walls", profile: "istructe", category: "Self-directed study", developmentGained: "Checking surcharge loads" }),
    entry({ title: "Reflective practice", profile: "custom", custom: { mentor: "Sam Patel" }, sourceType: "video", dateCompleted: "2025-11-02" }),
    entry({ title: "Benefits one", benefits: { helped: "", future: "Use on the A14 scheme", nextYear: "" } }),
  ];

  it("matches title, provider, notes, development gained, benefits and custom values, ignoring case", () => {
    expect(run(list, q({ q: "MOTORWAYS" })).map((e) => e.title)).toEqual(["Smart motorways"]);
    expect(run(list, q({ q: "national highways" })).map((e) => e.title)).toEqual(["Smart motorways"]);
    expect(run(list, q({ q: "zebra" })).map((e) => e.title)).toEqual(["Flood resilience"]);
    expect(run(list, q({ q: "surcharge" })).map((e) => e.title)).toEqual(["Retaining walls"]);
    expect(run(list, q({ q: "a14" })).map((e) => e.title)).toEqual(["Benefits one"]);
    expect(run(list, q({ q: "patel" })).map((e) => e.title)).toEqual(["Reflective practice"]);
  });

  it("matches the theme or the category", () => {
    expect(run(list, q({ q: "self-directed" })).map((e) => e.title)).toEqual(["Retaining walls"]);
    expect(run(list, q({ q: "water" })).map((e) => e.title)).toEqual(["Flood resilience"]);
  });

  it("needs every word, in any order", () => {
    expect(run(list, q({ q: "walls retaining" }))).toHaveLength(1);
    expect(run(list, q({ q: "walls motorways" }))).toHaveLength(0);
  });

  it("filters by year, log, source type and theme together", () => {
    expect(run(list, q({ year: "2025" })).map((e) => e.title)).toEqual(["Reflective practice"]);
    expect(run(list, q({ log: "istructe" })).map((e) => e.title)).toEqual(["Retaining walls"]);
    expect(run(list, q({ type: "video" })).map((e) => e.title)).toEqual(["Reflective practice"]);
    expect(run(list, q({ theme: "Transport" })).map((e) => e.title)).toEqual(["Smart motorways"]);
    expect(run(list, q({ theme: "Self-directed study" })).map((e) => e.title)).toEqual(["Retaining walls"]);
    expect(run(list, q({ theme: NO_THEME })).map((e) => e.title)).toEqual(["Reflective practice", "Benefits one"]);
    expect(run(list, q({ log: "ice", theme: "Water", year: "2026" }))).toHaveLength(1);
    expect(run(list, q({ log: "ice", theme: "Water", year: "2025" }))).toHaveLength(0);
  });
});

describe("Log sorting", () => {
  it("sorts by date with newest first by default and breaks ties by when they were added", () => {
    const a = entry({ title: "a", dateCompleted: "2026-01-05" });
    const b = entry({ title: "b", dateCompleted: "2026-03-01" });
    const c = entry({ title: "c", dateCompleted: "2026-03-01", createdAt: "2026-04-01T00:00:00.000Z" });
    expect(sortEntries([a, b, c], "date", "desc").map((e) => e.title)).toEqual(["c", "b", "a"]);
    expect(sortEntries([a, b, c], "date", "asc").map((e) => e.title)).toEqual(["a", "b", "c"]);
  });

  it("sorts titles the way a person reads them", () => {
    const list = ["part 10", "Part 2", "apple", "Banana"].map((title) => entry({ title }));
    expect(sortEntries(list, "title", "asc").map((e) => e.title)).toEqual(["apple", "Banana", "Part 2", "part 10"]);
    expect(sortEntries(list, "title", "desc").map((e) => e.title)).toEqual(["part 10", "Part 2", "Banana", "apple"]);
  });

  it("sorts by hours", () => {
    const list = [0.5, 3, 1.25].map((hours) => entry({ hours }));
    expect(sortEntries(list, "hours", "desc").map((e) => e.hours)).toEqual([3, 1.25, 0.5]);
    expect(sortEntries(list, "hours", "asc").map((e) => e.hours)).toEqual([0.5, 1.25, 3]);
  });

  it("puts entries with no theme last, whichever way the column is sorted", () => {
    const list = [entry({ title: "none" }), entry({ title: "w", theme: "Water" }), entry({ title: "i", profile: "istructe", category: "Horizon broadening" })];
    expect(sortEntries(list, "theme", "asc").map((e) => e.title)).toEqual(["i", "w", "none"]);
    expect(sortEntries(list, "theme", "desc").map((e) => e.title)).toEqual(["w", "i", "none"]);
  });

  it("does not change the list it is given", () => {
    const list = [entry({ hours: 2 }), entry({ hours: 1 })];
    sortEntries(list, "hours", "asc");
    expect(list.map((e) => e.hours)).toEqual([2, 1]);
  });
});

describe("Log summary and choices", () => {
  it("adds hours without floating point noise", () => {
    expect(totalHours([{ hours: 0.1 }, { hours: 0.2 }, { hours: 0.25 }])).toBe(0.55);
    expect(totalHours([])).toBe(0);
  });

  it("offers years that have entries, newest first, and keeps one chosen in the URL", () => {
    const list = [entry({ dateCompleted: "2024-05-01" }), entry({ dateCompleted: "2026-05-01" }), entry({ dateCompleted: "2024-09-01" })];
    expect(yearChoices(list, "")).toEqual(["2026", "2024"]);
    expect(yearChoices(list, "2019")).toEqual(["2026", "2024", "2019"]);
  });

  it("lists themes from the profile config plus anything else already in the log", () => {
    const list = [entry({ theme: "Water" }), entry({ theme: "Imported theme" }), entry({ category: "Horizon broadening" })];
    const choices = themeChoices(list, "From the link");
    expect(choices.ice).toContain("Safety and risk management");
    expect(choices.istructe).toContain("Horizon broadening");
    expect(choices.other).toEqual(["From the link", "Imported theme"]);
  });
});

describe("Log links", () => {
  it("only makes web links clickable", () => {
    expect(safeHref("https://example.com/a")).toBe("https://example.com/a");
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref("not a url")).toBeNull();
    expect(safeHref(null)).toBeNull();
  });
});
