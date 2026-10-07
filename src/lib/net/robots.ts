/**
 * robots.txt, the subset of RFC 9309 we need.
 *
 * - Groups are keyed by User-agent. We match our product token "CPDLoggerBot", case-insensitively. A group that
 *   names us beats the "*" group. Several groups naming us are combined.
 * - Allow and Disallow support "*" (any characters) and a trailing "$" (end of the path).
 * - The longest matching pattern wins. If an Allow and a Disallow tie, Allow wins.
 * - An empty Disallow allows everything. Crawl-delay and other lines are ignored.
 *
 * What the fetch result means:
 *   2xx  parse it (first 512 KiB), whatever Content-Type the site put on it (S3 and others serve it as octet-stream)
 *   4xx  there is no robots file, so reading is allowed
 *   5xx, timeout, network error, anything else  we could not confirm, so we do NOT read (robots_unconfirmed)
 *
 * The matcher never builds a regular expression from the file, so a hostile robots.txt cannot cause a slow match.
 */
import { BOT_PRODUCT_TOKEN, safeRequest } from "./safe-request";
import type { SafeRequestDeps, SafeResult } from "./safe-request";

export const ROBOTS_MAX_BYTES = 512 * 1024;
export const ROBOTS_TTL_MS = 60 * 60 * 1000;
export const ROBOTS_UNCONFIRMED_TTL_MS = 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

export const ROBOTS_DISALLOWED_MESSAGE =
  "This site asks automated tools not to read this page, so we haven't. You can type the details in yourself.";
export const ROBOTS_UNCONFIRMED_MESSAGE =
  "We couldn't confirm that this site allows automated reading, so we haven't read it. You can type the details in yourself.";

export interface RobotsRule {
  allow: boolean;
  /** Normalised pattern, never empty. */
  pattern: string;
}

export interface RobotsGroup {
  /** Lower-case product tokens, or "*". */
  agents: string[];
  rules: RobotsRule[];
}

export interface RobotsRules {
  groups: RobotsGroup[];
}

/** Upper-case percent escapes, escape non-ASCII as UTF-8, and decode escapes of unreserved characters. */
function normaliseOctets(input: string): string {
  let text = "";
  for (const ch of input) {
    if (ch.charCodeAt(0) > 0x7f) {
      try {
        text += encodeURIComponent(ch);
      } catch {
        // A lone surrogate cannot be encoded. It cannot be part of a real path either, so drop it.
      }
    } else {
      text += ch;
    }
  }
  return text.replace(/%([0-9a-fA-F]{2})/g, (_m, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9\-._~]/.test(ch) ? ch : `%${hex.toUpperCase()}`;
  });
}

function directiveName(key: string): "user-agent" | "allow" | "disallow" | null {
  // Common spellings and typos that crawlers in the wild also accept.
  const k = key.toLowerCase().replace(/[\s_-]+/g, "");
  if (k === "useragent") return "user-agent";
  if (k === "allow") return "allow";
  if (k === "disallow" || k === "dissallow" || k === "dissalow" || k === "disalow" || k === "diasllow" || k === "disallaw") return "disallow";
  return null;
}

/** Parse robots.txt text. Never throws. */
export function parseRobots(text: string): RobotsRules {
  const groups: RobotsGroup[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;

  for (const rawLine of text.replace(/^\uFEFF/, "").split(/\r\n|\r|\n/)) {
    const hash = rawLine.indexOf("#");
    const line = (hash === -1 ? rawLine : rawLine.slice(0, hash)).trim();
    if (line === "") continue;

    let key: string;
    let value: string;
    const colon = line.indexOf(":");
    if (colon !== -1) {
      key = line.slice(0, colon).trim();
      value = line.slice(colon + 1).trim();
    } else {
      // "Disallow /private" (no colon) is a common typo that crawlers accept.
      const loose = /^(user-agent|allow|disallow)\s+(.*)$/i.exec(line);
      if (!loose) continue;
      key = loose[1] ?? "";
      value = (loose[2] ?? "").trim();
    }

    const name = directiveName(key);
    if (name === "user-agent") {
      const token = /^[A-Za-z0-9_*-]+/.exec(value)?.[0]?.toLowerCase() ?? "";
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(token);
      lastWasAgent = true;
    } else if (name === "allow" || name === "disallow") {
      lastWasAgent = false;
      if (!current) continue; // a rule before any User-agent line belongs to no group
      const pattern = normaliseOctets(value);
      if (pattern === "") continue; // an empty Disallow (or Allow) changes nothing
      current.rules.push({ allow: name === "allow", pattern });
    }
    // Sitemap, Crawl-delay, Host and anything else are ignored and do not end a group.
  }
  return { groups };
}

/** The rules that apply to us: groups naming us if there are any, otherwise the "*" groups. */
export function rulesForAgent(rules: RobotsRules, token: string = BOT_PRODUCT_TOKEN): RobotsRule[] {
  const wanted = token.toLowerCase();
  const specific = rules.groups.filter((g) => g.agents.includes(wanted));
  const chosen = specific.length > 0 ? specific : rules.groups.filter((g) => g.agents.includes("*"));
  return chosen.flatMap((g) => g.rules);
}

/** Does a robots pattern match the start of the path? "*" matches any run of characters, a trailing "$" anchors the end. */
export function patternMatches(pattern: string, path: string): boolean {
  let body = pattern;
  let anchored = false;
  if (body.endsWith("$")) {
    anchored = true;
    body = body.slice(0, -1);
  }
  const parts = body.split("*");
  const first = parts[0] ?? "";
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return anchored ? path === first : true;

  // Match each literal piece at its earliest position, in order. That is enough for a pattern with only "*"
  // wildcards, and it takes linear time however many wildcards the file contains.
  let pos = first.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const piece = parts[i] ?? "";
    if (piece === "") continue;
    const at = path.indexOf(piece, pos);
    if (at === -1) return false;
    pos = at + piece.length;
  }
  const last = parts[parts.length - 1] ?? "";
  if (anchored) return path.length - last.length >= pos && path.endsWith(last);
  return last === "" || path.indexOf(last, pos) !== -1;
}

/**
 * Is this path (with its query string) allowed for us? Longest matching pattern wins, Allow wins a tie,
 * and no match means allowed.
 */
export function isPathAllowed(rules: RobotsRules, pathWithQuery: string, token: string = BOT_PRODUCT_TOKEN): boolean {
  const path = normaliseOctets(pathWithQuery === "" ? "/" : pathWithQuery);
  let best: { length: number; allow: boolean } | null = null;
  for (const rule of rulesForAgent(rules, token)) {
    if (!patternMatches(rule.pattern, path)) continue;
    const length = rule.pattern.length;
    if (best === null || length > best.length || (length === best.length && rule.allow && !best.allow)) {
      best = { length, allow: rule.allow };
    }
  }
  return best === null ? true : best.allow;
}

// ---------------------------------------------------------------------------------------------
// Fetching and caching
// ---------------------------------------------------------------------------------------------

export type RobotsDecision =
  | { allowed: true; source: "robots_txt" | "no_robots_file" }
  | { allowed: false; kind: "robots_disallowed" | "robots_unconfirmed"; message: string };

export interface RobotsChecker {
  /** Decide whether we may read this URL. Fetches /robots.txt on its origin if it is not cached. Never throws. */
  check(url: URL | string): Promise<RobotsDecision>;
  /** Forget everything cached. */
  clear(): void;
}

export interface RobotsCheckerDeps extends SafeRequestDeps {
  /** Replace the robots.txt fetch (tests). Receives the robots.txt URL. */
  fetch?: (robotsUrl: string) => Promise<SafeResult>;
  /** Deadline for the robots.txt fetch. Default 8000. */
  timeoutMs?: number;
  /** How many origins to remember. Default 500. */
  maxEntries?: number;
}

type RobotsEntry = { kind: "rules"; rules: RobotsRules } | { kind: "none" } | { kind: "unconfirmed" };

interface CacheSlot {
  entry: Promise<RobotsEntry>;
  /** Infinity while the fetch is still running. */
  expiresAt: number;
}

export function createRobotsChecker(deps: RobotsCheckerDeps = {}): RobotsChecker {
  const now = deps.now ?? Date.now;
  const maxEntries = deps.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const cache = new Map<string, CacheSlot>();

  const fetchRobots =
    deps.fetch ??
    ((robotsUrl: string) =>
      safeRequest(
        robotsUrl,
        // readBody "always": a robots.txt served as application/octet-stream is still a robots.txt. Reading it as
        // empty would drop every Disallow in it.
        { accept: "text/plain,*/*;q=0.5", maxBytes: ROBOTS_MAX_BYTES, onOverflow: "truncate", readBody: "always", timeoutMs: deps.timeoutMs },
        { request: deps.request, resolve: deps.resolve, now: deps.now, contact: deps.contact },
      ));

  async function load(origin: string): Promise<RobotsEntry> {
    let result: SafeResult;
    try {
      result = await fetchRobots(`${origin}/robots.txt`);
    } catch {
      return { kind: "unconfirmed" };
    }
    if (!result.ok) return { kind: "unconfirmed" }; // timeout, network error, unsafe redirect, ...
    const status = result.status;
    if (status >= 200 && status < 300) {
      let text = result.body;
      // Cut at the size cap: drop the last line, which may be half a rule.
      if (result.truncated) text = text.slice(0, text.lastIndexOf("\n") + 1);
      return { kind: "rules", rules: parseRobots(text) };
    }
    if (status >= 400 && status < 500) return { kind: "none" };
    return { kind: "unconfirmed" }; // 5xx, or a redirect that went nowhere
  }

  function evict(): void {
    if (cache.size <= maxEntries) return;
    const t = now();
    for (const [key, slot] of cache) {
      if (slot.expiresAt <= t) cache.delete(key);
    }
    while (cache.size > maxEntries) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
    }
  }

  function entryFor(origin: string): Promise<RobotsEntry> {
    const hit = cache.get(origin);
    if (hit && hit.expiresAt > now()) return hit.entry;
    const slot: CacheSlot = { entry: Promise.resolve({ kind: "unconfirmed" }), expiresAt: Number.POSITIVE_INFINITY };
    slot.entry = load(origin)
      .catch((): RobotsEntry => ({ kind: "unconfirmed" }))
      .then((entry) => {
        slot.expiresAt = now() + (entry.kind === "unconfirmed" ? ROBOTS_UNCONFIRMED_TTL_MS : ROBOTS_TTL_MS);
        return entry;
      });
    cache.set(origin, slot);
    evict();
    return slot.entry;
  }

  return {
    async check(input) {
      let url: URL;
      try {
        url = typeof input === "string" ? new URL(input) : input;
      } catch {
        return { allowed: false, kind: "robots_unconfirmed", message: ROBOTS_UNCONFIRMED_MESSAGE };
      }
      const entry = await entryFor(url.origin);
      if (entry.kind === "unconfirmed") return { allowed: false, kind: "robots_unconfirmed", message: ROBOTS_UNCONFIRMED_MESSAGE };
      if (entry.kind === "none") return { allowed: true, source: "no_robots_file" };
      return isPathAllowed(entry.rules, `${url.pathname}${url.search}`)
        ? { allowed: true, source: "robots_txt" }
        : { allowed: false, kind: "robots_disallowed", message: ROBOTS_DISALLOWED_MESSAGE };
    },
    clear() {
      cache.clear();
    },
  };
}
