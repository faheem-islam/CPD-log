import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { PROFILES } from "@/lib/profiles";
import { HEADER_ROW, buildWorkbook, columnLetter, exportFilename, safeSheetName } from "@/lib/export/workbook";
import { makeEntry, makeSettings, NOW, readBack, rowStrings, sheetNames, tableRows } from "./export-test-helpers";
import type { Entry, ProfileId } from "@/lib/types";

const settings = makeSettings({
  name: "Test Person",
  jobRole: "Test job role",
  responsibilities: "Test responsibilities",
  sector: "Test sector",
});

async function build(entries: Entry[], profiles: ProfileId[], year: number | "all" = "all", s = settings) {
  return readBack(await buildWorkbook({ entries, settings: s, profiles, year, now: NOW }));
}

const ICE_HEADER = [
  "Details of CPD activity",
  "ICE CPD Framework theme",
  "Dates",
  "Effective learning time",
  "Dev. Plan ref",
  "Key Learning Points",
  "Key Benefits/Value added",
];

describe("ICE sheet", () => {
  const entries = [
    makeEntry({
      title: "Test title B",
      provider: "Test provider",
      url: "https://example.test/b",
      theme: "Safety and risk management",
      dateCompleted: "2026-05-12",
      hours: 2.5,
      devPlanRef: "DP-1",
      learningPoints: "Learned about a test thing.",
      benefits: { helped: "Helped me.", future: "", nextYear: "" },
    }),
    makeEntry({
      title: "Test title A",
      theme: "Energy",
      dateCompleted: "2026-03-04",
      hours: 1,
      learningPoints: "More learning.",
      benefits: { helped: "One.", future: "Two.", nextYear: "Three." },
    }),
  ];

  it("has the header block on rows 1 and 2, an empty row 3, and the table header on row 4", async () => {
    const wb = await build(entries, ["ice"]);
    const ws = wb.getWorksheet(PROFILES.ice.sheetName);
    expect(ws).toBeDefined();
    if (!ws) return;
    expect(rowStrings(ws, 1, 3)).toEqual(["Name", "Job role and responsibilities", "Engineering sector"]);
    expect(rowStrings(ws, 2, 3)).toEqual(["Test Person", "Test job role\nTest responsibilities", "Test sector"]);
    expect(rowStrings(ws, 3, 7)).toEqual(["", "", "", "", "", "", ""]);
    expect(rowStrings(ws, HEADER_ROW.ice, 7)).toEqual(ICE_HEADER);
    expect(HEADER_ROW.ice).toBe(4);
  });

  it("starts the data on row 5, sorted by date then title", async () => {
    const wb = await build(entries, ["ice"]);
    const ws = wb.getWorksheet(PROFILES.ice.sheetName);
    if (!ws) throw new Error("no sheet");
    expect(ws.getCell("A5").value).toBe("Test title A");
    expect(ws.getCell("A6").value).toBe("Test title B\nProvider: Test provider\nhttps://example.test/b");
    expect(ws.getCell("B5").value).toBe("Energy");
    expect(ws.getCell("E5").value).toBe("unplanned");
    expect(ws.getCell("E6").value).toBe("DP-1");
  });

  it("freezes the panes below the table header (ySplit 4)", async () => {
    const wb = await build(entries, ["ice"]);
    const ws = wb.getWorksheet(PROFILES.ice.sheetName);
    const view = ws?.views[0];
    expect(view?.state).toBe("frozen");
    expect(view && "ySplit" in view ? view.ySplit : undefined).toBe(4);
    expect(view && "xSplit" in view ? view.xSplit : undefined).toBe(0);
  });

  it("has an autofilter over the table header and its data", async () => {
    const wb = await build(entries, ["ice"]);
    const ws = wb.getWorksheet(PROFILES.ice.sheetName);
    expect(ws?.autoFilter).toBe("A4:G6");
  });

  it("writes real date cells at UTC midnight with the dd/mm/yyyy format", async () => {
    const wb = await build(entries, ["ice"]);
    const ws = wb.getWorksheet(PROFILES.ice.sheetName);
    if (!ws) throw new Error("no sheet");
    const c = ws.getCell("C5");
    expect(c.value).toBeInstanceOf(Date);
    expect(c.numFmt).toBe("dd/mm/yyyy");
    const d = c.value as Date;
    expect(d.toISOString()).toBe("2026-03-04T00:00:00.000Z");
    expect((ws.getCell("C6").value as Date).toISOString()).toBe("2026-05-12T00:00:00.000Z");
    expect(c.type).toBe(ExcelJS.ValueType.Date);
  });

  it("writes hours as numbers with the 0.00 format", async () => {
    const wb = await build(entries, ["ice"]);
    const ws = wb.getWorksheet(PROFILES.ice.sheetName);
    if (!ws) throw new Error("no sheet");
    expect(typeof ws.getCell("D5").value).toBe("number");
    expect(ws.getCell("D5").value).toBe(1);
    expect(ws.getCell("D6").value).toBe(2.5);
    expect(ws.getCell("D5").numFmt).toBe("0.00");
    expect(ws.getCell("D5").type).toBe(ExcelJS.ValueType.Number);
  });

  it("writes one benefit answer unlabelled and several as labelled lines", async () => {
    const wb = await build(entries, ["ice"]);
    const ws = wb.getWorksheet(PROFILES.ice.sheetName);
    if (!ws) throw new Error("no sheet");
    expect(ws.getCell("G6").value).toBe("Helped me.");
    expect(ws.getCell("G5").value).toBe(
      "How it helped: One.\nHow I will use it in future: Two.\nHow it will influence next year's plan: Three.",
    );
  });

  it("uses the column widths from the config, wraps long text, and aligns to the top", async () => {
    const wb = await build(entries, ["ice"]);
    const ws = wb.getWorksheet(PROFILES.ice.sheetName);
    if (!ws) throw new Error("no sheet");
    PROFILES.ice.columns.forEach((c, i) => expect(ws.getColumn(i + 1).width).toBe(c.width));
    expect(ws.getCell("A5").alignment?.wrapText).toBe(true);
    expect(ws.getCell("F5").alignment?.wrapText).toBe(true);
    expect(ws.getCell("G5").alignment?.wrapText).toBe(true);
    expect(ws.getCell("D5").alignment?.wrapText).toBeFalsy();
    for (const a of ["A5", "B5", "C5", "D5", "G5"]) expect(ws.getCell(a).alignment?.vertical).toBe("top");
  });

  it("styles the header row bold with a fill", async () => {
    const wb = await build(entries, ["ice"]);
    const ws = wb.getWorksheet(PROFILES.ice.sheetName);
    if (!ws) throw new Error("no sheet");
    for (let c = 1; c <= 7; c++) {
      const cell = ws.getCell(4, c);
      expect(cell.font?.bold).toBe(true);
      expect(cell.fill?.type).toBe("pattern");
    }
    expect(ws.getCell("A1").font?.bold).toBe(true);
  });

  it("shows a date range as text so the last day is not lost", async () => {
    const wb = await build([makeEntry({ dateCompleted: "2026-03-04", dateEnd: "2026-03-06" })], ["ice"]);
    const ws = wb.getWorksheet(PROFILES.ice.sheetName);
    expect(ws?.getCell("C5").value).toBe("04/03/2026 - 06/03/2026");
  });

  it("still makes a sheet with the header when there are no entries", async () => {
    const wb = await build([], ["ice"]);
    const ws = wb.getWorksheet(PROFILES.ice.sheetName);
    expect(ws).toBeDefined();
    expect(rowStrings(ws as ExcelJS.Worksheet, 4, 7)).toEqual(ICE_HEADER);
    expect(tableRows(ws as ExcelJS.Worksheet, 4, 7)).toEqual([]);
    expect((ws as ExcelJS.Worksheet).autoFilter).toBe("A4:G5");
    expect((ws as ExcelJS.Worksheet).views[0]).toMatchObject({ state: "frozen", ySplit: 4 });
  });

  it("leaves the header block values blank when settings are empty, without inventing any", async () => {
    const wb = await build([], ["ice"], "all", makeSettings({ name: "", jobRole: "", responsibilities: "", sector: "" }));
    const ws = wb.getWorksheet(PROFILES.ice.sheetName);
    expect(rowStrings(ws as ExcelJS.Worksheet, 2, 3)).toEqual(["", "", ""]);
  });
});

describe("IStructE sheet", () => {
  const entries = [
    makeEntry({
      profile: "istructe",
      title: "Test IStructE activity",
      category: "Courses, events and seminars",
      dateCompleted: "2026-02-10",
      hours: 3,
      structuralSafety: true,
      sustainability: false,
      developmentGained: "Learned a test thing.",
    }),
    makeEntry({ profile: "istructe", title: "Test unanswered", dateCompleted: "2026-02-11", hours: 1, structuralSafety: null, sustainability: null }),
  ];

  it("carries the provisional note in a merged cell above the table header", async () => {
    const wb = await build(entries, ["istructe"]);
    const ws = wb.getWorksheet(PROFILES.istructe.sheetName);
    if (!ws) throw new Error("no sheet");
    expect(ws.getCell("A1").value).toBe(PROFILES.istructe.provisionalNote);
    expect(ws.getCell("A1").value).toMatch(/^PROVISIONAL/);
    // The note is merged across the table: every cell of row 1 reports the same text.
    expect(ws.getCell("G1").value).toBe(PROFILES.istructe.provisionalNote);
    expect(ws.getCell("A1").isMerged).toBe(true);
    expect(rowStrings(ws, HEADER_ROW.istructe, 7)).toEqual([
      "Date",
      "Activity title",
      "Category",
      "Hours",
      "Structural safety (Y/N)",
      "Sustainability (Y/N)",
      "Development gained",
    ]);
    expect(HEADER_ROW.istructe).toBe(3);
  });

  it("freezes below the table header and filters it", async () => {
    const wb = await build(entries, ["istructe"]);
    const ws = wb.getWorksheet(PROFILES.istructe.sheetName);
    expect(ws?.views[0]).toMatchObject({ state: "frozen", ySplit: 3 });
    expect(ws?.autoFilter).toBe("A3:G5");
  });

  it("writes Y and N as text, a blank for unanswered, real dates and numeric hours", async () => {
    const wb = await build(entries, ["istructe"]);
    const ws = wb.getWorksheet(PROFILES.istructe.sheetName);
    if (!ws) throw new Error("no sheet");
    expect(ws.getCell("A4").value).toBeInstanceOf(Date);
    expect(ws.getCell("A4").numFmt).toBe("dd/mm/yyyy");
    expect(ws.getCell("D4").value).toBe(3);
    expect(typeof ws.getCell("D4").value).toBe("number");
    expect(ws.getCell("E4").value).toBe("Y");
    expect(ws.getCell("F4").value).toBe("N");
    expect(ws.getCell("E4").type).toBe(ExcelJS.ValueType.String);
    expect(ws.getCell("E5").value).toBeNull();
    expect(ws.getCell("F5").value).toBeNull();
  });

  it("has a sheet name that Excel accepts", async () => {
    const wb = await build([], ["istructe"]);
    expect(sheetNames(wb)[0]).toBe("IStructE CPD log (provisional)");
    expect(sheetNames(wb)[0]?.length).toBeLessThanOrEqual(31);
  });
});

describe("Custom sheet", () => {
  const s = makeSettings({
    customFields: [
      { key: "cert", label: "Certificate number", type: "text" },
      { key: "cost", label: "Cost in pounds", type: "number" },
      { key: "renew", label: "Renewal date", type: "date" },
      { key: "paid", label: "Paid by employer", type: "yes_no" },
    ],
  });

  it("uses the user's own labels after Date, Activity and Hours", async () => {
    const wb = await build([], ["custom"], "all", s);
    const ws = wb.getWorksheet(PROFILES.custom.sheetName);
    if (!ws) throw new Error("no sheet");
    expect(rowStrings(ws, 1, 7)).toEqual(["Date", "Activity", "Hours", "Certificate number", "Cost in pounds", "Renewal date", "Paid by employer"]);
    expect(ws.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
  });

  it("writes typed custom values", async () => {
    const e = makeEntry({
      profile: "custom",
      title: "Test custom",
      custom: { cert: "C-100", cost: "25.5", renew: "2027-01-31", paid: "no" },
    });
    const wb = await build([e], ["custom"], "all", s);
    const ws = wb.getWorksheet(PROFILES.custom.sheetName);
    if (!ws) throw new Error("no sheet");
    expect(ws.getCell("D2").value).toBe("C-100");
    expect(ws.getCell("E2").value).toBe(25.5);
    expect(ws.getCell("F2").value).toBeInstanceOf(Date);
    expect(ws.getCell("F2").numFmt).toBe("dd/mm/yyyy");
    expect(ws.getCell("G2").value).toBe("N");
  });
});

describe("what goes in", () => {
  it("never includes deleted entries", async () => {
    const live = makeEntry({ title: "Test live" });
    const gone = makeEntry({ title: "Test deleted", deletedAt: "2026-04-01T00:00:00.000Z" });
    const wb = await build([live, gone], ["ice"]);
    const ws = wb.getWorksheet(PROFILES.ice.sheetName);
    const text = tableRows(ws as ExcelJS.Worksheet, 4, 7).flat().join("|");
    expect(text).toContain("Test live");
    expect(text).not.toContain("Test deleted");
    const summary = wb.getWorksheet("Summary");
    let total = 0;
    summary?.eachRow((row) => {
      if (row.getCell(1).value === "Total") total += 1;
    });
    expect(total).toBeGreaterThan(0);
  });

  it("filters to one year", async () => {
    const e25 = makeEntry({ title: "Test 2025", dateCompleted: "2025-11-20", hours: 2 });
    const e26 = makeEntry({ title: "Test 2026", dateCompleted: "2026-01-02", hours: 3 });
    const wb = await build([e25, e26], ["ice"], 2026);
    const rows = tableRows(wb.getWorksheet(PROFILES.ice.sheetName) as ExcelJS.Worksheet, 4, 7);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.[0]).toBe("Test 2026");
    expect(findRow(wb.getWorksheet("Summary"), "Entries from 2026. Deleted entries are not included.")).toBeGreaterThan(0);
  });

  it("puts each entry on its own profile's sheet only", async () => {
    const ice = makeEntry({ title: "Test ICE" });
    const ist = makeEntry({ profile: "istructe", title: "Test IStructE" });
    const wb = await build([ice, ist], ["ice", "istructe"]);
    expect(sheetNames(wb)).toEqual(["ICE CPD log", "IStructE CPD log (provisional)", "Summary"]);
    expect(tableRows(wb.getWorksheet("ICE CPD log") as ExcelJS.Worksheet, 4, 7).map((r) => r[0])).toEqual(["Test ICE"]);
    expect(tableRows(wb.getWorksheet("IStructE CPD log (provisional)") as ExcelJS.Worksheet, 3, 7).map((r) => r[1])).toEqual(["Test IStructE"]);
  });

  it("makes one sheet per requested profile, in the order asked, once each", async () => {
    const wb = await build([], ["custom", "ice", "custom"]);
    expect(sheetNames(wb)).toEqual(["Custom CPD log", "ICE CPD log", "Summary"]);
  });

  it("makes a sheet for every profile even when all are empty", async () => {
    const wb = await build([], ["ice", "istructe", "custom"]);
    expect(sheetNames(wb)).toEqual(["ICE CPD log", "IStructE CPD log (provisional)", "Custom CPD log", "Summary"]);
  });

  it("refuses an empty profile list, an unknown profile and a bad year with a plain message", async () => {
    await expect(buildWorkbook({ entries: [], settings, profiles: [], year: "all", now: NOW })).rejects.toThrow(/at least one profile/);
    await expect(buildWorkbook({ entries: [], settings, profiles: ["nope" as ProfileId], year: "all", now: NOW })).rejects.toThrow(/not recognised/);
    await expect(buildWorkbook({ entries: [], settings, profiles: ["ice"], year: 20.5, now: NOW })).rejects.toThrow(/Choose a year/);
    await expect(buildWorkbook({ entries: [], settings, profiles: ["ice"], year: Number.NaN, now: NOW })).rejects.toThrow(/Choose a year/);
  });
});

describe("formula injection", () => {
  const nasty = [
    '=HYPERLINK("http://example.test","click")',
    "+1+1",
    "-2+3",
    "@SUM(1,1)",
    "=cmd|' /C calc'!A0",
    "\t=1+1",
  ];

  it("writes strings that start with = + - @ as plain string cells with a leading quote", async () => {
    const entries = nasty.map((t, i) =>
      makeEntry({
        profile: "istructe",
        title: t,
        developmentGained: t,
        dateCompleted: `2026-03-${String(i + 1).padStart(2, "0")}`,
      }),
    );
    const wb = await build(entries, ["istructe"]);
    const ws = wb.getWorksheet(PROFILES.istructe.sheetName);
    if (!ws) throw new Error("no sheet");
    nasty.forEach((t, i) => {
      const cell = ws.getCell(4 + i, 2);
      expect(cell.type).toBe(ExcelJS.ValueType.String);
      expect(cell.formula).toBeUndefined();
      expect(cell.value).toBe(`'${t.trim()}`);
      const notes = ws.getCell(4 + i, 7);
      expect(notes.type).toBe(ExcelJS.ValueType.String);
      expect((notes.value as string).startsWith("'")).toBe(true);
    });
  });

  it("neutralises the ICE details cell, header block, custom labels and custom values", async () => {
    const s = makeSettings({
      name: "=1+1",
      jobRole: "@role",
      sector: "-sector",
      customFields: [{ key: "x", label: "=label", type: "text" }],
    });
    const wb = await build(
      [
        makeEntry({ title: "=SUM(A1)", learningPoints: "-bullet" }),
        makeEntry({ profile: "custom", title: "Plain", custom: { x: "+cmd" } }),
      ],
      ["ice", "custom"],
      "all",
      s,
    );
    const ice = wb.getWorksheet("ICE CPD log");
    expect(ice?.getCell("A2").value).toBe("'=1+1");
    expect(ice?.getCell("B2").type).toBe(ExcelJS.ValueType.String);
    expect(ice?.getCell("C2").value).toBe("'-sector");
    expect(ice?.getCell("A5").value).toBe("'=SUM(A1)");
    expect(ice?.getCell("F5").value).toBe("'-bullet");
    const custom = wb.getWorksheet("Custom CPD log");
    expect(custom?.getCell("D1").value).toBe("'=label");
    expect(custom?.getCell("D2").value).toBe("'+cmd");
  });

  it("does not touch text that only contains those characters later on", async () => {
    const wb = await build([makeEntry({ title: "Safe = text + more - stuff @ end" })], ["ice"]);
    expect(wb.getWorksheet("ICE CPD log")?.getCell("A5").value).toBe("Safe = text + more - stuff @ end");
  });

  it("never leaves a formula cell anywhere in the workbook", async () => {
    const wb = await build(
      nasty.map((t, i) => makeEntry({ title: t, learningPoints: t, theme: t, dateCompleted: `2026-04-0${i + 1}` })),
      ["ice", "istructe", "custom"],
    );
    wb.eachSheet((ws) => {
      ws.eachRow((row) => {
        row.eachCell((cell) => {
          expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
        });
      });
    });
  });
});

describe("cell limits and bad characters", () => {
  it("shortens a cell over the Excel limit and says so on the Summary sheet", async () => {
    const wb = await build([makeEntry({ learningPoints: "x".repeat(40000) })], ["ice"]);
    const v = wb.getWorksheet("ICE CPD log")?.getCell("F5").value as string;
    expect(v.length).toBeLessThanOrEqual(32767);
    expect(v.endsWith("…")).toBe(true);
    const lines = aboutLines(wb);
    expect(lines.some((l) => /shortened to fit Excel/.test(l))).toBe(true);
  });

  it("strips characters that would corrupt the file", async () => {
    const wb = await build([makeEntry({ title: "Bad\u0000 \u0008char\uD800s" })], ["ice"]);
    expect(wb.getWorksheet("ICE CPD log")?.getCell("A5").value).toBe("Bad chars");
  });

  it("keeps accents, quotes, ampersands and angle brackets", async () => {
    const t = `Café "quoted" & <tag> 'single' – dash`;
    const wb = await build([makeEntry({ title: t })], ["ice"]);
    expect(wb.getWorksheet("ICE CPD log")?.getCell("A5").value).toBe(t);
  });
});

describe("Summary sheet", () => {
  const entries = [
    makeEntry({ title: "I1", dateCompleted: "2025-06-01", hours: 2, theme: "Energy" }),
    makeEntry({ title: "I2", dateCompleted: "2026-02-01", hours: 1.5, theme: "Safety and risk management" }),
    makeEntry({ title: "I3", dateCompleted: "2026-03-01", hours: 0.25, theme: "Safety and risk management", hoursConfirmed: false }),
    makeEntry({ title: "I4", dateCompleted: "2026-04-01", hours: 1, theme: "Made-up theme" }),
    makeEntry({ title: "I5", dateCompleted: "2026-05-01", hours: 1, theme: null }),
    makeEntry({ profile: "istructe", title: "S1", dateCompleted: "2026-02-02", hours: 4, category: "Self-directed study", structuralSafety: true, sustainability: true }),
    makeEntry({ profile: "istructe", title: "S2", dateCompleted: "2026-02-03", hours: 2, category: "Horizon broadening", structuralSafety: false, sustainability: true }),
    makeEntry({ profile: "custom", title: "C1", dateCompleted: "2025-01-02", hours: 5 }),
    makeEntry({ title: "Gone", dateCompleted: "2026-02-04", hours: 99, theme: "Energy", deletedAt: "2026-02-05T00:00:00.000Z" }),
  ];

  it("is the last sheet", async () => {
    const wb = await build(entries, ["ice", "istructe", "custom"]);
    expect(sheetNames(wb).at(-1)).toBe("Summary");
  });

  it("totals hours by year as real numbers, one column per profile", async () => {
    const wb = await build(entries, ["ice", "istructe", "custom"]);
    const ws = wb.getWorksheet("Summary");
    if (!ws) throw new Error("no summary");
    const header = findRow(ws, "Hours by year");
    expect(header).toBeGreaterThan(0);
    expect(rowStrings(ws, header + 1, 4)).toEqual(["Year", "ICE", "IStructE", "Custom"]);
    const y2025 = ws.getRow(header + 2);
    const y2026 = ws.getRow(header + 3);
    expect(y2025.getCell(1).value).toBe(2025);
    expect(typeof y2025.getCell(1).value).toBe("number");
    expect(y2025.getCell(2).value).toBe(2);
    expect(y2025.getCell(3).value).toBe(0);
    expect(y2025.getCell(4).value).toBe(5);
    expect(y2026.getCell(1).value).toBe(2026);
    expect(y2026.getCell(2).value).toBe(3.75);
    expect(y2026.getCell(3).value).toBe(6);
    expect(y2026.getCell(4).value).toBe(0);
    const total = ws.getRow(header + 4);
    expect(total.getCell(1).value).toBe("Total");
    expect(total.getCell(2).value).toBe(5.75);
    expect(total.getCell(3).value).toBe(6);
    expect(total.getCell(4).value).toBe(5);
    expect(typeof total.getCell(2).value).toBe("number");
    expect(y2026.getCell(2).numFmt).toBe("0.00");
  });

  it("totals hours and entries by profile without adding across profiles", async () => {
    const wb = await build(entries, ["ice", "istructe", "custom"]);
    const ws = wb.getWorksheet("Summary");
    if (!ws) throw new Error("no summary");
    const r = findRow(ws, "Hours by profile");
    expect(rowStrings(ws, r + 2, 3)).toEqual(["ICE", "5.75", "5"]);
    expect(rowStrings(ws, r + 3, 3)).toEqual(["IStructE", "6.00", "2"]);
    expect(rowStrings(ws, r + 4, 3)).toEqual(["Custom", "5.00", "1"]);
    expect(ws.getRow(r + 2).getCell(3).numFmt).toBe("0");
    expect(findRow(ws, "Total across profiles")).toBe(-1);
    expect(findRow(ws, "Hours are not added across profiles, because the same learning can be logged under more than one.")).toBeGreaterThan(0);
  });

  it("totals ICE hours by theme, including themes with no entries, other values, and no theme", async () => {
    const wb = await build(entries, ["ice"]);
    const ws = wb.getWorksheet("Summary");
    if (!ws) throw new Error("no summary");
    const r = findRow(ws, "ICE hours by theme");
    const rows = tableRowsFrom(ws, r + 2, 3, 12);
    const byTheme = new Map(rows.map((x) => [x[0], x.slice(1)]));
    expect(byTheme.get("Energy")).toEqual(["2.00", "1"]);
    expect(byTheme.get("Safety and risk management")).toEqual(["1.75", "2"]);
    expect(byTheme.get("Water")).toEqual(["0.00", "0"]);
    expect(byTheme.get("Ethical and professional behaviours")).toEqual(["0.00", "0"]);
    expect(byTheme.get("Made-up theme")).toEqual(["1.00", "1"]);
    expect(byTheme.get("No theme set")).toEqual(["1.00", "1"]);
    expect(byTheme.get("Total")).toEqual(["5.75", "5"]);
  });

  it("totals IStructE hours by category and the flagged hours", async () => {
    const wb = await build(entries, ["istructe"]);
    const ws = wb.getWorksheet("Summary");
    if (!ws) throw new Error("no summary");
    const r = findRow(ws, "IStructE hours by category");
    const rows = tableRowsFrom(ws, r + 2, 3, 8);
    const by = new Map(rows.map((x) => [x[0], x.slice(1)]));
    expect(by.get("Self-directed study")).toEqual(["4.00", "1"]);
    expect(by.get("Horizon broadening")).toEqual(["2.00", "1"]);
    expect(by.get("Work-based learning")).toEqual(["0.00", "0"]);
    expect(by.get("Total")).toEqual(["6.00", "2"]);
    expect(findRow(ws, "Marked structural safety (Y): 4.00 hours. Marked sustainability (Y): 6.00 hours. Provisional layout.")).toBeGreaterThan(0);
  });

  it("totals the custom profile", async () => {
    const wb = await build(entries, ["custom"]);
    const ws = wb.getWorksheet("Summary");
    if (!ws) throw new Error("no summary");
    const r = findRow(ws, "Hours for your custom profile");
    expect(rowStrings(ws, r + 2, 2)).toEqual(["Hours", "5.00"]);
    expect(rowStrings(ws, r + 3, 2)).toEqual(["Entries", "1"]);
  });

  it("only has sections for the profiles that were asked for", async () => {
    const wb = await build(entries, ["ice"]);
    const ws = wb.getWorksheet("Summary");
    expect(findRow(ws, "ICE hours by theme")).toBeGreaterThan(0);
    expect(findRow(ws, "IStructE hours by category")).toBe(-1);
    expect(findRow(ws, "Hours for your custom profile")).toBe(-1);
  });

  it("has an honest About this file block", async () => {
    const wb = await build(entries, ["ice", "istructe"]);
    const lines = aboutLines(wb);
    const all = lines.join("\n");
    expect(all).toMatch(/ICE CPD tool has no import feature/);
    expect(all).toMatch(/for your own records or to attach/);
    expect(all).toMatch(/both accept CPD records in other formats if the content is complete/);
    expect(all).toMatch(/entered or reviewed by you in CPD Logger/);
    expect(all).toMatch(/detected automatically from a link or file should be checked by you/);
    expect(all).toMatch(/IStructE layout is provisional/);
    expect(all).toMatch(/Generated on 07\/10\/2026/);
    expect(all).toMatch(/1 entry has effective learning time you have not confirmed/);
    expect(all).not.toMatch(/\bverified by\b|\bcompliant\b|\baccurate\b/i);
    expect(all).not.toMatch(/verified/i);
  });

  it("does not mention unconfirmed hours when there are none", async () => {
    const wb = await build([makeEntry({})], ["ice"]);
    expect(aboutLines(wb).join("\n")).not.toMatch(/not confirmed/);
  });

  it("shows the year in the scope line", async () => {
    const wb = await build(entries, ["ice"], 2025);
    expect(findRow(wb.getWorksheet("Summary"), "Entries from 2025. Deleted entries are not included.")).toBeGreaterThan(0);
    const all = await build(entries, ["ice"], "all");
    expect(findRow(all.getWorksheet("Summary"), "Entries from all years. Deleted entries are not included.")).toBeGreaterThan(0);
  });

  it("has every section with zero totals and no invented rows when there are no entries", async () => {
    const wb = await build([], ["ice", "istructe", "custom"]);
    const ws = wb.getWorksheet("Summary");
    if (!ws) throw new Error("no summary");
    const y = findRow(ws, "Hours by year");
    expect(rowStrings(ws, y + 1, 4)).toEqual(["Year", "ICE", "IStructE", "Custom"]);
    expect(rowStrings(ws, y + 2, 4)).toEqual(["Total", "0.00", "0.00", "0.00"]);
    const t = findRow(ws, "ICE hours by theme");
    const themeRows = tableRowsFrom(ws, t + 2, 3, 12);
    expect(themeRows.at(-1)).toEqual(["Total", "0.00", "0"]);
    expect(themeRows.every((r) => r[1] === "0.00" && r[2] === "0")).toBe(true);
    expect(themeRows.map((r) => r[0])).not.toContain("No theme set");
    expect(aboutLines(wb).length).toBeGreaterThanOrEqual(5);
  });

  it("is made of plain values and no formulas", async () => {
    const wb = await build(entries, ["ice", "istructe", "custom"]);
    wb.getWorksheet("Summary")?.eachRow((row) =>
      row.eachCell((cell) => {
        expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
      }),
    );
  });
});

describe("workbook properties", () => {
  it("records only the app name and the generated time, not the user's name", async () => {
    const wb = await build([makeEntry({})], ["ice"]);
    expect(wb.creator).toBe("CPD Logger");
    expect(wb.lastModifiedBy).toBe("CPD Logger");
    expect(wb.created.toISOString()).toBe(NOW.toISOString());
    expect(JSON.stringify(wb.properties)).not.toContain("Test Person");
  });
});

describe("safeSheetName", () => {
  it("replaces characters Excel does not allow", () => {
    expect(safeSheetName("A[b]c:d*e?f/g\\h")).toBe("A-b-c-d-e-f-g-h");
  });
  it("cuts to 31 characters", () => {
    expect(safeSheetName("x".repeat(60))).toHaveLength(31);
  });
  it("drops leading and trailing apostrophes and falls back when nothing is left", () => {
    expect(safeSheetName("'Quoted'")).toBe("Quoted");
    expect(safeSheetName("   ")).toBe("Sheet");
    expect(safeSheetName("[]")).toBe("--");
  });
  it("makes names unique without going over 31 characters, ignoring case", () => {
    const used = new Set(["summary"]);
    expect(safeSheetName("Summary", used)).toBe("Summary (2)");
    used.add("summary (2)");
    expect(safeSheetName("SUMMARY", used)).toBe("SUMMARY (3)");
    const long = "y".repeat(31);
    const u2 = new Set([long.toLowerCase()]);
    const next = safeSheetName(long, u2);
    expect(next).toHaveLength(31);
    expect(next.endsWith(" (2)")).toBe(true);
  });
  it("accepts every sheet name in the profile config", () => {
    for (const p of [PROFILES.ice, PROFILES.istructe, PROFILES.custom]) {
      expect(safeSheetName(p.sheetName)).toBe(p.sheetName);
      expect(p.sheetName.length).toBeLessThanOrEqual(31);
    }
  });
});

describe("helpers", () => {
  it("makes column letters", () => {
    expect([1, 7, 26, 27, 52, 53].map(columnLetter)).toEqual(["A", "G", "Z", "AA", "AZ", "BA"]);
  });
  it("names the download", () => {
    expect(exportFilename(2026, NOW)).toBe("cpd-log-2026.xlsx");
    expect(exportFilename("all", NOW)).toBe("cpd-log-all-years-2026-10-07.xlsx");
  });
});

function findRow(ws: ExcelJS.Worksheet | undefined, text: string): number {
  if (!ws) return -1;
  for (let r = 1; r <= ws.rowCount; r++) {
    if (ws.getCell(r, 1).value === text) return r;
  }
  return -1;
}

/** Rows from `start` until a row with an empty first cell, as display strings. */
function tableRowsFrom(ws: ExcelJS.Worksheet, start: number, columns: number, max: number): string[][] {
  const out: string[][] = [];
  for (let r = start; r < start + max; r++) {
    const row = rowStrings(ws, r, columns);
    if (row[0] === "") break;
    out.push(row);
  }
  return out;
}

function aboutLines(wb: ExcelJS.Workbook): string[] {
  const ws = wb.getWorksheet("Summary");
  const out: string[] = [];
  if (!ws) return out;
  const start = findRow(ws, "About this file");
  for (let r = start + 1; r <= ws.rowCount; r++) {
    const v = ws.getCell(r, 1).value;
    if (typeof v === "string" && v) out.push(v);
  }
  return out;
}
