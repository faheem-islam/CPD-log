import { parseCsvRecords } from "@/lib/import/csv";
import { parseDurationMinutes, parseUkDate } from "@/lib/dates";
import { matchOption } from "@/lib/profiles";
import type { AdapterResult, Confidence, ExtractResponse } from "@/lib/types";

/** Fields the evaluation can score. A blank cell in eval/urls.csv means "don't score this field". */
export const SCORED_FIELDS = ["title", "provider", "sourceType", "durationMinutes", "publishedAt", "eventDate", "theme"] as const;
export type ScoredField = (typeof SCORED_FIELDS)[number];

export interface EvalRow {
  url: string;
  expected: Partial<Record<ScoredField, string>>;
  /** Problems with this row of the CSV itself (for example an unreadable date). */
  problems: string[];
}

export type Outcome = "correct" | "wrong" | "not_found";

export interface FieldScore {
  field: ScoredField;
  expected: string;
  actual: string | null;
  outcome: Outcome;
  confidence: Confidence | null;
  evidence: string | null;
}

export interface UrlScore {
  url: string;
  status: ExtractResponse["status"] | "error";
  message: string;
  fields: FieldScore[];
  problems: string[];
}

export function parseEvalCsv(text: string): EvalRow[] {
  const clean = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const { records } = parseCsvRecords(clean, ",");
  const [header, ...rows] = records;
  if (!header) return [];
  const names = header.map((h) => h.trim());
  const col = (name: string) => names.indexOf(name);
  const urlCol = col("url");
  if (urlCol < 0) throw new Error('eval/urls.csv needs a "url" column.');

  const out: EvalRow[] = [];
  for (const r of rows) {
    const url = (r[urlCol] ?? "").trim();
    if (!url) continue;
    const expected: Partial<Record<ScoredField, string>> = {};
    const problems: string[] = [];
    for (const f of SCORED_FIELDS) {
      const c = col(f);
      const v = c >= 0 ? (r[c] ?? "").trim() : "";
      if (!v) continue;
      if ((f === "publishedAt" || f === "eventDate") && !parseUkDate(v)) {
        problems.push(`${f}: "${v}" isn't a date. Use dd/mm/yyyy or yyyy-mm-dd.`);
        continue;
      }
      if (f === "durationMinutes" && !(Number.isFinite(Number(v)) || parseDurationMinutes(v))) {
        problems.push(`durationMinutes: "${v}" isn't a number of minutes.`);
        continue;
      }
      expected[f] = v;
    }
    out.push({ url, expected, problems });
  }
  return out;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** Titles and providers match when they are equal, or one contains the other, ignoring case and punctuation. */
export function textMatches(expected: string, actual: string): boolean {
  const e = norm(expected);
  const a = norm(actual);
  if (!e || !a) return false;
  return e === a || a.includes(e) || e.includes(a);
}

function expectedMinutes(v: string): number | null {
  const n = Number(v);
  if (Number.isFinite(n)) return n;
  return parseDurationMinutes(v);
}

function pick(result: AdapterResult, field: ScoredField): { value: string | null; confidence: Confidence; evidence: string } {
  const f = result[field];
  if (!f || f.value === null || f.value === undefined || f.confidence === "missing") {
    return { value: null, confidence: "missing", evidence: f?.evidence ?? "" };
  }
  return { value: String(f.value), confidence: f.confidence, evidence: f.evidence };
}

export function scoreField(field: ScoredField, expected: string, result: AdapterResult): FieldScore {
  const got = pick(result, field);
  let outcome: Outcome;
  if (got.value === null) {
    outcome = "not_found";
  } else if (field === "title" || field === "provider") {
    outcome = textMatches(expected, got.value) ? "correct" : "wrong";
  } else if (field === "sourceType") {
    outcome = norm(expected).replace(/ /g, "") === norm(got.value).replace(/ /g, "") ? "correct" : "wrong";
  } else if (field === "durationMinutes") {
    const e = expectedMinutes(expected);
    outcome = e !== null && Math.abs(e - Number(got.value)) <= 1 ? "correct" : "wrong";
  } else if (field === "publishedAt" || field === "eventDate") {
    outcome = parseUkDate(expected) === got.value ? "correct" : "wrong";
  } else {
    outcome = (matchOption(expected, [got.value]) ?? "") === got.value || norm(expected) === norm(got.value) ? "correct" : "wrong";
  }
  return { field, expected, actual: got.value, outcome, confidence: got.confidence, evidence: got.evidence };
}

export function scoreUrl(row: EvalRow, response: ExtractResponse | null, errorMessage?: string): UrlScore {
  if (!response) {
    return {
      url: row.url,
      status: "error",
      message: errorMessage ?? "The reader threw an error.",
      fields: Object.entries(row.expected).map(([f, e]) => ({
        field: f as ScoredField, expected: e ?? "", actual: null, outcome: "not_found", confidence: null, evidence: null,
      })),
      problems: row.problems,
    };
  }
  if (response.status !== "ok" || !response.result) {
    return {
      url: row.url,
      status: response.status,
      message: response.message,
      fields: Object.entries(row.expected).map(([f, e]) => ({
        field: f as ScoredField, expected: e ?? "", actual: null, outcome: "not_found", confidence: null, evidence: null,
      })),
      problems: row.problems,
    };
  }
  const result = response.result;
  const fields = (Object.entries(row.expected) as [ScoredField, string][]).map(([f, e]) => scoreField(f, e, result));
  return { url: row.url, status: "ok", message: response.message, fields, problems: row.problems };
}

export interface FieldTotals {
  field: ScoredField;
  scored: number;
  correct: number;
  wrong: number;
  notFound: number;
}

export interface Summary {
  urls: number;
  read: number;
  refused: number;
  perField: FieldTotals[];
  /** Of the values labelled High that could be checked, how many were right. */
  high: { checked: number; correct: number };
  /** Same for each of the other labels, for comparison. */
  byConfidence: Record<Confidence, { checked: number; correct: number }>;
}

export function summarise(scores: UrlScore[]): Summary {
  const perField = SCORED_FIELDS.map<FieldTotals>((field) => ({ field, scored: 0, correct: 0, wrong: 0, notFound: 0 }));
  const byConfidence: Summary["byConfidence"] = {
    high: { checked: 0, correct: 0 },
    low: { checked: 0, correct: 0 },
    estimate: { checked: 0, correct: 0 },
    missing: { checked: 0, correct: 0 },
  };
  for (const s of scores) {
    for (const f of s.fields) {
      const t = perField.find((p) => p.field === f.field);
      if (!t) continue;
      t.scored++;
      if (f.outcome === "correct") t.correct++;
      else if (f.outcome === "wrong") t.wrong++;
      else t.notFound++;
      if (f.outcome !== "not_found" && f.confidence) {
        byConfidence[f.confidence].checked++;
        if (f.outcome === "correct") byConfidence[f.confidence].correct++;
      }
    }
  }
  return {
    urls: scores.length,
    read: scores.filter((s) => s.status === "ok").length,
    refused: scores.filter((s) => s.status !== "ok").length,
    perField: perField.filter((p) => p.scored > 0),
    high: byConfidence.high,
    byConfidence,
  };
}

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${Math.round((n / d) * 100)}%`);
const cell = (s: string | null) => (s ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 120);

export function renderReport(scores: UrlScore[], when: string): string {
  const s = summarise(scores);
  const lines: string[] = [];
  lines.push("# CPD Logger evaluation report", "");
  lines.push(`Run: ${when}`, "");
  lines.push(
    "> This report describes **only the URLs in `eval/urls.csv`, as they were when the run happened**. It is not a measure of accuracy in general: a small list, one moment in time, and expected values filled in by hand. Blank cells in the CSV were not scored.",
    "",
  );
  lines.push(`URLs: ${s.urls} · read: ${s.read} · not read (blocked, refused or failed): ${s.refused}`, "");

  lines.push("## Per field", "");
  if (s.perField.length === 0) {
    lines.push("Nothing was scored. Fill in the expected values in `eval/urls.csv` (title, provider, sourceType, durationMinutes, publishedAt, eventDate, theme) and run `npm run eval` again.", "");
  } else {
    lines.push("| Field | Scored | Correct | Wrong | Not found | Correct of scored |", "|---|---:|---:|---:|---:|---:|");
    for (const t of s.perField) lines.push(`| ${t.field} | ${t.scored} | ${t.correct} | ${t.wrong} | ${t.notFound} | ${pct(t.correct, t.scored)} |`);
    lines.push("");
  }

  lines.push("## How often a \"High\" badge was right", "");
  lines.push(
    `Of ${s.high.checked} checkable value(s) labelled High, ${s.high.correct} matched your expected value (${pct(s.high.correct, s.high.checked)}).`,
    "",
    "| Badge | Checkable values | Matched | Matched of checkable |",
    "|---|---:|---:|---:|",
  );
  const label: Record<Confidence, string> = { high: "High", low: "Check", estimate: "Estimate", missing: "Not found" };
  for (const c of ["high", "low", "estimate"] as const) {
    lines.push(`| ${label[c]} | ${s.byConfidence[c].checked} | ${s.byConfidence[c].correct} | ${pct(s.byConfidence[c].correct, s.byConfidence[c].checked)} |`);
  }
  lines.push("", "A High badge that was wrong is the most important thing to look for below.", "");

  const wrong = scores.flatMap((u) => u.fields.filter((f) => f.outcome === "wrong").map((f) => ({ url: u.url, f })));
  lines.push("## Wrong values", "");
  if (wrong.length === 0) lines.push("None among the values that were scored.", "");
  else {
    lines.push("| URL | Field | Expected | Got | Badge | Where it came from |", "|---|---|---|---|---|---|");
    for (const w of wrong) lines.push(`| ${cell(w.url)} | ${w.f.field} | ${cell(w.f.expected)} | ${cell(w.f.actual)} | ${w.f.confidence ? label[w.f.confidence] : ""} | ${cell(w.f.evidence)} |`);
    lines.push("");
  }

  lines.push("## Per URL", "");
  for (const u of scores) {
    lines.push(`### ${u.url}`, "", `Status: **${u.status}** — ${u.message}`, "");
    for (const p of u.problems) lines.push(`- CSV problem: ${p}`);
    if (u.fields.length === 0) lines.push("- No expected values to score for this URL.");
    for (const f of u.fields) {
      const mark = f.outcome === "correct" ? "correct" : f.outcome === "wrong" ? "WRONG" : "not found";
      lines.push(`- ${f.field}: ${mark}. Expected "${cell(f.expected)}", got ${f.actual === null ? "nothing" : `"${cell(f.actual)}" (${f.confidence ? label[f.confidence] : ""})`}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
