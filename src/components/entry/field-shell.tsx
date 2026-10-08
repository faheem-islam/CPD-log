import { ChevronRight } from "lucide-react";
import { ConfidenceBadge } from "@/components/ui/badge";
import type { FieldConfidence } from "@/lib/types";

/** Props a control needs so its hint and error are announced with it. */
export interface ControlProps {
  id: string;
  "aria-describedby"?: string;
  "aria-invalid"?: true;
}

/**
 * "Where this came from": a native disclosure showing the evidence for a value. Keyboard operable.
 * `label` is the field's name. It is read out with the words (never shown), so a list of controls
 * can tell the disclosures apart.
 */
export function Evidence({ confidence, label }: { confidence: FieldConfidence; label?: string }) {
  if (!confidence.evidence) return null;
  return (
    <details className="group mt-0.5">
      <summary className="inline-flex min-h-tap cursor-pointer list-none items-center gap-1 text-sm font-bold text-link [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden="true" size={16} strokeWidth={3} className="group-open:rotate-90" />
        <span>
          Where this came from
          {label && <span className="sr-only">, {label}</span>}
        </span>
      </summary>
      <p className="mb-1 rounded-xl bg-surface-2 px-3 py-2 text-sm [overflow-wrap:anywhere]">{confidence.evidence}</p>
    </details>
  );
}

/**
 * One labelled field: label (always visible), optional confidence badge, the control, a hint, an error
 * linked with aria-describedby, and the evidence disclosure when a confidence is given.
 * The control is a render function so it can receive the id and the aria attributes.
 */
export function Field({
  id,
  label,
  hint,
  error,
  confidence,
  required = false,
  className = "",
  children,
}: {
  id: string;
  label: string;
  hint?: React.ReactNode;
  error?: string;
  /** Pass only when badges should show. */
  confidence?: FieldConfidence;
  /** Shows a visible "Required" tag beside the label. The control itself carries aria-required. */
  required?: boolean;
  className?: string;
  children: (control: ControlProps) => React.ReactNode;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const describedBy = [hint ? hintId : null, error ? errorId : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <span className="inline-flex flex-wrap items-baseline gap-x-2">
          <label htmlFor={id} className="label !mb-0">
            {label}
          </label>
          {/* Outside the label so the field's name stays "Title", not "Title Required". Screen readers get aria-required from the control. */}
          {required && (
            <span aria-hidden="true" className="text-xs font-bold uppercase tracking-wide text-muted">
              Required
            </span>
          )}
        </span>
        {confidence && <ConfidenceBadge level={confidence.level} />}
      </div>
      {children({ id, "aria-describedby": describedBy, "aria-invalid": error ? true : undefined })}
      {hint && (
        <p id={hintId} className="hint mt-1">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="field-error mt-1" role="alert">
          {error}
        </p>
      )}
      {confidence && <Evidence confidence={confidence} label={label} />}
    </div>
  );
}

/** A tick box with a large tap area. The label text is the accessible name. */
export function CheckRow({
  id,
  checked,
  onChange,
  children,
  describedBy,
  invalid,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: React.ReactNode;
  describedBy?: string;
  invalid?: boolean;
}) {
  return (
    <label htmlFor={id} className="flex min-h-tap cursor-pointer items-start gap-3 rounded-xl bg-surface-2 p-4 has-[:checked]:bg-sign has-[:checked]:text-sign-ink">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        aria-describedby={describedBy}
        aria-invalid={invalid ? true : undefined}
        className="mt-0.5 h-6 w-6 shrink-0 cursor-pointer accent-[rgb(var(--amber))]"
      />
      <span className="min-w-0 font-bold">{children}</span>
    </label>
  );
}

/** Yes / No as two large radios. Neither selected means "not answered". */
export function YesNo({
  id,
  legend,
  value,
  onChange,
  hint,
  confidence,
}: {
  id: string;
  legend: string;
  value: boolean | null;
  onChange: (v: boolean) => void;
  hint?: string;
  confidence?: FieldConfidence;
}) {
  const hintId = `${id}-hint`;
  return (
    <fieldset className="min-w-0" aria-describedby={hint ? hintId : undefined}>
      <div className="mb-1 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
        <legend className="label !mb-0">{legend}</legend>
        {confidence && <ConfidenceBadge level={confidence.level} />}
      </div>
      <div className="flex gap-2">
        {([true, false] as const).map((opt) => (
          <label
            key={String(opt)}
            className="flex min-h-tap flex-1 cursor-pointer items-center justify-center gap-2 rounded-xl bg-surface-2 px-4 font-bold has-[:checked]:bg-sign has-[:checked]:text-sign-ink"
          >
            <input
              type="radio"
              name={id}
              checked={value === opt}
              onChange={() => onChange(opt)}
              className="h-5 w-5 cursor-pointer accent-[rgb(var(--amber))]"
            />
            {opt ? "Yes" : "No"}
          </label>
        ))}
      </div>
      {hint && (
        <p id={hintId} className="hint mt-1">
          {hint}
        </p>
      )}
      {confidence && <Evidence confidence={confidence} label={legend} />}
    </fieldset>
  );
}
