/** Title choice shared by the adapters. Careful about site names and logo headings. */
import type { Field } from "@/lib/types";
import type { Doc } from "./common";
import {
  DEFAULT_MISSING_EVIDENCE, cleanText, documentTitle, field, headingText, metaContent, missing, quote, sameTitleWords, stripSiteSuffix,
  titlesPlausiblyMatch,
} from "./common";
import type { JsonObj } from "./jsonld";
import { isArticleNode, isEventNode, isPageNode, isVideoNode, textValue } from "./jsonld";

export interface TitleOptions {
  /**
   * The site's own adapter knows its h1 is the page title, so an h1 is High even when there is no
   * title tag to compare it with. The generic adapter does not trust an h1 on its own.
   */
  trustHeading?: boolean;
  /** Site names to strip from the end of a title tag and to ignore as a heading ("ICE Knowledge Hub"). */
  siteNames?: readonly string[];
}

function nodeTitle(node: JsonObj): string | null {
  return textValue(node["name"]) ?? textValue(node["headline"]);
}

/** Title from structured data. A plain WebPage name must agree with the page's own heading or title tag. */
function structuredTitle(nodes: readonly JsonObj[], others: readonly string[]): string | null {
  for (const test of [isVideoNode, isEventNode, isArticleNode]) {
    for (const n of nodes.filter(test)) {
      const t = nodeTitle(n);
      if (t) return t;
    }
  }
  for (const n of nodes.filter(isPageNode)) {
    const t = nodeTitle(n);
    if (!t) continue;
    if (others.length === 0 || others.some((o) => titlesPlausiblyMatch(t, o))) return t;
  }
  return null;
}

export function pickTitle(doc: Doc, nodes: readonly JsonObj[], opts: TitleOptions = {}): Field<string> {
  const ogSiteName = metaContent(doc, "meta[property='og:site_name']", "meta[name='og:site_name']");
  const knownSites = [...(opts.siteNames ?? []), ...(ogSiteName ? [cleanText(ogSiteName, 150)] : [])];
  const ogRaw = metaContent(doc, "meta[property='og:title']", "meta[name='og:title']");
  const og = ogRaw ? cleanText(ogRaw) : null;
  const tagRaw = documentTitle(doc);
  const tagSplit = tagRaw ? stripSiteSuffix(tagRaw, knownSites) : null;
  const ogSplit = og ? stripSiteSuffix(og, knownSites) : null;
  const tagStripped = tagSplit?.value ?? null;

  // A heading that is only the site's name (a logo wrapped in <h1>) is not the page's title. The site's
  // name is known from the adapter, from og:site_name, or from what was cut off the end of the title.
  const siteLike = [...knownSites, tagSplit?.removed, ogSplit?.removed].filter((n): n is string => Boolean(n));
  const rawHeading = headingText(doc);
  const heading = rawHeading && !siteLike.some((n) => sameTitleWords(rawHeading, n)) ? rawHeading : null;

  // The heading is checked against the title WITHOUT the site name. Against the raw title tag a site-name
  // heading would always agree, because every word of it is in the tag.
  const comparisons = [...new Set([og, ogSplit?.value, tagStripped].filter((t): t is string => Boolean(t)))];
  const allTitles = [...comparisons, ...(tagRaw ? [tagRaw] : [])];

  const structured = structuredTitle(nodes, [...allTitles, ...(heading ? [heading] : [])]);
  if (structured) return field(structured, "high", "The page's structured data gives this title.");

  if (heading) {
    const agrees = comparisons.some((c) => titlesPlausiblyMatch(heading, c));
    if (agrees) return field(heading, "high", "The page's main heading, which matches the page's title.");
    // A site adapter knows its own h1 is the page title; a title tag worded differently is usually fine.
    if (opts.trustHeading) return field(heading, "high", "The page's main heading.");
    if (comparisons.length === 0) {
      return field(heading, "low", "Only a main heading was found, with nothing to compare it with. Check it.");
    }
  }

  if (og) return field(og, "high", "The page's social-sharing title (og:title).");

  if (tagRaw) {
    const { value, removed } = tagSplit ?? { value: tagRaw, removed: null };
    const base = heading
      ? "The page's heading and title tag disagree, so we used the title tag."
      : "Taken from the page's title tag, which often has the site name added.";
    const stripped = removed ? ` We removed "${quote(removed)}" from the end.` : "";
    return field(value, "low", `${base}${stripped} Check it.`);
  }

  if (heading) return field(heading, "low", "Only a main heading was found. Check it.");
  return missing(DEFAULT_MISSING_EVIDENCE.title);
}
