import type { BenefitParts } from "./types";
import { PROFILES } from "./profiles";

export const EMPTY_BENEFITS: BenefitParts = { helped: "", future: "", nextYear: "" };

/**
 * Benefits text for export. One answer is written unlabelled; several answers become labelled lines.
 */
export function composeBenefits(parts: BenefitParts): string {
  const filled = PROFILES.ice.benefitPrompts
    .map((p) => ({ label: p.label, text: (parts[p.key] ?? "").trim() }))
    .filter((p) => p.text);
  if (filled.length === 0) return "";
  if (filled.length === 1) return filled[0]?.text ?? "";
  return filled.map((p) => `${p.label}: ${p.text}`).join("\n");
}

export function hasBenefits(parts: BenefitParts): boolean {
  return composeBenefits(parts) !== "";
}
