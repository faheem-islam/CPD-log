import { ConfidenceBadge } from "@/components/ui/badge";
import type { Confidence } from "@/lib/types";

const MEANINGS: Array<{ level: Confidence; text: string }> = [
  {
    level: "high",
    text: "Read from a clear label or from machine-readable data on the page, such as a length or date the page states in its own markup.",
  },
  { level: "low", text: "A guess. Look at it before you accept it." },
  {
    level: "estimate",
    text: "Calculated, for example reading time worked out from a word count. Reading time is not the time you spent learning.",
  },
  { level: "missing", text: "Nothing reliable was found. Please fill it in." },
];

/**
 * The four badges as they appear in the app, each with what it means. A definition list: the term is the real badge.
 * No tinted background behind it: the Not found badge is itself a pale tint and would vanish on one.
 */
export function BadgeGuide() {
  return (
    <dl className="space-y-4">
      {MEANINGS.map(({ level, text }) => (
        <div key={level} className="grid grid-cols-1 gap-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:gap-6">
          <dt className="sm:pt-0.5">
            <ConfidenceBadge level={level} />
          </dt>
          <dd className="min-w-0 max-w-[60ch]">{text}</dd>
        </div>
      ))}
    </dl>
  );
}
