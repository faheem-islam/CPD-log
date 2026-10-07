import type { CustomFieldDef, Entry, ProfileId, UserSettings } from "@/lib/types";
import { PROFILES, isProfileId } from "@/lib/profiles";
import { composeBenefits } from "@/lib/benefits";
import { formatUkDate, isValidYmd, parseUkDate, roundHours, yearOf } from "@/lib/dates";
import { cleanText, safeText } from "./safe-text";

/** What the Dev. Plan ref column shows when the entry has none. */
export const DEFAULT_DEV_PLAN_REF = "unplanned";

export type ExportColumnType = "text" | "date" | "hours" | "number" | "yesno";

export interface ExportColumn {
  key: string;
  label: string;
  type: ExportColumnType;
  width: number;
  /** Long text columns wrap. */
  wrap: boolean;
}

/**
 * One cell, typed. Dates hold an ISO day and become real Excel date cells, hours become numbers.
 * A date range cannot be one date cell, so it is text ("04/03/2026 - 06/03/2026").
 */
export type ExportCell =
  | { kind: "text"; value: string }
  | { kind: "date"; iso: string }
  | { kind: "hours"; value: number }
  | { kind: "number"; value: number }
  | { kind: "empty" };

export interface ExportRow {
  entryId: string;
  cells: ExportCell[];
}

export interface ExportTable {
  profile: ProfileId;
  columns: ExportColumn[];
  rows: ExportRow[];
  /** Sum of the hours of the rows, rounded to 2 decimals. */
  totalHours: number;
  count: number;
}

export type ExportYear = number | "all";

const ISO_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function validIso(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = ISO_ONLY.exec(s.trim());
  if (!m) return null;
  return isValidYmd(Number(m[1]), Number(m[2]), Number(m[3])) ? s.trim() : null;
}

/**
 * The profiles to export, in the order given, each once. Throws a RangeError in plain words for one that is not a
 * profile, or for none at all. The workbook and the on-screen preview both use it, so they refuse the same things.
 */
export function normaliseProfiles(profiles: readonly ProfileId[]): ProfileId[] {
  const out: ProfileId[] = [];
  for (const p of profiles) {
    if (!isProfileId(p)) throw new RangeError("One of the chosen profiles is not recognised. Choose ICE, IStructE or Custom.");
    if (!out.includes(p)) out.push(p);
  }
  if (out.length === 0) throw new RangeError("Choose at least one profile to export.");
  return out;
}

/** A year must be a whole number such as 2026, or "all". Throws a RangeError in plain words for anything else (a string, NaN). */
export function checkYear(year: ExportYear): void {
  if (year !== "all" && (!Number.isInteger(year) || year < 1900 || year > 2200)) {
    throw new RangeError('Choose a year such as 2026, or "all" for every year.');
  }
}

/**
 * Refuses entries that are not all one person's. With a user id, every entry must also be that user's. This is the
 * guard against a route that hands the exporter someone else's entries. Throws an Error in plain words.
 */
export function assertOwnEntries(entries: readonly Pick<Entry, "userId">[], userId?: string): void {
  const owners = new Set(entries.map((e) => e.userId));
  if (owners.size > 1 || (userId !== undefined && [...owners].some((o) => o !== userId))) {
    throw new Error("The export was stopped because the entries do not all belong to one user.");
  }
}

/** Entries of one profile that belong in an export: never deleted, and only the chosen year when one is given. */
export function selectEntries(entries: readonly Entry[], profile: ProfileId, year: ExportYear = "all"): Entry[] {
  return entries.filter((e) => {
    if (e.deletedAt) return false;
    if (e.profile !== profile) return false;
    if (year !== "all" && yearOf(e.dateCompleted) !== year) return false;
    return true;
  });
}

/** Date, then title, then creation time and id so the order never depends on the order they came in. */
export function sortEntries(entries: readonly Entry[]): Entry[] {
  return [...entries].sort((a, b) => {
    if (a.dateCompleted !== b.dateCompleted) return a.dateCompleted < b.dateCompleted ? -1 : 1;
    const t = a.title.localeCompare(b.title, "en-GB", { sensitivity: "base" });
    if (t !== 0) return t;
    if (a.title !== b.title) return a.title < b.title ? -1 : 1;
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

function text(value: string): ExportCell {
  const v = safeText(value);
  return v ? { kind: "text", value: v } : { kind: "empty" };
}

function hoursCell(h: number): ExportCell {
  return Number.isFinite(h) ? { kind: "hours", value: roundHours(h) } : { kind: "empty" };
}

/** One date cell for a single day. A range (dateEnd after dateCompleted) becomes text so no day is lost. */
function dateCell(e: Entry): ExportCell {
  const start = validIso(e.dateCompleted);
  if (!start) return text(e.dateCompleted);
  const end = validIso(e.dateEnd);
  if (end && end > start) return { kind: "text", value: `${formatUkDate(start)} - ${formatUkDate(end)}` };
  return { kind: "date", iso: start };
}

function yesNoCell(v: boolean | null): ExportCell {
  if (v === true) return { kind: "text", value: "Y" };
  if (v === false) return { kind: "text", value: "N" };
  return { kind: "empty" };
}

/** The ICE "Details of CPD activity" cell: title, then provider, then the link, one per line. */
export function iceDetails(e: Pick<Entry, "title" | "provider" | "url">): string {
  const lines = [cleanText(e.title)];
  const provider = cleanText(e.provider);
  if (provider) lines.push(`Provider: ${provider}`);
  const url = cleanText(e.url);
  if (url) lines.push(url);
  return lines.filter(Boolean).join("\n");
}

const YES = new Set(["y", "yes", "true", "1", "t", "x", "tick", "✓", "✔"]);
const NO = new Set(["n", "no", "false", "0", "f"]);

function customCell(def: CustomFieldDef, raw: string | undefined): ExportCell {
  const v = cleanText(raw);
  if (!v) return { kind: "empty" };
  switch (def.type) {
    case "number": {
      const n = /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : Number.NaN;
      return Number.isFinite(n) ? { kind: "number", value: n } : text(v);
    }
    case "date": {
      const iso = validIso(v) ?? parseUkDate(v);
      return iso ? { kind: "date", iso } : text(v);
    }
    case "yes_no": {
      const k = v.toLowerCase();
      if (YES.has(k)) return { kind: "text", value: "Y" };
      if (NO.has(k)) return { kind: "text", value: "N" };
      return text(v);
    }
    default:
      return text(v);
  }
}

function customColumns(settings: UserSettings): ExportColumn[] {
  return settings.customFields.map((f): ExportColumn => {
    const type: ExportColumnType = f.type === "number" ? "number" : f.type === "date" ? "date" : f.type === "yes_no" ? "yesno" : "text";
    return {
      key: `custom:${f.key}`,
      label: safeText(f.label) || f.key,
      type,
      width: type === "text" ? 28 : type === "date" ? 14 : type === "number" ? 12 : 14,
      wrap: type === "text",
    };
  });
}

/** The columns of one profile, in the exact order of the profile config. Custom uses the user's own labels. */
export function exportColumns(profile: ProfileId, settings: UserSettings): ExportColumn[] {
  const fromConfig = (cols: readonly { key: string; label: string; type: "text" | "date" | "hours" | "yesno"; width: number }[]): ExportColumn[] =>
    cols.map((c) => ({ key: c.key, label: c.label, type: c.type, width: c.width, wrap: c.type === "text" }));
  if (profile === "ice") return fromConfig(PROFILES.ice.columns);
  if (profile === "istructe") return fromConfig(PROFILES.istructe.columns);
  return [...fromConfig(PROFILES.custom.baseColumns), ...customColumns(settings)];
}

function cellFor(profile: ProfileId, key: string, e: Entry, settings: UserSettings): ExportCell {
  if (profile === "ice") {
    switch (key) {
      case "details": return text(iceDetails(e));
      case "theme": return text(e.theme ?? "");
      case "dates": return dateCell(e);
      case "hours": return hoursCell(e.hours);
      case "devPlanRef": return text(cleanText(e.devPlanRef) || DEFAULT_DEV_PLAN_REF);
      case "learningPoints": return text(e.learningPoints);
      case "benefits": return text(composeBenefits(e.benefits ?? { helped: "", future: "", nextYear: "" }));
      default: return { kind: "empty" };
    }
  }
  if (profile === "istructe") {
    switch (key) {
      case "date": return dateCell(e);
      case "title": return text(e.title);
      case "category": return text(e.category ?? "");
      case "hours": return hoursCell(e.hours);
      case "structuralSafety": return yesNoCell(e.structuralSafety);
      case "sustainability": return yesNoCell(e.sustainability);
      case "developmentGained": return text(e.developmentGained);
      default: return { kind: "empty" };
    }
  }
  switch (key) {
    case "date": return dateCell(e);
    case "title": return text(e.title);
    case "hours": return hoursCell(e.hours);
    default: {
      const def = settings.customFields.find((f) => `custom:${f.key}` === key);
      if (!def) return { kind: "empty" };
      // Own properties only: a field key such as "constructor" must not read something from Object.prototype.
      const raw = e.custom && Object.hasOwn(e.custom, def.key) ? e.custom[def.key] : undefined;
      return customCell(def, typeof raw === "string" ? raw : undefined);
    }
  }
}

/**
 * Entries mapped to the exact column order of the profile. The workbook and the on-screen preview both use this,
 * so they always match. Deleted entries are left out. Rows run by date, then title.
 */
export function exportRows(profile: ProfileId, entries: readonly Entry[], settings: UserSettings, opts: { year?: ExportYear } = {}): ExportTable {
  const columns = exportColumns(profile, settings);
  const chosen = sortEntries(selectEntries(entries, profile, opts.year ?? "all"));
  const rows = chosen.map((e): ExportRow => ({ entryId: e.id, cells: columns.map((c) => cellFor(profile, c.key, e, settings)) }));
  const totalHours = roundHours(chosen.reduce((t, e) => t + (Number.isFinite(e.hours) ? e.hours : 0), 0));
  return { profile, columns, rows, totalHours, count: chosen.length };
}

/** A cell as it appears on screen and in Excel: dates as dd/mm/yyyy, hours with two decimals. */
export function cellDisplay(cell: ExportCell): string {
  switch (cell.kind) {
    case "text": return cell.value;
    case "date": return formatUkDate(cell.iso);
    case "hours": return cell.value.toFixed(2);
    case "number": return String(cell.value);
    default: return "";
  }
}

/** The ICE header block (rows 1-2 of the ICE sheet): name, job role and responsibilities, sector. */
export function iceHeaderBlock(settings: UserSettings): { label: string; value: string }[] {
  const role = [cleanText(settings.jobRole), cleanText(settings.responsibilities)].filter(Boolean).join("\n");
  const values: Record<string, string> = {
    name: cleanText(settings.name),
    roleAndResponsibilities: role,
    sector: cleanText(settings.sector),
  };
  return PROFILES.ice.headerBlock.map((h) => ({ label: h.label, value: safeText(values[h.key] ?? "") }));
}
