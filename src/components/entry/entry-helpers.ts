/**
 * Pure helpers shared by the Add flow and the Log edit dialog. Client-safe: no server-only imports.
 *
 * The form works on an `EntryInput` (an Entry without id, userId and timestamps). Three ideas run through it:
 *
 *  - Confidence. `EntryInput.confidence` holds, per field, how the value was found: { level, evidence }.
 *    A value read from a page keeps the level the reader gave it. A value the person typed or changed is
 *    stored as level "high" with the evidence "Typed by you" (it is not auto-detected). A field left empty
 *    is stored as "missing". Nothing here ever claims a value has been confirmed as correct.
 *
 *  - Blocking checks. `checkEntry` returns plain-language errors for the few things that cannot be saved
 *    (no title, no valid date, no hours, hours not confirmed). Everything else is a soft warning
 *    (see entry-warnings.tsx) and never stops a save.
 *
 *  - Tidying before save. `prepareForSave` trims text, drops fields that belong to a profile the entry is not in,
 *    and fills in the confidence map.
 *
 * For editing an existing entry: `entryToInput(entry)` gives the form its value, and `changedFields(before, after)`
 * gives the smallest patch to send to PATCH /api/entries/[id]. Send `aiReviewed: true` only if the patch contains
 * `aiAssisted: true` (the API refuses it otherwise).
 */
import { EMPTY_BENEFITS } from "@/lib/benefits";
import { formatHours, isValidYmd, roundHours } from "@/lib/dates";
import { PROFILES } from "@/lib/profiles";
import type {
  BenefitParts,
  CustomFieldDef,
  Entry,
  EntryInput,
  Field,
  FieldConfidence,
  ProfileId,
  SourceType,
  UserSettings,
} from "@/lib/types";

/** What the ICE Dev. Plan ref column shows when nothing was planned. */
export const DEFAULT_DEV_PLAN_REF = "unplanned";
export const TYPED_EVIDENCE = "Typed by you";
export const LEFT_EMPTY_EVIDENCE = "Left empty";
export const MAX_HOURS = 9999.99;

/** Quick-pick buttons next to the hours box. */
export const HOUR_QUICK_PICKS = [0.25, 0.5, 1, 1.5, 2] as const;

export type ConfidenceMap = Record<string, FieldConfidence>;
/** Field key to a message. Custom fields use "custom.<key>". */
export type EntryErrors = Record<string, string>;

// ---------------------------------------------------------------------------------------------
// Blank and converted values

/** An empty entry for the manual form. Date completed starts as today (UK); everything else is empty. */
export function blankEntryInput(profile: ProfileId, todayIso: string): EntryInput {
  return {
    profile,
    title: "",
    url: null,
    provider: null,
    sourceType: "other",
    publishedAt: null,
    dateCompleted: todayIso,
    dateEnd: null,
    detectedDurationMinutes: null,
    hours: 0,
    hoursConfirmed: false,
    theme: null,
    category: null,
    structuralSafety: null,
    sustainability: null,
    devPlanRef: profile === "ice" ? DEFAULT_DEV_PLAN_REF : "",
    learningPoints: "",
    benefits: { ...EMPTY_BENEFITS },
    developmentGained: "",
    custom: {},
    notes: "",
    aiAssisted: false,
    confidence: {
      sourceType: { level: "missing", evidence: "Not chosen yet. Pick the one that fits best." },
      dateCompleted: { level: "estimate", evidence: "Set to today. Change it if you finished on another day." },
      ...(profile === "ice"
        ? { devPlanRef: { level: "estimate" as const, evidence: `Set to "${DEFAULT_DEV_PLAN_REF}" until you add a plan reference.` } }
        : {}),
    },
  };
}

/** A saved entry as form input: id, user and timestamps dropped, nested values copied. */
export function entryToInput(entry: Entry): EntryInput {
  return {
    profile: entry.profile,
    title: entry.title,
    url: entry.url,
    provider: entry.provider,
    sourceType: entry.sourceType,
    publishedAt: entry.publishedAt,
    dateCompleted: entry.dateCompleted,
    dateEnd: entry.dateEnd,
    detectedDurationMinutes: entry.detectedDurationMinutes,
    hours: entry.hours,
    hoursConfirmed: entry.hoursConfirmed,
    theme: entry.theme,
    category: entry.category,
    structuralSafety: entry.structuralSafety,
    sustainability: entry.sustainability,
    devPlanRef: entry.devPlanRef,
    learningPoints: entry.learningPoints,
    benefits: { ...entry.benefits },
    developmentGained: entry.developmentGained,
    custom: { ...entry.custom },
    notes: entry.notes,
    aiAssisted: entry.aiAssisted,
    confidence: Object.fromEntries(Object.entries(entry.confidence).map(([k, v]) => [k, { ...v }])),
  };
}

const INPUT_KEYS: readonly (keyof EntryInput)[] = [
  "profile", "title", "url", "provider", "sourceType", "publishedAt", "dateCompleted", "dateEnd",
  "detectedDurationMinutes", "hours", "hoursConfirmed", "theme", "category", "structuralSafety", "sustainability",
  "devPlanRef", "learningPoints", "benefits", "developmentGained", "custom", "notes", "aiAssisted", "confidence",
];

/** Only the fields whose value differs. Use as the `patch` for PATCH /api/entries/[id]. */
export function changedFields(before: EntryInput, after: EntryInput): Partial<EntryInput> {
  const patch: Record<string, unknown> = {};
  for (const key of INPUT_KEYS) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) patch[key] = after[key];
  }
  return patch as Partial<EntryInput>;
}

/** Switching log: ICE gets its default plan reference back if it was empty. Other values are kept. */
export function changeProfile(value: EntryInput, next: ProfileId): EntryInput {
  if (next === value.profile) return value;
  const devPlanRef = next === "ice" && !value.devPlanRef.trim() ? DEFAULT_DEV_PLAN_REF : value.devPlanRef;
  return { ...value, profile: next, devPlanRef };
}

// ---------------------------------------------------------------------------------------------
// Confidence

export function typedByYou(): FieldConfidence {
  return { level: "high", evidence: TYPED_EVIDENCE };
}

export function leftEmpty(evidence: string = LEFT_EMPTY_EVIDENCE): FieldConfidence {
  return { level: "missing", evidence };
}

/** The confidence of a value an adapter found (or did not find). */
export function confidenceFromField<T>(f: Field<T>): FieldConfidence {
  const found = f.value !== null && f.value !== undefined && f.confidence !== "missing";
  return found ? { level: f.confidence, evidence: f.evidence } : { level: "missing", evidence: f.evidence || "Not found." };
}

/** The recorded confidence for a field, or undefined when none was recorded (older entries, imports). */
export function confidenceOf(map: ConfidenceMap | undefined, key: string): FieldConfidence | undefined {
  if (!map || !Object.hasOwn(map, key)) return undefined;
  return map[key];
}

/** Does the field hold a value? Used to decide between "Typed by you" and "missing". */
export function fieldHasValue(value: EntryInput, key: string): boolean {
  switch (key) {
    case "title": return value.title.trim() !== "";
    case "url": return (value.url ?? "").trim() !== "";
    case "provider": return (value.provider ?? "").trim() !== "";
    case "sourceType": return true;
    case "publishedAt": return Boolean(value.publishedAt);
    case "dateCompleted": return Boolean(value.dateCompleted);
    case "dateEnd": return Boolean(value.dateEnd);
    case "detectedDurationMinutes": return value.detectedDurationMinutes !== null;
    case "hours": return value.hours > 0;
    case "theme": return Boolean(value.theme);
    case "category": return Boolean(value.category);
    case "structuralSafety": return value.structuralSafety !== null;
    case "sustainability": return value.sustainability !== null;
    case "devPlanRef": return value.devPlanRef.trim() !== "";
    case "learningPoints": return value.learningPoints.trim() !== "";
    case "benefits": return hasAnyBenefit(value.benefits);
    case "developmentGained": return value.developmentGained.trim() !== "";
    default: {
      if (key.startsWith("custom.")) return (value.custom[key.slice("custom.".length)] ?? "").trim() !== "";
      return false;
    }
  }
}

export function hasAnyBenefit(b: BenefitParts): boolean {
  return b.helped.trim() !== "" || b.future.trim() !== "" || b.nextYear.trim() !== "";
}

/** Is there reflection text in the fields that the entry's log uses? */
export function hasReflectionText(value: Pick<EntryInput, "profile" | "learningPoints" | "benefits" | "developmentGained">): boolean {
  if (value.profile === "istructe") return value.developmentGained.trim() !== "";
  if (value.profile === "ice") return value.learningPoints.trim() !== "" || hasAnyBenefit(value.benefits);
  return value.learningPoints.trim() !== "";
}

/** Record that fields were edited by hand: a value becomes "Typed by you", an emptied field becomes "missing". */
export function markEdited(value: EntryInput, keys: readonly string[]): ConfidenceMap {
  const map: ConfidenceMap = { ...value.confidence };
  for (const key of keys) map[key] = fieldHasValue(value, key) ? typedByYou() : leftEmpty();
  return map;
}

/** Fields that are tracked for every entry, then the ones that belong to each log. */
function trackedKeys(profile: ProfileId): string[] {
  const common = ["title", "url", "provider", "sourceType", "dateCompleted", "hours"];
  if (profile === "ice") return [...common, "theme", "devPlanRef", "learningPoints", "benefits"];
  if (profile === "istructe") return [...common, "category", "structuralSafety", "sustainability", "developmentGained"];
  return [...common, "learningPoints"];
}

/**
 * Fills the confidence map before saving. Values keep what they were given. A value with no record becomes
 * "Typed by you". An empty field becomes "missing". Optional detected fields (published date, detected length,
 * end date) are recorded only when they hold a value.
 */
export function completeConfidence(value: EntryInput): ConfidenceMap {
  const map: ConfidenceMap = { ...value.confidence };
  const keys = [...trackedKeys(value.profile)];
  for (const key of ["publishedAt", "dateEnd", "detectedDurationMinutes"]) {
    if (fieldHasValue(value, key) || Object.hasOwn(map, key)) keys.push(key);
  }
  for (const key of keys) {
    const has = fieldHasValue(value, key);
    const existing = confidenceOf(map, key);
    if (existing) {
      // A placeholder (source type "Other" before anyone chose) stays "missing" until it is edited.
      if (existing.level !== "missing" && !has) map[key] = leftEmpty();
      else if (existing.level === "missing" && has && key !== "sourceType") map[key] = typedByYou();
    } else {
      map[key] = has ? typedByYou() : leftEmpty();
    }
  }
  return map;
}

/** Drop confidence records for fields that do not belong to the entry's log (a theme on an IStructE entry). */
function pruneConfidence(map: ConfidenceMap, value: EntryInput): ConfidenceMap {
  const keep = new Set([...trackedKeys(value.profile), "publishedAt", "dateEnd", "detectedDurationMinutes"]);
  const out: ConfidenceMap = {};
  for (const [key, c] of Object.entries(map)) if (keep.has(key) || key.startsWith("custom.")) out[key] = c;
  return out;
}

// ---------------------------------------------------------------------------------------------
// Checks

function isIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m !== null && isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

function isWebUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * The things that stop a save, worded for the person. Soft problems (a long day, a vague reflection)
 * are not here: see entry-warnings.tsx.
 */
export function checkEntry(value: EntryInput, settings: Pick<UserSettings, "customFields">): EntryErrors {
  const errors: EntryErrors = {};
  if (value.title.trim() === "") errors.title = "Add a title so you can find this entry later.";
  const url = (value.url ?? "").trim();
  if (url && !isWebUrl(url)) errors.url = "Use a web address that starts with http:// or https://.";
  if (!isIsoDate(value.dateCompleted)) errors.dateCompleted = "Choose the date you finished, with day, month and year.";
  if (value.dateEnd) {
    if (!isIsoDate(value.dateEnd)) errors.dateEnd = "Choose a real end date, or clear it.";
    else if (isIsoDate(value.dateCompleted) && value.dateEnd < value.dateCompleted) {
      errors.dateEnd = "The end date can't be before the date completed. Change one of the two dates.";
    }
  }
  if (!(value.hours > 0)) errors.hours = "Enter the hours you spent learning, for example 0.5.";
  else if (value.hours > MAX_HOURS) errors.hours = `Hours can't be more than ${MAX_HOURS}.`;
  if (!value.hoursConfirmed) errors.hoursConfirmed = "Tick the box to confirm this is the time you actually spent learning.";
  if (value.profile === "custom") {
    for (const def of settings.customFields) {
      const raw = (value.custom[def.key] ?? "").trim();
      if (!raw) continue;
      if (def.type === "number" && !Number.isFinite(Number(raw))) errors[`custom.${def.key}`] = `${def.label} needs a number.`;
      if (def.type === "date" && !isIsoDate(raw)) errors[`custom.${def.key}`] = `${def.label} needs a real date.`;
    }
  }
  return errors;
}

/** The ready-to-save test the Save button uses: hours above zero and the confirmation ticked. */
export function hoursReady(value: Pick<EntryInput, "hours" | "hoursConfirmed">): boolean {
  return value.hours > 0 && value.hoursConfirmed;
}

/** AI text is in the entry and the person has not yet ticked the review box. */
export function needsAiReview(value: EntryInput, reviewed: boolean): boolean {
  return value.aiAssisted && hasReflectionText(value) && !reviewed;
}

// ---------------------------------------------------------------------------------------------
// Tidy before saving

function pickCustom(custom: Record<string, string>, defs: readonly CustomFieldDef[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const def of defs) {
    const v = (custom[def.key] ?? "").trim();
    if (v) Object.defineProperty(out, def.key, { value: v, enumerable: true, writable: true, configurable: true });
  }
  return out;
}

/**
 * The value to POST. Trims text, empties fields that belong to another log, rounds hours, and completes the
 * confidence map. `aiAssisted` stays true only if AI text is still in the fields the log uses.
 */
export function prepareForSave(value: EntryInput, settings: Pick<UserSettings, "customFields">): EntryInput {
  const p = value.profile;
  const benefits: BenefitParts =
    p === "ice"
      ? { helped: value.benefits.helped.trim(), future: value.benefits.future.trim(), nextYear: value.benefits.nextYear.trim() }
      : { ...EMPTY_BENEFITS };
  const trimmed: EntryInput = {
    ...value,
    title: value.title.trim(),
    url: (value.url ?? "").trim() || null,
    provider: (value.provider ?? "").trim() || null,
    hours: roundHours(value.hours),
    // An end date equal to the first day adds nothing. One before it is kept so checkEntry can say so.
    dateEnd: value.dateEnd && value.dateEnd !== value.dateCompleted ? value.dateEnd : null,
    theme: p === "ice" ? value.theme || null : null,
    category: p === "istructe" ? value.category || null : null,
    structuralSafety: p === "istructe" ? value.structuralSafety : null,
    sustainability: p === "istructe" ? value.sustainability : null,
    devPlanRef: p === "ice" ? value.devPlanRef.trim() || DEFAULT_DEV_PLAN_REF : "",
    learningPoints: p === "istructe" ? "" : value.learningPoints.trim(),
    benefits,
    developmentGained: p === "istructe" ? value.developmentGained.trim() : "",
    custom: p === "custom" ? pickCustom(value.custom, settings.customFields) : {},
    notes: value.notes.trim(),
  };
  const aiAssisted = value.aiAssisted && hasReflectionText(trimmed);
  const out: EntryInput = { ...trimmed, aiAssisted };
  return { ...out, confidence: pruneConfidence(completeConfidence(out), out) };
}

// ---------------------------------------------------------------------------------------------
// AI-assisted text

export const AI_EVIDENCE = "Drafted by AI from your notes. Read it and change anything that isn't right.";

/** The part of the /api/ai/expand answer this file needs. */
export interface ExpansionText {
  learningPoints: string;
  benefits: BenefitParts;
  developmentGained: string;
}

/**
 * Puts AI text into the fields the entry's log uses. A field the AI left empty keeps what the person
 * already had. AI-written fields are marked "Check" with where the words came from. `applied` is false
 * when the AI gave nothing back, in which case the entry is returned as it was.
 */
export function applyExpansion(value: EntryInput, res: ExpansionText): { value: EntryInput; applied: boolean } {
  const next: EntryInput = { ...value, benefits: { ...value.benefits } };
  const confidence: ConfidenceMap = { ...value.confidence };
  const drafted = (): FieldConfidence => ({ level: "low", evidence: AI_EVIDENCE });
  let applied = false;
  if (value.profile !== "istructe" && res.learningPoints.trim()) {
    next.learningPoints = res.learningPoints.trim();
    confidence.learningPoints = drafted();
    applied = true;
  }
  if (value.profile === "ice") {
    let anyBenefit = false;
    for (const key of ["helped", "future", "nextYear"] as const) {
      const text = res.benefits[key].trim();
      if (text) {
        next.benefits[key] = text;
        anyBenefit = true;
      }
    }
    if (anyBenefit) {
      confidence.benefits = drafted();
      applied = true;
    }
  }
  if (value.profile === "istructe" && res.developmentGained.trim()) {
    next.developmentGained = res.developmentGained.trim();
    confidence.developmentGained = drafted();
    applied = true;
  }
  if (!applied) return { value, applied: false };
  return { value: { ...next, aiAssisted: true, confidence }, applied: true };
}

// ---------------------------------------------------------------------------------------------
// Small value helpers

/** "1,5" and "1.5" both work. Anything that is not a positive number is 0. At most two decimals. */
export function parseHours(text: string): number {
  const n = Number(text.trim().replace(",", "."));
  return Number.isFinite(n) && n > 0 ? roundHours(n) : 0;
}

export function hoursText(hours: number): string {
  return hours > 0 ? formatHours(hours) : "";
}

/** A suggestion for the IStructE category from the source type. Shown as an estimate the person can change. */
export function categoryForSourceType(type: SourceType): string | null {
  const cats = PROFILES.istructe.categories;
  if (type === "webinar" || type === "live_event") return cats.find((c) => c.startsWith("Courses")) ?? null;
  if (type === "video" || type === "article" || type === "document") return cats.find((c) => c.startsWith("Self-directed")) ?? null;
  return null;
}

/** Element id for a field. Dots in custom keys become dashes. */
export function entryFieldId(prefix: string, key: string): string {
  return `${prefix}-${key.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

/** The order fields appear on screen, so the first error can be focused. */
export function firstErrorKey(errors: EntryErrors, order: readonly string[]): string | null {
  for (const key of order) if (errors[key]) return key;
  const rest = Object.keys(errors)[0];
  return rest ?? null;
}

export const FIELD_ORDER: readonly string[] = ["title", "url", "dateCompleted", "dateEnd", "hours", "hoursConfirmed"];
