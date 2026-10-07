/**
 * The page reader and the JSON API fetcher.
 *
 * read(url): check the address is a public web address, check robots.txt, make ONE request, then say in plain
 * words what happened. It never retries with different headers, never tries another way in, and never gets
 * around a block, a login or a bot challenge. The person is always pointed back to typing the details in.
 *
 * Nothing here logs a URL, a query string or a header.
 */
import type { ApiFetcher, ApiOutcome, PageReader, ReadFailureKind, ReadOutcome } from "./types";
import { detectLoginWall, inspectBotChallenge, looksLikeLoginUrl, scanHtml } from "./challenge";
import { createRobotsChecker } from "./robots";
import type { RobotsChecker } from "./robots";
import { DEFAULT_TIMEOUT_MS, SAFE_REQUEST_MESSAGES, raceAbort, safeRequest } from "./safe-request";
import type { SafeFailure, SafeRequestDeps, SafeSuccess } from "./safe-request";
import { UnsafeUrlError, assertSafeUrl } from "./ssrf";

const TAIL = "You can type the details in yourself.";

export const READER_MESSAGES = {
  login_required: `This page needs you to sign in, so we can't read it. ${TAIL}`,
  blocked: `This site doesn't allow automated reading. We haven't tried to get around that. ${TAIL}`,
  challenge: `This site showed a security check or an access-denied page instead of the page itself, so we haven't read it. We haven't tried to get around that. ${TAIL}`,
  not_found: "That page wasn't found (error 404). Check the link for typos and try again, or type the details in yourself.",
  gone: `That page has been removed (error 410). ${TAIL}`,
  client_error: (status: number) => `The site refused the request (error ${status}). Check the link and try again. ${TAIL}`,
  server_error: (status: number) => `The site had a problem and sent an error (${status}). Try again later. ${TAIL}`,
  not_a_page: (mediaType: string) =>
    `That link goes to a file or data feed${mediaType ? ` (${mediaType})` : ""}, not a web page, so we can't read the details from it. ${TAIL}`,
  empty: `The page came back empty, so there was nothing to read. Check the link and try again. ${TAIL}`,
  redirect_dead_end: `That link redirects without saying where to, so we couldn't follow it. Open it in your browser and paste the address you end up on. ${TAIL}`,
  unexpected: `Something went wrong while reading that page. Try again in a moment. ${TAIL}`,
  api_failed: "The service didn't send a reply we could use. Try again in a moment.",
  api_refused_header: SAFE_REQUEST_MESSAGES.bad_request,
} as const;

export interface PageReaderDeps extends SafeRequestDeps {
  /** Replace the robots.txt checker (tests). By default one is built from the same transport, resolver and clock. */
  robots?: RobotsChecker;
  /** Deadline for each network step of a read (the address check, robots.txt, the page and its redirects). Default 8000. */
  timeoutMs?: number;
}

function mediaTypeOf(contentType: string): string {
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  return /^[a-z0-9.+/_-]{1,80}$/.test(mediaType) ? mediaType : "";
}

function isReadableType(contentType: string): boolean {
  const mediaType = mediaTypeOf(contentType);
  return mediaType === "" || mediaType.startsWith("text/") || mediaType === "application/xhtml+xml";
}

/** Map a failed request to the reader's outcome kinds. */
function outcomeFromFailure(f: SafeFailure): ReadOutcome {
  switch (f.code) {
    case "unsafe_url":
      return { kind: "unsafe_url", message: f.message };
    case "robots_disallowed":
      return { kind: "robots_disallowed", message: f.message };
    case "robots_unconfirmed":
      return { kind: "robots_unconfirmed", message: f.message };
    case "login_required":
      return { kind: "login_required", message: f.message };
    default:
      return { kind: "failed", message: f.message };
  }
}

function failed(message: string): { kind: ReadFailureKind; message: string } {
  return { kind: "failed", message };
}

/**
 * A page with no Content-Type is read as text, so look at what it holds. A PDF or an image sent without a header
 * decodes to NUL bytes, replacement characters and control characters, which no web page has.
 */
export function looksBinary(text: string): boolean {
  const sample = text.slice(0, 2000);
  if (sample === "") return false;
  if (sample.startsWith("%PDF-") || sample.startsWith("GIF8") || sample.startsWith("PK\u0003\u0004") || sample.startsWith("\uFFFDPNG")) return true;
  let odd = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if (c === 0) return true;
    if (c === 0xfffd || (c < 32 && c !== 9 && c !== 10 && c !== 12 && c !== 13)) odd++;
  }
  return odd / sample.length > 0.1;
}

/** Decide what a finished HTTP answer means. Order matters: sign-in, challenge, block, other errors, then success. */
function classify(res: SafeSuccess): ReadOutcome {
  const { status, body, headers, finalUrl, contentType } = res;

  if (status === 401) return { kind: "login_required", message: READER_MESSAGES.login_required };

  // Read the HTML once and share the result: a 2 MB page is not scanned again for the sign-in check.
  const scan = scanHtml(body);
  const blockingStatus = status === 403 || status === 429 || status === 451;

  // A challenge page usually arrives as 403 or 503, so look for it before the generic block. But a plain 403 whose
  // page only says "access denied" is a block, not a security check: on 403, 429 and 451 only a sign that belongs
  // to a vendor's challenge page counts.
  const challenge = inspectBotChallenge({ status, headers, html: body, scan });
  if (challenge && (challenge.strong || !blockingStatus)) return { kind: "challenge", message: READER_MESSAGES.challenge };

  if (blockingStatus) return { kind: "blocked", message: READER_MESSAGES.blocked };

  if (status === 404) return failed(READER_MESSAGES.not_found);
  if (status === 410) return failed(READER_MESSAGES.gone);
  if (status >= 500) return failed(READER_MESSAGES.server_error(status));
  if (status >= 400) return failed(READER_MESSAGES.client_error(status));
  if (status >= 300) return failed(READER_MESSAGES.redirect_dead_end);
  if (status < 200) return failed(READER_MESSAGES.unexpected);

  if (!res.bodyRead || !isReadableType(contentType)) return failed(READER_MESSAGES.not_a_page(mediaTypeOf(contentType)));
  if (mediaTypeOf(contentType) === "" && looksBinary(body)) return failed(READER_MESSAGES.not_a_page(""));
  if (detectLoginWall({ status, finalUrl, html: body, scan })) return { kind: "login_required", message: READER_MESSAGES.login_required };
  if (body.trim() === "") return failed(READER_MESSAGES.empty);

  return { kind: "ok", finalUrl, status, contentType, body, fromCache: false };
}

export function createPageReader(deps: PageReaderDeps = {}): PageReader {
  const transportDeps: SafeRequestDeps = { request: deps.request, resolve: deps.resolve, now: deps.now, contact: deps.contact };
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const robots = deps.robots ?? createRobotsChecker({ ...transportDeps, timeoutMs });

  return {
    async read(rawUrl: string): Promise<ReadOutcome> {
      try {
        // 1. Is it a public web address? The DNS lookup has its own deadline: a resolver that never answers must not hang the read.
        let url: URL;
        const lookupDeadline = new AbortController();
        const lookupTimer = setTimeout(() => lookupDeadline.abort(), timeoutMs);
        try {
          url = await raceAbort(assertSafeUrl(rawUrl, { resolve: deps.resolve }), lookupDeadline.signal);
        } catch (e) {
          if (e instanceof UnsafeUrlError) {
            if (e.code === "unresolvable" || e.code === "dns_failed") return failed(e.message);
            return { kind: "unsafe_url", message: e.message };
          }
          if (lookupDeadline.signal.aborted) return failed(SAFE_REQUEST_MESSAGES.timeout(timeoutMs));
          throw e;
        } finally {
          clearTimeout(lookupTimer);
        }

        // 2. Does the site allow it? Unsure counts as no.
        const decision = await robots.check(url);
        if (!decision.allowed) return { kind: decision.kind, message: decision.message };

        // 3. One request. Each redirect is checked before it is followed: a redirect to a sign-in or single-sign-on
        // address is reported as a sign-in page without asking that site's robots.txt (which often disallows /login
        // and would turn "this page needs you to sign in" into "this site asks automated tools not to read it"),
        // then every other redirect is checked against robots.txt.
        const res = await safeRequest(
          url.href,
          {
            timeoutMs,
            guard: async (next) => {
              if (looksLikeLoginUrl(next.href)) return { ok: false, code: "login_required", message: READER_MESSAGES.login_required };
              const d = await robots.check(next);
              return d.allowed ? null : { ok: false, code: d.kind, message: d.message };
            },
          },
          transportDeps,
        );
        if (!res.ok) return outcomeFromFailure(res);

        // 4. What did the site say?
        return classify(res);
      } catch {
        // Never surface the error text: it could contain addresses from inside our network.
        return failed(READER_MESSAGES.unexpected);
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// JSON APIs
// ---------------------------------------------------------------------------------------------

export const API_MAX_BYTES = 1024 * 1024;

export interface ApiFetcherDeps extends SafeRequestDeps {
  timeoutMs?: number;
  /** Default 1 MiB. */
  maxBytes?: number;
}

/**
 * For documented JSON APIs (YouTube Data API, YouTube oEmbed). Same address checks and redirect handling as the
 * page reader, no robots.txt check. Pass an API key as a header (x-goog-api-key), never in the URL. Extra headers
 * go only to the first URL's origin and are dropped if a redirect leaves it. Cookie and Authorization are refused.
 */
export function createApiFetcher(deps: ApiFetcherDeps = {}): ApiFetcher {
  const transportDeps: SafeRequestDeps = { request: deps.request, resolve: deps.resolve, now: deps.now, contact: deps.contact };
  return {
    async getJson(url, opts): Promise<ApiOutcome> {
      try {
        const res = await safeRequest(
          url,
          {
            accept: "application/json",
            headers: opts?.headers,
            readBody: "always",
            maxBytes: deps.maxBytes ?? API_MAX_BYTES,
            timeoutMs: deps.timeoutMs,
          },
          transportDeps,
        );
        if (!res.ok) {
          if (res.code === "unsafe_url") return { kind: "unsafe_url", message: res.message };
          return { kind: "failed", message: res.message };
        }
        if (res.status < 200 || res.status >= 300) return { kind: "http_error", status: res.status };
        if (res.body.trim() === "") return { kind: "failed", message: READER_MESSAGES.api_failed };
        try {
          return { kind: "ok", status: res.status, json: JSON.parse(res.body) as unknown };
        } catch {
          return { kind: "failed", message: READER_MESSAGES.api_failed };
        }
      } catch {
        return { kind: "failed", message: READER_MESSAGES.api_failed };
      }
    },
  };
}
