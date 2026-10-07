import { Check, CircleHelp, Calculator, Search } from "lucide-react";
import { CONFIDENCE_LABELS, type Confidence } from "@/lib/types";

const STYLE: Record<Confidence, string> = {
  high: "badge badge-high",
  low: "badge badge-low",
  estimate: "badge badge-estimate",
  missing: "badge badge-missing",
};

const ICON = {
  high: Check,
  low: Search,
  estimate: Calculator,
  missing: CircleHelp,
} as const;

/**
 * Confidence badge. Always text plus an icon, never colour alone. Labels are High, Check, Estimate
 * and Not found. None of them means "verified": they describe how the value was found.
 */
export function ConfidenceBadge({ level }: { level: Confidence }) {
  const Icon = ICON[level];
  return (
    <span className={STYLE[level]}>
      <Icon aria-hidden="true" size={14} strokeWidth={3} />
      {CONFIDENCE_LABELS[level]}
    </span>
  );
}

export function ProvisionalBadge() {
  return <span className="badge badge-warn">Provisional layout</span>;
}
