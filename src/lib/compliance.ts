import { PROFILES } from "./profiles";
import { roundHours } from "./dates";
import type { Entry } from "./types";

/** Entries that count: not deleted. Callers pass one profile's entries. */
function live(entries: Entry[]): Entry[] {
  return entries.filter((e) => !e.deletedAt);
}

function year(e: Entry): number {
  return Number(e.dateCompleted.slice(0, 4));
}

function sum(entries: Entry[]): number {
  return roundHours(entries.reduce((t, e) => t + (Number.isFinite(e.hours) ? e.hours : 0), 0));
}

export interface IceThemeStatus {
  theme: string;
  recordedThisYear: boolean;
  recordedInWindow: boolean;
  entriesThisYear: number;
  entriesInWindow: number;
}

export interface IceProgress {
  profile: "ice";
  year: number;
  windowYears: number[];
  /** Hours are shown for information only: ICE sets no target for qualified members. */
  hoursThisYear: number;
  hoursInWindow: number;
  themes: IceThemeStatus[];
  /** At least one mandatory theme recorded this year. */
  anyMandatoryThisYear: boolean;
  /** All three mandatory themes recorded across the window. */
  allMandatoryInWindow: boolean;
  mandatoryRecordedThisYear: number;
  mandatoryRecordedInWindow: number;
  /** Plain wording for the dashboard. Never says "compliant". */
  summary: string;
}

export function iceProgress(allEntries: Entry[], thisYear: number): IceProgress {
  const rules = PROFILES.ice.rules;
  const windowYears = Array.from({ length: rules.rollingYears }, (_, i) => thisYear - (rules.rollingYears - 1) + i);
  const entries = live(allEntries).filter((e) => e.profile === "ice");
  const inYear = entries.filter((e) => year(e) === thisYear);
  const inWindow = entries.filter((e) => windowYears.includes(year(e)));

  const themes: IceThemeStatus[] = PROFILES.ice.themes.mandatory.map((theme) => {
    const y = inYear.filter((e) => e.theme === theme).length;
    const w = inWindow.filter((e) => e.theme === theme).length;
    return { theme, recordedThisYear: y > 0, recordedInWindow: w > 0, entriesThisYear: y, entriesInWindow: w };
  });

  const mandatoryRecordedThisYear = themes.filter((t) => t.recordedThisYear).length;
  const mandatoryRecordedInWindow = themes.filter((t) => t.recordedInWindow).length;
  const anyMandatoryThisYear = mandatoryRecordedThisYear >= rules.mandatoryEachYear;
  const allMandatoryInWindow = mandatoryRecordedInWindow === themes.length;

  const summary = `${mandatoryRecordedThisYear} of ${themes.length} mandatory themes recorded in ${thisYear}; ${mandatoryRecordedInWindow} of ${themes.length} over ${windowYears[0]}–${thisYear}.`;
  return {
    profile: "ice",
    year: thisYear,
    windowYears,
    hoursThisYear: sum(inYear),
    hoursInWindow: sum(inWindow),
    themes,
    anyMandatoryThisYear,
    allMandatoryInWindow,
    mandatoryRecordedThisYear,
    mandatoryRecordedInWindow,
    summary,
  };
}

export interface Target {
  label: string;
  hours: number;
  target: number;
  /** 0 to 1, capped. */
  fraction: number;
  met: boolean;
}

export interface IstructeProgress {
  profile: "istructe";
  provisional: true;
  year: number;
  windowYears: number[];
  annual: Target;
  structuralSafety: Target;
  sustainability: Target;
  rolling: Target;
  summary: string;
}

function target(label: string, hours: number, goal: number): Target {
  return { label, hours, target: goal, fraction: goal > 0 ? Math.min(1, hours / goal) : 0, met: hours >= goal };
}

export function istructeProgress(allEntries: Entry[], thisYear: number): IstructeProgress {
  const r = PROFILES.istructe.rules;
  const windowYears = Array.from({ length: r.rollingYears }, (_, i) => thisYear - (r.rollingYears - 1) + i);
  const entries = live(allEntries).filter((e) => e.profile === "istructe");
  const inYear = entries.filter((e) => year(e) === thisYear);
  const inWindow = entries.filter((e) => windowYears.includes(year(e)));
  const annual = target(`Hours in ${thisYear}`, sum(inYear), r.annualHours);
  const structuralSafety = target("Structural safety", sum(inYear.filter((e) => e.structuralSafety === true)), r.structuralSafetyHours);
  const sustainability = target("Sustainability", sum(inYear.filter((e) => e.sustainability === true)), r.sustainabilityHours);
  const rolling = target(`Rolling ${r.rollingYears} years`, sum(inWindow), r.rollingHours);
  return {
    profile: "istructe",
    provisional: true,
    year: thisYear,
    windowYears,
    annual,
    structuralSafety,
    sustainability,
    rolling,
    summary: `${annual.hours} of ${annual.target} hours recorded in ${thisYear} (provisional targets).`,
  };
}

/** Hours recorded in a calendar year across the given entries (any profile). */
export function hoursInYear(entries: Entry[], y: number): number {
  return sum(live(entries).filter((e) => year(e) === y));
}

export function yearsPresent(entries: Entry[]): number[] {
  return [...new Set(live(entries).map(year))].sort((a, b) => b - a);
}
