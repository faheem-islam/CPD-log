import { deflateRawSync, inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { normHeader } from "@/lib/import/columns";
import { parseCsvRecords } from "@/lib/import/csv";
import { IMPORT_LIMITS, ImportError, parseDelimitedText, parseSpreadsheet } from "@/lib/import/parse";
import { parseDateText, parseHoursCell } from "@/lib/import/values";
import { verifyXlsxUnpackedSize } from "@/lib/import/xlsx";
import { makeCtx, utc, xlsxFromRows } from "./import-test-helpers";

const ctx = makeCtx();

function elapsed(f: () => unknown): number {
  const t = performance.now();
  f();
  return performance.now() - t;
}

async function failure(p: Promise<unknown>): Promise<ImportError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ImportError);
  return e as ImportError;
}

// ---------------------------------------------------------------------------------------------------------------
// A tiny zip reader and writer, so a test can build a workbook whose zip directory says something untrue.

interface ZipPart {
  name: string;
  /** 0 = stored, 8 = deflated. */
  method: number;
  /** The bytes as they sit in the zip. */
  compressed: Buffer;
  /** The uncompressed size the directory will claim. */
  declaredSize: number;
}

function readZip(buf: Buffer): ZipPart[] {
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
  const total = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const parts: ZipPart[] = [];
  for (let k = 0; k < total; k++) {
    const nameLength = buf.readUInt16LE(p + 28);
    const compressedSize = buf.readUInt32LE(p + 20);
    const local = buf.readUInt32LE(p + 42);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    parts.push({
      name: buf.toString("utf8", p + 46, p + 46 + nameLength),
      method: buf.readUInt16LE(p + 10),
      compressed: buf.subarray(start, start + compressedSize),
      declaredSize: buf.readUInt32LE(p + 24),
    });
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return parts;
}

function writeZip(parts: ZipPart[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const part of parts) {
    const name = Buffer.from(part.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(part.method, 8);
    local.writeUInt32LE(part.compressed.length, 18);
    local.writeUInt32LE(part.declaredSize, 22);
    local.writeUInt16LE(name.length, 26);
    const head = Buffer.alloc(46);
    head.writeUInt32LE(0x02014b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(20, 6);
    head.writeUInt16LE(part.method, 10);
    head.writeUInt32LE(part.compressed.length, 20);
    head.writeUInt32LE(part.declaredSize, 24);
    head.writeUInt16LE(name.length, 28);
    head.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([head, name]));
    chunks.push(local, name, part.compressed);
    offset += 30 + name.length + part.compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(parts.length, 8);
  end.writeUInt16LE(parts.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, directory, end]);
}

function deflated(name: string, data: Buffer, declaredSize = data.length): ZipPart {
  return { name, method: 8, compressed: deflateRawSync(data, { level: 1 }), declaredSize };
}

async function baseWorkbook(): Promise<ZipPart[]> {
  return readZip(await xlsxFromRows([["Date", "Title", "Hours"], [utc(2026, 3, 4), "A", 1]]));
}

describe("a zip directory that lies about sizes", () => {
  it("reads a zip back the way it was written (the helper itself)", async () => {
    const parts = await baseWorkbook();
    const again = writeZip(parts);
    const r = await parseSpreadsheet(again, "x.xlsx", ctx);
    expect(r.rows[0]?.input.title).toBe("A");
    const sheet = parts.find((p) => p.name === "xl/worksheets/sheet1.xml");
    expect(inflateRawSync(sheet?.compressed ?? Buffer.alloc(0)).toString()).toContain("<sheetData>");
  });

  it("refuses a workbook that inflates past the limit although its directory says 100 bytes", async () => {
    const bomb = deflated("xl/media/bomb.png", Buffer.alloc(120 * 1024 * 1024), 100);
    const buf = writeZip([...(await baseWorkbook()), bomb]);
    expect(buf.length).toBeLessThan(IMPORT_LIMITS.maxBytes);
    const start = performance.now();
    const e = await failure(parseSpreadsheet(buf, "bomb.xlsx", ctx));
    expect(e.code).toBe("too_large");
    expect(e.message).toMatch(/bigger than its file size suggests/);
    // It stops as soon as the total passes the limit. It does not inflate to the end.
    expect(performance.now() - start).toBeLessThan(5000);
  }, 30000);

  it("counts every entry together, not each one alone", async () => {
    const slab = Buffer.alloc(30 * 1024 * 1024);
    const parts = [deflated("xl/media/a.bin", slab, 10), deflated("xl/media/b.bin", slab, 10), deflated("xl/media/c.bin", slab, 10)];
    const buf = writeZip([...(await baseWorkbook()), ...parts]);
    await expect(verifyXlsxUnpackedSize(buf)).rejects.toMatchObject({ code: "too_large" });
  }, 30000);

  it("accepts a workbook whose parts together are under the limit", async () => {
    const buf = writeZip([...(await baseWorkbook()), deflated("xl/media/ok.bin", Buffer.alloc(5 * 1024 * 1024), 5)]);
    await expect(verifyXlsxUnpackedSize(buf)).resolves.toBeUndefined();
  });

  it("refuses a part that cannot be inflated, and a part that runs past the end of the file, as unreadable", async () => {
    const garbage: ZipPart = { name: "xl/media/bad.bin", method: 8, compressed: Buffer.from("this is not a deflate stream at all"), declaredSize: 10 };
    const e1 = await failure(parseSpreadsheet(writeZip([...(await baseWorkbook()), garbage]), "x.xlsx", ctx));
    expect(e1.code).toBe("unreadable");
    const base = await baseWorkbook();
    const buf = writeZip(base);
    // Make the first directory entry claim far more compressed bytes than the file holds.
    let eocd = buf.length - 22;
    while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd -= 1;
    buf.writeUInt32LE(buf.length * 2, buf.readUInt32LE(eocd + 16) + 20);
    const e2 = await failure(parseSpreadsheet(buf, "x.xlsx", ctx));
    expect(e2.code).toBe("unreadable");
  });

  it("refuses a part with a compression method no workbook uses", async () => {
    const odd: ZipPart = { name: "xl/media/odd.bin", method: 12, compressed: Buffer.from("abc"), declaredSize: 3 };
    const e = await failure(parseSpreadsheet(writeZip([...(await baseWorkbook()), odd]), "x.xlsx", ctx));
    expect(e.code).toBe("unreadable");
  });
});

describe("a sheet with far too many rows is stopped before it is loaded", () => {
  function sheetXml(rows: number): string {
    const out: string[] = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>'];
    out.push('<row r="1"><c r="A1" t="inlineStr"><is><t>Date</t></is></c><c r="B1" t="inlineStr"><is><t>Title</t></is></c><c r="C1" t="inlineStr"><is><t>Hours</t></is></c></row>');
    for (let i = 2; i <= rows; i++) out.push(`<row r="${i}"><c r="A${i}"><v>46085</v></c><c r="B${i}" t="inlineStr"><is><t>T${i}</t></is></c><c r="C${i}"><v>1</v></c></row>`);
    out.push("</sheetData></worksheet>");
    return out.join("");
  }

  async function withSheet(xml: string): Promise<Buffer> {
    const parts = (await baseWorkbook()).map((p) => (p.name === "xl/worksheets/sheet1.xml" ? deflated(p.name, Buffer.from(xml)) : p));
    return writeZip(parts);
  }

  it("refuses 200,000 rows quickly, without loading them", async () => {
    const buf = await withSheet(sheetXml(200_000));
    expect(buf.length).toBeLessThan(IMPORT_LIMITS.maxBytes);
    const start = performance.now();
    const e = await failure(parseSpreadsheet(buf, "many.xlsx", ctx));
    expect(e.code).toBe("too_many_rows");
    expect(e.message).toMatch(/far more than 2000 rows/);
    expect(performance.now() - start).toBeLessThan(2500);
  }, 30000);

  it("still lets the exact check decide for a sheet that is over the limit but not absurd", async () => {
    const e = await failure(parseSpreadsheet(await withSheet(sheetXml(3000)), "some.xlsx", ctx));
    expect(e.code).toBe("too_many_rows");
    expect(e.message).toMatch(/^That sheet has more than 2000 rows/);
  }, 30000);

  it("reads a sheet of ordinary size as before", async () => {
    const r = await parseSpreadsheet(await withSheet(sheetXml(50)), "ok.xlsx", ctx);
    expect(r.rows).toHaveLength(49);
  });
});

describe("one cell cannot keep the server busy", () => {
  const N = 100_000;
  const BUDGET_MS = 1000;

  it("reads a header, a first cell and a title of 100,000 opening brackets in linear time", () => {
    const evil = "(".repeat(N);
    expect(elapsed(() => parseDelimitedText(`Date,Title,Hours\n04/03/2026,${evil},1`, ctx))).toBeLessThan(BUDGET_MS);
    expect(elapsed(() => parseDelimitedText(`Date,Title,Hours\n${evil},A,1`, ctx))).toBeLessThan(BUDGET_MS);
    expect(elapsed(() => parseDelimitedText(`Date,Title,Hours,${evil}\n04/03/2026,A,1,x`, ctx))).toBeLessThan(BUDGET_MS);
    expect(elapsed(() => parseDelimitedText(`Date,Title,Hours\n04/03/2026,[${"[".repeat(N)},1`, ctx))).toBeLessThan(BUDGET_MS);
  });

  it("reads an hours cell of 100,000 digits followed by a letter in linear time", () => {
    const evil = `${"1".repeat(N)}x`;
    expect(elapsed(() => parseDelimitedText(`Date,Title,Hours\n04/03/2026,A,${evil}`, ctx))).toBeLessThan(BUDGET_MS);
    expect(elapsed(() => parseDelimitedText(`Date,Title,Duration\n04/03/2026,A,${evil}`, ctx))).toBeLessThan(BUDGET_MS);
    expect(elapsed(() => parseHoursCell({ v: `${"1 ".repeat(N / 2)}h`, link: null }, "hours", "Hours"))).toBeLessThan(BUDGET_MS);
  });

  it("reads a date cell of 100,000 characters in linear time", () => {
    expect(elapsed(() => parseDelimitedText(`Date,Title,Hours\n${"1-".repeat(N / 2)},A,1`, ctx))).toBeLessThan(BUDGET_MS);
    expect(elapsed(() => parseDateText(`04/03/2026 ${" ".repeat(N)}-`))).toBeLessThan(BUDGET_MS);
  });

  it("reads a benefits cell that holds a line of 4,000,000 spaces in linear time", () => {
    const header = "Date,Title,Hours,Key Benefits/Value added";
    const row = `04/03/2026,A,1,"How it helped: x\n${" ".repeat(4_000_000)}y"`;
    expect(elapsed(() => parseDelimitedText(`${header}\n${row}`, ctx))).toBeLessThan(700);
  });

  it("calls such cells unreadable, and does not echo them back whole", () => {
    expect(parseHoursCell({ v: "1".repeat(N), link: null }, "hours", "Hours")).toEqual({ kind: "bad", text: `${"1".repeat(77)}...` });
    const r = parseDelimitedText(`Date,Title,Hours\n${"9".repeat(N)},A,${"1".repeat(N)}x`, ctx);
    const row = r.rows[0];
    expect(row?.include).toBe(false);
    for (const i of row?.issues ?? []) expect(i.message.length).toBeLessThan(400);
    for (const c of Object.values(row?.input.confidence ?? {})) expect(c.evidence.length).toBeLessThan(400);
  });

  it("gives no header name to text over 200 characters", () => {
    expect(normHeader("(".repeat(N))).toBe("");
    expect(normHeader("a".repeat(201))).toBe("");
    expect(normHeader("a".repeat(200))).toBe("a".repeat(200));
  });

  it("still takes brackets off a normal header, and leaves a very long bracket as text", () => {
    expect(normHeader("Structural safety (Y/N)")).toBe("structural safety");
    expect(normHeader(`Hours (${"x".repeat(150)})`)).toMatch(/^hours x+$/);
  });
});

describe("limits are applied while the text is read", () => {
  const MB5 = IMPORT_LIMITS.maxBytes;

  it("calls a 5 MB file of nothing but line breaks empty, quickly", async () => {
    const buf = Buffer.alloc(MB5, 0x0a);
    const start = performance.now();
    const e = await failure(parseSpreadsheet(buf, "newlines.csv", ctx));
    expect(e.code).toBe("unreadable");
    expect(e.message).toMatch(/empty/);
    expect(performance.now() - start).toBeLessThan(2500);
  });

  it("does the same for 5 MB of empty rows, a single row of five million commas, and blank spaces", async () => {
    for (const filler of [",\n", ",", " \r\n", ",,,\r"]) {
      const buf = Buffer.from(filler.repeat(Math.floor(MB5 / filler.length)));
      const start = performance.now();
      const e = await failure(parseSpreadsheet(buf, "blank.csv", ctx));
      expect(e.code, JSON.stringify(filler)).toBe("unreadable");
      expect(e.message).toMatch(/empty/);
      expect(performance.now() - start).toBeLessThan(2500);
    }
  });

  it("works out the delimiter from the start of the file, so one 5 MB cell or one row of commas is read at once", async () => {
    const oneCell = Buffer.from(`Date,Title,Hours\n04/03/2026,${"x".repeat(MB5 - 100)},1`);
    const start = performance.now();
    const r = await parseSpreadsheet(oneCell, "cell.csv", ctx);
    expect(r.rows[0]?.input.title).toHaveLength(MB5 - 100);
    expect(performance.now() - start).toBeLessThan(2500);
    const commas = Buffer.from(",".repeat(MB5));
    const t2 = performance.now();
    await failure(parseSpreadsheet(commas, "commas.csv", ctx));
    expect(performance.now() - t2).toBeLessThan(2500);
  });

  it("stops reading a file with far too many rows, and says so", async () => {
    const lines = ["Date,Title,Hours", ...Array.from({ length: 150_000 }, (_, i) => `04/03/2026,Row ${i},1`)];
    const buf = Buffer.from(lines.join("\n"));
    expect(buf.length).toBeLessThan(MB5);
    const start = performance.now();
    const e = await failure(parseSpreadsheet(buf, "long.csv", ctx));
    expect(e.code).toBe("too_many_rows");
    expect(performance.now() - start).toBeLessThan(2500);
  });

  it("does not count blank lines, and keeps row numbers as they are in the file", () => {
    const r = parseDelimitedText(["Date,Title,Hours", "", "", "04/03/2026,A,1", "", "05/03/2026,B,1"].join("\n"), ctx);
    expect(r.rows.map((x) => x.n)).toEqual([4, 6]);
    const many = ["Date,Title,Hours", ...Array.from({ length: 5000 }, () => ""), "04/03/2026,A,1"];
    expect(parseDelimitedText(many.join("\n"), ctx).rows.map((x) => x.n)).toEqual([5002]);
  });

  it("still says no header for text that is not empty, and for an empty paste", () => {
    expect(() => parseDelimitedText("a,b,c\n1,2,3", ctx)).toThrow(/header row/);
    expect(() => parseDelimitedText("", ctx)).toThrow(/header row/);
  });

  it("limits what parseCsvRecords keeps when it is given limits", () => {
    const blank = parseCsvRecords("\n\n,\n  \n", ",", Number.POSITIVE_INFINITY, { maxNonBlank: 10 });
    expect(blank.records).toHaveLength(4);
    expect(new Set(blank.records).size).toBe(1);
    expect(blank.records[0]).toEqual([""]);
    const wide = parseCsvRecords(`a${",".repeat(5000)}`, ",", Number.POSITIVE_INFINITY, { maxFields: 100 });
    expect(wide.records[0]).toHaveLength(100);
    const cut = parseCsvRecords("a\nb\nc\nd\ne", ",", Number.POSITIVE_INFINITY, { maxNonBlank: 2 });
    expect(cut.truncated).toBe(true);
    expect(cut.records).toHaveLength(3);
    expect(parseCsvRecords("a\nb", ",", Number.POSITIVE_INFINITY, { maxNonBlank: 2 }).truncated).toBe(false);
    expect(parseCsvRecords("a\nb\nc", ",", Number.POSITIVE_INFINITY, { maxNonBlank: 2 }).truncated).toBe(true);
    // Without limits nothing changes: every record is kept as written.
    expect(parseCsvRecords("a\n\n,\n", ",").records).toEqual([["a"], [""], ["", ""]]);
  });
});
