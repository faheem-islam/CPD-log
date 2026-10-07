export type ProfileId = "ice" | "istructe" | "custom";
export const PROFILE_IDS: readonly ProfileId[] = ["ice", "istructe", "custom"] as const;

export type SourceType = "video" | "article" | "webinar" | "document" | "live_event" | "other";
export const SOURCE_TYPES: readonly SourceType[] = ["video", "article", "webinar", "document", "live_event", "other"] as const;
export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  video: "Video",
  article: "Article",
  webinar: "Webinar",
  document: "Document",
  live_event: "Live event",
  other: "Other",
};

/** High = read from a clear label on the page. Check = a guess, look at it. Estimate = calculated. Missing = not found. */
export type Confidence = "high" | "low" | "estimate" | "missing";
export const CONFIDENCE_LABELS: Record<Confidence, string> = {
  high: "High",
  low: "Check",
  estimate: "Estimate",
  missing: "Not found",
};

export interface Field<T> {
  value: T | null;
  confidence: Confidence;
  /** Plain language shown to the user, e.g. "The resource runs 15m". */
  evidence: string;
}

export interface AdapterInput {
  url: string;
  html: string;
  now: Date;
}

export interface AdapterFlags {
  /** The event has not happened yet: log it only after attending. */
  upcoming: boolean;
  /** The page offers a recording rather than a live session. */
  recording: boolean;
}

/** What an adapter returns. Dates are ISO YYYY-MM-DD. Durations are minutes. */
export interface AdapterResult {
  adapter: string;
  title: Field<string>;
  provider: Field<string>;
  sourceType: Field<SourceType>;
  /** A framework theme name from the profile config (ICE). */
  theme: Field<string>;
  durationMinutes: Field<number>;
  publishedAt: Field<string>;
  eventDate: Field<string>;
  /** CPD hours the provider says the event is worth. A hint only. */
  providerCpdHours: Field<number>;
  flags: AdapterFlags;
  notes: string[];
}

export interface Adapter {
  id: string;
  /** Higher wins ties in mergeResults. */
  specificity: number;
  matches(url: URL): boolean;
  extract(input: AdapterInput): AdapterResult;
}

export type DraftFieldKey =
  | "title"
  | "provider"
  | "sourceType"
  | "theme"
  | "durationMinutes"
  | "publishedAt"
  | "eventDate"
  | "providerCpdHours";

export type ExtractStatus = "ok" | "blocked" | "robots_disallowed" | "robots_unconfirmed" | "login_required" | "challenge" | "unsafe_url" | "failed";

export interface ExtractResponse {
  status: ExtractStatus;
  url: string;
  /** Plain-language message for the user. */
  message: string;
  result: AdapterResult | null;
  cached?: boolean;
}

export interface BenefitParts {
  helped: string;
  future: string;
  nextYear: string;
}

export interface FieldConfidence {
  level: Confidence;
  evidence: string;
}

export interface Entry {
  id: string;
  userId: string;
  profile: ProfileId;
  title: string;
  url: string | null;
  provider: string | null;
  sourceType: SourceType;
  /** Resource publish date, YYYY-MM-DD. */
  publishedAt: string | null;
  /** Date completed (first day for a range), YYYY-MM-DD. */
  dateCompleted: string;
  /** Last day, when the activity spans several days. */
  dateEnd: string | null;
  detectedDurationMinutes: number | null;
  /** Effective learning time in hours, the user's own figure. */
  hours: number;
  /** True once the user ticked the confirmation box (or reviewed the row on import). */
  hoursConfirmed: boolean;
  /** ICE framework theme. */
  theme: string | null;
  /** IStructE category. */
  category: string | null;
  structuralSafety: boolean | null;
  sustainability: boolean | null;
  devPlanRef: string;
  learningPoints: string;
  benefits: BenefitParts;
  /** IStructE: one sentence on what was learned and the benefit. */
  developmentGained: string;
  /** Custom profile values keyed by custom field key. */
  custom: Record<string, string>;
  /** The user's own takeaway notes, as typed. */
  notes: string;
  aiAssisted: boolean;
  confidence: Record<string, FieldConfidence>;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** What the client sends to create an entry. The server fills id, userId and timestamps. */
export type EntryInput = Omit<Entry, "id" | "userId" | "createdAt" | "updatedAt" | "deletedAt">;

export interface CustomFieldDef {
  key: string;
  label: string;
  type: "text" | "number" | "date" | "yes_no";
}

export interface UserSettings {
  name: string;
  jobRole: string;
  responsibilities: string;
  sector: string;
  activeProfiles: ProfileId[];
  customFields: CustomFieldDef[];
}

export const DEFAULT_SETTINGS: UserSettings = {
  name: "",
  jobRole: "",
  responsibilities: "",
  sector: "",
  activeProfiles: ["ice"],
  customFields: [],
};

export interface SessionUser {
  id: string;
  email: string;
}
