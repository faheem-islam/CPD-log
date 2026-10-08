import { FilePlus2, FileUp, Link2 } from "lucide-react";
import Link from "next/link";

/** The log has nothing in it at all. Points to the two quick ways to start, and to doing it by hand. */
export function NoEntries() {
  return (
    <section id="log-empty" tabIndex={-1} aria-labelledby="log-empty-heading" className="band-2 lg:grid lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:gap-10 !p-6 sm:!p-8">
      <div className="min-w-0">
        <h2 id="log-empty-heading">Nothing in your log yet</h2>
        <p className="mt-2 max-w-prose text-base">
          Paste a link to a talk, article or course and CPD Logger reads it and fills in what it can. You check every detail and confirm your hours before anything is saved.
        </p>
        <div className="mt-5 flex flex-wrap gap-3">
          <Link href="/dashboard" className="btn btn-primary">
            <Link2 aria-hidden="true" size={20} />
            Paste a link on the dashboard
          </Link>
        </div>
      </div>
      <div className="mt-6 min-w-0 space-y-3 lg:mt-0">
        <p className="eyebrow">Other ways to start</p>
        <p className="text-base">
          <Link href="/import" className="inline-flex min-h-tap items-center gap-2 font-bold">
            <FileUp aria-hidden="true" size={19} />
            Import from a spreadsheet
          </Link>
          <span className="block text-sm text-muted">Bring in rows you already keep in Excel or a CSV file, and check them before they are added.</span>
        </p>
        <p className="text-base">
          <Link href="/add" className="inline-flex min-h-tap items-center gap-2 font-bold">
            <FilePlus2 aria-hidden="true" size={19} />
            Fill in an entry by hand
          </Link>
          <span className="block text-sm text-muted">No link needed. Type in what you did and how long it took.</span>
        </p>
      </div>
    </section>
  );
}

/** Entries exist but none match what was typed or chosen. The clear button is the one the page already has. */
export function NoMatches({ query, onClear }: { query: string; onClear: () => void }) {
  const words = query.trim();
  return (
    <section aria-labelledby="log-nomatch-heading" className="band-2 !p-6 sm:!p-8">
      <h2 id="log-nomatch-heading">No entries match</h2>
      <p className="mt-2 max-w-prose text-base">
        {words ? (
          <>
            Nothing in your log fits <strong>“{words}”</strong> with the filters you have chosen.
          </>
        ) : (
          <>Nothing in your log fits the filters you have chosen.</>
        )}{" "}
        Try a shorter word, check the spelling, or clear the filters to see everything again.
      </p>
      <div className="mt-4">
        <button type="button" className="btn btn-primary" onClick={onClear}>
          Clear filters
        </button>
      </div>
    </section>
  );
}
