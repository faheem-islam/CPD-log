"use client";

import { Save } from "lucide-react";
import type { RefObject } from "react";
import { EntryWarnings, type SoftWarning } from "@/components/entry/entry-warnings";
import {
  ClassificationFields,
  DetailsFields,
  HoursConfirm,
  HoursFields,
  ReflectionFields,
  type EntryAi,
  type HoursHint,
} from "@/components/entry/entry-form";
import { AiReviewCheck } from "@/components/entry/expand-notes";
import { hasReflectionText, hoursReady, needsAiReview, type EntryErrors } from "@/components/entry/entry-helpers";
import { formatHours, formatLongDate } from "@/lib/dates";
import { profileLabel } from "@/lib/profiles";
import type { EntryInput, ProfileId, UserSettings } from "@/lib/types";
import { ManualLink } from "./manual-link";
import { ProfilePicker } from "./profile-picker";
import { StepProgress } from "./step-progress";
import { PageNotes, RecordingNotice, SourceStrip, StepActions, UpcomingNotice, ignoreRepeat } from "./step-parts";

type HeadingRef = RefObject<HTMLHeadingElement | null>;
export type ReviewStep = "details" | "hours" | "takeaways";
type Settings = Pick<UserSettings, "activeProfiles" | "customFields">;

interface Base {
  headingRef: HeadingRef;
  settings: Settings;
  value: EntryInput;
  onChange: (next: EntryInput) => void;
  errors: EntryErrors;
  onManual: () => void;
}

const FIELD_IDS = "entry";

const REVIEW_STEPS: readonly ReviewStep[] = ["details", "hours", "takeaways"];
const FIX_LABEL: Record<ReviewStep, string> = { details: "Go to the details", hours: "Go to time spent", takeaways: "Go to takeaways" };

/** Which step holds the field behind an error. */
export function stepOfKey(key: string): ReviewStep {
  if (key === "hours" || key === "hoursConfirmed") return "hours";
  if (key === "learningPoints" || key === "developmentGained" || key === "benefits") return "takeaways";
  return "details";
}

/** Step 4: review what was detected. Every field is editable and says where it came from. */
export function DetailsStep({
  headingRef,
  settings,
  value,
  onChange,
  errors,
  onManual,
  flags,
  notes,
  onProfile,
  onNext,
}: Base & {
  flags: { upcoming: boolean; recording: boolean };
  notes: readonly string[];
  onProfile: (p: ProfileId) => void;
  onNext: () => void;
}) {
  const section = { profile: value.profile, settings, value, onChange, errors, showConfidence: true, idPrefix: FIELD_IDS } as const;
  return (
    <div className="band space-y-5">
      <StepProgress current="details" />
      <div>
        <h2 ref={headingRef} tabIndex={-1}>
          Check the details
        </h2>
        <p className="hint mt-1">Change anything that's wrong. Each detail says how we found it.</p>
      </div>
      {flags.upcoming && <UpcomingNotice />}
      {flags.recording && <RecordingNotice />}
      <PageNotes notes={notes} />
      <ProfilePicker profiles={settings.activeProfiles} value={value.profile} onChange={onProfile} />
      <DetailsFields {...section} />
      <ClassificationFields {...section} />
      <StepActions>
        <button type="button" className="btn btn-primary w-full sm:w-auto" onClick={ignoreRepeat(onNext)}>
          Continue to time spent
        </button>
        <ManualLink onClick={onManual} className="inline-flex min-h-tap items-center font-bold" />
      </StepActions>
    </div>
  );
}

/** Step 5: time spent. The detected length is only a suggestion and the box must be ticked. */
export function HoursStep({
  headingRef,
  settings,
  value,
  onChange,
  errors,
  onManual,
  hint,
  onBack,
  onNext,
}: Base & { hint: HoursHint; onBack: () => void; onNext: () => void }) {
  return (
    <div className="band space-y-5">
      <StepProgress current="hours" />
      <SourceStrip title={value.title} />
      <div>
        <h2 ref={headingRef} tabIndex={-1}>
          How long did you actually spend?
        </h2>
        <p className="hint mt-1">Only you know this, so it is always your figure that goes in the log.</p>
      </div>
      <HoursFields profile={value.profile} settings={settings} value={value} onChange={onChange} errors={errors} showConfidence idPrefix={FIELD_IDS} hint={hint} />
      <StepActions>
        <button type="button" className="btn btn-primary w-full sm:w-auto" onClick={ignoreRepeat(onNext)}>
          Continue to takeaways
        </button>
        <button type="button" className="btn btn-quiet self-start !px-0" onClick={ignoreRepeat(onBack)}>
          Back
        </button>
        <ManualLink onClick={onManual} className="inline-flex min-h-tap items-center font-bold" />
      </StepActions>
    </div>
  );
}

/** Step 6: takeaways. With AI on, notes can be expanded into the wording; with AI off, type the fields. */
export function TakeawaysStep({
  headingRef,
  settings,
  value,
  onChange,
  errors,
  onManual,
  ai,
  onBack,
  onNext,
}: Base & { ai: EntryAi; onBack: () => void; onNext: () => void }) {
  return (
    <div className="band space-y-5">
      <StepProgress current="takeaways" />
      <SourceStrip title={value.title} />
      <div>
        <h2 ref={headingRef} tabIndex={-1}>
          What did you take from it?
        </h2>
        <p className="hint mt-1">A line or two on what you learned and how it helps your work. You can leave this blank and add it later from your log.</p>
      </div>
      <ReflectionFields profile={value.profile} settings={settings} value={value} onChange={onChange} errors={errors} showConfidence idPrefix={FIELD_IDS} ai={ai} />
      <StepActions>
        <button type="button" className="btn btn-primary w-full sm:w-auto" onClick={ignoreRepeat(onNext)}>
          Continue to review
        </button>
        <button type="button" className="btn btn-quiet self-start !px-0" onClick={ignoreRepeat(onBack)}>
          Back
        </button>
        <ManualLink onClick={onManual} className="inline-flex min-h-tap items-center font-bold" />
      </StepActions>
    </div>
  );
}

function Recap({ label, children, onChange, changeLabel }: { label: string; children: React.ReactNode; onChange?: () => void; changeLabel?: string }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-0.5 rounded-xl px-4 py-3 odd:bg-surface-2 sm:grid-cols-[9rem_minmax(0,1fr)_auto]">
      <dt className="text-sm font-bold text-muted sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 [overflow-wrap:anywhere]">{children}</dd>
      {onChange && (
        <dd className="sm:justify-self-end">
          <button type="button" className="btn btn-quiet !min-h-0 !px-0 !py-1 text-sm" onClick={onChange} aria-label={changeLabel}>
            Change
          </button>
        </dd>
      )}
    </div>
  );
}

function clip(text: string, max = 220): string {
  const t = text.trim();
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t;
}

/** Step 7: a recap, soft warnings, the confirmations next to the button, and the one Save action. */
export function SaveStep({
  headingRef,
  value,
  onChange,
  errors,
  onManual,
  ai,
  warnings,
  saving,
  saveError,
  onBack,
  onSave,
  onGoTo,
  onFix,
}: Base & {
  ai: EntryAi;
  warnings: readonly SoftWarning[];
  saving: boolean;
  saveError: string | null;
  onBack: () => void;
  onSave: () => void;
  /** Open a step to change something (the Change buttons). */
  onGoTo: (step: ReviewStep) => void;
  /** Open the step that holds a problem and put the cursor in the field. */
  onFix: (step: ReviewStep) => void;
}) {
  const label = profileLabel(value.profile);
  const aiPending = needsAiReview(value, ai.state.reviewed);
  const ready = hoursReady(value) && !aiPending;
  const blocking = Object.entries(errors).filter(([k]) => k !== "hoursConfirmed");
  // One button for each step that holds a problem, in the order the steps come.
  const fixSteps = REVIEW_STEPS.filter((s) => blocking.some(([k]) => stepOfKey(k) === s));
  const hintId = "save-hint";
  const detail = value.profile === "ice" ? value.theme : value.profile === "istructe" ? value.category : null;
  const reflection = value.profile === "istructe" ? value.developmentGained : value.learningPoints;

  let disabledReason = "";
  if (!(value.hours > 0)) disabledReason = "Add your hours to save.";
  else if (!value.hoursConfirmed) disabledReason = "Tick the box to confirm your hours to save.";
  else if (aiPending) disabledReason = "Tick the box to say you've checked the AI-assisted text to save.";

  return (
    <div className="band space-y-5">
      <StepProgress current="save" />
      <div>
        <h2 ref={headingRef} tabIndex={-1}>
          Check and save
        </h2>
        <p className="hint mt-1">This is what goes in your {label} log. You can edit it later from your log.</p>
      </div>

      <dl className="space-y-1">
        <Recap label="Log">{label}</Recap>
        <Recap label="Title" onChange={() => onGoTo("details")} changeLabel="Change the title and details">
          {value.title.trim() ? <span className="line-clamp-3">{value.title.trim()}</span> : <span className="text-muted">Not added yet</span>}
        </Recap>
        <Recap label="Date completed" onChange={() => onGoTo("details")} changeLabel="Change the date">
          {formatLongDate(value.dateCompleted)}
          {value.dateEnd && value.dateEnd > value.dateCompleted ? ` to ${formatLongDate(value.dateEnd)}` : ""}
        </Recap>
        <Recap label="Hours" onChange={() => onGoTo("hours")} changeLabel="Change the hours">
          {value.hours > 0 ? (
            <>
              <span className="num">{formatHours(value.hours)}</span> {value.hours === 1 ? "hour" : "hours"}
            </>
          ) : (
            <span className="text-muted">Not added yet</span>
          )}
        </Recap>
        {value.profile !== "custom" && (
          <Recap label={value.profile === "ice" ? "ICE theme" : "IStructE category"} onChange={() => onGoTo("details")} changeLabel="Change the theme or category">
            {detail || <span className="text-muted">Not chosen</span>}
          </Recap>
        )}
        <Recap label={value.profile === "istructe" ? "Development gained" : "Learning points"} onChange={() => onGoTo("takeaways")} changeLabel="Change the takeaways">
          {reflection.trim() ? clip(reflection) : <span className="text-muted">Left blank</span>}
        </Recap>
      </dl>

      <EntryWarnings warnings={warnings} />

      {blocking.length > 0 && (
        <div className="notice notice-error" role="alert">
          <p className="font-bold">Fix these before you save</p>
          <ul className="mt-1 list-disc space-y-1 pl-6">
            {blocking.map(([k, m]) => (
              <li key={k}>{m}</li>
            ))}
          </ul>
          <p className="mt-2 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            {fixSteps.map((s) => (
              <button key={s} type="button" className="btn btn-secondary" onClick={() => onFix(s)}>
                {FIX_LABEL[s]}
              </button>
            ))}
          </p>
        </div>
      )}

      <div className="space-y-3">
        <HoursConfirm value={value} idPrefix={FIELD_IDS} onChange={(hoursConfirmed) => onChange({ ...value, hoursConfirmed })} />
        {!(value.hours > 0) && (
          <p className="notice notice-warn">
            You haven't added your hours yet.{" "}
            <button type="button" className="btn btn-quiet !inline !min-h-0 !px-1 underline" onClick={() => onGoTo("hours")}>
              Add your hours
            </button>
          </p>
        )}
        {value.aiAssisted && ai.available && hasReflectionText(value) && (
          <AiReviewCheck id={`${FIELD_IDS}-aiReviewed`} reviewed={ai.state.reviewed} onChange={(reviewed) => ai.onStateChange((prev) => ({ ...prev, reviewed }))} />
        )}
      </div>

      {saveError && (
        <p className="notice notice-error" role="alert">
          {saveError}
        </p>
      )}

      {/* The reason Save is greyed out sits right above it, not under the quiet buttons. */}
      {disabledReason && (
        <p id={hintId} className="hint -mb-2">
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
          aria-describedby={disabledReason ? hintId : undefined}
        >
          <Save aria-hidden="true" size={20} />
          {saving ? "Saving…" : `Save to ${label} log`}
        </button>
        <button type="button" className="btn btn-quiet self-start !px-0" onClick={ignoreRepeat(onBack)} disabled={saving}>
          Back
        </button>
        <ManualLink onClick={onManual} className="inline-flex min-h-tap items-center font-bold" />
      </StepActions>
    </div>
  );
}
