/**
 * The extraction orchestrator: link in, small ExtractResponse out.
 *
 * What it does, in order:
 *  1. Trims and normalises the link. Empty or unusable input gives status "unsafe_url" and a plain message.
 *  2. Looks in a short in-memory cache (10 minutes). The cache holds the extraction result only, never a page body.
 *  3. YouTube links never go through the page reader. With a YouTube API key it calls the Data API
 *     v3 (the key goes in the x-goog-api-key HEADER, never in the URL). Without a key, or if that call
 *     fails, it uses the key-free oEmbed endpoint. If both fail the status is "failed".
 *  4. Everything else is read by deps.reader. A reader outcome that is not ok is passed straight back
 *     as the response status and message, with result null. For ok pages every matching adapter plus
 *     the generic one runs, and the results are merged. Only the first MAX_HTML_CHARS of a page are read,
 *     the page is parsed once for all the adapters, and a page nested absurdly deep is refused before it is
 *     parsed (parsing and searching such a page takes minutes and blocks the server for everybody).
 *
 * It never returns a page body. It never logs, returns or stores the API key, and error messages do
 * not contain it. It does not retry anything to get round a block.
 */
import type { ApiFetcher, ApiOutcome, PageReader, ReadOutcome } from "@/lib/net/types";
import type { AdapterResult, DraftFieldKey, ExtractResponse, ExtractStatus } from "@/lib/types";
import { isFound, MAX_HTML_CHARS, withParsedPage } from "@/lib/adapters/common";
import { mergeResults } from "@/lib/adapters/merge";
import { isTooDeeplyNested } from "@/lib/adapters/nesting";
import { SPECIFICITY_BY_ID, selectAdapters } from "@/lib/adapters/registry";
import {
  canonicalYoutubeUrl, parseYoutubeId, youtubeApiVideo, youtubeFromApi, youtubeFromOembed, youtubeJsonKind,
} from "@/lib/adapters/youtube";

export const EXTRACT_CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const MAX_URL_CHARS = 2048;

export interface ExtractCacheEntry {
  storedAt: number;
  response: ExtractResponse;
}
export type ExtractCache = Map<string, ExtractCacheEntry>;

/** Used when the caller does not pass its own cache. One per server process. */
export const sharedExtractCache: ExtractCache = new Map();

export interface ExtractDeps {
  reader: PageReader;
  api: ApiFetcher;
  /** Optional. Sent only in the x-goog-api-key header. */
  youtubeApiKey?: string;
  /** Injectable clock, for the cache and for "is this event in the future". */
  now?: () => Date;
  cache?: ExtractCache;
}

// ---------------------------------------------------------------------------------------------
// URL normalisation
// ---------------------------------------------------------------------------------------------

export type NormalisedUrl =
  | { ok: true; url: URL; href: string }
  | { ok: false; message: string; echo: string };

const MSG_EMPTY = "Paste a link to a web page, for example https://www.example.com/article.";
const MSG_GARBAGE = "That does not look like a web link. Paste the full address of the page, for example https://www.example.com/article.";
const MSG_SCHEME = "Only web links that start with http:// or https:// can be read. Paste the web address of the page instead.";
const MSG_CREDENTIALS = "The link has a username or password in it. Remove that part and try again.";
const MSG_SPACES = "That looks like more than one link, or the link has a space in it. Paste just the web address of the page.";
const MSG_LONG = "That link is too long (over 2,000 characters). Paste the shorter web address of the page.";

const WRAPPERS: [string, string][] = [["<", ">"], ['"', '"'], ["'", "'"], ["(", ")"], ["“", "”"], ["‘", "’"]];

function unwrap(s: string): string {
  for (const [open, close] of WRAPPERS) {
    if (s.length > 2 && s.startsWith(open) && s.endsWith(close)) return s.slice(1, -1).trim();
  }
  return s;
}

/** What may be sent back in the response's url field when the input was rejected. Never a script link. */
function safeEcho(trimmed: string): string {
  if (/^https?:\/\//i.test(trimmed) || /^www\./i.test(trimmed) || !trimmed.includes(":")) return trimmed.slice(0, MAX_URL_CHARS);
  return "";
}

function plausibleHost(host: string): boolean {
  if (host.startsWith("[") && host.endsWith("]")) return true; // IPv6 literal; the reader's safety check decides
  const labels = host.replace(/\.$/, "").split(".");
  if (labels.length < 2 || labels.some((l) => l.length === 0)) return false;
  const tld = labels[labels.length - 1] ?? "";
  return /^(?:[a-z]{2,}|xn--[a-z0-9-]+|\d+)$/i.test(tld);
}

/**
 * Turns what the user pasted into one http(s) URL. "www.x.com/y" becomes https://www.x.com/y.
 * The #fragment is dropped. Everything else, including the query string, is kept as typed.
 */
export function normaliseUserUrl(input: unknown): NormalisedUrl {
  if (typeof input !== "string") return { ok: false, message: MSG_EMPTY, echo: "" };
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, message: MSG_EMPTY, echo: "" };
  let s = unwrap(trimmed);
  const echo = safeEcho(trimmed);
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(s)) return { ok: false, message: MSG_SPACES, echo };
  if (s.length > MAX_URL_CHARS) return { ok: false, message: MSG_LONG, echo: "" };

  s = s.replace(/^(https?):\/(?=[^/])/i, "$1://");
  if (s.startsWith("//")) s = `https:${s}`;
  else if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    if (/^(?:javascript|data|file|mailto|tel|ftp|blob|about|vbscript|sms|chrome|view-source):/i.test(s)) {
      return { ok: false, message: MSG_SCHEME, echo };
    }
    s = `https://${s}`;
  }

  let url: URL;
  try {
    url = new URL(s);
  } catch {
    return { ok: false, message: MSG_GARBAGE, echo };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, message: MSG_SCHEME, echo };
  if (url.username || url.password) return { ok: false, message: MSG_CREDENTIALS, echo: "" };
  if (!url.hostname || !plausibleHost(url.hostname)) return { ok: false, message: MSG_GARBAGE, echo };
  url.hash = "";
  return { ok: true, url, href: url.href };
}

// ---------------------------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------------------------

function cloneResponse(r: ExtractResponse): ExtractResponse {
  return structuredClone(r);
}

function readCache(cache: ExtractCache, key: string, nowMs: number): ExtractResponse | null {
  const hit = cache.get(key);
  if (!hit) return null;
  const age = nowMs - hit.storedAt;
  if (age < 0 || age >= EXTRACT_CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return { ...cloneResponse(hit.response), cached: true };
}

function writeCache(cache: ExtractCache, key: string, response: ExtractResponse, nowMs: number): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    for (const [k, v] of cache) {
      if (nowMs - v.storedAt >= EXTRACT_CACHE_TTL_MS) cache.delete(k);
    }
    while (cache.size >= MAX_CACHE_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }
  // Only the small extraction result is stored. A page body never reaches this function.
  cache.set(key, { storedAt: nowMs, response: { ...cloneResponse(response), cached: false } });
}

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

const FIELD_LABELS: Record<DraftFieldKey, string> = {
  title: "title",
  provider: "provider",
  sourceType: "type",
  theme: "theme",
  durationMinutes: "length",
  publishedAt: "published date",
  eventDate: "event date",
  providerCpdHours: "CPD hours",
};
const FIELD_KEYS = Object.keys(FIELD_LABELS) as DraftFieldKey[];

/** A note when almost nothing was found. A guessed (Check) type does not count as finding something. */
export function mostlyMissingNote(result: AdapterResult): string | null {
  const found = FIELD_KEYS.filter((k) => {
    const f = result[k];
    if (!isFound(f)) return false;
    return !(k === "sourceType" && f.confidence === "low");
  });
  if (found.length === 0) return "We could not find any details on this page. Please fill them in.";
  const only = found[0];
  if (found.length === 1 && only) return `We could only find the ${FIELD_LABELS[only]}. Please fill in the rest.`;
  return null;
}

const OK_MESSAGE = "Here is what we found on the page. Check each detail before you save it.";

function okResponse(href: string, result: AdapterResult): ExtractResponse {
  const note = mostlyMissingNote(result);
  if (note && !result.notes.includes(note)) result.notes.push(note);
  return { status: "ok", url: href, message: OK_MESSAGE, result, cached: false };
}

function failure(status: ExtractStatus, href: string, message: string): ExtractResponse {
  return { status, url: href, message, result: null, cached: false };
}

const TOO_COMPLEX_MESSAGE =
  "That page is built in a way that is too complicated for us to read safely, so we did not read it. Fill in the details yourself.";

const DEFAULT_FAILURE_MESSAGES: Record<Exclude<ExtractStatus, "ok">, string> = {
  blocked: "The website did not let us read that page. Fill in the details yourself.",
  robots_disallowed: "The website asks automated tools not to read that page. Fill in the details yourself.",
  robots_unconfirmed: "We could not check whether the website allows automated reading, so we did not read it. Fill in the details yourself.",
  login_required: "That page needs a login, so we cannot read it. Fill in the details yourself.",
  challenge: "The website asked for a human check, so we did not read it. Fill in the details yourself.",
  unsafe_url: "We cannot read that link. Check the address, or fill in the details yourself.",
  failed: "We could not read that page. Check the link, or fill in the details yourself.",
};

// ---------------------------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------------------------

const YOUTUBE_FAILED =
  "We could not read details for this YouTube video. It may be private or removed, or YouTube may not be reachable. Check the link, or fill in the details yourself.";

async function safeGetJson(api: ApiFetcher, url: string, headers?: Record<string, string>): Promise<ApiOutcome> {
  try {
    return await api.getJson(url, headers ? { headers } : undefined);
  } catch {
    // The thrown error is dropped on purpose: it could carry request details.
    return { kind: "failed", message: "The lookup failed." };
  }
}

async function extractYoutube(id: string, href: string, deps: ExtractDeps, now: Date): Promise<ExtractResponse> {
  const key = deps.youtubeApiKey?.trim();
  const fallbackNotes: string[] = [];

  if (key) {
    // The key is only ever in this header. It is not in the URL, a note, a message or the response.
    const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,liveStreamingDetails&id=${id}`;
    const out = await safeGetJson(deps.api, apiUrl, { "x-goog-api-key": key });
    if (out.kind === "ok" && youtubeApiVideo(out.json)) {
      return okResponse(href, youtubeFromApi(out.json, now));
    }
    fallbackNotes.push("YouTube's full lookup did not work this time, so the length is missing. Please enter it.");
  }

  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalYoutubeUrl(id))}&format=json`;
  const out = await safeGetJson(deps.api, oembedUrl);
  if (out.kind === "ok" && youtubeJsonKind(out.json) === "oembed") {
    const result = youtubeFromOembed(out.json);
    result.notes.push(...fallbackNotes);
    return okResponse(href, result);
  }
  return failure("failed", href, YOUTUBE_FAILED);
}

// ---------------------------------------------------------------------------------------------
// Web pages
// ---------------------------------------------------------------------------------------------

function isHtmlLike(contentType: string): boolean {
  const t = contentType.trim().toLowerCase();
  return t === "" || t.includes("html") || t.includes("xml");
}

function adaptersFor(requested: URL, final: URL | null) {
  const picked = [...selectAdapters(requested), ...(final ? selectAdapters(final) : [])];
  const seen = new Set<string>();
  const specific = picked.filter((a) => {
    if (a.id === "generic" || a.id === "youtube" || seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });
  const generic = picked.find((a) => a.id === "generic");
  return generic ? [...specific, generic] : specific;
}

async function extractPage(requested: URL, href: string, deps: ExtractDeps, now: Date): Promise<ExtractResponse> {
  let outcome: ReadOutcome;
  try {
    outcome = await deps.reader.read(href);
  } catch {
    return failure("failed", href, DEFAULT_FAILURE_MESSAGES.failed);
  }

  if (outcome.kind !== "ok") {
    const message = typeof outcome.message === "string" && outcome.message.trim() ? outcome.message : DEFAULT_FAILURE_MESSAGES[outcome.kind];
    return failure(outcome.kind, href, message);
  }

  let final: URL | null = null;
  try {
    final = new URL(outcome.finalUrl);
  } catch {
    final = null;
  }

  // A short link that lands on YouTube: use the YouTube lookups, not the page we were given.
  const finalVideo = final ? parseYoutubeId(final) : null;
  if (finalVideo) return extractYoutube(finalVideo, href, deps, now);

  if (typeof outcome.status === "number" && outcome.status >= 400) {
    return failure("failed", href, `The website replied with an error (${outcome.status}). Check the link, or fill in the details yourself.`);
  }
  if (!isHtmlLike(String(outcome.contentType ?? ""))) {
    return failure(
      "failed",
      href,
      "That link opens a file (such as a PDF) rather than a web page, so we cannot read details from it. Fill in the details yourself.",
    );
  }

  const body = typeof outcome.body === "string" ? outcome.body : "";
  const truncated = body.length > MAX_HTML_CHARS;
  const html = truncated ? body.slice(0, MAX_HTML_CHARS) : body;
  const finalHref = final ? final.href : href;

  // A page nested thousands of levels deep would freeze the server while it is parsed and searched.
  if (isTooDeeplyNested(html)) return failure("failed", href, TOO_COMPLEX_MESSAGE);

  const results: AdapterResult[] = [];
  const adapters = adaptersFor(requested, final);
  try {
    // The page is parsed once here. Every adapter's own loadDoc(html) gets this same document.
    withParsedPage(html, () => {
      for (const adapter of adapters) {
        const useUrl = final && adapter.matches(final) ? finalHref : href;
        try {
          results.push(adapter.extract({ url: useUrl, html, now }));
        } catch {
          // One adapter failing must not lose the others. The error text is dropped: it could echo page content.
        }
      }
    });
  } catch {
    // The page could not be parsed at all. The error text is dropped: it could echo page content.
  }
  if (results.length === 0) {
    return failure("failed", href, "We could not read details from that page. Fill in the details yourself.");
  }
  const merged = mergeResults(results, SPECIFICITY_BY_ID);
  if (truncated) merged.notes.push("The page was very long, so we only read the first part of it.");
  return okResponse(href, merged);
}

// ---------------------------------------------------------------------------------------------

export async function extractFromUrl(rawUrl: string, deps: ExtractDeps): Promise<ExtractResponse> {
  const norm = normaliseUserUrl(rawUrl);
  if (!norm.ok) return failure("unsafe_url", norm.echo, norm.message);

  const clock = deps.now ?? (() => new Date());
  const cache = deps.cache ?? sharedExtractCache;
  const startedAt = clock();

  const cached = readCache(cache, norm.href, startedAt.getTime());
  if (cached) return cached;

  const videoId = parseYoutubeId(norm.url);
  const response = videoId
    ? await extractYoutube(videoId, norm.href, deps, startedAt)
    : await extractPage(norm.url, norm.href, deps, startedAt);

  if (response.status === "ok") writeCache(cache, norm.href, response, startedAt.getTime());
  return response;
}
