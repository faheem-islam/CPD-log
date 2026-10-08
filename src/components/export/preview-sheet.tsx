"use client";

import { ArrowRight, Info, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ProvisionalBadge } from "@/components/ui/badge";
import { formatHours } from "@/lib/dates";
import type { ExportPreview } from "@/lib/export/preview";

/** Rows drawn for each sheet. The file always has every row. */
export const PREVIEW_ROW_LIMIT = 50;
/** On a phone each row is a tall card, so the first few show and the rest come on request. */
const PHONE_FIRST = 5;
const PHONE_STEP = 10;

type Col = ExportPreview["columns"][number];

function isShort(c: Col): boolean {
  return c.type !== "text";
}

/** A column's narrowest width, from the width the file gives it, so the table fits without needless scrolling. */
function minWidth(c: Col): { minWidth: string } {
  const rem = c.type === "text" ? Math.min(8.5, Math.max(7, c.width * 0.17)) : c.type === "date" ? 6.5 : 5.5;
  return { minWidth: `${rem}rem` };
}

/**
 * Two ICE cells are built from labelled lines: Details is the title, the provider and the link, and Key Benefits is up to
 * three answers ("How it helped: …", "How I will use it in future: …", "How it will influence next year's plan: …"). In a
 * narrow column one long line would use up all the room and push the later ones out of sight, so each line is shortened on
 * its own and every label stays visible. Other long text is cut after three lines. The file always has all of the text.
 */
function isLabelled(c: Col): boolean {
  return c.key === "benefits" || c.key === "details";
}

const MAX_LABELLED_LINES = 6;

function LabelledLines({ text }: { text: string }) {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const shown = lines.slice(0, MAX_LABELLED_LINES);
  return (
    <div className="space-y-1">
      {shown.map((line, i) => (
        <div key={i} className="line-clamp-2 [overflow-wrap:anywhere]">
          {line}
        </div>
      ))}
      {lines.length > shown.length && (
        <div aria-hidden="true" className="text-muted">
          …
        </div>
      )}
    </div>
  );
}

/** A long text cell: the labelled ones line by line, the rest cut after three lines. */
function LongText({ column, text }: { column: Col; text: string }) {
  if (text === "") return <Value text={text} />;
  if (isLabelled(column)) return <LabelledLines text={text} />;
  return (
    <div className="line-clamp-3 whitespace-pre-line [overflow-wrap:anywhere]">
      <Value text={text} />
    </div>
  );
}

/** One value. An empty cell shows a dash, and says "Empty" to a screen reader. */
function Value({ text }: { text: string }) {
  if (text === "") {
    return (
      <>
        <span aria-hidden="true" className="text-muted">
          –
        </span>
        <span className="sr-only">Empty</span>
      </>
    );
  }
  return <>{text}</>;
}

function Table({ preview, rows }: { preview: ExportPreview; rows: string[][] }) {
  const box = useRef<HTMLDivElement>(null);
  // Whether the table is wider than its box, and whether there is more to the right of what shows now.
  const [scrolls, setScrolls] = useState(false);
  const [moreRight, setMoreRight] = useState(false);

  const measure = useCallback(() => {
    const el = box.current;
    if (!el) return;
    setScrolls(el.scrollWidth > el.clientWidth + 1);
    setMoreRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
  }, []);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    measure();
    const watcher = new ResizeObserver(measure);
    watcher.observe(el);
    const inner = el.firstElementChild;
    if (inner) watcher.observe(inner);
    return () => watcher.disconnect();
  }, [measure, preview.profile, rows.length]);

  return (
    <div className="space-y-2">
      {scrolls && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <ArrowRight aria-hidden="true" size={16} className="shrink-0" />
          This sheet is wider than the screen. Scroll sideways to see every column.
        </p>
      )}
      <div className="relative">
        {/* Focusable only while it actually scrolls, so a keyboard can scroll it. A table that fits has no tab stop. */}
        <div
          ref={box}
          onScroll={measure}
          className="table-wrap relative !bg-surface-2/60"
          role="region"
          aria-label={`Rows in the ${preview.sheetName} sheet`}
          tabIndex={scrolls ? 0 : undefined}
        >
          <table className="data-table">
            <caption className="sr-only">
              Rows in the {preview.sheetName} sheet, in the same column order as the file
            </caption>
            <thead>
              <tr>
                {preview.columns.map((c) => (
                  <th
                    key={c.key}
                    scope="col"
                    style={minWidth(c)}
                    className={`!whitespace-normal !normal-case !tracking-normal align-bottom text-sm [overflow-wrap:normal] ${
                      c.type === "hours" || c.type === "number" ? "text-right" : ""
                    }`}
                  >
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((cells, i) => (
                <tr key={i}>
                  {preview.columns.map((c, j) => {
                    const text = cells[j] ?? "";
                    const numeric = c.type === "hours" || c.type === "number";
                    return (
                      <td
                        key={c.key}
                        style={minWidth(c)}
                        className={
                          isShort(c)
                            ? `num [overflow-wrap:break-word] ${text.includes(" - ") ? "" : "whitespace-nowrap"} ${numeric ? "text-right" : ""}`
                            : "max-w-[16rem] [overflow-wrap:anywhere]"
                        }
                      >
                        {isShort(c) ? <Value text={text} /> : <LongText column={c} text={text} />}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {/* A soft edge on the right while more columns wait beyond it. It sits over the box, so it never takes a click. */}
        {moreRight && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 right-0 w-10 rounded-r-2xl bg-gradient-to-l from-surface to-transparent"
          />
        )}
      </div>
    </div>
  );
}

/**
 * The phone version of the table: one card per row, the same columns in the same order. Only the first few show, with a
 * button for more, so the notes and the other sheets further down the page are not buried under dozens of tall cards.
 */
function Cards({ preview, rows }: { preview: ExportPreview; rows: string[][] }) {
  const total = preview.count;
  const [visible, setVisible] = useState(PHONE_FIRST);
  // After "Show more", focus goes to the first card that has just appeared, so the next Tab or swipe carries on from there.
  const [focusAt, setFocusAt] = useState<number | null>(null);
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (focusAt === null) return;
    (list.current?.children[focusAt] as HTMLElement | undefined)?.focus();
    setFocusAt(null);
  }, [focusAt]);

  const shown = rows.slice(0, visible);
  const left = rows.length - shown.length;
  const step = Math.min(PHONE_STEP, left);

  return (
    <div className="space-y-3">
      <ol ref={list} className="space-y-2" aria-label={`Rows in the ${preview.sheetName} sheet`}>
        {shown.map((cells, i) => (
          <li key={i} tabIndex={-1} className="rounded-xl bg-surface-2 px-4 py-3">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
              {preview.columns.map((c, j) => {
                const text = cells[j] ?? "";
                return (
                  <div key={c.key} className={isShort(c) ? "min-w-0" : "col-span-2 min-w-0"}>
                    <dt className="text-xs font-bold text-muted">{c.label}</dt>
                    <dd className={`text-base ${isShort(c) ? "num" : ""}`}>
                      {isShort(c) ? <Value text={text} /> : <LongText column={c} text={text} />}
                    </dd>
                  </div>
                );
              })}
            </dl>
          </li>
        ))}
      </ol>
      {left > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => {
              setFocusAt(shown.length);
              setVisible((v) => v + PHONE_STEP);
            }}
          >
            Show {step} more {step === 1 ? "row" : "rows"}
          </button>
          <p className="text-sm text-muted">
            Showing <span className="num">{shown.length}</span> of <span className="num">{total}</span> {total === 1 ? "row" : "rows"}
          </p>
        </div>
      )}
    </div>
  );
}

/** Which of the three ICE header values are blank. */
function blankHeaderLabels(preview: ExportPreview): string[] {
  return (preview.headerBlock ?? []).filter((h) => h.value.trim() === "").map((h) => h.label);
}

/**
 * One sheet of the file, as it will be written: the sheet name, how many rows and hours, the notes that go with
 * it, and the first rows. `wide` picks the table (desktop) or the stacked cards (phone).
 */
export function PreviewSheet({ preview, yearLabel, wide }: { preview: ExportPreview; yearLabel: string; wide: boolean }) {
  const shown = preview.rows.slice(0, PREVIEW_ROW_LIMIT);
  const more = preview.count - shown.length;
  const blanks = blankHeaderLabels(preview);
  const headingId = `sheet-${preview.profile}`;

  return (
    <article aria-labelledby={headingId} className="band min-w-0 space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p className="eyebrow">Sheet</p>
          <h3 id={headingId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {preview.sheetName}
            {preview.profile === "istructe" && <ProvisionalBadge />}
          </h3>
        </div>
        <p className="flex items-baseline gap-x-5 gap-y-1">
          <span className="flex items-baseline gap-1.5">
            <span className="big-num text-3xl">{preview.count}</span>
            <span className="text-base text-muted">{preview.count === 1 ? "row" : "rows"}</span>
          </span>
          <span className="flex items-baseline gap-1.5">
            <span className="big-num text-3xl">{formatHours(preview.totalHours)}</span>
            <span className="text-base text-muted">{preview.totalHours === 1 ? "hour" : "hours"}</span>
          </span>
        </p>
      </div>

      {preview.headerBlock && (
        <div className="space-y-3">
          <div className="rounded-xl bg-surface-2 px-4 py-3">
            <p className="text-sm font-bold text-muted">Header at the top of the sheet</p>
            <dl className="mt-2 grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
              {preview.headerBlock.map((h) => (
                <div key={h.label} className="contents">
                  <dt className="text-sm font-bold sm:pt-0.5">{h.label}</dt>
                  <dd className="min-w-0 whitespace-pre-line text-base [overflow-wrap:anywhere]">
                    {h.value.trim() === "" ? <span className="text-muted">Not filled in</span> : h.value}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
          {blanks.length > 0 && (
            <p className="notice notice-info flex items-start gap-2 text-base">
              <Info aria-hidden="true" size={20} className="mt-0.5 shrink-0" />
              <span className="min-w-0">
                Not filled in yet: {blanks.join("; ")}. Add {blanks.length === 1 ? "it" : "them"} in <Link href="/settings">Settings</Link> and{" "}
                {blanks.length === 1 ? "it" : "they"} will appear in the file.
              </span>
            </p>
          )}
        </div>
      )}

      {preview.note && (
        <p className="notice notice-warn flex items-start gap-2 text-base">
          <TriangleAlert aria-hidden="true" size={20} className="mt-0.5 shrink-0" />
          <span className="min-w-0">{preview.note}</span>
        </p>
      )}

      {preview.profile === "custom" && (
        <p className="text-sm text-muted">
          The columns after Hours use the field names you set in <Link href="/settings">Settings</Link>.
        </p>
      )}

      {preview.count === 0 ? (
        <p className="rounded-xl bg-surface-2 px-4 py-3 text-base">
          {yearLabel === "all"
            ? "There are no entries in this log, so this sheet will have only its column headings."
            : `There are no entries in this log for ${yearLabel}, so this sheet will have only its column headings.`}
        </p>
      ) : (
        <div className="space-y-3">
          {wide ? <Table preview={preview} rows={shown} /> : <Cards preview={preview} rows={shown} />}
          {more > 0 && (
            <p className="text-base font-bold">
              and {more} more {more === 1 ? "row" : "rows"} in the file
            </p>
          )}
          <p className="text-sm text-muted">Long text is shortened on screen. The file has every word.</p>
        </div>
      )}
    </article>
  );
}
