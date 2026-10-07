/**
 * YouTube adapter.
 *
 * Unlike the other adapters this one does NOT read a web page. YouTube pages are not fetched by the
 * page reader. The orchestrator (extract.ts) fetches JSON instead and hands the JSON TEXT to
 * `youtubeAdapter.extract({ url, html: <json text>, now })`:
 *   - the YouTube Data API v3 videos.list response (only when an API key is configured), or
 *   - the key-free youtube.com/oembed response.
 * The adapter works out which of the two it was given. Anything else gives an empty result with a
 * note. The two pure builders youtubeFromApi and youtubeFromOembed can be used directly.
 *
 * The API key is never seen here: it travels in a request header set by the orchestrator.
 */
import { formatDuration, parseIsoDurationMinutes } from "@/lib/dates";
import type { Adapter, AdapterInput, AdapterResult } from "@/lib/types";
import { cleanText, emptyResult, field, longDate, missing, parseStamp, safeUrl } from "./common";
import type { JsonObj } from "./jsonld";
import { isObj } from "./jsonld";

const YOUTUBE_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com",
  "youtube-nocookie.com", "www.youtube-nocookie.com",
]);
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
/** "videoseries" is exactly 11 letters but is a playlist embed, not a video. */
const NOT_VIDEO_IDS = new Set(["videoseries"]);

/**
 * The 11-character video id from watch?v=, youtu.be/, /shorts/, /embed/, /live/ and /v/ links.
 * The t= parameter and any other parameters are ignored. Look-alike hosts return null.
 */
export function parseYoutubeId(input: string | URL): string | null {
  const url = typeof input === "string" ? safeUrl(input) : input;
  if (!url) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const segments = url.pathname.split("/").filter(Boolean);
  let id: string | null | undefined = null;
  if (host === "youtu.be" || host === "www.youtu.be") {
    id = segments[0];
  } else if (YOUTUBE_HOSTS.has(host)) {
    const kind = segments[0]?.toLowerCase();
    if (kind === "watch") id = url.searchParams.get("v");
    else if (kind === "shorts" || kind === "embed" || kind === "live" || kind === "v") id = segments[1];
  }
  if (!id || !ID_RE.test(id) || NOT_VIDEO_IDS.has(id)) return null;
  return id;
}

/** The watch URL for an id. Used for the oEmbed lookup so extra parameters never reach YouTube. */
export function canonicalYoutubeUrl(id: string): string {
  return `https://www.youtube.com/watch?v=${id}`;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** The first video in a Data API response, or null when the video was not returned (private, removed). */
export function youtubeApiVideo(json: unknown): JsonObj | null {
  if (!isObj(json)) return null;
  const items = json["items"];
  if (!Array.isArray(items)) return null;
  const item = items.find((i): i is JsonObj => isObj(i) && isObj(i["snippet"]));
  return item ?? null;
}

/**
 * The longest length taken from a YouTube lookup. YouTube's own data is trusted, so this is only a sanity
 * ceiling (7 days) that keeps a malformed value such as PT99999999999999999H from becoming a number of minutes.
 * A page's own figure is held to MAX_PAGE_DURATION_MINUTES instead.
 */
export const MAX_YOUTUBE_MINUTES = 7 * 24 * 60;

/**
 * Minutes from an ISO-8601 duration, rounded to the nearest minute with a minimum of 1. Zero, invalid or
 * longer than `maxMinutes` gives null.
 */
export function youtubeDurationMinutes(iso: string | null, maxMinutes: number = MAX_YOUTUBE_MINUTES): number | null {
  if (!iso) return null;
  const minutes = parseIsoDurationMinutes(iso);
  if (minutes !== null) return Number.isFinite(minutes) && minutes <= maxMinutes ? Math.max(1, minutes) : null;
  // parseIsoDurationMinutes returns null for 0 total minutes. A short clip such as PT20S is still 1 minute.
  const validShape = /^P(?:\d+D)?(?:T(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/i.test(iso.trim());
  return validShape && /[1-9]/.test(iso) ? 1 : null;
}

const VIDEO_SOURCE_TYPE = "This is a YouTube video link.";

/** Build a result from a Data API v3 videos.list response. Fields read straight from the response are High. */
export function youtubeFromApi(json: unknown, now: Date): AdapterResult {
  const result = emptyResult("youtube");
  const video = youtubeApiVideo(json);
  if (!video) {
    result.notes.push("YouTube did not return this video. It may be private or removed.");
    return result;
  }
  const snippet = isObj(video["snippet"]) ? video["snippet"] : {};
  const details = isObj(video["contentDetails"]) ? video["contentDetails"] : {};
  const live = isObj(video["liveStreamingDetails"]) ? video["liveStreamingDetails"] : {};

  const title = str(snippet["title"]);
  if (title && cleanText(title)) result.title = field(cleanText(title), "high", "YouTube's data gives this title.");

  const channel = str(snippet["channelTitle"]);
  if (channel && cleanText(channel)) {
    result.provider = field(
      cleanText(channel, 150),
      "high",
      "YouTube's data names this channel. The channel is not always the organisation that made the video.",
    );
  }

  result.sourceType = field("video", "high", VIDEO_SOURCE_TYPE);

  // publishedAt is a UTC timestamp ("...T23:30:00Z"). The UK date of that instant is the one the user sees.
  const publishedIso = parseStamp(str(snippet["publishedAt"]))?.date ?? null;
  if (publishedIso) {
    result.publishedAt = field(publishedIso, "high", `YouTube's data says it was published on ${longDate(publishedIso)}.`);
  }

  const broadcast = str(snippet["liveBroadcastContent"]);
  const scheduled = str(live["scheduledStartTime"]);
  const scheduledMs = scheduled ? Date.parse(scheduled) : Number.NaN;
  const notStarted = !str(live["actualStartTime"]) && Number.isFinite(scheduledMs) && scheduledMs > now.getTime();
  if (broadcast === "upcoming" || notStarted) {
    result.flags.upcoming = true;
    result.notes.push("This is a live stream or premiere that has not started. Log it only after you have watched it.");
  } else if (broadcast === "live") {
    result.notes.push("This is a live stream that is on now, so YouTube gives no final length. Log it once you have watched it.");
  }

  const minutes = youtubeDurationMinutes(str(details["duration"]));
  if (minutes !== null) {
    result.durationMinutes = field(
      minutes,
      "high",
      `YouTube's data says the video runs ${formatDuration(minutes)}. That is the video length, not your learning time.`,
    );
  } else {
    result.durationMinutes = missing(
      "YouTube gives no length for this video yet. It may be a live stream or a premiere. Please enter the time you spent.",
    );
  }
  return result;
}

/** Build a result from the key-free oEmbed response. oEmbed has no length or date, so those are missing. */
export function youtubeFromOembed(json: unknown): AdapterResult {
  const result = emptyResult("youtube");
  if (!isObj(json)) {
    result.notes.push("YouTube's lookup did not return anything we could read.");
    return result;
  }
  const title = str(json["title"]);
  if (title && cleanText(title)) result.title = field(cleanText(title), "high", "YouTube's lookup gives this title.");
  const author = str(json["author_name"]);
  if (author && cleanText(author)) {
    result.provider = field(
      cleanText(author, 150),
      "high",
      "YouTube's lookup names this channel. The channel is not always the organisation that made the video.",
    );
  }
  result.sourceType = field("video", "high", VIDEO_SOURCE_TYPE);
  result.durationMinutes = missing("YouTube's key-free lookup doesn't give the length. Please enter it.");
  result.publishedAt = missing("YouTube's key-free lookup doesn't give the published date.");
  return result;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Tells a Data API response from an oEmbed response. */
export function youtubeJsonKind(json: unknown): "api" | "oembed" | null {
  if (!isObj(json)) return null;
  if (Array.isArray(json["items"]) || json["kind"] === "youtube#videoListResponse") return "api";
  if (typeof json["title"] === "string" || typeof json["author_name"] === "string") return "oembed";
  return null;
}

export const youtubeAdapter: Adapter = {
  id: "youtube",
  specificity: 100,
  matches(url: URL): boolean {
    return parseYoutubeId(url) !== null;
  },
  /** `html` must be the JSON text of a Data API or oEmbed response, not a web page. See the file header. */
  extract({ html, now }: AdapterInput): AdapterResult {
    const json = parseJson(html);
    const kind = youtubeJsonKind(json);
    if (kind === "api") return youtubeFromApi(json, now);
    if (kind === "oembed") return youtubeFromOembed(json);
    const result = emptyResult("youtube");
    result.notes.push("YouTube's lookup did not return anything we could read.");
    return result;
  },
};
