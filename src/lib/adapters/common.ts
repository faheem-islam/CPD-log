/**
 * Small shared helpers for the source adapters. Everything here is pure: no network, no clock
 * (callers pass `now`), and no global state except WeakMap text caches and the one page that
 * withParsedPage shares with the adapters while they run.
 */
import * as cheerio from "cheerio";
import type { Cheerio, CheerioAPI } from "cheerio";
import type { AnyNode, Element, Text } from "domhandler";
import { formatLongDate, parseDateOrRangeStart, parseTimeRange, parseUkDate, todayUk } from "@/lib/dates";
import type { AdapterResult, Confidence, DraftFieldKey, Field } from "@/lib/types";
import { isTooDeeplyNested } from "./nesting";

export type Doc = CheerioAPI;
export type Sel = Cheerio<AnyNode>;

/**
 * Hard caps so a hostile or huge page cannot make an adapter slow or the response large. The page reader
 * allows up to 2 MiB; only the first MAX_HTML_CHARS of it are parsed. Pages nested deeper than
 * MAX_NESTING_DEPTH (see nesting.ts) are not parsed at all.
 */
export const MAX_HTML_CHARS = 1_000_000;
export const MAX_TEXT_CHARS = 500_000;
/**
 * The longest length accepted from a figure a page states about itself (a video's duration in structured
 * data or social tags, an event's duration). It goes straight into the hours the user logs, and a page can
 * write any number. 24 hours is longer than any real video or session.
 */
export const MAX_PAGE_DURATION_MINUTES = 24 * 60;
export { MAX_NESTING_DEPTH } from "./nesting";
const TITLE_MAX = 300;
const EVIDENCE_QUOTE_MAX = 80;

// ---------------------------------------------------------------------------------------------
// Fields and results
// ---------------------------------------------------------------------------------------------

export function field<T>(value: T, confidence: Exclude<Confidence, "missing">, evidence: string): Field<T> {
  return { value, confidence, evidence };
}

export function missing<T>(evidence: string): Field<T> {
  return { value: null, confidence: "missing", evidence };
}

export function isFound(f: Field<unknown>): boolean {
  return f.confidence !== "missing" && f.value !== null && f.value !== undefined;
}

export const DEFAULT_MISSING_EVIDENCE: Record<DraftFieldKey, string> = {
  title: "We could not find a title on this page. Please enter it.",
  provider: "We could not find who provides this. Please enter it.",
  sourceType: "We could not tell what type of resource this is. Please choose one.",
  theme: "We could not suggest a theme for this page. Please choose one.",
  durationMinutes: "We could not find a length for this resource. Please enter the time you spent.",
  publishedAt: "We could not find a published date on this page.",
  eventDate: "We could not find an event date on this page.",
  providerCpdHours: "The page does not state any CPD hours.",
};

/** A result with every field missing. Adapters start from this and fill in what they find. */
export function emptyResult(adapter: string): AdapterResult {
  return {
    adapter,
    title: missing(DEFAULT_MISSING_EVIDENCE.title),
    provider: missing(DEFAULT_MISSING_EVIDENCE.provider),
    sourceType: missing(DEFAULT_MISSING_EVIDENCE.sourceType),
    theme: missing(DEFAULT_MISSING_EVIDENCE.theme),
    durationMinutes: missing(DEFAULT_MISSING_EVIDENCE.durationMinutes),
    publishedAt: missing(DEFAULT_MISSING_EVIDENCE.publishedAt),
    eventDate: missing(DEFAULT_MISSING_EVIDENCE.eventDate),
    providerCpdHours: missing(DEFAULT_MISSING_EVIDENCE.providerCpdHours),
    flags: { upcoming: false, recording: false },
    notes: [],
  };
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

/**
 * Characters that show nothing but change how text reads: zero-width joiners, left-to-right and
 * right-to-left marks, the bidi embedding, override and isolate controls (which can make "exe.txt" look
 * like "txt.exe"), the word joiner and the invisible operators. They are removed, not turned into spaces,
 * so they cannot join or split two words either.
 */
const INVISIBLE_FORMAT = /[\u200d\u200e\u200f\u202a-\u202e\u2060-\u206f]/g;

export function normSpace(s: string): string {
  // \s already covers no-break space and the byte order mark. Zero-width spaces are not covered, so they
  // become a space; the invisible format characters above are dropped.
  return s.replace(/[\u200b\u200c]/g, " ").replace(INVISIBLE_FORMAT, "").replace(/\s+/g, " ").trim();
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`;
}

/** Page text made safe to show: control characters removed, spaces collapsed, length capped. */
export function cleanText(s: string, max = TITLE_MAX): string {
  // eslint-disable-next-line no-control-regex
  return clip(normSpace(s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ")), max);
}

/** A short quote of page text for use inside an evidence sentence. */
export function quote(s: string): string {
  return clip(cleanText(s, EVIDENCE_QUOTE_MAX * 2), EVIDENCE_QUOTE_MAX);
}

function parseHtml(html: string): Doc {
  const capped = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;
  // A page nested thousands of levels deep takes minutes to parse and search. It is read as an empty page.
  if (isTooDeeplyNested(capped)) return cheerio.load("");
  return cheerio.load(capped);
}

let sharedPage: { html: string; doc: Doc } | null = null;

/**
 * Parses HTML into a document. Only the first MAX_HTML_CHARS are read, and a page that nests too deeply
 * (htmlNestingDepth) comes back as an empty document instead of being parsed.
 */
export function loadDoc(html: string): Doc {
  if (sharedPage !== null && sharedPage.html === html) return sharedPage.doc;
  return parseHtml(html);
}

/**
 * Runs `run` with the page parsed once: every loadDoc(html) inside it, whichever adapter makes it,
 * gets the same document instead of parsing the page again. Adapters only read the document. The
 * orchestrator calls this around the adapters (it is synchronous, so nothing else can interleave).
 */
export function withParsedPage<T>(html: string, run: () => T): T {
  const previous = sharedPage;
  sharedPage = { html, doc: parseHtml(html) };
  try {
    return run();
  } finally {
    sharedPage = previous;
  }
}

/** Runs one extraction step so that a failure in it leaves the other fields alone. */
export function attempt<T>(step: () => T, fallback: T): T {
  try {
    return step();
  } catch {
    return fallback;
  }
}

const BLOCK_TAGS = new Set([
  "address", "article", "aside", "blockquote", "body", "br", "caption", "dd", "details", "dialog", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hr", "li",
  "main", "nav", "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
  "option", "select", "button", "label", "input", "textarea",
]);
/** Inline tags that sit inside a word or a number, so they must never get a space around them. */
const NO_GAP_TAGS = new Set(["sup", "sub", "wbr"]);
/** Elements whose content is never page text. */
const NOISE_TAGS = new Set(["script", "style", "noscript", "template", "svg", "iframe", "head"]);

const ELEMENT_TYPES = new Set(["tag", "script", "style"]);

function isElementNode(node: AnyNode): node is Element {
  return ELEMENT_TYPES.has(node.type as string);
}

export interface MeasuredText {
  text: string;
  /** True when the page had more text than `limit`, so `text` is only the start of it. */
  truncated: boolean;
}

/**
 * Walks the DOM once, without changing it, and joins the text with a space at element boundaries.
 * (Inserting spaces into the DOM instead is quadratic on pages with many siblings.)
 */
function walkText(roots: readonly AnyNode[], skip: ReadonlySet<AnyNode> | null, limit: number): MeasuredText {
  const out: string[] = [];
  let size = 0;
  const emit = (s: string) => {
    out.push(s);
    size += s.length;
  };
  // Entries are nodes still to visit, or a string to emit once the children before it are done.
  const stack: (AnyNode | string)[] = [];
  for (let i = roots.length - 1; i >= 0; i -= 1) {
    const root = roots[i];
    if (root) stack.push(root);
  }
  while (stack.length > 0 && size < limit * 2) {
    const item = stack.pop();
    if (item === undefined) break;
    if (typeof item === "string") {
      emit(item);
      continue;
    }
    if (skip?.has(item)) continue;
    const type = item.type as string;
    if (type === "text") {
      emit((item as Text).data);
      continue;
    }
    if (isElementNode(item)) {
      const name = item.name.toLowerCase();
      if (NOISE_TAGS.has(name)) continue;
      if (BLOCK_TAGS.has(name)) {
        emit(" ");
        stack.push(" ");
      } else if (!NO_GAP_TAGS.has(name) && item.next && isElementNode(item.next)) {
        stack.push(" ");
      }
    } else if (type !== "root") {
      continue; // comments, directives and the like
    }
    const children = (item as Element).children;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i];
      if (child) stack.push(child);
    }
  }
  const stoppedEarly = stack.some((item) => typeof item !== "string");
  const all = normSpace(out.join(""));
  return { text: all.slice(0, limit), truncated: stoppedEarly || all.length > limit };
}

const textCache = new WeakMap<Doc, MeasuredText>();

/**
 * Text of an element with a space at every element boundary, and whether it was cut short.
 *
 * cheerio's .text() glues text across block elements: <div>4 March 2026</div><div>18:00</div> becomes
 * "4 March 202618:00", which breaks date and time searches. Here block elements get a space on both
 * sides and an inline element gets one when another element follows it. sup/sub get none, so
 * "4<sup>th</sup> March" still reads "4th March". Scripts, styles and hidden templates are dropped.
 * The page itself is not changed. `skipSelector` leaves out matching descendants (navigation, files).
 * `limit` is the most text returned; a caller that needs an exact count (words) passes a larger one.
 */
export function measureText(doc: Doc, scope?: Sel, skipSelector?: string, limit: number = MAX_TEXT_CHARS): MeasuredText {
  const whole = scope === undefined && skipSelector === undefined && limit === MAX_TEXT_CHARS;
  if (whole) {
    const hit = textCache.get(doc);
    if (hit !== undefined) return hit;
  }
  const rootSel = scope ?? (doc("body").length > 0 ? doc("body").first() : doc.root());
  const roots = rootSel.toArray();
  // Selecting from the document is linear. Selecting with .find() from an element that has thousands of
  // children is quadratic in cheerio, so it is not used here.
  const skip = skipSelector ? new Set(doc(skipSelector).toArray()) : null;
  for (const root of roots) skip?.delete(root); // a body class such as "menu-open" must not hide the whole body
  const out = walkText(roots, skip, limit);
  if (whole) textCache.set(doc, out);
  return out;
}

/** Text of an element, capped at MAX_TEXT_CHARS. See measureText. */
export function textOf(doc: Doc, scope?: Sel, skipSelector?: string): string {
  return measureText(doc, scope, skipSelector).text;
}

/**
 * True when `el` or one of its ancestors is in `skip`. The search stops at `stopAt` (which is not checked),
 * so a class on an element ABOVE the area being read (a body class such as "menu-open") does not count.
 */
export function isInsideAny(el: AnyNode, skip: ReadonlySet<AnyNode>, stopAt: AnyNode | null = null): boolean {
  for (let node: AnyNode | null = el; node && node !== stopAt; node = node.parent) if (skip.has(node)) return true;
  return false;
}

/** Text of the main content: <main> if there is one, otherwise the body without navigation and footers. */
export function contentText(doc: Doc): string {
  const main = doc("main, [role='main']").first();
  if (main.length > 0) return textOf(doc, main);
  const body = doc("body").first();
  return textOf(doc, body.length > 0 ? body : doc.root(), "nav, footer, [role='navigation'], [role='contentinfo']");
}

const WIDE_SKIP = "nav, footer, aside, [role='navigation'], [role='contentinfo'], [role='complementary']";
const wideCache = new WeakMap<Doc, string>();

/**
 * Text of the whole body except navigation, footers and sidebars. contentText stops at <main>, but some
 * pages put the facts (date, time, length) in a banner above it. Callers read contentText first and come
 * here only when it had nothing, and call what they find here "Check".
 */
export function wideText(doc: Doc): string {
  const hit = wideCache.get(doc);
  if (hit !== undefined) return hit;
  const body = doc("body").first();
  const out = textOf(doc, body.length > 0 ? body : doc.root(), WIDE_SKIP);
  wideCache.set(doc, out);
  return out;
}

export function metaContent(doc: Doc, ...selectors: string[]): string | null {
  for (const sel of selectors) {
    const v = doc(sel).first().attr("content");
    if (v && normSpace(v)) return cleanText(v, 1000);
  }
  return null;
}

export function headingText(doc: Doc): string | null {
  const h1 = doc("h1").first();
  if (h1.length === 0) return null;
  const t = cleanText(textOf(doc, h1));
  return t || null;
}

export function documentTitle(doc: Doc): string | null {
  const t = cleanText(doc("head > title, title").first().text());
  return t || null;
}

// ---------------------------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------------------------

function titleTokens(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter((t) => t.length > 1 || /\d/.test(t));
}

/** The share of the longer title's words that the other title must have for the two to count as the same. */
export const TITLE_MATCH_THRESHOLD = 0.6;

/**
 * True when two titles share most of their words, e.g. "Safe lifting" and "Safe lifting | Site".
 * The overlap is measured against the LONGER title. Measured against the shorter one, a logo heading such
 * as "Example Civils" would match "Notes on drainage | Example Civils" completely, because every one of
 * its words is in the title tag, and the site name would be taken for the page title.
 */
export function titlesPlausiblyMatch(a: string, b: string): boolean {
  const ta = new Set(titleTokens(a));
  const tb = new Set(titleTokens(b));
  if (ta.size === 0 || tb.size === 0) return false;
  let overlap = 0;
  for (const t of ta) if (tb.has(t)) overlap += 1;
  return overlap / Math.max(ta.size, tb.size) >= TITLE_MATCH_THRESHOLD;
}

/** True when two names use the same words, ignoring case and punctuation ("ICE Knowledge-Hub" and "ice knowledge hub"). */
export function sameTitleWords(a: string, b: string): boolean {
  const ta = titleTokens(a).join(" ");
  return ta.length > 0 && ta === titleTokens(b).join(" ");
}

const SUFFIX_SEPARATOR = /\s+(?:\||–|—|·|•|::|«|»|-)\s+/g;

/**
 * Removes a trailing " | Site name" from a page title. Returns what was removed so the caller can say so.
 * A suffix is removed when it is a known site name, or when it is short (up to five words).
 */
export function stripSiteSuffix(title: string, siteNames: readonly string[] = []): { value: string; removed: string | null } {
  const matches = [...title.matchAll(SUFFIX_SEPARATOR)];
  const last = matches[matches.length - 1];
  if (!last || last.index === undefined) return { value: title, removed: null };
  const head = title.slice(0, last.index).trim();
  const tail = title.slice(last.index + last[0].length).trim();
  const known = siteNames.some((n) => n.trim().toLowerCase() === tail.toLowerCase());
  const shortTail = tail.split(/\s+/).filter(Boolean).length <= 5;
  if (head.length >= 3 && tail.length > 0 && (known || shortTail)) return { value: head, removed: tail };
  return { value: title, removed: null };
}

// ---------------------------------------------------------------------------------------------
// Dates and times in text
// ---------------------------------------------------------------------------------------------

const MONTH_WORDS =
  "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const DATE_SCAN_SOURCE = [
  // 4-6 March 2026 (a same-month range; the first day is used)
  String.raw`(?<![\d/.-])\d{1,2}(?:st|nd|rd|th)?\s*[-–—]\s*\d{1,2}(?:st|nd|rd|th)?\s+(?:${MONTH_WORDS})\.?\s+\d{4}(?!\d)`,
  // 4 March 2026, Wed 4th Mar 2026
  String.raw`(?<![\d/.-])\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:${MONTH_WORDS})\.?,?\s+\d{4}(?!\d)`,
  // March 4, 2026
  String.raw`(?<![A-Za-z])(?:${MONTH_WORDS})\.?\s+\d{1,2}(?:st|nd|rd|th)?,?\s+\d{4}(?!\d)`,
  // 04/03/2026, 4.3.26
  String.raw`(?<![\d/.-])\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})(?!\d)`,
  // 2026-03-04, also inside a timestamp
  String.raw`(?<!\d)\d{4}-\d{2}-\d{2}(?!\d)`,
].join("|");

export interface FoundDate {
  iso: string;
  index: number;
  raw: string;
}

/** Every valid UK day-first date in the text, in order. Impossible dates (31/02/2026) are skipped. */
export function findDates(text: string, max = 50): FoundDate[] {
  const re = new RegExp(DATE_SCAN_SOURCE, "gi");
  const out: FoundDate[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < max) {
    const iso = parseDateOrRangeStart(m[0]) ?? parseUkDate(m[0]);
    if (iso) out.push({ iso, index: m.index, raw: m[0] });
  }
  return out;
}

const WEEKDAY_PREFIX = /^(?:(?:mon|tue|wed|thu|fri|sat|sun)[a-z]*\.?,?\s*)?$/i;

/**
 * A date written straight after one of the labels ("Published 4 March 2026", "Date: 04/03/2026").
 * A date that merely appears later in the same sentence does not count.
 */
export function findLabelledDate(
  text: string,
  labels: readonly string[],
  /** A label is ignored when the text just before it matches this (e.g. "Published date"). */
  skipIfPrecededBy?: RegExp,
): { iso: string; raw: string } | null {
  if (labels.length === 0) return null;
  const alternatives = [...labels].sort((a, b) => b.length - a.length).join("|");
  const re = new RegExp(String.raw`(?<![A-Za-z])(${alternatives})\s*(?:on\s+)?[:\-–]?\s*`, "gi");
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = re.exec(text)) && guard < 200) {
    guard += 1;
    if (skipIfPrecededBy?.test(text.slice(Math.max(0, m.index - 30), m.index))) continue;
    const slice = text.slice(m.index + m[0].length, m.index + m[0].length + 48);
    const d = findDates(slice, 1)[0];
    if (!d) continue;
    if (!WEEKDAY_PREFIX.test(slice.slice(0, d.index))) continue;
    return { iso: d.iso, raw: normSpace(`${m[1] ?? ""} ${d.raw}`) };
  }
  return null;
}

const TZ_WORDS = String.raw`(?:\s*(?:GMT|BST|UTC))?`;
const RANGE_SEP = String.raw`\s*(?:-|–|—|to|until)\s*`;
// am or pm only as a whole word, so "2-3 amendments" and "10-11 amazing" are not times.
const AMPM = String.raw`(?:am|pm)(?![A-Za-z])`;
// Needs a colon/dot in both times: "18:00-19:00". This keeps date ranges like "4-5 March" out.
const RANGE_WITH_MINUTES = String.raw`(?<![\d:./-])\d{1,2}[:.]\d{2}\s*(?:${AMPM})?${TZ_WORDS}${RANGE_SEP}\d{1,2}[:.]\d{2}\s*(?:${AMPM})?${TZ_WORDS}(?!\d)`;
// Or an am/pm marker on the end time: "10-11am", "6pm to 7:30pm".
const RANGE_WITH_AMPM = String.raw`(?<![\d:./-])\d{1,2}(?:[:.]\d{2})?\s*(?:${AMPM})?${TZ_WORDS}${RANGE_SEP}\d{1,2}(?:[:.]\d{2})?\s*${AMPM}${TZ_WORDS}(?!\d)`;
const TIME_SCAN_SOURCE = `${RANGE_WITH_MINUTES}|${RANGE_WITH_AMPM}`;

export interface FoundTimeRange {
  raw: string;
  index: number;
  minutes: number;
}

/** Every clock time range in the text ("18:00-19:00", "6pm to 7:30pm") with its length in minutes. */
export function findTimeRanges(text: string, max = 20): FoundTimeRange[] {
  const re = new RegExp(TIME_SCAN_SOURCE, "gi");
  const out: FoundTimeRange[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) && out.length < max) {
    const minutes = parseTimeRange(m[0].replace(/\b(?:GMT|BST|UTC)\b/gi, " "));
    if (minutes !== null) out.push({ raw: normSpace(m[0]), index: m.index, minutes });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Timestamps (JSON-LD startDate, <time datetime>) and the "upcoming" decision
// ---------------------------------------------------------------------------------------------

export interface Stamp {
  /** UK date, YYYY-MM-DD. For a timestamp with a zone it is the date in the UK at that instant. */
  date: string;
  /** Minutes since midnight in UK time, when the stamp has a time. */
  minuteOfDay: number | null;
  /** The exact instant, only when the stamp carries a zone (Z or +01:00). */
  instantMs: number | null;
  /** Wall-clock milliseconds as if UTC, only for a time without a zone. Used for lengths. */
  localMs: number | null;
}

const STAMP_RE =
  /^\s*(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?\s*(Z|[+-]\d{2}(?::?\d{2})?)?)?\s*$/i;

export function ukMinuteOfDay(d: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  return get("hour") * 60 + get("minute");
}

/**
 * Reads "2026-03-04", "2026-03-04T18:00", "2026-03-04T18:00:00+00:00" or "2026-03-04T18:00:00Z".
 * A time without a zone is taken as UK local time. A written date ("4 March 2026") gives a date only.
 */
export function parseStamp(input: string | null | undefined): Stamp | null {
  if (!input) return null;
  const m = STAMP_RE.exec(input);
  if (!m) {
    const d = parseUkDate(input);
    return d ? { date: d, minuteOfDay: null, instantMs: null, localMs: null } : null;
  }
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dateOnly = parseUkDate(`${m[1]}-${m[2]}-${m[3]}`);
  if (!dateOnly) return null;
  if (m[4] === undefined || m[5] === undefined) return { date: dateOnly, minuteOfDay: null, instantMs: null, localMs: null };
  const hh = Number(m[4]);
  const mm = Number(m[5]);
  const ss = Number(m[6] ?? 0);
  if (hh > 23 || mm > 59 || ss > 59) return { date: dateOnly, minuteOfDay: null, instantMs: null, localMs: null };
  const wall = Date.UTC(y, mo - 1, d, hh, mm, ss);
  const zone = m[7];
  if (!zone) return { date: dateOnly, minuteOfDay: hh * 60 + mm, instantMs: null, localMs: wall };
  let offset = 0;
  if (zone.toUpperCase() !== "Z") {
    const zm = /^([+-])(\d{2}):?(\d{2})?$/.exec(zone);
    if (!zm) return { date: dateOnly, minuteOfDay: hh * 60 + mm, instantMs: null, localMs: wall };
    offset = (zm[1] === "-" ? -1 : 1) * (Number(zm[2]) * 60 + Number(zm[3] ?? 0));
  }
  const instantMs = wall - offset * 60000;
  const at = new Date(instantMs);
  return { date: todayUk(at), minuteOfDay: ukMinuteOfDay(at), instantMs, localMs: null };
}

/** Minutes between two stamps that both have a time, or null (also null when they span over 12 hours). */
export function stampLengthMinutes(start: Stamp | null, end: Stamp | null): number | null {
  if (!start || !end) return null;
  let diffMs: number | null = null;
  if (start.instantMs !== null && end.instantMs !== null) diffMs = end.instantMs - start.instantMs;
  else if (start.localMs !== null && end.localMs !== null) diffMs = end.localMs - start.localMs;
  if (diffMs === null) return null;
  const minutes = Math.round(diffMs / 60000);
  return minutes > 0 && minutes <= 12 * 60 ? minutes : null;
}

/**
 * Whether an event has not finished yet. With an exact instant it compares instants. Otherwise it
 * compares the UK date with today, and for an event today it uses the time when the page gave one.
 * An event today with no time we can check counts as upcoming, so nobody logs it before attending.
 */
export function isUpcomingEvent(
  event: { date: string | null; start?: Stamp | null; end?: Stamp | null },
  now: Date,
): boolean {
  const ref = event.end ?? event.start ?? null;
  if (ref && ref.instantMs !== null) return ref.instantMs > now.getTime();
  const date = ref?.date ?? event.date;
  if (!date) return false;
  const today = todayUk(now);
  if (date > today) return true;
  if (date < today) return false;
  if (ref && ref.minuteOfDay !== null) return ukMinuteOfDay(now) < ref.minuteOfDay;
  return true;
}

export function longDate(iso: string): string {
  return formatLongDate(iso) || iso;
}

// ---------------------------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------------------------

export function pathSegments(url: URL): string[] {
  return url.pathname.split("/").filter(Boolean).map((s) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  });
}

/** True when the host is the domain or (when allowed) a subdomain of it. Look-alike hosts do not match. */
export function hostMatches(host: string, domain: string, allowSubdomains: boolean): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  const d = domain.toLowerCase();
  return h === d || h === `www.${d}` || (allowSubdomains && h.endsWith(`.${d}`));
}

/** The URL string for an adapter input, or null when it cannot be parsed. */
export function safeUrl(input: string): URL | null {
  try {
    return new URL(input);
  } catch {
    return null;
  }
}
