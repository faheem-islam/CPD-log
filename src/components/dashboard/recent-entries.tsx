import Link from "next/link";
import { formatHours, formatUkDate } from "@/lib/dates";
import { profileLabel } from "@/lib/profiles";
import type { ProfileId } from "@/lib/types";

/** Only what the list needs, so nothing else about an entry travels to the page. */
export interface RecentEntry {
  id: string;
  title: string;
  dateCompleted: string;
  hours: number;
  profile: ProfileId;
}

/**
 * The latest entries as a list. On a phone each one is a small stacked card (title first, then date,
 * log and hours); from tablet width up it is a single aligned row.
 */
export function RecentEntries({ entries }: { entries: RecentEntry[] }) {
  return (
    <section aria-labelledby="recent-heading">
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-1">
        <h2 id="recent-heading">Recent entries</h2>
        <Link href="/log" className="inline-flex min-h-tap items-center font-bold">
          See the whole log
        </Link>
      </div>

      {entries.length === 0 ? (
        <p className="band-2 mt-2 text-base">
          No entries in the logs you have switched on. Entries in other logs are in the whole log.
        </p>
      ) : (
        <ul className="mt-2 space-y-2" aria-label="Latest entries">
          {entries.map((e) => (
            <li
              key={e.id}
              className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-xl bg-surface px-4 py-3 md:grid-cols-[7rem_minmax(0,1fr)_auto_5rem] md:gap-x-5"
            >
              <p className="col-span-3 col-start-1 row-start-1 min-w-0 font-bold [overflow-wrap:anywhere] md:col-span-1 md:col-start-2">
                <span className="line-clamp-2">{e.title}</span>
              </p>
              <time
                dateTime={e.dateCompleted}
                className="num col-start-1 row-start-2 text-sm text-muted md:row-start-1 md:text-base"
              >
                {formatUkDate(e.dateCompleted)}
              </time>
              <span className="badge badge-info col-start-2 row-start-2 justify-self-start md:col-start-3 md:row-start-1">
                {profileLabel(e.profile)}
              </span>
              <span className="num col-start-3 row-start-2 text-right text-base font-bold md:col-start-4 md:row-start-1">
                {formatHours(e.hours)}
                <span className="sr-only"> hours</span>
                <span aria-hidden="true" className="font-normal text-muted">
                  {" "}
                  h
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
