import type ExcelJS from "exceljs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { previewExport } from "@/lib/export/preview";
import { buildWorkbook, exportFilename } from "@/lib/export/workbook";
import { parseSpreadsheet } from "@/lib/import/parse";
import type { Entry } from "@/lib/types";
import { makeEntry, makeSettings, readBack, shown } from "./export-test-helpers";
import { makeCtx, utc, xlsxFromRows } from "./import-test-helpers";

/**
 * Every date in a file is a UTC day, so the machine's time zone must make no difference. The suite used to pass only
 * because the machine ran in UTC. These tests set the zone themselves, so a date helper that quietly used local time
 * fails here whatever zone the build machine is in. Offsets are minutes west of UTC on 7 July and on 4 March 2026.
 */
const ZONES: [zone: string, july: number, march: number][] = [
  ["UTC", 0, 0],
  ["America/Los_Angeles", 420, 480],
  ["Europe/London", -60, 0],
  ["Pacific/Auckland", -720, -780],
  ["Asia/Tokyo", -540, -540],
];

const settings = makeSettings({ customFields: [{ key: "when", label: "Renewal date", type: "date" }] });
const entries: Entry[] = [
  makeEntry({ title: "March range", dateCompleted: "2026-03-04", dateEnd: "2026-03-06" }),
  makeEntry({ title: "July day", dateCompleted: "2026-07-07" }),
  makeEntry({ title: "New year's day", dateCompleted: "2026-01-01" }),
  makeEntry({ title: "New year's eve", dateCompleted: "2026-12-31" }),
  makeEntry({ profile: "custom", title: "Custom", dateCompleted: "2026-01-01", custom: { when: "2026-12-31" } }),
];
const LATE = new Date(Date.UTC(2026, 6, 7, 23, 30));

describe.each(ZONES)("in the %s time zone", (zone, july, march) => {
  const previous = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = zone;
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  });

  it("really is that zone, so the other tests mean something", () => {
    expect(new Date(2026, 6, 7).getTimezoneOffset()).toBe(july);
    expect(new Date(2026, 2, 4).getTimezoneOffset()).toBe(march);
  });

  it("writes every date as the same UTC day", async () => {
    const wb = await readBack(await buildWorkbook({ entries, settings, profiles: ["ice", "custom"], year: "all", now: LATE }));
    const ice = wb.getWorksheet("ICE CPD log") as ExcelJS.Worksheet;
    // sorted by date: 1 Jan, 4-6 Mar (a text range), 7 Jul, 31 Dec
    const day = (r: number) => ice.getCell(r, 3);
    expect(day(5).value).toEqual(new Date(Date.UTC(2026, 0, 1)));
    expect(shown(day(5))).toBe("01/01/2026");
    expect(day(6).value).toBe("04/03/2026 - 06/03/2026");
    expect(day(7).value).toEqual(new Date(Date.UTC(2026, 6, 7)));
    expect(day(8).value).toEqual(new Date(Date.UTC(2026, 11, 31)));
    const cus = wb.getWorksheet("Custom CPD log") as ExcelJS.Worksheet;
    expect(cus.getCell(2, 1).value).toEqual(new Date(Date.UTC(2026, 0, 1)));
    expect(cus.getCell(2, 4).value).toEqual(new Date(Date.UTC(2026, 11, 31)));
  });

  it("writes the UK date of the day, whatever the machine's zone", async () => {
    const wb = await readBack(await buildWorkbook({ entries, settings, profiles: ["ice"], year: "all", now: LATE }));
    const summary = wb.getWorksheet("Summary") as ExcelJS.Worksheet;
    const text: string[] = [];
    summary.eachRow((row) => text.push(shown(row.getCell(1))));
    expect(text).toContain("Generated on 08/07/2026 by CPD Logger.");
    expect(exportFilename("all", LATE)).toBe("cpd-log-all-years-2026-07-08.xlsx");
  });

  it("shows the same dates in the preview, and counts years by the written date", () => {
    const [ice] = previewExport({ entries, settings, profiles: ["ice"], year: 2026 });
    expect(ice?.rows.map((r) => r[2])).toEqual(["01/01/2026", "04/03/2026 - 06/03/2026", "07/07/2026", "31/12/2026"]);
    expect(previewExport({ entries, settings, profiles: ["ice"], year: 2025 })[0]?.count).toBe(0);
  });

  it("reads date cells as the same UTC day", async () => {
    const buf = await xlsxFromRows([["Date", "Title", "Hours"], [utc(2026, 1, 1), "A", 1], [utc(2026, 3, 4), "B", 1], [utc(2026, 7, 7), "C", 1], [utc(2026, 12, 31), "D", 1]]);
    const r = await parseSpreadsheet(buf, "x.xlsx", makeCtx());
    expect(r.rows.map((x) => x.input.dateCompleted)).toEqual(["2026-01-01", "2026-03-04", "2026-07-07", "2026-12-31"]);
  });

  it("brings its own export back as the same days", async () => {
    const buf = await buildWorkbook({ entries, settings, profiles: ["ice"], year: "all", now: LATE });
    const r = await parseSpreadsheet(buf, "x.xlsx", makeCtx({ profile: "ice", settings }));
    expect(r.rows.map((x) => [x.input.dateCompleted, x.input.dateEnd])).toEqual([
      ["2026-01-01", null],
      ["2026-03-04", "2026-03-06"],
      ["2026-07-07", null],
      ["2026-12-31", null],
    ]);
  });
});
