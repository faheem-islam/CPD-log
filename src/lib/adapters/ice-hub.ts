/**
 * ICE Knowledge Hub (knowledgehub.ice.org.uk).
 *
 * Content type, duration, title and published date come from the page. The Duration is read from the
 * resource's own part of the page (the article that holds the heading), not from a related-resources card,
 * a featured block or a sidebar, which describe other resources. The THEME comes from the web
 * address only: /cpd/<slug>/ is looked up in PROFILES.ice.themeSlugs. Only an exact slug is High; any
 * other known slug is a Check-level guess that says so; an unknown slug gives no theme.
 *
 * The selectors and label wording below are hand-written guesses tested only against hand-written
 * fixtures. They have not been checked against the live site.
 */
import { parseDurationMinutes } from "@/lib/dates";
import { PROFILES } from "@/lib/profiles";
import type { Adapter, AdapterInput, AdapterResult, Field, SourceType } from "@/lib/types";
import { contains } from "cheerio";
import type { Doc, Sel } from "./common";
import {
  contentText, emptyResult, field, hostMatches, isInsideAny, loadDoc, missing, normSpace, pathSegments, quote, safeUrl, textOf,
} from "./common";
import { jsonLdNodes } from "./jsonld";
import { publishedField } from "./published";
import { pickTitle } from "./titles";

export const ICE_PROVIDER_NAME = "Institution of Civil Engineers (ICE)";
const ICE_SITE_NAMES = ["ICE Knowledge Hub", "Knowledge Hub", "ICE", "Institution of Civil Engineers", ICE_PROVIDER_NAME];

/** Theme from the /cpd/<slug>/ part of the web address. Pure; exported for tests. */
export function themeFromIcePath(url: URL): Field<string> {
  const segments = pathSegments(url).map((s) => s.toLowerCase());
  const at = segments.indexOf("cpd");
  if (at < 0) return missing("The web address has no /cpd/ section, so we could not suggest a theme. Please choose one.");
  const slug = segments[at + 1];
  if (!slug) return missing("The web address stops at /cpd/ with no theme after it, so we could not suggest a theme. Please choose one.");
  // hasOwn: a slug such as "constructor" or "__proto__" must not read from Object.prototype.
  const entry = Object.hasOwn(PROFILES.ice.themeSlugs, slug) ? PROFILES.ice.themeSlugs[slug] : undefined;
  if (!entry) {
    return missing(`The web address has /cpd/${quote(slug)}/, which we do not recognise as an ICE theme. Please choose the theme yourself.`);
  }
  if (entry.exact) {
    return field(entry.theme, "high", `The web address has /cpd/${slug}/, which ICE uses for the ${entry.theme} theme.`);
  }
  return field(
    entry.theme,
    "low",
    `Guessed from the web address (/cpd/${slug}/). ICE's theme names may not match this word, so check it against ICE's themes.`,
  );
}

interface TypeRule {
  re: RegExp;
  type: SourceType;
}
/** Order matters: the first rule that matches the label wins. */
const TYPE_RULES: TypeRule[] = [
  { re: /\b(?:webinar|on[- ]?demand|recording)\b/i, type: "webinar" },
  { re: /\b(?:video|film|animation)\b/i, type: "video" },
  { re: /\b(?:event|conference|course|workshop|seminar)\b/i, type: "live_event" },
  { re: /\b(?:podcast|audio)\b/i, type: "other" },
  {
    re: /\b(?:guide|guidance|report|standard|specification|manual|paper|policy|white ?paper|checklist|toolkit|template|fact ?sheet|handbook|briefing|publication|document|code of practice)\b/i,
    type: "document",
  },
  { re: /\b(?:explainer|case study|article|blog|news|opinion|interview|feature|comment)\b/i, type: "article" },
];

export function mapContentType(label: string): SourceType | null {
  for (const rule of TYPE_RULES) if (rule.re.test(label)) return rule.type;
  return null;
}

const TYPE_SELECTORS = [
  "[class*='content-type' i]",
  "[class*='contenttype' i]",
  "[class*='resource-type' i]",
  "[class*='resourcetype' i]",
  "[data-content-type]",
  "[data-resource-type]",
].join(", ");

const TYPE_LABEL_RE =
  /\b(?:content type|resource type|type of content|type)\s*[:\-–]\s*([A-Za-z]+(?:\s+(?!(?:Duration|Published|Date|Author|Theme|Topic|Share|Read)\b)[A-Za-z]+){0,2})/i;

/** A whole element that is just a content-type word, e.g. a badge placed before the heading. */
const BARE_TYPE_RE =
  /^(?:explainer|guide|guidance|case study|webinar|video|article|report|podcast|briefing|news|blog|opinion|interview|toolkit|checklist|factsheet|fact sheet|event|course|publication|document)$/i;

function labelBeforeHeading(doc: Doc): string | null {
  const h1 = doc("h1").first();
  if (h1.length === 0) return null;
  for (const el of [h1.prevAll().first(), h1.parent().prevAll().first(), h1.parent().children().first()]) {
    if (el.length === 0) continue;
    const t = normSpace(textOf(doc, el));
    if (t.length <= 25 && BARE_TYPE_RE.test(t)) return t;
  }
  return null;
}

function contentTypeLabel(doc: Doc, text: string): string | null {
  for (const el of doc(TYPE_SELECTORS).toArray()) {
    const wrapped = doc(el);
    const attr = wrapped.attr("data-content-type") ?? wrapped.attr("data-resource-type");
    const candidate = normSpace(attr ?? textOf(doc, wrapped)).replace(/^(?:content type|resource type)\s*[:\-–]?\s*/i, "");
    if (candidate && candidate.length <= 40) return candidate;
  }
  const m = TYPE_LABEL_RE.exec(text);
  if (m?.[1]) return normSpace(m[1]);
  return labelBeforeHeading(doc);
}

function sourceTypeField(doc: Doc, text: string): Field<SourceType> {
  const label = contentTypeLabel(doc, text);
  if (label) {
    const mapped = mapContentType(label);
    if (mapped) return field(mapped, "high", `The page labels this as "${quote(label)}".`);
    return field(
      "article",
      "low",
      `The page labels this as "${quote(label)}", which we do not recognise. We assumed an article. Check it.`,
    );
  }
  return field("article", "low", "The page does not say what type of resource this is, so we assumed an article. Check it.");
}

const DURATION_VALUE =
  String.raw`(?:\d+(?:\.\d+)?\s*(?:hours?|hrs?|h)(?![a-z])\.?\s*)?(?:\d+\s*(?:minutes?|mins?|m)(?![a-z]))?`;
const DURATION_LABELLED_RE = new RegExp(String.raw`\bDuration\b\s*[:\-–]?\s*(${DURATION_VALUE})`, "gi");
const DURATION_ONLY_RE = new RegExp(String.raw`^(?:Duration\s*[:\-–]?\s*)?(${DURATION_VALUE})$`, "i");

/** The longest Duration taken from a hub page. A longer one is a typing mistake or not a length at all. */
export const MAX_HUB_DURATION_MINUTES = 40 * 60;

/** Parts of a page that describe OTHER resources or the site, whose Duration is not this resource's. */
const NOT_THIS_RESOURCE = [
  "aside", "nav", "footer", "[role='navigation']", "[role='contentinfo']", "[role='complementary']",
  "[class*='related' i]", "[class*='card' i]", "[class*='featured' i]", "[class*='recommend' i]", "[class*='similar' i]",
].join(", ");

const MSG_DURATION_MISSING =
  "We could not read a length: there is no Duration label we could find on this page. Please enter the time you spent.";
const MSG_DURATION_TOO_LONG =
  "The page gives a Duration of more than 40 hours, which cannot be right for one resource, so we did not use it. Please enter the time you spent.";

/**
 * The Duration of THIS resource. It is looked for in the part of the page that holds the main heading (the
 * <article>, else <main>), leaving out related-resource cards, featured blocks and sidebars. Only when it is
 * not there is the rest of the page searched, and a length found there is Check, not High.
 */
function durationField(doc: Doc): Field<number> {
  const body = doc("body").first();
  const wholePage: Sel = body.length > 0 ? body : doc.root();
  const h1 = doc("h1").first();
  const near = h1.length > 0 ? h1.closest("article, [role='main'], main").first() : h1;
  const scope: Sel = near.length > 0 ? near : wholePage;
  const skip = new Set(doc(NOT_THIS_RESOURCE).toArray());
  let tooLong = false;

  const search = (root: Sel, outside: boolean): Field<number> | null => {
    const rootNode = root.get(0) ?? null;
    const accept = (value: string | undefined): { value: string; minutes: number } | null => {
      const minutes = value ? parseDurationMinutes(value) : null;
      if (!value || minutes === null) return null;
      if (minutes > MAX_HUB_DURATION_MINUTES) {
        tooLong = true;
        return null;
      }
      return { value, minutes };
    };
    const found = (value: string, minutes: number, said: string): Field<number> =>
      outside
        ? field(minutes, "low", `The page says ${said}, but not in the main part of the page. Check it is this resource's length.`)
        : field(minutes, "high", `The page says ${said}.`);

    // 1. An element whose class says it is the duration ("<span class='duration'>15m</span>").
    for (const el of doc("[class*='duration' i]").toArray()) {
      if (rootNode && !contains(rootNode, el)) continue;
      if (isInsideAny(el, skip, rootNode)) continue;
      const t = normSpace(textOf(doc, doc(el)));
      if (!t || t.length > 30) continue;
      const hit = accept(DURATION_ONLY_RE.exec(t)?.[1]?.trim());
      if (hit) return found(hit.value, hit.minutes, `Duration ${hit.value}`);
    }
    // 2. The words "Duration 15m" in the text of that part of the page.
    const text = textOf(doc, root, NOT_THIS_RESOURCE);
    const re = new RegExp(DURATION_LABELLED_RE.source, DURATION_LABELLED_RE.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const hit = accept(m[1]?.trim());
      if (hit) return found(hit.value, hit.minutes, normSpace(m[0]));
    }
    return null;
  };

  const inScope = search(scope, false);
  if (inScope) return inScope;
  if (scope !== wholePage) {
    const elsewhere = search(wholePage, true);
    if (elsewhere) return elsewhere;
  }
  return missing(tooLong ? MSG_DURATION_TOO_LONG : MSG_DURATION_MISSING);
}

export function extractIceHub({ url, html }: AdapterInput): AdapterResult {
  const result = emptyResult("ice-hub");
  const parsed = safeUrl(url);
  const doc = loadDoc(html);
  const nodes = jsonLdNodes(doc);
  const text = contentText(doc);

  result.title = pickTitle(doc, nodes, { trustHeading: true, siteNames: ICE_SITE_NAMES });
  result.provider = field(ICE_PROVIDER_NAME, "high", "From the site: the Knowledge Hub is run by the Institution of Civil Engineers.");
  result.sourceType = sourceTypeField(doc, text);
  result.durationMinutes = durationField(doc);
  result.publishedAt = publishedField(doc, nodes, text);
  if (parsed) result.theme = themeFromIcePath(parsed);
  return result;
}

export const iceHubAdapter: Adapter = {
  id: "ice-hub",
  specificity: 60,
  matches(url: URL): boolean {
    return hostMatches(url.hostname, "knowledgehub.ice.org.uk", false);
  },
  extract: extractIceHub,
};
