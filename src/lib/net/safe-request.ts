/**
 * One polite, bounded HTTP GET.
 *
 * - Every hop (the first URL and each redirect) goes through assertSafeUrl.
 * - Redirects are followed by hand, at most 5, and the transport itself never follows any.
 * - 8 second overall deadline, body size cap enforced while streaming.
 * - No cookies and no Authorization header, ever. Set-Cookie is ignored and dropped from the result.
 * - One fixed User-Agent: "CPDLoggerBot/1.0 (+<contact>)". It is never changed to get past a block.
 *
 * This file must only run on the server.
 */
import { Agent, request as undiciRequest } from "undici";
import { BlockedAddressError, UNSAFE_URL_MESSAGES, UnsafeUrlError, assertSafeUrl, createValidatingLookup } from "./ssrf";
import type { Resolver } from "./ssrf";

export const BOT_PRODUCT_TOKEN = "CPDLoggerBot";
export const BOT_VERSION = "1.0";
export const DEFAULT_CONTACT = "contact-not-set";
export const DEFAULT_TIMEOUT_MS = 8000;
export const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
export const DEFAULT_MAX_REDIRECTS = 5;

export const HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1";

/** The longest contact text we publish. */
export const MAX_CONTACT_CHARS = 200;

/**
 * "CPDLoggerBot/1.0 (+contact)". The contact is cut down to printable ASCII (letters lose their accents, so "Zoë"
 * becomes "Zoe"; anything else outside 0x20 to 0x7E is dropped, control characters included, so it cannot inject a
 * header) and to 200 characters. The HTTP client refuses a User-Agent with any character above U+00FF, and that
 * would make every request fail.
 */
export function buildUserAgent(contact?: string): string {
  const cleaned = (contact ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\u0020-\u007e]/g, "")
    .replace(/ {2,}/g, " ")
    .trim()
    .slice(0, MAX_CONTACT_CHARS)
    .trim();
  return `${BOT_PRODUCT_TOKEN}/${BOT_VERSION} (+${cleaned === "" ? DEFAULT_CONTACT : cleaned})`;
}

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

export type HeadersIn = Record<string, string | string[] | undefined>;

export interface TransportRequest {
  url: URL;
  /** Lower-case header names. Never contains cookie or authorization. */
  headers: Record<string, string>;
  signal: AbortSignal;
}

export interface TransportResponse {
  status: number;
  headers: HeadersIn;
  body: AsyncIterable<Uint8Array | string>;
  /** Close the connection without reading the rest of the body. */
  destroy?: () => void;
}

/** One HTTP GET with no redirect following. Injectable so tests never touch the network. */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

export interface SafeRequestDeps {
  request?: Transport;
  resolve?: Resolver;
  /** Milliseconds, like Date.now. */
  now?: () => number;
  /** Published in the User-Agent. */
  contact?: string;
}

export type SafeFailureCode =
  | "unsafe_url"
  | "unresolvable"
  | "dns_failed"
  | "timeout"
  | "too_large"
  | "too_many_redirects"
  | "bad_redirect"
  | "network"
  | "tls"
  | "unsupported_encoding"
  | "bad_request"
  | "robots_disallowed"
  | "robots_unconfirmed"
  | "login_required";

export interface SafeFailure {
  ok: false;
  code: SafeFailureCode;
  /** Plain language, safe to show. Never contains the URL, headers or key values. */
  message: string;
}

export interface SafeSuccess {
  ok: true;
  /** Any final HTTP status that is not a followed redirect. The caller decides what 4xx and 5xx mean. */
  status: number;
  finalUrl: string;
  /** The Content-Type header as sent, or "" if there was none. */
  contentType: string;
  /** Lower-case names. Set-Cookie is never included. */
  headers: Record<string, string>;
  /** Decoded text. "" when the type is not text (PDF, image) or when bodyRead is false. */
  body: string;
  /** False when the content type was not text, so the body was not read. */
  bodyRead: boolean;
  /** True when the body was cut at the size cap (only with onOverflow "truncate"). */
  truncated: boolean;
  redirects: number;
}

export type SafeResult = SafeSuccess | SafeFailure;

export interface SafeRequestOptions {
  /** Overall deadline for all hops and the body. Default 8000. */
  timeoutMs?: number;
  /** Default 2 MiB. */
  maxBytes?: number;
  /** Default 5. */
  maxRedirects?: number;
  /** "fail" (default) returns too_large. "truncate" keeps the first maxBytes and carries on. */
  onOverflow?: "fail" | "truncate";
  /** Default: an HTML Accept header. */
  accept?: string;
  /**
   * Extra request headers, such as an API key header. They are only sent to the ORIGIN OF THE FIRST URL and are
   * dropped from any redirect that leaves that origin. Cookie and Authorization are refused.
   */
  headers?: Record<string, string>;
  /** "text" (default) reads only text-like bodies. "always" reads any body (for JSON APIs). */
  readBody?: "text" | "always";
  /** Called before each redirect is followed (hop 1, 2, ...). Return a failure to stop, or null to carry on. */
  guard?: (url: URL, hop: number) => Promise<SafeFailure | null>;
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

const TAIL = "You can type the details in yourself.";

function megabytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return mb >= 1 ? `${Math.round(mb * 10) / 10} MB` : `${Math.round(bytes / 1024)} KB`;
}

export const SAFE_REQUEST_MESSAGES = {
  timeout: (ms: number) =>
    `The site took too long to answer (more than ${Math.max(1, Math.round(ms / 1000))} seconds), so we stopped waiting. Try again in a moment. ${TAIL}`,
  too_large: (bytes: number) => `That page is bigger than we can read (over ${megabytes(bytes)}), so we stopped. ${TAIL}`,
  too_many_redirects: (max: number) =>
    `That link redirects more than ${max} times, so we stopped following it. Open it in your browser and paste the address you end up on. ${TAIL}`,
  bad_redirect:
    "That site sent us to an address we couldn't understand, so we stopped. Open the link in your browser and paste the address you end up on.",
  redirect_unsafe: `That link redirects to an address that isn't a public web address, so we haven't followed it. ${TAIL}`,
  network: `We couldn't connect to that site. Check the link and try again in a moment. ${TAIL}`,
  tls: `We couldn't make a secure connection to that site because its security certificate wasn't accepted. ${TAIL}`,
  tls_handshake: `We couldn't make a secure connection to that site. ${TAIL}`,
  unsupported_encoding: `That site sent the page in a compressed form we can't read. ${TAIL}`,
  bad_request: "This request tried to send cookies or sign-in details, which this app never sends. Remove that header and try again.",
  bad_header: "A header on this request has a name or value that can't be sent. Remove it and try again.",
  insecure_headers: "Extra request headers, such as an API key, are only sent over a secure https:// address, so nothing was sent. Use an https:// address.",
} as const;

function failure(code: SafeFailureCode, message: string): SafeFailure {
  return { ok: false, code, message };
}

// ---------------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------------

class AbortedError extends Error {
  constructor() {
    super("aborted");
    this.name = "AbortedError";
  }
}

/** Settle as soon as the signal aborts, even if the underlying promise never does. */
export function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(new AbortedError());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new AbortedError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function unrefTimer(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.();
}

function errorCodeOf(e: unknown): string {
  // Walk the cause chain a little: undici and Node wrap lookup and TLS errors.
  let current: unknown = e;
  for (let depth = 0; depth < 4 && typeof current === "object" && current !== null; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string" && code !== "") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return "";
}

const TIMEOUT_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "ETIMEDOUT", "ESOCKETTIMEDOUT"]);
/** Errors that really are about the site's certificate. */
const CERTIFICATE_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "CERT_UNTRUSTED",
  "CERT_REVOKED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);
/** Handshake and protocol errors. They say the secure connection failed, not why, so we do not blame the certificate. */
const HANDSHAKE_CODES = new Set(["ERR_SSL_WRONG_VERSION_NUMBER", "EPROTO"]);

/**
 * Turn a transport or stream error into a plain failure. The raw error text is never shown. `hop` is 0 for the
 * address the caller gave and 1 or more for a redirect, so a refusal is only called a redirect when it was one.
 */
function failureFromError(e: unknown, timeoutMs: number, hop: number): SafeFailure {
  const code = errorCodeOf(e);
  if (e instanceof AbortedError || TIMEOUT_CODES.has(code)) return failure("timeout", SAFE_REQUEST_MESSAGES.timeout(timeoutMs));
  if (code === "ERR_CPD_BLOCKED_ADDRESS" || e instanceof BlockedAddressError) {
    return failure("unsafe_url", hop === 0 ? UNSAFE_URL_MESSAGES.private_network : SAFE_REQUEST_MESSAGES.redirect_unsafe);
  }
  if (code === "ENOTFOUND" || code === "ENODATA") {
    return failure("unresolvable", "We couldn't find a website at that address. Check the link for typos and try again.");
  }
  if (code === "EAI_AGAIN") {
    return failure("dns_failed", `We couldn't look up that website just now. Try again in a moment. ${TAIL}`);
  }
  if (CERTIFICATE_CODES.has(code) || code.startsWith("CERT_")) return failure("tls", SAFE_REQUEST_MESSAGES.tls);
  if (HANDSHAKE_CODES.has(code) || code.startsWith("ERR_SSL")) return failure("tls", SAFE_REQUEST_MESSAGES.tls_handshake);
  return failure("network", SAFE_REQUEST_MESSAGES.network);
}

/** Lower-case the names, join repeated values, and drop Set-Cookie so a cookie can never be read or replayed. */
function normaliseHeaders(h: HeadersIn): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(h)) {
    const key = name.toLowerCase();
    if (key === "set-cookie" || key === "set-cookie2" || value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

const REFUSED_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "cookie2"]);
const FIXED_HEADERS = new Set(["host", "user-agent", "accept-encoding", "content-length", "transfer-encoding", "connection", "te", "upgrade"]);

type PreparedHeaders = { ok: true; headers: Record<string, string> } | { ok: false; reason: "refused" | "unsendable" };

/**
 * Validate caller headers. A refused set says why: "refused" for Cookie and Authorization, "unsendable" for a name or
 * value the HTTP client would reject (control characters, or anything above U+00FF, which makes the client throw
 * before a request is made).
 */
function prepareExtraHeaders(headers: Record<string, string> | undefined): PreparedHeaders {
  const out: Record<string, string> = {};
  if (!headers) return { ok: true, headers: out };
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase().trim();
    if (REFUSED_HEADERS.has(key)) return { ok: false, reason: "refused" };
    if (FIXED_HEADERS.has(key)) continue; // we set these ourselves
    // eslint-disable-next-line no-control-regex
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(key) || typeof value !== "string" || /[\u0000-\u001f\u007f]|[^\u0000-\u00ff]/.test(value)) {
      return { ok: false, reason: "unsendable" };
    }
    out[key] = value;
  }
  return { ok: true, headers: out };
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Text-like types are read and decoded. A missing type is treated as text. */
export function isTextContentType(contentType: string): boolean {
  const mediaType = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType === "") return true;
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/xhtml+xml" ||
    mediaType === "application/xml" ||
    mediaType === "application/json" ||
    mediaType.endsWith("+xml") ||
    mediaType.endsWith("+json")
  );
}

function charsetFromContentType(contentType: string): string | null {
  const m = /;\s*charset\s*=\s*(?:"([^"]+)"|([^\s;]+))/i.exec(contentType);
  const value = (m?.[1] ?? m?.[2] ?? "").trim();
  return value === "" ? null : value;
}

function sniffCharset(bytes: Uint8Array): string | null {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return "utf-8";
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return "utf-16le";
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return "utf-16be";
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
  const m = /<meta\b[^>]{0,300}?charset\s*=\s*["']?\s*([a-zA-Z0-9_:.-]+)/i.exec(head);
  return m?.[1] ?? null;
}

/** Bytes 0x80 to 0x9F in windows-1252. Node's TextDecoder decodes this encoding as plain Latin-1 and loses these. */
const WINDOWS_1252_C1 =
  "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";

function decodeWindows1252(bytes: Uint8Array): string {
  const pieces: string[] = [];
  const step = 8192;
  for (let start = 0; start < bytes.length; start += step) {
    const codes: number[] = [];
    for (let i = start; i < Math.min(bytes.length, start + step); i++) {
      const b = bytes[i] ?? 0;
      codes.push(b >= 0x80 && b <= 0x9f ? WINDOWS_1252_C1.charCodeAt(b - 0x80) : b);
    }
    pieces.push(String.fromCharCode(...codes));
  }
  return pieces.join("");
}

/**
 * Decode a body as text. Uses the charset in Content-Type; if there is none, a byte-order mark or an HTML
 * <meta charset>; otherwise UTF-8. An unknown charset name falls back to UTF-8. Bad bytes become U+FFFD.
 * "iso-8859-1", "latin1" and "ascii" mean windows-1252 on the web, so they are decoded that way.
 */
export function decodeBody(bytes: Uint8Array, contentType: string): string {
  const label = charsetFromContentType(contentType) ?? sniffCharset(bytes) ?? "utf-8";
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(label, { fatal: false });
  } catch {
    decoder = new TextDecoder("utf-8", { fatal: false });
  }
  if (decoder.encoding === "windows-1252") return decodeWindows1252(bytes);
  return decoder.decode(bytes);
}

function release(res: TransportResponse | undefined): void {
  try {
    res?.destroy?.();
  } catch {
    // Closing a connection that is already closed is fine.
  }
}

// ---------------------------------------------------------------------------------------------
// The real transport: undici with a validating lookup
// ---------------------------------------------------------------------------------------------

export type ClosableTransport = Transport & { close: () => Promise<void> };

/**
 * undici GET with no redirect following (undici only follows redirects when a redirect interceptor is added,
 * and none is). The agent's connect.lookup validates every address at connect time, so the socket can only open
 * to a public address, whatever DNS says later. Literal-IP URLs skip lookup in Node, which is why assertSafeUrl
 * judges them first.
 */
export function createUndiciTransport(options: { resolve?: Resolver; timeoutMs?: number } = {}): ClosableTransport {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const agent = new Agent({
    connect: { lookup: createValidatingLookup(options.resolve) },
    connectTimeout: timeout,
    headersTimeout: timeout,
    bodyTimeout: timeout,
  });
  const transport: Transport = async ({ url, headers, signal }) => {
    const res = await undiciRequest(url, { method: "GET", headers, signal, dispatcher: agent });
    // Destroying a body nobody has finished reading (a redirect answer, a cut-off page) emits "error". With no
    // listener Node treats that as an uncaught exception, so always have one. Readers still see errors through iteration.
    res.body.on("error", () => undefined);
    return {
      status: res.statusCode,
      headers: res.headers,
      body: res.body,
      destroy: () => {
        res.body.destroy();
      },
    };
  };
  return Object.assign(transport, { close: () => agent.close() });
}

let sharedTransport: ClosableTransport | undefined;
const customResolverTransports = new WeakMap<Resolver, ClosableTransport>();

/** The shared agent (connection reuse). A custom resolver gets its own, so the connect-time check uses the same DNS answers. */
function defaultTransport(resolve?: Resolver): Transport {
  if (!resolve) {
    sharedTransport ??= createUndiciTransport();
    return sharedTransport;
  }
  let t = customResolverTransports.get(resolve);
  if (!t) {
    t = createUndiciTransport({ resolve });
    customResolverTransports.set(resolve, t);
  }
  return t;
}

// ---------------------------------------------------------------------------------------------
// safeRequest
// ---------------------------------------------------------------------------------------------

/** Read the body while counting bytes. Stops at the cap instead of buffering more. */
async function readCapped(
  res: TransportResponse,
  maxBytes: number,
  onOverflow: "fail" | "truncate",
  signal: AbortSignal,
  now: () => number,
  deadline: number,
): Promise<{ bytes: Uint8Array; truncated: boolean } | "timeout" | "too_large"> {
  const iterator = res.body[Symbol.asyncIterator]();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let truncated = false;
  try {
    for (;;) {
      if (now() >= deadline) return "timeout";
      const next = await raceAbort(iterator.next(), signal);
      if (next.done) break;
      const chunk = typeof next.value === "string" ? Buffer.from(next.value) : next.value;
      if (total + chunk.length > maxBytes) {
        if (onOverflow === "fail") return "too_large";
        chunks.push(chunk.subarray(0, maxBytes - total));
        total = maxBytes;
        truncated = true;
        break;
      }
      chunks.push(chunk);
      total += chunk.length;
    }
  } finally {
    // Stop the producer and close the connection. A stalled read may never settle, so do not await it.
    try {
      void Promise.resolve(iterator.return?.()).catch(() => undefined);
    } catch {
      // ignore
    }
    release(res);
  }
  return { bytes: Buffer.concat(chunks, total), truncated };
}

/**
 * GET a URL safely. Returns a SafeSuccess for any HTTP answer that is not a followed redirect (check `status`),
 * or a SafeFailure with a plain-language message. Never throws.
 */
export async function safeRequest(rawUrl: string, opts: SafeRequestOptions = {}, deps: SafeRequestDeps = {}): Promise<SafeResult> {
  const now = deps.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const onOverflow = opts.onOverflow ?? "fail";

  const prepared = prepareExtraHeaders(opts.headers);
  if (!prepared.ok) return failure("bad_request", prepared.reason === "refused" ? SAFE_REQUEST_MESSAGES.bad_request : SAFE_REQUEST_MESSAGES.bad_header);
  const extraHeaders = prepared.headers;

  const transport = deps.request ?? defaultTransport(deps.resolve);
  const userAgent = buildUserAgent(deps.contact);

  const controller = new AbortController();
  const signal = controller.signal;
  const deadline = now() + timeoutMs;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  unrefTimer(timer);

  const timeoutFailure = () => failure("timeout", SAFE_REQUEST_MESSAGES.timeout(timeoutMs));
  let res: TransportResponse | undefined;

  let hop = 0;
  try {
    let target = rawUrl;
    let firstOrigin: string | null = null;

    for (;;) {
      if (timedOut || now() >= deadline) return timeoutFailure();

      // 1. Is this hop a public web address? (Runs on the first URL and on every redirect.)
      let url: URL;
      try {
        url = await raceAbort(assertSafeUrl(target, { resolve: deps.resolve }), signal);
      } catch (e) {
        if (e instanceof UnsafeUrlError) {
          if (hop === 0) return failure(e.code === "unresolvable" ? "unresolvable" : e.code === "dns_failed" ? "dns_failed" : "unsafe_url", e.message);
          if (e.code === "malformed" || e.code === "too_long") return failure("bad_redirect", SAFE_REQUEST_MESSAGES.bad_redirect);
          if (e.code === "unresolvable" || e.code === "dns_failed") return failure(e.code, e.message);
          return failure("unsafe_url", SAFE_REQUEST_MESSAGES.redirect_unsafe);
        }
        return failureFromError(e, timeoutMs, hop);
      }
      firstOrigin ??= url.origin;
      // An API key or other caller header must never cross the network in clear text.
      if (hop === 0 && Object.keys(extraHeaders).length > 0 && url.protocol !== "https:") {
        return failure("unsafe_url", SAFE_REQUEST_MESSAGES.insecure_headers);
      }

      // 2. Optional caller check before following a redirect (the reader uses it for robots.txt).
      if (hop > 0 && opts.guard) {
        let blocked: SafeFailure | null;
        try {
          blocked = await raceAbort(opts.guard(url, hop), signal);
        } catch (e) {
          return failureFromError(e, timeoutMs, hop);
        }
        if (blocked) return blocked;
      }

      // 3. One request. Only a fixed, small set of headers; extra headers never leave the first origin.
      const headers: Record<string, string> = {
        "user-agent": userAgent,
        accept: opts.accept ?? HTML_ACCEPT,
        "accept-encoding": "identity",
      };
      if (url.origin === firstOrigin) Object.assign(headers, extraHeaders);

      try {
        res = await raceAbort(transport({ url, headers, signal }), signal);
      } catch (e) {
        if (timedOut) return timeoutFailure();
        return failureFromError(e, timeoutMs, hop);
      }

      const responseHeaders = normaliseHeaders(res.headers);

      // 4. Redirects are followed here, by hand.
      const location = responseHeaders["location"];
      if (REDIRECT_STATUSES.has(res.status) && location !== undefined && location.trim() !== "") {
        release(res);
        res = undefined;
        if (hop >= maxRedirects) return failure("too_many_redirects", SAFE_REQUEST_MESSAGES.too_many_redirects(maxRedirects));
        let next: URL;
        try {
          next = new URL(location.trim(), url);
        } catch {
          return failure("bad_redirect", SAFE_REQUEST_MESSAGES.bad_redirect);
        }
        target = next.href;
        hop += 1;
        continue;
      }

      // 5. A final answer. Read the body if it is text (or the caller asked for any body).
      const contentType = responseHeaders["content-type"] ?? "";
      const base = { ok: true as const, status: res.status, finalUrl: url.href, contentType, headers: responseHeaders, redirects: hop };

      if (opts.readBody !== "always" && !isTextContentType(contentType)) {
        release(res);
        res = undefined;
        return { ...base, body: "", bodyRead: false, truncated: false };
      }
      const encoding = (responseHeaders["content-encoding"] ?? "").trim().toLowerCase();
      if (encoding !== "" && encoding !== "identity") {
        release(res);
        res = undefined;
        return failure("unsupported_encoding", SAFE_REQUEST_MESSAGES.unsupported_encoding);
      }
      const declared = Number(responseHeaders["content-length"]);
      if (onOverflow === "fail" && Number.isFinite(declared) && declared > maxBytes) {
        release(res);
        res = undefined;
        return failure("too_large", SAFE_REQUEST_MESSAGES.too_large(maxBytes));
      }

      const current = res;
      res = undefined; // readCapped releases it
      let read: Awaited<ReturnType<typeof readCapped>>;
      try {
        read = await readCapped(current, maxBytes, onOverflow, signal, now, deadline);
      } catch (e) {
        if (timedOut) return timeoutFailure();
        return failureFromError(e, timeoutMs, hop);
      }
      if (read === "timeout") return timeoutFailure();
      if (read === "too_large") return failure("too_large", SAFE_REQUEST_MESSAGES.too_large(maxBytes));
      return { ...base, body: decodeBody(read.bytes, contentType), bodyRead: true, truncated: read.truncated };
    }
  } catch (e) {
    return timedOut ? timeoutFailure() : failureFromError(e, timeoutMs, hop);
  } finally {
    clearTimeout(timer);
    release(res);
  }
}
