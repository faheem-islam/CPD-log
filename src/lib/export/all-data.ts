import type { BenefitParts, CustomFieldDef, Entry, FieldConfidence, ProfileId, SourceType, UserSettings } from "@/lib/types";
import { todayUk } from "@/lib/dates";
import { assertOwnEntries } from "./rows";

/** Bump this when the shape of the file changes, so an importer can tell which layout it has. */
export const ALL_DATA_VERSION = 1;

export interface AllDataEntry {
  id: string;
  profile: ProfileId;
  title: string;
  url: string | null;
  provider: string | null;
  sourceType: SourceType;
  publishedAt: string | null;
  dateCompleted: string;
  dateEnd: string | null;
  detectedDurationMinutes: number | null;
  hours: number;
  hoursConfirmed: boolean;
  theme: string | null;
  category: string | null;
  structuralSafety: boolean | null;
  sustainability: boolean | null;
  devPlanRef: string;
  learningPoints: string;
  benefits: BenefitParts;
  developmentGained: string;
  custom: Record<string, string>;
  notes: string;
  aiAssisted: boolean;
  confidence: Record<string, FieldConfidence>;
  createdAt: string;
  updatedAt: string;
  /** Null for a live entry. Set for an entry in the bin. */
  deletedAt: string | null;
  /** True when the entry is in the bin (deletedAt is set). */
  deleted: boolean;
}

export interface AllData {
  app: "CPD Logger";
  version: number;
  /** ISO timestamp of when the file was made. */
  exportedAt: string;
  /** What this file is, in plain words. */
  about: string;
  settings: {
    name: string;
    jobRole: string;
    responsibilities: string;
    sector: string;
    activeProfiles: ProfileId[];
    customFields: CustomFieldDef[];
  };
  counts: { entries: number; live: number; deleted: number };
  entries: AllDataEntry[];
}

export interface AllDataInput {
  settings: UserSettings;
  /** Every entry of this one user, including entries in the bin. */
  entries: readonly Entry[];
  now: Date;
  /**
   * The user the export is for. Always pass it from a route: with it, every entry must belong to this user or the export
   * is refused. Without it, only entries of more than one user are refused, so a caller that leaves it out is not guarded.
   */
  userId?: string;
}

function pickEntry(e: Entry): AllDataEntry {
  // Each field is copied by name, so nothing extra that rode along on the object can leak into the file.
  // The internal user id is left out: it is not part of the person's own data.
  return {
    id: e.id,
    profile: e.profile,
    title: e.title,
    url: e.url,
    provider: e.provider,
    sourceType: e.sourceType,
    publishedAt: e.publishedAt,
    dateCompleted: e.dateCompleted,
    dateEnd: e.dateEnd,
    detectedDurationMinutes: e.detectedDurationMinutes,
    hours: e.hours,
    hoursConfirmed: e.hoursConfirmed,
    theme: e.theme,
    category: e.category,
    structuralSafety: e.structuralSafety,
    sustainability: e.sustainability,
    devPlanRef: e.devPlanRef,
    learningPoints: e.learningPoints,
    benefits: { helped: e.benefits?.helped ?? "", future: e.benefits?.future ?? "", nextYear: e.benefits?.nextYear ?? "" },
    developmentGained: e.developmentGained,
    custom: { ...(e.custom ?? {}) },
    notes: e.notes,
    aiAssisted: e.aiAssisted,
    confidence: Object.fromEntries(Object.entries(e.confidence ?? {}).map(([k, v]) => [k, { level: v.level, evidence: v.evidence }])),
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    deletedAt: e.deletedAt,
    deleted: e.deletedAt !== null,
  };
}

/**
 * The "Download all my data" file (UK GDPR data portability): the person's settings and every entry with all of its
 * fields, including entries in the bin. Plain JSON, no secrets, no other user's data.
 * Throws if the entries belong to more than one user: that is a bug in the caller, and nothing is returned.
 */
export function buildAllData(input: AllDataInput): AllData {
  assertOwnEntries(input.entries, input.userId);
  const entries = [...input.entries]
    .sort((a, b) => (a.dateCompleted < b.dateCompleted ? -1 : a.dateCompleted > b.dateCompleted ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(pickEntry);
  const deleted = entries.filter((e) => e.deleted).length;
  const s = input.settings;
  return {
    app: "CPD Logger",
    version: ALL_DATA_VERSION,
    exportedAt: input.now.toISOString(),
    about: "Your CPD Logger data: your settings and every entry, including entries in the bin.",
    settings: {
      name: s.name,
      jobRole: s.jobRole,
      responsibilities: s.responsibilities,
      sector: s.sector,
      activeProfiles: [...s.activeProfiles],
      customFields: s.customFields.map((f) => ({ key: f.key, label: f.label, type: f.type })),
    },
    counts: { entries: entries.length, live: entries.length - deleted, deleted },
    entries,
  };
}

/** For example cpd-logger-data-2026-10-07.json */
export function allDataFilename(now: Date): string {
  return `cpd-logger-data-${todayUk(now)}.json`;
}
