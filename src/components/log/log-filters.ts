/**
 * Pure helpers for the Log page: what the URL holds, how entries are searched, filtered and sorted.
 * Client-safe: no server-only imports.
 *
 * The URL carries ?q=&year=&log=&theme=&type=&sort= . Anything missing or not recognised falls back
 * to "no filter", so a hand-edited or stale link never breaks the page.
 */
import { roundHours } from "@/lib/dates";
import { ICE_ALL_THEMES, PROFILES, isProfileId } from "@/lib/profiles";
import { SOURCE_TYPES, type Entry, type ProfileId, type SourceType } from "@/lib/types";

/** An entry as the Log page holds it. The user id and the deleted marker never travel to the browser. */
export type LogEntry = Omit<Entry, "userId" | "deletedAt">;

export function toLogEntry(entry: Entry): LogEntry {
  const { userId: _userId, deletedAt: _deletedAt, ...rest } = entry;
  return rest;
}

/** The shape the shared edit helpers expect. Only the two fields the page never holds are filled in. */
export function toFullEntry(entry: LogEntry): Entry {
  return { ...entry, userId: "", deletedAt: null };
}

export type SortKey = "date" | "title" | "hours" | "theme";
export type SortDir = "asc" | "desc";

export interface LogQuery {
  q: string;
  /** Four digits, or "" for every year. */
  year: string;
  log: ProfileId | "";
  /** A theme or category exactly as recorded, NO_THEME, or "" for all. */
  theme: string;
  type: SourceType | "";
  sort: SortKey;
  dir: SortDir;
}

/** Filter value for entries that have no theme or category (Custom entries, and any left blank). */
export const NO_THEME = "none";

export const DEFAULT_QUERY: LogQuery = { q: "", year: "", log: "", theme: "", type: "", sort: "date", dir: "desc" };

/** The direction a column starts in when first chosen: newest and largest first, text A to Z. */
export const FIRST_DIR: Record<SortKey, SortDir> = { date: "desc", hours: "desc", title: "asc", theme: "asc" };

export const SORT_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "date-desc", label: "Date, newest first" },
  { value: "date-asc", label: "Date, oldest first" },
  { value: "title-asc", label: "Title, A to Z" },
  { value: "title-desc", label: "Title, Z to A" },
  { value: "hours-desc", label: "Hours, most first" },
  { value: "hours-asc", label: "Hours, fewest first" },
  { value: "theme-asc", label: "Theme, A to Z" },
  { value: "theme-desc", label: "Theme, Z to A" },
];

type ParamSource = URLSearchParams | { get(name: string): string | null };

function parseSort(raw: string | null): { sort: SortKey; dir: SortDir } {
  const m = /^(date|title|hours|theme)-(asc|desc)$/.exec(raw ?? "");
  if (!m) return { sort: DEFAULT_QUERY.sort, dir: DEFAULT_QUERY.dir };
  return { sort: m[1] as SortKey, dir: m[2] as SortDir };
}

export function parseQuery(params: ParamSource): LogQuery {
  const year = params.get("year") ?? "";
  const log = params.get("log") ?? "";
  const type = params.get("type") ?? "";
  return {
    q: (params.get("q") ?? "").slice(0, 200),
    year: /^\d{4}$/.test(year) ? year : "",
    log: isProfileId(log) ? log : "",
    theme: (params.get("theme") ?? "").slice(0, 300),
    type: (SOURCE_TYPES as readonly string[]).includes(type) ? (type as SourceType) : "",
    ...parseSort(params.get("sort")),
  };
}

/** The query string for a state, without the leading "?". The default sort and empty filters are left out. */
export function serialiseQuery(query: LogQuery): string {
  const p = new URLSearchParams();
  if (query.q.trim() !== "") p.set("q", query.q);
  if (query.year) p.set("year", query.year);
  if (query.log) p.set("log", query.log);
  if (query.theme) p.set("theme", query.theme);
  if (query.type) p.set("type", query.type);
  if (query.sort !== DEFAULT_QUERY.sort || query.dir !== DEFAULT_QUERY.dir) p.set("sort", `${query.sort}-${query.dir}`);
  return p.toString();
}

export function sortValue(query: Pick<LogQuery, "sort" | "dir">): string {
  return `${query.sort}-${query.dir}`;
}

/** How many of the filters (not the sort) are switched on. The search words count as one. */
export function activeFilterCount(query: LogQuery): number {
  return [query.q.trim(), query.year, query.log, query.theme, query.type].filter((v) => v !== "").length;
}

/** ICE entries carry a theme, IStructE entries a category. Either way it is the one label shown and filtered on. */
export function entryTheme(entry: Pick<LogEntry, "theme" | "category">): string | null {
  const t = (entry.theme ?? "").trim() || (entry.category ?? "").trim();
  return t || null;
}

// ---------------------------------------------------------------------------------------------
// Search

/** Everything a person might remember about an entry, lower-cased once so searching stays quick. */
export function searchHaystack(entry: LogEntry): string {
  return [
    entry.title,
    entry.provider,
    entry.theme,
    entry.category,
    entry.learningPoints,
    entry.benefits.helped,
    entry.benefits.future,
    entry.benefits.nextYear,
    entry.developmentGained,
    entry.notes,
    ...Object.values(entry.custom),
  ]
    .filter((v): v is string => typeof v === "string" && v !== "")
    .join("\n")
    .toLocaleLowerCase("en-GB");
}

/** Every word typed must appear somewhere in the entry, in any order, ignoring case. */
export function searchTerms(q: string): string[] {
  return q.toLocaleLowerCase("en-GB").split(/\s+/).filter(Boolean);
}

export function filterEntries(entries: readonly LogEntry[], query: LogQuery, haystacks: ReadonlyMap<string, string>): LogEntry[] {
  const terms = searchTerms(query.q);
  return entries.filter((e) => {
    if (query.year && e.dateCompleted.slice(0, 4) !== query.year) return false;
    if (query.log && e.profile !== query.log) return false;
    if (query.type && e.sourceType !== query.type) return false;
    if (query.theme) {
      const theme = entryTheme(e);
      if (query.theme === NO_THEME ? theme !== null : theme !== query.theme) return false;
    }
    if (terms.length > 0) {
      const hay = haystacks.get(e.id) ?? searchHaystack(e);
      if (!terms.every((t) => hay.includes(t))) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Sort

const collator = new Intl.Collator("en-GB", { sensitivity: "base", numeric: true });

function byDate(a: LogEntry, b: LogEntry): number {
  return a.dateCompleted < b.dateCompleted ? -1 : a.dateCompleted > b.dateCompleted ? 1 : a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0;
}

export function sortEntries(entries: readonly LogEntry[], sort: SortKey, dir: SortDir): LogEntry[] {
  const sign = dir === "asc" ? 1 : -1;
  const out = [...entries];
  out.sort((a, b) => {
    let primary = 0;
    if (sort === "date") return sign * byDate(a, b);
    if (sort === "title") primary = collator.compare(a.title, b.title);
    else if (sort === "hours") primary = a.hours - b.hours;
    else {
      const ta = entryTheme(a);
      const tb = entryTheme(b);
      // Entries with no theme go last whichever way the column is sorted.
      if (ta === null || tb === null) {
        if (ta === tb) return -byDate(a, b);
        return ta === null ? 1 : -1;
      }
      primary = collator.compare(ta, tb);
    }
    return primary !== 0 ? sign * primary : -byDate(a, b);
  });
  return out;
}

export function totalHours(entries: readonly Pick<LogEntry, "hours">[]): number {
  return roundHours(entries.reduce((t, e) => t + (Number.isFinite(e.hours) ? e.hours : 0), 0));
}

// ---------------------------------------------------------------------------------------------
// Filter choices

export interface ThemeChoices {
  ice: string[];
  istructe: string[];
  /** Values found in the log that the two lists do not know about (imported rows, older entries). */
  other: string[];
}

/** The ICE themes and IStructE categories, plus anything else already in the log or chosen in the URL. */
export function themeChoices(entries: readonly LogEntry[], selected: string): ThemeChoices {
  const known = new Set<string>([...ICE_ALL_THEMES, ...PROFILES.istructe.categories]);
  const other = new Set<string>();
  for (const e of entries) {
    const t = entryTheme(e);
    if (t && !known.has(t)) other.add(t);
  }
  if (selected && selected !== NO_THEME && !known.has(selected)) other.add(selected);
  return {
    ice: [...ICE_ALL_THEMES],
    istructe: [...PROFILES.istructe.categories],
    other: [...other].sort((a, b) => collator.compare(a, b)),
  };
}

/** Years that have entries, newest first, plus the one chosen in the URL so the select always shows it. */
export function yearChoices(entries: readonly LogEntry[], selected: string): string[] {
  const years = new Set(entries.map((e) => e.dateCompleted.slice(0, 4)));
  if (selected) years.add(selected);
  return [...years].sort().reverse();
}

// ---------------------------------------------------------------------------------------------
// Wording

export function entriesWord(n: number): string {
  return n === 1 ? "entry" : "entries";
}

export function hoursWord(h: number): string {
  return h === 1 ? "hour" : "hours";
}

/** A short form of a title for use inside a sentence or toast. */
export function shortTitle(title: string, max = 60): string {
  const t = title.trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Only web links are made clickable, even if an older record holds something else. */
export function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "" ? u.href : null;
  } catch {
    return null;
  }
}
