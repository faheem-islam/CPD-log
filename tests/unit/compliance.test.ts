import { describe, expect, it } from "vitest";
import { iceProgress, istructeProgress } from "@/lib/compliance";
import { composeBenefits } from "@/lib/benefits";
import { entryWarnings, isVague } from "@/lib/warnings";
import type { Entry } from "@/lib/types";

function entry(over: Partial<Entry>): Entry {
  return {
    id: Math.random().toString(36).slice(2), userId: "u", profile: "ice", title: "T", url: null, provider: null,
    sourceType: "article", publishedAt: null, dateCompleted: "2026-03-04", dateEnd: null, detectedDurationMinutes: null,
    hours: 1, hoursConfirmed: true, theme: null, category: null, structuralSafety: null, sustainability: null,
    devPlanRef: "unplanned", learningPoints: "", benefits: { helped: "", future: "", nextYear: "" },
    developmentGained: "", custom: {}, notes: "", aiAssisted: false, confidence: {},
    createdAt: "", updatedAt: "", deletedAt: null, ...over,
  };
}

describe("iceProgress", () => {
  it("counts mandatory themes this year and over three years", () => {
    const p = iceProgress([
      entry({ theme: "Safety and risk management", dateCompleted: "2026-02-01" }),
      entry({ theme: "Sustainable development", dateCompleted: "2025-02-01" }),
      entry({ theme: "Ethical and professional behaviours", dateCompleted: "2024-02-01" }),
      entry({ theme: "Ethical and professional behaviours", dateCompleted: "2023-12-31" }),
      entry({ theme: "Transport", dateCompleted: "2026-03-01" }),
    ], 2026);
    expect(p.windowYears).toEqual([2024, 2025, 2026]);
    expect(p.mandatoryRecordedThisYear).toBe(1);
    expect(p.anyMandatoryThisYear).toBe(true);
    expect(p.allMandatoryInWindow).toBe(true);
    expect(p.hoursThisYear).toBe(2);
    expect(p.summary).not.toMatch(/compliant/i);
  });
  it("ignores deleted entries and other profiles", () => {
    const p = iceProgress([
      entry({ theme: "Safety and risk management", deletedAt: "2026-01-01" }),
      entry({ theme: "Safety and risk management", profile: "istructe" }),
    ], 2026);
    expect(p.anyMandatoryThisYear).toBe(false);
    expect(p.hoursThisYear).toBe(0);
  });
});

describe("istructeProgress", () => {
  it("measures hours against provisional targets", () => {
    const p = istructeProgress([
      entry({ profile: "istructe", hours: 7, structuralSafety: true, sustainability: false }),
      entry({ profile: "istructe", hours: 6, sustainability: true, dateCompleted: "2025-06-01" }),
    ], 2026);
    expect(p.provisional).toBe(true);
    expect(p.annual.hours).toBe(7);
    expect(p.structuralSafety.met).toBe(true);
    expect(p.sustainability.hours).toBe(0);
    expect(p.rolling.hours).toBe(13);
    expect(p.rolling.target).toBe(90);
  });
});

describe("composeBenefits", () => {
  it("writes one answer unlabelled", () => {
    expect(composeBenefits({ helped: "Clearer signing layouts.", future: "", nextYear: "" })).toBe("Clearer signing layouts.");
  });
  it("labels several answers", () => {
    expect(composeBenefits({ helped: "A", future: "B", nextYear: "" })).toBe("How it helped: A\nHow I will use it in future: B");
  });
  it("is empty when nothing is written", () => {
    expect(composeBenefits({ helped: " ", future: "", nextYear: "" })).toBe("");
  });
});

describe("warnings", () => {
  it("flags more than 6 hours in a day, counting other entries", () => {
    const w = entryWarnings(entry({ hours: 3 }), { others: [{ id: "x", dateCompleted: "2026-03-04", hours: 4 }] });
    expect(w.map((x) => x.code)).toContain("day_over_6h");
  });
  it("flags more than 30 hours on one activity", () => {
    expect(entryWarnings(entry({ hours: 31 }), { others: [] }).map((x) => x.code)).toContain("activity_over_30h");
  });
  it("flags vague text but not specific text", () => {
    expect(isVague("various webinars")).toBe(true);
    expect(isVague("General learning")).toBe(true);
    expect(isVague("Learned how the principal designer role splits duties between design teams under CDM 2015.")).toBe(false);
    expect(isVague("")).toBe(false);
  });
});
