import type ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { PROFILES } from "@/lib/profiles";
import { previewExport } from "@/lib/export/preview";
import { HEADER_ROW, buildWorkbook } from "@/lib/export/workbook";
import type { Entry, ProfileId } from "@/lib/types";
import { makeEntry, makeSettings, NOW, readBack, rowStrings, tableRows } from "./export-test-helpers";

const settings = makeSettings({
  customFields: [
    { key: "cert", label: "Certificate number", type: "text" },
    { key: "cost", label: "Cost", type: "number" },
    { key: "when", label: "Renewal date", type: "date" },
    { key: "paid", label: "Paid", type: "yes_no" },
  ],
});

const entries: Entry[] = [
  makeEntry({
    title: "Test ICE one",
    provider: "Test provider",
    url: "https://example.test/one",
    theme: "Water",
    dateCompleted: "2026-03-04",
    dateEnd: "2026-03-05",
    hours: 2.25,
    devPlanRef: "DP-7",
    learningPoints: "Line one\nLine two",
    benefits: { helped: "A.", future: "B.", nextYear: "C." },
  }),
  makeEntry({ title: "Test ICE two", dateCompleted: "2026-01-09", hours: 0.5 }),
  makeEntry({ title: "=Test formula", dateCompleted: "2026-01-09", hours: 1 }),
  makeEntry({
    profile: "istructe",
    title: "Test IStructE",
    category: "Work-based learning",
    dateCompleted: "2026-02-02",
    hours: 6,
    structuralSafety: true,
    sustainability: null,
    developmentGained: "Learned something.",
  }),
  makeEntry({
    profile: "custom",
    title: "Test custom",
    dateCompleted: "2026-06-06",
    hours: 3.5,
    custom: { cert: "C-9", cost: "10", when: "2027-02-03", paid: "yes" },
  }),
  makeEntry({ title: "Test deleted", deletedAt: "2026-03-01T00:00:00.000Z" }),
];

const HEADER_COLUMNS: Record<ProfileId, number> = { ice: 7, istructe: 7, custom: 7 };

describe("previewExport", () => {
  it("equals the rows in the workbook for every profile", async () => {
    const profiles: ProfileId[] = ["ice", "istructe", "custom"];
    const previews = previewExport({ entries, settings, profiles, year: "all" });
    const wb = await readBack(await buildWorkbook({ entries, settings, profiles, year: "all", now: NOW }));
    expect(previews.map((p) => p.profile)).toEqual(profiles);
    for (const p of previews) {
      const ws = wb.getWorksheet(PROFILES[p.profile].sheetName) as ExcelJS.Worksheet;
      expect(ws).toBeDefined();
      const header = HEADER_ROW[p.profile];
      expect(rowStrings(ws, header, p.columns.length)).toEqual(p.columns.map((c) => c.label));
      expect(tableRows(ws, header, HEADER_COLUMNS[p.profile])).toEqual(p.rows);
      expect(p.count).toBe(p.rows.length);
    }
  });

  it("equals the workbook when a year is chosen", async () => {
    const previews = previewExport({ entries, settings, profiles: ["ice"], year: 2026 });
    const wb = await readBack(await buildWorkbook({ entries, settings, profiles: ["ice"], year: 2026, now: NOW }));
    const ws = wb.getWorksheet("ICE CPD log") as ExcelJS.Worksheet;
    expect(tableRows(ws, 4, 7)).toEqual(previews[0]?.rows);
    expect(previewExport({ entries, settings, profiles: ["ice"], year: 2030 })[0]?.rows).toEqual([]);
  });

  it("shows dates as dd/mm/yyyy, hours with two decimals and in the same order as the file", () => {
    const [ice] = previewExport({ entries, settings, profiles: ["ice"], year: "all" });
    expect(ice?.rows.map((r) => r[2])).toEqual(["09/01/2026", "09/01/2026", "04/03/2026 - 05/03/2026"]);
    // Same day: sorted by title, so the entry that starts with = comes first.
    expect(ice?.rows.map((r) => r[3])).toEqual(["1.00", "0.50", "2.25"]);
    expect(ice?.rows.map((r) => r[0]?.split("\n")[0])).toEqual(["'=Test formula", "Test ICE two", "Test ICE one"]);
  });

  it("reports the total hours and count of what is shown, not of deleted entries", () => {
    const [ice, ist, custom] = previewExport({ entries, settings, profiles: ["ice", "istructe", "custom"], year: "all" });
    expect(ice).toMatchObject({ count: 3, totalHours: 3.75 });
    expect(ist).toMatchObject({ count: 1, totalHours: 6 });
    expect(custom).toMatchObject({ count: 1, totalHours: 3.5 });
  });

  it("carries the ICE header block and the IStructE provisional note", () => {
    const [ice, ist, custom] = previewExport({ entries, settings, profiles: ["ice", "istructe", "custom"], year: "all" });
    expect(ice?.headerBlock?.map((b) => b.label)).toEqual(["Name", "Job role and responsibilities", "Engineering sector"]);
    expect(ice?.headerBlock?.[0]?.value).toBe("Test Person");
    expect(ist?.note).toBe(PROFILES.istructe.provisionalNote);
    expect(ice?.note).toBeUndefined();
    expect(custom?.headerBlock).toBeUndefined();
    expect(custom?.note).toBeUndefined();
  });

  it("gives the user's own custom labels as the column labels", () => {
    const [custom] = previewExport({ entries, settings, profiles: ["custom"], year: "all" });
    expect(custom?.columns.map((c) => c.label)).toEqual(["Date", "Activity", "Hours", "Certificate number", "Cost", "Renewal date", "Paid"]);
    expect(custom?.rows[0]).toEqual(["06/06/2026", "Test custom", "3.50", "C-9", "10", "03/02/2027", "Y"]);
  });

  it("returns no row for a profile with no entries, with its columns", () => {
    const [ist] = previewExport({ entries: [], settings, profiles: ["istructe"], year: "all" });
    expect(ist?.rows).toEqual([]);
    expect(ist?.count).toBe(0);
    expect(ist?.totalHours).toBe(0);
    expect(ist?.columns).toHaveLength(7);
  });

  it("lists each profile once", () => {
    expect(previewExport({ entries, settings, profiles: ["ice", "ice"], year: "all" })).toHaveLength(1);
  });

  it("is plain data that survives JSON", () => {
    const previews = previewExport({ entries, settings, profiles: ["ice", "istructe", "custom"], year: "all" });
    expect(JSON.parse(JSON.stringify(previews))).toEqual(previews);
  });
});
