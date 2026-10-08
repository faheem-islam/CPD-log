"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ProvisionalBadge } from "@/components/ui/badge";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/api/client";
import { PROFILES } from "@/lib/profiles";
import type { ProfileId, UserSettings } from "@/lib/types";
import { CheckCard } from "./check-card";
import { CustomFieldsEditor } from "./custom-fields-editor";
import { SettingsSection } from "./section";
import {
  customLabelId,
  errorsAfterFieldChange,
  FIELD_ID,
  firstErrorId,
  LIMITS,
  mapServerError,
  normaliseDraft,
  sameSettings,
  validateDraft,
  type SettingsErrors,
} from "./settings-helpers";

const LOGS: Array<{ id: ProfileId; description: string }> = [
  { id: "ice", description: "Institution of Civil Engineers. Tracks the three mandatory themes and fills the ICE header in your export." },
  { id: "istructe", description: "Institution of Structural Engineers. Hours and the structural safety and sustainability targets." },
  { id: "custom", description: "Your own columns, for any other scheme or an employer's record." },
];

/** An error message next to a field, linked to it for screen readers. */
function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} className="field-error mt-1" role="alert">
      {message}
    </p>
  );
}

/**
 * "Your details" and "Which logs do you keep?", with the one Save settings button. Everything is held in this
 * component until Save, then sent as the full settings object. Problems are shown next to the field they belong to.
 */
export function SettingsForm({ initial }: { initial: UserSettings }) {
  const router = useRouter();
  const { toast } = useToast();
  const [saved, setSaved] = useState<UserSettings>(initial);
  const [draft, setDraft] = useState<UserSettings>(initial);
  const [errors, setErrors] = useState<SettingsErrors>({});
  const [busy, setBusy] = useState(false);
  const [logNote, setLogNote] = useState("");
  const [focusId, setFocusId] = useState<string | null>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);

  const dirty = !sameSettings(draft, saved);
  const customOn = draft.activeProfiles.includes("custom");

  // Move focus to the first problem after a failed save.
  useEffect(() => {
    if (!focusId) return;
    if (focusId === "form") formErrorRef.current?.focus();
    else document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId, errors]);

  function set<K extends keyof UserSettings>(key: K, value: UserSettings[K]) {
    setDraft((d) => ({ ...d, [key]: value }));
    // The message about a field goes as soon as the person changes that field.
    const errorKey = key === "activeProfiles" ? "profiles" : key;
    setErrors((e) => {
      if (!e[errorKey] && !e.form) return e;
      const next = { ...e };
      delete next[errorKey];
      delete next.form;
      return next;
    });
  }

  function toggleLog(id: ProfileId, on: boolean) {
    const has = draft.activeProfiles.includes(id);
    if (!on && has && draft.activeProfiles.length === 1) {
      setLogNote("Keep at least one log switched on.");
      return;
    }
    setLogNote("");
    set("activeProfiles", on ? [...draft.activeProfiles, id] : draft.activeProfiles.filter((p) => p !== id));
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const problems = validateDraft(draft);
    if (Object.keys(problems).length > 0) {
      setErrors(problems);
      setFocusId(firstErrorId(problems, draft));
      return;
    }
    setBusy(true);
    setErrors({});
    try {
      const body = normaliseDraft(draft);
      const res = await api<{ settings: UserSettings }>("/api/settings", { method: "PUT", json: body });
      setSaved(res.settings);
      setDraft(res.settings);
      toast({ message: "Settings saved", tone: "ok" });
      // The rest of the page (logs on the dashboard, the export) reads these settings on the server.
      router.refresh();
    } catch (err) {
      const message = err instanceof ApiClientError ? err.message : "Something went wrong. Your changes were not saved. Try again.";
      const mapped = mapServerError(message);
      setErrors({ [mapped.key]: mapped.message });
      const index = /^customFields\.(\d+)$/.exec(mapped.key)?.[1];
      const customKey = index === undefined ? undefined : draft.customFields[Number(index)]?.key;
      setFocusId(customKey ? customLabelId(customKey) : (FIELD_ID[mapped.key] ?? "form"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={save} noValidate className="space-y-4" aria-label="Your details and logs">
      <SettingsSection
        id="details"
        title="Your details"
        intro="These fill the header at the top of your ICE Excel file. They are optional, and you can change them whenever you like."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="min-w-0">
            <label htmlFor={FIELD_ID.name} className="label">
              Name
            </label>
            <input
              id={FIELD_ID.name}
              className="input"
              type="text"
              autoComplete="name"
              maxLength={LIMITS.name}
              value={draft.name}
              onChange={(e) => set("name", e.target.value)}
              aria-invalid={errors.name ? true : undefined}
              aria-describedby={errors.name ? "settings-name-error" : undefined}
            />
            <FieldError id="settings-name-error" message={errors.name} />
          </div>
          <div className="min-w-0">
            <label htmlFor={FIELD_ID.jobRole} className="label">
              Job role
            </label>
            <input
              id={FIELD_ID.jobRole}
              className="input"
              type="text"
              autoComplete="organization-title"
              maxLength={LIMITS.jobRole}
              value={draft.jobRole}
              onChange={(e) => set("jobRole", e.target.value)}
              aria-invalid={errors.jobRole ? true : undefined}
              aria-describedby={errors.jobRole ? "settings-job-role-error" : undefined}
            />
            <FieldError id="settings-job-role-error" message={errors.jobRole} />
          </div>
        </div>
        <div className="min-w-0">
          <label htmlFor={FIELD_ID.responsibilities} className="label">
            Responsibilities
          </label>
          <textarea
            id={FIELD_ID.responsibilities}
            className="textarea"
            rows={4}
            maxLength={LIMITS.responsibilities}
            value={draft.responsibilities}
            onChange={(e) => set("responsibilities", e.target.value)}
            aria-invalid={errors.responsibilities ? true : undefined}
            aria-describedby={errors.responsibilities ? "settings-responsibilities-error" : "settings-responsibilities-hint"}
          />
          <p id="settings-responsibilities-hint" className="hint mt-1">
            A few lines on what your job involves. It goes next to your job role in the ICE header.
          </p>
          <FieldError id="settings-responsibilities-error" message={errors.responsibilities} />
        </div>
        <div className="min-w-0 sm:max-w-md">
          <label htmlFor={FIELD_ID.sector} className="label">
            Engineering sector
          </label>
          <input
            id={FIELD_ID.sector}
            className="input"
            type="text"
            autoComplete="off"
            maxLength={LIMITS.sector}
            value={draft.sector}
            onChange={(e) => set("sector", e.target.value)}
            aria-invalid={errors.sector ? true : undefined}
            aria-describedby={errors.sector ? "settings-sector-error" : undefined}
          />
          <FieldError id="settings-sector-error" message={errors.sector} />
        </div>
      </SettingsSection>

      <SettingsSection
        id="logs"
        title="Which logs do you keep?"
        intro="Tick the logs you want on your dashboard and in your export. You can keep more than one."
      >
        <fieldset
          id={FIELD_ID.profiles}
          tabIndex={-1}
          className="min-w-0 space-y-2"
          aria-describedby="settings-logs-note"
        >
          <legend className="sr-only">Logs you keep</legend>
          {LOGS.map(({ id, description }) => (
            <CheckCard
              key={id}
              title={PROFILES[id].label}
              checked={draft.activeProfiles.includes(id)}
              onChange={(on) => toggleLog(id, on)}
              badge={PROFILES[id].provisional ? <ProvisionalBadge /> : undefined}
              description={description}
            />
          ))}
          <p id="settings-logs-note" className="hint" role="status">
            {logNote || errors.profiles || "At least one log must stay ticked."}
          </p>
        </fieldset>

        {customOn && (
          <CustomFieldsEditor
            fields={draft.customFields}
            errors={errors}
            onChange={(fields, change) => {
              setDraft((d) => ({ ...d, customFields: fields }));
              // Typing in a field clears that field's own message. The others are still true until the person fixes them.
              setErrors((cur) => errorsAfterFieldChange(cur, change));
            }}
          />
        )}
      </SettingsSection>

      <div className="band-2 space-y-3">
        {errors.form && (
          <p ref={formErrorRef} tabIndex={-1} className="notice notice-error font-bold" role="alert">
            We could not save your settings. {errors.form}
          </p>
        )}
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-base text-muted" role="status">
            {dirty ? "You have changes that are not saved yet." : "Your details and logs are saved together."}
          </p>
          <button type="submit" className="btn btn-primary w-full sm:w-auto" disabled={busy}>
            {busy ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>
    </form>
  );
}
