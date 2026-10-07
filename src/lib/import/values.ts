import type { BenefitParts } from "@/lib/types";
import { PROFILES, matchOption } from "@/lib/profiles";
import {
  dateToIsoUtc,
  excelSerialToIso,
  formatUkDate,
  minutesToHours,
  parseDateOrRangeStart,
  parseUkDate,
  roundHours,
} from "@/lib/dates";
import { unneutraliseFormula } from "@/lib/export/safe-text";
import type { Cell } from "./types";

/** Spaces that Excel and the web like to use, zero-width characters and BOMs removed; line breaks as \n; trimmed. */
export function cleanCellString(s: string): string {
  return s
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
    .replace(/\r\n?/g, "\n")
    .trim();
}

/**
 * A date, an amount of time or a link is never longer than this. Longer text is called unreadable without being run
 * through any pattern, so one huge cell in a hostile file cannot keep the server busy.
 */
export const MAX_CELL_PARSE_CHARS = 200;

/** Text for a message or an evidence note: long cells are cut, so a message never carries a whole paragraph back. */
export function shorten(text: string, max = 80): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

/** The text of a cell. A Date cell reads as its UTC day. Never throws. */
export function cellText(c: Cell | undefined): string {
  if (!c || c.v === null) return "";
  const v = c.v;
  if (typeof v === "string") return cleanCellString(v);
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  return dateToIsoUtc(v) ?? "";
}

/** Text for a free-text field. One quote that an earlier export put in front of = + - @ is taken off again. */
export function textField(c: Cell | undefined): string {
  return unneutraliseFormula(cellText(c));
}

export function isEmptyCell(c: Cell | undefined): boolean {
  return cellText(c) === "";
}

// ---------------------------------------------------------------------------------------------------------------
// Dates

export type DateResult =
  | { kind: "empty" }
  | { kind: "ok"; start: string; end: string | null; note?: string }
  /** Something is there but it is not a date we can read. */
  | { kind: "bad"; text: string };

/** 1 January 1990 and 31 December 2100 as Excel serial numbers. Anything else in a date column is not a date. */
const SERIAL_MIN = 32874;
const SERIAL_MAX = 73415;

function fromSerial(n: number, date1904: boolean, text: string): DateResult {
  const serial = date1904 ? n + 1462 : n;
  if (!Number.isFinite(serial) || serial < SERIAL_MIN || serial > SERIAL_MAX) return { kind: "bad", text };
  const iso = excelSerialToIso(serial);
  return iso ? { kind: "ok", start: iso, end: null } : { kind: "bad", text };
}

const MONTH_WORD = String.raw`[A-Za-z]{3,9}`;
const SAME_MONTH_RANGE = new RegExp(
  String.raw`^(\d{1,2})(?:st|nd|rd|th)?\s*[-–—]\s*(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(${MONTH_WORD})\.?,?\s+(\d{4})$`,
  "i",
);
const ISO_INTERVAL = /^(\d{4}-\d{2}-\d{2})\s*(?:\/|--|to)\s*(\d{4}-\d{2}-\d{2})$/i;
const RANGE_SPLIT = /\s+(?:-|–|—|to|until)\s+|\s*[–—]\s*/i;

/** The first half of a range may leave out the year or month ("4 March - 6 March 2026", "4/3 - 6/3/2026"). Borrow it from the second half. */
function borrowFromEnd(first: string, end: string): string | null {
  const [y, m] = end.split("-");
  if (!y || !m) return null;
  const f = first.trim();
  if (/^\d{1,2}(?:st|nd|rd|th)?$/i.test(f)) {
    const day = Number(f.replace(/\D/g, ""));
    return parseUkDate(`${String(day).padStart(2, "0")}/${m}/${y}`);
  }
  if (/^\d{1,2}[/.-]\d{1,2}$/.test(f)) return parseUkDate(`${f.replace(/[.-]/g, "/")}/${y}`);
  if (new RegExp(String.raw`^\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?${MONTH_WORD}\.?$`, "i").test(f)) return parseUkDate(`${f} ${y}`);
  return null;
}

function finishRange(start: string, end: string | null): DateResult {
  if (!end || end === start) return { kind: "ok", start, end: null };
  if (end < start) return { kind: "ok", start, end: null, note: "The end date is before the start date, so only the start date was used." };
  return { kind: "ok", start, end };
}

/** The different days that are written anywhere in some text, whichever way each is written. Each match is used up once. */
function distinctDates(s: string): Set<string> {
  const found = new Set<string>();
  let rest = s;
  const take = (re: RegExp) => {
    rest = rest.replace(re, (m) => {
      const d = parseUkDate(m);
      if (d) found.add(d);
      return " ";
    });
  };
  take(/(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)/g);
  take(/(?<!\d)\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})(?!\d)/g);
  take(/(?<!\d)\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?[A-Za-z]{3,9}\.?,?\s+\d{4}(?!\d)/gi);
  take(/[A-Za-z]{3,9}\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}(?!\d)/g);
  return found;
}

/** One date or a date range written as text. A range uses its first day and keeps the last day as dateEnd. */
export function parseDateText(raw: string): DateResult {
  const s = cleanCellString(raw).replace(/\s+/g, " ");
  if (!s) return { kind: "empty" };
  if (s.length > MAX_CELL_PARSE_CHARS) return { kind: "bad", text: shorten(s) };

  const same = SAME_MONTH_RANGE.exec(s);
  if (same) {
    const start = parseUkDate(`${same[1]} ${same[3]} ${same[4]}`);
    const end = parseUkDate(`${same[2]} ${same[3]} ${same[4]}`);
    if (start) return finishRange(start, end);
  }

  const iso = ISO_INTERVAL.exec(s);
  if (iso) {
    const start = parseUkDate(iso[1]);
    const end = parseUkDate(iso[2]);
    if (start) return finishRange(start, end);
  }

  const parts = s.split(RANGE_SPLIT);
  if (parts.length === 2) {
    const [a = "", b = ""] = parts;
    const end = parseUkDate(b);
    if (end) {
      const start = parseUkDate(a) ?? borrowFromEnd(a, end);
      if (start) return finishRange(start, end);
    }
  }

  // Two complete dates joined by a hyphen with no spaces ("04/03/2026-06/03/2026"). A hyphen inside a date is never a
  // split point, because neither side of it is then a date on its own.
  for (let i = s.indexOf("-"); i !== -1; i = s.indexOf("-", i + 1)) {
    const end = parseUkDate(s.slice(i + 1));
    const start = end ? parseUkDate(s.slice(0, i)) : null;
    if (start) return finishRange(start, end);
  }

  const single = parseDateOrRangeStart(s);
  if (!single) return { kind: "bad", text: s };
  if (distinctDates(s).size >= 2) {
    return {
      kind: "ok",
      start: single,
      end: null,
      note: `Two dates were found in "${shorten(s)}", so only ${formatUkDate(single)} was used. If this is a date range, write it like 04/03/2026 - 06/03/2026.`,
    };
  }
  return { kind: "ok", start: single, end: null };
}

/** A date cell: a real Date, an Excel serial number (also as text), or day-first text. */
export function parseDateCell(c: Cell | undefined, date1904 = false): DateResult {
  if (!c || c.v === null) return { kind: "empty" };
  const v = c.v;
  if (v instanceof Date) {
    const iso = dateToIsoUtc(v);
    return iso ? { kind: "ok", start: iso, end: null } : { kind: "bad", text: cellText(c) || "that date" };
  }
  if (typeof v === "boolean") return { kind: "bad", text: v ? "TRUE" : "FALSE" };
  if (typeof v === "number") return fromSerial(v, date1904, String(v));
  const s = cleanCellString(v);
  if (!s) return { kind: "empty" };
  if (/^\d{4,6}(?:\.\d+)?$/.test(s)) return fromSerial(Number(s), date1904, s);
  return parseDateText(s);
}

// ---------------------------------------------------------------------------------------------------------------
// Durations

export type HoursRole = "hours" | "minutes" | "duration";

export type HoursResult =
  | { kind: "empty" }
  | {
      kind: "ok";
      hours: number;
      /** For the review screen, e.g. "From your file (90 minutes)". */
      evidence: string;
      /** A warning to show when the number had to be read one way or the other. */
      reading?: string;
      /** True when the reading was a guess: show Check, not High. */
      guessed: boolean;
    }
  | { kind: "bad"; text: string };

/** A time cell formatted as [h]:mm comes back from exceljs as a Date on 30 December 1899 plus the elapsed time. */
const EXCEL_TIME_ZERO = Date.UTC(1899, 11, 30);

function bareNumber(n: number, text: string, role: HoursRole, header: string): HoursResult {
  if (!Number.isFinite(n)) return { kind: "bad", text: shorten(text) };
  if (role === "hours") return { kind: "ok", hours: roundHours(n), evidence: "From your file", guessed: false };
  if (role === "minutes") {
    return { kind: "ok", hours: minutesToHours(n), evidence: `From your file (${text} minutes)`, guessed: false };
  }
  // "Time" and "Duration" columns do not say what the unit is. Up to 12 reads as hours, more as minutes, and we say so.
  if (n <= 12) {
    return {
      kind: "ok",
      hours: roundHours(n),
      evidence: `From your file, read as ${text} hours`,
      reading: `Read "${text}" in the "${header}" column as ${text} hours. Check this is right.`,
      guessed: true,
    };
  }
  const h = minutesToHours(n);
  return {
    kind: "ok",
    hours: h,
    evidence: `From your file, read as ${text} minutes`,
    reading: `Read "${text}" in the "${header}" column as ${text} minutes (${h} hours). Check this is right.`,
    guessed: true,
  };
}

const UNIT_TOKEN = String.raw`(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)(?![a-z])`;
const unitMinutes = (amount: string, unit: string) => Number(amount) * (unit.startsWith("h") ? 60 : 1);

/**
 * "1h 30m", "1 hour, 30 minutes", "90 mins", "2 hrs + 15 mins": numbers with units and nothing else but separators.
 * The whole text has to be that, so "2 x 1h" or "3 x 30 mins" is not read as its first pair. Null when it is not.
 */
function parseUnitsExactly(s: string): number | null {
  const token = new RegExp(UNIT_TOKEN, "y");
  const separator = /\s*(?:,|&|\+|and)?\s*/y;
  let pos = 0;
  let minutes = 0;
  let any = false;
  while (pos < s.length) {
    token.lastIndex = pos;
    const m = token.exec(s);
    if (!m) return null;
    minutes += unitMinutes(m[1] ?? "0", m[2] ?? "m");
    any = true;
    separator.lastIndex = token.lastIndex;
    separator.exec(s);
    pos = separator.lastIndex;
  }
  return any ? minutes : null;
}

/** Words and signs that mean the figure is multiplied, split or a range, so reading one pair out of the text would be wrong. */
const COUNTING_TEXT = /\d|(?:^|[^a-z])[x×*](?:[^a-z]|$)|\b(?:half|quarter|twice|double|per|each|every|daily|days?|weeks?|sessions?)\b/i;

/**
 * Text that has a number and a unit in it, with ordinary words around it ("about 2 hours", "45 mins in total"). The
 * reading is a guess, and the caller says so. Null when there is no pair, or when the other text has a number, a
 * multiplier or a range in it ("2 x 1h", "2-3 hours", "15 mins x 4"): that has no safe single reading.
 */
function parseUnitsAmongWords(s: string): number | null {
  const re = new RegExp(UNIT_TOKEN, "g");
  let minutes = 0;
  let any = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    minutes += unitMinutes(m[1] ?? "0", m[2] ?? "m");
    any = true;
  }
  if (!any) return null;
  return COUNTING_TEXT.test(s.replace(new RegExp(UNIT_TOKEN, "g"), " ")) ? null : minutes;
}

function describeMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  const parts: string[] = [];
  if (h) parts.push(`${h} ${h === 1 ? "hour" : "hours"}`);
  if (m || !h) parts.push(`${m} ${m === 1 ? "minute" : "minutes"}`);
  return parts.join(" ");
}

/**
 * A clock-style value (1:30) in a Time or Duration column. It may be a length or a time of day, so it is never read as
 * certain. Under 12 hours it is read as a length and the reading is said out loud. 12 or more reads as a time of day
 * (18:30), not a length, so it is not read at all.
 */
function clockInDurationColumn(minutes: number, text: string, header: string): HoursResult {
  if (minutes <= 0 || minutes >= 12 * 60) return { kind: "bad", text: shorten(text) };
  const said = describeMinutes(minutes);
  return {
    kind: "ok",
    hours: minutesToHours(minutes),
    evidence: `From your file, read as ${said}`,
    reading: `Read "${shorten(text)}" in the "${shorten(header)}" column as ${said}, not as a time of day. Check this is right.`,
    guessed: true,
  };
}

/** Hours from a cell: 1.5, "1,5", "1h 30m", "90 mins", "1:30", a time value. A bare number follows the column's role. */
export function parseHoursCell(c: Cell | undefined, role: HoursRole, header: string): HoursResult {
  if (!c || c.v === null) return { kind: "empty" };
  const v = c.v;
  if (v instanceof Date) {
    const ms = v.getTime() - EXCEL_TIME_ZERO;
    if (Number.isNaN(ms) || ms < 0 || ms >= 7 * 86400000) return { kind: "bad", text: shorten(cellText(c)) };
    if (role === "duration") {
      const minutes = Math.round(ms / 60000);
      return clockInDurationColumn(minutes, `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}`, header);
    }
    return { kind: "ok", hours: roundHours(ms / 3600000), evidence: "From your file (a time value)", guessed: false };
  }
  if (typeof v === "boolean") return { kind: "bad", text: v ? "TRUE" : "FALSE" };
  if (typeof v === "number") return bareNumber(v, String(v), role, header);

  const text = cleanCellString(v);
  if (!text) return { kind: "empty" };
  if (text.length > MAX_CELL_PARSE_CHARS) return { kind: "bad", text: shorten(text) };
  let s = text.toLowerCase();
  // 1,5 and 1,25 are decimals. 1,500 is a thousands separator.
  if (/^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else s = s.replace(/(\d),(\d{1,2})(?!\d)/g, "$1.$2");

  if (/^[-+]?\d+(?:\.\d+)?$/.test(s) || /^[-+]?\.\d+$/.test(s)) return bareNumber(Number(s), text, role, header);

  const hm = /^(\d{1,3})\s*h(?:rs?|ours?)?\s*(\d{1,2})$/.exec(s); // 1h30
  if (hm) return unitResult(Number(hm[1]) * 60 + Number(hm[2]), text);
  const clock = /^(\d{1,3}):([0-5]\d)(?::([0-5]\d))?$/.exec(s); // 1:30 and 1:30:00
  if (clock) {
    const minutes = Number(clock[1]) * 60 + Number(clock[2]) + (clock[3] ? Math.round(Number(clock[3]) / 60) : 0);
    return role === "duration" ? clockInDurationColumn(minutes, text, header) : unitResult(minutes, text);
  }

  const exact = parseUnitsExactly(s);
  if (exact !== null) return unitResult(Math.round(exact), text);
  const among = parseUnitsAmongWords(s);
  if (among !== null && among > 0) {
    const minutes = Math.round(among);
    return {
      kind: "ok",
      hours: minutesToHours(minutes),
      evidence: `From your file, read from "${shorten(text)}"`,
      reading: `Read "${shorten(text)}" in the "${shorten(header)}" column as ${describeMinutes(minutes)}. Check this is right.`,
      guessed: true,
    };
  }
  return { kind: "bad", text: shorten(text) };
}

function unitResult(minutes: number, text: string): HoursResult {
  return minutes > 0
    ? { kind: "ok", hours: minutesToHours(minutes), evidence: `From your file (${text})`, guessed: false }
    : { kind: "bad", text: shorten(text) };
}

// ---------------------------------------------------------------------------------------------------------------
// Yes / no, links, lists

export type YesNoResult = { kind: "empty" } | { kind: "ok"; value: boolean } | { kind: "bad"; text: string };

const YES = new Set(["y", "yes", "true", "1", "t", "x", "tick", "ticked", "✓", "✔", "☑"]);
const NO = new Set(["n", "no", "false", "0", "f"]);
const UNANSWERED = new Set(["-", "–", "—", "n/a", "na", "?", "tbc", "unknown"]);

export function parseYesNo(c: Cell | undefined): YesNoResult {
  if (!c || c.v === null) return { kind: "empty" };
  if (typeof c.v === "boolean") return { kind: "ok", value: c.v };
  if (typeof c.v === "number") return c.v === 1 ? { kind: "ok", value: true } : c.v === 0 ? { kind: "ok", value: false } : { kind: "bad", text: String(c.v) };
  const t = cellText(c);
  if (!t) return { kind: "empty" };
  const k = t.toLowerCase();
  if (YES.has(k)) return { kind: "ok", value: true };
  if (NO.has(k)) return { kind: "ok", value: false };
  if (UNANSWERED.has(k)) return { kind: "empty" };
  return { kind: "bad", text: t };
}

export type UrlResult = { kind: "empty" } | { kind: "ok"; url: string } | { kind: "bad"; text: string };

/** Only http and https links are kept. Credentials in a link are dropped. */
export function normaliseUrl(raw: string): string | null {
  let s = cleanCellString(raw).replace(/^<|>$/g, "");
  if (!s || /\s/.test(s) || s.length > 2048) return null;
  if (!/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (/^www\./i.test(s) || /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]|$)/i.test(s)) s = `https://${s}`;
    else return null;
  }
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (!u.hostname) return null;
  if (u.username || u.password) {
    u.username = "";
    u.password = "";
    return u.toString();
  }
  return s;
}

export function parseUrlCell(c: Cell | undefined): UrlResult {
  if (!c) return { kind: "empty" };
  const t = cellText(c);
  if (!t && !c.link) return { kind: "empty" };
  const fromLink = c.link ? normaliseUrl(c.link) : null;
  if (fromLink) return { kind: "ok", url: fromLink };
  if (!t) return { kind: "bad", text: c.link ?? "" };
  const fromText = normaliseUrl(t);
  return fromText ? { kind: "ok", url: fromText } : { kind: "bad", text: t };
}

const normOption = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const prepOption = (s: string) => s.replace(/[&+]/g, " and ");

export type MatchResult =
  | { kind: "empty" }
  | { kind: "exact"; value: string }
  /** Matched by a looser rule ("Safety & risk" for "Safety and risk management"). Show Check. */
  | { kind: "fuzzy"; value: string }
  | { kind: "none"; text: string };

/** The theme aliases from the profile config ("ethics", "safety-risk") as normalised text -> theme. */
const THEME_ALIASES: Map<string, string> = new Map(
  Object.entries(PROFILES.ice.themeSlugs).map(([slug, t]) => [normOption(slug.replace(/-/g, " ")), t.theme]),
);

/**
 * Match free text to one of a fixed list. matchOption is tried first; if the text fits more than one option
 * (for example "Transport and energy") it is NOT matched, because guessing would put it under the wrong heading.
 */
export function matchFromList(text: string, options: readonly string[], aliases?: ReadonlyMap<string, string>): MatchResult {
  const v = normOption(prepOption(text));
  if (!v) return { kind: "empty" };
  const exact = options.find((o) => normOption(o) === v);
  if (exact) return { kind: "exact", value: exact };
  const alias = aliases?.get(v);
  if (alias && options.includes(alias)) return { kind: "fuzzy", value: alias };
  const hit = matchOption(prepOption(text), options);
  if (hit) {
    const candidates = options.filter((o) => {
      const a = normOption(o);
      return a.includes(v) || v.includes(a);
    });
    if (candidates.length === 1) return { kind: "fuzzy", value: hit };
  }
  return { kind: "none", text: cleanCellString(text) };
}

export function matchTheme(text: string, allThemes: readonly string[]): MatchResult {
  return matchFromList(text, allThemes, THEME_ALIASES);
}

export function matchCategory(text: string): MatchResult {
  return matchFromList(text, PROFILES.istructe.categories);
}

// ---------------------------------------------------------------------------------------------------------------
// Benefits, titles

const normLabel = (s: string) => s.toLowerCase().replace(/[’‘`]/g, "'").replace(/[^a-z0-9]+/g, " ").trim();

/**
 * Splits a Key Benefits cell into the three answers. An export with several answers has labelled lines
 * ("How it helped: ..."), which are read back. Text without those labels goes into "How it helped".
 */
export function parseBenefits(text: string): BenefitParts {
  const parts: BenefitParts = { helped: "", future: "", nextYear: "" };
  const t = text.trim();
  if (!t) return parts;
  const labels = PROFILES.ice.benefitPrompts.map((p) => ({ key: p.key, norm: normLabel(p.label) }));
  const add = (key: keyof BenefitParts, line: string) => {
    parts[key] = parts[key] ? `${parts[key]}\n${line}` : line;
  };
  let current: keyof BenefitParts | null = null;
  const before: string[] = [];
  let foundLabel = false;
  for (const line of t.split("\n")) {
    // A label is at most 80 characters, so only the start of the line is looked at: a line of millions of spaces is cheap.
    const m = /^\s*([^:\n]{3,80}):/.exec(line.slice(0, 200));
    const hit = m ? labels.find((l) => l.norm === normLabel(m[1] ?? "")) : undefined;
    if (m && hit) {
      foundLabel = true;
      current = hit.key;
      const value = line.slice(m[0].length).trim();
      if (value) add(current, value);
    } else if (current) {
      add(current, line.trim());
    } else {
      before.push(line.trim());
    }
  }
  if (!foundLabel) {
    parts.helped = t;
    return parts;
  }
  const lead = before.filter(Boolean).join("\n");
  if (lead) parts.helped = parts.helped ? `${lead}\n${parts.helped}` : lead;
  return parts;
}

/** Lower case, punctuation and spacing ignored: the form of a title used to spot duplicates. */
export function normTitle(title: string): string {
  return title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Same date and normalised title give the same key. Null when either part is missing. */
export function duplicateKey(dateCompleted: string, title: string): string | null {
  const t = normTitle(title);
  if (!dateCompleted || !t) return null;
  return `${dateCompleted}|${t}`;
}
