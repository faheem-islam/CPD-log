/**
 * Server-side request forgery (SSRF) defences.
 *
 * Two layers work together:
 *  1. assertSafeUrl() checks the URL text, then resolves the hostname and refuses it if ANY address is not
 *     a public one.
 *  2. createValidatingLookup() is plugged into the HTTP agent, so the socket can only connect to an address
 *     that was checked at connect time. That closes the gap DNS rebinding relies on (a name that answers
 *     "public" for the check and "private" for the connection).
 *
 * This file must only run on the server (it uses node:dns).
 */
import { promises as dnsPromises } from "node:dns";
import type { LookupAddress } from "node:dns";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";

export type UnsafeUrlCode =
  | "malformed"
  | "too_long"
  | "scheme"
  | "credentials"
  | "port"
  | "blocked_host"
  | "blocked_ip"
  | "unresolvable"
  | "dns_failed";

/**
 * Thrown when a URL must not be requested. The message is written for the person who pasted the link.
 * It never contains the URL itself (a URL can carry a secret in its query string).
 */
export class UnsafeUrlError extends Error {
  readonly code: UnsafeUrlCode;
  constructor(code: UnsafeUrlCode, message: string) {
    super(message);
    this.name = "UnsafeUrlError";
    this.code = code;
  }
}

/** Thrown inside the connection lookup when a hostname resolves to an address we must not connect to. */
export class BlockedAddressError extends Error {
  readonly code = "ERR_CPD_BLOCKED_ADDRESS";
  constructor() {
    super(MESSAGES.private_network);
    this.name = "BlockedAddressError";
  }
}

const TAIL = "You can type the details in yourself.";

const MESSAGES = {
  malformed: "That doesn't look like a web address. Paste the full link, starting with http:// or https://, and try again.",
  too_long: "That link is too long to read. Paste the shorter link to the page itself, or type the details in yourself.",
  scheme: "That isn't a public web address we can read: only links that start with http:// or https:// work. Paste the link to the web page itself.",
  credentials: `That link has a username or password in it, so it isn't a public web address we can read. Remove them from the link and try again. ${TAIL}`,
  port: `That link uses an unusual port number, so it isn't a public web address we can read. Use the normal link to the page. ${TAIL}`,
  private_network: `That link points to a private or internal address, not a public web address, so we haven't tried to read it. ${TAIL}`,
  unresolvable: "We couldn't find a website at that address. Check the link for typos and try again.",
  dns_failed: "We couldn't look up that website just now. Try again in a moment, or type the details in yourself.",
} as const;

export const UNSAFE_URL_MESSAGES = MESSAGES;

// ---------------------------------------------------------------------------------------------
// IP address classification
// ---------------------------------------------------------------------------------------------

/** IPv4 ranges that are not public unicast addresses. [first address, prefix length]. */
const V4_BLOCKED: ReadonlyArray<readonly [string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including the cloud metadata address 169.254.169.254
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation (TEST-NET-1)
  ["192.88.99.0", 24], // old 6to4 relay anycast
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation (TEST-NET-2)
  ["203.0.113.0", 24], // documentation (TEST-NET-3)
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255
];

function strictIpv4(s: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  let out = 0;
  for (let i = 1; i <= 4; i++) {
    const part = m[i] ?? "";
    if (part.length > 1 && part.startsWith("0")) return null; // 010 is ambiguous (octal); refuse
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

const V4_BLOCKED_PARSED = V4_BLOCKED.map(([base, bits]) => {
  const n = strictIpv4(base);
  if (n === null) throw new Error("Bad built-in IPv4 range");
  return { base: n, bits };
});

function ipv4InRange(n: number, base: number, bits: number): boolean {
  if (bits === 0) return true;
  const mask = (0xffffffff << (32 - bits)) >>> 0;
  return ((n & mask) >>> 0) === ((base & mask) >>> 0);
}

function isBlockedIpv4Number(n: number): boolean {
  return V4_BLOCKED_PARSED.some((r) => ipv4InRange(n, r.base, r.bits));
}

/** One WHATWG IPv4 part: decimal, 0x hex or leading-zero octal. Returns null when it is not a number. */
function parseIpv4Part(part: string): number | null {
  if (part === "") return null;
  let digits = part;
  let radix = 10;
  if (digits.length >= 2 && (digits.startsWith("0x") || digits.startsWith("0X"))) {
    digits = digits.slice(2);
    radix = 16;
  } else if (digits.length >= 2 && digits.startsWith("0")) {
    digits = digits.slice(1);
    radix = 8;
  }
  if (digits === "") return 0;
  const re = radix === 16 ? /^[0-9a-fA-F]+$/ : radix === 8 ? /^[0-7]+$/ : /^[0-9]+$/;
  if (!re.test(digits)) return null;
  return parseInt(digits, radix);
}

/**
 * IPv4 in every form a URL parser or inet_aton accepts: 127.0.0.1, 2130706433, 0x7f.0.0.1, 017700000001, 127.1.
 * Returns the address as a 32-bit number, or null when it is not an IPv4 address.
 */
function parseIpv4Loose(input: string): number | null {
  const parts = input.split(".");
  if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
  if (parts.length === 0 || parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const n = parseIpv4Part(p);
    if (n === null) return null;
    nums.push(n);
  }
  const last = nums[nums.length - 1] ?? 0;
  for (let i = 0; i < nums.length - 1; i++) {
    if ((nums[i] ?? 0) > 255) return null;
  }
  if (last >= 256 ** (5 - nums.length)) return null;
  let value = last;
  for (let i = 0; i < nums.length - 1; i++) value += (nums[i] ?? 0) * 256 ** (3 - i);
  return value;
}

function parseGroups(part: string): number[] | null {
  if (part === "") return [];
  const out: number[] = [];
  for (const g of part.split(":")) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out;
}

/** IPv6 text to eight 16-bit words, or null if it is not valid IPv6. Accepts [brackets], zone ids and a dotted IPv4 tail. */
function parseIpv6(input: string): number[] | null {
  let s = input;
  if (s.startsWith("[") && s.endsWith("]")) s = s.slice(1, -1);
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  if (!s.includes(":")) return null;
  const lastColon = s.lastIndexOf(":");
  const tail = s.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = strictIpv4(tail);
    if (v4 === null) return null;
    s = `${s.slice(0, lastColon + 1)}${Math.floor(v4 / 65536).toString(16)}:${(v4 % 65536).toString(16)}`;
  }
  const dbl = s.indexOf("::");
  if (dbl !== s.lastIndexOf("::")) return null;
  if (dbl === -1) {
    const words = parseGroups(s);
    return words && words.length === 8 ? words : null;
  }
  const head = parseGroups(s.slice(0, dbl));
  const rest = parseGroups(s.slice(dbl + 2));
  if (!head || !rest) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

/** IPv6 ranges that are not public unicast. Checked after the embedded-IPv4 cases below. */
const V6_BLOCKED_RAW: ReadonlyArray<readonly [string, number]> = [
  ["100::", 64], // discard-only
  ["2001::", 23], // IETF protocol assignments (Teredo is handled before this table)
  ["2001:db8::", 32], // documentation
  ["3fff::", 20], // documentation
  ["5f00::", 16], // segment routing SIDs
  ["fc00::", 7], // unique local addresses, includes fd00:ec2::254 (AWS)
  ["fe80::", 10], // link-local
  ["fec0::", 10], // old site-local
  ["ff00::", 8], // multicast
];

const V6_BLOCKED = V6_BLOCKED_RAW.map(([base, bits]) => {
  const words = parseIpv6(base);
  if (!words) throw new Error("Bad built-in IPv6 range");
  return { words, bits };
});

function ipv6InRange(words: number[], range: { words: number[]; bits: number }): boolean {
  let remaining = range.bits;
  for (let i = 0; i < 8 && remaining > 0; i++) {
    const bits = Math.min(16, remaining);
    const mask = (0xffff << (16 - bits)) & 0xffff;
    if (((words[i] ?? 0) & mask) !== ((range.words[i] ?? 0) & mask)) return false;
    remaining -= bits;
  }
  return true;
}

function v4FromWords(hi: number | undefined, lo: number | undefined): number {
  return (hi ?? 0) * 65536 + (lo ?? 0);
}

function isBlockedIpv6(w: number[]): boolean {
  const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);

  // IPv4-mapped ::ffff:a.b.c.d and IPv4-translated ::ffff:0:a.b.c.d: judged by the IPv4 address inside.
  if (zero(0, 5) && w[5] === 0xffff) return isBlockedIpv4Number(v4FromWords(w[6], w[7]));
  if (zero(0, 4) && w[4] === 0xffff && w[5] === 0) return isBlockedIpv4Number(v4FromWords(w[6], w[7]));

  // ::/96 covers unspecified (::), loopback (::1) and the old IPv4-compatible form.
  if (zero(0, 6)) return true;

  // NAT64 64:ff9b::/96 carries an IPv4 address; 64:ff9b:1::/48 is local use only.
  if (w[0] === 0x64 && w[1] === 0xff9b) {
    if (zero(2, 6)) return isBlockedIpv4Number(v4FromWords(w[6], w[7]));
    if (w[2] === 1) return true;
  }

  // 6to4 2002::/16 carries an IPv4 address in bits 16-47.
  if (w[0] === 0x2002) return isBlockedIpv4Number(v4FromWords(w[1], w[2]));

  // Teredo 2001:0::/32 carries a server IPv4 (bits 32-63) and an obfuscated client IPv4 (the last 32 bits, inverted).
  if (w[0] === 0x2001 && w[1] === 0) {
    const server = v4FromWords(w[2], w[3]);
    const client = (v4FromWords(w[6], w[7]) ^ 0xffffffff) >>> 0;
    return isBlockedIpv4Number(server) || isBlockedIpv4Number(client);
  }

  if (V6_BLOCKED.some((r) => ipv6InRange(w, r))) return true;

  // Only global unicast (2000::/3) is public. Everything else is reserved or unassigned, so refuse it.
  return ((w[0] ?? 0) & 0xe000) !== 0x2000;
}

/**
 * True when the address is NOT a public internet address and must not be requested.
 * Fails closed: text that is not a valid IPv4 or IPv6 address also returns true.
 * Accepts the odd IPv4 spellings (decimal 2130706433, hex 0x7f.0.0.1, octal 017700000001, short 127.1),
 * IPv6 with or without [brackets], and IPv6 that embeds an IPv4 address.
 */
export function isBlockedIp(ip: string): boolean {
  if (typeof ip !== "string") return true;
  const s = ip.trim();
  if (s === "") return true;
  if (s.includes(":")) {
    const words = parseIpv6(s);
    return words === null ? true : isBlockedIpv6(words);
  }
  const n = parseIpv4Loose(s);
  return n === null ? true : isBlockedIpv4Number(n);
}

// ---------------------------------------------------------------------------------------------
// Hostname rules
// ---------------------------------------------------------------------------------------------

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "broadcasthost",
  "metadata",
  "metadata.google.internal",
  "instance-data",
]);

const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".localdomain",
  ".internal",
  ".intranet",
  ".private",
  ".lan",
  ".home",
  ".corp",
  ".home.arpa",
  ".arpa",
  ".onion",
];

function isBlockedHostname(host: string): boolean {
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (!host.includes(".")) return true; // single-label names are internal names
  return BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

// ---------------------------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------------------------

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

/** Looks a hostname up. Injectable so tests never touch real DNS. */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

/** The system resolver (getaddrinfo), so /etc/hosts and the platform's own rules apply, like a real connection would. */
export const defaultResolve: Resolver = async (hostname) => {
  const found = await dnsPromises.lookup(hostname, { all: true, verbatim: true });
  return found.map((a) => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));
};

export interface SsrfDeps {
  resolve?: Resolver;
}

const MAX_URL_LENGTH = 2048;

function errorCode(e: unknown): string {
  if (typeof e === "object" && e !== null && "code" in e) {
    const c = (e as { code?: unknown }).code;
    if (typeof c === "string") return c;
  }
  return "";
}

/** Maps a DNS failure to the right UnsafeUrlError. */
function dnsFailure(e: unknown): UnsafeUrlError {
  const code = errorCode(e);
  if (code === "ENOTFOUND" || code === "ENODATA") return new UnsafeUrlError("unresolvable", MESSAGES.unresolvable);
  return new UnsafeUrlError("dns_failed", MESSAGES.dns_failed);
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * A pasted link can have plain spaces in its path, query or fragment ("/events/My Event 2026.html"). Browsers
 * percent-encode them, so do the same. A space before the path (in the scheme or the host) is left in place, and
 * the caller refuses the link. Tabs, line breaks and other control characters are refused before this runs.
 */
function encodeSpacesAfterHost(text: string): string {
  if (!text.includes(" ")) return text;
  const prefix = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.exec(text)?.[0];
  if (prefix === undefined) return text;
  const rest = text.slice(prefix.length);
  const hostEnd = rest.search(/[/?#\\]/);
  if (hostEnd === -1) return text;
  return `${prefix}${rest.slice(0, hostEnd)}${rest.slice(hostEnd).replace(/ /g, "%20")}`;
}

/**
 * Throws UnsafeUrlError unless the URL is a plain public http(s) address. Returns the parsed URL; request THAT
 * (its href), never the original text, so the parser and the checker always agree about the host.
 *
 * Rules: http/https only; no username or password; no explicit port other than 80 or 443; no local or internal
 * hostnames; no IP literal in any non-public range; and the hostname must resolve, with EVERY address public.
 */
export async function assertSafeUrl(raw: string, deps: SsrfDeps = {}): Promise<URL> {
  if (typeof raw !== "string") throw new UnsafeUrlError("malformed", MESSAGES.malformed);
  const trimmed = raw.trim();
  if (trimmed === "") throw new UnsafeUrlError("malformed", MESSAGES.malformed);
  if (trimmed.length > MAX_URL_LENGTH) throw new UnsafeUrlError("too_long", MESSAGES.too_long);
  // The URL parser silently deletes tabs and line breaks, which can hide what a link really says. Refuse them.
  if (CONTROL_CHARACTER.test(trimmed)) throw new UnsafeUrlError("malformed", MESSAGES.malformed);
  const text = encodeSpacesAfterHost(trimmed);
  // Any space left is in the scheme or the host.
  if (text.includes(" ")) throw new UnsafeUrlError("malformed", MESSAGES.malformed);
  if (text.length > MAX_URL_LENGTH) throw new UnsafeUrlError("too_long", MESSAGES.too_long);

  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new UnsafeUrlError("malformed", MESSAGES.malformed);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") throw new UnsafeUrlError("scheme", MESSAGES.scheme);
  if (url.username !== "" || url.password !== "") throw new UnsafeUrlError("credentials", MESSAGES.credentials);
  // The parser drops a port that is the default for the scheme, so an explicit port here is a non-default one.
  if (url.port !== "" && url.port !== "80" && url.port !== "443") throw new UnsafeUrlError("port", MESSAGES.port);

  const host = url.hostname.replace(/\.+$/, "").toLowerCase();
  if (host === "") throw new UnsafeUrlError("malformed", MESSAGES.malformed);

  // IP literals: judged on their own, no DNS needed.
  if (host.startsWith("[") || isIP(host) !== 0) {
    if (isBlockedIp(host)) throw new UnsafeUrlError("blocked_ip", MESSAGES.private_network);
    return url;
  }

  if (isBlockedHostname(host)) throw new UnsafeUrlError("blocked_host", MESSAGES.private_network);

  let addresses: ResolvedAddress[];
  try {
    addresses = await (deps.resolve ?? defaultResolve)(host);
  } catch (e) {
    throw dnsFailure(e);
  }
  if (!Array.isArray(addresses) || addresses.length === 0) throw new UnsafeUrlError("unresolvable", MESSAGES.unresolvable);
  // ANY non-public answer refuses the host: a name that mixes public and private addresses is how rebinding is staged.
  if (addresses.some((a) => isBlockedIp(a.address))) throw new UnsafeUrlError("blocked_ip", MESSAGES.private_network);
  return url;
}

// ---------------------------------------------------------------------------------------------
// Validating lookup for the HTTP agent
// ---------------------------------------------------------------------------------------------

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function lookupError(code: string, message: string): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error(message);
  err.code = code;
  return err;
}

function wantedFamily(value: unknown): 0 | 4 | 6 {
  if (value === 4 || value === "IPv4") return 4;
  if (value === 6 || value === "IPv6") return 6;
  return 0;
}

/**
 * A dns.lookup replacement for net.connect / undici's `connect.lookup`. It resolves the name, checks EVERY
 * address with isBlockedIp, and hands back only addresses that passed. If any address is not public it fails
 * the connection, so the socket can never be opened to a private address, even if DNS changed since the
 * earlier assertSafeUrl check. Handles both call shapes: `all: true` (an array of {address, family}) and the
 * single-address form (address, family).
 */
export function createValidatingLookup(resolve: Resolver = defaultResolve): LookupFunction {
  const lookup = (hostname: string, optionsOrCallback: unknown, maybeCallback?: unknown): void => {
    const callback = (typeof optionsOrCallback === "function" ? optionsOrCallback : maybeCallback) as LookupCallback;
    const options =
      typeof optionsOrCallback === "function" || optionsOrCallback === undefined || optionsOrCallback === null
        ? {}
        : typeof optionsOrCallback === "number"
          ? { family: optionsOrCallback }
          : (optionsOrCallback as { family?: unknown; all?: unknown });
    const all = (options as { all?: unknown }).all === true;
    const family = wantedFamily((options as { family?: unknown }).family);

    const fail = (err: NodeJS.ErrnoException) => (all ? callback(err, []) : callback(err, "", 0));

    const answer =
      isIP(hostname) !== 0
        ? Promise.resolve<ResolvedAddress[]>([{ address: hostname, family: isIP(hostname) === 6 ? 6 : 4 }])
        : resolve(hostname);

    answer.then(
      (addresses) => {
        if (!Array.isArray(addresses) || addresses.length === 0) {
          fail(lookupError("ENOTFOUND", "No address was found for that host."));
          return;
        }
        if (addresses.some((a) => isBlockedIp(a.address))) {
          fail(new BlockedAddressError());
          return;
        }
        const usable = family === 0 ? addresses : addresses.filter((a) => a.family === family);
        const first = usable[0];
        if (!first) {
          fail(lookupError("ENOTFOUND", "No address of the requested type was found for that host."));
          return;
        }
        if (all) callback(null, usable.map((a) => ({ address: a.address, family: a.family })));
        else callback(null, first.address, first.family);
      },
      (e: unknown) => {
        const code = errorCode(e) || "EAI_AGAIN";
        fail(lookupError(code, "The host name could not be looked up."));
      },
    );
  };
  return lookup as LookupFunction;
}
