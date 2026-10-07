import type { ProfileId, UserSettings } from "@/lib/types";
import { PROFILES } from "@/lib/profiles";
import { cellText, shorten } from "./values";
import { IMPORT_LIMITS, type Cell, type GridRow } from "./types";

/** The fields a column can feed. Custom profile fields use "custom.<key>". */
export type FieldKey =
  | "date"
  | "title"
  | "theme"
  | "hours"
  | "minutes"
  | "duration"
  | "devPlanRef"
  | "learningPoints"
  | "benefits"
  | "category"
  | "structuralSafety"
  | "sustainability"
  | "developmentGained"
  | "provider"
  | "url"
  | `custom.${string}`;

/**
 * No header, and no label worth comparing, is longer than this. Text past it is never run through a pattern, so a cell
 * of millions of characters from a hostile file cannot keep the server busy.
 */
export const MAX_LABEL_CHARS = 200;

const plain = (s: string) => s.toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").trim();

/** Lower case, punctuation turned into single spaces, "&" read as "and". Brackets are kept as text. "" for very long text. */
export function normPlain(raw: string): string {
  return raw.length > MAX_LABEL_CHARS ? "" : plain(raw);
}

/**
 * Lower case, brackets removed, punctuation turned into single spaces, "&" read as "and". Text over MAX_LABEL_CHARS
 * is not a header and gives "". The bracket patterns are bounded (at most 100 characters inside a pair), so they run
 * in linear time on any text, including a long run of opening brackets.
 */
export function normHeader(raw: string): string {
  if (raw.length > MAX_LABEL_CHARS) return "";
  const withoutBrackets = plain(raw.replace(/\([^()]{0,100}\)|\[[^[\]]{0,100}\]/g, " "));
  return withoutBrackets || plain(raw);
}

const SYNONYMS: Record<Exclude<FieldKey, `custom.${string}`>, string[]> = {
  date: ["Date", "Dates", "Date completed", "Date of activity", "Completed", "Completion date", "Activity date", "Date of CPD", "Date of CPD activity"],
  title: [
    "Details of CPD activity", "Activity", "Activity title", "Title", "Description", "Details", "CPD activity", "Name of activity",
    "Activity description", "Course", "Course title", "Event",
  ],
  theme: ["ICE CPD Framework theme", "Theme", "Objective", "Framework theme", "CPD theme", "ICE theme"],
  hours: [
    "Effective learning time", "Hours", "CPD hours", "Hrs", "Effective learning hours", "Learning hours", "Hours spent",
    "Number of hours", "Total hours",
  ],
  minutes: ["Minutes", "Mins", "Minutes spent", "Duration minutes", "Duration mins", "Duration min", "Min"],
  duration: ["Time", "Duration", "Length", "Time spent", "Learning time", "CPD time"],
  devPlanRef: ["Dev. Plan ref", "Development plan ref", "Dev plan reference", "Development plan reference", "Plan ref", "Development plan"],
  learningPoints: ["Key Learning Points", "Learning points", "Learning outcomes", "What I learned", "What I learnt", "Key learning", "Learning", "Outcomes"],
  benefits: ["Key Benefits/Value added", "Benefits", "Value added", "Key benefits", "Benefit"],
  category: ["Category", "CPD category", "Activity category"],
  structuralSafety: ["Structural safety", "Structural safety Y/N", "Structural safety yes no"],
  sustainability: ["Sustainability", "Sustainability Y/N", "Sustainability yes no"],
  developmentGained: ["Development gained", "Development outcome"],
  provider: ["Provider", "Organiser", "Organizer", "Provider/organiser", "Delivered by", "Presenter", "Source"],
  url: ["URL", "Link", "Web link", "Website", "Web address", "Hyperlink"],
};

const LOOKUP: Map<string, FieldKey> = (() => {
  const m = new Map<string, FieldKey>();
  for (const [field, names] of Object.entries(SYNONYMS) as [FieldKey, string[]][]) {
    for (const n of names) m.set(normHeader(n), field);
  }
  return m;
})();

/** Columns that only mean something for one profile. Anything else is read for every profile. */
const ICE_ONLY: FieldKey[] = ["theme"];
const ISTRUCTE_ONLY: FieldKey[] = ["category", "structuralSafety", "sustainability", "developmentGained"];

export function isIgnoredForProfile(field: FieldKey, profile: ProfileId): boolean {
  if (ICE_ONLY.includes(field)) return profile !== "ice";
  if (ISTRUCTE_ONLY.includes(field)) return profile !== "istructe";
  return false;
}

/** The headers of the custom profile's own export (Date, Activity, Hours): these always mean the core columns. */
const BASE_HEADERS: ReadonlySet<string> = new Set(PROFILES.custom.baseColumns.map((c) => normHeader(c.label)));

/** Fields that tell a row what it is. Without one of each group (date, title, some hours) every row is blocked. */
const CORE_GROUPS: readonly (readonly FieldKey[])[] = [["date"], ["title"], ["hours", "minutes", "duration"]];

function customDefFor(norm: string, settings: UserSettings) {
  return settings.customFields.find((f) => normHeader(f.label) === norm);
}

/**
 * What one header cell stands for, or null. For the custom profile the user's own field labels count too, and they beat
 * the looser synonyms (a field called Duration, Time, Description or Event is that field, not the core column). Only the
 * profile's own base headers (Date, Activity, Hours) are kept for the core columns.
 */
export function matchHeader(raw: string, profile: ProfileId, settings: UserSettings): FieldKey | null {
  const norm = normHeader(raw);
  if (!norm) return null;
  if (profile === "custom" && !BASE_HEADERS.has(norm)) {
    const def = customDefFor(norm, settings);
    if (def) return `custom.${def.key}`;
  }
  return LOOKUP.get(norm) ?? null;
}

export interface HeaderMapping {
  /** Field -> column index (0-based). The first column for a field wins. */
  columns: Map<FieldKey, number>;
  /** Field -> header text as written in the file. */
  headers: Map<FieldKey, string>;
  /** Header texts that were not used: unrecognised, a second column for a field already read, or not for this profile. */
  unmapped: string[];
  /** Recognised columns that belong to another profile (for example Theme when importing into IStructE). */
  ignoredForProfile: string[];
}

export function mapHeaders(cells: readonly Cell[], profile: ProfileId, settings: UserSettings): HeaderMapping {
  const columns = new Map<FieldKey, number>();
  const headers = new Map<FieldKey, string>();
  const unmapped: string[] = [];
  const ignoredForProfile: string[] = [];
  cells.forEach((c, i) => {
    const text = cellText(c);
    if (!text) return;
    let field = matchHeader(text, profile, settings);
    if (field !== null && isIgnoredForProfile(field, profile)) {
      unmapped.push(shorten(text, MAX_LABEL_CHARS));
      ignoredForProfile.push(shorten(text, MAX_LABEL_CHARS));
      return;
    }
    if (profile === "custom" && field !== null && columns.has(field)) {
      // A second column with the same name. The custom export writes its base columns first and the user's own fields
      // after them, so a field labelled Date or Hours comes second: give it to that field.
      const def = customDefFor(normHeader(text), settings);
      if (def && !columns.has(`custom.${def.key}`)) field = `custom.${def.key}`;
    }
    if (field === null || columns.has(field)) {
      unmapped.push(shorten(text, MAX_LABEL_CHARS));
      return;
    }
    columns.set(field, i);
    headers.set(field, text);
  });
  if (profile === "custom") reclaimCoreColumns(columns, headers);
  return { columns, headers, unmapped, ignoredForProfile };
}

/**
 * A custom field whose label is also a synonym for a core column (a field called Description, in a hand-made file with
 * no Activity column) must not leave every row without a title. When no column reads as a core field, a column that was
 * given to a custom field and whose header is a synonym for it is used for the core field instead.
 */
function reclaimCoreColumns(columns: Map<FieldKey, number>, headers: Map<FieldKey, string>): void {
  for (const group of CORE_GROUPS) {
    if (group.some((f) => columns.has(f))) continue;
    for (const [field, index] of columns) {
      if (!field.startsWith("custom.")) continue;
      const text = headers.get(field) ?? "";
      const synonym = LOOKUP.get(normHeader(text));
      if (synonym === undefined || !group.includes(synonym)) continue;
      columns.delete(field);
      headers.delete(field);
      columns.set(synonym, index);
      headers.set(synonym, text);
      break;
    }
  }
}

/** How many different fields a row's cells name. Used to choose the header row. */
export function headerScore(cells: readonly Cell[], profile: ProfileId, settings: UserSettings): { score: number; hasDateOrTitle: boolean } {
  const seen = new Set<FieldKey>();
  for (const c of cells) {
    const text = cellText(c);
    if (!text || text.length > 80) continue;
    const f = matchHeader(text, profile, settings);
    if (f !== null) seen.add(f);
  }
  return { score: seen.size, hasDateOrTitle: seen.has("date") || seen.has("title") };
}

/** Looks through the first rows for the one that names the most columns. Needs a date or title column and one more. */
export function findHeaderRow(rows: readonly GridRow[], profile: ProfileId, settings: UserSettings): { index: number; mapping: HeaderMapping } | null {
  let bestIndex = -1;
  let bestScore = 0;
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!row || row.n > IMPORT_LIMITS.headerScanRows) continue;
    const { score, hasDateOrTitle } = headerScore(row.cells, profile, settings);
    // Strictly greater, so the first of two equally good rows wins.
    if (score >= 2 && hasDateOrTitle && score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }
  const header = bestIndex >= 0 ? rows[bestIndex] : undefined;
  if (!header) return null;
  return { index: bestIndex, mapping: mapHeaders(header.cells, profile, settings) };
}

/** Headers of the profile's own export, for messages. */
export function profileHeaderHint(profile: ProfileId): string {
  if (profile === "ice") return PROFILES.ice.columns.map((c) => c.label).join(", ");
  if (profile === "istructe") return PROFILES.istructe.columns.map((c) => c.label).join(", ");
  return PROFILES.custom.baseColumns.map((c) => c.label).join(", ");
}
