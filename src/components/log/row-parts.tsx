import { ExternalLink, Pencil, Sparkles, Trash2 } from "lucide-react";
import { formatHours, formatUkDate } from "@/lib/dates";
import { profileLabel } from "@/lib/profiles";
import { entryTheme, hoursWord, safeHref, type LogEntry } from "./log-filters";

/** Where and how a button was pressed. Delete uses it to tell the second click of a double-click from a new one. */
export interface ClickInfo {
  /** 1 for a single click, 2 for the second click of a double-click, 0 when a keyboard pressed the button. */
  detail: number;
  x: number;
  y: number;
}

/** What a row can do. Both take the button that was pressed so focus can come back to it. */
export interface RowActions {
  onEdit: (entry: LogEntry, trigger: HTMLElement) => void;
  onDelete: (entry: LogEntry, trigger: HTMLElement, click: ClickInfo) => void;
}

/** The title, as a link to the resource when there is one. The link opens in a new tab and says so. */
export function EntryTitle({ entry, className = "" }: { entry: Pick<LogEntry, "title" | "url">; className?: string }) {
  const href = safeHref(entry.url);
  if (!href) return <span className={`font-bold [overflow-wrap:anywhere] ${className}`}>{entry.title}</span>;
  // The new-tab icon stays with the last word so it is never left alone on a line. A very long unbroken word is left free to wrap.
  const cut = entry.title.lastIndexOf(" ") + 1;
  const last = entry.title.slice(cut);
  const keepTogether = cut > 0 && last.length > 0 && last.length <= 24;
  const icon = <ExternalLink aria-hidden="true" size={15} strokeWidth={2.5} className="ml-1 inline-block align-[-2px]" />;
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`font-bold [overflow-wrap:anywhere] ${className}`}>
      {keepTogether ? (
        <>
          {entry.title.slice(0, cut)}
          <span className="whitespace-nowrap">
            {last}
            {icon}
          </span>
        </>
      ) : (
        <>
          {entry.title}
          {icon}
        </>
      )}
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}

export function LogBadge({ profile }: { profile: LogEntry["profile"] }) {
  return <span className="badge badge-info">{profileLabel(profile)}</span>;
}

/** Shown only when AI wrote some of the text. Words plus an icon, never colour alone. */
export function AiBadge() {
  return (
    <span className="badge badge-warn">
      <Sparkles aria-hidden="true" size={13} strokeWidth={2.75} />
      AI-assisted
    </span>
  );
}

/** The date, with the last day underneath when the activity ran over several days. */
export function EntryDate({ entry, className = "" }: { entry: Pick<LogEntry, "dateCompleted" | "dateEnd">; className?: string }) {
  return (
    <span className={`num ${className}`}>
      <time dateTime={entry.dateCompleted}>{formatUkDate(entry.dateCompleted)}</time>
      {entry.dateEnd && (
        <>
          <span className="sr-only"> to </span>
          <span aria-hidden="true" className="block text-xs text-muted">
            to
          </span>
          <time dateTime={entry.dateEnd} className="block text-sm text-muted">
            {formatUkDate(entry.dateEnd)}
          </time>
        </>
      )}
    </span>
  );
}

/** ICE theme or IStructE category, or a plain dash for entries that have neither. */
export function ThemeText({ entry, className = "" }: { entry: Pick<LogEntry, "theme" | "category">; className?: string }) {
  const t = entryTheme(entry);
  if (!t) {
    return (
      <span className={`text-muted ${className}`}>
        <span aria-hidden="true">–</span>
        <span className="sr-only">No theme</span>
      </span>
    );
  }
  return <span className={className}>{t}</span>;
}

export function HoursText({ hours, className = "" }: { hours: number; className?: string }) {
  return (
    <span className={`num ${className}`}>
      {formatHours(hours)}
      <span className="sr-only"> {hoursWord(hours)}</span>
    </span>
  );
}

/**
 * Edit and Delete for one row. The name carries the title ("Edit <title>") so a list of them makes sense
 * to someone using a screen reader. `withText` shows the word next to the icon (phones and tablets).
 */
export function RowButtons({ entry, actions, withText }: { entry: LogEntry; actions: RowActions; withText: boolean }) {
  const pad = withText ? "" : "!px-2";
  return (
    <div className="flex items-center gap-1">
      <button
        type="button"
        className={`btn btn-quiet ${pad}`}
        data-action="edit"
        aria-label={`Edit ${entry.title}`}
        onClick={(e) => actions.onEdit(entry, e.currentTarget)}
      >
        <Pencil aria-hidden="true" size={19} />
        {withText && <span aria-hidden="true">Edit</span>}
      </button>
      <button
        type="button"
        className={`btn btn-quiet !text-danger ${pad}`}
        data-action="delete"
        aria-label={`Delete ${entry.title}`}
        onClick={(e) => actions.onDelete(entry, e.currentTarget, { detail: e.detail, x: e.clientX, y: e.clientY })}
      >
        <Trash2 aria-hidden="true" size={19} />
        {withText && <span aria-hidden="true">Delete</span>}
      </button>
    </div>
  );
}
