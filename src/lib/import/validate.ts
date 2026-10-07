import { SOURCE_TYPES, type EntryInput } from "@/lib/types";
import { ICE_ALL_THEMES, PROFILES } from "@/lib/profiles";
import { isValidYmd, todayUk } from "@/lib/dates";
import { isVague } from "@/lib/warnings";
import { ENTRY_INPUT_KEYS, StoreInputError, validateEntryInput as validateForStore } from "@/lib/store/mapping";
import { duplicateKey, normaliseUrl, shorten } from "./values";
import type { ImportContext, ImportIssue } from "./types";

export const SCREENSHOT_WARNING = "Read from a screenshot - check every field";

const error = (field: string, message: string): ImportIssue => ({ severity: "error", field, message });
const warning = (field: string, message: string): ImportIssue => ({ severity: "warning", field, message });

const ISO_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function validIso(s: string): boolean {
  const m = ISO_ONLY.exec(s);
  return m !== null && isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

function dayCount(start: string, end: string | null): number {
  if (!end || !validIso(end) || !validIso(start) || end <= start) return 1;
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.round(ms / 86400000) + 1;
}

/** The rule that makes a row unusable: no date, no title, or hours that are missing, zero, negative or over 24 a day. */
export function blockingIssues(input: Pick<EntryInput, "dateCompleted" | "dateEnd" | "title" | "hours">): ImportIssue[] {
  const out: ImportIssue[] = [];
  if (!validIso(input.dateCompleted ?? "")) {
    out.push(error("dateCompleted", "Add the date. Use day, month, year, for example 04/03/2026."));
  }
  if (!(input.title ?? "").trim()) {
    out.push(error("title", "Add the activity title."));
  }
  const h = input.hours;
  if (typeof h !== "number" || !Number.isFinite(h) || h <= 0) {
    out.push(error("hours", "Hours must be more than 0. Enter the effective learning time, for example 1.5."));
  } else {
    const days = dayCount(input.dateCompleted, input.dateEnd);
    if (h > 24 * days) {
      out.push(
        error(
          "hours",
          days > 1
            ? `${h} hours is more than 24 hours a day over ${days} days. Check the figure, or split it into separate entries.`
            : `${h} hours is more than 24 hours for one day. Check the figure, and enter the effective learning time rather than the time at an event.`,
        ),
      );
    }
  }
  return out;
}

/** A value the review screen cannot show or change is made safe here, so it never stops a row at the store. */
const CONFIDENCE_LEVELS: readonly string[] = ["high", "low", "estimate", "missing"];
const MAX_CONFIDENCE_ITEMS = 50;
const MAX_CONFIDENCE_KEY = 60;
const MAX_CONFIDENCE_EVIDENCE = 1000;

function cleanConfidence(raw: EntryInput["confidence"] | null | undefined): EntryInput["confidence"] {
  const out: EntryInput["confidence"] = {};
  if (typeof raw !== "object" || raw === null) return out;
  let n = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (key === "__proto__" || key.length === 0 || key.length > MAX_CONFIDENCE_KEY) continue;
    if (typeof value !== "object" || value === null || !CONFIDENCE_LEVELS.includes(value.level)) continue;
    if (n++ >= MAX_CONFIDENCE_ITEMS) break;
    out[key] = { level: value.level, evidence: typeof value.evidence === "string" ? value.evidence.slice(0, MAX_CONFIDENCE_EVIDENCE) : "" };
  }
  return out;
}

/**
 * The entry as it will be saved, for values the importer promises to drop or never to produce: an end date that is not
 * a date, a link that is not http or https, a source type that is not one of ours, and notes on how sure the importer was
 * that do not fit the store. Everything the user can see and edit is left as it is.
 */
export function sanitiseInput(input: EntryInput): EntryInput {
  const out: EntryInput = { ...input };
  if (out.dateEnd && !validIso(out.dateEnd)) out.dateEnd = null;
  if (out.url) out.url = normaliseUrl(out.url);
  if (!(SOURCE_TYPES as readonly string[]).includes(out.sourceType)) out.sourceType = "other";
  out.confidence = cleanConfidence(input.confidence);
  return out;
}

/** A minimal entry the store accepts, used to find which single field it is unhappy with. */
const STORE_PROBE: EntryInput = {
  profile: "custom",
  title: "Probe",
  url: null,
  provider: null,
  sourceType: "other",
  publishedAt: null,
  dateCompleted: "2026-01-01",
  dateEnd: null,
  detectedDurationMinutes: null,
  hours: 1,
  hoursConfirmed: true,
  theme: null,
  category: null,
  structuralSafety: null,
  sustainability: null,
  devPlanRef: "",
  learningPoints: "",
  benefits: { helped: "", future: "", nextYear: "" },
  developmentGained: "",
  custom: {},
  notes: "",
  aiAssisted: false,
  confidence: {},
};

/**
 * What the store would refuse about this entry (a title over its length limit, a benefit text over its limit, an end date
 * before the start date, and the rest), as errors. The store's own validator is the judge, so the importer and the store
 * cannot drift apart: a row that passes here is a row the store saves, and one that does not is stopped on the review
 * screen with the store's own wording instead of failing the whole import with no row named.
 */
export function storeIssues(input: EntryInput): ImportIssue[] {
  try {
    validateForStore(input);
    return [];
  } catch (e) {
    if (!(e instanceof StoreInputError)) throw e;
    const whole = e.message;
    const out: ImportIssue[] = [];
    for (const key of ENTRY_INPUT_KEYS) {
      const probe: Record<string, unknown> = { ...STORE_PROBE, [key]: input[key] };
      // The date order is the one rule that needs two fields.
      if (key === "dateEnd" && validIso(input.dateCompleted ?? "")) probe.dateCompleted = input.dateCompleted;
      try {
        validateForStore(probe);
      } catch (inner) {
        if (inner instanceof StoreInputError) out.push(error(key, inner.message));
      }
    }
    return out.length > 0 ? out : [error("row", whole)];
  }
}

const DATE_ORDER_MESSAGE = "The end date is before the start date. Change one of the two dates, or clear the end date.";

/**
 * Every rule that stops a row, and nothing else: the blocking rule, the date order, and what the store would refuse.
 * One error per field. Used by the review screen, and again when the rows are committed.
 */
export function hardIssues(input: EntryInput): ImportIssue[] {
  const out: ImportIssue[] = [...blockingIssues(input)];
  if (validIso(input.dateCompleted ?? "") && input.dateEnd && validIso(input.dateEnd) && input.dateEnd < input.dateCompleted) {
    out.push(error("dateEnd", DATE_ORDER_MESSAGE));
  }
  const covered = new Set(out.map((i) => i.field));
  for (const issue of storeIssues(input)) if (!covered.has(issue.field)) out.push(issue);
  return out;
}

/** JSON of the value of one issue field, to tell later whether the user has changed the value a warning was about. */
export function fieldFingerprint(input: EntryInput, field: string): string {
  let value: unknown;
  if (field.startsWith("custom.")) {
    const key = field.slice("custom.".length);
    value = Object.hasOwn(input.custom ?? {}, key) ? input.custom[key] : undefined;
  } else {
    value = (input as unknown as Record<string, unknown>)[field];
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Every check on one entry except duplicates (those need the other rows). Errors block the row, warnings do not.
 * Used for the first parse and again after the user edits a row on the review screen.
 */
export function validateEntryInput(input: EntryInput, ctx: Pick<ImportContext, "now" | "fromScreenshot">): ImportIssue[] {
  // The store check runs on the entry as it will be saved, so a value that the messages below say will be dropped
  // (an end date that is not a date, a link that is not http or https) is not also reported as an error.
  const out: ImportIssue[] = hardIssues(sanitiseInput(input));

  if (validIso(input.dateCompleted ?? "")) {
    if (input.dateCompleted > todayUk(ctx.now)) {
      out.push(warning("dateCompleted", "This date is in the future. Log CPD after you have done it."));
    }
    if (input.dateEnd && !validIso(input.dateEnd)) {
      out.push(warning("dateEnd", "The end date is not a valid date, so it will be ignored."));
    }
  }
  if (input.url && normaliseUrl(input.url) === null) {
    out.push(warning("url", "The link does not start with http:// or https://, so it will be left out."));
  }

  if (typeof input.hours === "number" && Number.isFinite(input.hours) && input.hours > 30) {
    out.push(warning("hours", "More than 30 hours for one activity is unusual. Check the figure, or split it into separate entries."));
  }

  const vague = (field: string) =>
    warning(field, "This is quite general. Reviewers often reject vague entries, so say what you learned and how it helps your work.");

  if (input.profile === "ice") {
    if (input.theme && !ICE_ALL_THEMES.includes(input.theme)) {
      out.push(warning("theme", `"${shorten(input.theme)}" is not one of the ICE CPD Framework themes. Choose one from the list.`));
    }
    if (!input.learningPoints.trim()) {
      out.push(warning("learningPoints", "No learning points. Say what you learned, because reviewers often reject entries without them."));
    } else if (isVague(input.learningPoints)) {
      out.push(vague("learningPoints"));
    }
    if (isVague(Object.values(input.benefits).join(" "))) out.push(vague("benefits"));
  }

  if (input.profile === "istructe") {
    const cats: readonly string[] = PROFILES.istructe.categories;
    if (input.category && !cats.includes(input.category)) {
      out.push(warning("category", `"${shorten(input.category)}" is not one of the IStructE categories. Choose one from the list.`));
    }
    if (!input.developmentGained.trim()) {
      out.push(warning("developmentGained", "No development gained. Add one sentence on what you learned and the benefit."));
    } else if (isVague(input.developmentGained)) {
      out.push(vague("developmentGained"));
    }
  }

  if (ctx.fromScreenshot) out.push(warning("row", SCREENSHOT_WARNING));
  return out;
}

/** Errors first, then warnings, each group keeping its order. */
export function sortIssues(issues: ImportIssue[]): ImportIssue[] {
  return [...issues.filter((i) => i.severity === "error"), ...issues.filter((i) => i.severity === "warning")];
}

/** Parse-time issues come first. A check issue is dropped when a parse-time issue already covers the same field and severity. */
export function mergeIssues(parseIssues: ImportIssue[], checkIssues: ImportIssue[]): ImportIssue[] {
  const merged = [...parseIssues];
  for (const c of checkIssues) {
    const covered = parseIssues.some((p) => p.field === c.field && p.severity === c.severity && c.severity === "error");
    const same = merged.some((m) => m.field === c.field && m.message === c.message);
    if (!covered && !same) merged.push(c);
  }
  return sortIssues(merged);
}

export function hasError(issues: readonly ImportIssue[]): boolean {
  return issues.some((i) => i.severity === "error");
}

export function duplicateWarning(kind: "existing" | "file", otherRow?: number): ImportIssue {
  return warning(
    "duplicate",
    kind === "existing"
      ? "Looks like a duplicate: you already have an entry with the same date and title. This row is unticked, so tick it if you want it anyway."
      : `Looks like a duplicate of row ${otherRow ?? "above"} in this file (same date and title). This row is unticked, so tick it if you want it anyway.`,
  );
}

/** Keys of the entries the user already has. */
export function existingKeys(existing: ImportContext["existing"]): Set<string> {
  const keys = new Set<string>();
  for (const e of existing) {
    const k = duplicateKey(e.dateCompleted, e.title);
    if (k) keys.add(k);
  }
  return keys;
}

