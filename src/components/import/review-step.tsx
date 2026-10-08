"use client";

import { CircleX, Info, RotateCcw, TriangleAlert } from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ProvisionalBadge } from "@/components/ui/badge";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/api/client";
import type { ImportResult, ImportRow } from "@/lib/import/types";
import type { CustomFieldDef, EntryInput, ProfileId } from "@/lib/types";
import { controlForIssue, hasError, hasProblem, mappedLabel, rowsLabel } from "./helpers";
import { RowCards, RowTable } from "./row-views";
import { useWideContainer } from "./use-wide";

/** Below this width the list is cards. The table needs room for its fixed columns and a usable title column. */
const TABLE_MIN_WIDTH = 880;
const CHECK_DELAY_MS = 450;

/** True when a note names a column heading as a whole word or phrase, not as part of a longer word. */
function mentions(note: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "i").test(note);
}

interface ReviewProps {
  profile: ProfileId;
  logLabel: string;
  provisional: boolean;
  fileName: string;
  result: ImportResult;
  customFields: CustomFieldDef[];
  onRestart: () => void;
}

/**
 * Takes the server's re-check of the rows and lays it over what is on screen now. The person's own text is never
 * replaced (so the cursor and focus stay put); only the messages, the duplicate flag and the tick boxes come back.
 * A tick the person made while the check was running wins. A row they ticked while it had an error stays ticked, so
 * the import stays blocked until they fix it or untick it, rather than the row quietly unticking itself. A row they
 * unticked by hand (`leftOut`) stays unticked: the server ticks a row again once its error is fixed, but that is only
 * right for a row the server or the file left out, never for one the person chose to leave out.
 */
function mergeChecked(current: ImportRow[], sent: ImportRow[], checked: ImportRow[], leftOut: ReadonlySet<number>): ImportRow[] {
  if (checked.length !== sent.length) return current;
  return current.map((cur, i) => {
    const snap = sent[i];
    const srv = checked[i];
    if (!snap || !srv || snap.n !== srv.n || cur.n !== snap.n) return cur;
    let include = srv.include;
    if (cur.include !== snap.include) include = cur.include;
    else if (leftOut.has(cur.n)) include = false;
    else if (snap.include && hasError(snap.issues) && hasError(srv.issues)) include = true;
    return { ...cur, include, issues: srv.issues, duplicate: srv.duplicate, parseWarnings: srv.parseWarnings };
  });
}

export function ReviewStep({ profile, logLabel, provisional, fileName, result, customFields, onRestart }: ReviewProps) {
  const router = useRouter();
  const { toast } = useToast();
  const { ref: listRef, wide } = useWideContainer(TABLE_MIN_WIDTH);

  const [rows, setRows] = useState<ImportRow[]>(result.rows);
  const baseline = useMemo(() => new Map(result.rows.map((r) => [r.n, r] as const)), [result]);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const [editVersion, setEditVersion] = useState(0);
  const [checkedVersion, setCheckedVersion] = useState(0);
  const [checkProblem, setCheckProblem] = useState(false);
  const [changed, setChanged] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState<string | null>(null);
  const [askRestart, setAskRestart] = useState(false);
  const [onlyProblems, setOnlyProblems] = useState(false);
  const [unreadableHours, setUnreadableHours] = useState<ReadonlySet<number>>(() => new Set());
  /** Rows the person has worked on while only problem rows are shown. They stay in the list until the filter changes. */
  const [touched, setTouched] = useState<ReadonlySet<number>>(() => new Set());

  const headingRef = useRef<HTMLHeadingElement>(null);
  const rowsRef = useRef(rows);
  const abortRef = useRef<AbortController | null>(null);
  const seqRef = useRef(0);
  const pendingFocus = useRef<string | null>(null);
  /** Rows the person unticked by hand. The re-check must not tick them again. */
  const leftOutRef = useRef<Set<number>>(new Set());

  const customLabels = useMemo(() => new Map(customFields.map((f) => [f.key, f.label] as const)), [customFields]);

  // The review is a new screen: put focus on its heading so a keyboard or screen reader user starts at the top.
  useEffect(() => {
    headingRef.current?.focus();
  }, []);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  // After a jump-to-row opens a panel, focus the control once it exists.
  useEffect(() => {
    const id = pendingFocus.current;
    if (!id) return;
    const el = document.getElementById(id);
    if (!el) return;
    pendingFocus.current = null;
    el.scrollIntoView({ block: "center" });
    el.focus({ preventScroll: true });
  });

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const runCheck = useCallback(
    async (version: number) => {
      const sent = rowsRef.current;
      const seq = ++seqRef.current;
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        const res = await api<{ rows: ImportRow[] }>("/api/import/revalidate", { json: { profile, rows: sent }, signal: ctrl.signal });
        if (seq !== seqRef.current) return;
        setRows((cur) => mergeChecked(cur, sent, res.rows, leftOutRef.current));
        setCheckProblem(false);
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (seq !== seqRef.current) return;
        setCheckProblem(true);
      }
      if (seq === seqRef.current) setCheckedVersion(version);
    },
    [profile],
  );

  // Re-check a moment after the last edit, not on every key.
  useEffect(() => {
    if (editVersion === 0) return;
    const t = window.setTimeout(() => void runCheck(editVersion), CHECK_DELAY_MS);
    return () => window.clearTimeout(t);
  }, [editVersion, runCheck]);

  const touch = useCallback((n: number) => setTouched((cur) => (cur.has(n) ? cur : new Set(cur).add(n))), []);

  const onEdit = useCallback(
    (n: number, patch: Partial<EntryInput>) => {
      touch(n);
      setRows((cur) => cur.map((r) => (r.n === n ? { ...r, input: { ...r.input, ...patch } } : r)));
      setEditVersion((v) => v + 1);
      setChanged(true);
    },
    [touch],
  );

  const onToggle = useCallback(
    (n: number, include: boolean) => {
      touch(n);
      if (include) leftOutRef.current.delete(n);
      else leftOutRef.current.add(n);
      setRows((cur) => cur.map((r) => (r.n === n ? { ...r, include } : r)));
      setChanged(true);
    },
    [touch],
  );

  const onExpand = useCallback((n: number) => {
    setExpanded((cur) => {
      const next = new Set(cur);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });
  }, []);

  const onHoursReadable = useCallback((n: number, readable: boolean) => {
    setUnreadableHours((cur) => {
      if (cur.has(n) === !readable) return cur;
      const next = new Set(cur);
      if (readable) next.delete(n);
      else next.add(n);
      return next;
    });
  }, []);

  const tickAll = useCallback(() => {
    leftOutRef.current = new Set();
    setRows((cur) => cur.map((r) => ({ ...r, include: !hasError(r.issues) && !r.duplicate })));
    setChanged(true);
  }, []);
  const untickAll = useCallback(() => {
    leftOutRef.current = new Set(rowsRef.current.map((r) => r.n));
    setRows((cur) => cur.map((r) => ({ ...r, include: false })));
    setChanged(true);
  }, []);

  // Leaving or reloading the page mid-review would throw the edits away, so the browser is asked to confirm first.
  useEffect(() => {
    if (!changed || committing) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [changed, committing]);

  const stats = useMemo(() => {
    const blocking: number[] = [];
    let ready = 0;
    let errorsLeftOut = 0;
    let duplicatesLeftOut = 0;
    let otherLeftOut = 0;
    for (const r of rows) {
      const bad = hasError(r.issues);
      if (r.include) {
        if (bad) blocking.push(r.n);
        else ready += 1;
      } else if (bad) errorsLeftOut += 1;
      else if (r.duplicate) duplicatesLeftOut += 1;
      else otherLeftOut += 1;
    }
    return { ready, blocking, errorsLeftOut, duplicatesLeftOut, otherLeftOut };
  }, [rows]);

  const checking = editVersion !== checkedVersion;
  const firstBlocking = stats.blocking[0];

  // On a phone a long file is a very long page, so the list can be cut down to the rows that need a decision. A row
  // stays in the list while it is being worked on, even once its problem is gone, so it does not vanish from under the
  // person's thumb.
  const problemCount = useMemo(() => rows.reduce((total, r) => (hasProblem(r) ? total + 1 : total), 0), [rows]);
  const visibleRows = useMemo(
    () => (onlyProblems ? rows.filter((r) => hasProblem(r) || touched.has(r.n)) : rows),
    [rows, onlyProblems, touched],
  );
  const showFilter = rows.length > 5 && (problemCount > 0 || onlyProblems);

  const goToRow = useCallback((n: number) => {
    const row = rowsRef.current.find((r) => r.n === n);
    if (!row) return;
    const target = controlForIssue(row);
    if (target.needsPanel) {
      setExpanded((cur) => new Set(cur).add(n));
      pendingFocus.current = target.id;
      return;
    }
    const el = document.getElementById(target.id) ?? document.getElementById(`import-row-${n}`);
    if (!el) return;
    el.scrollIntoView({ block: "center" });
    el.focus({ preventScroll: true });
  }, []);

  async function commit() {
    if (committing) return;
    setCommitting(true);
    setCommitError(null);
    try {
      const send = rows.filter((r) => r.include);
      const res = await api<{ created: number }>("/api/import/commit", { json: { profile, rows: send } });
      const created = typeof res?.created === "number" ? res.created : send.length;
      toast({ message: created === 1 ? "Imported 1 entry" : `Imported ${created} entries`, tone: "ok" });
      router.push("/log");
    } catch (err) {
      setCommitError(err instanceof ApiClientError ? err.message : "The import did not finish. Nothing was saved. Try again.");
      setCommitting(false);
    }
  }

  const canImport = stats.ready > 0 && stats.blocking.length === 0 && !checking && !committing;
  const importLabel = `Import ${stats.ready} ${stats.ready === 1 ? "row" : "rows"}`;

  let status: string;
  if (committing) status = "Importing…";
  else if (checking) status = "Checking your changes…";
  else if (stats.blocking.length > 0) status = `${rowsLabel(stats.blocking.length)} you included still ${stats.blocking.length === 1 ? "needs" : "need"} fixing.`;
  else if (stats.ready === 0) status = "No rows are ticked yet.";
  else status = `${rowsLabel(stats.ready)} will go into your ${logLabel} log.`;

  const isScreenshot = result.fileKind === "screenshot";
  // A column the file notes already name (for example one that belongs to another log) is not listed twice.
  const leftOut = result.unmapped.filter((h) => h.length < 3 || !result.warnings.some((w) => mentions(w, h)));
  const planFromFile = Object.hasOwn(result.mapped, "devPlanRef");
  const listProps = { rows: visibleRows, baseline, expanded, profile, customFields, planFromFile, unreadableHours, onEdit, onToggle, onExpand, onHoursReadable };

  return (
    <div className="space-y-4">
      <section aria-labelledby="review-heading" className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
        <div className="band min-w-0 space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1 basis-[16rem]">
              <h2 id="review-heading" ref={headingRef} tabIndex={-1} className="focus:outline-none">
                Check your rows
              </h2>
              <p className="mt-1 text-base text-muted">
                {rowsLabel(rows.length)} read from <strong className="text-ink [overflow-wrap:anywhere]">{fileName}</strong>. Ticked rows go into your {logLabel} log.{" "}
                {provisional && <ProvisionalBadge />}
              </p>
              {/* On a phone the import button is far down a long list, so the way there is on show. On a large screen the bar is pinned in view, and the link only appears for the keyboard. */}
              <a
                href="#import-bar"
                className="inline-flex min-h-tap items-center font-bold lg:sr-only lg:focus:not-sr-only"
                onClick={(e) => {
                  e.preventDefault();
                  const bar = document.getElementById("import-bar");
                  bar?.scrollIntoView({ block: "center" });
                  bar?.focus({ preventScroll: true });
                }}
              >
                Go to the import button
              </a>
            </div>
            <button
              type="button"
              className="btn btn-quiet -ml-3 sm:ml-0"
              onClick={() => (changed ? setAskRestart(true) : onRestart())}
            >
              <RotateCcw aria-hidden="true" size={18} />
              Choose a different file
            </button>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div role="status" aria-live="polite" className="min-w-0 space-y-1">
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="big-num" aria-hidden="true">
                  {stats.ready}
                </span>
                <span className="text-lg font-bold">{stats.ready === 1 ? "row will be imported" : "rows will be imported"}</span>
              </p>
              {(stats.errorsLeftOut > 0 || stats.duplicatesLeftOut > 0 || stats.otherLeftOut > 0) && (
                <ul className="text-base text-muted">
                  {stats.errorsLeftOut > 0 && (
                    <li>
                      {rowsLabel(stats.errorsLeftOut)} {stats.errorsLeftOut === 1 ? "has" : "have"} a problem and {stats.errorsLeftOut === 1 ? "is" : "are"} left out until you fix {stats.errorsLeftOut === 1 ? "it" : "them"}.
                    </li>
                  )}
                  {stats.duplicatesLeftOut > 0 && (
                    <li>
                      {rowsLabel(stats.duplicatesLeftOut)} {stats.duplicatesLeftOut === 1 ? "looks" : "look"} like {stats.duplicatesLeftOut === 1 ? "a duplicate" : "duplicates"} and {stats.duplicatesLeftOut === 1 ? "is" : "are"} left out.
                    </li>
                  )}
                  {stats.otherLeftOut > 0 && <li>{rowsLabel(stats.otherLeftOut)} you left out.</li>}
                </ul>
              )}
            </div>
            <div className="-ml-3 flex flex-wrap gap-x-1 gap-y-1 sm:ml-0">
              <button type="button" className="btn btn-quiet" onClick={tickAll}>
                Tick all rows that can be imported
              </button>
              <button type="button" className="btn btn-quiet" onClick={untickAll}>
                Untick all rows
              </button>
            </div>
          </div>

          {showFilter && (
            <div>
              <label className="inline-flex min-h-tap cursor-pointer items-center gap-3 text-base">
                <input
                  type="checkbox"
                  className="h-6 w-6 shrink-0 cursor-pointer accent-[rgb(var(--link))]"
                  checked={onlyProblems}
                  onChange={(e) => {
                    setOnlyProblems(e.target.checked);
                    setTouched(new Set());
                  }}
                />
                <span>
                  Show only rows with{" "}
                  <span className="whitespace-nowrap">
                    a problem <span className="num text-muted">({problemCount})</span>
                  </span>
                </span>
              </label>
              <p role="status" className="sr-only">
                {onlyProblems ? `Showing ${visibleRows.length} of ${rowsLabel(rows.length)}.` : ""}
              </p>
            </div>
          )}

          {firstBlocking !== undefined && (
            <div className="notice notice-error flex items-start gap-3" role="alert">
              <CircleX aria-hidden="true" size={22} className="mt-0.5 shrink-0 text-danger" />
              <div className="min-w-0">
                <p className="font-bold">
                  {stats.blocking.length === 1
                    ? "1 row you included needs fixing before you can import"
                    : `${stats.blocking.length} rows you included need fixing before you can import`}
                </p>
                <p>Fix the problem shown on the row, or untick the row to leave it out.</p>
                <p className="mt-2">
                  <button type="button" className="btn btn-secondary" onClick={() => goToRow(firstBlocking)}>
                    Go to row {firstBlocking}
                  </button>
                </p>
              </div>
            </div>
          )}

        </div>

        <section aria-labelledby="notes-heading" className="band-2 min-w-0 space-y-3">
          <h2 id="notes-heading" className="text-lg">
            About this file
          </h2>
          <ul className="space-y-2 text-base">
            {isScreenshot ? (
              <li className="flex items-start gap-2">
                <TriangleAlert aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-amber-ink" />
                <span className="min-w-0">Read from a screenshot by the AI feature. Text can be misread, so check every field in every row.</span>
              </li>
            ) : (
              <li className="flex items-start gap-2">
                <Info aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-link" />
                <span className="min-w-0">Your column headings were read from row {result.headerRow}.</span>
              </li>
            )}
            {result.warnings.map((w, i) => (
              <li key={i} className="flex items-start gap-2">
                <TriangleAlert aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-amber-ink" />
                <span className="min-w-0">{w}</span>
              </li>
            ))}
            {leftOut.length > 0 && (
              <li className="flex items-start gap-2">
                <Info aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-link" />
                <span className="min-w-0">
                  Columns left out because they don't fit your {logLabel} log: <strong>{leftOut.join(", ")}</strong>.
                </span>
              </li>
            )}
          </ul>
          {Object.keys(result.mapped).length > 0 && (
            <details className="text-base">
              <summary className="inline-flex min-h-tap cursor-pointer items-center font-bold text-link">How your columns were read</summary>
              <dl className="mt-1 grid grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] gap-x-3 gap-y-1 text-sm">
                {Object.entries(result.mapped).map(([field, header]) => (
                  <div key={field} className="contents">
                    <dt className="font-bold">{mappedLabel(field, customLabels)}</dt>
                    <dd className="text-muted [overflow-wrap:anywhere]">from “{header}”</dd>
                  </div>
                ))}
              </dl>
            </details>
          )}
        </section>
      </section>

      {checkProblem && (
        <p className="notice notice-warn flex items-start gap-2" role="status">
          <TriangleAlert aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-amber-ink" />
          <span>We couldn't re-check your last change, so some messages on the rows may be out of date. Your edits are kept, and every row is checked again when you import.</span>
        </p>
      )}

      <div ref={listRef}>
        {onlyProblems && visibleRows.length === 0 ? (
          <p className="band text-base">No rows have a problem right now. Untick “Show only rows with a problem” to see every row.</p>
        ) : wide ? (
          <RowTable {...listProps} />
        ) : (
          <RowCards {...listProps} />
        )}
      </div>

      <section id="import-bar" tabIndex={-1} aria-label="Finish the import" className="rounded-2xl bg-surface-2 px-4 py-3 lg:sticky lg:bottom-3 lg:z-20">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-6">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-1">
              <p id="import-status" className="font-bold" aria-live="polite">
                {status}
              </p>
              {firstBlocking !== undefined && !committing && !checking && (
                <button type="button" className="btn btn-quiet -ml-3 sm:ml-0" onClick={() => goToRow(firstBlocking)}>
                  Show row {firstBlocking} to fix
                </button>
              )}
            </div>
            <p className="hint">By importing, you confirm the hours in the rows you included are the time you actually spent learning.</p>
          </div>
          <button
            type="button"
            className="btn btn-save w-full md:w-auto md:shrink-0"
            disabled={!canImport}
            aria-describedby="import-status"
            aria-busy={committing || undefined}
            onClick={() => void commit()}
          >
            {importLabel}
          </button>
        </div>
        {commitError && (
          <p className="notice notice-error mt-3 flex items-start gap-2" role="alert">
            <CircleX aria-hidden="true" size={20} className="mt-0.5 shrink-0 text-danger" />
            <span className="min-w-0">{commitError}</span>
          </p>
        )}
      </section>

      <Dialog open={askRestart} onClose={() => setAskRestart(false)} title="Throw away your changes?">
        <p className="text-base">You have changed rows on this screen. If you choose a different file, those changes are lost. Nothing has been imported.</p>
        <div className="mt-5 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <button type="button" className="btn btn-secondary" onClick={() => setAskRestart(false)}>
            Keep checking rows
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              setAskRestart(false);
              onRestart();
            }}
          >
            Throw away changes
          </button>
        </div>
      </Dialog>
    </div>
  );
}

