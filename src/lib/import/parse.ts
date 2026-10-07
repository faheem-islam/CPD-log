import type { ProfileId } from "@/lib/types";
import { PROFILES } from "@/lib/profiles";
import { findHeaderRow } from "./columns";
import { decodeCsvBytes, detectDelimiter, parseCsvRecords } from "./csv";
import { buildResult } from "./pipeline";
import { isEmptyCell } from "./values";
import { loadWorkbook, readSheet } from "./xlsx";
import {
  IMPORT_LIMITS,
  ImportError,
  type Cell,
  type GridRow,
  type ImportContext,
  type ImportFileKind,
  type ImportResult,
} from "./types";

export { ImportError, IMPORT_LIMITS } from "./types";
export type { ImportContext, ImportIssue, ImportResult, ImportRow, ImportFileKind } from "./types";

const NO_HEADER =
  `We could not find a header row in the first ${IMPORT_LIMITS.headerScanRows} rows. The file needs a row of column names, such as Date, Title and Hours, with your entries below it. Add one and try again.`;

function extensionOf(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function unsupportedMessage(filename: string, ext: string): string {
  const name = filename.split(/[\\/]/).pop() || "That file";
  const shown = name.length > 80 ? `${name.slice(0, 77)}...` : name;
  const how = "Open it in Excel, choose Save as, pick Excel Workbook (.xlsx) or CSV, and upload the new file.";
  if (ext === ".xls") return `"${shown}" is an old .xls file, which we cannot read. ${how}`;
  if (ext === ".xlsm" || ext === ".xlsb") return `"${shown}" is a ${ext} file. We only read plain .xlsx files. ${how}`;
  return `"${shown}" is not an .xlsx or .csv file. ${how}`;
}

function recordsToGrid(records: readonly string[][]): GridRow[] {
  const rows: GridRow[] = [];
  records.forEach((rec, i) => {
    // A blank line is skipped before any cell is made for it, so a file of line breaks costs almost nothing.
    if (rec.length === 1 && (rec[0] ?? "").trim() === "") return;
    const cells: Cell[] = rec.slice(0, IMPORT_LIMITS.maxColumns).map((f) => ({ v: f.trim() === "" ? null : f, link: null }));
    if (cells.every((c) => isEmptyCell(c))) return;
    rows.push({ n: i + 1, cells });
  });
  return rows;
}

export interface DelimitedOptions {
  /** The text was transcribed from a screenshot: every row gets a warning and its fields show Check. */
  fromScreenshot?: boolean;
  /** Notes to add to the file warnings (for example from decoding). */
  extraWarnings?: string[];
  fileKind?: ImportFileKind;
}

/**
 * CSV, semicolon or tab separated text to import rows. The delimiter is detected. Used for .csv files,
 * pasted text and screenshot transcriptions, so they all go through the same checks.
 */
export function parseDelimitedText(text: string, ctx: ImportContext, opts: DelimitedOptions = {}): ImportResult {
  const fromScreenshot = opts.fromScreenshot ?? ctx.fromScreenshot ?? false;
  if (text.length > IMPORT_LIMITS.maxBytes) {
    throw new ImportError(`That text is over ${megabytes(IMPORT_LIMITS.maxBytes)}, which is the limit. Split it into smaller parts and import them one at a time.`, "too_large");
  }
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const delimiter = detectDelimiter(clean);
  // The limits are applied while reading, so a file of nothing but line breaks, or one with endless columns, costs
  // almost nothing, and a file with far too many rows is stopped after the first few thousand.
  const rowCap = IMPORT_LIMITS.maxRows + IMPORT_LIMITS.headerScanRows;
  const { records, unterminatedQuote, truncated } = parseCsvRecords(clean, delimiter, Number.POSITIVE_INFINITY, {
    maxNonBlank: rowCap,
    maxFields: IMPORT_LIMITS.maxColumns + 1,
  });
  const rows = recordsToGrid(records);
  if (truncated || rows.length > rowCap) {
    throw new ImportError(
      `That file has more than ${IMPORT_LIMITS.maxRows} rows, which is over the limit. Split it into smaller files, for example one per year, and import them one at a time.`,
      "too_many_rows",
    );
  }
  if (rows.length === 0 && opts.fileKind === "csv") {
    throw new ImportError("That file is empty. Choose a file that has your entries in it.", "unreadable");
  }
  const found = findHeaderRow(rows, ctx.profile, ctx.settings);
  if (!found) throw new ImportError(NO_HEADER, "no_header");
  const warnings = [...(opts.extraWarnings ?? [])];
  if (unterminatedQuote) {
    warnings.push("A quoted value was opened and never closed, so the end of the file may have been merged into one cell. Check the last rows.");
  }
  const fileKind: ImportFileKind = opts.fileKind ?? (fromScreenshot ? "screenshot" : "text");
  return buildResult(rows, found.index, found.mapping, { ...ctx, fromScreenshot }, { fileKind, fromScreenshot, warnings });
}

/** Sheets to try: the one named like the profile's own export first, then the rest in order. Hidden sheets are skipped. */
function sheetOrder<T extends { name: string; state?: string }>(sheets: T[], profile: ProfileId): T[] {
  const visible = sheets.filter((s) => s.state === undefined || s.state === "visible");
  const wanted = PROFILES[profile].sheetName.toLowerCase();
  return [...visible.filter((s) => s.name.toLowerCase() === wanted), ...visible.filter((s) => s.name.toLowerCase() !== wanted)];
}

/**
 * An .xlsx or .csv file to import rows. Refuses other file types, files over 5 MB, and more than 2000 rows,
 * with a message the user can act on. Formulas are never calculated: only the result Excel saved is read.
 */
export async function parseSpreadsheet(buffer: Buffer, filename: string, ctx: ImportContext): Promise<ImportResult> {
  const ext = extensionOf(filename);
  if (ext !== ".xlsx" && ext !== ".csv") throw new ImportError(unsupportedMessage(filename, ext), "unsupported_type");
  if (buffer.length === 0) throw new ImportError("That file is empty. Choose a file that has your entries in it.", "unreadable");
  if (buffer.length > IMPORT_LIMITS.maxBytes) {
    throw new ImportError(
      `That file is ${megabytes(buffer.length)}, which is over the ${megabytes(IMPORT_LIMITS.maxBytes)} limit. Remove old rows or unused sheets, or split it into smaller files, and try again.`,
      "too_large",
    );
  }

  if (ext === ".csv") {
    const { text, notes } = decodeCsvBytes(buffer);
    return parseDelimitedText(text, ctx, { fileKind: "csv", extraWarnings: notes, fromScreenshot: false });
  }

  const { workbook, date1904 } = await loadWorkbook(buffer);
  const sheets = sheetOrder(workbook.worksheets, ctx.profile);
  for (const ws of sheets) {
    const read = readSheet(ws);
    const found = findHeaderRow(read.rows, ctx.profile, ctx.settings);
    if (!found) continue;
    const warnings: string[] = [];
    if (sheets.length > 1) warnings.push(`Only the sheet "${read.name}" was read. The other sheets in the file were ignored.`);
    if (read.hiddenRows > 0) {
      warnings.push(
        `${read.hiddenRows} ${read.hiddenRows === 1 ? "row is" : "rows are"} hidden in the file (a filter may be switched on). Hidden rows were read like the others, so untick any you do not want.`,
      );
    }
    if (read.formulaCellsWithoutResult > 0) {
      warnings.push(
        `${read.formulaCellsWithoutResult} ${read.formulaCellsWithoutResult === 1 ? "cell holds a formula" : "cells hold formulas"} with no saved result, so ${read.formulaCellsWithoutResult === 1 ? "it was" : "they were"} read as blank. Formulas are never calculated here. Open the file in Excel, save it, and import it again.`,
      );
    }
    return buildResult(read.rows, found.index, found.mapping, { ...ctx, fromScreenshot: false }, { fileKind: "xlsx", fromScreenshot: false, warnings, date1904 });
  }
  throw new ImportError(NO_HEADER, "no_header");
}
