"use client";

import { Sparkles } from "lucide-react";
import { useMemo, useState } from "react";
import { EntryForm } from "@/components/entry/entry-form";
import {
  FIELD_ORDER,
  changedFields,
  checkEntry,
  entryFieldId,
  entryToInput,
  firstErrorKey,
  prepareForSave,
} from "@/components/entry/entry-helpers";
import { EntryWarnings, softWarnings } from "@/components/entry/entry-warnings";
import { formatLongDate, todayUk } from "@/lib/dates";
import { profileLabel } from "@/lib/profiles";
import type { EntryInput, UserSettings } from "@/lib/types";
import { toFullEntry, type LogEntry } from "./log-filters";

const ID_PREFIX = "edit";

/** The day an entry was added, as the UK day. createdAt is a UTC timestamp, so just after midnight in summer it is still "yesterday" in UTC. */
function addedOn(createdAt: string): string {
  try {
    return formatLongDate(todayUk(new Date(createdAt)));
  } catch {
    return formatLongDate(createdAt);
  }
}

/**
 * The body of the edit dialog: the shared entry form, soft warnings, and the Save and Cancel buttons.
 * It works out the smallest change (only the fields that differ) and hands it to the page to send.
 * Changing the hours counts as confirming them (the server does the same), so the confirmation box ticks itself
 * when the hours move. That is said right under the hours box.
 */
export function EditEntryForm({
  entry,
  settings,
  others,
  todayIso,
  saving,
  error,
  onSave,
  onCancel,
}: {
  entry: LogEntry;
  settings: Pick<UserSettings, "customFields">;
  others: Pick<LogEntry, "id" | "dateCompleted" | "hours">[];
  todayIso: string;
  saving: boolean;
  error: string | null;
  onSave: (patch: Partial<EntryInput>) => void;
  onCancel: () => void;
}) {
  const initial = useMemo(() => entryToInput(toFullEntry(entry)), [entry]);
  // The saved entry as the save step would tidy it. The change sent is measured against this, so tidying alone is never a change.
  const baseline = useMemo(() => prepareForSave(initial, settings), [initial, settings]);
  const [value, setValue] = useState<EntryInput>(initial);
  const [tried, setTried] = useState(false);

  const prepared = useMemo(() => prepareForSave(value, settings), [value, settings]);
  const errors = useMemo(() => (tried ? checkEntry(prepared, settings) : {}), [tried, prepared, settings]);
  const warnings = useMemo(() => softWarnings(prepared, { others, entryId: entry.id, todayIso }), [prepared, others, entry.id, todayIso]);
  const errorCount = Object.keys(errors).length;

  function change(next: EntryInput) {
    const hoursMoved = next.hours !== value.hours && next.hours > 0;
    setValue(hoursMoved ? { ...next, hoursConfirmed: true } : next);
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;
    const found = checkEntry(prepared, settings);
    if (Object.keys(found).length > 0) {
      setTried(true);
      const key = firstErrorKey(found, FIELD_ORDER);
      if (key) document.getElementById(entryFieldId(ID_PREFIX, key))?.focus();
      return;
    }
    onSave(changedFields(baseline, prepared));
  }

  return (
    // On a very short screen (landscape phone, 200% zoom) the form gets the room: less space between parts and a footer that scrolls with it.
    <form onSubmit={submit} noValidate className="space-y-6 [@media(max-height:480px)]:space-y-4">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
        <span className="badge badge-info">{profileLabel(entry.profile)} log</span>
        <span>
          Added <span className="num">{addedOn(entry.createdAt)}</span>
        </span>
      </p>

      {entry.aiAssisted && (
        <p className="notice notice-warn flex gap-2 text-sm">
          <Sparkles aria-hidden="true" size={19} className="mt-0.5 shrink-0" />
          <span className="min-w-0">Some of this text was written with AI help. If you change it, read it through again so it says what you mean.</span>
        </p>
      )}

      <EntryForm
        profile={value.profile}
        settings={settings}
        value={value}
        onChange={change}
        errors={errors}
        idPrefix={ID_PREFIX}
        hoursNote="Changing the hours counts as confirming them."
      />

      <EntryWarnings warnings={warnings} />

      {errorCount > 0 && (
        <p className="notice notice-error" role="alert">
          {errorCount === 1 ? "One thing needs fixing before this can be saved. It is marked above." : `${errorCount} things need fixing before this can be saved. They are marked above.`}
        </p>
      )}
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}

      <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center gap-3 bg-surface px-5 py-4 sm:-mx-7 sm:px-7 [@media(max-height:480px)]:static [@media(max-height:480px)]:py-2">
        {/* aria-disabled, not disabled: a disabled button drops keyboard focus to the page when it is pressed, and again if the save fails. */}
        <button type="submit" className="btn btn-save" aria-disabled={saving || undefined}>
          Save changes
        </button>
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <span role="status" className="text-sm text-muted">
          {saving ? "Saving…" : ""}
        </span>
      </div>
    </form>
  );
}
