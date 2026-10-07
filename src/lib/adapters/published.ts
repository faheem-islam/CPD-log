/** Published-date reading shared by several adapters: structured data first, then tags, then a labelled date. */
import type { Field } from "@/lib/types";
import type { Doc } from "./common";
import { field, findLabelledDate, longDate, metaContent, missing, parseStamp, DEFAULT_MISSING_EVIDENCE } from "./common";
import type { JsonObj } from "./jsonld";
import { isArticleNode, isEventNode, isPageNode, isVideoNode } from "./jsonld";

const META_SELECTORS = [
  "meta[property='article:published_time']",
  "meta[itemprop='datePublished']",
  "meta[name='article:published_time']",
  "meta[name='date' i]",
  "meta[name='DC.date.issued' i]",
  "meta[name='dcterms.created' i]",
  "meta[name='publication_date' i]",
  "meta[name='publish-date' i]",
];

/**
 * The UK date of a published date or timestamp. A timestamp with a zone ("2026-06-30T23:30:00Z", which is
 * 00:30 on 1 July in the UK in summer) is converted to the UK date, the same way event dates are, so
 * the published date does not come out a day early in British Summer Time. A date with no zone is taken as written.
 */
function ukDate(input: string | null | undefined): string | null {
  return parseStamp(input)?.date ?? null;
}

/** The date a node says it was published: datePublished, or uploadDate for a video. */
export function nodePublishedIso(node: JsonObj): string | null {
  for (const key of ["datePublished", "uploadDate", "dateCreated"]) {
    const v = node[key];
    if (typeof v === "string") {
      const iso = ukDate(v);
      if (iso) return iso;
    }
  }
  return null;
}

export function publishedFromNodes(nodes: readonly JsonObj[]): string | null {
  const ordered = [
    ...nodes.filter(isVideoNode),
    ...nodes.filter(isArticleNode),
    ...nodes.filter(isPageNode),
    ...nodes.filter((n) => !isVideoNode(n) && !isArticleNode(n) && !isPageNode(n) && !isEventNode(n)),
  ];
  for (const n of ordered) {
    const iso = nodePublishedIso(n);
    if (iso) return iso;
  }
  return null;
}

export function publishedFromTags(doc: Doc): string | null {
  for (const sel of META_SELECTORS) {
    const iso = ukDate(metaContent(doc, sel));
    if (iso) return iso;
  }
  const t = doc("time[itemprop='datePublished'][datetime]").first().attr("datetime");
  const direct = ukDate(t);
  if (direct) return direct;
  // A <time> tag the page itself calls "published" or "posted", by its class or by the word just before it.
  for (const el of doc("time[datetime]").toArray().slice(0, 25)) {
    const wrapped = doc(el);
    const cls = `${wrapped.attr("class") ?? ""} ${wrapped.parent().attr("class") ?? ""}`;
    const before = wrapped.parent().text().replace(/\s+/g, " ").trim().slice(0, 40);
    if (/publish|posted|pub-?date/i.test(cls) || /^(?:first )?published\b/i.test(before)) {
      const iso = ukDate(wrapped.attr("datetime"));
      if (iso) return iso;
    }
  }
  return null;
}

/**
 * Published date as a field. High when the page states it in structured data or tags, or in a plain
 * "Published 4 March 2026" label. `labels` are the words the site puts before the date.
 */
export function publishedField(
  doc: Doc,
  nodes: readonly JsonObj[],
  text: string,
  labels: readonly string[] = ["Published", "First published", "Date published"],
): Field<string> {
  const ld = publishedFromNodes(nodes);
  if (ld) return field(ld, "high", `The page's structured data says it was published on ${longDate(ld)}.`);
  const tag = publishedFromTags(doc);
  if (tag) return field(tag, "high", `The page's tags say it was published on ${longDate(tag)}.`);
  const labelled = findLabelledDate(text, labels);
  if (labelled) return field(labelled.iso, "high", `The page says ${labelled.raw}.`);
  return missing(DEFAULT_MISSING_EVIDENCE.publishedAt);
}
