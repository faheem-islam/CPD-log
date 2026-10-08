"use client";

import { useId } from "react";

/**
 * One tick box in a list of choices (a log to export, a log to keep). The whole row is the tap target.
 * The accessible name is just the title; the description and badge are read as the description, so a
 * test or a screen reader finds "ICE", not a long sentence.
 *
 * Controlled when `checked` and `onChange` are given. Inside a plain HTML form it can also carry `name` and
 * `value`, so the browser sends the ticked ones.
 */
export function CheckCard({
  title,
  description,
  badge,
  checked,
  onChange,
  name,
  value,
  disabled,
  describedBy,
}: {
  title: string;
  description?: React.ReactNode;
  badge?: React.ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  name?: string;
  value?: string;
  disabled?: boolean;
  describedBy?: string;
}) {
  const uid = useId();
  const inputId = `check-${uid}`;
  const titleId = `${inputId}-title`;
  const descId = `${inputId}-desc`;
  const described = [description ? descId : null, describedBy].filter(Boolean).join(" ") || undefined;
  return (
    <label
      htmlFor={inputId}
      className="flex min-h-tap cursor-pointer items-start gap-3 rounded-xl bg-surface-2 px-4 py-3"
    >
      <input
        id={inputId}
        type="checkbox"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-labelledby={titleId}
        aria-describedby={described}
        className="mt-0.5 h-6 w-6 shrink-0 cursor-pointer accent-[rgb(var(--link))]"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span id={titleId} className="font-bold">
            {title}
          </span>
          {badge && (
            // The badge is nowrap. At a large text size it would be wider than a phone, so let it break inside its own box.
            <span className="min-w-0 max-w-full [&>*]:max-w-full [&>*]:whitespace-normal [&>*]:[overflow-wrap:anywhere]">{badge}</span>
          )}
        </span>
        {description && (
          <span id={descId} className="mt-0.5 block text-sm text-muted">
            {description}
          </span>
        )}
      </span>
    </label>
  );
}
