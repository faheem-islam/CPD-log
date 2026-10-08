/**
 * Turns the page reader's answer into the form's starting values. Pure and client-safe.
 *
 * Rules that matter here:
 *  - Detected values keep the confidence the reader gave them. A guess stays "Check".
 *  - Hours are only a suggestion converted from the detected length. They are never confirmed for the person.
 *  - The provider's stated CPD hours are a hint and are never put into the hours box.
 *  - Date completed is today (UK) unless the page is a past live event; it is never a future date.
 */
import type { HoursHint } from "@/components/entry/entry-form";
import {
  DEFAULT_DEV_PLAN_REF,
  blankEntryInput,
  categoryForSourceType,
  confidenceFromField,
  hasAnyBenefit,
  type ConfidenceMap,
} from "@/components/entry/entry-helpers";
import { formatDuration, formatLongDate, minutesToHours } from "@/lib/dates";
import { ICE_ALL_THEMES, matchOption } from "@/lib/profiles";
import {
  SOURCE_TYPE_LABELS,
  type AdapterFlags,
  type AdapterResult,
  type EntryInput,
  type ExtractResponse,
  type Field,
  type FieldConfidence,
  type ProfileId,
} from "@/lib/types";

export interface Draft {
  value: EntryInput;
  hoursHint: HoursHint;
  flags: AdapterFlags;
  /** Plain-language notes from the page reader, minus any that repeat the event flags. */
  notes: string[];
}

const PASTED: FieldConfidence = { level: "high", evidence: "The link you pasted." };

function found<T>(f: Field<T>): f is Field<T> & { value: T } {
  return f.value !== null && f.value !== undefined && f.confidence !== "missing";
}

/** Match a detected theme name to one of the seven ICE themes. A loose match is only a guess, so it is marked Check. */
function iceTheme(f: Field<string>): { value: string | null; confidence: FieldConfidence } {
  if (found(f)) {
    if (ICE_ALL_THEMES.includes(f.value)) return { value: f.value, confidence: { level: f.confidence, evidence: f.evidence } };
    const loose = matchOption(f.value, ICE_ALL_THEMES);
    if (loose) {
      return { value: loose, confidence: { level: "low", evidence: `${f.evidence} We matched it to "${loose}", which is a guess.` } };
    }
  }
  return { value: null, confidence: { level: "missing", evidence: f.evidence || "We could not suggest a theme for this page. Please choose one." } };
}

function completedDate(r: AdapterResult, todayIso: string): { date: string; confidence: FieldConfidence } {
  const ev = r.eventDate;
  const eventDate = found(ev) ? ev.value : null;
  const pastLiveEvent =
    r.sourceType.value === "live_event" && !r.flags.recording && !r.flags.upcoming && eventDate !== null && eventDate < todayIso;
  if (pastLiveEvent && eventDate) {
    return { date: eventDate, confidence: { level: ev.confidence, evidence: ev.evidence || `The event date on the page is ${formatLongDate(eventDate)}.` } };
  }
  if (eventDate && eventDate > todayIso) {
    return {
      date: todayIso,
      confidence: {
        level: "estimate",
        evidence: `Set to today. The page gives ${formatLongDate(eventDate)} for the event, which hasn't happened yet. Change this to the day you attended.`,
      },
    };
  }
  return { date: todayIso, confidence: { level: "estimate", evidence: "Set to today. Change it if you finished on another day." } };
}

/** Notes that only repeat the "hasn't happened yet" notice are dropped, so it is said once. */
function usefulNotes(notes: readonly string[], flags: AdapterFlags): string[] {
  return notes.filter((n) => !(flags.upcoming && /\blog it (only )?after\b/i.test(n)));
}

/** A successful read. The caller has checked res.status === "ok" and res.result is present. */
export function draftFromExtract(res: ExtractResponse, r: AdapterResult, opts: { profile: ProfileId; todayIso: string; typedLink: string }): Draft {
  const base = blankEntryInput(opts.profile, opts.todayIso);
  const confidence: ConfidenceMap = { ...base.confidence };
  const value: EntryInput = { ...base };

  value.title = found(r.title) ? r.title.value : "";
  confidence.title = confidenceFromField(r.title);

  value.url = res.url || opts.typedLink || null;
  confidence.url = PASTED;

  value.provider = found(r.provider) ? r.provider.value : "";
  confidence.provider = confidenceFromField(r.provider);

  value.sourceType = found(r.sourceType) ? r.sourceType.value : "other";
  confidence.sourceType = confidenceFromField(r.sourceType);

  if (found(r.publishedAt)) {
    value.publishedAt = r.publishedAt.value;
    confidence.publishedAt = confidenceFromField(r.publishedAt);
  }

  const theme = iceTheme(r.theme);
  value.theme = theme.value;
  confidence.theme = theme.confidence;

  const done = completedDate(r, opts.todayIso);
  value.dateCompleted = done.date;
  confidence.dateCompleted = done.confidence;

  const hoursHint: HoursHint = {};
  const minutes = found(r.durationMinutes) ? r.durationMinutes.value : null;
  const suggested = minutes !== null ? minutesToHours(minutes) : 0;
  if (minutes !== null && suggested > 0) {
    value.detectedDurationMinutes = minutes;
    confidence.detectedDurationMinutes = confidenceFromField(r.durationMinutes);
    // A starting point only. The person still has to tick the confirmation before anything is saved.
    value.hours = suggested;
    value.hoursConfirmed = false;
    confidence.hours = {
      level: "estimate",
      evidence: `Suggested from the detected length of ${formatDuration(minutes)}. Change it to the time you actually spent learning.`,
    };
    hoursHint.suggestion = { hours: suggested, detected: formatDuration(minutes), confidence: confidence.detectedDurationMinutes };
  } else {
    confidence.hours = { level: "missing", evidence: r.durationMinutes.evidence || "We could not find a length for this resource. Please enter the time you spent." };
    hoursHint.notFound = "We couldn't find how long this is, so the hours box is empty. Enter the time you actually spent learning.";
  }
  if (found(r.providerCpdHours) && r.providerCpdHours.value > 0) {
    hoursHint.providerStated = { hours: r.providerCpdHours.value };
  }

  const suggestion = categoryForSourceType(value.sourceType);
  if (suggestion) {
    value.category = suggestion;
    confidence.category = {
      level: "estimate",
      evidence: `Suggested from the type of resource (${SOURCE_TYPE_LABELS[value.sourceType]}). Change it if another category fits better.`,
    };
  } else {
    confidence.category = { level: "missing", evidence: "Choose the category that fits best." };
  }

  value.confidence = confidence;
  return { value, hoursHint, flags: r.flags, notes: usefulNotes(r.notes, r.flags) };
}

/** Make a pasted link usable in the Link field. Does not check it: the form's own check does that. */
export function linkForForm(text: string): string | null {
  const t = text.trim();
  if (!t) return null;
  if (/^https?:\/\//i.test(t)) return t;
  if (/^www\./i.test(t)) return `https://${t}`;
  return t;
}

/** The link to carry into the form's Link field from the paste box, or null when the text there is not a web address. */
export function linkToCarry(text: string): string | null {
  const picked = pickLink(text);
  if (picked.error || !/^(https?:\/\/|www\.)/i.test(picked.link)) return null;
  return linkForForm(picked.link);
}

/** The manual form, with the link kept if there is one. */
export function draftForManual(opts: { profile: ProfileId; todayIso: string; link: string | null }): Draft {
  const base = blankEntryInput(opts.profile, opts.todayIso);
  const value: EntryInput = { ...base, url: opts.link, confidence: { ...base.confidence } };
  if (opts.link) value.confidence.url = PASTED;
  return { value, hoursHint: {}, flags: { upcoming: false, recording: false }, notes: [] };
}

/** Has anything been entered, or changed from how a new form starts? The link on its own does not count. */
export function hasTypedContent(v: EntryInput, todayIso: string): boolean {
  const text = (s: string | null | undefined) => (s ?? "").trim() !== "";
  const plan = v.devPlanRef.trim();
  return (
    text(v.title) ||
    text(v.provider) ||
    text(v.learningPoints) ||
    text(v.developmentGained) ||
    text(v.notes) ||
    hasAnyBenefit(v.benefits) ||
    Object.values(v.custom).some((x) => text(x)) ||
    v.hours > 0 ||
    v.hoursConfirmed ||
    v.theme !== null ||
    v.category !== null ||
    v.structuralSafety !== null ||
    v.sustainability !== null ||
    v.publishedAt !== null ||
    v.dateEnd !== null ||
    v.detectedDurationMinutes !== null ||
    v.sourceType !== "other" ||
    v.dateCompleted !== todayIso ||
    (plan !== "" && plan !== DEFAULT_DEV_PLAN_REF)
  );
}

/** Put a link in the form's Link field, but only if that field is empty. Whatever the person typed there stays. */
export function withLink(value: EntryInput, link: string | null): EntryInput {
  if (!link || (value.url ?? "").trim() !== "") return value;
  return { ...value, url: link, confidence: { ...value.confidence, url: PASTED } };
}

/** Longest address the reader accepts. The API's own message says "over 2,000 characters". */
const MAX_LINK_CHARS = 2000;

/**
 * What to do with the text in the paste box. A web address inside a sentence ("Great talk: https://...")
 * is picked out. Text that cannot be a link is explained here, in the box, before anything is sent.
 * Anything else goes to the reader as it is: its own messages for typos and unusable links are already plain.
 */
export function pickLink(text: string): { link: string; error: string | null } {
  const t = text.trim();
  if (!t) return { link: "", error: "Paste a link to a web page first, for example https://www.example.com/article." };
  let candidate = t;
  if (/\s/.test(t)) {
    const found = Array.from(new Set(t.match(/https?:\/\/[^\s<>"“”‘’]+/gi) ?? []));
    const only = found.length === 1 ? found[0] : undefined;
    if (only) candidate = only.replace(/[.,;:!?)\]}>]+$/, "");
  }
  if (candidate.length > MAX_LINK_CHARS) {
    return {
      link: t,
      error: /\s/.test(candidate)
        ? "That is too much text to be a link. Paste only the web address of the page."
        : "That link is too long (over 2,000 characters). Paste the shorter web address of the page.",
    };
  }
  return { link: candidate, error: null };
}
