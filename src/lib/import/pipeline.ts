import type { BenefitParts, EntryInput, FieldConfidence } from "@/lib/types";
import { ICE_ALL_THEMES, profileLabel } from "@/lib/profiles";
import { roundHours } from "@/lib/dates";
import { DEFAULT_DEV_PLAN_REF } from "@/lib/export/rows";
import { headerScore, normPlain, type FieldKey, type HeaderMapping } from "./columns";
import {
  cellText,
  duplicateKey,
  matchCategory,
  matchTheme,
  normaliseUrl,
  parseBenefits,
  parseDateCell,
  parseHoursCell,
  parseUrlCell,
  parseYesNo,
  shorten,
  textField,
  type HoursResult,
  type HoursRole,
} from "./values";
import { duplicateWarning, existingKeys, fieldFingerprint, hasError, mergeIssues, validateEntryInput } from "./validate";
import {
  IMPORT_LIMITS,
  ImportError,
  type Cell,
  type GridRow,
  type ImportContext,
  type ImportFileKind,
  type ImportIssue,
  type ImportResult,
  type ImportRow,
  type ParseWarning,
} from "./types";

export interface PipelineOptions {
  fileKind: ImportFileKind;
  fromScreenshot: boolean;
  /** Notes made before the pipeline ran (decoding, sheets that were not read, formulas without a saved result). */
  warnings: string[];
  /** The workbook uses the 1904 date system (some Mac files). Serial numbers then start four years later. */
  date1904?: boolean;
}

const FROM_FILE = "From your file";
const FROM_SCREENSHOT = "Read from a screenshot";

const TOTAL_WORDS = new Set(["total", "totals", "grand total", "subtotal", "sub total", "total hours", "overall total", "sum", "hours total"]);

function warn(field: string, message: string): ImportIssue {
  return { severity: "warning", field, message };
}
function err(field: string, message: string): ImportIssue {
  return { severity: "error", field, message };
}

function cellAt(row: GridRow, mapping: HeaderMapping, field: FieldKey): Cell | undefined {
  const i = mapping.columns.get(field);
  return i === undefined ? undefined : row.cells[i];
}

type SkipReason = "total" | "banner" | "header";

/**
 * A cell as a total row would write it, for comparing with TOTAL_WORDS: case, punctuation and spacing ignored. Brackets
 * are not removed, so a real activity called "Total (2025)" or "@SUM(1)" is not mistaken for a total. A total word is
 * short, so anything longer is not looked at.
 */
const totalKey = (text: string): string => (text.length > 40 ? "" : normPlain(text));

/** Rows that are not entries: totals, merged section headings, and a header repeated further down (page breaks). */
function skipReason(row: GridRow, mapping: HeaderMapping, ctx: ImportContext, date1904: boolean): SkipReason | null {
  const texts = row.cells.map((c) => cellText(c)).filter(Boolean);
  const first = texts[0];
  if (first !== undefined && TOTAL_WORDS.has(totalKey(first))) return "total";
  for (const f of ["date", "title"] as const) {
    const t = cellText(cellAt(row, mapping, f));
    if (t && TOTAL_WORDS.has(totalKey(t))) return "total";
  }
  if (texts.length >= 2 && texts.every((t) => t === first)) return "banner";
  const { score } = headerScore(row.cells, ctx.profile, ctx.settings);
  if (score >= Math.max(2, Math.ceil(mapping.columns.size / 2))) {
    const date = parseDateCell(cellAt(row, mapping, "date"), date1904);
    if (date.kind !== "ok") return "header";
  }
  return null;
}

interface HoursOutcome {
  hours: number;
  confidence: FieldConfidence;
  issues: ImportIssue[];
}

interface HoursColumn {
  role: HoursRole;
  header: string;
  cell: Cell | undefined;
  result: HoursResult;
}
type ReadColumn = HoursColumn & { result: Extract<HoursResult, { kind: "ok" }> };

const isRead = (c: HoursColumn): c is ReadColumn => c.result.kind === "ok";

function hoursColumn(row: GridRow, mapping: HeaderMapping, role: HoursRole): HoursColumn {
  const cell = cellAt(row, mapping, role);
  const header = mapping.headers.get(role) ?? role;
  return { role, header, cell, result: cell ? parseHoursCell(cell, role, header) : { kind: "empty" } };
}

function unreadableHours(text: string): HoursOutcome {
  return {
    hours: 0,
    confidence: { level: "missing", evidence: `Could not read "${shorten(text)}"` },
    issues: [
      err(
        "hours",
        `Hours "${shorten(text)}" is not a duration we can read. Use a number of hours such as 1.5, or text such as 1h 30m or 90 mins.`,
      ),
    ],
  };
}

/** A secondary column (Minutes, Time, Duration) that holds something but cannot be read: said, but it does not stop the row. */
function ignoredColumnWarning(c: HoursColumn, used: string): ImportIssue | null {
  return c.result.kind === "bad"
    ? warn("hours", `The "${c.header}" column ("${shorten(c.result.text)}") could not be read as a time, so ${used} was used instead.`)
    : null;
}

/**
 * The Hours column is the one that counts: when it has a readable value, that is the figure. Minutes is added to it (an
 * "Hours" and a "Minutes" column are two halves of one time), and a Time or Duration column is only a second opinion that
 * is not used. Only when Hours is empty are Minutes and then Duration read. An unreadable value in the Hours column stops
 * the row. An unreadable value in a column that was not needed is a warning, because the row has its hours.
 */
function resolveHours(row: GridRow, mapping: HeaderMapping): HoursOutcome {
  const missing: HoursOutcome = { hours: 0, confidence: { level: "missing", evidence: "No hours in your file" }, issues: [] };
  const hours = hoursColumn(row, mapping, "hours");
  const minutes = hoursColumn(row, mapping, "minutes");
  const duration = hoursColumn(row, mapping, "duration");

  if (hours.result.kind === "bad") return unreadableHours(hours.result.text);

  if (isRead(hours)) {
    if (isRead(minutes)) {
      const total = roundHours(hours.result.hours + minutes.result.hours);
      return {
        hours: total,
        confidence: { level: "low", evidence: `${FROM_FILE}, the hours and minutes columns added together` },
        issues: [
          warn(
            "hours",
            `Added the "${hours.header}" column (${shorten(cellText(hours.cell))}) and the "${minutes.header}" column (${shorten(cellText(minutes.cell))}) together: ${total} hours. Check this is right.`,
          ),
        ],
      };
    }
    const issues: ImportIssue[] = hours.result.reading ? [warn("hours", hours.result.reading)] : [];
    for (const other of [minutes, duration]) {
      const w = ignoredColumnWarning(other, `the "${hours.header}" column`);
      if (w) issues.push(w);
    }
    return { hours: hours.result.hours, confidence: { level: hours.result.guessed ? "low" : "high", evidence: hours.result.evidence }, issues };
  }

  const pick = [minutes, duration].find(isRead);
  if (!pick) {
    const bad = [minutes, duration].find((c) => c.result.kind === "bad");
    return bad && bad.result.kind === "bad" ? unreadableHours(bad.result.text) : missing;
  }
  const issues: ImportIssue[] = pick.result.reading ? [warn("hours", pick.result.reading)] : [];
  for (const other of [minutes, duration]) {
    if (other === pick) continue;
    const w = ignoredColumnWarning(other, `the "${pick.header}" column`);
    if (w) issues.push(w);
  }
  return { hours: pick.result.hours, confidence: { level: pick.result.guessed ? "low" : "high", evidence: pick.result.evidence }, issues };
}

const PROVIDER_LINE = /^provider\s*:\s*(.+)$/i;

/** ICE's "Details of CPD activity" holds the title, "Provider: ...", and a link on separate lines. Read them apart. */
function splitDetails(text: string): { title: string; provider: string; url: string } {
  const kept: string[] = [];
  let provider = "";
  let url = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const p = PROVIDER_LINE.exec(line);
    if (p && !provider) {
      provider = (p[1] ?? "").trim();
    } else if (/^(?:https?:\/\/|www\.)\S+$/i.test(line) && !url && normaliseUrl(line)) {
      url = normaliseUrl(line) ?? "";
    } else {
      kept.push(line);
    }
  }
  const title = kept.join(" - ").replace(/\s+/g, " ").trim();
  // A cell that holds nothing but a link: the person pasted the link as the name, so it is the title too.
  return { title: title || url, provider, url };
}

function present(level: FieldConfidence["level"] = "high"): FieldConfidence {
  return { level, evidence: FROM_FILE };
}

function buildImportRow(row: GridRow, mapping: HeaderMapping, ctx: ImportContext, opts: PipelineOptions): ImportRow {
  const issues: ImportIssue[] = [];
  const confidence: Record<string, FieldConfidence> = {};
  const profile = ctx.profile;
  const has = (f: FieldKey) => mapping.columns.has(f);

  // Title (and the provider and link that may sit in the same cell).
  const titleCell = cellAt(row, mapping, "title");
  const details = splitDetails(textField(titleCell));
  const title = details.title;
  confidence.title = title ? present() : { level: "missing", evidence: "No title in your file" };

  // Provider and link.
  let provider = textField(cellAt(row, mapping, "provider")) || details.provider;
  provider = provider.replace(/\s+/g, " ").trim();
  let url: string | null = null;
  const urlCell = cellAt(row, mapping, "url");
  const urlRes = parseUrlCell(urlCell);
  if (urlRes.kind === "ok") url = urlRes.url;
  else if (urlRes.kind === "bad") {
    issues.push(warn("url", `The link "${shorten(urlRes.text)}" does not start with http:// or https://, so it was left out.`));
  }
  if (!url && details.url) url = details.url;
  if (!url && titleCell?.link) url = normaliseUrl(titleCell.link);
  if (provider) confidence.provider = present();
  if (url) confidence.url = present();

  // Date.
  const dateRes = parseDateCell(cellAt(row, mapping, "date"), opts.date1904 ?? false);
  let dateCompleted = "";
  let dateEnd: string | null = null;
  if (dateRes.kind === "ok") {
    dateCompleted = dateRes.start;
    dateEnd = dateRes.end;
    confidence.dateCompleted = present();
    if (dateRes.note) issues.push(warn("dateEnd", dateRes.note));
  } else if (dateRes.kind === "bad") {
    issues.push(err("dateCompleted", `Date "${shorten(dateRes.text)}" is not a date we can read. Use day, month, year, for example 04/03/2026.`));
    confidence.dateCompleted = { level: "missing", evidence: `Could not read "${shorten(dateRes.text)}"` };
  } else {
    confidence.dateCompleted = { level: "missing", evidence: "No date in your file" };
  }

  // Hours.
  const hoursOutcome = resolveHours(row, mapping);
  confidence.hours = hoursOutcome.confidence;
  issues.push(...hoursOutcome.issues);

  // Profile fields.
  let theme: string | null = null;
  let category: string | null = null;
  let structuralSafety: boolean | null = null;
  let sustainability: boolean | null = null;
  let learningPoints = "";
  let benefits: BenefitParts = { helped: "", future: "", nextYear: "" };
  let developmentGained = "";
  const custom: Record<string, string> = {};

  const devPlan = textField(cellAt(row, mapping, "devPlanRef")).replace(/\s+/g, " ");
  const devPlanRef = devPlan || DEFAULT_DEV_PLAN_REF;
  if (devPlan) confidence.devPlanRef = present();

  if (has("learningPoints") || profile === "ice") {
    learningPoints = textField(cellAt(row, mapping, "learningPoints"));
  }
  if (has("benefits")) benefits = parseBenefits(textField(cellAt(row, mapping, "benefits")));

  if (profile === "ice") {
    const text = textField(cellAt(row, mapping, "theme"));
    const match = matchTheme(text, ICE_ALL_THEMES);
    if (match.kind === "exact") {
      theme = match.value;
      confidence.theme = present();
    } else if (match.kind === "fuzzy") {
      theme = match.value;
      confidence.theme = { level: "low", evidence: `${FROM_FILE} ("${shorten(text)}"), matched to "${match.value}"` };
    } else if (match.kind === "none") {
      issues.push(warn("theme", `The theme "${shorten(match.text)}" is not one of the ICE CPD Framework themes, so it was left blank. Choose one on the review screen.`));
      confidence.theme = { level: "missing", evidence: `Not matched: "${shorten(match.text)}"` };
    } else {
      confidence.theme = { level: "missing", evidence: has("theme") ? "No theme in your file" : "No theme column in your file" };
    }
    confidence.learningPoints = learningPoints ? present() : { level: "missing", evidence: "No learning points in your file" };
    const anyBenefit = Object.values(benefits).some((b) => b.trim());
    confidence.benefits = anyBenefit ? present() : { level: "missing", evidence: "No benefits in your file" };
  }

  if (profile === "istructe") {
    const text = textField(cellAt(row, mapping, "category"));
    const match = matchCategory(text);
    if (match.kind === "exact") {
      category = match.value;
      confidence.category = present();
    } else if (match.kind === "fuzzy") {
      category = match.value;
      confidence.category = { level: "low", evidence: `${FROM_FILE} ("${shorten(text)}"), matched to "${match.value}"` };
    } else if (match.kind === "none") {
      issues.push(warn("category", `The category "${shorten(match.text)}" is not one of the IStructE categories, so it was left blank. Choose one on the review screen.`));
      confidence.category = { level: "missing", evidence: `Not matched: "${shorten(match.text)}"` };
    } else {
      confidence.category = { level: "missing", evidence: has("category") ? "No category in your file" : "No category column in your file" };
    }
    for (const [field, label] of [["structuralSafety", "Structural safety"], ["sustainability", "Sustainability"]] as const) {
      const res = parseYesNo(cellAt(row, mapping, field));
      let value: boolean | null = null;
      if (res.kind === "ok") {
        value = res.value;
        confidence[field] = present();
      } else if (res.kind === "bad") {
        issues.push(warn(field, `${label} "${shorten(res.text)}" was not understood, so it was left blank. Use Y or N.`));
        confidence[field] = { level: "missing", evidence: `Could not read "${shorten(res.text)}"` };
      }
      if (field === "structuralSafety") structuralSafety = value;
      else sustainability = value;
    }
    developmentGained = textField(cellAt(row, mapping, "developmentGained"));
    confidence.developmentGained = developmentGained ? present() : { level: "missing", evidence: "No development gained in your file" };
    if (learningPoints) confidence.learningPoints = present();
  }

  if (profile === "custom") {
    for (const def of ctx.settings.customFields) {
      const key = `custom.${def.key}` as const;
      const cell = cellAt(row, mapping, key);
      if (!cell) continue;
      let value = "";
      if (def.type === "date") {
        const r = parseDateCell(cell, opts.date1904 ?? false);
        if (r.kind === "ok") value = r.start;
        else if (r.kind === "bad") {
          value = textField(cell);
          issues.push(warn(key, `${def.label} "${shorten(r.text)}" is not a date we can read, so it was kept as text.`));
        }
      } else if (def.type === "yes_no") {
        const r = parseYesNo(cell);
        if (r.kind === "ok") value = r.value ? "yes" : "no";
        else if (r.kind === "bad") {
          issues.push(warn(key, `${def.label} "${shorten(r.text)}" was not understood, so it was left blank. Use Yes or No.`));
        }
      } else {
        value = textField(cell);
      }
      if (value) {
        // defineProperty, so a field key such as "__proto__" becomes an ordinary own property.
        Object.defineProperty(custom, def.key, { value, enumerable: true, writable: true, configurable: true });
        confidence[key] = present();
      }
    }
    if (learningPoints) confidence.learningPoints = present();
  }

  const input: EntryInput = {
    profile,
    title,
    url,
    provider: provider || null,
    sourceType: "other",
    publishedAt: null,
    dateCompleted,
    dateEnd,
    detectedDurationMinutes: null,
    hours: hoursOutcome.hours,
    hoursConfirmed: true,
    theme,
    category,
    structuralSafety,
    sustainability,
    devPlanRef,
    learningPoints,
    benefits,
    developmentGained,
    custom,
    notes: "",
    aiAssisted: false,
    confidence,
  };

  if (opts.fromScreenshot) {
    for (const [k, c] of Object.entries(confidence)) {
      if (c.level !== "missing") confidence[k] = { level: "low", evidence: FROM_SCREENSHOT };
    }
  }

  const merged = mergeIssues(issues, validateEntryInput(input, { now: ctx.now, fromScreenshot: opts.fromScreenshot }));
  // The reading warnings are kept with the value they are about, so a re-check can show them again while that value
  // is unchanged. The screenshot flag is kept on the row, so no caller has to remember to set it again.
  const parseWarnings: ParseWarning[] = issues
    .filter((i) => i.severity === "warning")
    .map((issue) => ({ issue, value: fieldFingerprint(input, issue.field) }));
  return {
    n: row.n,
    include: !hasError(merged),
    input,
    issues: merged,
    duplicate: false,
    ...(opts.fromScreenshot ? { fromScreenshot: true } : {}),
    ...(parseWarnings.length > 0 ? { parseWarnings } : {}),
  };
}

/** Fills in duplicate flags in file order: a row is a duplicate of an existing entry or of an earlier row in the file. */
export function markDuplicates(rows: ImportRow[], existing: ImportContext["existing"]): void {
  const have = existingKeys(existing);
  const seen = new Map<string, number>();
  for (const row of rows) {
    const key = duplicateKey(row.input.dateCompleted, row.input.title);
    row.duplicate = false;
    if (!key) continue;
    if (have.has(key)) {
      row.duplicate = true;
      row.issues.push(duplicateWarning("existing"));
    } else if (seen.has(key)) {
      row.duplicate = true;
      row.issues.push(duplicateWarning("file", seen.get(key)));
    }
    if (!seen.has(key)) seen.set(key, row.n);
    if (row.duplicate) row.include = false;
  }
}

function rowList(ns: number[]): string {
  return ns.length === 1 ? `row ${ns[0]}` : `rows ${ns.join(", ")}`;
}

/** "which looks like" for one row, "which look like" for several. */
function whichAre(ns: number[], one: string, many: string): string {
  return `which ${ns.length === 1 ? one : many}`;
}

/** The shared pipeline: grid rows plus the chosen header row become import rows, notes and the column map. */
export function buildResult(rows: readonly GridRow[], headerIndex: number, mapping: HeaderMapping, ctx: ImportContext, opts: PipelineOptions): ImportResult {
  const header = rows[headerIndex];
  if (!header) throw new ImportError("We could not find the header row. Check the file and try again.", "no_header");
  const body = rows.slice(headerIndex + 1);
  if (body.length > IMPORT_LIMITS.maxRows) {
    throw new ImportError(
      `That file has ${body.length} rows below the header, which is over the limit of ${IMPORT_LIMITS.maxRows}. Split it into smaller files, for example one per year, and import them one at a time.`,
      "too_many_rows",
    );
  }

  const warnings = [...opts.warnings];
  const date1904 = opts.date1904 ?? false;
  const skipped: Record<SkipReason, number[]> = { total: [], banner: [], header: [] };
  const out: ImportRow[] = [];
  for (const row of body) {
    const reason = skipReason(row, mapping, ctx, date1904);
    if (reason) {
      skipped[reason].push(row.n);
      continue;
    }
    out.push(buildImportRow(row, mapping, ctx, opts));
  }
  if (skipped.total.length) warnings.push(`Skipped ${rowList(skipped.total)}, ${whichAre(skipped.total, "looks", "look")} like a total.`);
  if (skipped.banner.length) {
    warnings.push(`Skipped ${rowList(skipped.banner)}, ${whichAre(skipped.banner, "looks", "look")} like a merged heading and not an entry.`);
  }
  if (skipped.header.length) warnings.push(`Skipped ${rowList(skipped.header)}, ${whichAre(skipped.header, "repeats", "repeat")} the header row.`);

  if (out.length === 0) {
    throw new ImportError(
      `No entries were found below the header row (row ${header.n}). Check that your entries start on the row after the column names.`,
      "no_rows",
    );
  }
  markDuplicates(out, ctx.existing);

  const has = (f: FieldKey) => mapping.columns.has(f);
  if (!has("date")) warnings.push("No date column was found, so every row needs a date before it can be imported.");
  if (!has("title")) warnings.push("No title column was found, so every row needs a title before it can be imported.");
  if (!has("hours") && !has("minutes") && !has("duration")) {
    warnings.push("No hours column was found, so every row needs its hours before it can be imported.");
  }
  if (ctx.profile === "ice" && !has("theme")) {
    warnings.push("There is no theme column, so the rows have no ICE theme. You can choose one for each row on the review screen.");
  }
  if (ctx.profile === "istructe" && !has("category")) {
    warnings.push("There is no category column, so the rows have no IStructE category. You can choose one for each row on the review screen.");
  }
  if (mapping.ignoredForProfile.length) {
    warnings.push(`Left out columns that belong to a different profile than ${profileLabel(ctx.profile)}: ${mapping.ignoredForProfile.join(", ")}.`);
  }
  if (ctx.profile === "custom") {
    const unused = ctx.settings.customFields.filter((f) => !has(`custom.${f.key}`)).map((f) => f.label);
    if (unused.length && ctx.settings.customFields.length) {
      warnings.push(`No column matched these custom fields, so they were left empty: ${unused.join(", ")}. A column must have the same name as the field.`);
    }
  }

  const mapped: Record<string, string> = {};
  for (const [field, text] of mapping.headers) mapped[field] = text;
  return { rows: out, headerRow: header.n, mapped, unmapped: mapping.unmapped, warnings, fileKind: opts.fileKind };
}
