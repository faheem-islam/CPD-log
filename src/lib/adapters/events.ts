/**
 * Event pages: one shared extractor plus a small config per host.
 *
 * Event date: High only when machine-readable (JSON-LD startDate, or a <time datetime> tag that is not a
 * published or news date, on a page that looks like an event page); a date found in the text is
 * Check-level. Duration comes from a time range such as 18:00-19:00 and is always Check-level, because
 * it is the scheduled length of the session and not the user's learning time.
 *
 * The facts are looked for in <main> first. When they are not there (a banner above <main> often holds
 * them) the rest of the body, without navigation, footers and sidebars, is searched and what is found is
 * Check and says so. A page that does not look like an event page (no event word in the address, title
 * or heading, and no JSON-LD Event) gets no event date from an unlabelled date in its text, and no length.
 *
 * Flags are decided separately and never from the URL alone:
 *  - upcoming: the event date (and time, when known) is after "now".
 *  - recording: the page offers a recording or on-demand viewing (text, or "recording" in the path).
 * A recording can live under /events/upcoming-events/, so the path section "upcoming" means nothing.
 *
 * ILP lists CPD hours on events. They are captured as providerCpdHours at Check level with evidence
 * starting "Provider-stated:". It is a hint from the provider, not the user's effective learning time.
 *
 * The wording and markup it looks for are hand-written guesses tested only against hand-written
 * fixtures. They have not been checked against the live sites.
 */
import { roundHours, todayUk } from "@/lib/dates";
import type { Adapter, AdapterInput, AdapterResult, Field, SourceType } from "@/lib/types";
import type { Doc, FoundDate, Stamp } from "./common";
import {
  DEFAULT_MISSING_EVIDENCE, attempt, cleanText, contentText, emptyResult, field, findDates, findLabelledDate, findTimeRanges,
  headingText, hostMatches, isUpcomingEvent, loadDoc, longDate, missing, normSpace, parseStamp, pathSegments, quote, safeUrl,
  stampLengthMinutes, wideText,
} from "./common";
import type { EventData } from "./jsonld";
import { isEventNode, jsonLdNodes, readEvent } from "./jsonld";
import { pickTitle } from "./titles";

export interface EventHostConfig {
  id: string;
  /** Provider name shown to the user. */
  name: string;
  /** Short name used in evidence sentences. */
  short: string;
  domains: readonly string[];
  allowSubdomains: boolean;
  /** When set, only paths that match are treated as event pages. */
  pathRe?: RegExp;
  siteNames: readonly string[];
}

export const EVENT_HOSTS: readonly EventHostConfig[] = [
  {
    id: "ice-events", name: "Institution of Civil Engineers (ICE)", short: "ICE", domains: ["ice.org.uk"],
    // knowledgehub.ice.org.uk has its own adapter, so subdomains are not matched here.
    allowSubdomains: false, pathRe: /^\/events(?:\/|$)/i, siteNames: ["ICE", "Institution of Civil Engineers", "ICE events"],
  },
  {
    id: "ciht", name: "Chartered Institution of Highways & Transportation (CIHT)", short: "CIHT", domains: ["ciht.org.uk"],
    allowSubdomains: true, siteNames: ["CIHT", "Chartered Institution of Highways & Transportation", "Chartered Institution of Highways and Transportation"],
  },
  {
    id: "ihe", name: "Institute of Highway Engineers (IHE)", short: "IHE", domains: ["theihe.org"],
    allowSubdomains: true, siteNames: ["IHE", "The IHE", "Institute of Highway Engineers", "The Institute of Highway Engineers"],
  },
  {
    id: "ilp", name: "Institution of Lighting Professionals (ILP)", short: "ILP", domains: ["ilp.org.uk", "theilp.org.uk"],
    allowSubdomains: true, siteNames: ["ILP", "Institution of Lighting Professionals"],
  },
  {
    id: "adept", name: "Association of Directors of Environment, Economy, Planning and Transport (ADEPT)", short: "ADEPT", domains: ["adeptnet.org.uk"],
    allowSubdomains: true, siteNames: ["ADEPT", "ADEPT Network", "Association of Directors of Environment, Economy, Planning and Transport"],
  },
  {
    id: "road-safety-gb", name: "Road Safety GB", short: "Road Safety GB", domains: ["roadsafetygb.org.uk"],
    allowSubdomains: true, siteNames: ["Road Safety GB", "RSGB"],
  },
];

export function eventHostFor(url: URL): EventHostConfig | null {
  for (const cfg of EVENT_HOSTS) {
    if (!cfg.domains.some((d) => hostMatches(url.hostname, d, cfg.allowSubdomains))) continue;
    if (cfg.pathRe && !cfg.pathRe.test(url.pathname)) continue;
    return cfg;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Recording detection
// ---------------------------------------------------------------------------------------------

interface RecordingPattern {
  re: RegExp;
}

// A bare "On demand" is NOT a pattern: it is usually a menu item or a link to a library of other sessions
// ("Events | On demand | News"). It counts only next to a word that says the session itself can be watched.
const RECORDING_PATTERNS: RecordingPattern[] = [
  { re: /\b(?:watch|view|access|see|download)\s+(?:the |this |a |our |your )?(?:full |event |webinar |session |online )*(?:recording|replay)\b/i },
  { re: /\b(?:recording|replay)\s+(?:is |are )?(?:now |also )?available\b/i },
  { re: /\b(?:available|watch(?:\s+it)?|view|stream|access)\s+on[- ]?demand\b/i },
  { re: /\bon[- ]?demand\s+(?:webinar|session|event|recording|video|version)\b/i },
  { re: /\b(?:webinar|session|event|recording)\s+is\s+(?:now\s+)?on[- ]?demand\b/i },
  { re: /\bwatch\s+(?:the\s+)?(?:webinar|session|event|it)\s+again\b/i },
];
/** Words near a match that mean the recording does not exist yet ("will be available after the event"). */
const FUTURE_GUARD = /\b(?:will|would|shall|going to|after the|afterwards|following the|once the|soon|not yet|not available|unavailable|if you miss)\b/i;
const WINDOW = 70;

/** True when the text says a recording exists now. Statements about a future recording are ignored. */
export function textOffersRecording(text: string): boolean {
  for (const pattern of RECORDING_PATTERNS) {
    const g = new RegExp(pattern.re.source, "gi");
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = g.exec(text)) && guard < 20) {
      guard += 1;
      const around = text.slice(Math.max(0, m.index - WINDOW), m.index + m[0].length + WINDOW);
      if (FUTURE_GUARD.test(around)) continue;
      return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------------------------
// Provider CPD hours
// ---------------------------------------------------------------------------------------------

const HOURS_NUM = String.raw`(\d{1,2}(?:\.\d{1,2})?)(?![\d.]*\d)`;
const CPD_HOUR_PATTERNS: { re: RegExp; minutes?: boolean }[] = [
  { re: new RegExp(String.raw`\bCPD\s*(?:hours?|hrs?)\s*(?:[:=\-–]|of|is)?\s*${HOURS_NUM}`, "i") },
  { re: new RegExp(String.raw`(?<![\d.])${HOURS_NUM}\s*(?:hours?|hrs?)\s*(?:of\s+)?CPD\b`, "i") },
  { re: new RegExp(String.raw`\bCPD\s*[:=\-–]\s*${HOURS_NUM}\s*(?:hours?|hrs?)\b`, "i") },
  { re: new RegExp(String.raw`(?<![\d.])${HOURS_NUM}\s*CPD\s*(?:hours?|hrs?)\b`, "i") },
  { re: /\bCPD\s*[:=\-–]?\s*(\d{1,3})\s*(?:minutes?|mins?)\b/i, minutes: true },
];

/** The most hours one event can be worth. A larger number on a page is a mistake or about something else. */
export const MAX_PROVIDER_CPD_HOURS = 40;
/** Words after the number that make it a yearly requirement ("30 hours CPD per year"), not this event's value. */
const YEARLY_AFTER =
  /^[\s,;:)]*(?:(?:per|a|each|every|in a|for the|for a|over the|within a|within the)\s+(?:calendar\s+|cpd\s+)?(?:year|annum|12 months|twelve months)\b|annually\b|yearly\b|p\.a\b|are required\b|is required\b|required\b|needed\b)/i;
/** Words before the number that make it a requirement on members ("Members need 30 hours CPD"). */
const REQUIREMENT_BEFORE =
  /\b(?:need|needs|needed|require|requires|required|must|should|minimum(?: of)?|expected to|obliged to|undertake)\b[^.!?\n]{0,20}$/i;

/** CPD hours the provider states on the page ("CPD hours: 2", "2 hours CPD", "CPD: 1.5 hours"). */
export function findProviderCpdHours(text: string): Field<number> {
  let best: { index: number; hours: number; raw: string } | null = null;
  for (const p of CPD_HOUR_PATTERNS) {
    const g = new RegExp(p.re.source, "gi");
    let m: RegExpExecArray | null;
    let guard = 0;
    while ((m = g.exec(text)) && guard < 20) {
      guard += 1;
      if (m[1] === undefined) continue;
      const n = Number(m[1]);
      const hours = p.minutes ? roundHours(n / 60) : roundHours(n);
      if (!Number.isFinite(hours) || hours <= 0 || hours > MAX_PROVIDER_CPD_HOURS) continue;
      const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40);
      const before = text.slice(Math.max(0, m.index - 60), m.index);
      if (YEARLY_AFTER.test(after) || REQUIREMENT_BEFORE.test(before)) continue;
      if (!best || m.index < best.index) best = { index: m.index, hours, raw: m[0] };
      break;
    }
  }
  if (!best) return missing(DEFAULT_MISSING_EVIDENCE.providerCpdHours);
  return field(
    best.hours,
    "low",
    `Provider-stated: the page says "${quote(best.raw)}". This is a hint from the provider, not your own learning time.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Event date
// ---------------------------------------------------------------------------------------------

/** Words just before a date that mean it is not the event date ("Published", "Booking closes", "Early bird ends"). */
const EXCLUDED_DATE_CONTEXT =
  /(?<![A-Za-z])(?:publish|post|updat|modif|creat|clos|deadline|booking|regist|releas|copyright|issued|founded|since|until|before|by|end|previous|earlier|prior)[A-Za-z]*[\s:.\-–©]*$|©\s*$/i;
const MAX_TIME_TAGS = 25;
/** A <time> that sits in a published, posted, news or blog context is that item's date, not an event date. */
const EXCLUDED_CLASS =
  /publish|posted|post-date|postdate|post-meta|postmeta|entry-date|entry-meta|article-date|article-meta|news|blog|updated|modified|created|byline|copyright/i;
/** A bare "date" or "when" in a class says nothing: every news item has a date. The class must say event. */
const EVENT_CLASS = /event|start|schedule/i;

interface EventTiming {
  date: string | null;
  start: Stamp | null;
  end: Stamp | null;
  dateField: Field<string>;
  /** True when the date came from a "Date:"-style label in the text, which is a strong sign of an event page. */
  labelled: boolean;
  /** True when the event runs over more than one day, so a time range is one day's. */
  multiDay: boolean;
}

function timeElementStamp(doc: Doc, pathLooksLikeEvent: boolean): { stamp: Stamp; datetime: string } | null {
  const found: { stamp: Stamp; datetime: string; score: number }[] = [];
  // A page with thousands of <time> tags is not a normal event page; only the first few are looked at.
  for (const el of doc("time[datetime]").toArray().slice(0, MAX_TIME_TAGS)) {
    const wrapped = doc(el);
    if (wrapped.closest("nav, footer, [role='navigation'], [role='contentinfo']").length > 0) continue;
    const datetime = wrapped.attr("datetime") ?? "";
    const stamp = parseStamp(datetime);
    if (!stamp) continue;
    const chain = [wrapped, ...wrapped.parents().toArray().slice(0, 3).map((p) => doc(p))];
    const classes = chain.map((c) => `${c.attr("class") ?? ""} ${c.attr("id") ?? ""}`).join(" ");
    const parentText = normSpace(wrapped.parent().text()).slice(0, 160);
    if (EXCLUDED_CLASS.test(classes) || /\b(?:published|posted|updated|modified|created|closes?|closing|deadline)\b/i.test(parentText)) continue;
    let score = 0;
    if (EVENT_CLASS.test(classes)) score += 2;
    if (/\b(?:date|when|time|starts?)\b/i.test(parentText)) score += 1;
    found.push({ stamp, datetime, score });
  }
  if (found.length === 0) return null;
  const best = found.reduce((a, b) => (b.score > a.score ? b : a));
  if (best.score >= 1) return best;
  // No cue at all: only trust a lone <time> on a page whose address says it is an event page.
  const distinct = new Set(found.map((f) => f.stamp.date));
  return pathLooksLikeEvent && distinct.size === 1 ? best : null;
}

const DATE_LABELS = ["Event date", "Date and time", "Date & time", "Date/time", "Start date", "Starts on", "Starts", "Date", "When"];

interface TextDate {
  iso: string;
  raw: string;
  labelled: boolean;
  /** How many other distinct dates the text has (unlabelled dates only). */
  others: number;
  /** True when a later date was chosen because the first one in the text has already passed. */
  skippedPast: boolean;
  /** True when it was found outside <main>. */
  outside: boolean;
}

function labelledEventDate(text: string): TextDate | null {
  // "Published date: 1 March 2026" or "Booking closes: 1 March 2026" must not count as the event date.
  const labelled = findLabelledDate(text, DATE_LABELS, EXCLUDED_DATE_CONTEXT);
  return labelled ? { iso: labelled.iso, raw: labelled.raw, labelled: true, others: 0, skippedPast: false, outside: false } : null;
}

function unlabelledEventDate(text: string, now: Date): TextDate | null {
  const all = findDates(text).filter((d: FoundDate) => !EXCLUDED_DATE_CONTEXT.test(text.slice(Math.max(0, d.index - 30), d.index)));
  const first = all[0];
  if (!first) return null;
  // The first date in the text is often an earlier session ("following our session on 4 March 2025, join
  // us again on 12 November 2026"). With more than one date, the first one that has not passed is used,
  // so a future event is not reported as past (and not flagged as upcoming).
  const today = todayUk(now);
  const next = all.find((d) => d.iso >= today) ?? first;
  const distinct = new Set(all.map((d) => d.iso));
  return { iso: next.iso, raw: next.raw, labelled: false, others: distinct.size - 1, skippedPast: next !== first && next.iso !== first.iso, outside: false };
}

/**
 * The event date from the text. A labelled date is tried first, in <main> and then outside it; an unlabelled
 * date is only used on a page that looks like an event page.
 */
function textEventDate(text: string, wide: string | null, now: Date, allowUnlabelled: boolean): TextDate | null {
  const inMain = labelledEventDate(text);
  if (inMain) return inMain;
  const labelledOutside = wide ? labelledEventDate(wide) : null;
  if (labelledOutside) return { ...labelledOutside, outside: true };
  if (!allowUnlabelled) return null;
  const guessed = unlabelledEventDate(text, now);
  if (guessed) return guessed;
  const guessedOutside = wide ? unlabelledEventDate(wide, now) : null;
  return guessedOutside ? { ...guessedOutside, outside: true } : null;
}

/** "4-6 March 2027", also with a label in front ("Date 4-6 March 2027"). */
const DAY_RANGE_RE = /(?:^|\s)\d{1,2}(?:st|nd|rd|th)?\s*[-–—]\s*\d{1,2}(?:st|nd|rd|th)?\s+[A-Za-z]{3}/;

interface TimingContext {
  text: string;
  /** Text of the rest of the page, or null when it is the same as `text`. */
  wide: string | null;
  now: Date;
  pathLooksLikeEvent: boolean;
  looksLikeEvent: boolean;
}

function resolveTiming(doc: Doc, event: EventData | null, ctx: TimingContext): EventTiming {
  const none = { start: null, end: null, labelled: false, multiDay: false };
  const startLd = parseStamp(event?.startDate);
  if (startLd) {
    const endLd = parseStamp(event?.endDate);
    return {
      ...none, date: startLd.date, start: startLd, end: endLd, multiDay: Boolean(endLd && endLd.date > startLd.date),
      dateField: field(startLd.date, "high", `The page's structured data gives the event date as ${longDate(startLd.date)}.`),
    };
  }
  // A <time> tag is trusted only on a page that looks like an event page: every news item has one too.
  const tagged = ctx.looksLikeEvent ? timeElementStamp(doc, ctx.pathLooksLikeEvent) : null;
  if (tagged) {
    return {
      ...none, date: tagged.stamp.date, start: tagged.stamp,
      dateField: field(tagged.stamp.date, "high", `The page's date tag gives the event date as ${longDate(tagged.stamp.date)}.`),
    };
  }
  const t = textEventDate(ctx.text, ctx.wide, ctx.now, ctx.looksLikeEvent);
  if (t) {
    const where = t.outside ? " It is outside the main part of the page, so look at it closely." : "";
    const more = t.others > 0 ? (t.skippedPast ? " The page has more than one date. We used the first one that has not passed yet." : " The page has more than one date.") : "";
    const evidence = t.labelled
      ? `The page text says "${quote(t.raw)}". A date in the page text is not machine-readable, so check it.${where}`
      : `The page text mentions ${longDate(t.iso)}, so we guessed that is the event date.${more}${where} Check it.`;
    return { ...none, date: t.iso, labelled: t.labelled, multiDay: DAY_RANGE_RE.test(t.raw), dateField: field(t.iso, "low", evidence) };
  }
  return { ...none, date: null, dateField: missing(DEFAULT_MISSING_EVIDENCE.eventDate) };
}

// ---------------------------------------------------------------------------------------------
// Duration from time ranges
// ---------------------------------------------------------------------------------------------

const TIME_LABEL_RE = /(?<![A-Za-z])(?:time|when|date and time|date & time|date\/time|starts?|start time|session time)\s*[:\-–]?\s*/gi;
const SCHEDULED_NOT_LEARNING = "That is the scheduled length of the session, not your learning time. Check it.";
const EACH_DAY_RE = /^[^.]{0,30}?\b(?:each|every|per)\s+day\b|^[^.]{0,30}?\bdaily\b/i;

function durationFromText(text: string, notes: string[], multiDay: boolean, outside: boolean): Field<number> | null {
  const all = findTimeRanges(text);
  if (all.length === 0) return null;
  let chosen = all[0];
  const label = new RegExp(TIME_LABEL_RE.source, TIME_LABEL_RE.flags);
  let m: RegExpExecArray | null;
  let guard = 0;
  while ((m = label.exec(text)) && guard < 100) {
    guard += 1;
    const start = m.index + m[0].length;
    const inWindow = findTimeRanges(text.slice(start, start + 100), 1)[0];
    if (inWindow) {
      chosen = all.find((r) => r.raw === inWindow.raw) ?? chosen;
      break;
    }
  }
  if (!chosen) return null;
  const distinct = new Set(all.map((r) => r.raw.toLowerCase()));
  if (distinct.size > 1) notes.push("The page lists more than one time range. We used one of them for the length. Check it.");
  const where = outside ? " It is outside the main part of the page." : "";
  const afterRange = text.slice(chosen.index + chosen.raw.length, chosen.index + chosen.raw.length + 50);
  if (multiDay || EACH_DAY_RE.test(afterRange)) {
    return field(
      chosen.minutes,
      "low",
      `The page lists ${chosen.raw} for each day of an event that runs over more than one day. That is one day's scheduled length, not the whole event and not your learning time. Check it.${where}`,
    );
  }
  return field(chosen.minutes, "low", `The page lists ${chosen.raw}. ${SCHEDULED_NOT_LEARNING}${where}`);
}

function durationField(timing: EventTiming, ctx: TimingContext, notes: string[]): Field<number> {
  const fromStamps = stampLengthMinutes(timing.start, timing.end);
  if (fromStamps !== null) {
    return field(fromStamps, "low", `The page's start and end times give ${fromStamps} minutes. ${SCHEDULED_NOT_LEARNING}`);
  }
  // A time range in the text of a page that does not look like an event page is not a session length.
  if (!ctx.looksLikeEvent && !timing.labelled) {
    return missing("This page does not look like an event page, so we did not read a length from its text. Please enter the time you spent.");
  }
  const fromText = durationFromText(ctx.text, notes, timing.multiDay, false);
  if (fromText) return fromText;
  const outside = ctx.wide ? durationFromText(ctx.wide, notes, timing.multiDay, true) : null;
  if (outside) return outside;
  return missing("We could not find a start and end time on this page, so there is no length. Please enter the time you spent.");
}

// ---------------------------------------------------------------------------------------------
// Source type
// ---------------------------------------------------------------------------------------------

const EVENT_WORDS = /\b(?:event|webinar|conference|seminar|workshop|training|course|symposium|summit|masterclass|roundtable|forum|lecture)s?\b/i;

function sourceTypeField(args: {
  event: EventData | null;
  headings: string;
  path: string;
  text: string;
  recording: boolean;
  looksLikeEvent: boolean;
}): Field<SourceType> {
  const { event, headings, path, text, recording, looksLikeEvent } = args;
  if (event?.mode === "online") return field("webinar", "high", "The page's structured data says this is an online event.");
  if (/\bwebinar\b/i.test(`${headings} ${path}`)) return field("webinar", "high", "The page calls this a webinar in its title or address.");
  if (event?.mode === "offline") return field("live_event", "high", "The page's structured data says this event is held in person.");
  if (event?.mode === "mixed") return field("live_event", "low", "The page's structured data says this can be attended online or in person. Check which you did.");
  if (/\bwebinar\b/i.test(text)) return field("webinar", "low", "The page text mentions a webinar. Check it.");
  if (recording) return field("webinar", "low", "The page offers a recording, so we assumed a webinar. Check it.");
  // Naming an online meeting tool is a stronger sign than the word "online", which can be "book online".
  if (/\b(?:microsoft teams|ms teams|zoom|webex|live[- ]?stream)\b/i.test(text)) {
    return field("webinar", "low", "The page mentions an online meeting tool, so we assumed a webinar. Check it.");
  }
  if (event?.hasPlace || /\b(?:venue|in[- ]person|face[- ]to[- ]face)\b/i.test(text)) {
    return field("live_event", "low", "The page mentions a venue or an in-person event, so we assumed a live event. Check it.");
  }
  if (/\b(?:online|virtual)\b/i.test(text)) {
    return field("webinar", "low", "The page mentions an online event, so we assumed a webinar. Check it.");
  }
  if (looksLikeEvent) {
    return field("live_event", "low", "We could not tell whether this is online or in person, so we assumed a live event. Check it.");
  }
  return missing("This page does not look like an event page, so we could not tell what type of resource it is. Please choose one.");
}

// ---------------------------------------------------------------------------------------------
// The shared extractor
// ---------------------------------------------------------------------------------------------

export function extractEventPage({ url, html, now }: AdapterInput, host: EventHostConfig | null): AdapterResult {
  const result = emptyResult("events");
  const parsed = safeUrl(url);
  const doc = loadDoc(html);
  // Each step stands alone: one odd field on a page must not lose the others.
  const nodes = attempt(() => jsonLdNodes(doc), []);
  const text = attempt(() => contentText(doc), "");
  const path = parsed ? pathSegments(parsed).join("/") : "";
  const eventNode = nodes.find(isEventNode);
  const event = attempt(() => (eventNode ? readEvent(eventNode) : null), null);

  result.title = attempt(() => pickTitle(doc, nodes, { trustHeading: true, siteNames: host?.siteNames ?? [] }), result.title);
  const titleText = result.title.value ?? "";
  const headings = `${titleText} ${attempt(() => headingText(doc), null) ?? ""}`;

  const pathLooksLikeEvent = EVENT_WORDS.test(path.replace(/[-_]/g, " "));
  const looksLikeEvent = Boolean(event) || pathLooksLikeEvent || EVENT_WORDS.test(headings) || Boolean(host?.pathRe);

  if (host) {
    result.provider = field(host.name, "high", `The page is on the ${host.short} website, so ${host.name} is shown as the provider.`);
  }

  // The rest of the page, for facts that sit in a banner above <main>. Null when it adds nothing.
  const wideRaw = attempt(() => wideText(doc), text);
  const wide = wideRaw === text ? null : wideRaw;
  const ctx: TimingContext = { text, wide, now, pathLooksLikeEvent, looksLikeEvent };

  const timing = attempt(
    () => resolveTiming(doc, event, ctx),
    { date: null, start: null, end: null, labelled: false, multiDay: false, dateField: missing(DEFAULT_MISSING_EVIDENCE.eventDate) } as EventTiming,
  );
  result.eventDate = timing.dateField;
  result.durationMinutes = attempt(() => durationField(timing, ctx, result.notes), result.durationMinutes);
  result.providerCpdHours = attempt(() => {
    const inMain = findProviderCpdHours(text);
    if (inMain.value !== null || wide === null) return inMain;
    const outside = findProviderCpdHours(wide);
    return outside.value === null ? inMain : { ...outside, evidence: `${outside.evidence} It is outside the main part of the page.` };
  }, result.providerCpdHours);

  const recordingFromPath = /recording/i.test(path);
  const recordingFromTitle = /^\s*(?:recording|on[- ]?demand)\b\s*[:\-–]/i.test(titleText);
  const recording = recordingFromPath || recordingFromTitle || attempt(() => textOffersRecording(text), false);
  result.flags.recording = recording;
  if (recording) {
    result.notes.push(
      recordingFromPath
        ? "The web address says this is a recording. Log it after you have watched it."
        : "The page offers a recording or on-demand viewing. Log it after you have watched it.",
    );
  }

  result.sourceType = attempt(() => sourceTypeField({ event, headings, path, text, recording, looksLikeEvent }), result.sourceType);

  if (timing.date) {
    const upcoming = isUpcomingEvent({ date: timing.date, start: timing.start, end: timing.end }, now);
    result.flags.upcoming = upcoming;
    if (upcoming) {
      result.notes.push("This event has not happened yet. Log it only after you have attended.");
      if (!timing.start || timing.start.instantMs === null) {
        const today = cleanText(longDate(timing.date));
        if (timing.date === todayUk(now)) result.notes.push(`The event is today (${today}). If it has already finished, you can log it now.`);
      }
      if (recording) result.notes.push("The page mentions a recording but also gives a future date. Check which one you are logging.");
    }
  }
  if (event?.status) {
    result.notes.push(`The page's structured data marks this event as ${event.status}. Check before you log it.`);
  }
  return result;
}

export const eventsAdapter: Adapter = {
  id: "events",
  specificity: 60,
  matches(url: URL): boolean {
    return eventHostFor(url) !== null;
  },
  extract(input: AdapterInput): AdapterResult {
    const url = safeUrl(input.url);
    return extractEventPage(input, url ? eventHostFor(url) : null);
  },
};
