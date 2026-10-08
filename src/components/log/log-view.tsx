"use client";

import { useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/toast";
import { api, ApiClientError } from "@/lib/api/client";
import type { EntryResponse } from "@/lib/api/types";
import { formatHours } from "@/lib/dates";
import type { CustomFieldDef, Entry, EntryInput } from "@/lib/types";
import { EditEntryForm } from "./edit-entry-form";
import { NoEntries, NoMatches } from "./empty-states";
import {
  DEFAULT_QUERY,
  FIRST_DIR,
  SORT_OPTIONS,
  activeFilterCount,
  entriesWord,
  filterEntries,
  hoursWord,
  parseQuery,
  searchHaystack,
  serialiseQuery,
  shortTitle,
  sortEntries,
  sortValue,
  themeChoices,
  toLogEntry,
  totalHours,
  yearChoices,
  type LogEntry,
  type LogQuery,
  type SortKey,
} from "./log-filters";
import { LogCards } from "./log-cards";
import { LogTable } from "./log-table";
import { LogToolbar } from "./log-toolbar";
import { useLogLayout } from "./use-layout";
import type { ClickInfo, RowActions } from "./row-parts";

export interface LogViewProps {
  entries: LogEntry[];
  customFields: CustomFieldDef[];
  /** Today in the UK, for the "this date hasn't happened yet" hint in the edit form. */
  todayIso: string;
  /** The query string the page was opened with, without the "?". */
  initialQuery: string;
}

interface FocusRequest {
  /** The row whose Edit button should take focus. */
  rowId: string | null;
  /** The control to prefer, if it is still on screen. */
  el: HTMLElement | null;
  n: number;
}

function isShown(el: Element | null): el is HTMLElement {
  return el instanceof HTMLElement && el.isConnected && el.getClientRects().length > 0;
}

/** Edit buttons exist in both the table and the cards. Only one set is on screen, so take the shown one. */
function shownEditButton(rowId: string): HTMLElement | null {
  const found = document.querySelectorAll(`[data-row="${CSS.escape(rowId)}"] [data-action="edit"]`);
  for (const el of Array.from(found)) if (isShown(el)) return el as HTMLElement;
  return null;
}

function applyPatch(entry: LogEntry, patch: Partial<EntryInput>): LogEntry {
  // Changing the hours is the person confirming them (the server does the same).
  return { ...entry, ...patch, ...("hours" in patch ? { hoursConfirmed: true } : {}) } as LogEntry;
}

/** How long the Undo button stays on screen. */
const UNDO_WINDOW_MS = 10_000;

/**
 * A tap this soon after a delete, in the same place, is the second half of a double-tap. The row has already
 * gone and the next one has slid under the finger, so it must not delete that one too.
 */
const REPEAT_DELETE_MS = 250;
const REPEAT_DELETE_PX = 40;

function Num({ children }: { children: React.ReactNode }) {
  return <strong className="num font-display text-2xl font-extrabold leading-none">{children}</strong>;
}

/**
 * The whole Log page below the header: search, filters, sortable table (desktop) or cards (phone and
 * tablet), and the edit, delete and undo actions. Filters live in the URL so Back and refresh keep them.
 * Edits and deletes show at once and are put back with a plain message if the server says no.
 */
export function LogView({ entries: initialEntries, customFields, todayIso, initialQuery }: LogViewProps) {
  const { toast } = useToast();
  const layout = useLogLayout();
  const [entries, setEntries] = useState<LogEntry[]>(initialEntries);
  const [query, setQuery] = useState<LogQuery>(() => parseQuery(new URLSearchParams(initialQuery)));
  const [filtersOpen, setFiltersOpen] = useState(() => {
    const q = parseQuery(new URLSearchParams(initialQuery));
    return Boolean(q.year || q.log || q.theme || q.type || sortValue(q) !== sortValue(DEFAULT_QUERY));
  });
  const [editing, setEditing] = useState<LogEntry | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [focusReq, setFocusReq] = useState<FocusRequest | null>(null);
  // The staggered rise belongs to the page load only. It is switched off after it has played, so a list
  // that later empties (or comes back) never animates again.
  const [intro, setIntro] = useState(true);

  const searchRef = useRef<HTMLInputElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);
  const editingIdRef = useRef<string | null>(null);
  const focusCount = useRef(0);
  const restoring = useRef(new Set<string>());
  /** The last entry deleted, so Control+Z can bring it back while the Undo button is still on offer. */
  const lastDeleted = useRef<{ entry: LogEntry; until: number } | null>(null);
  /** When and where the last Delete was pressed. */
  const lastDeleteClick = useRef<{ at: number; x: number; y: number } | null>(null);
  const queryRef = useRef(query);
  const visibleRef = useRef<LogEntry[]>([]);
  const pendingUrls = useRef(new Set<string>());
  const firstSort = useRef(true);

  useEffect(() => {
    const t = setTimeout(() => setIntro(false), 1500);
    return () => clearTimeout(t);
  }, []);

  // ---- What is on screen --------------------------------------------------------------------

  const haystacks = useMemo(() => new Map(entries.map((e) => [e.id, searchHaystack(e)])), [entries]);
  const visible = useMemo(
    () => sortEntries(filterEntries(entries, query, haystacks), query.sort, query.dir),
    [entries, query, haystacks],
  );
  const years = useMemo(() => yearChoices(entries, query.year), [entries, query.year]);
  const themes = useMemo(() => themeChoices(entries, query.theme), [entries, query.theme]);
  const hours = useMemo(() => totalHours(visible), [visible]);
  const filterCount = activeFilterCount(query);

  useEffect(() => {
    queryRef.current = query;
    visibleRef.current = visible;
  });

  // ---- The URL ------------------------------------------------------------------------------

  const searchParams = useSearchParams();
  const urlKey = searchParams.toString();

  // The page to the address bar. Replaces, never pushes, so Back still leaves the page.
  useEffect(() => {
    const key = serialiseQuery(query);
    if (key === serialiseQuery(parseQuery(new URLSearchParams(window.location.search)))) return;
    const t = setTimeout(() => {
      pendingUrls.current.add(key);
      window.history.replaceState(null, "", `${window.location.pathname}${key ? `?${key}` : ""}`);
    }, 200);
    return () => clearTimeout(t);
  }, [query]);

  // The address bar to the page, for a change that came from outside (a link to /log, or Forward).
  useEffect(() => {
    if (pendingUrls.current.delete(urlKey)) return;
    const next = parseQuery(searchParams);
    if (serialiseQuery(next) !== serialiseQuery(queryRef.current)) {
      pendingUrls.current.clear();
      setQuery(next);
    }
    // searchParams is read through urlKey, which changes whenever it does.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlKey]);

  // ---- Search, filter, sort -----------------------------------------------------------------

  const change = useCallback((patch: Partial<LogQuery>) => setQuery((q) => ({ ...q, ...patch })), []);

  const clearFilters = useCallback(() => {
    setQuery((q) => ({ ...DEFAULT_QUERY, sort: q.sort, dir: q.dir }));
    searchRef.current?.focus();
  }, []);

  const onSort = useCallback((column: SortKey) => {
    setQuery((q) => (q.sort === column ? { ...q, dir: q.dir === "asc" ? "desc" : "asc" } : { ...q, sort: column, dir: FIRST_DIR[column] }));
  }, []);

  // Say how the list is ordered when that changes, not on first load.
  useEffect(() => {
    if (firstSort.current) {
      firstSort.current = false;
      return;
    }
    const label = SORT_OPTIONS.find((o) => o.value === sortValue(query))?.label;
    setNote(label ? `Sorted by ${label.charAt(0).toLowerCase()}${label.slice(1)}.` : "");
  }, [query.sort, query.dir]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- Focus ---------------------------------------------------------------------------------

  const requestFocus = useCallback((rowId: string | null, el: HTMLElement | null = null) => {
    focusCount.current += 1;
    setFocusReq({ rowId, el, n: focusCount.current });
  }, []);

  useEffect(() => {
    if (!focusReq) return;
    const target =
      (isShown(focusReq.el) ? focusReq.el : null) ??
      (focusReq.rowId ? shownEditButton(focusReq.rowId) : null) ??
      document.getElementById("log-results") ??
      document.getElementById("log-empty");
    target?.focus();
    setFocusReq(null);
  }, [focusReq]);

  // ---- Edit ----------------------------------------------------------------------------------

  const closeEdit = useCallback(() => {
    if (editingIdRef.current === null) return;
    const id = editingIdRef.current;
    editingIdRef.current = null;
    setEditing(null);
    setSaveError(null);
    requestFocus(id, openerRef.current);
    openerRef.current = null;
  }, [requestFocus]);

  const openEdit = useCallback((entry: LogEntry, trigger: HTMLElement) => {
    openerRef.current = trigger;
    editingIdRef.current = entry.id;
    setSaveError(null);
    setEditing(entry);
  }, []);

  const saveEdit = useCallback(
    async (entry: LogEntry, patch: Partial<EntryInput>) => {
      if (Object.keys(patch).length === 0) {
        toast({ message: "No changes to save." });
        closeEdit();
        return;
      }
      setSaving(true);
      setSaveError(null);
      setEntries((list) => list.map((e) => (e.id === entry.id ? applyPatch(e, patch) : e)));
      try {
        const res = await api<EntryResponse>(`/api/entries/${encodeURIComponent(entry.id)}`, {
          method: "PATCH",
          json: { patch, aiReviewed: false },
        });
        const saved = toLogEntry(res.entry);
        setEntries((list) => list.map((e) => (e.id === saved.id ? saved : e)));
        toast({ tone: "ok", message: `Saved changes to “${shortTitle(saved.title)}”.` });
        closeEdit();
      } catch (err) {
        setEntries((list) => list.map((e) => (e.id === entry.id ? entry : e)));
        const detail = err instanceof ApiClientError ? err.message : "Something went wrong.";
        const message = `${detail} Your changes weren't saved, and the entry is as it was.`;
        if (editingIdRef.current === entry.id) setSaveError(message);
        else toast({ tone: "error", message: `“${shortTitle(entry.title)}”: ${message}` });
      } finally {
        setSaving(false);
      }
    },
    [closeEdit, toast],
  );

  // ---- Delete and undo -----------------------------------------------------------------------

  const restoreEntry = useCallback(
    async (entry: LogEntry): Promise<void> => {
      if (restoring.current.has(entry.id)) return;
      restoring.current.add(entry.id);
      setEntries((list) => (list.some((e) => e.id === entry.id) ? list : [...list, entry]));
      requestFocus(entry.id);
      try {
        const res = await api<{ entry: Entry }>(`/api/entries/${encodeURIComponent(entry.id)}/restore`, { method: "POST" });
        const back = toLogEntry(res.entry);
        setEntries((list) => list.map((e) => (e.id === back.id ? back : e)));
        toast({ tone: "ok", message: `Put “${shortTitle(entry.title)}” back in your log.` });
      } catch (err) {
        setEntries((list) => list.filter((e) => e.id !== entry.id));
        const detail = err instanceof ApiClientError ? err.message : "Something went wrong.";
        toast({
          tone: "error",
          message: `We couldn't bring back “${shortTitle(entry.title)}”. ${detail} It is still deleted.`,
          action: { label: "Try again", onClick: () => restoreEntry(entry) },
        });
      } finally {
        restoring.current.delete(entry.id);
      }
    },
    [requestFocus, toast],
  );

  const deleteEntry = useCallback(
    async (entry: LogEntry) => {
      // After the row goes, focus moves to the row that takes its place.
      const list = visibleRef.current;
      const at = list.findIndex((e) => e.id === entry.id);
      const neighbour = at >= 0 ? (list[at + 1] ?? list[at - 1]) : undefined;
      setEntries((all) => all.filter((e) => e.id !== entry.id));
      requestFocus(neighbour?.id ?? null);
      try {
        await api<{ entry: Entry }>(`/api/entries/${encodeURIComponent(entry.id)}`, { method: "DELETE" });
      } catch (err) {
        if (err instanceof ApiClientError && err.code === "not_found") {
          toast({ message: `“${shortTitle(entry.title)}” was already gone from your log.` });
          return;
        }
        setEntries((all) => (all.some((e) => e.id === entry.id) ? all : [...all, entry]));
        requestFocus(entry.id);
        const detail = err instanceof ApiClientError ? err.message : "Something went wrong.";
        toast({ tone: "error", message: `We couldn't delete “${shortTitle(entry.title)}”. ${detail} It is still in your log.` });
        return;
      }
      lastDeleted.current = { entry, until: Date.now() + UNDO_WINDOW_MS };
      const hint = "To undo, press Control Z, or use the Undo button in the notifications at the end of the page.";
      setNote(hint);
      setTimeout(() => setNote((n) => (n === hint ? "" : n)), UNDO_WINDOW_MS);
      toast({
        message: `Deleted “${shortTitle(entry.title)}”.`,
        action: {
          label: "Undo",
          onClick: () => {
            lastDeleted.current = null;
            return restoreEntry(entry);
          },
        },
        durationMs: UNDO_WINDOW_MS,
      });
    },
    [requestFocus, restoreEntry, toast],
  );

  // Control+Z (Command+Z on a Mac) puts back the last deleted entry, for people who cannot reach the Undo button easily.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
      const t = e.target;
      if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const last = lastDeleted.current;
      if (!last || editingIdRef.current !== null || Date.now() > last.until) return;
      e.preventDefault();
      lastDeleted.current = null;
      void restoreEntry(last.entry);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [restoreEntry]);

  const onDelete = useCallback(
    (entry: LogEntry, _trigger: HTMLElement, click: ClickInfo) => {
      const now = Date.now();
      const last = lastDeleteClick.current;
      // The second click of a double-click. Browsers count it (detail 2); touch screens may not, so a tap in the same spot right after a delete counts too.
      const repeat =
        click.detail > 1 ||
        (click.detail > 0 && last !== null && now - last.at < REPEAT_DELETE_MS && Math.hypot(click.x - last.x, click.y - last.y) < REPEAT_DELETE_PX);
      if (repeat) return;
      lastDeleteClick.current = { at: now, x: click.x, y: click.y };
      void deleteEntry(entry);
    },
    [deleteEntry],
  );
  const actions: RowActions = useMemo(() => ({ onEdit: openEdit, onDelete }), [openEdit, onDelete]);

  const others = useMemo(
    () => (editing ? entries.filter((e) => e.id !== editing.id).map((e) => ({ id: e.id, dateCompleted: e.dateCompleted, hours: e.hours })) : []),
    [entries, editing],
  );
  const settings = useMemo(() => ({ customFields }), [customFields]);

  // ---- Render --------------------------------------------------------------------------------

  const dialog = (
    <Dialog open={editing !== null} onClose={closeEdit} title="Edit entry">
      {editing && (
        <EditEntryForm
          key={editing.id}
          entry={editing}
          settings={settings}
          others={others}
          todayIso={todayIso}
          saving={saving}
          error={saveError}
          onSave={(patch) => void saveEdit(editing, patch)}
          onCancel={closeEdit}
        />
      )}
    </Dialog>
  );

  if (entries.length === 0) {
    return (
      <>
        <div className={intro ? "reveal" : undefined}>
          <NoEntries />
        </div>
        {dialog}
      </>
    );
  }

  const filtered = filterCount > 0;
  return (
    <>
      <div className={`space-y-4 ${intro ? "reveal" : ""}`}>
        <LogToolbar
          query={query}
          years={years}
          themes={themes}
          filtersOpen={filtersOpen}
          resultCount={visible.length}
          onToggleFilters={() => setFiltersOpen((v) => !v)}
          onChange={change}
          searchRef={searchRef}
        />

        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <p aria-live="polite" aria-atomic="true" className="text-base">
            {filtered ? (
              <>
                <Num>{visible.length}</Num> of <Num>{entries.length}</Num> {entriesWord(entries.length)} shown
              </>
            ) : (
              <>
                <Num>{visible.length}</Num> {entriesWord(visible.length)}
              </>
            )}
            <span aria-hidden="true" className="px-2 text-muted">
              ·
            </span>
            <span className="sr-only">, </span>
            <Num>{formatHours(hours)}</Num> {hoursWord(hours)}
          </p>
          {filtered && visible.length > 0 && (
            <button type="button" className="btn btn-quiet -ml-3 sm:ml-0" onClick={clearFilters}>
              Clear filters
            </button>
          )}
          <p className="sr-only" aria-live="polite">
            {note}
          </p>
        </div>

        <div id="log-results" tabIndex={-1} className="min-w-0 outline-none">
          <h2 className="sr-only">Your entries</h2>
          {visible.length === 0 ? (
            <NoMatches query={query.q} onClear={clearFilters} />
          ) : (
            <>
              {layout !== "table" && <LogCards entries={visible} actions={actions} />}
              {layout !== "cards" && <LogTable entries={visible} sort={query.sort} dir={query.dir} onSort={onSort} actions={actions} />}
            </>
          )}
        </div>
      </div>
      {dialog}
    </>
  );
}
