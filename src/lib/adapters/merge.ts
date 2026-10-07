/**
 * Merging results from several adapters into one.
 *
 * For each field the best confidence wins: high, then estimate, then low, then missing. A tie goes to
 * the adapter with the higher specificity (the generic adapter is the lowest), then to the one listed
 * first. The winning field is copied as it is, so a merge can never raise a confidence level: the
 * result for a field is exactly one adapter's own answer. Flags are OR-ed. Notes are joined and
 * de-duplicated.
 */
import type { AdapterResult, Confidence, DraftFieldKey, Field } from "@/lib/types";
import { DEFAULT_MISSING_EVIDENCE, emptyResult } from "./common";

/** Higher is better. Estimate ranks above low because it is calculated from the page, not guessed. */
export const CONFIDENCE_RANK: Readonly<Record<Confidence, number>> = {
  high: 3,
  estimate: 2,
  low: 1,
  missing: 0,
};

export const MERGED_FIELD_KEYS: readonly DraftFieldKey[] = [
  "title", "provider", "sourceType", "theme", "durationMinutes", "publishedAt", "eventDate", "providerCpdHours",
];

/** A field with no value counts as missing whatever its label says. An unknown label also counts as missing. */
function normalised<T>(f: Field<T> | undefined, key: DraftFieldKey): Field<T> {
  if (!f || f.value === null || f.value === undefined || !Object.hasOwn(CONFIDENCE_RANK, f.confidence) || f.confidence === "missing") {
    return { value: null, confidence: "missing", evidence: f?.evidence || DEFAULT_MISSING_EVIDENCE[key] };
  }
  return { value: f.value, confidence: f.confidence, evidence: f.evidence };
}

function specificityOf(table: Record<string, number>, id: string): number {
  if (!Object.hasOwn(table, id)) return 0;
  const n = table[id];
  return typeof n === "number" && Number.isFinite(n) ? n : 0;
}

function best<T>(entries: readonly { field: Field<T>; spec: number; index: number }[]): Field<T> {
  const sorted = [...entries].sort(
    (a, b) =>
      CONFIDENCE_RANK[b.field.confidence] - CONFIDENCE_RANK[a.field.confidence] || b.spec - a.spec || a.index - b.index,
  );
  const winner = sorted[0];
  if (!winner) throw new Error("best() needs at least one entry");
  return { ...winner.field };
}

export function mergeResults(results: readonly AdapterResult[], specificityById: Record<string, number>): AdapterResult {
  if (results.length === 0) return emptyResult("merged");
  const entries = results.map((r, index) => ({ r, index, spec: specificityOf(specificityById, r.adapter) }));

  function pick<T>(key: DraftFieldKey, get: (r: AdapterResult) => Field<T> | undefined): Field<T> {
    return best(entries.map((e) => ({ field: normalised(get(e.r), key), spec: e.spec, index: e.index })));
  }

  const notes: string[] = [];
  for (const { r } of entries) {
    for (const n of r.notes ?? []) {
      const note = typeof n === "string" ? n.trim() : "";
      if (note && !notes.includes(note)) notes.push(note);
    }
  }

  const ids: string[] = [];
  for (const e of [...entries].sort((a, b) => b.spec - a.spec || a.index - b.index)) {
    if (!ids.includes(e.r.adapter)) ids.push(e.r.adapter);
  }

  return {
    adapter: ids.join("+"),
    title: pick("title", (r) => r.title),
    provider: pick("provider", (r) => r.provider),
    sourceType: pick("sourceType", (r) => r.sourceType),
    theme: pick("theme", (r) => r.theme),
    durationMinutes: pick("durationMinutes", (r) => r.durationMinutes),
    publishedAt: pick("publishedAt", (r) => r.publishedAt),
    eventDate: pick("eventDate", (r) => r.eventDate),
    providerCpdHours: pick("providerCpdHours", (r) => r.providerCpdHours),
    flags: {
      upcoming: entries.some((e) => e.r.flags?.upcoming === true),
      recording: entries.some((e) => e.r.flags?.recording === true),
    },
    notes,
  };
}
