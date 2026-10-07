/**
 * Text clean-up for anything that goes into, or comes out of, a model prompt.
 * Pure functions, no I/O.
 */

/** Control characters except tab, line feed, carriage return, vertical tab and form feed (those are whitespace). */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000E-\u001F\u007F-\u009F]/g;
/** Format characters: zero-width space/joiners, bidi controls, word joiner, BOM, soft hyphen. */
const FORMAT_CHARS = /\p{Cf}/gu;
/** Unicode tag characters and variation selectors that carry invisible text. */
// eslint-disable-next-line no-misleading-character-class
const TAG_CHARS = /[\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;
/** Letters and separators that render as blank space. Built from code points so the source stays readable. */
const BLANK_LOOKALIKES = new RegExp(`[${["180E", "115F", "1160", "3164", "FFA0"].map((h) => String.fromCodePoint(parseInt(h, 16))).join("")}]`, "g");
/** Surrogate halves with no partner: they would make a JSON body invalid. */
const LONE_SURROGATES = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip hidden characters. Returns the text and whether anything was removed. */
export function stripHidden(input: string): { text: string; removed: boolean } {
  const text = input.replace(CONTROL_CHARS, "").replace(FORMAT_CHARS, "").replace(TAG_CHARS, "").replace(BLANK_LOOKALIKES, "").replace(LONE_SURROGATES, "");
  return { text, removed: text.length !== input.length };
}

/** Cut to at most `max` characters without splitting a surrogate pair. */
export function truncateChars(input: string, max: number): { text: string; truncated: boolean } {
  if (input.length <= max) return { text: input, truncated: false };
  let end = max;
  const code = input.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: input.slice(0, end).trimEnd(), truncated: true };
}

/**
 * Remove every occurrence of each forbidden token (case-insensitively) until none are left, so that removing one
 * cannot join the text on either side into a new copy of it.
 */
export function removeTokens(input: string, tokens: readonly string[]): string {
  let out = input;
  const live = tokens.filter((t) => t.length > 0);
  if (live.length === 0) return out;
  const re = new RegExp(live.map(escapeRegExp).join("|"), "gi");
  for (let i = 0; i < 20; i++) {
    const next = out.replace(re, "");
    if (next === out) return out;
    out = next;
  }
  return out.replace(re, "");
}

export interface SanitisedField {
  text: string;
  /** True when the text was longer than the cap and was cut. */
  truncated: boolean;
}

/**
 * Make one piece of user text safe to place inside a delimited data block:
 * strip control and zero-width characters, remove the block boundary token so the text cannot close the block,
 * collapse all whitespace (including line breaks) to single spaces, trim, and cap the length.
 */
export function sanitiseForPrompt(input: unknown, maxChars: number, forbiddenTokens: readonly string[] = []): SanitisedField {
  const raw = typeof input === "string" ? input : "";
  const stripped = stripHidden(raw).text;
  const withoutTokens = removeTokens(stripped, forbiddenTokens);
  const collapsed = withoutTokens.replace(/\s+/g, " ").trim();
  // Collapsing can bring pieces of a token together only if whitespace separated them, so check again.
  const again = removeTokens(collapsed, forbiddenTokens).replace(/\s+/g, " ").trim();
  return truncateChars(again, maxChars);
}

function isTagChar(code: number): boolean {
  return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 || code === 45;
}

/**
 * If the whole text is wrapped in one markdown code fence, return what is inside it (not trimmed). Otherwise null.
 *
 * An optional language tag ("```json") is removed. By default it is removed even when the content follows it on the same
 * line ("```json {...}```"). With `tagOnOwnLine` it counts as a tag only when nothing else is on that line, so a table
 * whose first row begins on the fence line ("```Date<tab>Title") does not lose its first cell to a false tag.
 *
 * Written as plain scanning, not a regular expression: model text can contain very long runs of spaces and line
 * breaks, and a lazy match over them takes quadratic time, which would freeze the server.
 */
export function unwrapCodeFence(raw: string, options: { tagOnOwnLine?: boolean } = {}): string | null {
  const t = raw.trim();
  if (t.length < 6 || !t.startsWith("```") || !t.endsWith("```")) return null;
  const inner = t.slice(3, -3);

  let k = 0;
  while (k < inner.length && isTagChar(inner.charCodeAt(k))) k++;
  let m = k;
  while (m < inner.length && (inner[m] === " " || inner[m] === "\t")) m++;

  let start: number;
  if (m === inner.length) return "";
  if (inner[m] === "\n") start = m + 1;
  else if (inner[m] === "\r" && inner[m + 1] === "\n") start = m + 2;
  else start = options.tagOnOwnLine ? 0 : m;

  // Drop the blank space, one line break and its carriage return that sit just before the closing fence.
  let end = inner.length;
  while (end > start && (inner[end - 1] === " " || inner[end - 1] === "\t")) end--;
  if (end > start && inner[end - 1] === "\n") end--;
  if (end > start && inner[end - 1] === "\r") end--;
  return inner.slice(start, end);
}

/**
 * Clean text that came back from a model. Keeps line breaks (at most one blank line in a row), removes hidden
 * characters, trims each line and collapses runs of spaces. Reports whether hidden characters were removed.
 */
export function cleanModelText(input: string): { text: string; removedHidden: boolean } {
  const { text: stripped, removed } = stripHidden(input);
  const text = stripped
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, removedHidden: removed };
}
