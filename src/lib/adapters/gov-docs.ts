/**
 * Government and standards documents: gov.uk, legislation.gov.uk and standardsforhighways.co.uk.
 *
 * Reading time is an ESTIMATE, and only when the page itself holds the document text. A page that
 * merely links to attachments (a gov.uk /government/publications/... landing page, a Standards for
 * Highways page with a PDF download) has no readable length, so the duration is missing and the
 * evidence says why. Nothing is guessed from PDF links. Only the attachment areas of the page count as
 * attachments (not a PDF link in a toolbar, header or the body text), and legislation.gov.uk pages are
 * never treated as landing pages: a section page holds its text.
 *
 * The CSS selectors here are hand-written best guesses used with hand-written fixtures. They have not
 * been checked against the live sites.
 */
import type { Adapter, AdapterInput, AdapterResult, Field, SourceType } from "@/lib/types";
import { contains } from "cheerio";
import type { AnyNode } from "domhandler";
import type { Doc, Sel } from "./common";
import {
  DEFAULT_MISSING_EVIDENCE, MAX_HTML_CHARS, cleanText, clip, contentText, emptyResult, field, findLabelledDate, hostMatches, isInsideAny,
  loadDoc, longDate, measureText, missing, normSpace, pathSegments, quote, safeUrl,
} from "./common";
import type { JsonObj } from "./jsonld";
import { jsonLdNodes } from "./jsonld";
import { publishedField } from "./published";
import { pickTitle } from "./titles";

export type GovKind = "govuk" | "legislation" | "sfh";

export const WORDS_PER_MINUTE = 200;
/** With attachments present, a page with fewer words than this is treated as a landing page. */
export const LANDING_MAX_WORDS = 800;
/** Below this many words there is not enough text to give a reading time. */
export const MIN_ESTIMATE_WORDS = 50;

export const LEGISLATION_PROVIDER = "The National Archives (legislation.gov.uk)";
export const SFH_PROVIDER = "National Highways (Standards for Highways)";

export function govKindFor(url: URL): GovKind | null {
  if (hostMatches(url.hostname, "legislation.gov.uk", false)) return "legislation";
  if (hostMatches(url.hostname, "standardsforhighways.co.uk", false)) return "sfh";
  if (hostMatches(url.hostname, "gov.uk", false)) return "govuk";
  return null;
}

const SITE_NAMES = ["GOV.UK", "legislation.gov.uk", "Standards for Highways", "National Highways", "The National Archives"];

const NOISE_SELECTORS = [
  "nav", "aside", "header", "footer", "form", "[role='navigation']", "[role='banner']", "[role='contentinfo']",
  "[class*='attachment' i]", "[class*='metadata' i]", "[class*='contents-list' i]", "[class*='breadcrumb' i]",
  "[class*='print-link' i]", "[class*='cookie' i]", "[class*='share' i]", "[class*='toolbar' i]", "[class*='menu' i]",
  "[class*='pagination' i]", "[class*='feedback' i]",
].join(", ");

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function bodySelection(doc: Doc, kind: GovKind): Sel | null {
  const candidates: string[] =
    kind === "govuk"
      ? [".govspeak"]
      : kind === "legislation"
        ? ["#viewLegContents", ".LegContent", "#content", "main", "article"]
        : ["main", "article", "#content", "[role='main']"];
  for (const sel of candidates) {
    const found = doc(sel);
    if (found.length > 0) return found;
  }
  return null;
}

/** Elements that hold running text. Short list items (menus, link lists) are filtered out by length. */
const PROSE_SELECTOR = "p, li, blockquote, dd, td";
const MIN_PROSE_WORDS = 8;
const MIN_PROSE_BLOCKS = 3;
/**
 * Words are counted from text that is never cut short: the HTML is capped at MAX_HTML_CHARS and the text of
 * a page cannot be longer than its HTML, so this limit is never reached. (The usual text cap would count
 * only the first 500,000 characters of a long document and print that figure as the page's word count.)
 */
const WORD_COUNT_TEXT_LIMIT = MAX_HTML_CHARS * 4;

interface WordCount {
  words: number;
  /** True when the text was cut short, so `words` is only a lower bound. */
  cut: boolean;
}

/**
 * For a gov.uk page without a .govspeak body: the words in running-text blocks inside <main>, so that a
 * page of links (a browse or topic page) is not mistaken for a document. Null when there is too little prose.
 */
function proseWordCount(doc: Doc): WordCount | null {
  const root = doc("main, [role='main'], #content").first();
  if (root.length === 0) return null;
  const skip = new Set(doc(NOISE_SELECTORS).toArray());
  const rootEl = root.get(0);
  skip.delete(rootEl as AnyNode);
  let words = 0;
  let blocks = 0;
  let cut = false;
  for (const el of doc(PROSE_SELECTOR).toArray()) {
    if (!contains(rootEl as AnyNode, el) || isInsideAny(el, skip)) continue;
    // A block inside another prose block (a <p> in an <li>) would be counted twice.
    if (el.parent && "name" in el.parent && /^(?:li|blockquote|dd|td)$/i.test(el.parent.name)) continue;
    const measured = measureText(doc, doc(el), undefined, WORD_COUNT_TEXT_LIMIT);
    const n = countWords(measured.text);
    if (measured.truncated) cut = true;
    if (n >= MIN_PROSE_WORDS) {
      words += n;
      blocks += 1;
    }
  }
  return blocks >= MIN_PROSE_BLOCKS ? { words, cut } : null;
}

function bodyWordCount(doc: Doc, kind: GovKind): WordCount | null {
  const sel = bodySelection(doc, kind);
  if (sel) {
    const measured = measureText(doc, sel, NOISE_SELECTORS, WORD_COUNT_TEXT_LIMIT);
    return { words: countWords(measured.text), cut: measured.truncated };
  }
  return kind === "govuk" ? proseWordCount(doc) : null;
}

const FILE_EXTENSION = /\.(?:pdf|docx?|xlsx?|xlsm|ods|odt|odp|csv|zip|pptx?|rtf)$/i;

/** Parts of a page whose links are not the document's own files: menus, toolbars, sharing, the page header and footer. */
const NOT_ATTACHMENT_AREAS = [
  "nav", "aside", "header", "footer", "form", "[role='navigation']", "[role='banner']", "[role='contentinfo']", "[role='complementary']",
  "[class*='toolbar' i]", "[class*='menu' i]", "[class*='breadcrumb' i]", "[class*='share' i]", "[class*='print' i]",
  "[class*='cookie' i]", "[class*='feedback' i]", "[class*='pagination' i]",
].join(", ");

/**
 * Number of separate downloadable files the page links to or lists as attachments. Only the page's content
 * area counts (<main>, #content or the body), and not its toolbars, menus, header, footer or sidebars.
 * `ignoreInside` is a selector for the document text itself (".govspeak"): a link to a form inside the
 * text is a link in the text, not an attachment of the page.
 */
export function countAttachments(doc: Doc, ignoreInside?: string): number {
  const rootSel = doc("main, [role='main'], #content").first();
  const bodySel = doc("body").first();
  const rootNode = (rootSel.length > 0 ? rootSel : bodySel).get(0) ?? null;
  const skip = new Set(doc(ignoreInside ? `${NOT_ATTACHMENT_AREAS}, ${ignoreInside}` : NOT_ATTACHMENT_AREAS).toArray());
  if (rootNode) skip.delete(rootNode); // a body class such as "menu-open" must not hide the whole page
  const inArea = (el: AnyNode): boolean => (rootNode === null || contains(rootNode, el)) && !isInsideAny(el, skip, rootNode);

  const files = new Set<string>();
  for (const el of doc("a[href]").toArray()) {
    if (!inArea(el)) continue;
    const href = (doc(el).attr("href") ?? "").split(/[?#]/)[0] ?? "";
    const label = normSpace(doc(el).text());
    if (FILE_EXTENSION.test(href) || /(?:^|\/)download(?:\/|$)/i.test(href) || /^(?:download|view|open)\b.*\b(?:pdf|document)\b/i.test(label)) {
      files.add(href || label);
    }
  }
  if (files.size > 0) return files.size;
  return doc("section[class*='attachment' i], div[class*='attachment' i]")
    .filter((_, el) => inArea(el) && !doc(el).find("[class*='attachment' i]").length)
    .length;
}

const MSG_TOO_LONG =
  "This page is very long, so we could only read part of it and cannot count its words. We have not guessed a reading time. Please enter the time you spent.";

function readingTimeField(doc: Doc, kind: GovKind, url: URL | null, maybeCut: boolean): Field<number> {
  const segments = url ? pathSegments(url).map((s) => s.toLowerCase()) : [];

  // "contents", "contents/made" and "contents/enacted" are all tables of contents.
  if (kind === "legislation" && segments.includes("contents")) {
    return missing(
      "This is a contents page for a piece of legislation. Its length cannot be read from here. Open a section and paste that link, or enter the time you spent.",
    );
  }
  const counted = bodyWordCount(doc, kind);
  if (counted === null) {
    return missing("We could not find the main text on this page, so there is no reading time. Please enter the time you spent.");
  }
  // A count of part of a long document would print a word count that is not the document's.
  if (counted.cut || maybeCut) return missing(MSG_TOO_LONG);
  const { words } = counted;
  // A section of legislation holds its own text, so a link to a PDF version does not make it a landing page.
  const attachments = kind === "legislation" ? 0 : countAttachments(doc, kind === "govuk" ? ".govspeak" : undefined);
  if (attachments > 0 && words < LANDING_MAX_WORDS) {
    const files = `${attachments} file${attachments === 1 ? "" : "s"}`;
    return missing(
      `This looks like a landing page for a document: it links to ${files} and has little text of its own. The length of the document cannot be read from this page. Please enter the time you spent.`,
    );
  }
  if (words < MIN_ESTIMATE_WORDS) {
    return missing("There is too little text on this page to estimate a reading time. Please enter the time you spent.");
  }
  const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  return field(
    minutes,
    "estimate",
    `About ${words} words at ${WORDS_PER_MINUTE} words a minute. This estimates reading time, not learning time.`,
  );
}

// ---------------------------------------------------------------------------------------------
// Publisher
// ---------------------------------------------------------------------------------------------

const PUBLISHER_NAME_MAX = 120;
const PUBLISHER_MAX = 300;
const MAX_PUBLISHERS = 4;

function govukPublisher(doc: Doc, text: string): Field<string> {
  const orgs: string[] = [];
  // Every name from the page is cleaned and clipped: control and direction-changing characters are
  // removed and the response stays small, whatever the page puts after "From:".
  const add = (raw: string) => {
    const name = cleanText(raw, PUBLISHER_NAME_MAX);
    if (name && !orgs.includes(name)) orgs.push(name);
  };
  doc("dt").each((_, el) => {
    if (orgs.length >= MAX_PUBLISHERS) return;
    if (!/^from:?$/i.test(normSpace(doc(el).text()))) return;
    const dd = doc(el).nextAll("dd").first();
    const links = dd.find("a").toArray().slice(0, MAX_PUBLISHERS * 2).map((a) => doc(a).text()).filter((t) => normSpace(t));
    for (const n of links.length > 0 ? links : [dd.text()]) add(n);
  });
  if (orgs.length === 0) {
    const m = /\bFrom:\s*(.{2,150}?)(?=\s+(?:First published|Published|Last updated|Part of|Contents|Documents|Applies to|Topic|Collection)\b|$)/.exec(text);
    if (m?.[1]) add(m[1]);
  }
  if (orgs.length > 0) {
    return field(clip(orgs.slice(0, MAX_PUBLISHERS).join(", "), PUBLISHER_MAX), "high", "The page's \"From:\" line names this organisation.");
  }
  return field(
    "GOV.UK",
    "low",
    "The page has no \"From:\" organisation, so we used the website name. Check who published it.",
  );
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

const UPDATED_LABELS = ["Last updated", "Last modified", "Last reviewed", "Updated", "Revised"];
const ENACTMENT_LABELS = ["Enactment date", "Date of enactment", "Made"];

function lastUpdated(text: string): { iso: string; raw: string } | null {
  return findLabelledDate(text, UPDATED_LABELS);
}

function datesFor(doc: Doc, nodes: readonly JsonObj[], text: string, kind: GovKind, result: AdapterResult): void {
  const labels = kind === "govuk" ? ["First published", "Published"] : ["First published", "Published", "Publication date", "Date published", "Issued"];
  let published = publishedField(doc, nodes, text, labels);
  const updated = lastUpdated(text);

  if (published.value === null && kind === "legislation") {
    const enacted = findLabelledDate(text, ENACTMENT_LABELS);
    if (enacted) {
      published = field(
        enacted.iso,
        "low",
        `The page says "${quote(enacted.raw)}". That is when the law was made, not when this web version was published. Check it.`,
      );
    }
  }
  if (published.value !== null) {
    if (updated && updated.iso !== published.value) {
      published = { ...published, evidence: `${published.evidence} It was last updated on ${longDate(updated.iso)}.` };
      result.notes.push(`Last updated ${longDate(updated.iso)}. The log uses the first published date.`);
    }
    result.publishedAt = published;
    return;
  }
  if (updated) {
    result.publishedAt = missing(
      `The page gives a last updated date (${longDate(updated.iso)}) but no first published date. Please enter the date if you need it.`,
    );
    result.notes.push(`Last updated ${longDate(updated.iso)}.`);
  } else {
    result.publishedAt = missing(DEFAULT_MISSING_EVIDENCE.publishedAt);
  }
}

// ---------------------------------------------------------------------------------------------
// Source type
// ---------------------------------------------------------------------------------------------

function sourceTypeField(kind: GovKind, url: URL | null): Field<SourceType> {
  const path = url ? url.pathname.toLowerCase() : "";
  if (kind === "legislation") return field("document", "high", "legislation.gov.uk publishes legislation, which is a document.");
  if (kind === "sfh") {
    if (/\/(?:news|blog|events?)\b/.test(path)) return field("article", "low", "This looks like a news or blog page on the Standards for Highways site, so we assumed an article. Check it.");
    return field("document", "high", "The Standards for Highways site publishes standards and documents.");
  }
  if (path.includes("/government/publications/")) {
    return field("document", "high", "The web address has /government/publications/, which GOV.UK uses for published documents.");
  }
  if (path.startsWith("/guidance/")) {
    return field("article", "low", "GOV.UK guidance is written as web pages, so we assumed an article. Check it.");
  }
  return field("article", "low", "We could not tell what type of GOV.UK page this is, so we assumed an article. Check it.");
}

// ---------------------------------------------------------------------------------------------

export function extractGovDoc({ url, html }: AdapterInput): AdapterResult {
  const result = emptyResult("gov-docs");
  const parsed = safeUrl(url);
  const kind = parsed ? govKindFor(parsed) : null;
  if (!kind) {
    result.notes.push("This is not a gov.uk, legislation.gov.uk or standardsforhighways.co.uk page.");
    return result;
  }
  const doc = loadDoc(html);
  const nodes = jsonLdNodes(doc);
  const text = contentText(doc);

  result.title = pickTitle(doc, nodes, { trustHeading: true, siteNames: SITE_NAMES });
  if (kind === "legislation") {
    result.provider = field(LEGISLATION_PROVIDER, "high", "From the site: legislation.gov.uk is run by The National Archives.");
  } else if (kind === "sfh") {
    result.provider = field(SFH_PROVIDER, "high", "From the site: Standards for Highways is published by National Highways.");
  } else {
    result.provider = govukPublisher(doc, text);
  }
  result.sourceType = sourceTypeField(kind, parsed);
  // HTML at or over the cap may have been cut, and a count of part of a document is not its length.
  result.durationMinutes = readingTimeField(doc, kind, parsed, html.length >= MAX_HTML_CHARS);
  datesFor(doc, nodes, text, kind, result);
  return result;
}

export const govDocsAdapter: Adapter = {
  id: "gov-docs",
  specificity: 50,
  matches(url: URL): boolean {
    return govKindFor(url) !== null;
  },
  extract: extractGovDoc,
};
