import { CalendarClock, Info, Video } from "lucide-react";

/**
 * For buttons that move between steps. The second click of a double-click lands on the next step's button
 * (it sits in the same place), so it would skip a whole step. A repeat click counts for nothing.
 */
export function ignoreRepeat(action: () => void) {
  return (e: React.MouseEvent) => {
    if (e.detail > 1) return;
    action();
  };
}

/** The row of buttons under a step. DOM order is visual order: the one primary action first, then quiet ones. */
export function StepActions({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-2 pt-1 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-4">{children}</div>;
}

/** Which resource is being logged. Phones only: wide screens show the side panel instead. */
export function SourceStrip({ title }: { title: string }) {
  const t = title.trim();
  if (!t) return null;
  return (
    <p className="rounded-xl bg-surface-2 px-4 py-2 text-sm lg:hidden">
      <span className="font-bold">Logging: </span>
      <span className="line-clamp-2 [overflow-wrap:anywhere]">{t}</span>
    </p>
  );
}

export function UpcomingNotice() {
  return (
    <p className="notice notice-warn flex gap-2">
      <CalendarClock aria-hidden="true" size={20} className="mt-0.5 shrink-0" />
      <span className="min-w-0">This event hasn't happened yet. Log it after you've attended.</span>
    </p>
  );
}

export function RecordingNotice() {
  return (
    <p className="notice notice-info flex gap-2">
      <Video aria-hidden="true" size={20} className="mt-0.5 shrink-0" />
      <span className="min-w-0">This looks like a recording rather than the live session. Log the time you actually spend watching it.</span>
    </p>
  );
}

export function PageNotes({ notes }: { notes: readonly string[] }) {
  if (notes.length === 0) return null;
  return (
    <div className="notice notice-info">
      <p className="flex items-center gap-2 font-bold">
        <Info aria-hidden="true" size={20} />
        About this page
      </p>
      <ul className="mt-1 list-disc space-y-1 pl-6">
        {notes.map((n) => (
          <li key={n}>{n}</li>
        ))}
      </ul>
    </div>
  );
}
