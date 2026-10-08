import { PROFILES } from "@/lib/profiles";
import { PROFILE_IDS, type CustomFieldDef, type ProfileId, type UserSettings } from "@/lib/types";

export const MAX_CUSTOM_FIELDS = PROFILES.custom.maxCustomFields;

/** The longest each text may be. The server enforces the same limits. */
export const LIMITS = { name: 200, jobRole: 200, sector: 200, responsibilities: 5000, customLabel: 200 } as const;

/** Error text keyed by the field it belongs to: "name", "jobRole", "responsibilities", "sector", "profiles", "customFields.2", "form". */
export type SettingsErrors = Record<string, string>;

export const FIELD_ID: Record<string, string> = {
  name: "settings-name",
  jobRole: "settings-job-role",
  responsibilities: "settings-responsibilities",
  sector: "settings-sector",
  profiles: "settings-profiles",
};

export function customLabelId(key: string): string {
  return `settings-cf-${key}-label`;
}

/**
 * Removes what the server removes before it saves text: the NUL character and half of a surrogate pair with no partner.
 * Both are invisible, and a name made only of them must count as empty here too, or the server refuses it with a message
 * the person cannot make sense of.
 */
export function stripUnstorable(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0) continue;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s.slice(i, i + 2);
        i++;
      }
      continue;
    }
    if (c >= 0xdc00 && c <= 0xdfff) continue;
    out += s.charAt(i);
  }
  return out;
}

/** The text of a custom field's name as it will be saved. */
function cleanLabel(s: string): string {
  return stripUnstorable(s).trim();
}

/** Logs in the usual order, each once. */
export function orderedProfiles(list: readonly ProfileId[]): ProfileId[] {
  return PROFILE_IDS.filter((id) => list.includes(id));
}

/** The settings as they will be saved: text trimmed, logs in order, and custom fields kept only when they are usable. */
export function normaliseDraft(draft: UserSettings): UserSettings {
  const customOn = draft.activeProfiles.includes("custom");
  const fields = draft.customFields
    .map((f): CustomFieldDef => ({ key: f.key, label: cleanLabel(f.label), type: f.type }))
    // With Custom switched off, a half-typed field with no name is dropped rather than refused.
    .filter((f) => customOn || f.label !== "");
  return {
    name: draft.name.trim(),
    jobRole: draft.jobRole.trim(),
    responsibilities: draft.responsibilities.trim(),
    sector: draft.sector.trim(),
    activeProfiles: orderedProfiles(draft.activeProfiles),
    customFields: fields,
  };
}

/** Same settings? Used to tell whether there is anything unsaved. */
export function sameSettings(a: UserSettings, b: UserSettings): boolean {
  return JSON.stringify(normaliseDraft(a)) === JSON.stringify(normaliseDraft(b));
}

const NEEDS_NAME = "Give this field a name. It becomes a column heading in your export.";
const TOO_LONG = `Field names can be up to ${LIMITS.customLabel} characters.`;
const DUPLICATE_NAME = "Another field already has this name. Give each field its own name.";
const BAD_FIELD = "Something is wrong with this field. Remove it and add it again.";

/** Problems the person can fix before anything is sent. Plain words, tied to the field. */
export function validateDraft(draft: UserSettings): SettingsErrors {
  const errors: SettingsErrors = {};
  const text: Array<[keyof typeof LIMITS, string, string]> = [
    ["name", draft.name, "Name"],
    ["jobRole", draft.jobRole, "Job role"],
    ["sector", draft.sector, "Engineering sector"],
    ["responsibilities", draft.responsibilities, "Responsibilities"],
  ];
  for (const [key, value, label] of text) {
    if (value.length > LIMITS[key]) errors[key] = `${label} can be up to ${LIMITS[key]} characters. Shorten it and try again.`;
  }
  if (draft.activeProfiles.length === 0) errors.profiles = "Keep at least one log switched on.";

  if (draft.activeProfiles.includes("custom")) {
    if (draft.customFields.length > MAX_CUSTOM_FIELDS) {
      errors.customFields = `You can have up to ${MAX_CUSTOM_FIELDS} custom fields. Remove some and try again.`;
    }
    const seen = new Map<string, number>();
    draft.customFields.forEach((f, i) => {
      const label = cleanLabel(f.label);
      if (label === "") {
        errors[`customFields.${i}`] = NEEDS_NAME;
        return;
      }
      if (label.length > LIMITS.customLabel) {
        errors[`customFields.${i}`] = TOO_LONG;
        return;
      }
      const norm = label.toLowerCase();
      if (seen.has(norm)) {
        errors[`customFields.${i}`] = DUPLICATE_NAME;
        return;
      }
      seen.set(norm, i);
    });
  }
  return errors;
}

/** The id of the first control that has an error, so focus can go there. */
export function firstErrorId(errors: SettingsErrors, draft: UserSettings): string | null {
  for (const key of ["name", "jobRole", "sector", "responsibilities", "profiles"]) {
    if (errors[key]) return FIELD_ID[key] ?? null;
  }
  for (let i = 0; i < draft.customFields.length; i++) {
    const f = draft.customFields[i];
    if (f && errors[`customFields.${i}`]) return customLabelId(f.key);
  }
  return null;
}

/**
 * The server words its refusals as "Name must be 200 characters or fewer." Match the start to the field it is about so the
 * message appears next to that field. Anything else is shown for the form as a whole.
 */
export function mapServerError(message: string): { key: string; message: string } {
  const starts: Array<[string, string]> = [
    ["Name ", "name"],
    ["Job role ", "jobRole"],
    ["Responsibilities ", "responsibilities"],
    ["Sector ", "sector"],
    ["Active profiles ", "profiles"],
  ];
  for (const [prefix, key] of starts) if (message.startsWith(prefix)) return { key, message };
  // The server words a problem with one custom field as "Custom fields (1 > label) needs a label." The number counts from
  // zero and the wording reads like a code path, so say it in the same plain words as the checks made before saving.
  const custom = /^Custom fields \((\d+) > (\w+)\)\s*(.*)$/.exec(message);
  if (custom) {
    const key = `customFields.${custom[1]}`;
    if (custom[2] === "label") {
      return { key, message: /too long/.test(custom[3] ?? "") ? TOO_LONG : NEEDS_NAME };
    }
    return { key, message: BAD_FIELD };
  }
  return { key: "form", message };
}

/** What changed in the list of custom fields, so only the messages that no longer apply are cleared. */
export type FieldChange = { kind: "add" } | { kind: "rename" | "type"; index: number } | { kind: "remove"; index: number };

/**
 * The messages that are still true after a change to the custom fields. Typing in one field's name clears that field's
 * message only; the other fields are still blank or repeated, and say so. Removing a field takes its message with it and
 * moves the later ones up, because messages are kept by position. The message about the list as a whole goes on any change.
 */
export function errorsAfterFieldChange(errors: SettingsErrors, change: FieldChange): SettingsErrors {
  const next: SettingsErrors = {};
  for (const [k, v] of Object.entries(errors)) {
    if (k === "form" || k === "customFields") continue;
    const m = /^customFields\.(\d+)$/.exec(k);
    if (!m) {
      next[k] = v;
      continue;
    }
    const at = Number(m[1]);
    if (change.kind === "rename" && at === change.index) continue;
    if (change.kind === "remove") {
      if (at === change.index) continue;
      next[at > change.index ? `customFields.${at - 1}` : k] = v;
      continue;
    }
    next[k] = v;
  }
  return next;
}

function randomPart(): string {
  try {
    return crypto.randomUUID().replace(/-/g, "").slice(0, 10);
  } catch {
    return Math.random().toString(36).slice(2, 12).padEnd(10, "0");
  }
}

/** A key that no other custom field uses. The key stays the same when the label is renamed, so saved values keep their place. */
export function newFieldKey(existing: readonly string[]): string {
  for (let i = 0; i < 10; i++) {
    const key = `f_${randomPart()}`;
    if (!existing.includes(key)) return key;
  }
  return `f_${Date.now().toString(36)}`;
}

export const FIELD_TYPE_LABELS: Record<CustomFieldDef["type"], string> = {
  text: "Text",
  number: "Number",
  date: "Date",
  yes_no: "Yes or no",
};
