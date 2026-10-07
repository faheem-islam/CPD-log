import type { EntryInput, ProfileId } from "@/lib/types";
import { PROFILE_IDS } from "@/lib/types";
import { markDuplicates } from "./pipeline";
import { duplicateWarning, existingKeys, fieldFingerprint, hardIssues, hasError, sanitiseInput, sortIssues, validateEntryInput } from "./validate";
import { duplicateKey } from "./values";
import { IMPORT_LIMITS, ImportError, type ImportContext, type ImportIssue, type ImportRow, type ParseWarning } from "./types";

const isString = (v: unknown): v is string => typeof v === "string";
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === "string";
const isBoolOrNull = (v: unknown): v is boolean | null => v === null || typeof v === "boolean";
const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True when a value has the shape of an EntryInput. Rows that come back from a browser are checked before they are trusted. */
export function looksLikeEntryInput(v: unknown): v is EntryInput {
  if (!isPlainObject(v)) return false;
  const b = v.benefits;
  return (
    PROFILE_IDS.includes(v.profile as ProfileId) &&
    [v.title, v.dateCompleted, v.devPlanRef, v.learningPoints, v.developmentGained, v.notes, v.sourceType].every(isString) &&
    [v.url, v.provider, v.publishedAt, v.dateEnd, v.theme, v.category].every(isStringOrNull) &&
    [v.structuralSafety, v.sustainability].every(isBoolOrNull) &&
    typeof v.hours === "number" &&
    typeof v.hoursConfirmed === "boolean" &&
    typeof v.aiAssisted === "boolean" &&
    (v.detectedDurationMinutes === null || typeof v.detectedDurationMinutes === "number") &&
    isPlainObject(b) &&
    [b.helped, b.future, b.nextYear].every(isString) &&
    isPlainObject(v.custom) &&
    Object.values(v.custom).every(isString) &&
    isPlainObject(v.confidence)
  );
}

const RELOAD = "Reload the page, read the file again, and try again.";

/** The error for rows that came back from a browser in the wrong shape. Plain words, nothing from the value itself. */
function badRows(): ImportError {
  return new ImportError(`The rows were not in the expected format. ${RELOAD}`, "commit_blocked");
}

function badRow(n: number): ImportError {
  return new ImportError(`Row ${n} is not in the expected format. ${RELOAD}`, "commit_blocked");
}

/** The row number to name in a message: the row's own n when it is a sensible number, else its place in the list. */
function rowNumber(row: unknown, index: number): number {
  const n = isPlainObject(row) ? row.n : undefined;
  return typeof n === "number" && Number.isSafeInteger(n) && n > 0 ? n : index + 1;
}

function assertRowList(rows: unknown): asserts rows is readonly unknown[] {
  if (!Array.isArray(rows)) throw badRows();
}

function tooManyRows(): ImportError {
  return new ImportError(`You can import up to ${IMPORT_LIMITS.maxRows} rows at a time. Untick some rows, or split the file, and try again.`, "too_many_rows");
}

function checkedInput(input: unknown, n: number): EntryInput {
  if (!looksLikeEntryInput(input)) throw badRow(n);
  return input;
}

/** The checks on one entry, with the duplicate keys of the existing entries already built. */
function validateWithKeys(input: EntryInput, profile: ProfileId, ctx: ImportContext, keys: ReadonlySet<string>): ImportIssue[] {
  const checked: EntryInput = input.profile === profile ? input : { ...input, profile };
  const issues = validateEntryInput(checked, ctx);
  const key = duplicateKey(checked.dateCompleted, checked.title);
  if (key && keys.has(key)) issues.push(duplicateWarning("existing"));
  return sortIssues(issues);
}

/**
 * The same checks as the first parse, run again on an entry the user has edited on the review screen.
 * Duplicates are looked for in ctx.existing only. To also catch duplicates between rows of the file, use revalidateRows.
 * Throws an ImportError, in plain words, when the entry is not shaped like an entry (it came from a browser).
 */
export function validateImportRow(input: EntryInput, profile: ProfileId, ctx: ImportContext): ImportIssue[] {
  const checked = checkedInput(input, 1);
  return validateWithKeys(checked, profile, ctx, existingKeys(ctx.existing));
}

function isParseWarning(v: unknown): v is ParseWarning {
  if (!isPlainObject(v) || !isString(v.value) || !isPlainObject(v.issue)) return false;
  const issue = v.issue;
  return issue.severity === "warning" && isString(issue.field) && issue.field.length <= 80 && isString(issue.message) && issue.message.length <= 500;
}

/** The first parse's warnings whose value the user has not changed since, as they should be shown now. */
function keptParseWarnings(list: unknown, input: EntryInput): ParseWarning[] {
  if (!Array.isArray(list)) return [];
  return list.slice(0, 50).filter((w): w is ParseWarning => isParseWarning(w) && fieldFingerprint(input, w.issue.field) === w.value);
}

/**
 * Re-checks every row after an edit: issues, duplicates (against existing entries and earlier rows) and the tick box.
 * A row with an error is unticked. A row whose only problem was fixed is ticked again. Otherwise the user's choice stays.
 * The first parse's warnings about how a value was read (for example hours read as minutes) stay on a row for as long
 * as the value they are about is unchanged. They go when the user edits that value, because the user has then looked at it.
 * A row read from a screenshot keeps its screenshot warning without the caller having to say so again.
 * Throws an ImportError, in plain words, when the rows are not shaped like rows (they came from a browser).
 */
export function revalidateRows(rows: readonly ImportRow[], ctx: ImportContext): ImportRow[] {
  assertRowList(rows);
  if (rows.length > IMPORT_LIMITS.maxRows) throw tooManyRows();
  const next: ImportRow[] = rows.map((row, i) => {
    if (!isPlainObject(row)) throw badRow(i + 1);
    const n = rowNumber(row, i);
    const source = checkedInput(row.input, n);
    const input: EntryInput = source.profile === ctx.profile ? source : { ...source, profile: ctx.profile };
    const fromScreenshot = ctx.fromScreenshot === true || row.fromScreenshot === true;
    const kept = keptParseWarnings(row.parseWarnings, input);
    const fresh = validateEntryInput(input, { now: ctx.now, fromScreenshot });
    const extra: ImportIssue[] = kept
      .filter((w) => !fresh.some((f) => f.field === w.issue.field && f.message === w.issue.message))
      .map((w) => ({ severity: "warning", field: w.issue.field, message: w.issue.message }));
    const out: ImportRow = { n, include: row.include === true, input, issues: sortIssues([...fresh, ...extra]), duplicate: false };
    if (row.fromScreenshot === true) out.fromScreenshot = true;
    if (kept.length > 0) out.parseWarnings = kept;
    return out;
  });
  markDuplicates(next, ctx.existing);
  return next.map((row, i) => {
    const prev = rows[i];
    if (!prev) return row;
    const errorNow = hasError(row.issues);
    let include = prev.include === true;
    if (errorNow) include = false;
    else if (hadError(prev.issues)) include = !row.duplicate;
    else if (row.duplicate && !prev.duplicate) include = false;
    else if (!row.duplicate && prev.duplicate && !prev.include) include = true;
    return { ...row, include, issues: sortIssues(row.issues) };
  });
}

/** True when a list of issues that may have come from a browser holds an error. Anything that is not an issue is ignored. */
function hadError(issues: unknown): boolean {
  return Array.isArray(issues) && issues.some((i) => isPlainObject(i) && i.severity === "error");
}

/** What a browser may say about a problem: a short text. Never a whole value that someone chose to send. */
function plainMessage(v: unknown): string {
  return typeof v === "string" && v.length > 0 ? v.slice(0, 300) : "This row has a problem.";
}

/**
 * The rows to save: only ticked rows, as EntryInput. Errors block the commit.
 * The row's own issue list is not trusted, because it may have come from the browser: the blocking checks are run
 * again on the input itself, and with a context the full checks are too. Throws ImportError if any ticked row has an error.
 * With a context, the profile is forced to ctx.profile, custom values are limited to the user's own custom fields, and
 * what the messages promise is done: an end date that is not a date and a link that is not http or https are dropped.
 * Without one, the same checks run on the input as it is, and anything the store would refuse blocks the commit.
 * The cost does not grow with the number of existing entries times the number of rows: the duplicate keys are built once.
 */
export function commitRows(rows: readonly ImportRow[], ctx?: ImportContext): EntryInput[] {
  assertRowList(rows);
  let ticked = 0;
  for (const row of rows) if (isPlainObject(row) && row.include === true) ticked += 1;
  if (ticked > IMPORT_LIMITS.maxRows) throw tooManyRows();

  const keys = ctx ? existingKeys(ctx.existing) : null;
  const out: EntryInput[] = [];
  for (const [index, row] of rows.entries()) {
    if (!isPlainObject(row)) throw badRow(index + 1);
    if (row.include !== true) continue;
    const n = rowNumber(row, index);
    const original = checkedInput(row.input, n);
    const input = ctx ? forProfile(original, ctx) : original;
    const errors = [
      ...(Array.isArray(row.issues) ? row.issues : []).filter((i) => isPlainObject(i) && i.severity === "error"),
      ...(ctx && keys ? validateWithKeys(input, ctx.profile, ctx, keys) : hardIssues(input)).filter((i) => i.severity === "error"),
    ];
    const first = errors[0];
    if (first) {
      throw new ImportError(`Row ${n} still has a problem: ${plainMessage(first.message)} Fix it, or untick the row to leave it out.`, "commit_blocked");
    }
    out.push(input);
  }
  if (out.length > IMPORT_LIMITS.maxRows) throw tooManyRows();
  return out;
}

function forProfile(input: EntryInput, ctx: ImportContext): EntryInput {
  const allowed = new Set(ctx.settings.customFields.map((f) => f.key));
  const custom = ctx.profile === "custom" ? Object.fromEntries(Object.entries(input.custom).filter(([k]) => allowed.has(k))) : {};
  const out: EntryInput = { ...sanitiseInput(input), profile: ctx.profile, custom };
  // Columns that belong to one profile are not carried into another.
  if (ctx.profile !== "ice") out.theme = null;
  if (ctx.profile !== "istructe") {
    out.category = null;
    out.structuralSafety = null;
    out.sustainability = null;
    out.developmentGained = "";
  }
  return out;
}
