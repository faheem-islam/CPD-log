"use client";

import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { CustomFieldDef } from "@/lib/types";
import { customLabelId, FIELD_TYPE_LABELS, MAX_CUSTOM_FIELDS, newFieldKey, type FieldChange, type SettingsErrors } from "./settings-helpers";

const TYPES: CustomFieldDef["type"][] = ["text", "number", "date", "yes_no"];

/**
 * The person's own columns for the Custom log. Each has a name (which becomes the column heading in the export) and
 * a type. Up to ten. Names are required and different from each other. A field keeps its key when it is renamed, so
 * values already saved against it stay with it.
 */
export function CustomFieldsEditor({
  fields,
  errors,
  onChange,
}: {
  fields: CustomFieldDef[];
  errors: SettingsErrors;
  /** The new list, and what changed, so the form can keep the messages that still apply. */
  onChange: (next: CustomFieldDef[], change: FieldChange) => void;
}) {
  const addRef = useRef<HTMLButtonElement>(null);
  // After adding or removing a row, focus goes somewhere sensible instead of being lost.
  const [focusTarget, setFocusTarget] = useState<string | "add" | null>(null);
  const atLimit = fields.length >= MAX_CUSTOM_FIELDS;

  useEffect(() => {
    if (!focusTarget) return;
    if (focusTarget === "add") addRef.current?.focus();
    else document.getElementById(customLabelId(focusTarget))?.focus();
    setFocusTarget(null);
  }, [focusTarget, fields]);

  function add() {
    const key = newFieldKey(fields.map((f) => f.key));
    onChange([...fields, { key, label: "", type: "text" }], { kind: "add" });
    setFocusTarget(key);
  }

  function remove(index: number) {
    const next = fields.filter((_, i) => i !== index);
    onChange(next, { kind: "remove", index });
    const neighbour = next[index] ?? next[index - 1];
    setFocusTarget(neighbour ? neighbour.key : "add");
  }

  function update(index: number, patch: Partial<CustomFieldDef>) {
    onChange(
      fields.map((f, i) => (i === index ? { ...f, ...patch } : f)),
      { kind: patch.label !== undefined ? "rename" : "type", index },
    );
  }

  const listError = errors.customFields;

  return (
    <div className="band-2 min-w-0 space-y-4 !p-4 sm:!p-5">
      <div>
        <h3>Your custom fields</h3>
        <p id="custom-fields-help" className="mt-1 text-base text-muted">
          Each field becomes a column in your Custom log and in its export, after Date, Activity and Hours. The name you give it is the
          column heading. You can add up to {MAX_CUSTOM_FIELDS}.
        </p>
      </div>

      {fields.length === 0 ? (
        <p className="rounded-xl bg-surface px-4 py-3 text-base">
          You have no custom fields yet. Without any, your Custom log has just Date, Activity and Hours.
        </p>
      ) : (
        <ul className="space-y-2" aria-label="Custom fields">
          {fields.map((f, i) => {
            const error = errors[`customFields.${i}`];
            const labelId = customLabelId(f.key);
            const typeId = `settings-cf-${f.key}-type`;
            const errorId = `${labelId}-error`;
            return (
              <li key={f.key} className="rounded-xl bg-surface px-3 py-3 sm:px-4">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-[minmax(0,1fr)_9rem_auto] sm:items-end">
                  <div className="min-w-0">
                    <label htmlFor={labelId} className="label">
                      Column heading {i + 1}
                    </label>
                    <input
                      id={labelId}
                      type="text"
                      className="input"
                      value={f.label}
                      maxLength={200}
                      autoComplete="off"
                      onChange={(e) => update(i, { label: e.target.value })}
                      aria-invalid={error ? true : undefined}
                      aria-describedby={error ? errorId : undefined}
                    />
                  </div>
                  <div className="min-w-0">
                    <label htmlFor={typeId} className="label">
                      Column type {i + 1}
                    </label>
                    <select id={typeId} className="select" value={f.type} onChange={(e) => update(i, { type: e.target.value as CustomFieldDef["type"] })}>
                      {TYPES.map((t) => (
                        <option key={t} value={t}>
                          {FIELD_TYPE_LABELS[t]}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    className="btn btn-quiet -ml-3 justify-self-start sm:ml-0 sm:justify-self-end"
                    onClick={() => remove(i)}
                    aria-label={`Remove column ${i + 1}`}
                  >
                    <Trash2 aria-hidden="true" size={18} />
                    Remove
                  </button>
                </div>
                {error && (
                  <p id={errorId} className="field-error mt-2" role="alert">
                    {error}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {listError && (
        <p className="field-error" role="alert">
          {listError}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <button ref={addRef} type="button" className="btn btn-secondary" onClick={add} disabled={atLimit} aria-describedby={atLimit ? "custom-fields-limit" : undefined}>
          <Plus aria-hidden="true" size={18} />
          Add a field
        </button>
        {atLimit && (
          <p id="custom-fields-limit" className="text-sm font-bold">
            That is the limit of {MAX_CUSTOM_FIELDS} fields. Remove one to add another.
          </p>
        )}
      </div>
      <p className="hint">Renaming a field changes only its column heading. Removing one takes its column out of the export.</p>
    </div>
  );
}
