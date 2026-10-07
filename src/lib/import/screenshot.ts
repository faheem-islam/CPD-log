import { parseDelimitedText } from "./parse";
import type { ImportContext, ImportResult } from "./types";

/** A line of a markdown table separator: |---|:---:|---| (borders optional). */
function isSeparatorRow(cells: readonly string[]): boolean {
  const filled = cells.map((c) => c.replace(/\s/g, "")).filter((c) => c !== "");
  return filled.length > 0 && filled.every((c) => /^:?-+:?$/.test(c));
}

function splitPipeRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  return s.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").replace(/<br\s*\/?>/gi, "\n").trim());
}

/** Tab-separated, with quotes where a cell holds a tab, a line break or a quote. */
function toTsvLine(cells: readonly string[]): string {
  return cells
    .map((c) => (/[\t\n"]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c))
    .join("\t");
}

/**
 * Whether lines that hold a pipe are a markdown table, and not CSV whose titles happen to hold pipes ("Webinar | Part 1").
 * A table has a separator row (|---|---|), or most of its lines start or end with a pipe, or every line is cut into
 * columns by pipes starting with the first one. Text where a few lines have a pipe inside a cell is not a table.
 */
function looksLikePipeTable(nonEmpty: readonly string[], pipeLines: readonly string[]): boolean {
  if (pipeLines.some((l) => isSeparatorRow(splitPipeRow(l)))) return true;
  const bordered = nonEmpty.filter((l) => /^\s*\|/.test(l) || /\|\s*$/.test(l)).length;
  if (bordered * 2 > nonEmpty.length) return true;
  const first = nonEmpty[0];
  return first !== undefined && first.includes("|") && pipeLines.length === nonEmpty.length;
}

export interface NormalisedTranscription {
  text: string;
  /** Lines that were not part of the table (a sentence before it, for example) and were left out. */
  droppedLines: number;
}

/**
 * Makes a transcription easy to parse. A markdown pipe table loses its borders and its |---|---| separator row and
 * becomes tab-separated text. Tab-separated text stays as it is. Lines that are not part of the table are dropped
 * and counted, so the importer can say so.
 */
export function normaliseTranscription(input: string): NormalisedTranscription {
  const lines = input
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .filter((l) => !/^\s*```/.test(l));
  const nonEmpty = lines.filter((l) => l.trim() !== "");

  const tabLines = nonEmpty.filter((l) => l.includes("\t"));
  if (tabLines.length >= 2 && tabLines.length * 2 >= nonEmpty.length) {
    const kept = lines.filter((l) => l.trim() === "" || l.includes("\t"));
    return { text: kept.join("\n"), droppedLines: nonEmpty.length - tabLines.length };
  }

  const pipeLines = nonEmpty.filter((l) => l.includes("|"));
  if (pipeLines.length >= 2 && looksLikePipeTable(nonEmpty, pipeLines)) {
    const out: string[] = [];
    for (const line of pipeLines) {
      const cells = splitPipeRow(line);
      if (isSeparatorRow(cells)) continue;
      out.push(toTsvLine(cells));
    }
    return { text: out.join("\n"), droppedLines: nonEmpty.length - pipeLines.length };
  }

  return { text: lines.join("\n"), droppedLines: 0 };
}

/**
 * Text that a model transcribed from a screenshot of a CPD table. The model only copies text out of the picture;
 * this code turns it into rows. Every row gets a warning to check every field.
 * Accepts markdown pipe tables, tab-separated text, and CSV.
 */
export function parseTranscribedText(text: string, ctx: ImportContext): ImportResult {
  const { text: table, droppedLines } = normaliseTranscription(text);
  const extraWarnings =
    droppedLines === 0
      ? []
      : droppedLines === 1
        ? ["1 line of the transcription was not part of the table and was left out."]
        : [`${droppedLines} lines of the transcription were not part of the table and were left out.`];
  return parseDelimitedText(table, ctx, { fromScreenshot: true, fileKind: "screenshot", extraWarnings });
}
