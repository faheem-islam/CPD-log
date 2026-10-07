import { describe, expect, it } from "vitest";
import { buildWorkbook } from "@/lib/export/workbook";
import { parseSpreadsheet } from "@/lib/import/parse";
import { commitRows } from "@/lib/import/revalidate";
import type { Entry, ProfileId, UserSettings } from "@/lib/types";
import { makeEntry, makeSettings, NOW } from "./export-test-helpers";
import { makeCtx } from "./import-test-helpers";

const settings: UserSettings = makeSettings({
  customFields: [
    { key: "cert", label: "Certificate number", type: "text" },
    { key: "cost", label: "Cost", type: "number" },
    { key: "renew", label: "Renewal date", type: "date" },
    { key: "paid", label: "Paid by employer", type: "yes_no" },
  ],
});

async function roundTrip(entries: Entry[], profile: ProfileId, profiles: ProfileId[] = [profile]) {
  const buf = await buildWorkbook({ entries, settings, profiles, year: "all", now: NOW });
  return parseSpreadsheet(buf, "export.xlsx", makeCtx({ profile, settings }));
}

describe("our own export imports back", () => {
  it("round-trips ICE entries, including ranges, benefits and the details cell", async () => {
    const entries = [
      makeEntry({
        title: "Test activity one",
        provider: "Test provider",
        url: "https://example.test/one",
        theme: "Safety and risk management",
        dateCompleted: "2026-03-04",
        dateEnd: "2026-03-06",
        hours: 6.5,
        devPlanRef: "DP-1",
        learningPoints: "Learned how to check a drainage design.\nSecond line.",
        benefits: { helped: "It helped me.", future: "I will use it.", nextYear: "" },
      }),
      makeEntry({
        title: "Test activity two",
        theme: "Water",
        dateCompleted: "2026-01-15",
        hours: 0.25,
        learningPoints: "Learned how to read a flood map properly.",
        benefits: { helped: "A single unlabelled answer.", future: "", nextYear: "" },
      }),
    ];
    const r = await roundTrip(entries, "ice", ["ice", "istructe", "custom"]);
    expect(r.fileKind).toBe("xlsx");
    expect(r.headerRow).toBe(4);
    expect(r.warnings.some((w) => /Only the sheet "ICE CPD log" was read/.test(w))).toBe(true);
    expect(r.rows).toHaveLength(2);
    // sorted by date: the January entry first
    const [jan, mar] = r.rows;
    expect(jan?.input).toMatchObject({
      title: "Test activity two",
      theme: "Water",
      dateCompleted: "2026-01-15",
      dateEnd: null,
      hours: 0.25,
      devPlanRef: "unplanned",
      provider: null,
      url: null,
      benefits: { helped: "A single unlabelled answer.", future: "", nextYear: "" },
    });
    expect(mar?.input).toMatchObject({
      title: "Test activity one",
      provider: "Test provider",
      url: "https://example.test/one",
      theme: "Safety and risk management",
      dateCompleted: "2026-03-04",
      dateEnd: "2026-03-06",
      hours: 6.5,
      devPlanRef: "DP-1",
      learningPoints: "Learned how to check a drainage design.\nSecond line.",
      benefits: { helped: "It helped me.", future: "I will use it.", nextYear: "" },
    });
    expect(r.rows.every((x) => x.include && !x.issues.some((i) => i.severity === "error"))).toBe(true);
    expect(r.rows.every((x) => x.input.confidence.theme?.level === "high")).toBe(true);
  });

  it("flags every entry as a duplicate when you import your own export back into the same account", async () => {
    const entries = [makeEntry({ title: "Test activity one", theme: "Water", learningPoints: "Learned how to read a flood map properly." })];
    const buf = await buildWorkbook({ entries, settings, profiles: ["ice"], year: "all", now: NOW });
    const r = await parseSpreadsheet(buf, "export.xlsx", makeCtx({ existing: [{ dateCompleted: "2026-03-04", title: "Test activity one" }] }));
    expect(r.rows[0]?.duplicate).toBe(true);
    expect(r.rows[0]?.include).toBe(false);
    expect(commitRows(r.rows)).toEqual([]);
  });

  it("round-trips IStructE entries", async () => {
    const entries = [
      makeEntry({
        profile: "istructe",
        title: "Test IStructE one",
        category: "Courses, events and seminars",
        dateCompleted: "2026-02-10",
        hours: 3,
        structuralSafety: true,
        sustainability: false,
        developmentGained: "Learned how to check a steel connection detail.",
      }),
      makeEntry({ profile: "istructe", title: "Test unanswered", dateCompleted: "2026-02-11", hours: 1, category: "Self-directed study", structuralSafety: null, sustainability: null }),
    ];
    const r = await roundTrip(entries, "istructe", ["ice", "istructe"]);
    expect(r.headerRow).toBe(3);
    expect(r.rows.map((x) => x.input)).toMatchObject([
      { title: "Test IStructE one", category: "Courses, events and seminars", dateCompleted: "2026-02-10", hours: 3, structuralSafety: true, sustainability: false, developmentGained: "Learned how to check a steel connection detail." },
      { title: "Test unanswered", category: "Self-directed study", structuralSafety: null, sustainability: null, hours: 1 },
    ]);
    // the provisional note above the header is not read as a row
    expect(r.rows.some((x) => /PROVISIONAL/.test(x.input.title))).toBe(false);
  });

  it("round-trips Custom entries with the user's own labels and typed values", async () => {
    const entries = [
      makeEntry({
        profile: "custom",
        title: "Test custom",
        dateCompleted: "2026-06-06",
        hours: 3.5,
        custom: { cert: "C-9", cost: "10.5", renew: "2027-02-03", paid: "yes" },
      }),
    ];
    const r = await roundTrip(entries, "custom");
    expect(r.rows[0]?.input).toMatchObject({
      profile: "custom",
      title: "Test custom",
      hours: 3.5,
      dateCompleted: "2026-06-06",
      custom: { cert: "C-9", cost: "10.5", renew: "2027-02-03", paid: "yes" },
    });
    expect(r.warnings).toEqual(expect.not.arrayContaining([expect.stringMatching(/No column matched/)]));
  });

  it("round-trips text that starts with = + - @ exactly, because the importer takes the export's quote off again", async () => {
    const nasty = ['=HYPERLINK("http://example.test","x")', "+44 test briefing", "-5 degrees of freedom", "@mention test", "'=already has a quote"];
    const entries = nasty.map((t, i) =>
      makeEntry({ title: t, learningPoints: t, theme: "Energy", dateCompleted: `2026-03-0${i + 1}`, benefits: { helped: t, future: "", nextYear: "" } }),
    );
    const r = await roundTrip(entries, "ice");
    expect(r.rows.map((x) => x.input.title)).toEqual(nasty);
    expect(r.rows.map((x) => x.input.learningPoints)).toEqual(nasty);
    expect(r.rows.map((x) => x.input.benefits.helped)).toEqual(nasty);
  });

  it("round-trips an empty ICE sheet into a clear message, not a crash", async () => {
    const buf = await buildWorkbook({ entries: [], settings, profiles: ["ice"], year: "all", now: NOW });
    await expect(parseSpreadsheet(buf, "empty.xlsx", makeCtx())).rejects.toMatchObject({ code: "no_rows" });
  });

  it("does not read the ICE header block or the Summary sheet as entries", async () => {
    const entries = [makeEntry({ title: "Only entry", theme: "Water", learningPoints: "Learned how to read a flood map properly." })];
    const r = await roundTrip(entries, "ice", ["ice"]);
    expect(r.rows.map((x) => x.input.title)).toEqual(["Only entry"]);
  });

  it("can import an IStructE-sheet export as ICE rows, leaving out the columns that do not belong", async () => {
    const entries = [makeEntry({ profile: "istructe", title: "Test IStructE", category: "Work-based learning", hours: 2, developmentGained: "Learned how to check a steel connection detail." })];
    const buf = await buildWorkbook({ entries, settings, profiles: ["istructe"], year: "all", now: NOW });
    const r = await parseSpreadsheet(buf, "x.xlsx", makeCtx({ profile: "ice" }));
    expect(r.rows[0]?.input).toMatchObject({ profile: "ice", title: "Test IStructE", hours: 2, category: null, developmentGained: "" });
    expect(r.warnings.some((w) => /different profile than ICE/.test(w))).toBe(true);
  });
});
