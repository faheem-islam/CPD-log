"use client";

import { CircleAlert, FileDown, FilePlus2, Info, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { CheckCard } from "@/components/settings/check-card";
import { ProvisionalBadge } from "@/components/ui/badge";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { api, ApiClientError } from "@/lib/api/client";
import { formatHours } from "@/lib/dates";
import type { ExportPreview } from "@/lib/export/preview";
import type { ProfileId } from "@/lib/types";
import { downloadExportFile } from "./download";
import { PreviewSheet } from "./preview-sheet";

/** The logs the person keeps, with what the page needs to describe each one. */
export interface LogOption {
  id: ProfileId;
  label: string;
  fullName: string;
  provisional: boolean;
  /** Live entries in this log. */
  count: number;
}

export interface ExportViewProps {
  logs: LogOption[];
  /** Years that have entries, newest first. */
  years: number[];
  /** Entries in the logs the person keeps. */
  totalEntries: number;
  /** Entries in logs that are switched off in Settings. */
  hiddenEntries: number;
}

const WIDE_QUERY = "(min-width: 768px)";
function subscribeWide(cb: () => void) {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener("change", cb);
  return () => mq.removeEventListener("change", cb);
}
/** True from tablet width up. Only one of table and cards is ever in the page. */
function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => false,
  );
}

type Status = "loading" | "ready" | "error";

/** The export route accepts these years. An entry from outside them is still in the file when "All years" is chosen. */
const FIRST_YEAR = 1990;
const LAST_YEAR = 2200;

/** What the preview service said for one choice of logs and year. Kept with that choice so it is never shown under another. */
type Fetched = { key: string; previews: ExportPreview[]; error: null } | { key: string; previews: null; error: string };

type Download = { state: "idle" | "busy" | "done" | "error"; message: string };
const IDLE: Download = { state: "idle", message: "" };

function entriesWord(n: number): string {
  return n === 1 ? "1 entry" : `${n} entries`;
}

export function ExportView({ logs, years, totalEntries, hiddenEntries }: ExportViewProps) {
  const wide = useWide();
  const [selected, setSelected] = useState<ProfileId[]>(() => logs.map((l) => l.id));
  const [year, setYear] = useState<string>("all");
  const [fetched, setFetched] = useState<Fetched | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [download, setDownload] = useState<Download>(IDLE);

  // Always in the order the logs are listed, whatever order they were ticked in.
  const chosen = useMemo(() => logs.map((l) => l.id).filter((id) => selected.includes(id)), [logs, selected]);
  const chosenKey = chosen.join(",");
  const canPreview = totalEntries > 0 && chosen.length > 0;

  // The years the export route accepts. Anything earlier is only in the file for "All years".
  const pickable = useMemo(() => years.filter((y) => y >= FIRST_YEAR && y <= LAST_YEAR), [years]);
  const leftOut = years.length > pickable.length;

  useEffect(() => {
    if (!canPreview) return;
    const ctrl = new AbortController();
    const key = `${chosenKey}|${year}`;
    api<{ previews: ExportPreview[] }>("/api/export/preview", {
      json: { profiles: chosenKey.split(","), year: year === "all" ? "all" : Number(year) },
      signal: ctrl.signal,
    })
      .then((res) => setFetched({ key, previews: res.previews, error: null }))
      .catch((err: unknown) => {
        if (err instanceof DOMException && err.name === "AbortError") return;
        setFetched({
          key,
          previews: null,
          error: err instanceof ApiClientError ? err.message : "We couldn't build the preview. Try again.",
        });
      });
    return () => ctrl.abort();
  }, [canPreview, chosenKey, year, attempt]);

  // Only what was fetched for the choice on screen counts. While a new choice is loading, or if it failed, the numbers
  // from the earlier choice are not shown, so a total can never sit beside the wrong year.
  const current = fetched && fetched.key === `${chosenKey}|${year}` ? fetched : null;
  const status: Status = !canPreview ? "ready" : current === null ? "loading" : current.error === null ? "ready" : "error";
  const previews: ExportPreview[] | null = !canPreview ? [] : current?.previews ?? null;
  const error = current?.error ?? "";

  const rows = previews?.reduce((t, p) => t + p.count, 0) ?? 0;
  const hours = previews?.reduce((t, p) => t + p.totalHours, 0) ?? 0;
  const yearLabel = year === "all" ? "all" : year;

  // Why the button is off, in words. Null when it can be pressed.
  let whyOff: { text: string; waiting: boolean } | null = null;
  if (totalEntries === 0) whyOff = { text: "You have no entries to export yet. Add one and it will appear here.", waiting: false };
  else if (chosen.length === 0) whyOff = { text: "Tick at least one log to include in the file.", waiting: false };
  else if (status === "loading") whyOff = { text: "Updating the preview for your choice. You can download once it has finished.", waiting: true };
  else if (status === "ready" && previews && rows === 0)
    whyOff = {
      text: "None of the logs you ticked have entries for this year. Choose another year or tick another log.",
      waiting: false,
    };

  function toggle(id: ProfileId, on: boolean) {
    setDownload(IDLE);
    setSelected((cur) => (on ? [...new Set([...cur, id])] : cur.filter((x) => x !== id)));
  }

  async function onDownload(e: React.FormEvent<HTMLFormElement>) {
    // The page asks for the file itself, so a failure shows here instead of replacing the page with the server's reply.
    e.preventDefault();
    if (whyOff !== null || download.state === "busy") return;
    setDownload({ state: "busy", message: "Preparing your file…" });
    try {
      const { filename } = await downloadExportFile({ profiles: chosen, year: year === "all" ? "all" : Number(year) });
      setDownload({ state: "done", message: `Your file ${filename} has been downloaded. Look in your downloads folder.` });
    } catch (err) {
      setDownload({
        state: "error",
        message: err instanceof ApiClientError ? err.message : "We couldn't build the file. Try again in a moment.",
      });
    }
  }

  const announce =
    status === "ready" && previews && previews.length > 0
      ? `Preview updated. ${previews.length} ${previews.length === 1 ? "sheet" : "sheets"}, ${rows} ${rows === 1 ? "row" : "rows"}, ${formatHours(hours)} hours.`
      : "";

  return (
    <>
      <section aria-labelledby="choose-heading">
        {/* The choices sit outside the download form on purpose: pressing Enter on a tick box or the year must not start a download. */}
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] lg:items-start xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
          <div className="band min-w-0 space-y-6">
            <div>
              <h2 id="choose-heading">What goes in the file</h2>
              <p className="mt-1 text-base text-muted">Each log you tick becomes its own sheet in the Excel file.</p>
            </div>

            <fieldset className="min-w-0">
              <legend className="label">Logs to include</legend>
              <div className="space-y-2">
                {logs.map((l) => (
                  <CheckCard
                    key={l.id}
                    title={l.label}
                    checked={selected.includes(l.id)}
                    onChange={(on) => toggle(l.id, on)}
                    badge={l.provisional ? <ProvisionalBadge /> : undefined}
                    description={
                      <>
                        {l.fullName} · <span className="num">{entriesWord(l.count)}</span>
                      </>
                    }
                  />
                ))}
              </div>
              {hiddenEntries > 0 && (
                <p className="hint mt-2">
                  {entriesWord(hiddenEntries)} {hiddenEntries === 1 ? "is" : "are"} in a log you have switched off. Switch it on in{" "}
                  <Link href="/settings">Settings</Link> to export it.
                </p>
              )}
            </fieldset>

            <div className="max-w-xs">
              <label htmlFor="export-year" className="label">
                Year
              </label>
              <select
                id="export-year"
                className="select"
                value={year}
                onChange={(e) => {
                  setDownload(IDLE);
                  setYear(e.target.value);
                }}
                aria-describedby="export-year-hint"
              >
                <option value="all">All years</option>
                {pickable.map((y) => (
                  <option key={y} value={String(y)}>
                    {y}
                  </option>
                ))}
              </select>
              <p id="export-year-hint" className="hint mt-1">
                The year each entry was completed.
                {leftOut && ` Entries from before ${FIRST_YEAR} are only in the file when you choose All years.`}
              </p>
            </div>
          </div>

          <div className="band-2 min-w-0 space-y-4 lg:sticky lg:top-6">
            <h2 className="sr-only">Download</h2>
            <p className="eyebrow">Your file</p>
            {totalEntries > 0 && (
              <>
                {status === "ready" ? (
                  <p className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
                    <span className="flex items-baseline gap-1.5">
                      <span className="big-num text-3xl">{rows}</span>
                      <span className="text-base text-muted">{rows === 1 ? "row" : "rows"}</span>
                    </span>
                    <span className="flex items-baseline gap-1.5">
                      <span className="big-num text-3xl">{formatHours(hours)}</span>
                      <span className="text-base text-muted">{hours === 1 ? "hour" : "hours"}</span>
                    </span>
                  </p>
                ) : status === "loading" ? (
                  <Skeleton className="h-12 w-3/4" />
                ) : (
                  <p className="text-base">The totals are not available because the preview did not load. The reason is shown under “What the file will contain”.</p>
                )}
                <p className="text-sm text-muted">
                  {chosen.length === 1 ? "1 sheet" : `${chosen.length} sheets`} · {year === "all" ? "all years" : year}
                  {status === "ready" ? ". Check the preview, then download." : "."}
                </p>
              </>
            )}
            {/* Without script this form posts the default choice (every log, every year) and the browser saves the file. */}
            <form method="post" action="/api/export" onSubmit={onDownload} className="space-y-3">
              {chosen.map((id) => (
                <input key={id} type="hidden" name="profiles" value={id} />
              ))}
              <input type="hidden" name="year" value={year} />
              <button
                type="submit"
                className="btn btn-primary w-full whitespace-nowrap"
                disabled={whyOff !== null}
                aria-disabled={download.state === "busy" || undefined}
                aria-describedby={whyOff ? "download-why" : undefined}
              >
                <FileDown aria-hidden="true" size={20} className="shrink-0" />
                Download Excel file
              </button>
            </form>
            <div role="status" aria-live="polite">
              {whyOff && (
                <p id="download-why" className="flex items-start gap-2 text-sm font-bold">
                  {whyOff.waiting ? (
                    <Info aria-hidden="true" size={18} className="mt-0.5 shrink-0" />
                  ) : (
                    <CircleAlert aria-hidden="true" size={18} className="mt-0.5 shrink-0" />
                  )}
                  <span className="min-w-0">{whyOff.text}</span>
                </p>
              )}
              {(download.state === "busy" || download.state === "done") && <p className="text-sm font-bold">{download.message}</p>}
            </div>
            {download.state === "error" && (
              <p className="notice notice-error flex items-start gap-2 text-sm font-bold" role="alert">
                <CircleAlert aria-hidden="true" size={18} className="mt-0.5 shrink-0" />
                <span className="min-w-0">{download.message}</span>
              </p>
            )}
          </div>
        </div>
      </section>

      <section aria-labelledby="preview-heading" className="space-y-4">
        <div>
          <h2 id="preview-heading">What the file will contain</h2>
          <p className="mt-1 max-w-2xl text-base text-muted">
            This is built the same way as the download, so the sheets, columns, order and rows match the spreadsheet. Long text is shortened
            on screen, but the file has every word.
          </p>
        </div>
        <p className="sr-only" role="status">
          {announce}
        </p>

        {totalEntries === 0 ? (
          <EmptyState hiddenEntries={hiddenEntries} />
        ) : chosen.length === 0 ? (
          <p className="band-2 text-base">No logs are ticked, so there is nothing to preview. Tick a log above.</p>
        ) : status === "error" ? (
          <div className="notice notice-error space-y-3" role="alert">
            <p className="font-bold">{error}</p>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setFetched(null);
                setAttempt((n) => n + 1);
              }}
            >
              <RefreshCw aria-hidden="true" size={18} />
              Try again
            </button>
          </div>
        ) : previews === null ? (
          <LoadingRegion label="Building the preview">
            <div className="space-y-3">
              <Skeleton className="h-10 w-2/3" />
              <Skeleton className="h-40 w-full" />
            </div>
          </LoadingRegion>
        ) : (
          <div className="space-y-4">
            {previews.map((p) => (
              <PreviewSheet key={p.profile} preview={p} yearLabel={yearLabel} wide={wide} />
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function EmptyState({ hiddenEntries }: { hiddenEntries: number }) {
  return (
    <div className="band-2 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h3>{hiddenEntries > 0 ? "Your entries are in logs you have switched off" : "Nothing to export yet"}</h3>
        <p className="max-w-xl text-base text-muted">
          {hiddenEntries > 0
            ? "Switch a log back on in Settings and its entries will be listed here."
            : "Once you have saved an entry, you can download your log as an Excel file from this page."}
        </p>
      </div>
      {hiddenEntries > 0 ? (
        <Link href="/settings" className="btn btn-secondary">
          Open Settings
        </Link>
      ) : (
        <Link href="/add" className="btn btn-primary">
          <FilePlus2 aria-hidden="true" size={20} />
          Add your first entry
        </Link>
      )}
    </div>
  );
}
