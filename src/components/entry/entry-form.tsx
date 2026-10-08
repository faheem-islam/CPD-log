"use client";

/**
 * The shared, profile-aware entry form. A controlled component: it owns no entry data, it edits the
 * `value` you give it and calls `onChange` with the next value. Used by the Add flow (manual form and
 * the wizard steps) and by the Log edit dialog.
 *
 * Whole form:  <EntryForm profile settings value onChange errors ai? hoursHint? showConfidence? idPrefix? />
 * One section: DetailsFields, ClassificationFields, HoursFields, ReflectionFields (same section props).
 *
 *  - `profile` decides which fields show (normally value.profile).
 *  - `settings` supplies the person's custom fields; only customFields is read.
 *  - `errors` come from checkEntry() in entry-helpers.ts. Each is linked to its field with aria-describedby.
 *  - `ai` is optional. Leave it out (the Log edit dialog does) and no AI controls show. Pass it and the
 *    reflection section shows the notes box and "Expand my notes" when ai.available is true, or a short
 *    plain line when it is false. The parent keeps ai.state (reviewed, warnings) so it survives screens.
 *  - `showConfidence` adds a confidence badge and a "Where this came from" disclosure to each field
 *    that has a recorded confidence. Edits made here are recorded as "Typed by you".
 *  - `idPrefix` fixes element ids (the Add flow uses "entry" so it can focus the first invalid field).
 *
 * The form never saves and never blocks. Warnings are separate: see entry-warnings.tsx.
 */

import { Info } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { ConfidenceBadge, ProvisionalBadge } from "@/components/ui/badge";
import { formatHours, formatLongDate } from "@/lib/dates";
import { ICE_ALL_THEMES, PROFILES } from "@/lib/profiles";
import {
  SOURCE_TYPES,
  SOURCE_TYPE_LABELS,
  type EntryInput,
  type FieldConfidence,
  type ProfileId,
  type SourceType,
  type UserSettings,
} from "@/lib/types";
import {
  HOUR_QUICK_PICKS,
  confidenceOf,
  entryFieldId,
  hasReflectionText,
  hoursText,
  markEdited,
  parseHours,
  type EntryErrors,
} from "./entry-helpers";
import { AiBanner, AiOffLine, AiReviewCheck, ExpandNotes, type EntryAi } from "./expand-notes";
import { CheckRow, Evidence, Field, YesNo } from "./field-shell";

export type { AiState, EntryAi } from "./expand-notes";
export { EMPTY_AI_STATE } from "./expand-notes";

/** Extra help next to the hours box. Built by the Add flow from what the page reader found. */
export interface HoursHint {
  /** A length found on the page, converted to hours. Only a starting point. */
  suggestion?: { hours: number; detected: string; confidence: FieldConfidence };
  /** Said plainly when no length was found. */
  notFound?: string;
  /** What the provider says the event is worth. Shown as a hint, never put into the hours box. */
  providerStated?: { hours: number };
}

export interface SectionProps {
  profile: ProfileId;
  settings: Pick<UserSettings, "customFields">;
  value: EntryInput;
  onChange: (next: EntryInput) => void;
  errors?: EntryErrors;
  showConfidence?: boolean;
  idPrefix?: string;
}

export interface EntryFormProps extends SectionProps {
  ai?: EntryAi;
  hoursHint?: HoursHint;
  /** A short line shown next to the hours box, above the confirmation. */
  hoursNote?: React.ReactNode;
}

/** Shared plumbing: stable ids, edit-and-mark-as-typed, confidence and error lookups. */
function useBase(p: SectionProps) {
  const auto = useId().replace(/[^a-zA-Z0-9]/g, "");
  const prefix = p.idPrefix ?? `entry${auto}`;
  const id = (key: string) => entryFieldId(prefix, key);
  /** Apply a change and record the touched fields as typed by the person (or empty). */
  const edit = (patch: Partial<EntryInput>, keys: readonly string[]) => {
    const merged: EntryInput = { ...p.value, ...patch };
    p.onChange({ ...merged, confidence: markEdited(merged, keys) });
  };
  const conf = (key: string): FieldConfidence | undefined => (p.showConfidence ? confidenceOf(p.value.confidence, key) : undefined);
  const err = (key: string): string | undefined => p.errors?.[key];
  return { id, edit, conf, err, prefix };
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return <h3 className="eyebrow">{children}</h3>;
}

// ---------------------------------------------------------------------------------------------
// Details: title, link, provider, type, dates

export function DetailsFields(p: SectionProps) {
  const { id, edit, conf, err } = useBase(p);
  const v = p.value;
  const longDate = formatLongDate(v.dateCompleted);
  const longEnd = formatLongDate(v.dateEnd);
  return (
    <div className="space-y-4">
      <Field id={id("title")} label="Title" required error={err("title")} confidence={conf("title")}>
        {(c) => (
          <input
            {...c}
            type="text"
            className="input"
            value={v.title}
            maxLength={1000}
            autoComplete="off"
            aria-required="true"
            onChange={(e) => edit({ title: e.target.value }, ["title"])}
          />
        )}
      </Field>
      <Field id={id("url")} label="Link" error={err("url")} confidence={conf("url")}>
        {(c) => (
          <input
            {...c}
            type="url"
            inputMode="url"
            className="input"
            value={v.url ?? ""}
            maxLength={4000}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            onChange={(e) => edit({ url: e.target.value }, ["url"])}
          />
        )}
      </Field>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Field id={id("provider")} label="Provider" confidence={conf("provider")}>
          {(c) => (
            <input
              {...c}
              type="text"
              className="input"
              value={v.provider ?? ""}
              maxLength={500}
              autoComplete="off"
              onChange={(e) => edit({ provider: e.target.value }, ["provider"])}
            />
          )}
        </Field>
        <Field id={id("sourceType")} label="Source type" confidence={conf("sourceType")}>
          {(c) => (
            <select {...c} className="select" value={v.sourceType} onChange={(e) => edit({ sourceType: e.target.value as SourceType }, ["sourceType"])}>
              {SOURCE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {SOURCE_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <Field
          id={id("dateCompleted")}
          label="Date completed"
          required
          error={err("dateCompleted")}
          confidence={conf("dateCompleted")}
          hint={longDate || undefined}
        >
          {(c) => (
            <input {...c} type="date" className="input" value={v.dateCompleted} aria-required="true" onChange={(e) => edit({ dateCompleted: e.target.value }, ["dateCompleted"])} />
          )}
        </Field>
        <Field
          id={id("dateEnd")}
          label="End date"
          error={err("dateEnd")}
          confidence={conf("dateEnd")}
          hint={longEnd || "Only if it ran over several days."}
        >
          {(c) => <input {...c} type="date" className="input" value={v.dateEnd ?? ""} onChange={(e) => edit({ dateEnd: e.target.value || null }, ["dateEnd"])} />}
        </Field>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Classification: ICE theme / IStructE category and flags / the person's own fields

function selectOptions(current: string | null, known: readonly string[], label: (v: string) => string) {
  const extra = current && !known.includes(current) ? [current] : [];
  return [...known, ...extra].map((o) => (
    <option key={o} value={o}>
      {label(o)}
    </option>
  ));
}

export function ClassificationFields(p: SectionProps) {
  const { id, edit, conf, err } = useBase(p);
  const v = p.value;

  if (p.profile === "ice") {
    const mandatory = PROFILES.ice.themes.mandatory;
    return (
      <Field
        id={id("theme")}
        label="ICE theme"
        confidence={conf("theme")}
        error={err("theme")}
        hint="Mandatory themes are marked. ICE asks you to record at least one of them each year."
      >
        {(c) => (
          <select {...c} className="select" value={v.theme ?? ""} onChange={(e) => edit({ theme: e.target.value || null }, ["theme"])}>
            <option value="">Choose a theme</option>
            {selectOptions(v.theme, ICE_ALL_THEMES, (t) => (mandatory.includes(t) ? `${t} (mandatory)` : t))}
          </select>
        )}
      </Field>
    );
  }

  if (p.profile === "istructe") {
    return (
      <div className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <ProvisionalBadge />
          <span className="hint min-w-0 basis-full sm:flex-1 sm:basis-0">These fields follow published IStructE guidance, not the My Account form.</span>
        </div>
        <Field id={id("category")} label="IStructE category" confidence={conf("category")} error={err("category")}>
          {(c) => (
            <select {...c} className="select" value={v.category ?? ""} onChange={(e) => edit({ category: e.target.value || null }, ["category"])}>
              <option value="">Choose a category</option>
              {selectOptions(v.category, PROFILES.istructe.categories, (x) => x)}
            </select>
          )}
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <YesNo
            id={id("structuralSafety")}
            legend="Structural safety"
            value={v.structuralSafety}
            onChange={(b) => edit({ structuralSafety: b }, ["structuralSafety"])}
            confidence={conf("structuralSafety")}
          />
          <YesNo
            id={id("sustainability")}
            legend="Sustainability"
            value={v.sustainability}
            onChange={(b) => edit({ sustainability: b }, ["sustainability"])}
            confidence={conf("sustainability")}
          />
        </div>
      </div>
    );
  }

  // Custom: the person's own fields from Settings.
  const defs = p.settings.customFields;
  if (defs.length === 0) {
    return (
      <p className="notice notice-info">
        You haven't set up any custom fields. Add them in <Link href="/settings">Settings</Link> and they will appear here.
      </p>
    );
  }
  return (
    <div className="space-y-4">
      {defs.map((def) => {
        const key = `custom.${def.key}`;
        const raw = v.custom[def.key] ?? "";
        const set = (next: string) => {
          const custom = { ...v.custom, [def.key]: next };
          p.onChange({ ...v, custom });
        };
        if (def.type === "yes_no") {
          return (
            <YesNo
              key={def.key}
              id={id(key)}
              legend={def.label}
              value={raw === "yes" ? true : raw === "no" ? false : null}
              onChange={(b) => set(b ? "yes" : "no")}
            />
          );
        }
        return (
          <Field key={def.key} id={id(key)} label={def.label} error={err(key)}>
            {(c) => (
              <input
                {...c}
                type={def.type === "number" ? "number" : def.type === "date" ? "date" : "text"}
                inputMode={def.type === "number" ? "decimal" : undefined}
                step={def.type === "number" ? "any" : undefined}
                className="input"
                value={raw}
                maxLength={def.type === "text" ? 5000 : undefined}
                onChange={(e) => set(e.target.value)}
              />
            )}
          </Field>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Hours

/** The hours box. Keeps its own text while typing ("1." is not yet a number) and follows the value otherwise. */
function HoursInput({ control, value, onChange }: { control: React.ComponentProps<"input">; value: number; onChange: (hours: number) => void }) {
  const [text, setText] = useState(hoursText(value));
  useEffect(() => {
    setText((t) => (parseHours(t) === value ? t : hoursText(value)));
  }, [value]);
  return (
    <input
      {...control}
      type="number"
      inputMode="decimal"
      min={0}
      step={0.25}
      className="input num max-w-[10rem]"
      value={text}
      aria-required="true"
      onChange={(e) => {
        setText(e.target.value);
        onChange(parseHours(e.target.value));
      }}
      onBlur={() => setText(hoursText(value))}
    />
  );
}

/** "I confirm this is the time I actually spent learning". Required before any save. */
export function HoursConfirm({
  value,
  onChange,
  error,
  idPrefix = "entry",
}: {
  value: Pick<EntryInput, "hoursConfirmed">;
  onChange: (confirmed: boolean) => void;
  error?: string;
  idPrefix?: string;
}) {
  const id = entryFieldId(idPrefix, "hoursConfirmed");
  return (
    <div>
      <CheckRow id={id} checked={value.hoursConfirmed} onChange={onChange} describedBy={error ? `${id}-error` : undefined} invalid={Boolean(error)}>
        I confirm this is the time I actually spent learning
      </CheckRow>
      {error && (
        <p id={`${id}-error`} className="field-error mt-1" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export function HoursFields(p: SectionProps & { hint?: HoursHint; note?: React.ReactNode }) {
  const { id, edit, conf, err, prefix } = useBase(p);
  const v = p.value;
  const quickId = id("quick");
  const hint = p.hint;
  return (
    <div className="space-y-4">
      <Field
        id={id("hours")}
        label="Hours"
        required
        error={err("hours")}
        confidence={conf("hours")}
        hint="Effective learning time, not the length of the video or event."
      >
        {(c) => <HoursInput control={c} value={v.hours} onChange={(hours) => edit({ hours }, ["hours"])} />}
      </Field>
      <div role="group" aria-labelledby={quickId}>
        <p id={quickId} className="hint mb-1">
          Quick picks
        </p>
        <div className="flex flex-wrap gap-2">
          {HOUR_QUICK_PICKS.map((h) => (
            <button
              key={h}
              type="button"
              className="btn btn-secondary num !px-3 aria-pressed:bg-sign aria-pressed:text-sign-ink"
              aria-pressed={v.hours === h}
              aria-label={`${h} ${h === 1 ? "hour" : "hours"}`}
              onClick={() => edit({ hours: h }, ["hours"])}
            >
              {h}
            </button>
          ))}
        </div>
      </div>
      {hint?.suggestion && (
        <p className="notice notice-info flex gap-2">
          <Info aria-hidden="true" size={20} className="mt-0.5 shrink-0" />
          <span className="min-w-0">
            We read a length of <strong className="num">{hint.suggestion.detected}</strong> on the page and put <strong className="num">{formatHours(hint.suggestion.hours)}</strong> hours in the box as a
            starting point. Change it to the time you actually spent learning.
          </span>
        </p>
      )}
      {hint?.notFound && (
        <p className="notice notice-info flex gap-2">
          <Info aria-hidden="true" size={20} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{hint.notFound}</span>
        </p>
      )}
      {hint?.providerStated && (
        <p className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-2 px-4 py-3 text-sm">
          <span className="badge badge-info">Provider-stated</span>
          <span className="min-w-0 basis-full sm:flex-1 sm:basis-0">
            <strong className="num">{formatHours(hint.providerStated.hours)}</strong> CPD {hint.providerStated.hours === 1 ? "hour" : "hours"}. This is what the provider says it is worth. It isn't added to your hours.
          </span>
        </p>
      )}
      {p.note && <p className="hint">{p.note}</p>}
      <HoursConfirm value={v} idPrefix={prefix} error={err("hoursConfirmed")} onChange={(hoursConfirmed) => p.onChange({ ...v, hoursConfirmed })} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Reflection: learning points, benefits, development gained

export function ReflectionFields(p: SectionProps & { ai?: EntryAi }) {
  const { id, edit, conf, err } = useBase(p);
  const v = p.value;
  const ai = p.ai;
  const aiText = Boolean(ai?.available) && v.aiAssisted && hasReflectionText(v);
  const prompts = PROFILES.ice.benefitPrompts;
  // While the AI is writing, the boxes it will fill are read-only, so nothing typed there is replaced a moment later.
  const locked = Boolean(ai?.state.expanding);
  const lockedClass = locked ? " opacity-70" : "";

  return (
    <div className="space-y-4">
      {ai && (ai.available ? <ExpandNotes id={id("expand")} value={v} onChange={p.onChange} ai={ai} /> : <AiOffLine profile={p.profile} />)}
      {ai && aiText && <AiBanner warnings={ai.state.warnings} />}

      {p.profile === "istructe" ? (
        <Field
          id={id("developmentGained")}
          label="Development gained"
          confidence={conf("developmentGained")}
          error={err("developmentGained")}
          hint="One sentence: what you learned and how it helps your work."
        >
          {(c) => (
            <textarea
              {...c}
              className={`textarea${lockedClass}`}
              rows={3}
              readOnly={locked}
              value={v.developmentGained}
              onChange={(e) => edit({ developmentGained: e.target.value }, ["developmentGained"])}
            />
          )}
        </Field>
      ) : (
        <Field
          id={id("learningPoints")}
          label={p.profile === "ice" ? "Key learning points" : "What you learned"}
          confidence={conf("learningPoints")}
          error={err("learningPoints")}
          hint={
            p.profile === "ice"
              ? "What you learned, in your own words."
              : "Kept in your log. The Custom Excel export uses only the fields you set in Settings."
          }
        >
          {(c) => (
            <textarea
              {...c}
              className={`textarea${lockedClass}`}
              rows={3}
              readOnly={locked}
              value={v.learningPoints}
              onChange={(e) => edit({ learningPoints: e.target.value }, ["learningPoints"])}
            />
          )}
        </Field>
      )}

      {p.profile === "ice" && (
        <fieldset className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <legend className="label !mb-0">Key benefits and value added (all optional)</legend>
            {conf("benefits") && <ConfidenceBadge level={conf("benefits")?.level ?? "missing"} />}
          </div>
          {prompts.map((prompt) => (
            <Field key={prompt.key} id={id(`benefit-${prompt.key}`)} label={prompt.label}>
              {(c) => (
                <textarea
                  {...c}
                  className={`textarea !min-h-[4.5rem]${lockedClass}`}
                  rows={2}
                  readOnly={locked}
                  value={v.benefits[prompt.key]}
                  onChange={(e) => edit({ benefits: { ...v.benefits, [prompt.key]: e.target.value } }, ["benefits"])}
                />
              )}
            </Field>
          ))}
          {conf("benefits") && <Evidence confidence={conf("benefits") as FieldConfidence} label="Key benefits and value added" />}
        </fieldset>
      )}

      {ai && aiText && <AiReviewCheck id={id("aiReviewed")} reviewed={ai.state.reviewed} onChange={(reviewed) => ai.onStateChange((prev) => ({ ...prev, reviewed }))} />}

      {p.profile === "ice" && (
        <Field id={id("devPlanRef")} label="Dev plan ref" confidence={conf("devPlanRef")} hint="Leave as unplanned if this wasn't in your development plan.">
          {(c) => <input {...c} type="text" className="input" value={v.devPlanRef} maxLength={300} onChange={(e) => edit({ devPlanRef: e.target.value }, ["devPlanRef"])} />}
        </Field>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// The whole form

export function EntryForm({ ai, hoursHint, hoursNote, ...section }: EntryFormProps) {
  return (
    <div className="space-y-8">
      <div className="space-y-4">
        <SectionHeading>Details</SectionHeading>
        <DetailsFields {...section} />
        <ClassificationFields {...section} />
      </div>
      <div className="space-y-4">
        <SectionHeading>Time spent</SectionHeading>
        <HoursFields {...section} hint={hoursHint} note={hoursNote} />
      </div>
      <div className="space-y-4">
        <SectionHeading>What you learned</SectionHeading>
        <ReflectionFields {...section} ai={ai} />
      </div>
    </div>
  );
}
