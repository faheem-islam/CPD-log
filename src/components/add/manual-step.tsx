"use client";

import { Info, Save } from "lucide-react";
import type { RefObject } from "react";
import { EntryForm, type EntryAi, type HoursHint } from "@/components/entry/entry-form";
import { EntryWarnings, type SoftWarning } from "@/components/entry/entry-warnings";
import { hoursReady, needsAiReview, type EntryErrors } from "@/components/entry/entry-helpers";
import { profileLabel } from "@/lib/profiles";
import type { EntryInput, ProfileId, UserSettings } from "@/lib/types";
import { ProfilePicker } from "./profile-picker";
import { StepActions } from "./step-parts";

export interface ReadFailure {
  /** The message the API gave, shown as it is. */
  message: string;
  url: string;
}

/**
 * The manual form: the same EntryForm the Log edit dialog uses, with one Save. Reached from "Fill in by hand"
 * on any step, or when a page could not be read. When it follows a failed read it says so plainly, keeps the
 * link in the form, and does not offer any other way of reading the page.
 */
export function ManualStep({
  headingRef,
  settings,
  value,
  onChange,
  errors,
  failure,
  ai,
  hoursHint,
  warnings,
  saving,
  saveError,
  onProfile,
  onSave,
  onReadLink,
}: {
  headingRef: RefObject<HTMLHeadingElement | null>;
  settings: Pick<UserSettings, "activeProfiles" | "customFields">;
  value: EntryInput;
  onChange: (next: EntryInput) => void;
  errors: EntryErrors;
  failure: ReadFailure | null;
  ai: EntryAi;
  hoursHint: HoursHint;
  warnings: readonly SoftWarning[];
  saving: boolean;
  saveError: string | null;
  onProfile: (p: ProfileId) => void;
  onSave: () => void;
  onReadLink: () => void;
}) {
  const label = profileLabel(value.profile);
  const aiPending = needsAiReview(value, ai.state.reviewed);
  const ready = hoursReady(value) && !aiPending;
  const hasErrors = Object.keys(errors).length > 0;

  let disabledReason = "";
  if (!(value.hours > 0)) disabledReason = "Add your hours to save.";
  else if (!value.hoursConfirmed) disabledReason = "Tick the box to confirm your hours to save.";
  else if (aiPending) disabledReason = "Tick the box to say you've checked the AI-assisted text to save.";

  return (
    <div className="band space-y-6">
      <div className="space-y-3">
        {failure ? (
          <>
            <h2 ref={headingRef} tabIndex={-1}>
              Couldn't read this site automatically
            </h2>
            <p className="notice notice-info flex gap-2">
              <Info aria-hidden="true" size={20} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{failure.message}</span>
            </p>
            <p className="hint">We've kept your link in the form below. Fill in the rest yourself. Nothing is saved until you press Save.</p>
          </>
        ) : (
          <>
            <h2 ref={headingRef} tabIndex={-1}>
              Fill in the details
            </h2>
            <p className="hint">Nothing is saved until you press Save.</p>
          </>
        )}
      </div>

      <ProfilePicker profiles={settings.activeProfiles} value={value.profile} onChange={onProfile} />

      <EntryForm profile={value.profile} settings={settings} value={value} onChange={onChange} errors={errors} ai={ai} hoursHint={hoursHint} idPrefix="entry" />

      <EntryWarnings warnings={warnings} />

      {hasErrors && (
        <p className="notice notice-error" role="alert">
          Check the highlighted fields, then save again.
        </p>
      )}
      {saveError && (
        <p className="notice notice-error" role="alert">
          {saveError}
        </p>
      )}

      {/* The reason Save is greyed out sits right above it, not under the quiet button. */}
      {disabledReason && (
        <p id="manual-save-hint" className="hint -mb-2">
          {disabledReason}
        </p>
      )}
      <StepActions>
        <button
          type="button"
          className="btn btn-save w-full sm:w-auto"
          onClick={() => {
            if (!saving) onSave();
          }}
          disabled={!ready}
          aria-disabled={saving || undefined}
          aria-describedby={disabledReason ? "manual-save-hint" : undefined}
        >
          <Save aria-hidden="true" size={20} />
          {saving ? "Saving…" : `Save to ${label} log`}
        </button>
        <button type="button" className="btn btn-quiet self-start !px-0" onClick={onReadLink} disabled={saving}>
          {failure ? "Use a different link" : "Read a link instead"}
        </button>
      </StepActions>
    </div>
  );
}
