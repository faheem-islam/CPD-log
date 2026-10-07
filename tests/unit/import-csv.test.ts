import { describe, expect, it } from "vitest";
import { decodeCsvBytes, detectDelimiter, parseCsvRecords } from "@/lib/import/csv";
import { ImportError } from "@/lib/import/types";
import { parseDelimitedText, parseSpreadsheet } from "@/lib/import/parse";
import { csv, makeCtx } from "./import-test-helpers";

describe("parseCsvRecords (RFC 4180)", () => {
  it("splits simple records", () => {
    expect(parseCsvRecords("a,b,c\n1,2,3", ",").records).toEqual([["a", "b", "c"], ["1", "2", "3"]]);
  });

  it("reads quoted fields with commas, doubled quotes and line breaks", () => {
    const text = 'a,"b, with comma","say ""hi""","line one\nline two"\n1,2,3,4';
    expect(parseCsvRecords(text, ",").records).toEqual([
      ["a", "b, with comma", 'say "hi"', "line one\nline two"],
      ["1", "2", "3", "4"],
    ]);
  });

  it("handles CRLF, LF and CR between records, and CRLF inside quotes", () => {
    expect(parseCsvRecords("a,b\r\n1,2\r\n", ",").records).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsvRecords("a,b\r1,2\r", ",").records).toEqual([["a", "b"], ["1", "2"]]);
    expect(parseCsvRecords('"x\r\ny",z', ",").records).toEqual([["x\r\ny", "z"]]);
  });

  it("keeps empty fields and a trailing delimiter", () => {
    expect(parseCsvRecords("a,,c,\n,,,", ",").records).toEqual([["a", "", "c", ""], ["", "", "", ""]]);
  });

  it("keeps blank lines as records so row numbers match the file", () => {
    expect(parseCsvRecords("a,b\n\n1,2\n", ",").records).toEqual([["a", "b"], [""], ["1", "2"]]);
  });

  it("has no phantom record after the last line break, and keeps a last line without one", () => {
    expect(parseCsvRecords("a\n", ",").records).toEqual([["a"]]);
    expect(parseCsvRecords("a", ",").records).toEqual([["a"]]);
    expect(parseCsvRecords("", ",").records).toEqual([]);
  });

  it("keeps a quote in the middle of an unquoted field as text", () => {
    expect(parseCsvRecords('5" pipe,ok', ",").records).toEqual([['5" pipe', "ok"]]);
  });

  it("keeps a quoted empty string as an empty field", () => {
    expect(parseCsvRecords('"",a', ",").records).toEqual([["", "a"]]);
    expect(parseCsvRecords('a,""', ",").records).toEqual([["a", ""]]);
  });

  it("tolerates text after a closing quote", () => {
    expect(parseCsvRecords('"abc"def,x', ",").records).toEqual([["abcdef", "x"]]);
  });

  it("flags a quote that is never closed and keeps the text", () => {
    const r = parseCsvRecords('a,"never closed\nb,c', ",");
    expect(r.unterminatedQuote).toBe(true);
    expect(r.records).toEqual([["a", "never closed\nb,c"]]);
    expect(parseCsvRecords('a,"closed"', ",").unterminatedQuote).toBe(false);
  });

  it("stops at maxRecords", () => {
    expect(parseCsvRecords("a\nb\nc\nd", ",", 2).records).toEqual([["a"], ["b"]]);
  });

  it("works with semicolon and tab delimiters, and a comma inside is plain text", () => {
    expect(parseCsvRecords("a;b,c;d", ";").records).toEqual([["a", "b,c", "d"]]);
    expect(parseCsvRecords("a\tb c\td", "\t").records).toEqual([["a", "b c", "d"]]);
  });
});

describe("detectDelimiter", () => {
  it("detects comma, semicolon and tab", () => {
    expect(detectDelimiter("Date,Title,Hours\n04/03/2026,A,1.5")).toBe(",");
    expect(detectDelimiter("Date;Title;Hours\n04/03/2026;A;1,5")).toBe(";");
    expect(detectDelimiter("Date\tTitle\tHours\n04/03/2026\tA\t1.5")).toBe("\t");
  });
  it("is not fooled by comma decimals in a semicolon file", () => {
    expect(detectDelimiter("Date;Title;Hours\n04/03/2026;A;1,5\n05/03/2026;B;2,25\n06/03/2026;C;0,5")).toBe(";");
  });
  it("is not fooled by commas inside quoted text in a tab file", () => {
    expect(detectDelimiter('Date\tTitle\tHours\n04/03/2026\t"A, B, C"\t1\n05/03/2026\t"D, E"\t2')).toBe("\t");
  });
  it("is not fooled by semicolons inside quoted text in a comma file", () => {
    expect(detectDelimiter('Date,Title,Hours\n04/03/2026,"A; B; C",1\n05/03/2026,"D; E",2')).toBe(",");
  });
  it("copes with a header-only file", () => {
    expect(detectDelimiter("Date;Title;Hours")).toBe(";");
    expect(detectDelimiter("Date\tTitle\tHours")).toBe("\t");
  });
  it("falls back to comma for a single column", () => {
    expect(detectDelimiter("just one column\nanother line")).toBe(",");
    expect(detectDelimiter("")).toBe(",");
  });
});

describe("decodeCsvBytes", () => {
  it("strips a UTF-8 BOM", () => {
    const d = decodeCsvBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Date,Title\n", "utf8")]));
    expect(d.text).toBe("Date,Title\n");
    expect(d.notes).toEqual([]);
  });
  it("reads UTF-8 with accents", () => {
    expect(decodeCsvBytes(Buffer.from("Café – ok", "utf8")).text).toBe("Café – ok");
  });
  it("reads UTF-16 LE and BE with a BOM", () => {
    const le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Date,Title", "utf16le")]);
    expect(decodeCsvBytes(le).text).toBe("Date,Title");
    const be = Buffer.from(le.subarray(2));
    be.swap16();
    expect(decodeCsvBytes(Buffer.concat([Buffer.from([0xfe, 0xff]), be])).text).toBe("Date,Title");
  });
  it("falls back to Windows-1252 and says so", () => {
    const d = decodeCsvBytes(Buffer.from([0x43, 0x61, 0x66, 0xe9, 0x20, 0x93, 0x71, 0x94]));
    expect(d.text).toBe("Café “q”");
    expect(d.notes[0]).toMatch(/not UTF-8/);
  });
  it("refuses a binary file with a clear message", () => {
    try {
      decodeCsvBytes(Buffer.from([0x50, 0x00, 0x01, 0x02]));
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(ImportError);
      expect((e as ImportError).code).toBe("unreadable");
      expect((e as ImportError).message).toMatch(/save it again as CSV/);
    }
  });
});

describe("parseDelimitedText and CSV files", () => {
  const ctx = makeCtx();

  it("reads a comma file with quotes and embedded newlines in a cell", () => {
    const text = [
      "Date,Title,Hours,Key Learning Points",
      '04/03/2026,"Test, with comma",1.5,"First line',
      'second line with ""quotes"""',
      "05/03/2026,Plain,2,Short",
    ].join("\n");
    const r = parseDelimitedText(text, ctx);
    expect(r.fileKind).toBe("text");
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]?.input.title).toBe("Test, with comma");
    expect(r.rows[0]?.input.learningPoints).toBe('First line\nsecond line with "quotes"');
    // Row numbers count records, as Excel does, not physical lines: the first entry spans two lines.
    expect(r.rows[1]?.n).toBe(3);
  });

  it("reads a semicolon file with comma decimals", () => {
    const r = parseDelimitedText("Date;Title;Hours\n04/03/2026;A;1,5\n05/03/2026;B;0,25", ctx);
    expect(r.rows.map((x) => x.input.hours)).toEqual([1.5, 0.25]);
  });

  it("reads a tab file", () => {
    const r = parseDelimitedText("Date\tTitle\tHours\n04/03/2026\tA\t1.5", ctx);
    expect(r.rows[0]?.input.hours).toBe(1.5);
  });

  it("reads CRLF line endings and a BOM at the start of the text", () => {
    const r = parseDelimitedText("﻿Date,Title,Hours\r\n04/03/2026,A,1\r\n05/03/2026,B,2\r\n", ctx);
    expect(r.headerRow).toBe(1);
    expect(r.rows).toHaveLength(2);
    expect(r.mapped.date).toBe("Date");
  });

  it("warns when a quote is never closed", () => {
    const r = parseDelimitedText('Date,Title,Hours\n04/03/2026,"A,1', ctx);
    expect(r.warnings.some((w) => /never closed/.test(w))).toBe(true);
  });

  it("reads a .csv file from bytes", async () => {
    const r = await parseSpreadsheet(csv(["Date,Title,Hours", "04/03/2026,A,1"]), "mine.csv", ctx);
    expect(r.fileKind).toBe("csv");
    expect(r.rows).toHaveLength(1);
  });

  it("reads a .csv file with a BOM, CRLF and an upper-case extension", async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Date,Title,Hours\r\n04/03/2026,A,1\r\n", "utf8")]);
    const r = await parseSpreadsheet(bytes, "MINE.CSV", ctx);
    expect(r.rows).toHaveLength(1);
    expect(r.headerRow).toBe(1);
  });

  it("passes on the note when a CSV was not UTF-8", async () => {
    const bytes = Buffer.concat([Buffer.from("Date,Title,Hours\n04/03/2026,Caf", "latin1"), Buffer.from([0xe9]), Buffer.from(",1", "latin1")]);
    const r = await parseSpreadsheet(bytes, "latin.csv", ctx);
    expect(r.rows[0]?.input.title).toBe("Café");
    expect(r.warnings.some((w) => /Windows-1252/.test(w))).toBe(true);
  });

  it("finds a header that is not on row 1, with junk above it and blank lines", () => {
    const text = ["My CPD record", "", "Printed on a test day", "Date,Title,Hours", "04/03/2026,A,1"].join("\n");
    const r = parseDelimitedText(text, ctx);
    expect(r.headerRow).toBe(4);
    expect(r.rows[0]?.n).toBe(5);
  });
});
