import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { parseSpreadsheet } from "@/lib/import/parse";
import { flattenCellValue, inspectXlsxZip } from "@/lib/import/xlsx";
import { ImportError } from "@/lib/import/types";
import { makeCtx, toBuffer, utc, xlsxFromRows, issueKeys } from "./import-test-helpers";

const ctx = makeCtx();

describe("xlsx files", () => {
  it("reads a plain sheet with real date cells and numeric hours", async () => {
    const buf = await xlsxFromRows([
      ["Date", "Title", "Hours", "Theme"],
      [utc(2026, 3, 4), "Test activity one", 1.5, "Energy"],
      [utc(2026, 3, 5), "Test activity two", 2, "Water"],
    ]);
    const r = await parseSpreadsheet(buf, "log.xlsx", ctx);
    expect(r.fileKind).toBe("xlsx");
    expect(r.headerRow).toBe(1);
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]?.input).toMatchObject({ title: "Test activity one", dateCompleted: "2026-03-04", hours: 1.5, theme: "Energy", profile: "ice", sourceType: "other", hoursConfirmed: true });
    expect(r.rows[1]?.input).toMatchObject({ dateCompleted: "2026-03-05", hours: 2, theme: "Water" });
    expect(r.mapped).toMatchObject({ date: "Date", title: "Title", hours: "Hours", theme: "Theme" });
    expect(r.unmapped).toEqual([]);
  });

  it("finds a header that is not on row 1, below junk rows, a merged title and blank rows", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("My log");
    ws.getCell("A1").value = "CPD record for a test person";
    ws.mergeCells("A1:D1");
    ws.getCell("A2").value = "Printed on a test day";
    ws.addRow([]);
    ws.addRow([]);
    ws.addRow(["Date", "Activity", "Hours"]);
    ws.addRow([utc(2026, 3, 4), "Test activity", 1]);
    const r = await parseSpreadsheet(await toBuffer(wb), "x.xlsx", ctx);
    expect(r.headerRow).toBe(5);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.n).toBe(6);
    expect(r.rows[0]?.input.title).toBe("Test activity");
  });

  it("chooses the row with the most recognised columns as the header", async () => {
    const buf = await xlsxFromRows([
      ["Hours", "Notes"],
      ["Date", "Title", "Hours", "Theme", "Provider"],
      [utc(2026, 3, 4), "Test activity", 1, "Water", "Test provider"],
    ]);
    const r = await parseSpreadsheet(buf, "x.xlsx", ctx);
    expect(r.headerRow).toBe(2);
    expect(r.rows[0]?.input.provider).toBe("Test provider");
  });

  it("only looks in the first 25 rows for the header", async () => {
    const rows: unknown[][] = Array.from({ length: 25 }, (_, i) => [`junk ${i + 1}`]);
    rows.push(["Date", "Title", "Hours"], [utc(2026, 3, 4), "A", 1]);
    await expect(parseSpreadsheet(await xlsxFromRows(rows), "x.xlsx", ctx)).rejects.toMatchObject({ code: "no_header" });
    const ok: unknown[][] = Array.from({ length: 24 }, (_, i) => [`junk ${i + 1}`]);
    ok.push(["Date", "Title", "Hours"], [utc(2026, 3, 4), "A", 1]);
    expect((await parseSpreadsheet(await xlsxFromRows(ok), "x.xlsx", ctx)).headerRow).toBe(25);
  });

  it("reads dates as Excel serial numbers in a General-format cell, serial text and UK text", async () => {
    const buf = await xlsxFromRows([
      ["Date", "Title", "Hours"],
      [46085, "Serial number", 1],
      ["46086", "Serial as text", 1],
      ["06/03/2026", "UK text", 1],
      ["7 March 2026", "Written date", 1],
      ["2026-03-08", "ISO text", 1],
    ]);
    const r = await parseSpreadsheet(buf, "x.xlsx", ctx);
    expect(r.rows.map((x) => x.input.dateCompleted)).toEqual(["2026-03-04", "2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08"]);
  });

  it("reads serial numbers in a workbook that uses the 1904 date system", async () => {
    const wb = new ExcelJS.Workbook();
    wb.properties.date1904 = true;
    const ws = wb.addWorksheet("S");
    ws.addRow(["Date", "Title", "Hours"]);
    ws.addRow([44623, "Serial in 1904 system", 1]);
    ws.addRow([utc(2026, 3, 5), "Date cell in 1904 system", 1]);
    const r = await parseSpreadsheet(await toBuffer(wb), "x.xlsx", ctx);
    expect(r.rows.map((x) => x.input.dateCompleted)).toEqual(["2026-03-04", "2026-03-05"]);
  });

  it("reads rich text cells", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["Date", "Title", "Hours", "Key Learning Points"]);
    const row = ws.addRow([utc(2026, 3, 4), null, 1, null]);
    row.getCell(2).value = { richText: [{ text: "Part one, ", font: { bold: true } }, { text: "part two" }] };
    row.getCell(4).value = { richText: [{ text: "Learned " }, { text: "a test thing about drainage design.", font: { italic: true } }] };
    const r = await parseSpreadsheet(await toBuffer(wb), "x.xlsx", ctx);
    expect(r.rows[0]?.input.title).toBe("Part one, part two");
    expect(r.rows[0]?.input.learningPoints).toBe("Learned a test thing about drainage design.");
  });

  it("reads hyperlink cells: the text, and the link as the entry's link", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["Date", "Title", "Hours", "Link"]);
    const a = ws.addRow([utc(2026, 3, 4), null, 1, null]);
    a.getCell(2).value = { text: "Linked title", hyperlink: "https://example.test/a" };
    const b = ws.addRow([utc(2026, 3, 5), "Plain title", 1, null]);
    b.getCell(4).value = { text: "Click here", hyperlink: "https://example.test/b" };
    const c = ws.addRow([utc(2026, 3, 6), "Bad link", 1, null]);
    c.getCell(4).value = { text: "Click here", hyperlink: "javascript:alert(1)" };
    const r = await parseSpreadsheet(await toBuffer(wb), "x.xlsx", ctx);
    expect(r.rows[0]?.input).toMatchObject({ title: "Linked title", url: "https://example.test/a" });
    expect(r.rows[1]?.input).toMatchObject({ title: "Plain title", url: "https://example.test/b" });
    expect(r.rows[2]?.input.url).toBeNull();
    expect(issueKeys(r.rows[2])).toContain("url:warning");
  });

  it("uses the saved result of a formula and never calculates one", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["Date", "Title", "Hours"]);
    ws.addRow([null, null, null]);
    ws.getCell("A2").value = { formula: "DATE(2026,3,4)", result: utc(2026, 3, 4) };
    ws.getCell("B2").value = { formula: '"Test "&"title"', result: "Test title" };
    ws.getCell("C2").value = { formula: "90/60", result: 1.5 };
    const r = await parseSpreadsheet(await toBuffer(wb), "x.xlsx", ctx);
    expect(r.rows[0]?.input).toMatchObject({ dateCompleted: "2026-03-04", title: "Test title", hours: 1.5 });
  });

  it("reads a formula with no saved result as blank and warns", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["Date", "Title", "Hours"]);
    ws.addRow([utc(2026, 3, 4), "Has formula hours", null]);
    ws.getCell("C2").value = { formula: "1+1" } as ExcelJS.CellFormulaValue;
    const r = await parseSpreadsheet(await toBuffer(wb), "x.xlsx", ctx);
    expect(r.rows[0]?.input.hours).toBe(0);
    expect(issueKeys(r.rows[0])).toContain("hours:error");
    expect(r.warnings.some((w) => /1 cell holds a formula with no saved result/.test(w))).toBe(true);
    expect(r.warnings.some((w) => /never calculated/.test(w))).toBe(true);
  });

  it("reads an error value from a formula as text, not as a number", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["Date", "Title", "Hours"]);
    ws.addRow([utc(2026, 3, 4), "Test", null]);
    ws.getCell("C2").value = { formula: "1/0", result: { error: "#DIV/0!" } } as ExcelJS.CellFormulaValue;
    const r = await parseSpreadsheet(await toBuffer(wb), "x.xlsx", ctx);
    expect(issueKeys(r.rows[0])).toContain("hours:error");
    expect(r.rows[0]?.issues.find((i) => i.field === "hours")?.message).toMatch(/#DIV\/0!/);
  });

  it("skips empty rows, whitespace-only rows and a Total row, and says so for the total", async () => {
    const buf = await xlsxFromRows([
      ["Date", "Title", "Hours"],
      [utc(2026, 3, 4), "A", 1],
      [],
      ["  ", " ", ""],
      [utc(2026, 3, 5), "B", 2],
      ["Total", null, 3],
    ]);
    const r = await parseSpreadsheet(buf, "x.xlsx", ctx);
    expect(r.rows.map((x) => x.input.title)).toEqual(["A", "B"]);
    expect(r.warnings.some((w) => /Skipped row 6, which looks like a total/.test(w))).toBe(true);
  });

  it.each(["Total", "TOTAL", "Totals", "Grand total", "Sub-total", "Total hours"])("skips a %s row", async (word) => {
    const buf = await xlsxFromRows([["Date", "Title", "Hours"], [utc(2026, 3, 4), "A", 1], [null, word, 1]]);
    const r = await parseSpreadsheet(buf, "x.xlsx", ctx);
    expect(r.rows).toHaveLength(1);
  });

  it("does not skip an activity that merely starts with the word total", async () => {
    const buf = await xlsxFromRows([["Date", "Title", "Hours"], [utc(2026, 3, 4), "Total station surveying course", 1]]);
    const r = await parseSpreadsheet(buf, "x.xlsx", ctx);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.input.title).toBe("Total station surveying course");
  });

  it("repeats a merged date down several rows and skips a merged section heading", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["Date", "Title", "Hours"]);
    ws.addRow([null, "First on the day", 1]);
    ws.addRow([null, "Second on the day", 2]);
    ws.getCell("A2").value = utc(2026, 3, 4);
    ws.mergeCells("A2:A3");
    ws.addRow(["February", "February", "February"]);
    ws.mergeCells("A4:C4");
    ws.addRow([utc(2026, 2, 1), "In February", 1]);
    const r = await parseSpreadsheet(await toBuffer(wb), "x.xlsx", ctx);
    expect(r.rows.map((x) => [x.input.title, x.input.dateCompleted])).toEqual([
      ["First on the day", "2026-03-04"],
      ["Second on the day", "2026-03-04"],
      ["In February", "2026-02-01"],
    ]);
    expect(r.warnings.some((w) => /Skipped row 4, which looks like a merged heading/.test(w))).toBe(true);
  });

  it("skips a header row repeated further down", async () => {
    const buf = await xlsxFromRows([["Date", "Title", "Hours"], [utc(2026, 3, 4), "A", 1], ["Date", "Title", "Hours"], [utc(2026, 3, 5), "B", 1]]);
    const r = await parseSpreadsheet(buf, "x.xlsx", ctx);
    expect(r.rows.map((x) => x.input.title)).toEqual(["A", "B"]);
    expect(r.warnings.some((w) => /repeats the header row/.test(w))).toBe(true);
  });

  it("reads date ranges: the first day, and the last day as dateEnd", async () => {
    const buf = await xlsxFromRows([
      ["Date", "Title", "Hours"],
      ["4-6 March 2026", "Range one", 6],
      ["10/03/2026 - 12/03/2026", "Range two", 3],
    ]);
    const r = await parseSpreadsheet(buf, "x.xlsx", ctx);
    expect(r.rows[0]?.input).toMatchObject({ dateCompleted: "2026-03-04", dateEnd: "2026-03-06" });
    expect(r.rows[1]?.input).toMatchObject({ dateCompleted: "2026-03-10", dateEnd: "2026-03-12" });
  });

  it("reads a separate Minutes column and comma decimals", async () => {
    const buf = await xlsxFromRows([
      ["Date", "Title", "Minutes"],
      [utc(2026, 3, 4), "Minutes only", 90],
      [utc(2026, 3, 5), "Text minutes", "45"],
    ]);
    const r = await parseSpreadsheet(buf, "x.xlsx", ctx);
    expect(r.rows.map((x) => x.input.hours)).toEqual([1.5, 0.75]);
    const buf2 = await xlsxFromRows([["Date", "Title", "Hours"], [utc(2026, 3, 4), "Comma", "1,5"], [utc(2026, 3, 5), "Units", "1h 30m"]]);
    const r2 = await parseSpreadsheet(buf2, "x.xlsx", ctx);
    expect(r2.rows.map((x) => x.input.hours)).toEqual([1.5, 1.5]);
  });

  it("adds Hours and Minutes columns together, with a warning to check it", async () => {
    const buf = await xlsxFromRows([["Date", "Title", "Hours", "Minutes"], [utc(2026, 3, 4), "Split", 1, 30]]);
    const r = await parseSpreadsheet(buf, "x.xlsx", ctx);
    expect(r.rows[0]?.input.hours).toBe(1.5);
    expect(r.rows[0]?.issues.find((i) => i.field === "hours")?.message).toMatch(/Added the "Hours" column \(1\) and the "Minutes" column \(30\) together: 1.5 hours/);
    expect(r.rows[0]?.input.confidence.hours?.level).toBe("low");
  });

  it("warns which way an ambiguous Time or Duration number was read", async () => {
    const buf = await xlsxFromRows([["Date", "Title", "Duration"], [utc(2026, 3, 4), "Small", 2], [utc(2026, 3, 5), "Big", 45]]);
    const r = await parseSpreadsheet(buf, "x.xlsx", ctx);
    expect(r.rows.map((x) => x.input.hours)).toEqual([2, 0.75]);
    expect(r.rows[0]?.issues.find((i) => i.field === "hours")?.message).toBe('Read "2" in the "Duration" column as 2 hours. Check this is right.');
    expect(r.rows[1]?.issues.find((i) => i.field === "hours")?.message).toBe('Read "45" in the "Duration" column as 45 minutes (0.75 hours). Check this is right.');
    expect(r.rows[0]?.input.confidence.hours?.level).toBe("low");
    // An ambiguity warning does not block the row.
    expect(r.rows.every((x) => x.include)).toBe(true);
  });

  it("reads a time-formatted hours cell", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["Date", "Title", "Hours"]);
    const row = ws.addRow([utc(2026, 3, 4), "Time cell", null]);
    row.getCell(3).value = new Date(Date.UTC(1899, 11, 30, 1, 30));
    row.getCell(3).numFmt = "[h]:mm";
    const r = await parseSpreadsheet(await toBuffer(wb), "x.xlsx", ctx);
    expect(r.rows[0]?.input.hours).toBe(1.5);
  });

  it("prefers the sheet named like the profile's own export, and says the others were ignored", async () => {
    const wb = new ExcelJS.Workbook();
    const other = wb.addWorksheet("Other");
    other.addRow(["Date", "Title", "Hours"]);
    other.addRow([utc(2026, 1, 1), "From other sheet", 1]);
    const ice = wb.addWorksheet("ICE CPD log");
    ice.addRow(["Date", "Title", "Hours"]);
    ice.addRow([utc(2026, 2, 2), "From ICE sheet", 2]);
    const r = await parseSpreadsheet(await toBuffer(wb), "x.xlsx", ctx);
    expect(r.rows.map((x) => x.input.title)).toEqual(["From ICE sheet"]);
    expect(r.warnings).toContain('Only the sheet "ICE CPD log" was read. The other sheets in the file were ignored.');
  });

  it("skips sheets with no header and hidden sheets", async () => {
    const wb = new ExcelJS.Workbook();
    const notes = wb.addWorksheet("Notes");
    notes.addRow(["Just some notes"]);
    const hidden = wb.addWorksheet("Hidden");
    hidden.addRow(["Date", "Title", "Hours"]);
    hidden.addRow([utc(2026, 1, 1), "From hidden sheet", 1]);
    hidden.state = "hidden";
    const real = wb.addWorksheet("Real");
    real.addRow(["Date", "Title", "Hours"]);
    real.addRow([utc(2026, 2, 2), "From real sheet", 2]);
    const r = await parseSpreadsheet(await toBuffer(wb), "x.xlsx", ctx);
    expect(r.rows.map((x) => x.input.title)).toEqual(["From real sheet"]);
  });

  it("says plainly when no sheet has a header", async () => {
    const buf = await xlsxFromRows([["just", "words"], ["and", "numbers", 3]]);
    await expect(parseSpreadsheet(buf, "x.xlsx", ctx)).rejects.toMatchObject({ code: "no_header" });
  });

  it("says plainly when there are no entries under the header", async () => {
    const buf = await xlsxFromRows([["Date", "Title", "Hours"]]);
    const err = await parseSpreadsheet(buf, "x.xlsx", ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportError);
    expect((err as ImportError).code).toBe("no_rows");
    expect((err as ImportError).message).toMatch(/below the header row \(row 1\)/);
  });

  it("reads hidden rows too and says how many there were", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("S");
    ws.addRow(["Date", "Title", "Hours"]);
    ws.addRow([utc(2026, 3, 4), "Visible", 1]);
    ws.addRow([utc(2026, 3, 5), "Hidden by a filter", 1]).hidden = true;
    ws.addRow([utc(2026, 3, 6), "Also hidden", 1]).hidden = true;
    const r = await parseSpreadsheet(await toBuffer(wb), "x.xlsx", ctx);
    expect(r.rows.map((x) => x.input.title)).toEqual(["Visible", "Hidden by a filter", "Also hidden"]);
    expect(r.warnings.some((w) => /^2 rows are hidden in the file/.test(w))).toBe(true);
  });

  it("only reads the first 100 columns", async () => {
    const header = ["Date", "Title", "Hours", ...Array.from({ length: 150 }, (_, i) => `Extra ${i}`)];
    const row = [utc(2026, 3, 4), "Wide", 1, ...Array.from({ length: 150 }, () => "x")];
    const r = await parseSpreadsheet(await xlsxFromRows([header, row]), "x.xlsx", ctx);
    expect(r.rows).toHaveLength(1);
    expect(r.unmapped.length).toBe(97);
  });
});

describe("flattenCellValue", () => {
  it("handles every shape exceljs can return", () => {
    expect(flattenCellValue(null).cell.v).toBeNull();
    expect(flattenCellValue(undefined).cell.v).toBeNull();
    expect(flattenCellValue("a").cell.v).toBe("a");
    expect(flattenCellValue(3).cell.v).toBe(3);
    expect(flattenCellValue(true).cell.v).toBe(true);
    expect(flattenCellValue(utc(2026, 1, 1)).cell.v).toEqual(utc(2026, 1, 1));
    expect(flattenCellValue(new Date(Number.NaN)).cell.v).toBeNull();
    expect(flattenCellValue({ richText: [{ text: "a" }, { text: "b" }] }).cell.v).toBe("ab");
    expect(flattenCellValue({ text: "t", hyperlink: "https://example.test" }).cell).toEqual({ v: "t", link: "https://example.test" });
    expect(flattenCellValue({ text: "t", hyperlink: "mailto:a@example.test" }).cell).toEqual({ v: "t", link: null });
    expect(flattenCellValue({ formula: "A1", result: 5 }).cell.v).toBe(5);
    expect(flattenCellValue({ sharedFormula: "B1", result: "x" } as unknown as ExcelJS.CellValue).cell.v).toBe("x");
    expect(flattenCellValue({ formula: "A1" }).formulaWithoutResult).toBe(true);
    expect(flattenCellValue({ error: "#N/A" }).cell.v).toBe("#N/A");
    expect(flattenCellValue({ formula: "A1", result: { error: "#REF!" } } as ExcelJS.CellValue).cell.v).toBe("#REF!");
    expect(flattenCellValue({ formula: "A1", result: { richText: [{ text: "r" }] } } as unknown as ExcelJS.CellValue).cell.v).toBe("r");
  });
});

describe("inspectXlsxZip", () => {
  it("accepts a real workbook", async () => {
    const buf = await xlsxFromRows([["Date", "Title", "Hours"]]);
    expect(() => inspectXlsxZip(buf)).not.toThrow();
  });

  it("refuses a workbook whose zip directory claims it unpacks to a huge size", async () => {
    const buf = Buffer.from(await xlsxFromRows([["Date", "Title", "Hours"], [utc(2026, 3, 4), "A", 1]]));
    // Patch every central directory entry's uncompressed size (offset 24 in the entry) to about 2 GB.
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    const total = buf.readUInt16LE(eocd + 10);
    let p = buf.readUInt32LE(eocd + 16);
    for (let k = 0; k < total; k++) {
      buf.writeUInt32LE(0x7fffffff, p + 24);
      p += 46 + buf.readUInt16LE(p + 28) + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    }
    await expect(parseSpreadsheet(buf, "bomb.xlsx", ctx)).rejects.toMatchObject({ code: "too_large" });
  });

  it("refuses text, an old .xls header, and a truncated zip, with a message about saving as .xlsx", async () => {
    for (const bytes of [Buffer.from("this is not a zip file at all, just text"), Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Buffer.from("PK\x03\x04 truncated nonsense that is long enough to pass the length check")]) {
      const err = await parseSpreadsheet(bytes, "x.xlsx", ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ImportError);
      expect((err as ImportError).code).toBe("unreadable");
      expect((err as ImportError).message).toMatch(/save it again as \.xlsx/);
      expect((err as ImportError).message).toMatch(/password/);
    }
  });

  it("refuses a valid zip that is not a workbook", async () => {
    const wb = new ExcelJS.Workbook();
    wb.addWorksheet("S").addRow(["Date", "Title", "Hours"]);
    const good = await toBuffer(wb);
    // Break the workbook part's name inside the archive: exceljs cannot then find a workbook.
    const bad = Buffer.from(good);
    const idx = bad.indexOf(Buffer.from("xl/workbook.xml"));
    expect(idx).toBeGreaterThan(0);
    bad.write("xl/wxrkbook.xml", idx);
    bad.write("xl/wxrkbook.xml", bad.lastIndexOf(Buffer.from("xl/workbook.xml")));
    const err = await parseSpreadsheet(bad, "x.xlsx", ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ImportError);
  });
});
