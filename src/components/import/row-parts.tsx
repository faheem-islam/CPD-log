"use client";

import { ChevronRight, CircleX, Copy, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { ConfidenceBadge } from "@/components/ui/badge";
import { formatHours, formatUkDate, parseUkDate } from "@/lib/dates";
import type { ImportIssue, ImportRow } from "@/lib/import/types";
import { ICE_ALL_THEMES, PROFILES } from "@/lib/profiles";
import type { CustomFieldDef, EntryInput, ProfileId } from "@/lib/types";
import { DEFAULT_PLAN_REF, DUPLICATE_TEXT, SCREENSHOT_NOTE, UNREADABLE_HOURS_MESSAGE, duplicateDetail, issuesId, readHoursText, rid } from "./helpers";

export type LabelMode = "visible" | "hidden";
export type EditFn = (n: number, patch: Partial<EntryInput>) => void;

interface FieldProps {
  row: ImportRow;
  /** The row as first read, to tell whether the person has changed a value since. */
  base: ImportRow | undefined;
  mode: LabelMode;
  onEdit: EditFn;
}

function fieldIssues(row: ImportRow, field: string) {
  return row.issues.filter((i) => i.field === field);
}

/** Props that link a control to the row's message list, and mark it invalid when the message is an error. */
function linkProps(row: ImportRow, field: string) {
  const found = fieldIssues(row, field);
  return {
    "aria-describedby": found.length > 0 ? issuesId(row.n) : undefined,
    "aria-invalid": found.some((i) => i.severity === "error") ? (true as const) : undefined,
  };
}

/** Every control has a label. In the table it is read aloud only, because the column heading shows it. */
function Label({ id, mode, n, children }: { id: string; mode: LabelMode; n: number; children: React.ReactNode }) {
  return (
    <label htmlFor={id} className={mode === "hidden" ? "sr-only" : "label"}>
      {children}
      <span className="sr-only"> for row {n}</span>
    </label>
  );
}

/**
 * How sure the importer was about a value, shown only while the value is as it was first read.
 * In the table the badge sits in a narrow column, so it is tightened and is allowed to wrap rather than spill over
 * into the next cell.
 */
function Confidence({
  row,
  base,
  field,
  confKey,
  mode,
}: {
  row: ImportRow;
  base: ImportRow | undefined;
  field: keyof EntryInput;
  confKey: string;
  mode: LabelMode;
}) {
  const c = row.input.confidence?.[confKey];
  if (!c || c.level === "high") return null;
  if (base && JSON.stringify(base.input[field]) !== JSON.stringify(row.input[field])) return null;
  return (
    <div className={`mt-1 min-w-0 space-y-0.5 ${mode === "hidden" ? "[&_.badge]:max-w-full [&_.badge]:whitespace-normal [&_.badge]:px-2" : ""}`}>
      <ConfidenceBadge level={c.level} />
      {c.level !== "missing" && c.evidence && <p className="text-xs text-muted [overflow-wrap:anywhere]">{c.evidence}</p>}
    </div>
  );
}

export function IncludeBox({ row, onToggle, variant }: { row: ImportRow; onToggle: (n: number, include: boolean) => void; variant: "table" | "card" }) {
  const id = `import-include-${row.n}`;
  const input = (
    <input
      id={id}
      type="checkbox"
      checked={row.include}
      onChange={(e) => onToggle(row.n, e.target.checked)}
      aria-describedby={row.issues.length > 0 ? issuesId(row.n) : undefined}
      className="h-6 w-6 shrink-0 cursor-pointer accent-[rgb(var(--link))]"
    />
  );
  if (variant === "table") {
    return (
      <label className="flex min-h-tap min-w-tap cursor-pointer items-center justify-center">
        {input}
        <span className="sr-only">Include row {row.n}</span>
      </label>
    );
  }
  return (
    <label className="flex min-h-tap cursor-pointer items-center gap-3 font-display text-xl font-bold">
      {input}
      <span>Include row {row.n}</span>
    </label>
  );
}

export function DateField({ row, base, mode, onEdit }: FieldProps) {
  const id = rid(row.n, "date");
  const [text, setText] = useState(() => formatUkDate(row.input.dateCompleted));
  return (
    <div className="min-w-0">
      <Label id={id} mode={mode} n={row.n}>
        Date
      </Label>
      <input
        id={id}
        type="text"
        autoComplete="off"
        spellCheck={false}
        placeholder="dd/mm/yyyy"
        className={`input num ${mode === "hidden" ? "px-2.5" : ""}`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          onEdit(row.n, { dateCompleted: parseUkDate(e.target.value) ?? "" });
        }}
        onBlur={() => {
          const iso = parseUkDate(text);
          if (iso) setText(formatUkDate(iso));
        }}
        {...linkProps(row, "dateCompleted")}
      />
      <Confidence row={row} base={base} field="dateCompleted" confKey="dateCompleted" mode={mode} />
    </div>
  );
}

export function TitleField({ row, base, mode, onEdit }: FieldProps) {
  const id = rid(row.n, "title");
  return (
    <div className="min-w-0">
      <Label id={id} mode={mode} n={row.n}>
        Activity title
      </Label>
      <textarea
        id={id}
        rows={2}
        className={`textarea !min-h-0 py-2 [field-sizing:content] [overflow-wrap:anywhere] ${mode === "hidden" ? "px-2.5" : ""}`}
        value={row.input.title}
        onChange={(e) => onEdit(row.n, { title: e.target.value })}
        {...linkProps(row, "title")}
      />
      <Confidence row={row} base={base} field="title" confKey="title" mode={mode} />
    </div>
  );
}

export function HoursField({
  row,
  base,
  mode,
  onEdit,
  unreadable,
  onReadable,
}: FieldProps & {
  /** The text in the box cannot be read as hours. The message for it is shown with the row's other messages. */
  unreadable: boolean;
  onReadable: (n: number, readable: boolean) => void;
}) {
  const id = rid(row.n, "hours");
  const [text, setText] = useState(() => (row.input.hours > 0 ? formatHours(row.input.hours) : ""));
  const link = linkProps(row, "hours");
  return (
    <div className="min-w-0">
      <Label id={id} mode={mode} n={row.n}>
        Hours
      </Label>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        className={`input num ${mode === "hidden" ? "px-2.5" : ""}`}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const hours = readHoursText(e.target.value);
          onEdit(row.n, { hours: hours ?? 0 });
          onReadable(row.n, hours !== null);
        }}
        onBlur={() => {
          const h = readHoursText(text);
          if (h !== null && h > 0) setText(formatHours(h));
        }}
        {...link}
        {...(unreadable ? { "aria-invalid": true as const, "aria-describedby": issuesId(row.n) } : {})}
      />
      <Confidence row={row} base={base} field="hours" confKey="hours" mode={mode} />
    </div>
  );
}

/** ICE theme or IStructE category. The Custom log has neither. */
export function ThemeField({ row, base, mode, onEdit, profile }: FieldProps & { profile: ProfileId }) {
  if (profile === "ice") {
    const id = rid(row.n, "theme");
    const current = row.input.theme ?? "";
    const known = current === "" || ICE_ALL_THEMES.includes(current);
    return (
      <div className="min-w-0">
        <Label id={id} mode={mode} n={row.n}>
          ICE theme
        </Label>
        <select
          id={id}
          className={`select ${mode === "hidden" ? "px-2.5 text-sm" : ""}`}
          title={current || undefined}
          value={current}
          onChange={(e) => onEdit(row.n, { theme: e.target.value || null })}
          {...linkProps(row, "theme")}
        >
          <option value="">No theme chosen</option>
          <optgroup label="Mandatory themes">
            {PROFILES.ice.themes.mandatory.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </optgroup>
          <optgroup label="Other themes">
            {PROFILES.ice.themes.additional.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </optgroup>
          {!known && <option value={current}>{current} (not an ICE theme)</option>}
        </select>
        <Confidence row={row} base={base} field="theme" confKey="theme" mode={mode} />
      </div>
    );
  }
  if (profile === "istructe") {
    const id = rid(row.n, "category");
    const current = row.input.category ?? "";
    const known = current === "" || PROFILES.istructe.categories.includes(current);
    return (
      <div className="min-w-0">
        <Label id={id} mode={mode} n={row.n}>
          IStructE category
        </Label>
        <select
          id={id}
          className={`select ${mode === "hidden" ? "px-2.5 text-sm" : ""}`}
          title={current || undefined}
          value={current}
          onChange={(e) => onEdit(row.n, { category: e.target.value || null })}
          {...linkProps(row, "category")}
        >
          <option value="">No category chosen</option>
          {PROFILES.istructe.categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
          {!known && <option value={current}>{current} (not an IStructE category)</option>}
        </select>
        <Confidence row={row} base={base} field="category" confKey="category" mode={mode} />
      </div>
    );
  }
  return null;
}

/**
 * What is wrong with a row, each with an icon and words (never colour alone). Errors stop the row being imported;
 * warnings and duplicates do not. The list is a polite live region so a fix or a new problem is read out.
 */
export function IssueList({ row, flush = false, hoursUnreadable = false }: { row: ImportRow; flush?: boolean; hoursUnreadable?: boolean }) {
  // Hours text that cannot be read is sent as 0, and the check would then say "more than 0". Say what is wrong instead.
  const issues: ImportIssue[] = hoursUnreadable
    ? [{ severity: "error", field: "hours", message: UNREADABLE_HOURS_MESSAGE }, ...row.issues.filter((i) => !(i.field === "hours" && i.severity === "error"))]
    : row.issues;
  const needsScreenshotNote = row.fromScreenshot === true && !issues.some((i) => i.message === SCREENSHOT_NOTE);
  const any = issues.length > 0 || needsScreenshotNote;
  return (
    <div id={issuesId(row.n)} aria-live="polite" className="min-w-0">
      {any && (
        <ul className={flush ? "space-y-1.5" : "mt-2 space-y-1.5"}>
          {issues.map((issue, i) => {
            if (issue.field === "duplicate") {
              return (
                <li key={`d${i}`} className="flex items-start gap-2 text-sm">
                  <Copy aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-amber-ink" />
                  <span className="min-w-0">
                    <span className="sr-only">Check: </span>
                    <strong>{DUPLICATE_TEXT}</strong> <span className="text-muted">{duplicateDetail(issue.message)}</span>
                  </span>
                </li>
              );
            }
            const isError = issue.severity === "error";
            const Icon = isError ? CircleX : TriangleAlert;
            return (
              <li key={`${issue.field}-${i}`} className="flex items-start gap-2 text-sm">
                <Icon aria-hidden="true" size={18} className={`mt-0.5 shrink-0 ${isError ? "text-danger" : "text-amber-ink"}`} />
                <span className="min-w-0">
                  <span className="sr-only">{isError ? "Needs fixing: " : "Check: "}</span>
                  {issue.message}
                </span>
              </li>
            );
          })}
          {needsScreenshotNote && (
            <li className="flex items-start gap-2 text-sm">
              <TriangleAlert aria-hidden="true" size={18} className="mt-0.5 shrink-0 text-amber-ink" />
              <span className="min-w-0">
                <span className="sr-only">Check: </span>
                {SCREENSHOT_NOTE}
              </span>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}

/** Whether a row has anything to show in its details panel, and what the button should call it. */
export function detailsSummary(profile: ProfileId, customFields: readonly CustomFieldDef[]): string | null {
  if (profile === "ice") return "Learning points and benefits";
  if (profile === "istructe") return "Development gained and flags";
  return customFields.length > 0 ? "Your custom fields" : null;
}

export function DetailsToggle({
  row,
  expanded,
  onToggle,
  variant,
  summary,
}: {
  row: ImportRow;
  expanded: boolean;
  onToggle: (n: number) => void;
  variant: "table" | "card";
  summary: string;
}) {
  return (
    <button
      type="button"
      className="btn btn-quiet w-full justify-between !px-2"
      aria-expanded={expanded}
      aria-controls={expanded ? rid(row.n, "panel") : undefined}
      onClick={() => onToggle(row.n)}
    >
      <span className="min-w-0 text-left">
        {variant === "table" ? "Details" : summary}
        <span className="sr-only">
          {" "}
          for row {row.n}
          {variant === "table" ? ` (${summary.toLowerCase()})` : ""}
        </span>
      </span>
      <ChevronRight aria-hidden="true" size={18} strokeWidth={3} className={`shrink-0 ${expanded ? "rotate-90" : ""}`} />
    </button>
  );
}

function PanelText({
  row,
  part,
  label,
  value,
  rows,
  onChange,
  field,
}: {
  row: ImportRow;
  part: string;
  label: string;
  value: string;
  rows: number;
  onChange: (v: string) => void;
  field: string;
}) {
  const id = rid(row.n, part);
  return (
    <div className="min-w-0">
      <Label id={id} mode="visible" n={row.n}>
        {label}
      </Label>
      <textarea id={id} rows={rows} className="textarea !min-h-0 py-2" value={value} onChange={(e) => onChange(e.target.value)} {...linkProps(row, field)} />
    </div>
  );
}

function YesNoSelect({
  row,
  part,
  label,
  value,
  onChange,
}: {
  row: ImportRow;
  part: string;
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const id = rid(row.n, part);
  return (
    <div className="min-w-0">
      <Label id={id} mode="visible" n={row.n}>
        {label}
      </Label>
      <select
        id={id}
        className="select"
        value={value === null ? "" : value ? "yes" : "no"}
        onChange={(e) => onChange(e.target.value === "" ? null : e.target.value === "yes")}
      >
        <option value="">Not set</option>
        <option value="yes">Yes</option>
        <option value="no">No</option>
      </select>
    </div>
  );
}

/** The text fields that do not fit in the table: learning points and benefits, development gained, custom values. */
export function DetailsPanel({
  row,
  profile,
  customFields,
  planFromFile,
  onEdit,
}: {
  row: ImportRow;
  profile: ProfileId;
  customFields: readonly CustomFieldDef[];
  /** The file had a column for the development plan ref. When it did not, "unplanned" was put there by us. */
  planFromFile: boolean;
  onEdit: EditFn;
}) {
  const n = row.n;
  const input = row.input;
  const planFilledIn = !planFromFile && input.devPlanRef === DEFAULT_PLAN_REF;
  const planHintId = rid(n, "plan-hint");
  const planLink = linkProps(row, "devPlanRef");
  return (
    <div id={rid(n, "panel")} className="rounded-xl bg-bg p-4">
      {profile === "ice" && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <div className="min-w-0 space-y-3">
            <PanelText row={row} part="lp" field="learningPoints" label="Learning points" rows={4} value={input.learningPoints} onChange={(v) => onEdit(n, { learningPoints: v })} />
            <div className="min-w-0">
              <Label id={rid(n, "plan")} mode="visible" n={n}>
                Dev. plan ref
              </Label>
              <input
                id={rid(n, "plan")}
                type="text"
                className="input"
                value={input.devPlanRef}
                onChange={(e) => onEdit(n, { devPlanRef: e.target.value })}
                {...planLink}
                aria-describedby={[planFilledIn ? planHintId : null, planLink["aria-describedby"]].filter(Boolean).join(" ") || undefined}
              />
              {planFilledIn && (
                <p id={planHintId} className="hint mt-1">
                  Filled in by us because your file has no plan column. “unplanned” is the usual answer. Change it if this was in your development plan.
                </p>
              )}
            </div>
          </div>
          <fieldset className="min-w-0 space-y-3">
            <legend className="label">Benefits</legend>
            {PROFILES.ice.benefitPrompts.map((p) => (
              <PanelText
                key={p.key}
                row={row}
                part={`ben-${p.key}`}
                field="benefits"
                label={p.label}
                rows={2}
                value={input.benefits[p.key]}
                onChange={(v) => onEdit(n, { benefits: { ...input.benefits, [p.key]: v } })}
              />
            ))}
          </fieldset>
        </div>
      )}

      {profile === "istructe" && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <PanelText row={row} part="dg" field="developmentGained" label="Development gained" rows={4} value={input.developmentGained} onChange={(v) => onEdit(n, { developmentGained: v })} />
          <div className="min-w-0 space-y-3">
            <YesNoSelect row={row} part="ss" label="Structural safety" value={input.structuralSafety} onChange={(v) => onEdit(n, { structuralSafety: v })} />
            <YesNoSelect row={row} part="sus" label="Sustainability" value={input.sustainability} onChange={(v) => onEdit(n, { sustainability: v })} />
          </div>
        </div>
      )}

      {profile === "custom" && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {customFields.map((f) => {
            const id = rid(n, `custom-${f.key}`);
            const value = Object.hasOwn(input.custom, f.key) ? (input.custom[f.key] ?? "") : "";
            const set = (v: string) => onEdit(n, { custom: { ...input.custom, [f.key]: v } });
            return (
              <div key={f.key} className="min-w-0">
                <Label id={id} mode="visible" n={n}>
                  {f.label}
                </Label>
                {f.type === "yes_no" ? (
                  <select id={id} className="select" value={value} onChange={(e) => set(e.target.value)} {...linkProps(row, `custom.${f.key}`)}>
                    <option value="">Not set</option>
                    <option value="yes">Yes</option>
                    <option value="no">No</option>
                  </select>
                ) : (
                  <input
                    id={id}
                    type="text"
                    inputMode={f.type === "number" ? "decimal" : undefined}
                    className="input"
                    value={value}
                    onChange={(e) => set(e.target.value)}
                    {...linkProps(row, `custom.${f.key}`)}
                  />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
