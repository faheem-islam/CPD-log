"use client";

import { memo } from "react";
import type { ImportRow } from "@/lib/import/types";
import type { CustomFieldDef, ProfileId } from "@/lib/types";
import { hasError } from "./helpers";
import {
  DateField,
  DetailsPanel,
  DetailsToggle,
  HoursField,
  IncludeBox,
  IssueList,
  ThemeField,
  TitleField,
  detailsSummary,
  type EditFn,
} from "./row-parts";

export interface RowListProps {
  rows: readonly ImportRow[];
  baseline: ReadonlyMap<number, ImportRow>;
  expanded: ReadonlySet<number>;
  profile: ProfileId;
  customFields: readonly CustomFieldDef[];
  /** Whether the file had its own column for the development plan ref. */
  planFromFile: boolean;
  /** Rows whose hours box holds text that cannot be read as hours. */
  unreadableHours: ReadonlySet<number>;
  onEdit: EditFn;
  onToggle: (n: number, include: boolean) => void;
  onExpand: (n: number) => void;
  onHoursReadable: (n: number, readable: boolean) => void;
}

/** A ticked row with a problem is red-tinted, a row left out sits back on the page colour, the rest are white. */
function tone(row: ImportRow): string {
  if (row.include && hasError(row.issues)) return "bg-danger/10";
  if (!row.include) return "bg-surface-2/60";
  return "bg-surface";
}

interface RowProps {
  row: ImportRow;
  base: ImportRow | undefined;
  expanded: boolean;
  profile: ProfileId;
  customFields: readonly CustomFieldDef[];
  planFromFile: boolean;
  unreadable: boolean;
  onEdit: EditFn;
  onToggle: (n: number, include: boolean) => void;
  onExpand: (n: number) => void;
  onHoursReadable: (n: number, readable: boolean) => void;
}

const TableRow = memo(function TableRow({ row, base, expanded, profile, customFields, planFromFile, unreadable, onEdit, onToggle, onExpand, onHoursReadable }: RowProps) {
  const summary = detailsSummary(profile, customFields);
  const hasTheme = profile !== "custom";
  const columns = 5 + (hasTheme ? 1 : 0) + (summary ? 1 : 0);
  const hasMessages = row.issues.length > 0 || row.fromScreenshot === true || unreadable;
  return (
    <tbody id={`import-row-${row.n}`} tabIndex={-1} className={`${tone(row)} scroll-mt-24 [&>tr:last-child>*]:border-b-2 [&>tr:last-child>*]:border-bg`}>
      <tr className="align-top">
        <td className="px-1 py-2">
          <IncludeBox row={row} onToggle={onToggle} variant="table" />
        </td>
        <th scope="row" className="px-1 py-4 text-left font-display text-lg font-bold num">
          {row.n}
        </th>
        <td className="px-2 py-2">
          <DateField row={row} base={base} mode="hidden" onEdit={onEdit} />
        </td>
        <td className="px-2 py-2">
          <TitleField row={row} base={base} mode="hidden" onEdit={onEdit} />
        </td>
        <td className="px-1.5 py-2">
          <HoursField row={row} base={base} mode="hidden" onEdit={onEdit} unreadable={unreadable} onReadable={onHoursReadable} />
        </td>
        {hasTheme && (
          <td className="px-2 py-2">
            <ThemeField row={row} base={base} mode="hidden" onEdit={onEdit} profile={profile} />
          </td>
        )}
        {summary && (
          <td className="px-1 py-2">
            <DetailsToggle row={row} expanded={expanded} onToggle={onExpand} variant="table" summary={summary} />
          </td>
        )}
      </tr>
      <tr>
        <td colSpan={columns} className={hasMessages ? "pb-3 pl-[8.25rem] pr-3" : "p-0"}>
          <IssueList row={row} flush hoursUnreadable={unreadable} />
        </td>
      </tr>
      {expanded && summary && (
        <tr>
          <td colSpan={columns} className="px-3 pb-4 pt-0">
            <DetailsPanel row={row} profile={profile} customFields={customFields} planFromFile={planFromFile} onEdit={onEdit} />
          </td>
        </tr>
      )}
    </tbody>
  );
});

/** Desktop: one table, one body per row. Every cell is a real form control, so Tab walks it left to right. */
export function RowTable({ rows, baseline, expanded, profile, customFields, planFromFile, unreadableHours, onEdit, onToggle, onExpand, onHoursReadable }: RowListProps) {
  const summary = detailsSummary(profile, customFields);
  const hasTheme = profile !== "custom";
  return (
    <div className="overflow-x-auto rounded-2xl bg-surface">
      <table className="w-full min-w-[52rem] table-fixed text-left text-sm">
        <caption className="sr-only">
          Rows read from your file. Each row has editable fields and a tick box to include it in the import.
        </caption>
        <colgroup>
          <col className="w-[4.5rem]" />
          <col className="w-14" />
          <col className="w-36" />
          <col />
          <col className="w-28" />
          {hasTheme && <col className="w-52" />}
          {summary && <col className="w-28" />}
        </colgroup>
        <thead>
          <tr className="bg-surface-2 text-xs uppercase tracking-wide text-muted">
            <th scope="col" className="px-1 py-3 text-center font-bold">
              Include
            </th>
            <th scope="col" className="px-1 py-3 font-bold">
              Row
            </th>
            <th scope="col" className="px-2 py-3 font-bold">
              Date
            </th>
            <th scope="col" className="px-2 py-3 font-bold">
              Activity
            </th>
            <th scope="col" className="px-2 py-3 font-bold">
              Hours
            </th>
            {hasTheme && (
              <th scope="col" className="px-2 py-3 font-bold">
                {profile === "ice" ? "Theme" : "Category"}
              </th>
            )}
            {summary && (
              <th scope="col" className="px-2 py-3 font-bold">
                More
              </th>
            )}
          </tr>
        </thead>
        {rows.map((row) => (
          <TableRow
            key={row.n}
            row={row}
            base={baseline.get(row.n)}
            expanded={expanded.has(row.n)}
            profile={profile}
            customFields={customFields}
            planFromFile={planFromFile}
            unreadable={unreadableHours.has(row.n)}
            onEdit={onEdit}
            onToggle={onToggle}
            onExpand={onExpand}
            onHoursReadable={onHoursReadable}
          />
        ))}
      </table>
    </div>
  );
}

const CardRow = memo(function CardRow({ row, base, expanded, profile, customFields, planFromFile, unreadable, onEdit, onToggle, onExpand, onHoursReadable }: RowProps) {
  const summary = detailsSummary(profile, customFields);
  return (
    <li id={`import-row-${row.n}`} tabIndex={-1} className={`${tone(row)} min-w-0 scroll-mt-4 rounded-2xl p-4`}>
      <IncludeBox row={row} onToggle={onToggle} variant="card" />
      <div className="mt-2 grid grid-cols-2 gap-3">
        <DateField row={row} base={base} mode="visible" onEdit={onEdit} />
        <HoursField row={row} base={base} mode="visible" onEdit={onEdit} unreadable={unreadable} onReadable={onHoursReadable} />
      </div>
      <div className="mt-3">
        <TitleField row={row} base={base} mode="visible" onEdit={onEdit} />
      </div>
      {profile !== "custom" && (
        <div className="mt-3">
          <ThemeField row={row} base={base} mode="visible" onEdit={onEdit} profile={profile} />
        </div>
      )}
      <IssueList row={row} hoursUnreadable={unreadable} />
      {summary && (
        <div className="mt-2">
          <DetailsToggle row={row} expanded={expanded} onToggle={onExpand} variant="card" summary={summary} />
          {expanded && (
            <div className="mt-2">
              <DetailsPanel row={row} profile={profile} customFields={customFields} planFromFile={planFromFile} onEdit={onEdit} />
            </div>
          )}
        </div>
      )}
    </li>
  );
});

/** Phone: one card per row, in the same order, with the same controls stacked. */
export function RowCards({ rows, baseline, expanded, profile, customFields, planFromFile, unreadableHours, onEdit, onToggle, onExpand, onHoursReadable }: RowListProps) {
  return (
    <ul className="space-y-3" aria-label="Rows read from your file">
      {rows.map((row) => (
        <CardRow
          key={row.n}
          row={row}
          base={baseline.get(row.n)}
          expanded={expanded.has(row.n)}
          profile={profile}
          customFields={customFields}
          planFromFile={planFromFile}
          unreadable={unreadableHours.has(row.n)}
          onEdit={onEdit}
          onToggle={onToggle}
          onExpand={onExpand}
          onHoursReadable={onHoursReadable}
        />
      ))}
    </ul>
  );
}
