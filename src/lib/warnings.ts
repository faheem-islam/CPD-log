import type { Entry } from "./types";

export interface EntryWarning {
  code: "day_over_6h" | "activity_over_30h" | "vague_text";
  field?: "hours" | "learningPoints" | "benefits" | "developmentGained";
  message: string;
}

const VAGUE_PHRASES = [
  /\bvarious\b/i,
  /\bgeneral (learning|knowledge|cpd|development)\b/i,
  /\bmiscellaneous\b/i,
  /\bmisc\b/i,
  /\bnetworking\b/i,
  /\bkeeping up to date\b/i,
  /\bbackground reading\b/i,
  /\bn\/a\b/i,
  /\betc\.?\b/i,
];

/** True when a reflection is too thin to tell a reviewer what was learned. Only a hint, never blocks. */
export function isVague(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 4) return true;
  if (words.length <= 12 && VAGUE_PHRASES.some((re) => re.test(t))) return true;
  return false;
}

export interface WarningContext {
  /** The user's other live entries, for the same-day total. */
  others: Pick<Entry, "id" | "dateCompleted" | "hours">[];
}

/** Soft warnings only. Nothing here ever blocks saving. */
export function entryWarnings(
  entry: Pick<Entry, "id" | "dateCompleted" | "hours" | "learningPoints" | "benefits" | "developmentGained"> & { profile: Entry["profile"] },
  ctx: WarningContext,
): EntryWarning[] {
  const out: EntryWarning[] = [];
  const sameDay = ctx.others.filter((o) => o.id !== entry.id && o.dateCompleted === entry.dateCompleted);
  const dayTotal = sameDay.reduce((t, o) => t + o.hours, 0) + entry.hours;
  if (dayTotal > 6) {
    out.push({
      code: "day_over_6h",
      field: "hours",
      message: `That makes ${Math.round(dayTotal * 100) / 100} hours on one day. Check this is effective learning time, not time at an event.`,
    });
  }
  if (entry.hours > 30) {
    out.push({
      code: "activity_over_30h",
      field: "hours",
      message: "More than 30 hours for one activity is unusual. Check the figure, or split it into separate entries.",
    });
  }
  const texts: Array<[NonNullable<EntryWarning["field"]>, string]> = [
    ["learningPoints", entry.learningPoints],
    ["benefits", Object.values(entry.benefits).join(" ")],
    ["developmentGained", entry.developmentGained],
  ];
  for (const [field, text] of texts) {
    if (isVague(text)) {
      out.push({
        code: "vague_text",
        field,
        message: "This is quite general. Reviewers often reject vague entries, so say what you learned and how it helps your work.",
      });
    }
  }
  return out;
}
