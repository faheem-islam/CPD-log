import ExcelJS from "exceljs";
import type { Entry, ProfileId, UserSettings } from "@/lib/types";
import { ICE_ALL_THEMES, PROFILES } from "@/lib/profiles";
import { formatUkDate, isoToUtcDate, roundHours, todayUk, yearOf } from "@/lib/dates";
import {
  assertOwnEntries,
  checkYear,
  exportRows,
  iceHeaderBlock,
  normaliseProfiles,
  selectEntries,
  type ExportCell,
  type ExportColumn,
  type ExportTable,
  type ExportYear,
} from "./rows";
import { clampCell, cleanText, escapeOoxmlText, safeText } from "./safe-text";

export interface BuildWorkbookInput {
  entries: readonly Entry[];
  settings: UserSettings;
  profiles: readonly ProfileId[];
  year: ExportYear;
  now: Date;
  /** When given, every entry must belong to this user or the export is refused. Entries of more than one user are always refused. */
  userId?: string;
}

export const DATE_FORMAT = "dd/mm/yyyy";
export const HOURS_FORMAT = "0.00";
export const SUMMARY_SHEET = "Summary";

const HEADER_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFDCE6F0" } };
const NOTE_FILL: ExcelJS.Fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFFFF2CC" } };
const HEADER_BORDER: Partial<ExcelJS.Borders> = { bottom: { style: "thin", color: { argb: "FF7A90A8" } } };

/** Row of the table header in each sheet. The data starts on the row after it. */
export const HEADER_ROW: Record<ProfileId, number> = { ice: 4, istructe: 3, custom: 1 };

/** A valid Excel sheet name: at most 31 characters, none of [ ] : * ? / \, no leading or trailing apostrophe, unique. */
export function safeSheetName(name: string, used: ReadonlySet<string> = new Set()): string {
  let n = cleanText(name).replace(/\s+/g, " ").replace(/[[\]:*?/\\]/g, "-").trim();
  n = n.replace(/^'+|'+$/g, "").trim();
  if (!n) n = "Sheet";
  n = n.slice(0, 31);
  const taken = (s: string) => used.has(s.toLowerCase());
  if (!taken(n)) return n;
  for (let i = 2; i < 1000; i++) {
    const suffix = ` (${i})`;
    const candidate = `${n.slice(0, 31 - suffix.length)}${suffix}`;
    if (!taken(candidate)) return candidate;
  }
  return `Sheet ${used.size + 1}`;
}

export function columnLetter(n: number): string {
  let s = "";
  let x = n;
  while (x > 0) {
    const r = (x - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    x = Math.floor((x - 1) / 26);
  }
  return s;
}

interface BuildStats {
  clampedCells: number;
}

function writeText(cell: ExcelJS.Cell, value: string, stats: BuildStats): void {
  const { text, clamped } = clampCell(escapeOoxmlText(value));
  if (clamped) stats.clampedCells += 1;
  cell.value = text;
}

function writeCell(ws: ExcelJS.Worksheet, rowNumber: number, colIndex: number, cell: ExportCell, col: ExportColumn, stats: BuildStats): void {
  const c = ws.getCell(rowNumber, colIndex);
  switch (cell.kind) {
    case "text":
      writeText(c, cell.value, stats);
      break;
    case "date":
      c.value = isoToUtcDate(cell.iso);
      c.numFmt = DATE_FORMAT;
      break;
    case "hours":
      c.value = cell.value;
      c.numFmt = HOURS_FORMAT;
      break;
    case "number":
      c.value = cell.value;
      break;
    default:
      break;
  }
  // A date range is written as text ("04/05/2026 - 06/05/2026") and is wider than a date column. It wraps onto two lines,
  // because text that does not fit is cut off at the next cell that has a value, and the end date would be lost on screen
  // and on paper. A single date is a real date cell and always fits.
  const rangeText = col.type === "date" && cell.kind === "text";
  c.alignment = { vertical: "top", wrapText: col.wrap || rangeText };
}

function styleHeaderCell(c: ExcelJS.Cell): void {
  c.font = { bold: true };
  c.fill = HEADER_FILL;
  c.border = HEADER_BORDER;
  c.alignment = { vertical: "top", wrapText: true };
}

function writeTableHeader(ws: ExcelJS.Worksheet, rowNumber: number, columns: ExportColumn[]): void {
  columns.forEach((col, i) => {
    const c = ws.getCell(rowNumber, i + 1);
    c.value = escapeOoxmlText(col.label);
    styleHeaderCell(c);
  });
}

function setWidths(ws: ExcelJS.Worksheet, columns: ExportColumn[]): void {
  columns.forEach((col, i) => {
    ws.getColumn(i + 1).width = col.width;
  });
}

function addProfileSheet(wb: ExcelJS.Workbook, table: ExportTable, settings: UserSettings, usedNames: Set<string>, stats: BuildStats): ExcelJS.Worksheet {
  const profile = table.profile;
  const name = safeSheetName(PROFILES[profile].sheetName, usedNames);
  usedNames.add(name.toLowerCase());
  const ws = wb.addWorksheet(name);
  const headerRow = HEADER_ROW[profile];
  const nCols = table.columns.length;
  setWidths(ws, table.columns);

  if (profile === "ice") {
    // Rows 1-2: name, job role and responsibilities, engineering sector. Row 3 stays empty.
    const block = iceHeaderBlock(settings);
    block.forEach((b, i) => {
      const label = ws.getCell(1, i + 1);
      label.value = b.label;
      styleHeaderCell(label);
      const value = ws.getCell(2, i + 1);
      if (b.value) writeText(value, b.value, stats);
      value.alignment = { vertical: "top", wrapText: true };
    });
  }

  if (profile === "istructe") {
    // The provisional note sits above the table header in a merged cell, so nobody can miss it.
    const note = cleanText(PROFILES.istructe.provisionalNote);
    ws.mergeCells(1, 1, 1, nCols);
    const c = ws.getCell(1, 1);
    c.value = note;
    c.font = { bold: true };
    c.fill = NOTE_FILL;
    c.alignment = { vertical: "top", wrapText: true };
    const totalWidth = table.columns.reduce((t, col) => t + col.width, 0);
    const lines = Math.max(1, Math.ceil(note.length / Math.max(20, totalWidth - 10)));
    ws.getRow(1).height = Math.max(32, lines * 16 + 6);
  }

  writeTableHeader(ws, headerRow, table.columns);

  table.rows.forEach((row, r) => {
    const rowNumber = headerRow + 1 + r;
    row.cells.forEach((cell, i) => {
      const col = table.columns[i];
      if (col) writeCell(ws, rowNumber, i + 1, cell, col, stats);
    });
  });

  const lastRow = headerRow + Math.max(1, table.rows.length);
  ws.autoFilter = `A${headerRow}:${columnLetter(nCols)}${lastRow}`;
  ws.views = [{ state: "frozen", xSplit: 0, ySplit: headerRow, topLeftCell: `A${headerRow + 1}`, activeCell: `A${headerRow + 1}` }];
  return ws;
}

// ---------------------------------------------------------------------------------------------------------------
// Summary sheet

/** A string, a number of hours (shown 0.00), a whole-number count (shown 0), or nothing. */
type SummaryCell = string | number | { count: number } | null;

interface SummaryRow {
  /** A year is written as a real number. */
  label: string | number;
  cells: SummaryCell[];
}

function sumHours(entries: readonly Entry[]): number {
  return roundHours(entries.reduce((t, e) => t + (Number.isFinite(e.hours) ? e.hours : 0), 0));
}

function lineHeight(text: string, charsPerLine: number): number {
  return Math.max(1, Math.ceil(text.length / charsPerLine)) * 15 + 3;
}

function hoursAndCount(es: readonly Entry[]): SummaryCell[] {
  return [sumHours(es), { count: es.length }];
}

function addSummarySheet(
  wb: ExcelJS.Workbook,
  input: { profiles: ProfileId[]; byProfile: Map<ProfileId, Entry[]>; year: ExportYear; now: Date },
  usedNames: Set<string>,
  stats: BuildStats,
): void {
  const name = safeSheetName(SUMMARY_SHEET, usedNames);
  usedNames.add(name.toLowerCase());
  const ws = wb.addWorksheet(name);
  ws.getColumn(1).width = 46;
  for (let i = 2; i <= 5; i++) ws.getColumn(i).width = 16;

  let row = 1;
  const title = ws.getCell(row, 1);
  title.value = "CPD summary";
  title.font = { bold: true, size: 14 };
  row += 1;
  ws.getCell(row, 1).value =
    input.year === "all"
      ? "Entries from all years. Deleted entries are not included."
      : `Entries from ${input.year}. Deleted entries are not included.`;
  row += 2;

  const writeSection = (heading: string, header: string[], rows: SummaryRow[], opts: { total?: SummaryRow; note?: string } = {}): void => {
    const h = ws.getCell(row, 1);
    h.value = heading;
    h.font = { bold: true, size: 12 };
    row += 1;
    header.forEach((label, i) => {
      const c = ws.getCell(row, i + 1);
      c.value = label;
      styleHeaderCell(c);
    });
    row += 1;
    const writeRow = (r: SummaryRow, bold: boolean): void => {
      const l = ws.getCell(row, 1);
      if (typeof r.label === "number") {
        l.value = r.label;
        l.numFmt = "0";
        l.alignment = { horizontal: "left" };
      } else {
        writeText(l, safeText(r.label), stats);
      }
      if (bold) l.font = { bold: true };
      r.cells.forEach((v, i) => {
        if (v === null) return;
        const c = ws.getCell(row, i + 2);
        if (typeof v === "number") {
          c.value = v;
          c.numFmt = HOURS_FORMAT;
        } else if (typeof v === "string") {
          c.value = safeText(v);
        } else {
          c.value = v.count;
          c.numFmt = "0";
        }
        if (bold) c.font = { bold: true };
      });
      row += 1;
    };
    rows.forEach((r) => writeRow(r, false));
    if (opts.total) writeRow(opts.total, true);
    if (opts.note) {
      const n = ws.getCell(row, 1);
      n.value = opts.note;
      n.font = { italic: true };
      row += 1;
    }
    row += 1;
  };

  // Hours and entries by profile. Hours are not added across profiles: the same learning can be logged under more than one.
  writeSection(
    "Hours by profile",
    ["Profile", "Hours", "Entries"],
    input.profiles.map((p) => ({ label: PROFILES[p].label, cells: hoursAndCount(input.byProfile.get(p) ?? []) })),
    { note: "Hours are not added across profiles, because the same learning can be logged under more than one." },
  );

  // Hours by year, one column per requested profile.
  const years = new Set<number>();
  for (const p of input.profiles) for (const e of input.byProfile.get(p) ?? []) years.add(yearOf(e.dateCompleted));
  const sortedYears = [...years].filter((y) => Number.isFinite(y)).sort((a, b) => a - b);
  writeSection(
    "Hours by year",
    ["Year", ...input.profiles.map((p) => PROFILES[p].label)],
    sortedYears.map((y) => ({
      label: y,
      cells: input.profiles.map((p) => sumHours((input.byProfile.get(p) ?? []).filter((e) => yearOf(e.dateCompleted) === y))),
    })),
    {
      total: { label: "Total", cells: input.profiles.map((p) => sumHours(input.byProfile.get(p) ?? [])) },
      note: "An entry that runs over several days is counted in the year of its first day.",
    },
  );

  if (input.profiles.includes("ice")) {
    const es = input.byProfile.get("ice") ?? [];
    const known = new Set(ICE_ALL_THEMES);
    const other = [...new Set(es.map((e) => cleanText(e.theme)).filter((t) => t && !known.has(t)))].sort();
    const rows: SummaryRow[] = [...ICE_ALL_THEMES, ...other].map((t) => ({
      label: t,
      cells: hoursAndCount(es.filter((e) => cleanText(e.theme) === t)),
    }));
    const none = es.filter((e) => !cleanText(e.theme));
    if (none.length > 0) rows.push({ label: "No theme set", cells: hoursAndCount(none) });
    writeSection("ICE hours by theme", ["Theme", "Hours", "Entries"], rows, { total: { label: "Total", cells: hoursAndCount(es) } });
  }

  if (input.profiles.includes("istructe")) {
    const es = input.byProfile.get("istructe") ?? [];
    const cats: readonly string[] = PROFILES.istructe.categories;
    const known = new Set(cats);
    const other = [...new Set(es.map((e) => cleanText(e.category)).filter((c) => c && !known.has(c)))].sort();
    const rows: SummaryRow[] = [...cats, ...other].map((c) => ({
      label: c,
      cells: hoursAndCount(es.filter((e) => cleanText(e.category) === c)),
    }));
    const none = es.filter((e) => !cleanText(e.category));
    if (none.length > 0) rows.push({ label: "No category set", cells: hoursAndCount(none) });
    const safety = sumHours(es.filter((e) => e.structuralSafety === true));
    const sust = sumHours(es.filter((e) => e.sustainability === true));
    writeSection("IStructE hours by category", ["Category", "Hours", "Entries"], rows, {
      total: { label: "Total", cells: hoursAndCount(es) },
      note: `Marked structural safety (Y): ${safety.toFixed(2)} hours. Marked sustainability (Y): ${sust.toFixed(2)} hours. Provisional layout.`,
    });
  }

  if (input.profiles.includes("custom")) {
    const es = input.byProfile.get("custom") ?? [];
    writeSection("Hours for your custom profile", ["Measure", "Value"], [
      { label: "Hours", cells: [sumHours(es)] },
      { label: "Entries", cells: [{ count: es.length }] },
    ]);
  }

  // About this file
  const about = ws.getCell(row, 1);
  about.value = "About this file";
  about.font = { bold: true, size: 12 };
  row += 1;
  const allIncluded = input.profiles.flatMap((p) => input.byProfile.get(p) ?? []);
  const unconfirmed = allIncluded.filter((e) => !e.hoursConfirmed).length;
  const lines: string[] = [
    "The ICE CPD tool has no import feature, so this file is for your own records or to attach. You copy entries across by hand.",
    "ICE and IStructE both accept CPD records in other formats if the content is complete. Check their current guidance before you rely on this layout.",
    "Values were entered or reviewed by you in CPD Logger. Anything detected automatically from a link or file should be checked by you before you rely on it.",
    "The IStructE layout is provisional. It is based on published guidance, not on the real My Account form.",
    `Generated on ${formatUkDate(todayUk(input.now))} by CPD Logger.`,
  ];
  if (unconfirmed > 0) {
    lines.splice(3, 0, `${unconfirmed} ${unconfirmed === 1 ? "entry has" : "entries have"} effective learning time you have not confirmed.`);
  }
  if (stats.clampedCells > 0) {
    lines.push(`${stats.clampedCells} ${stats.clampedCells === 1 ? "cell was" : "cells were"} shortened to fit Excel's cell size limit.`);
  }
  for (const line of lines) {
    ws.mergeCells(row, 1, row, 5);
    const c = ws.getCell(row, 1);
    c.value = line;
    c.alignment = { vertical: "top", wrapText: true };
    ws.getRow(row).height = lineHeight(line, 100);
    row += 1;
  }
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * One workbook: a sheet per requested profile, then a Summary sheet.
 * Dates are real Excel dates (UTC midnight, dd/mm/yyyy), hours are numbers, yes/no is "Y" or "N" text.
 * Deleted entries are never included. A profile with no entries still gets its sheet with the header.
 */
export async function buildWorkbook(input: BuildWorkbookInput): Promise<Buffer> {
  const profiles = normaliseProfiles(input.profiles);
  checkYear(input.year);
  assertOwnEntries(input.entries, input.userId);
  const wb = new ExcelJS.Workbook();
  wb.creator = "CPD Logger";
  wb.lastModifiedBy = "CPD Logger";
  wb.created = input.now;
  wb.modified = input.now;
  wb.title = "CPD log";

  const stats: BuildStats = { clampedCells: 0 };
  const usedNames = new Set<string>();
  const byProfile = new Map<ProfileId, Entry[]>();
  for (const p of profiles) {
    const table = exportRows(p, input.entries, input.settings, { year: input.year });
    byProfile.set(p, selectEntries(input.entries, p, input.year));
    addProfileSheet(wb, table, input.settings, usedNames, stats);
  }
  addSummarySheet(wb, { profiles, byProfile, year: input.year, now: input.now }, usedNames, stats);

  const out = await wb.xlsx.writeBuffer();
  return Buffer.from(out as ArrayBuffer);
}

/** A file name for the download, for example cpd-log-2026.xlsx or cpd-log-all-years-2026-10-07.xlsx. */
export function exportFilename(year: ExportYear, now: Date): string {
  return year === "all" ? `cpd-log-all-years-${todayUk(now)}.xlsx` : `cpd-log-${year}.xlsx`;
}

