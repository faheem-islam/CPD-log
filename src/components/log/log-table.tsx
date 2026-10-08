"use client";

import { ArrowDown, ArrowUp, ChevronsUpDown } from "lucide-react";
import { memo } from "react";
import type { LogEntry, SortDir, SortKey } from "./log-filters";
import { AiBadge, EntryDate, EntryTitle, HoursText, LogBadge, RowButtons, ThemeText, type RowActions } from "./row-parts";

const SORT_LABEL: Record<SortKey, string> = { date: "Date", title: "Title", hours: "Hours", theme: "Theme" };

function SortHeader({
  column,
  sort,
  dir,
  onSort,
  align = "left",
  className = "",
}: {
  column: SortKey;
  sort: SortKey;
  dir: SortDir;
  onSort: (column: SortKey) => void;
  align?: "left" | "right";
  className?: string;
}) {
  const active = sort === column;
  const Icon = !active ? ChevronsUpDown : dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th scope="col" aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : undefined} className={`!py-1 ${align === "right" ? "!text-right" : ""} ${className}`}>
      <button
        type="button"
        onClick={() => onSort(column)}
        className={`-mx-2 inline-flex min-h-tap items-center gap-1 rounded-lg px-2 uppercase tracking-wide hover:bg-ink/5 ${active ? "text-ink" : ""} ${align === "right" ? "flex-row-reverse" : ""}`}
      >
        {SORT_LABEL[column]}
        <Icon aria-hidden="true" size={15} strokeWidth={active ? 3 : 2} className={active ? "" : "opacity-60"} />
      </button>
    </th>
  );
}

const Row = memo(function Row({ entry, actions }: { entry: LogEntry; actions: RowActions }) {
  return (
    <tr data-row={entry.id}>
      <td className="whitespace-nowrap">
        <EntryDate entry={entry} />
      </td>
      <th scope="row" className="!whitespace-normal !bg-transparent !px-3 !py-3 !text-left !align-top !text-base !font-normal !normal-case !tracking-normal !text-ink">
        <EntryTitle entry={entry} className="text-base" />
        {entry.provider && <span className="mt-0.5 block text-sm text-muted">{entry.provider}</span>}
        {entry.aiAssisted && (
          <span className="mt-1.5 block">
            <AiBadge />
          </span>
        )}
      </th>
      <td>
        <LogBadge profile={entry.profile} />
      </td>
      <td className="text-base">
        <ThemeText entry={entry} />
      </td>
      <td className="text-right text-base font-bold">
        <HoursText hours={entry.hours} />
      </td>
      <td className="!px-1 text-right align-top">
        <div className="flex justify-end">
          <RowButtons entry={entry} actions={actions} withText={false} />
        </div>
      </td>
    </tr>
  );
});

/** The desktop table. Phones and tablets get LogCards instead. */
export function LogTable({
  entries,
  sort,
  dir,
  onSort,
  actions,
}: {
  entries: readonly LogEntry[];
  sort: SortKey;
  dir: SortDir;
  onSort: (column: SortKey) => void;
  actions: RowActions;
}) {
  return (
    <div className="table-wrap hidden xl:block">
      <table className="data-table table-fixed">
        <caption className="sr-only">Your CPD entries. Use the column headings to change the order.</caption>
        <colgroup>
          <col className="w-[7rem]" />
          <col />
          <col className="w-[6rem]" />
          <col className="w-[12rem]" />
          <col className="w-[5rem]" />
          <col className="w-[6.25rem]" />
        </colgroup>
        <thead>
          <tr>
            <SortHeader column="date" sort={sort} dir={dir} onSort={onSort} />
            <SortHeader column="title" sort={sort} dir={dir} onSort={onSort} />
            <th scope="col">Log</th>
            <SortHeader column="theme" sort={sort} dir={dir} onSort={onSort} />
            <SortHeader column="hours" sort={sort} dir={dir} onSort={onSort} align="right" />
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <Row key={e.id} entry={e} actions={actions} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
