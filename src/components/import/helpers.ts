import type { ImportIssue, ImportRow } from "@/lib/import/types";
import { minutesToHours, parseDurationMinutes, roundHours } from "@/lib/dates";

/** Limits the server enforces. Repeated here so the page can say them and stop an oversize file before it is sent. */
export const MAX_FILE_MB = 5;
export const MAX_FILE_BYTES = MAX_FILE_MB * 1024 * 1024;
export const MAX_ROWS = 2000;
export const HEADER_SCAN_ROWS = 25;

export const SPREADSHEET_ACCEPT = ".xlsx,.csv";
export const SCREENSHOT_ACCEPT = ".png,.jpg,.jpeg,.webp,.gif";
const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "webp", "gif"];

export const AI_OFF_MESSAGE =
  "Screenshots need the AI feature, which isn't switched on here. To import from a screenshot, ask the site owner to switch it on, or export your record to Excel or CSV and import that.";
export const SCREENSHOT_NOTE = "Read from a screenshot - check every field";
export const DUPLICATE_TEXT = "Looks like a duplicate (same date and title)";
export const UNREADABLE_HOURS_MESSAGE = "We can't read that as hours. Use a number such as 1.5, or a length such as 1h 30m.";
/** What the Add form and the export call a development plan ref that was not filled in. */
export const DEFAULT_PLAN_REF = "unplanned";

export function isImageFile(file: { name: string; type: string }): boolean {
  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  return IMAGE_EXTENSIONS.includes(ext) || file.type.startsWith("image/");
}

export function hasError(issues: readonly ImportIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

export function rowsLabel(n: number): string {
  return n === 1 ? "1 row" : `${n} rows`;
}

/**
 * Hours typed by hand: 1.5, 1,5, .5, or a duration such as 1h 30m. Nothing typed is 0 hours.
 * Text that is neither a number nor a duration is null, so the page can say it could not read it.
 */
export function readHoursText(text: string): number | null {
  const t = text.trim().replace(",", ".");
  if (!t) return 0;
  if (/^(\d+(\.\d*)?|\.\d+)$/.test(t)) return roundHours(Number(t));
  const minutes = parseDurationMinutes(text);
  return minutes ? minutesToHours(minutes) : null;
}

/** The same, with text that cannot be read counted as 0 (the check on the row then reports the hours). */
export function parseHoursText(text: string): number {
  return readHoursText(text) ?? 0;
}

/** A row the person has to act on: it cannot be imported as it is, or it looks like one already in the log. */
export function hasProblem(row: Pick<ImportRow, "issues" | "duplicate">): boolean {
  return row.duplicate || hasError(row.issues);
}

/** The ids the row controls use, so a message can point at the control it is about. */
export const rid = (n: number, part: string) => `import-r${n}-${part}`;
export const issuesId = (n: number) => rid(n, "issues");

/** Which control to focus for an issue on a field. Fields on the "details" panel open it first. */
const CONTROL_FOR_FIELD: Record<string, string> = {
  dateCompleted: "date",
  title: "title",
  hours: "hours",
  theme: "theme",
  category: "category",
};
const PANEL_CONTROL_FOR_FIELD: Record<string, string> = {
  learningPoints: "lp",
  benefits: "ben-helped",
  developmentGained: "dg",
  devPlanRef: "plan",
};

export function controlForIssue(row: ImportRow): { id: string; needsPanel: boolean } {
  const first = row.issues.find((i) => i.severity === "error") ?? row.issues[0];
  const field = first?.field ?? "";
  const direct = CONTROL_FOR_FIELD[field];
  if (direct) return { id: rid(row.n, direct), needsPanel: false };
  const inPanel = PANEL_CONTROL_FOR_FIELD[field];
  if (inPanel) return { id: rid(row.n, inPanel), needsPanel: true };
  return { id: `import-include-${row.n}`, needsPanel: false };
}

/** What a duplicate issue adds to the fixed sentence: where the other copy is. */
export function duplicateDetail(message: string): string {
  const inFile = /duplicate of row (\d+) in this file/i.exec(message);
  if (inFile) return `Same as row ${inFile[1]} in this file. Tick the row if you want it anyway.`;
  if (/already have an entry/i.test(message)) return "You already have an entry like this in your log. Tick the row if you want it anyway.";
  return "Tick the row if you want it anyway.";
}

const MAPPED_LABELS: Record<string, string> = {
  date: "Date",
  title: "Activity",
  theme: "Theme",
  hours: "Hours",
  minutes: "Minutes",
  duration: "Duration",
  devPlanRef: "Dev. plan ref",
  learningPoints: "Learning points",
  benefits: "Benefits",
  category: "Category",
  structuralSafety: "Structural safety",
  sustainability: "Sustainability",
  developmentGained: "Development gained",
  provider: "Provider",
  url: "Link",
};

export function mappedLabel(field: string, customLabels: ReadonlyMap<string, string>): string {
  if (field.startsWith("custom.")) return customLabels.get(field.slice("custom.".length)) ?? field.slice("custom.".length);
  return MAPPED_LABELS[field] ?? field;
}
