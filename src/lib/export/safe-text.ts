/**
 * Text safety for spreadsheet cells.
 *
 * Formula injection: a text cell that starts with = + - @ (or a tab or carriage return) can be turned into a
 * formula if someone edits the cell, or if the sheet is saved as CSV and opened in another tool.
 * exceljs always writes a plain string as a shared-string cell, never as a formula, so Excel does not evaluate it
 * when the file opens. To also cover editing and CSV round trips, we neutralise such strings with the usual
 * single-quote prefix. The quote becomes part of the stored text (exceljs cannot set Excel's hidden quote-prefix
 * style), so the cell stays a plain string and the preview shows exactly what the file holds.
 * The importer removes one such quote again (see unneutraliseFormula), so a round trip keeps the original text.
 */

/** Excel allows 32,767 characters in one cell. We stay a little under it. */
export const MAX_CELL_CHARS = 32000;

/** Text that would be read as a formula, or that already starts with quote(s) in front of one (so one quote can come off again later). */
const FORMULA_START = /^'*[=+\-@\t\r]/;
const NEUTRALISED = /^'(?='*[=+\-@\t\r])/;

/** Characters that are not allowed in XML 1.0, and lone surrogates. Either one makes Excel say the file is corrupt. */
// eslint-disable-next-line no-control-regex
const XML_INVALID = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Trim, use \n for line breaks and drop characters Excel cannot store. */
export function cleanText(input: string | null | undefined): string {
  if (!input) return "";
  return input.replace(/\r\n?/g, "\n").replace(XML_INVALID, "").trim();
}

/** Prefix a single quote when the text could be read as a formula, so unneutraliseFormula gets the original text back. */
export function neutraliseFormula(text: string): string {
  return FORMULA_START.test(text) ? `'${text}` : text;
}

/** Undo neutraliseFormula: remove one leading quote when it sits in front of = + - @ tab or carriage return (or more quotes and then one of those). */
export function unneutraliseFormula(text: string): string {
  return NEUTRALISED.test(text) ? text.slice(1) : text;
}

/** Clean, then neutralise. Use this for every user-supplied string that is written to a cell. */
export function safeText(input: string | null | undefined): string {
  return neutraliseFormula(cleanText(input));
}

/** An underscore that starts what an OOXML reader would take for an escaped character: _x0041_ is the letter A. */
const OOXML_ESCAPE_START = /_(?=x[0-9A-Fa-f]{4}_)/g;

/**
 * Text as it must be written into a cell so that it reads back unchanged. OOXML spells a character as _xHHHH_, and
 * readers (Excel, exceljs) turn such a sequence into the character, so a title that contains "tank_x00FF_data" would come
 * back as "tankÿdata". The underscore that starts such a sequence is written as _x005F_ (the escape for an underscore).
 * Use it at the moment a string is put into a cell, and nowhere else: the text on screen and in the preview stays as typed.
 */
export function escapeOoxmlText(text: string): string {
  return text.replace(OOXML_ESCAPE_START, "_x005F_");
}

/** Shorten text to the Excel cell limit. Returns whether it was shortened so the file can say so. */
export function clampCell(text: string): { text: string; clamped: boolean } {
  if (text.length <= MAX_CELL_CHARS) return { text, clamped: false };
  let cut = text.slice(0, MAX_CELL_CHARS - 1);
  // Do not leave half of a surrogate pair at the cut.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { text: `${cut}…`, clamped: true };
}
