import { createInflateRaw } from "node:zlib";
import ExcelJS from "exceljs";
import { ImportError, IMPORT_LIMITS, EMPTY_CELL, type Cell, type CellValue, type GridRow } from "./types";
import { cleanCellString, isEmptyCell } from "./values";

/** An .xlsx file is a zip. Everything inside it, unpacked, may not be bigger than this. */
const MAX_UNPACKED_BYTES = 80 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 2000;
/**
 * A sheet may not hold more row elements than this, whatever is in them (rows that only carry formatting count). The
 * limit on entries is far lower (see IMPORT_LIMITS.maxRows), but this one is checked before the workbook is loaded, and
 * a workbook with hundreds of thousands of rows costs seconds and hundreds of megabytes to load.
 */
const MAX_SHEET_ROW_ELEMENTS = 50_000;

const UNREADABLE =
  "We could not open that file as an .xlsx workbook. If it is password protected, remove the password first. Otherwise open it in Excel, save it again as .xlsx, and upload the new file.";
const TOO_BIG_UNPACKED =
  "That workbook is much bigger than its file size suggests once it is opened, so it was not read. Remove unused sheets or formatting, or copy the entries into a new file, and try again.";
const TOO_MANY_SHEET_ROWS = `That sheet has far more than ${IMPORT_LIMITS.maxRows} rows, which is over the limit. Many of them may be empty rows that only carry formatting. Delete the unused rows, or copy your entries into a new file, and try again. If it really has that many entries, split it into smaller files, for example one per year.`;

interface ZipEntry {
  name: string;
  /** 0 = stored, 8 = deflated. */
  method: number;
  compressedSize: number;
  /** What the directory says. Only a hint: the real size is measured by inflating. */
  declaredSize: number;
  localOffset: number;
}

/** The zip's central directory, checked for shape. Throws "unreadable" for anything that is not a plain, non-zip64 zip. */
function readZipDirectory(buf: Buffer): ZipEntry[] {
  if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new ImportError(UNREADABLE, "unreadable");
  const lowest = Math.max(0, buf.length - 22 - 65535);
  let eocd = -1;
  for (let i = buf.length - 22; i >= lowest; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ImportError(UNREADABLE, "unreadable");
  const total = buf.readUInt16LE(eocd + 10);
  const dirOffset = buf.readUInt32LE(eocd + 16);
  if (total === 0xffff || dirOffset === 0xffffffff || total > MAX_ZIP_ENTRIES) throw new ImportError(UNREADABLE, "unreadable");
  const entries: ZipEntry[] = [];
  let p = dirOffset;
  for (let k = 0; k < total; k++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ImportError(UNREADABLE, "unreadable");
    const nameLength = buf.readUInt16LE(p + 28);
    if (p + 46 + nameLength > buf.length) throw new ImportError(UNREADABLE, "unreadable");
    entries.push({
      name: buf.toString("utf8", p + 46, p + 46 + nameLength),
      method: buf.readUInt16LE(p + 10),
      compressedSize: buf.readUInt32LE(p + 20),
      declaredSize: buf.readUInt32LE(p + 24),
      localOffset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLength + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return entries;
}

/**
 * A quick look at the zip directory before anything is unpacked: a directory that already admits to an unpacked size
 * over the limit is refused. The directory is written by whoever made the file, so this is only the cheap first check.
 * verifyXlsxUnpackedSize is the one that cannot be fooled.
 */
export function inspectXlsxZip(buf: Buffer): void {
  let declared = 0;
  for (const e of readZipDirectory(buf)) declared += e.declaredSize;
  if (declared > MAX_UNPACKED_BYTES) throw new ImportError(TOO_BIG_UNPACKED, "too_large");
}

/** Counts the `<row` elements of a sheet as its text goes past in pieces, without keeping any of it. */
class RowCounter {
  count = 0;
  private tail = "";
  push(chunk: Buffer): void {
    const text = this.tail + chunk.toString("latin1");
    const found = text.match(/<row[\s/>]/g);
    if (found) this.count += found.length;
    // "<row" plus the next character is 5 long, so a match cannot sit entirely inside the last 4 characters.
    this.tail = text.slice(-4);
  }
}

/**
 * Inflates one deflated entry into nothing, only counting. Stops with "too_large" the moment the count passes the budget,
 * so a few kilobytes that expand into gigabytes are never held in memory. Feeds each piece to onChunk.
 */
function inflateCounting(data: Buffer, budget: number, onChunk?: (chunk: Buffer) => void): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const inflater = createInflateRaw({ chunkSize: 64 * 1024 });
    let size = 0;
    let settled = false;
    const fail = (e: unknown) => {
      if (settled) return;
      settled = true;
      inflater.destroy();
      reject(e);
    };
    inflater.on("data", (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > budget) {
        fail(new ImportError(TOO_BIG_UNPACKED, "too_large"));
        return;
      }
      try {
        onChunk?.(chunk);
      } catch (e) {
        fail(e);
      }
    });
    inflater.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(size);
    });
    inflater.on("error", () => fail(new ImportError(UNREADABLE, "unreadable")));
    inflater.end(data);
  });
}

/**
 * Measures what the workbook really unpacks to, ignoring the sizes written in the zip directory (which a file can
 * lie about, and which the zip reader only checks after it has inflated everything). Every entry is located through its
 * own local header and compressed size, and inflated with a running total that stops at the limit. Also stops a sheet
 * that has an absurd number of rows before it is loaded. Throws ImportError.
 */
export async function verifyXlsxUnpackedSize(buf: Buffer): Promise<void> {
  let total = 0;
  for (const e of readZipDirectory(buf)) {
    const at = e.localOffset;
    if (at + 30 > buf.length || buf.readUInt32LE(at) !== 0x04034b50) throw new ImportError(UNREADABLE, "unreadable");
    const start = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
    const end = start + e.compressedSize;
    if (end > buf.length) throw new ImportError(UNREADABLE, "unreadable");
    const data = buf.subarray(start, end);
    if (data.length === 0) continue;
    if (e.method === 0) {
      total += data.length;
      if (total > MAX_UNPACKED_BYTES) throw new ImportError(TOO_BIG_UNPACKED, "too_large");
      continue;
    }
    if (e.method !== 8) throw new ImportError(UNREADABLE, "unreadable");
    const counter = /\.xml$/i.test(e.name) ? new RowCounter() : null;
    total += await inflateCounting(data, MAX_UNPACKED_BYTES - total, (chunk) => {
      if (!counter) return;
      counter.push(chunk);
      if (counter.count > MAX_SHEET_ROW_ELEMENTS) throw new ImportError(TOO_MANY_SHEET_ROWS, "too_many_rows");
    });
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function richTextOf(v: unknown): string | null {
  if (isObject(v) && Array.isArray(v.richText)) {
    return v.richText.map((t) => (isObject(t) && typeof t.text === "string" ? t.text : "")).join("");
  }
  return null;
}

function httpLink(v: unknown): string | null {
  return typeof v === "string" && /^https?:\/\//i.test(v.trim()) ? v.trim() : null;
}

export interface FlattenOutcome {
  cell: Cell;
  /** A formula with no saved result: nothing to read. */
  formulaWithoutResult: boolean;
}

/**
 * One exceljs cell value to a plain cell: strings, numbers, dates (UTC), rich text joined, formula results
 * (never calculated here), and hyperlink text with its link.
 */
export function flattenCellValue(value: ExcelJS.CellValue | undefined): FlattenOutcome {
  const plain = (v: CellValue, link: string | null = null): FlattenOutcome => ({ cell: { v, link }, formulaWithoutResult: false });
  if (value === null || value === undefined) return { cell: EMPTY_CELL, formulaWithoutResult: false };
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return plain(value);
  if (value instanceof Date) return plain(Number.isNaN(value.getTime()) ? null : value);
  if (!isObject(value)) return { cell: EMPTY_CELL, formulaWithoutResult: false };

  const rich = richTextOf(value);
  if (rich !== null) return plain(rich);

  if ("formula" in value || "sharedFormula" in value) {
    const result = (value as { result?: unknown }).result;
    if (result === undefined || result === null) return { cell: EMPTY_CELL, formulaWithoutResult: true };
    if (isObject(result) && "error" in result) return plain(String(result.error));
    const inner = flattenCellValue(result as ExcelJS.CellValue);
    return { cell: inner.cell, formulaWithoutResult: false };
  }
  if ("hyperlink" in value) {
    const link = httpLink((value as { hyperlink?: unknown }).hyperlink);
    const text = (value as { text?: unknown }).text;
    const inner = typeof text === "string" ? text : (richTextOf(text) ?? "");
    return plain(inner || link, link);
  }
  if ("error" in value) return plain(String((value as { error: unknown }).error));
  return { cell: EMPTY_CELL, formulaWithoutResult: false };
}

export interface SheetRead {
  name: string;
  rows: GridRow[];
  formulaCellsWithoutResult: number;
  /** Rows that hold something but are hidden in the file (a filter may be on). They are read like any other row. */
  hiddenRows: number;
}

/** Reads one worksheet into non-empty rows. Throws when the sheet clearly has more rows than the limit. */
export function readSheet(ws: ExcelJS.Worksheet): SheetRead {
  const rows: GridRow[] = [];
  let formulaCellsWithoutResult = 0;
  let hiddenRows = 0;
  // A header row, up to 2000 entries and a little slack for notes and blank-looking rows.
  const cap = IMPORT_LIMITS.maxRows + IMPORT_LIMITS.headerScanRows;
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    const cells: Cell[] = [];
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (colNumber > IMPORT_LIMITS.maxColumns) return;
      const out = flattenCellValue(cell.value);
      if (out.formulaWithoutResult) formulaCellsWithoutResult += 1;
      const text = typeof out.cell.v === "string" ? cleanCellString(out.cell.v) : out.cell.v;
      cells[colNumber - 1] = { v: text === "" ? null : text, link: out.cell.link };
    });
    for (let i = 0; i < cells.length; i++) cells[i] ??= EMPTY_CELL;
    if (cells.every((c) => isEmptyCell(c))) return;
    if (rows.length >= cap) {
      throw new ImportError(
        `That sheet has more than ${IMPORT_LIMITS.maxRows} rows, which is over the limit. Split it into smaller files, for example one per year, and import them one at a time.`,
        "too_many_rows",
      );
    }
    if (row.hidden) hiddenRows += 1;
    rows.push({ n: rowNumber, cells });
  });
  return { name: ws.name, rows, formulaCellsWithoutResult, hiddenRows };
}

export interface LoadedWorkbook {
  workbook: ExcelJS.Workbook;
  date1904: boolean;
}

export async function loadWorkbook(buf: Buffer): Promise<LoadedWorkbook> {
  inspectXlsxZip(buf);
  await verifyXlsxUnpackedSize(buf);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buf as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  } catch (e) {
    if (e instanceof ImportError) throw e;
    throw new ImportError(UNREADABLE, "unreadable");
  }
  return { workbook, date1904: Boolean(workbook.properties?.date1904) };
}
