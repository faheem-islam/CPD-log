import { TriangleAlert } from "lucide-react";
import { entryWarnings, type EntryWarning, type WarningContext } from "@/lib/warnings";
import type { EntryInput } from "@/lib/types";
import { hasReflectionText } from "./entry-helpers";

const FIELD_NAMES: Record<NonNullable<EntryWarning["field"]>, string> = {
  hours: "Hours",
  learningPoints: "Key learning points",
  benefits: "Benefits",
  developmentGained: "Development gained",
};

export interface SoftWarning {
  key: string;
  message: string;
}

/**
 * Soft warnings for an entry, in the order they should be read. Warnings never block saving.
 * The rules in src/lib/warnings.ts (a long day, over 30 hours, a vague reflection) plus two gentle prompts:
 * a date in the future, and no reflection at all.
 *
 * @param entryId  The entry's own id when editing, so it is not counted twice in the day total.
 * @param todayIso Today in the UK (YYYY-MM-DD). Pass the server's todayUk().
 */
export function softWarnings(
  entry: EntryInput,
  ctx: WarningContext & { entryId?: string; todayIso: string },
): SoftWarning[] {
  const out: SoftWarning[] = [];
  const rules = entryWarnings(
    {
      id: ctx.entryId ?? "",
      profile: entry.profile,
      dateCompleted: entry.dateCompleted,
      hours: entry.hours,
      learningPoints: entry.learningPoints,
      benefits: entry.benefits,
      developmentGained: entry.developmentGained,
    },
    { others: ctx.others },
  );
  rules.forEach((w, i) => {
    const prefix = w.field ? `${FIELD_NAMES[w.field]}: ` : "";
    out.push({ key: `${w.code}-${w.field ?? ""}-${i}`, message: `${prefix}${w.message}` });
  });
  if (entry.dateCompleted && entry.dateCompleted > ctx.todayIso) {
    out.push({ key: "future-date", message: "Date completed: this date hasn't happened yet. Log it after you've attended." });
  }
  if (!hasReflectionText(entry)) {
    out.push({
      key: "no-reflection",
      message:
        entry.profile === "istructe"
          ? "Development gained: say in one sentence what you learned and how it helps your work. You can save without it."
          : "Key learning points: say what you learned and how it helps your work. You can save without it.",
    });
  }
  return out;
}

/** Inline soft warnings. Renders nothing when there are none. Text plus an icon, never colour alone. */
export function EntryWarnings({
  warnings,
  className = "",
}: {
  warnings: readonly SoftWarning[];
  className?: string;
}) {
  if (warnings.length === 0) return null;
  return (
    <div className={`notice notice-warn ${className}`}>
      <p className="flex items-center gap-2 font-bold">
        <TriangleAlert aria-hidden="true" size={20} />
        Worth a second look. You can still save.
      </p>
      <ul className="mt-2 list-disc space-y-1 pl-6">
        {warnings.map((w) => (
          <li key={w.key}>{w.message}</li>
        ))}
      </ul>
    </div>
  );
}
