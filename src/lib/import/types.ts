import type { EntryInput, ProfileId, UserSettings } from "@/lib/types";

export type IssueSeverity = "error" | "warning";

export interface ImportIssue {
  severity: IssueSeverity;
  /** The EntryInput field the issue belongs to (dateCompleted, title, hours, theme, ...), or "row" / "duplicate". */
  field: string;
  /** Says what went wrong and how to fix it. */
  message: string;
}

/**
 * A warning from the first parse about how one value was read (hours read as minutes, a link left out, ...), kept with
 * the value it was about. While that value is unchanged the warning is still true, so it is shown again after a re-check.
 */
export interface ParseWarning {
  issue: ImportIssue;
  /** JSON of the value of issue.field when the warning was made. A different value means the user changed it. */
  value: string;
}

export interface ImportRow {
  /** 1-based row number in the file, as you would see it in Excel. */
  n: number;
  /** Ticked rows are imported. Rows with an error, and duplicates, start unticked. */
  include: boolean;
  input: EntryInput;
  issues: ImportIssue[];
  duplicate: boolean;
  /** The row was read from a screenshot. Kept on the row, so the screenshot warning survives every re-check. */
  fromScreenshot?: boolean;
  /** How-it-was-read warnings from the first parse. See ParseWarning. */
  parseWarnings?: ParseWarning[];
}

export interface ExistingEntryKey {
  dateCompleted: string;
  title: string;
}

export interface ImportContext {
  profile: ProfileId;
  settings: UserSettings;
  /** The user's live entries, to spot duplicates (same date and title). */
  existing: readonly ExistingEntryKey[];
  now: Date;
  /** Set when the rows were read from a screenshot: every row then carries a warning. */
  fromScreenshot?: boolean;
}

export type ImportFileKind = "xlsx" | "csv" | "text" | "screenshot";

export interface ImportResult {
  rows: ImportRow[];
  /** 1-based row number of the header row. */
  headerRow: number;
  /** Field key -> the header text it was read from. */
  mapped: Record<string, string>;
  /** Header texts that were recognised as nothing, or that do not belong to the chosen profile. They were ignored. */
  unmapped: string[];
  /** Notes about the whole file (skipped rows, ignored columns, formulas without a saved result, ...). */
  warnings: string[];
  fileKind: ImportFileKind;
}

export type ImportErrorCode =
  | "unsupported_type"
  | "too_large"
  | "too_many_rows"
  | "unreadable"
  | "no_header"
  | "no_rows"
  | "commit_blocked";

/** A problem the user can fix. The message is written for them and is safe to show. */
export class ImportError extends Error {
  readonly code: ImportErrorCode;
  constructor(message: string, code: ImportErrorCode) {
    super(message);
    this.name = "ImportError";
    this.code = code;
  }
}

export const IMPORT_LIMITS = {
  /** 5 MB */
  maxBytes: 5 * 1024 * 1024,
  maxRows: 2000,
  /** The header row must be within the first 25 rows. */
  headerScanRows: 25,
  maxColumns: 100,
} as const;

/** One cell after exceljs types, rich text, formulas and hyperlinks have been flattened. */
export type CellValue = string | number | boolean | Date | null;
export interface Cell {
  v: CellValue;
  /** The link behind a hyperlink cell (http or https only). */
  link: string | null;
}
export interface GridRow {
  /** 1-based row number in the file. */
  n: number;
  cells: Cell[];
}

export const EMPTY_CELL: Cell = { v: null, link: null };
