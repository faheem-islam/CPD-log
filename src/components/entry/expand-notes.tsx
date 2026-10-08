"use client";

import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, ApiClientError } from "@/lib/api/client";
import type { ExpandResponse } from "@/lib/api/types";
import type { EntryInput, ProfileId } from "@/lib/types";
import { applyExpansion } from "./entry-helpers";
import { CheckRow, Field } from "./field-shell";

/** What the review boxes need to remember between screens. Lives in the parent. */
export interface AiState {
  /** The person ticked "I've read and checked the AI-assisted text". */
  reviewed: boolean;
  /** Things in the AI text that are not in the person's notes, as returned by the API. */
  warnings: string[];
  /** A request to the AI is on its way. The notes and the boxes it will fill are read-only until it answers. */
  expanding?: boolean;
}

export const EMPTY_AI_STATE: AiState = { reviewed: false, warnings: [] };

/**
 * Pass this to the form to turn the AI parts on. Leave it out and the form shows no AI controls at all.
 * `available` is the server's features.ai flag.
 */
export interface EntryAi {
  available: boolean;
  state: AiState;
  onStateChange: (state: AiState | ((previous: AiState) => AiState)) => void;
  /**
   * Optional. The newest entry value, plus a number that changes when a different entry takes its place
   * (a new link was read). The AI's answer is merged into this, not into the value from when the button
   * was pressed, so nothing typed while it was thinking is lost, and it is dropped if the entry was replaced.
   */
  latest?: () => { value: EntryInput; draft: number };
}

const OFF_LINE: Record<ProfileId, string> = {
  ice: "AI help isn't switched on here, so type your learning points and benefits in yourself.",
  istructe: "AI help isn't switched on here, so type what you gained in yourself.",
  custom: "AI help isn't switched on here, so type what you learned in yourself.",
};

export function AiOffLine({ profile }: { profile: ProfileId }) {
  return <p className="hint">{OFF_LINE[profile]}</p>;
}

/**
 * The notes box and the "Expand my notes" button. Only title, provider, source type, theme and the notes
 * are sent. The answer fills the log's text fields and can be edited freely. On an error the message from
 * the API is shown and nothing the person typed is touched.
 */
export function ExpandNotes({
  id,
  value,
  onChange,
  ai,
}: {
  id: string;
  value: EntryInput;
  onChange: (next: EntryInput) => void;
  ai: EntryAi;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [empty, setEmpty] = useState(false);

  // The newest props, for the moment the answer arrives. The screen may have moved on by then.
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  useEffect(() => {
    valueRef.current = value;
    onChangeRef.current = onChange;
  });
  const newest = () => ai.latest?.() ?? { value: valueRef.current, draft: 0 };

  async function expand() {
    if (busy) return;
    const sent = newest();
    const v = sent.value;
    setBusy(true);
    setError(null);
    setEmpty(false);
    ai.onStateChange((s) => ({ ...s, expanding: true }));
    try {
      const res = await api<ExpandResponse>("/api/ai/expand", {
        json: {
          profile: v.profile,
          title: v.title.trim().slice(0, 500),
          provider: (v.provider ?? "").trim().slice(0, 300) || null,
          sourceType: v.sourceType,
          theme: v.profile === "ice" ? v.theme : null,
          notes: v.notes,
        },
      });
      const now = newest();
      // A different entry has taken its place (another link was read). The answer is not about this one.
      if (now.draft !== sent.draft) return;
      const out = applyExpansion(now.value, res);
      if (out.applied) {
        onChangeRef.current(out.value);
        ai.onStateChange((s) => ({ ...s, reviewed: false, warnings: res.warnings }));
      } else {
        setEmpty(true);
        ai.onStateChange((s) => ({ ...s, warnings: res.warnings }));
      }
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "The AI help didn't answer. Your notes are still here. Try again, or type the text yourself.");
    } finally {
      setBusy(false);
      if (newest().draft === sent.draft) ai.onStateChange((s) => ({ ...s, expanding: false }));
    }
  }

  const noteId = `${id}-notes`;
  const locked = busy || Boolean(ai.state.expanding);
  return (
    <div className="space-y-3" aria-busy={locked}>
      <Field
        id={noteId}
        label="Your notes"
        hint="One or two lines on what you took from it. Only these notes, the title, provider, type and theme are sent to the AI."
      >
        {(c) => (
          <textarea
            {...c}
            className={`textarea${locked ? " opacity-70" : ""}`}
            rows={3}
            maxLength={1200}
            readOnly={locked}
            value={value.notes}
            onChange={(e) => onChange({ ...value, notes: e.target.value })}
          />
        )}
      </Field>
      {/* The hint sits under the button on a phone, so it is never squeezed into a narrow column beside it. */}
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:gap-3">
        <button
          type="button"
          className="btn btn-secondary"
          onClick={expand}
          disabled={locked || value.notes.trim() === ""}
          aria-describedby={`${id}-expand-hint`}
        >
          <Sparkles aria-hidden="true" size={18} />
          Expand my notes
        </button>
        <p id={`${id}-expand-hint`} className="hint min-w-0 sm:flex-1">
          Replaces any text already in the boxes below. You can edit the result.
        </p>
      </div>
      <div aria-live="polite">
        {locked && <p className="hint">Expanding your notes. The boxes below are locked until the text arrives.</p>}
        {empty && !locked && (
          <p className="notice notice-info">The AI had nothing to add from those notes. Add a little more detail and try again, or type the text yourself.</p>
        )}
      </div>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Shown above AI-written text so nobody mistakes it for their own words. */
export function AiBanner({ warnings }: { warnings: readonly string[] }) {
  return (
    <div className="notice notice-warn" role="status">
      <p className="flex items-center gap-2 font-bold">
        <Sparkles aria-hidden="true" size={20} />
        AI-assisted, please review
      </p>
      <p className="mt-1">These words were drafted from your notes. Read them and change anything that isn't right.</p>
      {warnings.length > 0 && (
        <>
          <p className="mt-2 font-bold">Check these before you save</p>
          <ul className="mt-1 list-disc space-y-1 pl-6">
            {warnings.map((w, i) => (
              <li key={`${i}-${w}`}>{w}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The box that must be ticked before AI-assisted text is saved. */
export function AiReviewCheck({ id, reviewed, onChange }: { id: string; reviewed: boolean; onChange: (reviewed: boolean) => void }) {
  return (
    <CheckRow id={id} checked={reviewed} onChange={onChange}>
      I've read and checked the AI-assisted text
    </CheckRow>
  );
}
