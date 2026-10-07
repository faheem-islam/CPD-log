/**
 * JSON-LD reading shared by the generic and event adapters. Page JSON-LD is untrusted input:
 * it is parsed defensively, never evaluated, and only plain strings are read from it.
 */
import type { Doc } from "./common";
import { cleanText } from "./common";

export type JsonObj = Record<string, unknown>;

const MAX_SCRIPT_CHARS = 600_000;
const MAX_NODES = 300;
const MAX_DEPTH = 5;
/** Properties that can hold another typed node worth reading (an article's video, a page's main entity). */
const NESTED_KEYS = ["mainEntity", "mainEntityOfPage", "video"] as const;

export function isObj(v: unknown): v is JsonObj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function stripWrappers(text: string): string {
  return text
    .trim()
    .replace(/^<!--/, "")
    .replace(/-->$/, "")
    .replace(/^\s*\/\*<!\[CDATA\[\*\//, "")
    .replace(/\/\*\]\]>\*\/\s*$/, "")
    .replace(/^\s*<!\[CDATA\[/, "")
    .replace(/\]\]>\s*$/, "")
    .trim();
}

function collect(value: unknown, out: JsonObj[], depth: number): void {
  if (out.length >= MAX_NODES || depth > MAX_DEPTH) return;
  if (Array.isArray(value)) {
    for (const v of value) collect(v, out, depth + 1);
    return;
  }
  if (!isObj(value)) return;
  if ("@type" in value) out.push(value);
  const graph = value["@graph"];
  if (Array.isArray(graph)) collect(graph, out, depth + 1);
  for (const key of NESTED_KEYS) {
    const nested = value[key];
    if (nested !== undefined && nested !== null && typeof nested === "object") collect(nested, out, depth + 1);
  }
}

/** Every typed JSON-LD node on the page, flattening arrays and @graph. Invalid JSON is skipped. */
export function jsonLdNodes(doc: Doc): JsonObj[] {
  const out: JsonObj[] = [];
  doc("script").each((_, el) => {
    const type = (doc(el).attr("type") ?? "").toLowerCase();
    if (!type.includes("ld+json")) return;
    const raw = doc(el).text();
    if (!raw || raw.length > MAX_SCRIPT_CHARS) return;
    try {
      collect(JSON.parse(stripWrappers(raw)), out, 0);
    } catch {
      // Invalid JSON-LD is common on real sites. Ignore it rather than guess.
    }
  });
  return out;
}

/** Type names without any schema.org prefix, lower-cased: "https://schema.org/Event" becomes "event". */
export function typesOf(node: JsonObj): string[] {
  const t = node["@type"];
  const list = Array.isArray(t) ? t : [t];
  return list
    .filter((x): x is string => typeof x === "string")
    .map((x) => x.replace(/^.*[/#:]/, "").toLowerCase());
}

export function hasType(node: JsonObj, test: (type: string) => boolean): boolean {
  return typesOf(node).some(test);
}

export const isVideoNode = (n: JsonObj) => hasType(n, (t) => t === "videoobject");
export const isEventNode = (n: JsonObj) => hasType(n, (t) => t.endsWith("event"));
export const isArticleNode = (n: JsonObj) =>
  hasType(n, (t) => ["article", "newsarticle", "blogposting", "techarticle", "scholarlyarticle", "report", "liveblogposting", "socialmediaposting"].includes(t));
export const isPageNode = (n: JsonObj) =>
  hasType(n, (t) => ["webpage", "itempage", "collectionpage", "aboutpage", "profilepage", "faqpage"].includes(t));

/** How many levels of {name: {name: ...}} or [[...]] textValue follows. Real data needs one or two. */
const MAX_TEXT_DEPTH = 4;

/**
 * A plain string from a JSON-LD value: a string, {"@value"}, {name}, {text}, or the first of an array.
 * It follows nested values only a few levels, so a page cannot make it recurse until the stack runs out.
 */
export function textValue(v: unknown, max = 300, depth = 0): string | null {
  if (depth > MAX_TEXT_DEPTH) return null;
  if (typeof v === "string") {
    const t = cleanText(v, max);
    return t || null;
  }
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) {
    for (const item of v) {
      const t = textValue(item, max, depth + 1);
      if (t) return t;
    }
    return null;
  }
  if (isObj(v)) {
    for (const key of ["name", "@value", "text", "headline"]) {
      const t = textValue(v[key], max, depth + 1);
      if (t) return t;
    }
  }
  return null;
}

/** Up to three names from an author or publisher value (string, object or array of either). */
export function namesOf(v: unknown): string[] {
  const list = Array.isArray(v) ? v : [v];
  const names: string[] = [];
  for (const item of list) {
    const n = textValue(item, 120);
    if (n && !names.includes(n)) names.push(n);
    if (names.length >= 3) break;
  }
  return names;
}

export function first<T>(nodes: readonly T[], test: (n: T) => boolean): T | undefined {
  return nodes.find(test);
}

export type AttendanceMode = "online" | "offline" | "mixed" | null;

export interface EventData {
  name: string | null;
  startDate: string | null;
  endDate: string | null;
  mode: AttendanceMode;
  status: "cancelled" | "postponed" | "rescheduled" | null;
  organizer: string | null;
  hasPlace: boolean;
}

/** Plain facts from a JSON-LD Event node. */
export function readEvent(node: JsonObj): EventData {
  const modeText = textValue(node["eventAttendanceMode"], 200)?.toLowerCase() ?? "";
  let mode: AttendanceMode = null;
  if (modeText.includes("mixed")) mode = "mixed";
  else if (modeText.includes("online")) mode = "online";
  else if (modeText.includes("offline")) mode = "offline";

  const statusText = textValue(node["eventStatus"], 200)?.toLowerCase() ?? "";
  let status: EventData["status"] = null;
  if (statusText.includes("cancel")) status = "cancelled";
  else if (statusText.includes("postpone")) status = "postponed";
  else if (statusText.includes("reschedule")) status = "rescheduled";

  const location = node["location"];
  const locations = Array.isArray(location) ? location : [location];
  const hasPlace = locations.some((l) => isObj(l) && hasType(l, (t) => t === "place" || t === "postaladdress") );

  return {
    name: textValue(node["name"]),
    startDate: typeof node["startDate"] === "string" ? node["startDate"] : null,
    endDate: typeof node["endDate"] === "string" ? node["endDate"] : null,
    mode,
    status,
    organizer: namesOf(node["organizer"])[0] ?? null,
    hasPlace,
  };
}
