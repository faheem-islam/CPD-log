/**
 * Unsupported-claim scan.
 *
 * Finds things in AI-written text that do not appear in the text the model was given: numbers, years,
 * percentages, standards and document references, and capitalised names or acronyms. It is a prompt to the
 * user to check, not a proof either way. It never changes or removes any text; callers show what it finds as warnings.
 *
 * Text is compared after Unicode compatibility folding (NFKC), so fullwidth digits and letters ("１２", "ＢＳ"),
 * mathematical digits, ideographic spaces and digits from other scripts count as the plain characters they imitate.
 *
 * What it can miss (by design, to keep false alarms down):
 *  - the word "one" (almost always a pronoun) and ordinal words such as "first";
 *  - a single capitalised word at the start of a sentence, unless it is an acronym (almost every such word is an
 *    everyday one, and first-person answers usually begin "I learned ..."; checking them all would bury real warnings);
 *  - fractions and multiples other than the common ones ("a third", "two quarters", "doubled", "twice", "tenfold");
 *  - facts that use only words from the source (it checks tokens, not meaning).
 * What it can flag wrongly: a derived figure (for example hours worked out from minutes), a spelled-out number
 * where the source used digits for a different but equal quantity, and names that appear in the source in a
 * different form.
 */

export type UnsupportedKind = "number" | "year" | "percentage" | "reference" | "name";

export interface UnsupportedClaim {
  kind: UnsupportedKind;
  /** The text as it appears in the output. */
  text: string;
}

const NUMBER_WORDS: Record<string, number> = {
  zero: 0, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
  hundred: 100, thousand: 1000, million: 1_000_000, billion: 1_000_000_000, dozen: 12, half: 0.5,
};
const UNIT_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const TENS = ["twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

const COMPOUND_RE = new RegExp(`\\b(${TENS.join("|")})[- ](${Object.keys(UNIT_WORDS).join("|")})\\b`, "gi");
const NUMBER_WORD_RE = new RegExp(`\\b(${Object.keys(NUMBER_WORDS).join("|")})\\b`, "gi");
const DIGITS_RE = /\d+(?:,\d{3})*(?:\.\d+)?/g;
const PERCENT_RE = /(\d+(?:,\d{3})*(?:\.\d+)?)\s?(?:%|per\s?cent\b|percent\b)/gi;

const SECTION_WORD = "(?:Chapter|Section|Part|Clause|Table|Annex|Appendix|Figure|Regulations?|Schedule|Volume|No\\.?)";
const HEAD_WORD = "(?:[A-Z]{2,}[A-Za-z]*|Eurocode)";
const REFERENCE_RE = new RegExp(`\\b${HEAD_WORD}(?:\\s+(?:${HEAD_WORD}|${SECTION_WORD}))*\\s*-?\\s*(?:${SECTION_WORD}\\s+)?\\d[\\w./:-]*`, "g");
const CODE_RE = /\b[A-Z][A-Za-z]{0,5}\d+[A-Za-z0-9]*\b/g;
const WORD_RE = /[A-Za-z][A-Za-z0-9]*(?:['’][A-Za-z]+)?(?:-[A-Za-z0-9]+)*/g;

/** Capitalised words the user's own voice or this app's subject makes ordinary. */
const NAME_ALLOWLIST = new Set(["i", "i'm", "i'll", "i've", "i'd", "cpd", "uk"]);

/** Ordinary words that often begin a sentence in front of a name ("The Network Rail team ..."). */
const SENTENCE_STARTERS = new Set([
  "the", "this", "that", "these", "those", "a", "an", "in", "on", "at", "it", "we", "our", "my", "their", "his", "her", "its",
  "when", "while", "after", "before", "during", "for", "from", "with", "without", "by", "to", "as", "if", "using", "and", "but",
  "so", "some", "many", "all", "each", "both", "also", "however", "overall", "finally", "next", "then", "now", "there", "here",
  "what", "how", "why", "who", "which", "where", "understanding", "learning", "key", "good", "better", "clear", "because",
]);

const DECIMAL_DIGIT = /^\p{Nd}$/u;

/** The ASCII digit a decimal digit from another script stands for. Each script's digits are one run of ten, starting at zero. */
function asciiDigit(ch: string): string {
  const cp = ch.codePointAt(0) ?? 0;
  let zero = cp;
  while (zero > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(zero - 1))) zero--;
  return String((cp - zero) % 10);
}

/**
 * Make look-alike characters plain, so a claim cannot hide in fullwidth or other compatibility forms: NFKC (fullwidth and
 * mathematical digits and letters, ideographic space, ligatures), then digits of other scripts, then curly quotes and dashes.
 */
function foldText(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/(?![0-9])\p{Nd}/gu, asciiDigit)
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐‑‒–—−]/g, "-");
}

/** Lowercase, letters and digits split apart (BS5489 = BS 5489), punctuation to single spaces, padded so whole-token matching is a plain substring test. */
function tokenForm(s: string): string {
  const spaced = foldText(s).toLowerCase().replace(/([a-z])(\d)/g, "$1 $2").replace(/(\d)([a-z])/g, "$1 $2");
  return ` ${spaced.replace(/[^a-z0-9]+/g, " ").trim()} `;
}

function parseDigits(s: string): number {
  return Number(s.replace(/,/g, ""));
}

function blank(text: string, start: number, length: number): string {
  return text.slice(0, start) + " ".repeat(length) + text.slice(start + length);
}

function isYear(raw: string): boolean {
  return /^\d{4}$/.test(raw) && Number(raw) >= 1900 && Number(raw) <= 2199;
}

// ---------------------------------------------------------------------------------------------
// Fractions and multiples ("a third", "doubled", "twice", "tenfold"). They state a quantity as surely as a digit does.
// Each one gets a key ("1/3", "x2") so that "doubled" in the notes supports "twice" in the answer, and nothing else does.

const MULTIPLE_KEYS: Record<string, string> = {
  twice: "x2", doubled: "x2", doubling: "x2",
  thrice: "x3", tripled: "x3", tripling: "x3",
  quadrupled: "x4", quadrupling: "x4",
  halved: "x0.5", halving: "x0.5",
};
const FRACTION_NUMERATORS: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9 };
const FRACTION_DENOMINATORS: Record<string, number> = { third: 3, thirds: 3, quarter: 4, quarters: 4, fifth: 5, fifths: 5, tenth: 10, tenths: 10 };
const FOLD_WORDS = ["two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "twenty", "thirty", "forty", "fifty", "hundred", "thousand"];

const MULTIPLE_RE = new RegExp(`\\b(?:${Object.keys(MULTIPLE_KEYS).join("|")})\\b`, "gi");
/** "double the capacity", "triple its output": the bare word is only a multiple in front of these ("double-check" and "double glazing" are not). */
const BARE_MULTIPLE_RE = /\b(double|triple|quadruple)(?=\s+(?:the|as|its|their|our|my|that|this|what)\b)/gi;
const FOLD_RE = new RegExp(`\\b(${FOLD_WORDS.join("|")})[- ]?fold\\b`, "gi");
/** "a third" but not "a third party", "the third edition" or "once a quarter" (a point in the year, not a fraction). */
const FRACTION_RE = new RegExp(
  `(?<!\\b(?:once|twice|thrice|per|every|each)\\s)\\b(${Object.keys(FRACTION_NUMERATORS).join("|")})[ -](${Object.keys(FRACTION_DENOMINATORS).join("|")})\\b(?![ -]+(?:party|parties|edition|time|times|place|person|people|stage|phase|round|reading|tier|level|rail|sector|year|week|month|day|class|generation)\\b)`,
  "gi",
);

interface QuantityWord {
  index: number;
  text: string;
  key: string;
}

/** Fractions and multiples in already-folded text, in order, none overlapping. */
function findQuantities(text: string): QuantityWord[] {
  const out: QuantityWord[] = [];
  for (const m of text.matchAll(MULTIPLE_RE)) {
    const key = MULTIPLE_KEYS[m[0].toLowerCase()];
    if (key) out.push({ index: m.index, text: m[0], key });
  }
  for (const m of text.matchAll(BARE_MULTIPLE_RE)) {
    const n = { double: 2, triple: 3, quadruple: 4 }[(m[1] ?? "").toLowerCase()];
    if (n) out.push({ index: m.index, text: m[0], key: `x${n}` });
  }
  for (const m of text.matchAll(FOLD_RE)) {
    const n = NUMBER_WORDS[(m[1] ?? "").toLowerCase()];
    if (n !== undefined) out.push({ index: m.index, text: m[0], key: `x${n}` });
  }
  for (const m of text.matchAll(FRACTION_RE)) {
    const top = FRACTION_NUMERATORS[(m[1] ?? "").toLowerCase()];
    const bottom = FRACTION_DENOMINATORS[(m[2] ?? "").toLowerCase()];
    if (top !== undefined && bottom !== undefined) out.push({ index: m.index, text: m[0], key: `${top}/${bottom}` });
  }
  out.sort((a, b) => a.index - b.index);
  const kept: QuantityWord[] = [];
  let end = -1;
  for (const q of out) {
    if (q.index < end) continue;
    kept.push(q);
    end = q.index + q.text.length;
  }
  return kept;
}

interface SourceFacts {
  tokens: string;
  words: Set<string>;
  numbers: Set<number>;
  years: Set<string>;
  percents: Set<number>;
  /** Keys of fractions and multiples ("1/3", "x2"). */
  quantities: Set<string>;
}

function addWordForms(words: Set<string>, w: string): void {
  words.add(w);
  if (w.endsWith("'s")) words.add(w.slice(0, -2));
  if (w.endsWith("s") && w.length > 3) words.add(w.slice(0, -1));
  else words.add(`${w}s`);
}

function extractNumbers(text: string): { numbers: number[]; years: string[]; percents: number[] } {
  const numbers: number[] = [];
  const years: string[] = [];
  const percents: number[] = [];
  let working = foldText(text);

  for (const m of working.matchAll(PERCENT_RE)) {
    percents.push(parseDigits(m[1] ?? ""));
  }
  for (const m of working.matchAll(COMPOUND_RE)) {
    const tens = NUMBER_WORDS[(m[1] ?? "").toLowerCase()];
    const unit = UNIT_WORDS[(m[2] ?? "").toLowerCase()];
    if (tens !== undefined && unit !== undefined) numbers.push(tens + unit);
    working = blank(working, m.index, m[0].length);
  }
  for (const m of working.matchAll(DIGITS_RE)) {
    numbers.push(parseDigits(m[0]));
    if (isYear(m[0])) years.push(m[0]);
  }
  for (const m of working.matchAll(NUMBER_WORD_RE)) {
    const v = NUMBER_WORDS[m[1]?.toLowerCase() ?? ""];
    if (v !== undefined) numbers.push(v);
  }
  // "one" is only counted as a number when it is a digit-like unit inside a compound, handled above.
  return { numbers, years, percents };
}

function sourceFacts(sourceTexts: readonly string[]): SourceFacts {
  const joined = sourceTexts.join("\n");
  const words = new Set<string>();
  for (const m of foldText(joined).matchAll(WORD_RE)) addWordForms(words, m[0].toLowerCase());
  for (const w of tokenForm(joined).trim().split(" ")) if (w) addWordForms(words, w);
  const { numbers, years, percents } = extractNumbers(joined);
  const quantities = new Set(findQuantities(foldText(joined)).map((q) => q.key));
  // "half" in the notes supports "halved" in the answer.
  if (numbers.includes(0.5)) quantities.add("x0.5");
  return { tokens: tokenForm(joined), words, numbers: new Set(numbers), years: new Set(years), percents: new Set(percents), quantities };
}

function wordSupported(word: string, facts: SourceFacts): boolean {
  const w = foldText(word).toLowerCase();
  const base = w.replace(/'s$/, "");
  if (facts.words.has(w) || facts.words.has(base)) return true;
  // "Pre-construction" is supported by "pre construction" in the source, and the reverse.
  if (base.includes("-")) return base.split("-").every((part) => part === "" || facts.words.has(part));
  return false;
}

/** Capitalised words in the output that are proper nouns or acronyms. Sentence-initial ordinary words are skipped. */
function findNames(original: string, working: string): { text: string; words: string[] }[] {
  type Tok = { text: string; start: number; end: number };
  const toks: Tok[] = [];
  for (const m of working.matchAll(WORD_RE)) toks.push({ text: m[0], start: m.index, end: m.index + m[0].length });

  const isCap = (t: string) => /^[A-Z]/.test(t);
  const isAcronym = (t: string) => /^[A-Z]{2,}/.test(t) || /[a-z][A-Z]/.test(t);
  const atSentenceStart = (start: number): boolean => {
    let i = start - 1;
    while (i >= 0 && /[\s"'“‘([*_\-•]/.test(original.charAt(i))) {
      if (original.charAt(i) === "\n") return true;
      i--;
    }
    if (i < 0) return true;
    return /[.!?:]/.test(original.charAt(i));
  };

  const out: { text: string; words: string[] }[] = [];
  let i = 0;
  while (i < toks.length) {
    const tok = toks[i];
    if (!tok || !isCap(tok.text)) {
      i++;
      continue;
    }
    // Group capitalised words separated by a single space.
    const group: Tok[] = [tok];
    let j = i + 1;
    while (j < toks.length) {
      const next = toks[j];
      const prev = group[group.length - 1];
      if (!next || !prev || !isCap(next.text) || original.slice(prev.end, next.start) !== " ") break;
      group.push(next);
      j++;
    }
    i = j;

    let words = group.map((g) => g.text);
    const first = group[0];
    if (first && atSentenceStart(first.start) && !isAcronym(first.text)) {
      // The first word may be an ordinary word that only looks capitalised because it starts a sentence.
      // Two or more capitalised words in a row ("Highways England") are kept unless the first is a plain
      // function word ("The Network Rail team"); a single one is not checked.
      if (group.length === 1 || SENTENCE_STARTERS.has(foldText(first.text).toLowerCase())) words = words.slice(1);
    }
    words = words.filter((w) => !NAME_ALLOWLIST.has(foldText(w).toLowerCase()));
    if (words.length === 0) continue;
    out.push({ text: words.join(" "), words });
  }
  return out;
}

/**
 * Find claims in `output` that the `sourceTexts` do not contain. Pass the same texts the model was shown
 * (title, provider, theme, the user's notes). Returns each distinct claim once, in order of first appearance.
 */
export function scanUnsupported(output: string, sourceTexts: readonly string[]): UnsupportedClaim[] {
  const facts = sourceFacts(sourceTexts);
  const claims: UnsupportedClaim[] = [];
  const seen = new Set<string>();
  const add = (kind: UnsupportedKind, text: string) => {
    const key = `${kind}:${foldText(text).toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    claims.push({ kind, text });
  };

  const original = foldText(output).replace(/^[ \t]*(?:[-*•]|\d+[.)])[ \t]+/gm, (m) => " ".repeat(m.length));
  let working = original;

  // 1. Standards and document references, then short codes such as A14 or NEC4.
  const found: { index: number; kind: UnsupportedKind; text: string }[] = [];
  for (const m of working.matchAll(REFERENCE_RE)) {
    found.push({ index: m.index, kind: "reference", text: m[0].replace(/[.:/-]+$/, "") });
  }
  working = [...working.matchAll(REFERENCE_RE)].reduce((w, m) => blank(w, m.index, m[0].length), working);
  for (const m of working.matchAll(CODE_RE)) found.push({ index: m.index, kind: "reference", text: m[0] });
  working = [...working.matchAll(CODE_RE)].reduce((w, m) => blank(w, m.index, m[0].length), working);

  // 2. Percentages.
  for (const m of working.matchAll(PERCENT_RE)) found.push({ index: m.index, kind: "percentage", text: m[0].trim() });
  working = [...working.matchAll(PERCENT_RE)].reduce((w, m) => blank(w, m.index, m[0].length), working);

  // 3a. Fractions and multiples ("a third", "doubled"), before the single number words so "two thirds" is one claim.
  const quantities = findQuantities(working);
  for (const q of quantities) found.push({ index: q.index, kind: "number", text: `${q.text}\u0000q:${q.key}` });
  working = quantities.reduce((w, q) => blank(w, q.index, q.text.length), working);

  // 3b. Number words in compounds ("twenty-five"), then digits, then single number words.
  for (const m of working.matchAll(COMPOUND_RE)) {
    const v = (NUMBER_WORDS[(m[1] ?? "").toLowerCase()] ?? 0) + (UNIT_WORDS[(m[2] ?? "").toLowerCase()] ?? 0);
    found.push({ index: m.index, kind: "number", text: `${m[0]}\u0000${v}` });
  }
  working = [...working.matchAll(COMPOUND_RE)].reduce((w, m) => blank(w, m.index, m[0].length), working);
  for (const m of working.matchAll(DIGITS_RE)) {
    found.push({ index: m.index, kind: isYear(m[0]) ? "year" : "number", text: m[0] });
  }
  for (const m of working.matchAll(NUMBER_WORD_RE)) {
    const v = NUMBER_WORDS[(m[1] ?? "").toLowerCase()];
    if (v !== undefined) found.push({ index: m.index, kind: "number", text: `${m[0]}\u0000${v}` });
  }

  // 4. Names and acronyms, on the text with everything above blanked out.
  const names = findNames(original, working);

  found.sort((a, b) => a.index - b.index);
  for (const f of found) {
    if (f.kind === "reference") {
      if (!facts.tokens.includes(tokenForm(f.text))) add("reference", f.text);
    } else if (f.kind === "percentage") {
      const value = parseDigits(/\d+(?:,\d{3})*(?:\.\d+)?/.exec(f.text)?.[0] ?? "");
      if (!facts.percents.has(value)) add("percentage", f.text);
    } else if (f.kind === "year") {
      if (!facts.years.has(f.text)) add("year", f.text);
    } else {
      const [shown, valueText] = f.text.split("\u0000");
      if (valueText?.startsWith("q:")) {
        if (!facts.quantities.has(valueText.slice(2))) add("number", shown ?? f.text);
        continue;
      }
      const value = valueText === undefined ? parseDigits(shown ?? "") : Number(valueText);
      if (!facts.numbers.has(value)) add("number", shown ?? f.text);
    }
  }
  for (const n of names) {
    if (n.words.some((w) => !wordSupported(w, facts))) add("name", n.text);
  }
  return claims;
}

const STOP_WORDS = new Set([
  "that", "this", "with", "from", "have", "will", "would", "which", "their", "there", "about", "into", "your", "they", "were", "been",
  "being", "also", "more", "most", "some", "such", "than", "then", "them", "these", "those", "what", "when", "where", "while", "whose",
  "over", "under", "each", "other", "could", "should", "might", "onto", "upon", "because", "through", "during", "after", "before",
  "again", "only", "very", "just", "like", "make", "made", "many", "much", "helped", "help", "learned", "learnt", "future", "next",
  "year", "plan", "plans", "use", "used", "using", "how", "its", "our", "and", "the", "for", "are", "was", "can", "now", "own",
]);

function contentStems(text: string): string[] {
  return (foldText(text).toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((w) => !STOP_WORDS.has(w)).map((w) => w.slice(0, 5));
}

/**
 * True when `text` shares at least one meaningful word (matched on its first five letters, so "inspection" matches
 * "inspections") with the sources. Used for benefit statements, which should only be written when the notes say
 * something to support them. A false result means "check this", not "this is wrong".
 */
export function sharesContentWords(text: string, sourceTexts: readonly string[]): boolean {
  const source = new Set(sourceTexts.flatMap(contentStems));
  return contentStems(text).some((stem) => source.has(stem));
}

const KIND_LABEL: Record<UnsupportedKind, string> = {
  number: "number",
  year: "year",
  percentage: "percentage",
  reference: "standard or reference",
  name: "name",
};

/** A short, plain warning for one field, or null when nothing was found. Lists at most `max` items. */
export function claimsToWarning(fieldLabel: string, claims: readonly UnsupportedClaim[], max = 6): string | null {
  if (claims.length === 0) return null;
  const shown = claims.slice(0, max).map((c) => `"${c.text}" (${KIND_LABEL[c.kind]})`);
  const more = claims.length > max ? ` and ${claims.length - max} more` : "";
  const noun = claims.length === 1 ? "it does not" : "they do not";
  return `Check "${fieldLabel}": it mentions ${shown.join(", ")}${more}, but ${noun} appear in your notes, the title, the provider or the theme.`;
}
