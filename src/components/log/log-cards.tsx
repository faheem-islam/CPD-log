"use client";

import { memo } from "react";
import { hoursWord, type LogEntry } from "./log-filters";
import { AiBadge, EntryDate, EntryTitle, LogBadge, RowButtons, ThemeText, type RowActions } from "./row-parts";
import { formatHours } from "@/lib/dates";

/**
 * One entry as a card. On a phone the order is what you look for first: when, which log, the title,
 * who ran it, the theme, then the hours with Edit and Delete in a strip along the bottom. From tablet
 * width the hours and buttons sit in a column on the right.
 */
const Card = memo(function Card({ entry, actions }: { entry: LogEntry; actions: RowActions }) {
  return (
    <li data-row={entry.id} className="rounded-2xl bg-surface p-4 md:grid md:grid-cols-[minmax(0,1fr)_auto] md:gap-x-8 md:p-5">
      <div className="min-w-0 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <EntryDate entry={entry} className="text-sm text-muted" />
          <LogBadge profile={entry.profile} />
          {entry.aiAssisted && <AiBadge />}
        </div>
        <p className="text-base leading-snug">
          <EntryTitle entry={entry} />
        </p>
        {entry.provider && <p className="text-sm text-muted">{entry.provider}</p>}
        <p className="text-sm">
          <ThemeText entry={entry} />
        </p>
      </div>
      <div className="-mx-4 -mb-4 mt-3 flex items-center justify-between gap-2 rounded-b-2xl bg-surface-2/70 px-4 py-1 md:m-0 md:flex-col md:items-end md:justify-between md:rounded-none md:bg-transparent md:p-0">
        <p className="num">
          <span className="font-display text-2xl font-extrabold leading-none">{formatHours(entry.hours)}</span>{" "}
          <span className="text-sm text-muted">{hoursWord(entry.hours)}</span>
        </p>
        <RowButtons entry={entry} actions={actions} withText />
      </div>
    </li>
  );
});

/** Phones and tablets: a list of cards. The desktop table (LogTable) takes over from the xl breakpoint. */
export function LogCards({ entries, actions }: { entries: readonly LogEntry[]; actions: RowActions }) {
  return (
    <ul className="space-y-3 xl:hidden" aria-label="Your CPD entries">
      {entries.map((e) => (
        <Card key={e.id} entry={e} actions={actions} />
      ))}
    </ul>
  );
}
