import { z } from "zod";
import { ISO_DATE_RE, isValidYmd, roundHours, toIso } from "@/lib/dates";
import { EMPTY_BENEFITS } from "@/lib/benefits";
import { PROFILES } from "@/lib/profiles";
import {
  DEFAULT_SETTINGS,
  SOURCE_TYPES,
  type BenefitParts,
  type Confidence,
  type CustomFieldDef,
  type Entry,
  type EntryInput,
  type FieldConfidence,
  type ProfileId,
  type SourceType,
  type UserSettings,
} from "@/lib/types";

/**
 * Pure validation and row mapping shared by both stores, so the local file and Postgres accept and
 * return exactly the same shapes. Nothing here touches the network or the disk.
 *
 * Error messages from this file are written for the person using the app. They name the field and say
 * what to fix. They never include the value that was rejected.
 */

// ---------------------------------------------------------------------------------------------
// Errors

export type StoreErrorCode = "invalid" | "not_signed_in" | "unavailable" | "failed";

/** A store failure with a message that is safe to show to the user. It never carries a key, a row or a raw database message. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;
  /** The Postgres/PostgREST error code (for example "42501"), kept for logging. Never a message. */
  readonly dbCode: string | undefined;

  constructor(code: StoreErrorCode, message: string, dbCode?: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
    this.dbCode = dbCode;
  }
}

/** The data the caller sent was not acceptable. The message says which field and what to change. */
export class StoreInputError extends StoreError {
  constructor(message: string) {
    super("invalid", message);
    this.name = "StoreInputError";
  }
}

// ---------------------------------------------------------------------------------------------
// Limits. Generous: they stop a runaway paste filling the database, not normal use.

const LIMITS = {
  title: 1000,
  url: 4096,
  provider: 500,
  short: 300,
  long: 20000,
  customValue: 5000,
  customKeys: 50,
  keyLength: 60,
  evidence: 1000,
  maxHours: 9999.99,
  maxMinutes: 1_000_000,
} as const;

const FIELD_LABELS: Record<string, string> = {
  profile: "Profile",
  title: "Title",
  url: "Link",
  provider: "Provider",
  sourceType: "Source type",
  publishedAt: "Published date",
  dateCompleted: "Date completed",
  dateEnd: "End date",
  detectedDurationMinutes: "Detected length",
  hours: "Hours",
  hoursConfirmed: "Hours confirmed",
  theme: "Theme",
  category: "Category",
  structuralSafety: "Structural safety",
  sustainability: "Sustainability",
  devPlanRef: "Development plan reference",
  learningPoints: "Learning points",
  benefits: "Benefits",
  developmentGained: "Development gained",
  custom: "Custom fields",
  notes: "Notes",
  aiAssisted: "AI assisted",
  confidence: "Confidence",
  name: "Name",
  jobRole: "Job role",
  responsibilities: "Responsibilities",
  sector: "Sector",
  activeProfiles: "Active profiles",
  customFields: "Custom fields",
};

function labelFor(path: PropertyKey[]): string {
  const head = path[0];
  if (typeof head === "string" && FIELD_LABELS[head]) return FIELD_LABELS[head];
  return "A field";
}

function firstIssueMessage(error: z.ZodError, prefix: string): string {
  const issue = error.issues[0];
  if (!issue) return `${prefix} The data was not accepted.`;
  const tail = issue.path.length > 1 ? ` (${issue.path.slice(1).map(String).join(" > ")})` : "";
  return `${labelFor(issue.path)}${tail} ${issue.message}.`;
}

// ---------------------------------------------------------------------------------------------
// Field schemas (strict, used before anything is written)

function isYmdString(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m !== null && isValidYmd(Number(m[1]), Number(m[2]), Number(m[3]));
}

/**
 * Characters Postgres cannot store in a text or jsonb value: U+0000, and half of a surrogate pair with no partner.
 * They arrive from pasted text (a NUL is common in text copied out of a PDF) and are invisible, so they are removed
 * rather than rejected. This is done for both stores, so the local file and the database hold the same text.
 */
const UNSTORABLE_SOURCE = "\\u0000|[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]";
const UNSTORABLE_ANY = new RegExp(UNSTORABLE_SOURCE);
const UNSTORABLE_ALL = new RegExp(UNSTORABLE_SOURCE, "g");

function stripUnstorable(s: string): string {
  return s.replace(UNSTORABLE_ALL, "");
}

function hasUnstorable(s: string): boolean {
  return UNSTORABLE_ANY.test(s);
}

const text = (max: number) => z.string("must be text").max(max, `must be ${max} characters or fewer`).transform(stripUnstorable);

/** A web link: http or https only. A javascript: or file: link in a saved entry would be a risk wherever the link is later shown. */
function isWebUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

const urlField = z
  .preprocess(
    (v) => (typeof v === "string" ? (v.trim() === "" ? null : v.trim()) : v),
    z.string("must be text").max(LIMITS.url, `must be ${LIMITS.url} characters or fewer`).refine(isWebUrl, "must be a web address starting with http:// or https://").nullable(),
  );

const ymd = z.string("must be a date written as YYYY-MM-DD").refine(isYmdString, "must be a real date written as YYYY-MM-DD");

const profileField = z.custom<ProfileId>(
  (v) => v === "ice" || v === "istructe" || v === "custom",
  "must be ice, istructe or custom",
);
const sourceTypeField = z.custom<SourceType>(
  (v) => typeof v === "string" && (SOURCE_TYPES as readonly string[]).includes(v),
  `must be one of ${SOURCE_TYPES.join(", ")}`,
);
const confidenceLevel = z.custom<Confidence>(
  (v) => v === "high" || v === "low" || v === "estimate" || v === "missing",
  "must be high, low, estimate or missing",
);

function normaliseHours(h: number): number {
  const r = roundHours(h);
  return Object.is(r, -0) ? 0 : r;
}

const hoursField = z
  .number("must be a number")
  .finite("must be a number")
  .min(0, "must be 0 or more")
  .max(LIMITS.maxHours, `must be ${LIMITS.maxHours} or less`)
  .transform(normaliseHours);

const benefitsField = z.object({
  helped: text(LIMITS.customValue),
  future: text(LIMITS.customValue),
  nextYear: text(LIMITS.customValue),
});

const customField = z
  .record(z.string(), text(LIMITS.customValue))
  .refine((r) => Object.keys(r).length <= LIMITS.customKeys, `can have at most ${LIMITS.customKeys} fields`)
  .refine((r) => Object.keys(r).every((k) => k.length > 0 && k.length <= LIMITS.keyLength && k !== "__proto__" && !hasUnstorable(k)), "has a field name that is empty, too long or not allowed");

const confidenceField = z
  .record(z.string(), z.object({ level: confidenceLevel, evidence: text(LIMITS.evidence) }))
  .refine((r) => Object.keys(r).length <= LIMITS.customKeys, `can have at most ${LIMITS.customKeys} items`)
  .refine((r) => Object.keys(r).every((k) => k.length > 0 && k.length <= LIMITS.keyLength && k !== "__proto__" && !hasUnstorable(k)), "has a name that is empty, too long or not allowed");

const inputShape = {
  profile: profileField,
  title: text(LIMITS.title),
  url: urlField,
  provider: text(LIMITS.provider).nullable(),
  sourceType: sourceTypeField,
  publishedAt: ymd.nullable(),
  dateCompleted: ymd,
  dateEnd: ymd.nullable(),
  detectedDurationMinutes: z.number("must be a number").finite("must be a number").min(0, "must be 0 or more").max(LIMITS.maxMinutes, "is too large").nullable(),
  hours: hoursField,
  hoursConfirmed: z.boolean("must be true or false"),
  theme: text(LIMITS.short).nullable(),
  category: text(LIMITS.short).nullable(),
  structuralSafety: z.boolean("must be true or false").nullable(),
  sustainability: z.boolean("must be true or false").nullable(),
  devPlanRef: text(LIMITS.short),
  learningPoints: text(LIMITS.long),
  benefits: benefitsField,
  developmentGained: text(LIMITS.long),
  custom: customField,
  notes: text(LIMITS.long),
  aiAssisted: z.boolean("must be true or false"),
  confidence: confidenceField,
} as const;

const entryInputSchema = z.object(inputShape);
const entryPatchSchema = z.object(inputShape).partial();

export const ENTRY_INPUT_KEYS = Object.keys(inputShape) as (keyof EntryInput)[];

/** The end date of a range cannot be before the first day. */
export function assertDateOrder(dateCompleted: string, dateEnd: string | null | undefined): void {
  if (dateEnd && dateEnd < dateCompleted) {
    throw new StoreInputError("End date cannot be before the date completed. Change one of the two dates.");
  }
}

/** Check a whole entry before it is written. Unknown keys (id, userId, timestamps) are dropped, not trusted. */
export function validateEntryInput(input: unknown): EntryInput {
  const parsed = entryInputSchema.safeParse(input);
  if (!parsed.success) throw new StoreInputError(firstIssueMessage(parsed.error, "The entry"));
  const value = parsed.data as EntryInput;
  assertDateOrder(value.dateCompleted, value.dateEnd);
  return value;
}

/** Check the fields that were sent. Only known, editable fields come back; keys with undefined are ignored. */
export function validateEntryPatch(patch: unknown): Partial<EntryInput> {
  const parsed = entryPatchSchema.safeParse(patch);
  if (!parsed.success) throw new StoreInputError(firstIssueMessage(parsed.error, "The change"));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) if (v !== undefined) out[k] = v;
  const typed = out as Partial<EntryInput>;
  if (typed.dateCompleted !== undefined && typed.dateEnd !== undefined) assertDateOrder(typed.dateCompleted, typed.dateEnd);
  return typed;
}

// ---------------------------------------------------------------------------------------------
// Settings

const customFieldDefSchema = z.object({
  key: z.string("must be text").min(1, "needs a key").max(LIMITS.keyLength, "key is too long").refine((k) => k !== "__proto__" && !hasUnstorable(k), "key is not allowed"),
  label: z.string("must be text").transform(stripUnstorable).pipe(z.string().trim().min(1, "needs a label").max(200, "label is too long")),
  type: z.custom<CustomFieldDef["type"]>((v) => v === "text" || v === "number" || v === "date" || v === "yes_no", "type must be text, number, date or yes_no"),
});

function dedupeProfiles(list: ProfileId[]): ProfileId[] {
  return [...new Set(list)];
}

const settingsSchema = z.object({
  name: text(200),
  jobRole: text(200),
  responsibilities: text(5000),
  sector: text(200),
  activeProfiles: z.array(profileField, "must be a list").transform(dedupeProfiles).refine((l) => l.length > 0, "needs at least one profile"),
  customFields: z.array(customFieldDefSchema, "must be a list").max(PROFILES.custom.maxCustomFields, `can have at most ${PROFILES.custom.maxCustomFields} fields`),
});

export function validateSettings(settings: unknown): UserSettings {
  const parsed = settingsSchema.safeParse(settings);
  if (!parsed.success) throw new StoreInputError(firstIssueMessage(parsed.error, "The settings"));
  const value = parsed.data as UserSettings;
  const keys = new Set<string>();
  for (const f of value.customFields) {
    if (keys.has(f.key)) throw new StoreInputError("Two custom fields use the same key. Give each custom field its own key.");
    keys.add(f.key);
  }
  return { ...value, customFields: value.customFields.map((f) => ({ key: f.key, label: f.label, type: f.type })) };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** A fresh copy of the default settings, safe to modify. */
export function defaultSettings(): UserSettings {
  return { ...DEFAULT_SETTINGS, activeProfiles: [...DEFAULT_SETTINGS.activeProfiles], customFields: [] };
}

/** Read settings from storage without throwing. Anything unusable falls back to the default for that field. */
export function parseStoredSettings(raw: unknown): UserSettings {
  const out = defaultSettings();
  if (!isRecord(raw)) return out;
  const str = (v: unknown, max: number): string | null => (typeof v === "string" && v.length <= max ? v : null);
  out.name = str(raw.name, 200) ?? out.name;
  out.jobRole = str(raw.jobRole, 200) ?? out.jobRole;
  out.responsibilities = str(raw.responsibilities, 5000) ?? out.responsibilities;
  out.sector = str(raw.sector, 200) ?? out.sector;
  if (Array.isArray(raw.activeProfiles)) {
    const profiles = dedupeProfiles(raw.activeProfiles.filter((p): p is ProfileId => p === "ice" || p === "istructe" || p === "custom"));
    if (profiles.length > 0) out.activeProfiles = profiles;
  }
  if (Array.isArray(raw.customFields)) {
    const seen = new Set<string>();
    const defs: CustomFieldDef[] = [];
    for (const item of raw.customFields) {
      const parsed = customFieldDefSchema.safeParse(item);
      if (!parsed.success || seen.has(parsed.data.key) || defs.length >= PROFILES.custom.maxCustomFields) continue;
      seen.add(parsed.data.key);
      defs.push({ key: parsed.data.key, label: parsed.data.label, type: parsed.data.type });
    }
    out.customFields = defs;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Lenient reading of stored entries (hand-edited local file, or a database row)

function normaliseYmd(v: unknown): unknown {
  if (typeof v !== "string") return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  const m = ISO_DATE_RE.exec(v);
  return m ? toIso(Number(m[1]), Number(m[2]), Number(m[3])) : v;
}

function normaliseTimestamp(v: unknown): unknown {
  if (typeof v !== "string") return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** Numeric columns may arrive as "1.50" strings. */
function numberish(v: unknown): unknown {
  if (typeof v === "string" && v.trim() !== "" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim());
  return v;
}

const lenientYmd = z.preprocess(normaliseYmd, ymd);
const lenientHours = z.preprocess(numberish, z.number().finite().min(0).max(LIMITS.maxHours * 10)).transform(normaliseHours);

function cleanBenefits(raw: unknown): BenefitParts {
  const out: BenefitParts = { ...EMPTY_BENEFITS };
  if (!isRecord(raw)) return out;
  for (const key of ["helped", "future", "nextYear"] as const) {
    const v = raw[key];
    if (typeof v === "string") out[key] = v;
  }
  return out;
}

function cleanCustom(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" || k === "__proto__" || k.length === 0) continue;
    if (n++ >= LIMITS.customKeys) break;
    out[k] = v;
  }
  return out;
}

function cleanConfidence(raw: unknown): Record<string, FieldConfidence> {
  const out: Record<string, FieldConfidence> = {};
  if (!isRecord(raw)) return out;
  let n = 0;
  for (const [k, v] of Object.entries(raw)) {
    if (k === "__proto__" || k.length === 0 || !isRecord(v)) continue;
    const level = confidenceLevel.safeParse(v.level);
    if (!level.success) continue;
    if (n++ >= LIMITS.customKeys) break;
    out[k] = { level: level.data, evidence: typeof v.evidence === "string" ? v.evidence : "" };
  }
  return out;
}

const nullableText = z.string().nullable().catch(null);
const nullableBool = z.boolean().nullable().catch(null);

const storedEntrySchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  profile: profileField,
  title: z.string(),
  url: nullableText,
  provider: nullableText,
  sourceType: sourceTypeField.catch("other"),
  publishedAt: lenientYmd.nullable().catch(null),
  dateCompleted: lenientYmd,
  dateEnd: lenientYmd.nullable().catch(null),
  detectedDurationMinutes: z.preprocess(numberish, z.number().finite().min(0)).nullable().catch(null),
  hours: lenientHours,
  hoursConfirmed: z.boolean().catch(false),
  theme: nullableText,
  category: nullableText,
  structuralSafety: nullableBool,
  sustainability: nullableBool,
  devPlanRef: z.string().catch(""),
  learningPoints: z.string().catch(""),
  benefits: z.unknown().transform(cleanBenefits),
  developmentGained: z.string().catch(""),
  custom: z.unknown().transform(cleanCustom),
  notes: z.string().catch(""),
  aiAssisted: z.boolean().catch(false),
  confidence: z.unknown().transform(cleanConfidence),
  createdAt: z.preprocess(normaliseTimestamp, z.string()),
  updatedAt: z.preprocess(normaliseTimestamp, z.string()),
  deletedAt: z.preprocess(normaliseTimestamp, z.string()).nullable().catch(null),
});

/**
 * Read one stored entry (camelCase, as kept in the local file). Returns null when the row cannot be used:
 * no id, no valid date or hours, an unknown profile, or no creation time. Other broken fields fall back to
 * an empty value so a hand-edited file does not crash the app.
 */
export function parseStoredEntry(raw: unknown): Entry | null {
  if (!isRecord(raw)) return null;
  const candidate = { ...raw, updatedAt: raw.updatedAt ?? raw.createdAt };
  const parsed = storedEntrySchema.safeParse(candidate);
  if (!parsed.success) return null;
  return parsed.data as Entry;
}

// ---------------------------------------------------------------------------------------------
// Postgres rows

/** One row of public.cpd_entries as PostgREST returns it. Values are unchecked until rowToEntry. */
export interface EntryRow {
  id: string;
  user_id: string;
  profile: string;
  title: string;
  url: string | null;
  provider: string | null;
  source_type: string;
  published_at: string | null;
  date_completed: string;
  date_end: string | null;
  detected_duration_minutes: number | string | null;
  hours: number | string;
  hours_confirmed: boolean;
  theme: string | null;
  category: string | null;
  structural_safety: boolean | null;
  sustainability: boolean | null;
  dev_plan_ref: string | null;
  learning_points: string | null;
  benefits: unknown;
  development_gained: string | null;
  custom: unknown;
  notes: string | null;
  ai_assisted: boolean | null;
  confidence: unknown;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

const FIELD_TO_COLUMN = {
  profile: "profile",
  title: "title",
  url: "url",
  provider: "provider",
  sourceType: "source_type",
  publishedAt: "published_at",
  dateCompleted: "date_completed",
  dateEnd: "date_end",
  detectedDurationMinutes: "detected_duration_minutes",
  hours: "hours",
  hoursConfirmed: "hours_confirmed",
  theme: "theme",
  category: "category",
  structuralSafety: "structural_safety",
  sustainability: "sustainability",
  devPlanRef: "dev_plan_ref",
  learningPoints: "learning_points",
  benefits: "benefits",
  developmentGained: "development_gained",
  custom: "custom",
  notes: "notes",
  aiAssisted: "ai_assisted",
  confidence: "confidence",
} as const satisfies Record<keyof EntryInput, string>;

/** Database row to Entry. Returns null for a row that cannot be used. Numeric strings become numbers. */
export function rowToEntry(row: unknown): Entry | null {
  if (!isRecord(row)) return null;
  return parseStoredEntry({
    id: row.id,
    userId: row.user_id,
    profile: row.profile,
    title: row.title,
    url: row.url,
    provider: row.provider,
    sourceType: row.source_type,
    publishedAt: row.published_at,
    dateCompleted: row.date_completed,
    dateEnd: row.date_end,
    detectedDurationMinutes: row.detected_duration_minutes,
    hours: row.hours,
    hoursConfirmed: row.hours_confirmed,
    theme: row.theme,
    category: row.category,
    structuralSafety: row.structural_safety,
    sustainability: row.sustainability,
    devPlanRef: row.dev_plan_ref,
    learningPoints: row.learning_points,
    benefits: row.benefits,
    developmentGained: row.development_gained,
    custom: row.custom,
    notes: row.notes,
    aiAssisted: row.ai_assisted,
    confidence: row.confidence,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  });
}

/** Many rows to entries. Unusable rows are dropped and counted so the caller can warn without logging data. */
export function rowsToEntries(rows: unknown): { entries: Entry[]; dropped: number } {
  const list = Array.isArray(rows) ? rows : [];
  const entries: Entry[] = [];
  let dropped = 0;
  for (const r of list) {
    const e = rowToEntry(r);
    if (e) entries.push(e);
    else dropped += 1;
  }
  return { entries, dropped };
}

/**
 * Entry fields to an insert row. The caller supplies the user id (the policy also checks it equals auth.uid()).
 * id, created_at and updated_at come from column defaults; deleted_at starts null.
 */
export function entryInputToRow(userId: string, input: EntryInput): Record<string, unknown> {
  const row: Record<string, unknown> = { user_id: userId };
  for (const key of ENTRY_INPUT_KEYS) row[FIELD_TO_COLUMN[key]] = input[key];
  row.deleted_at = null;
  return row;
}

/** A patch to update columns. Only editable fields are mapped; id, user, created and deleted can never be set here. */
export function entryPatchToRow(patch: Partial<EntryInput>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const key of ENTRY_INPUT_KEYS) {
    const v = patch[key];
    if (v !== undefined) row[FIELD_TO_COLUMN[key]] = v;
  }
  return row;
}

export function settingsToRow(userId: string, s: UserSettings): Record<string, unknown> {
  return {
    user_id: userId,
    name: s.name,
    job_role: s.jobRole,
    responsibilities: s.responsibilities,
    sector: s.sector,
    active_profiles: s.activeProfiles,
    custom_fields: s.customFields,
  };
}

/** A missing row means the user has not saved settings yet: the defaults. */
export function rowToSettings(row: unknown): UserSettings {
  if (!isRecord(row)) return defaultSettings();
  return parseStoredSettings({
    name: row.name,
    jobRole: row.job_role,
    responsibilities: row.responsibilities,
    sector: row.sector,
    activeProfiles: row.active_profiles,
    customFields: row.custom_fields,
  });
}

// ---------------------------------------------------------------------------------------------
// Shared small helpers

const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

export function assertMonth(month: string): void {
  if (!MONTH_RE.test(month)) throw new StoreInputError("The month must be written as YYYY-MM, for example 2026-03.");
}

/** The largest value of the integer column and function argument the cap is sent to in Postgres. */
export const MAX_AI_CAP = 2_147_483_647;

/**
 * A cap that is not a positive whole number means "no calls allowed". A cap too big for Postgres is cut to the
 * largest one it accepts, which is far more calls than anyone can make: sent as it was, the database would refuse
 * every call with an out-of-range error.
 */
export function normaliseCap(cap: number): number {
  return Number.isFinite(cap) && cap > 0 ? Math.min(Math.floor(cap), MAX_AI_CAP) : 0;
}

/** Sort for lists: date completed (newest first), then created time (newest first). Stable for equal keys. */
export function compareEntriesNewestFirst(a: Entry, b: Entry): number {
  if (a.dateCompleted !== b.dateCompleted) return a.dateCompleted < b.dateCompleted ? 1 : -1;
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
  return 0;
}
