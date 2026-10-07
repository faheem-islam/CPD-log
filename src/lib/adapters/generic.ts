/**
 * Fallback adapter for any web page. It is deliberately conservative.
 *
 * Reads JSON-LD (VideoObject, Event, Article, NewsArticle, BlogPosting, WebPage; @graph and arrays),
 * OpenGraph tags, meta author and description, the first h1 and the title tag.
 *  - Title: JSON-LD name or og:title is High. An h1 is High only when it plausibly matches the title
 *    tag. A title tag on its own is Check-level, with a trailing " | Site name" removed and said so.
 *  - Provider: og:site_name, publisher or author, always Check-level.
 *  - Duration: only from a VideoObject or Event in JSON-LD, or og:video:duration. Never from a word count.
 */
import { formatDuration, parseIsoDurationMinutes } from "@/lib/dates";
import type { Adapter, AdapterInput, AdapterResult, Field, SourceType } from "@/lib/types";
import type { Doc } from "./common";
import {
  MAX_PAGE_DURATION_MINUTES, attempt, cleanText, contentText, emptyResult, field, isUpcomingEvent, loadDoc, longDate, metaContent, missing,
  parseStamp, stampLengthMinutes,
} from "./common";
import type { JsonObj } from "./jsonld";
import { isArticleNode, isEventNode, isPageNode, isVideoNode, jsonLdNodes, namesOf, readEvent } from "./jsonld";
import { publishedField } from "./published";
import { pickTitle } from "./titles";
import { youtubeDurationMinutes } from "./youtube";

function providerField(doc: Doc, nodes: readonly JsonObj[]): Field<string> {
  const siteName = metaContent(doc, "meta[property='og:site_name']", "meta[name='og:site_name']");
  if (siteName) {
    return field(cleanText(siteName, 150), "low", "The page's social-sharing tags name this site (og:site_name). The site is not always the provider. Check it.");
  }
  const ordered = [...nodes.filter(isVideoNode), ...nodes.filter(isEventNode), ...nodes.filter(isArticleNode), ...nodes.filter(isPageNode)];
  for (const n of ordered) {
    const publisher = namesOf(n["publisher"])[0] ?? namesOf(n["provider"])[0] ?? namesOf(n["organizer"])[0];
    if (publisher) return field(publisher, "low", "The page's structured data names this publisher. Check it is the provider.");
  }
  for (const n of ordered) {
    const author = namesOf(n["author"])[0] ?? namesOf(n["creator"])[0];
    if (author) return field(author, "low", "The page names this author. The author is not always the provider. Check it.");
  }
  const metaAuthor = metaContent(doc, "meta[name='author' i]");
  if (metaAuthor) return field(cleanText(metaAuthor, 150), "low", "The page's author tag names this person or group. The author is not always the provider. Check it.");
  return missing("We could not find who provides this. Please enter it.");
}

/** og:video:duration is in seconds by the OpenGraph rules. An ISO duration is tolerated. */
function ogVideoMinutes(raw: string | null): number | null {
  if (!raw) return null;
  const t = raw.trim();
  if (/^P/i.test(t)) return youtubeDurationMinutes(t, MAX_PAGE_DURATION_MINUTES);
  if (!/^\d+(?:\.\d+)?$/.test(t)) return null;
  const seconds = Number(t);
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 24 * 3600) return null;
  return Math.max(1, Math.round(seconds / 60));
}

const TOO_LONG_EVIDENCE =
  "The page gives a length of more than 24 hours, which cannot be right for one resource, so we did not use it. Please enter the time you spent.";

function durationField(doc: Doc, nodes: readonly JsonObj[], ogType: string, hasArticle: boolean): Field<number> {
  // A video inside an article page is not the length of the article.
  const embedded = hasArticle || /^article\b/i.test(ogType);
  const caveat = embedded ? " The page looks like an article, so this may be only a video on it, not the whole resource. Check it." : "";
  const confidence = embedded ? "low" : "high";
  // A length the page gives that is over 24 hours is not used, and is said to have been refused.
  let refused = false;

  for (const n of nodes.filter(isVideoNode)) {
    const iso = typeof n["duration"] === "string" ? n["duration"] : null;
    const minutes = youtubeDurationMinutes(iso, MAX_PAGE_DURATION_MINUTES);
    if (minutes !== null) {
      return field(minutes, confidence, `The page's structured data says the video runs ${formatDuration(minutes)}. That is the video length, not your learning time.${caveat}`);
    }
    if (youtubeDurationMinutes(iso, Number.POSITIVE_INFINITY) !== null) refused = true;
  }
  const ogRaw = metaContent(doc, "meta[property='og:video:duration']", "meta[property='video:duration']", "meta[name='og:video:duration']");
  const og = ogVideoMinutes(ogRaw);
  if (og !== null) {
    return field(og, confidence, `The page's video tag says the video runs ${formatDuration(og)}. That is the video length, not your learning time.${caveat}`);
  }
  if (ogRaw && /^\d+(?:\.\d+)?$/.test(ogRaw.trim()) && Number(ogRaw) > MAX_PAGE_DURATION_MINUTES * 60) refused = true;
  for (const n of nodes.filter(isEventNode)) {
    const ev = readEvent(n);
    const minutes = stampLengthMinutes(parseStamp(ev.startDate), parseStamp(ev.endDate));
    if (minutes !== null) {
      return field(minutes, "low", `The page's structured data gives start and end times that make ${formatDuration(minutes)}. That is the scheduled length, not your learning time. Check it.`);
    }
    const iso = typeof n["duration"] === "string" ? n["duration"] : null;
    const declared = iso ? parseIsoDurationMinutes(iso) : null;
    if (declared !== null && declared <= MAX_PAGE_DURATION_MINUTES) {
      return field(declared, "low", `The page's structured data says the event lasts ${formatDuration(declared)}. That is the scheduled length, not your learning time. Check it.`);
    }
    if (declared !== null) refused = true;
  }
  return missing(refused ? TOO_LONG_EVIDENCE : "We could not find a length for this resource. Please enter the time you spent.");
}

const ARTICLE_OG = /^(?:article|blog|news)\b/i;

function sourceTypeField(args: {
  doc: Doc;
  nodes: readonly JsonObj[];
  ogType: string;
  headline: string;
}): Field<SourceType> {
  const { doc, nodes, ogType, headline } = args;
  const event = nodes.find(isEventNode);
  const video = nodes.find(isVideoNode);
  const article = nodes.find(isArticleNode);
  const page = nodes.find(isPageNode);

  if (event) {
    const mode = readEvent(event).mode;
    if (mode === "online") return field("webinar", "high", "The page's structured data says this is an online event.");
    if (mode === "offline") return field("live_event", "high", "The page's structured data says this event is held in person.");
    return field("live_event", "low", "The page describes an event, but we could not tell if it is online or in person. Check it.");
  }
  if (video && !article) return field("video", "high", "The page's structured data says this is a video.");
  if (/^video\b/i.test(ogType)) return field("video", "high", "The page's social-sharing tags say this is a video (og:type).");
  if (article) return field("article", "high", "The page's structured data says this is an article.");
  if (ARTICLE_OG.test(ogType)) return field("article", "high", "The page's social-sharing tags say this is an article (og:type).");

  const description = metaContent(doc, "meta[property='og:description']", "meta[name='description' i]") ?? "";
  if (/\bwebinar\b/i.test(`${headline} ${description}`)) {
    return field("webinar", "low", "The title or description mentions a webinar. Check it.");
  }
  if (metaContent(doc, "meta[property='og:video']", "meta[property='og:video:url']", "meta[property='og:video:secure_url']")) {
    return field("video", "low", "The page has a video tag, but that may be a clip on an article. Check it.");
  }
  if (page || /^website\b/i.test(ogType)) {
    return field("article", "low", "The page is a general web page, so we assumed an article. Check it.");
  }
  return missing("We could not tell what type of resource this is. Please choose one.");
}

export function extractGeneric({ html, now }: AdapterInput): AdapterResult {
  const result = emptyResult("generic");
  const doc = loadDoc(html);
  // Each step stands alone: one odd field on a page must not lose the others.
  const nodes = attempt(() => jsonLdNodes(doc), []);
  const text = attempt(() => contentText(doc), "");
  const ogType = attempt(() => metaContent(doc, "meta[property='og:type']", "meta[name='og:type']") ?? "", "");
  const siteName = attempt(() => metaContent(doc, "meta[property='og:site_name']") ?? "", "");

  result.title = attempt(() => pickTitle(doc, nodes, { trustHeading: false, siteNames: siteName ? [siteName] : [] }), result.title);
  result.provider = attempt(() => providerField(doc, nodes), result.provider);
  result.sourceType = attempt(() => sourceTypeField({ doc, nodes, ogType, headline: result.title.value ?? "" }), result.sourceType);
  result.durationMinutes = attempt(() => durationField(doc, nodes, ogType, nodes.some(isArticleNode)), result.durationMinutes);
  result.publishedAt = attempt(() => publishedField(doc, nodes, text, []), result.publishedAt);

  attempt(() => {
    const eventNode = nodes.find(isEventNode);
    if (!eventNode) return;
    const ev = readEvent(eventNode);
    const start = parseStamp(ev.startDate);
    const end = parseStamp(ev.endDate);
    if (start) {
      result.eventDate = field(start.date, "high", `The page's structured data gives the event date as ${longDate(start.date)}.`);
      result.flags.upcoming = isUpcomingEvent({ date: start.date, start, end }, now);
      if (result.flags.upcoming) result.notes.push("This event has not happened yet. Log it only after you have attended.");
    }
    if (ev.status) result.notes.push(`The page's structured data marks this event as ${ev.status}. Check before you log it.`);
  }, undefined);
  return result;
}

export const genericAdapter: Adapter = {
  id: "generic",
  specificity: 0,
  matches(): boolean {
    return true;
  },
  extract: extractGeneric,
};
