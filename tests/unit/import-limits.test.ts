import { describe, expect, it } from "vitest";
import { IMPORT_LIMITS, ImportError, parseDelimitedText, parseSpreadsheet } from "@/lib/import/parse";
import { makeCtx, utc, xlsxFromRows } from "./import-test-helpers";

const ctx = makeCtx();

async function failure(p: Promise<unknown>): Promise<ImportError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ImportError);
  return e as ImportError;
}

describe("file type", () => {
  const body = Buffer.from("Date,Title,Hours\n04/03/2026,A,1");

  it.each(["notes.xls", "notes.xlsm", "notes.xlsb", "notes.ods", "notes.numbers", "notes.txt", "notes.tsv", "notes.pdf", "notes.docx", "notes", "notes.csv.exe", ".csv", "csv", "notes.xlsx.zip"])(
    "refuses %s with a message that says how to fix it",
    async (name) => {
      const e = await failure(parseSpreadsheet(body, name, ctx));
      expect(e.code).toBe("unsupported_type");
      expect(e.message).toMatch(/Save as/);
      expect(e.message).toMatch(/\.xlsx/);
    },
  );

  it("names an old .xls file as such", async () => {
    const e = await failure(parseSpreadsheet(body, "old.xls", ctx));
    expect(e.message).toMatch(/old \.xls file/);
  });

  it("accepts .csv and .xlsx in any case, and with a folder in the name", async () => {
    await expect(parseSpreadsheet(body, "a.CSV", ctx)).resolves.toBeDefined();
    await expect(parseSpreadsheet(body, "C:\\Users\\test\\My log.Csv", ctx)).resolves.toBeDefined();
    await expect(parseSpreadsheet(body, "/tmp/x/a.csv", ctx)).resolves.toBeDefined();
    const xl = await xlsxFromRows([["Date", "Title", "Hours"], [utc(2026, 3, 4), "A", 1]]);
    await expect(parseSpreadsheet(xl, "A.XLSX", ctx)).resolves.toBeDefined();
  });

  it("does not echo a very long file name in full", async () => {
    const e = await failure(parseSpreadsheet(body, `${"x".repeat(500)}.pdf`, ctx));
    expect(e.message.length).toBeLessThan(400);
  });

  it("refuses an empty file", async () => {
    const e = await failure(parseSpreadsheet(Buffer.alloc(0), "a.csv", ctx));
    expect(e.code).toBe("unreadable");
    expect(e.message).toMatch(/empty/);
  });
});

describe("size", () => {
  it("refuses a file over 5 MB and says how big it was", async () => {
    const big = Buffer.alloc(IMPORT_LIMITS.maxBytes + 1, 0x61);
    const e = await failure(parseSpreadsheet(big, "big.csv", ctx));
    expect(e.code).toBe("too_large");
    expect(e.message).toMatch(/5\.0 MB/);
    expect(e.message).toMatch(/limit/);
    const bigX = await failure(parseSpreadsheet(big, "big.xlsx", ctx));
    expect(bigX.code).toBe("too_large");
  });

  it("does not refuse a file of exactly 5 MB on size", async () => {
    const head = Buffer.from("Date,Title,Hours\n04/03/2026,A,1\n");
    const filler = Buffer.alloc(IMPORT_LIMITS.maxBytes - head.length, 0x20);
    const exact = Buffer.concat([head, filler]);
    expect(exact.length).toBe(IMPORT_LIMITS.maxBytes);
    const r = await parseSpreadsheet(exact, "exact.csv", ctx);
    expect(r.rows).toHaveLength(1);
  });

  it("refuses pasted text over 5 MB too", () => {
    expect(() => parseDelimitedText("a".repeat(IMPORT_LIMITS.maxBytes + 1), ctx)).toThrow(/limit/);
  });
});

describe("row limit", () => {
  const rowsOf = (n: number) => Array.from({ length: n }, (_, i) => `${String((i % 28) + 1).padStart(2, "0")}/${String((Math.floor(i / 28) % 12) + 1).padStart(2, "0")}/${2000 + Math.floor(i / 336)},Test ${i},1`);

  it("accepts 2000 rows", () => {
    const r = parseDelimitedText(["Date,Title,Hours", ...rowsOf(2000)].join("\n"), ctx);
    expect(r.rows).toHaveLength(2000);
  });

  it("refuses 2001 rows with a message that says what to do", () => {
    try {
      parseDelimitedText(["Date,Title,Hours", ...rowsOf(2001)].join("\n"), ctx);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ImportError);
      expect((e as ImportError).code).toBe("too_many_rows");
      expect((e as ImportError).message).toMatch(/2001 rows/);
      expect((e as ImportError).message).toMatch(/limit of 2000/);
      expect((e as ImportError).message).toMatch(/Split it into smaller files/);
    }
  });

  it("counts rows below the header, not junk above it", () => {
    const junk = Array.from({ length: 10 }, (_, i) => `note ${i}`);
    const r = parseDelimitedText([...junk, "Date,Title,Hours", ...rowsOf(2000)].join("\n"), ctx);
    expect(r.rows).toHaveLength(2000);
  });

  it("does not count blank lines", () => {
    const r = parseDelimitedText(["Date,Title,Hours", ...rowsOf(10).flatMap((l) => [l, "", ""])].join("\n"), ctx);
    expect(r.rows).toHaveLength(10);
  });

  it("refuses an xlsx with more than 2000 rows", async () => {
    const rows: unknown[][] = [["Date", "Title", "Hours"]];
    for (let i = 0; i < 2001; i++) rows.push([utc(2026, 1, 1 + (i % 28)), `Test ${i}`, 1]);
    const e = await failure(parseSpreadsheet(await xlsxFromRows(rows), "many.xlsx", ctx));
    expect(e.code).toBe("too_many_rows");
    expect(e.message).toMatch(/2000/);
  });

  it("stops early on an xlsx with far more rows than the limit", async () => {
    const rows: unknown[][] = [["Date", "Title", "Hours"]];
    for (let i = 0; i < 2100; i++) rows.push([utc(2026, 1, 1 + (i % 28)), `Test ${i}`, 1]);
    const e = await failure(parseSpreadsheet(await xlsxFromRows(rows), "many.xlsx", ctx));
    expect(e.code).toBe("too_many_rows");
  });

  it("accepts an xlsx with exactly 2000 entries", async () => {
    const rows: unknown[][] = [["Date", "Title", "Hours"]];
    for (let i = 0; i < 2000; i++) rows.push([utc(2026, 1, 1 + (i % 28)), `Test ${i}`, 1]);
    const r = await parseSpreadsheet(await xlsxFromRows(rows), "ok.xlsx", ctx);
    expect(r.rows).toHaveLength(2000);
  }, 30000);
});

describe("hostile content", () => {
  it("treats text that looks like markup or script as plain text", () => {
    const r = parseDelimitedText('Date,Title,Hours\n04/03/2026,"<script>alert(1)</script> & ""x""",1', ctx);
    expect(r.rows[0]?.input.title).toBe('<script>alert(1)</script> & "x"');
  });

  it("never turns a formula in a CSV cell into anything but text", () => {
    const r = parseDelimitedText('Date,Title,Hours\n04/03/2026,"=HYPERLINK(""http://example.test"",""x"")",1', ctx);
    expect(r.rows[0]?.input.title).toBe('=HYPERLINK("http://example.test","x")');
  });

  it("copes with a very long cell and many columns without throwing", () => {
    const long = "x".repeat(200000);
    const r = parseDelimitedText(`Date,Title,Hours,Key Learning Points\n04/03/2026,A,1,${long}`, ctx);
    expect(r.rows[0]?.input.learningPoints).toHaveLength(200000);
    const wide = Array.from({ length: 500 }, (_, i) => `c${i}`);
    const r2 = parseDelimitedText(`Date,Title,Hours,${wide.join(",")}\n04/03/2026,A,1,${wide.join(",")}`, ctx);
    expect(r2.rows).toHaveLength(1);
  });

  it("does not hang on a pathological date or hours string", () => {
    const evil = "1".repeat(20000);
    const start = Date.now();
    parseDelimitedText(`Date,Title,Hours\n${evil}-${evil},A,${evil}\n04/03/2026,${"a ".repeat(10000)},1`, ctx);
    expect(Date.now() - start).toBeLessThan(3000);
  });
});
