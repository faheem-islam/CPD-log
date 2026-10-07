import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EXTRACT_CACHE_TTL_MS, extractFromUrl, mostlyMissingNote, normaliseUserUrl, sharedExtractCache } from "@/lib/extract";
import type { ExtractCache, ExtractDeps } from "@/lib/extract";
import { emptyResult, field, loadDoc } from "@/lib/adapters/common";
import { genericAdapter } from "@/lib/adapters/generic";
import { iceHubAdapter } from "@/lib/adapters/ice-hub";
import type { ApiFetcher, ApiOutcome, PageReader, ReadOutcome } from "@/lib/net/types";
import type { ExtractResponse, ExtractStatus } from "@/lib/types";

const fixture = (kind: "html" | "json", name: string): string => readFileSync(path.resolve(import.meta.dirname, "../fixtures", kind, name), "utf8");
const ICE_HUB_URL = "https://knowledgehub.ice.org.uk/cpd/safety-risk/principal-designer-role/";
const KEY = "TEST-KEY-do-not-leak-0123456789";
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

function okPage(body: string, finalUrl: string, extra: Partial<Extract<ReadOutcome, { kind: "ok" }>> = {}): ReadOutcome {
  return { kind: "ok", finalUrl, status: 200, contentType: "text/html; charset=utf-8", body, fromCache: false, ...extra };
}

class FakeReader implements PageReader {
  calls: string[] = [];
  constructor(private handler: (url: string) => ReadOutcome | Promise<ReadOutcome>) {}
  async read(url: string): Promise<ReadOutcome> {
    this.calls.push(url);
    return this.handler(url);
  }
}

class FakeApi implements ApiFetcher {
  calls: { url: string; headers: Record<string, string> | undefined }[] = [];
  constructor(private handler: (url: string, headers: Record<string, string> | undefined) => ApiOutcome | Promise<ApiOutcome>) {}
  async getJson(url: string, opts?: { headers?: Record<string, string> }): Promise<ApiOutcome> {
    this.calls.push({ url, headers: opts?.headers });
    return this.handler(url, opts?.headers);
  }
}

const neverReader = new FakeReader(() => {
  throw new Error("the page reader should not have been called");
});
const neverApi = new FakeApi(() => {
  throw new Error("the API should not have been called");
});

const apiJson = () => JSON.parse(fixture("json", "youtube-api-video.json")) as unknown;
const oembedJson = () => JSON.parse(fixture("json", "youtube-oembed.json")) as unknown;

function clock(start = "2026-10-07T09:00:00Z") {
  let t = new Date(start).getTime();
  return { now: () => new Date(t), advance: (ms: number) => { t += ms; }, set: (iso: string) => { t = new Date(iso).getTime(); } };
}

function deps(over: Partial<ExtractDeps> & { reader?: PageReader; api?: ApiFetcher } = {}): ExtractDeps {
  return { reader: neverReader, api: neverApi, cache: new Map(), ...over };
}

afterEach(() => {
  sharedExtractCache.clear();
  vi.restoreAllMocks();
});

describe("normaliseUserUrl", () => {
  const accepted: [string, string][] = [
    ["https://example.com/a", "https://example.com/a"],
    ["  https://example.com/a  ", "https://example.com/a"],
    ["\n\thttps://example.com/a\n", "https://example.com/a"],
    ["www.example.com/y", "https://www.example.com/y"],
    ["example.com/y", "https://example.com/y"],
    ["example.com", "https://example.com/"],
    ["www.example.com", "https://www.example.com/"],
    ["//example.com/a", "https://example.com/a"],
    ["http://example.com/a", "http://example.com/a"],
    ["HTTPS://EXAMPLE.COM/Path", "https://example.com/Path"],
    ["https://example.com/a#section-2", "https://example.com/a"],
    ["https://example.com/a?x=1&utm_source=z#top", "https://example.com/a?x=1&utm_source=z"],
    ["<https://example.com/a>", "https://example.com/a"],
    ['"https://example.com/a"', "https://example.com/a"],
    ["'https://example.com/a'", "https://example.com/a"],
    ["https://example.com:8080/a", "https://example.com:8080/a"],
    ["http:/example.com/a", "http://example.com/a"],
    ["https://sub.domain.example.co.uk/a/b/?q=a%20b", "https://sub.domain.example.co.uk/a/b/?q=a%20b"],
    ["https://münchen.example/a", "https://xn--mnchen-3ya.example/a"],
    ["https://example.com/a%20b", "https://example.com/a%20b"],
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s", "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30s"],
    ["https://example.com/a(b)", "https://example.com/a(b)"],
    // The normaliser is not the safety check. Private and odd hosts are for the page reader to refuse.
    ["http://192.168.0.1/a", "http://192.168.0.1/a"],
    ["http://[::1]/a", "http://[::1]/a"],
  ];
  it.each(accepted)("%j becomes %j", (input, expected) => {
    const r = normaliseUserUrl(input);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.href).toBe(expected);
  });

  const rejected: [unknown, string][] = [
    ["", "empty"],
    ["   ", "blank"],
    ["\n", "newline"],
    [undefined, "undefined"],
    [null, "null"],
    [42, "a number"],
    [{}, "an object"],
    ["hello", "one word"],
    ["not a url", "words with spaces"],
    ["check out https://example.com/a", "a sentence"],
    ["https://example.com/a b", "a space inside"],
    ["https://example.com/a\nhttps://example.com/b", "two links"],
    ["https://", "no host"],
    ["http://", "no host over http"],
    ["https:///a", "empty host"],
    ["https://localhost/a", "localhost has no dot"],
    ["localhost", "bare localhost"],
    ["https://exa mple.com", "space in host"],
    ["https://example..com/a", "empty label"],
    ["https://example.c/a", "one-letter top level"],
    ["https://example.123abc/a", "odd top level"],
    ["javascript:alert(1)", "script scheme"],
    ["JavaScript:alert(1)", "script scheme in capitals"],
    ["javascript://example.com/%0Aalert(1)", "script scheme with slashes"],
    ["data:text/html,<script>alert(1)</script>", "data scheme"],
    ["file:///etc/passwd", "file scheme"],
    ["ftp://example.com/a", "ftp scheme"],
    ["mailto:someone@example.com", "mail link"],
    ["tel:+441234567890", "phone link"],
    ["blob:https://example.com/abc", "blob link"],
    ["view-source:https://example.com/", "view-source"],
    ["https://user:pass@example.com/a", "credentials"],
    ["https://user@example.com/a", "username only"],
    [`https://example.com/${"a".repeat(2100)}`, "too long"],
    ["https://example.com/\u0000", "control character"],
  ];
  it.each(rejected)("rejects %j (%s) with a plain message", (input) => {
    const r = normaliseUserUrl(input);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.message.length).toBeGreaterThan(20);
      expect(r.message).not.toMatch(/undefined|\[object|Error|exception|stack/i);
    }
  });

  it("never echoes a script or file link back as the url", () => {
    for (const input of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "vbscript:x", "mailto:a@b.co"]) {
      const r = normaliseUserUrl(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.echo).toBe("");
    }
  });

  it("does not echo credentials back", () => {
    const r = normaliseUserUrl("https://user:secretpass@example.com/a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(JSON.stringify(r)).not.toContain("secretpass");
  });

  it("says what to do in each kind of message", () => {
    const msg = (v: string) => {
      const r = normaliseUserUrl(v);
      return r.ok ? "" : r.message;
    };
    expect(msg("")).toMatch(/Paste a link/);
    expect(msg("hello")).toMatch(/does not look like a web link/);
    expect(msg("ftp://x.com/a")).toMatch(/http:\/\/ or https:\/\//);
    expect(msg("https://u:p@x.com/")).toMatch(/Remove that part/);
    expect(msg("a b")).toMatch(/more than one link|space/);
    expect(msg(`https://x.com/${"a".repeat(2100)}`)).toMatch(/too long/);
  });
});

describe("extractFromUrl: rejecting bad input", () => {
  it.each(["", "   ", "hello", "javascript:alert(1)", "file:///etc/passwd", "https://u:p@example.com/", "not a url", "https://localhost/a"])(
    "%j gives unsafe_url without calling the reader or the API",
    async (input) => {
      const r = await extractFromUrl(input, deps());
      expect(r.status).toBe("unsafe_url");
      expect(r.result).toBeNull();
      expect(r.message.length).toBeGreaterThan(20);
    },
  );

  it("does not crash on non-string input", async () => {
    for (const input of [undefined, null, 5, {}, []]) {
      const r = await extractFromUrl(input as unknown as string, deps());
      expect(r.status).toBe("unsafe_url");
    }
  });

  it("keeps the typed text in url for plain garbage, but never for script links", async () => {
    expect((await extractFromUrl("hello", deps())).url).toBe("hello");
    expect((await extractFromUrl("javascript:alert(1)", deps())).url).toBe("");
  });
});

describe("extractFromUrl: an ok page", () => {
  it("runs the matching adapter and the generic one and merges them", async () => {
    const reader = new FakeReader(() => okPage(fixture("html", "ice-hub-explainer.html"), ICE_HUB_URL));
    const r = await extractFromUrl(ICE_HUB_URL, deps({ reader }));
    expect(r.status).toBe("ok");
    expect(r.cached).toBe(false);
    expect(r.url).toBe(ICE_HUB_URL);
    expect(r.message.length).toBeGreaterThan(10);
    expect(r.result?.adapter).toBe("ice-hub+generic");
    expect(r.result?.title).toMatchObject({ value: "The principal designer role", confidence: "high" });
    expect(r.result?.durationMinutes).toMatchObject({ value: 15, confidence: "high" });
    expect(r.result?.theme).toMatchObject({ value: "Safety and risk management", confidence: "high" });
    expect(reader.calls).toEqual([ICE_HUB_URL]);
  });

  it("adds www and https before reading", async () => {
    const reader = new FakeReader((u) => okPage("<title>Hi</title>", u));
    const r = await extractFromUrl("www.example.com/y", deps({ reader }));
    expect(reader.calls).toEqual(["https://www.example.com/y"]);
    expect(r.url).toBe("https://www.example.com/y");
    expect(r.status).toBe("ok");
  });

  it("returns metadata only, never the page body", async () => {
    const marker = "UNIQUE-BODY-MARKER-9f3a";
    const body = `<html><head><title>Marker page | Site</title></head><body><main><h1>Marker page</h1><p>${marker}</p>${"<p>filler text</p>".repeat(500)}</main></body></html>`;
    const reader = new FakeReader((u) => okPage(body, u));
    const cache: ExtractCache = new Map();
    const r = await extractFromUrl("https://example.com/marker", deps({ reader, cache }));
    const text = JSON.stringify(r);
    expect(text).not.toContain(marker);
    expect(text).not.toContain("filler text");
    expect(text.length).toBeLessThan(6000);
    expect(JSON.stringify([...cache.values()])).not.toContain(marker);
    expect(Object.keys(r).sort()).toEqual(["cached", "message", "result", "status", "url"]);
  });

  it("uses a clear, honest message and never says verified or compliant", async () => {
    const reader = new FakeReader((u) => okPage(fixture("html", "generic-article-jsonld.html"), u));
    const r = await extractFromUrl("https://www.example-engineering.co.uk/insights/x", deps({ reader }));
    const everything = JSON.stringify(r);
    expect(everything).not.toMatch(/verified|compliant|accurate/i);
    expect(r.message).toMatch(/Check each detail/);
  });

  it("every evidence string and note is plain text", async () => {
    const reader = new FakeReader(() => okPage(fixture("html", "ice-event-recording.html"), "https://www.ice.org.uk/events/upcoming-events/recording-cpd"));
    const r = await extractFromUrl("https://www.ice.org.uk/events/upcoming-events/recording-cpd", deps({ reader }));
    const res = r.result;
    expect(res).not.toBeNull();
    if (!res) return;
    for (const k of ["title", "provider", "sourceType", "theme", "durationMinutes", "publishedAt", "eventDate", "providerCpdHours"] as const) {
      expect(res[k].evidence.length).toBeGreaterThan(5);
      expect(res[k].evidence).not.toMatch(/[<>]/);
    }
    expect(res.flags).toEqual({ upcoming: false, recording: true });
  });

  it("passes the injected clock to the adapters, so upcoming follows it", async () => {
    const url = "https://www.ice.org.uk/events/upcoming-events/safe-working-near-water/";
    const body = fixture("html", "ice-event-upcoming.html");
    const before = clock("2027-03-10T09:00:00Z");
    const a = await extractFromUrl(url, deps({ reader: new FakeReader((u) => okPage(body, u)), now: before.now }));
    expect(a.result?.flags.upcoming).toBe(true);
    const after = clock("2027-03-20T09:00:00Z");
    const b = await extractFromUrl(url, deps({ reader: new FakeReader((u) => okPage(body, u)), now: after.now }));
    expect(b.result?.flags.upcoming).toBe(false);
  });
});

describe("extractFromUrl: every non-ok outcome is passed straight through", () => {
  const statuses: Exclude<ExtractStatus, "ok">[] = ["blocked", "robots_disallowed", "robots_unconfirmed", "login_required", "challenge", "unsafe_url", "failed"];
  it.each(statuses)("%s keeps its status and message, with no result", async (kind) => {
    const message = `Plain words for ${kind}: what went wrong and what to do.`;
    const reader = new FakeReader(() => ({ kind, message }));
    const r = await extractFromUrl("https://example.com/page", deps({ reader }));
    expect(r.status).toBe(kind);
    expect(r.message).toBe(message);
    expect(r.result).toBeNull();
    expect(r.url).toBe("https://example.com/page");
    expect(reader.calls).toHaveLength(1);
  });

  it.each(statuses)("%s is not cached, and is not retried within one call", async (kind) => {
    const reader = new FakeReader(() => ({ kind, message: "Something plain." }));
    const cache: ExtractCache = new Map();
    await extractFromUrl("https://example.com/page", deps({ reader, cache }));
    expect(cache.size).toBe(0);
    expect(reader.calls).toHaveLength(1);
    await extractFromUrl("https://example.com/page", deps({ reader, cache }));
    expect(reader.calls).toHaveLength(2);
  });

  it("uses a plain default message if the reader gives an empty one", async () => {
    const reader = new FakeReader(() => ({ kind: "login_required", message: "  " }));
    const r = await extractFromUrl("https://example.com/page", deps({ reader }));
    expect(r.status).toBe("login_required");
    expect(r.message).toMatch(/login/);
  });

  it("returns failed, without the error text, if the reader throws", async () => {
    const reader = new FakeReader(() => {
      throw new Error("socket exploded at 10.0.0.5 with token abc123");
    });
    const r = await extractFromUrl("https://example.com/page", deps({ reader }));
    expect(r.status).toBe("failed");
    expect(r.result).toBeNull();
    expect(JSON.stringify(r)).not.toMatch(/exploded|10\.0\.0\.5|abc123/);
  });

  it("returns failed for an HTTP error status that the reader let through", async () => {
    const reader = new FakeReader((u) => okPage("<h1>Not found</h1>", u, { status: 404 }));
    const r = await extractFromUrl("https://example.com/missing", deps({ reader }));
    expect(r.status).toBe("failed");
    expect(r.message).toContain("404");
    expect(r.result).toBeNull();
  });

  it.each(["application/pdf", "image/png", "application/json", "text/plain; charset=utf-8", "application/octet-stream"])(
    "returns failed for a %s response, with plain words",
    async (contentType) => {
      const reader = new FakeReader((u) => okPage("%PDF-1.7 binary", u, { contentType }));
      const r = await extractFromUrl("https://example.com/file.pdf", deps({ reader }));
      expect(r.status).toBe("failed");
      expect(r.message).toMatch(/file|PDF|web page/);
      expect(r.result).toBeNull();
    },
  );

  it.each(["text/html", "text/html; charset=utf-8", "application/xhtml+xml", "TEXT/HTML", ""])("reads a %j response", async (contentType) => {
    const reader = new FakeReader((u) => okPage("<title>Hello world page</title>", u, { contentType }));
    const r = await extractFromUrl("https://example.com/p", deps({ reader }));
    expect(r.status).toBe("ok");
  });
});

describe("extractFromUrl: the 10 minute cache", () => {
  const body = "<html><head><title>Cache me | Site</title></head><body><main><h1>Cache me</h1></main></body></html>";

  it("serves the second request from the cache and does not read the page again", async () => {
    const reader = new FakeReader((u) => okPage(body, u));
    const c = clock();
    const d = deps({ reader, now: c.now });
    const first = await extractFromUrl("https://example.com/p", d);
    expect(first.cached).toBe(false);
    c.advance(9 * 60 * 1000 + 59 * 1000);
    const second = await extractFromUrl("https://example.com/p", d);
    expect(second.cached).toBe(true);
    expect(second.status).toBe("ok");
    expect(second.result).toEqual(first.result);
    expect(reader.calls).toHaveLength(1);
  });

  it("misses once 10 minutes have passed", async () => {
    const reader = new FakeReader((u) => okPage(body, u));
    const c = clock();
    const d = deps({ reader, now: c.now });
    await extractFromUrl("https://example.com/p", d);
    c.advance(EXTRACT_CACHE_TTL_MS);
    const again = await extractFromUrl("https://example.com/p", d);
    expect(again.cached).toBe(false);
    expect(reader.calls).toHaveLength(2);
    c.advance(EXTRACT_CACHE_TTL_MS - 1);
    expect((await extractFromUrl("https://example.com/p", d)).cached).toBe(true);
    expect(reader.calls).toHaveLength(2);
  });

  it("is 10 minutes exactly", () => {
    expect(EXTRACT_CACHE_TTL_MS).toBe(600_000);
  });

  it("misses if the clock goes backwards", async () => {
    const reader = new FakeReader((u) => okPage(body, u));
    const c = clock("2026-10-07T09:00:00Z");
    const d = deps({ reader, now: c.now });
    await extractFromUrl("https://example.com/p", d);
    c.set("2026-10-06T09:00:00Z");
    expect((await extractFromUrl("https://example.com/p", d)).cached).toBe(false);
  });

  it("keys on the normalised URL, so spelling and fragments share an entry", async () => {
    const reader = new FakeReader((u) => okPage(body, u));
    const d = deps({ reader });
    await extractFromUrl("https://example.com/p", d);
    expect((await extractFromUrl("  example.com/p#top ", d)).cached).toBe(true);
    expect((await extractFromUrl("HTTPS://EXAMPLE.COM/p", d)).cached).toBe(true);
    expect((await extractFromUrl("https://example.com/other", d)).cached).toBe(false);
    expect((await extractFromUrl("https://example.com/p?x=1", d)).cached).toBe(false);
    expect(reader.calls).toHaveLength(3);
  });

  it("stores only the extraction result, not page bodies", async () => {
    const marker = "BODY-ONLY-MARKER-77";
    const reader = new FakeReader((u) => okPage(`<html><head><title>T | S</title></head><body><main><h1>T</h1><p>${marker}</p></main></body></html>`, u));
    const cache: ExtractCache = new Map();
    await extractFromUrl("https://example.com/p", deps({ reader, cache }));
    expect(cache.size).toBe(1);
    expect(JSON.stringify([...cache.entries()])).not.toContain(marker);
    const entry = [...cache.values()][0];
    expect(Object.keys(entry?.response ?? {}).sort()).toEqual(["cached", "message", "result", "status", "url"]);
  });

  it("gives each caller its own copy, so changing a response cannot change the cache", async () => {
    const reader = new FakeReader((u) => okPage(body, u));
    const d = deps({ reader });
    const first = await extractFromUrl("https://example.com/p", d);
    if (first.result) first.result.title.value = "CHANGED";
    const second = await extractFromUrl("https://example.com/p", d);
    expect(second.result?.title.value).toBe("Cache me");
    if (second.result) second.result.title.value = "CHANGED AGAIN";
    expect((await extractFromUrl("https://example.com/p", d)).result?.title.value).toBe("Cache me");
  });

  it("does not let one cache's entries into another", async () => {
    const reader = new FakeReader((u) => okPage(body, u));
    await extractFromUrl("https://example.com/p", deps({ reader }));
    await extractFromUrl("https://example.com/p", deps({ reader }));
    expect(reader.calls).toHaveLength(2);
  });

  it("uses a shared cache when none is passed", async () => {
    const reader = new FakeReader((u) => okPage(body, u));
    const base = { reader, api: neverApi };
    await extractFromUrl("https://example.com/shared", base);
    const again = await extractFromUrl("https://example.com/shared", base);
    expect(again.cached).toBe(true);
    expect(reader.calls).toHaveLength(1);
    expect(sharedExtractCache.size).toBe(1);
  });

  it("does not grow without limit", async () => {
    const reader = new FakeReader((u) => okPage(body, u));
    const cache: ExtractCache = new Map();
    const d = deps({ reader, cache });
    for (let i = 0; i < 520; i += 1) await extractFromUrl(`https://example.com/p${i}`, d);
    expect(cache.size).toBeLessThanOrEqual(500);
    expect(cache.has("https://example.com/p519")).toBe(true);
  });

  it("drops expired entries first when it is full", async () => {
    const reader = new FakeReader((u) => okPage(body, u));
    const c = clock();
    const cache: ExtractCache = new Map();
    const d = deps({ reader, cache, now: c.now });
    for (let i = 0; i < 500; i += 1) await extractFromUrl(`https://example.com/old${i}`, d);
    c.advance(EXTRACT_CACHE_TTL_MS + 1000);
    await extractFromUrl("https://example.com/new", d);
    expect(cache.size).toBe(1);
  });

  it("caches the YouTube result too", async () => {
    const api = new FakeApi(() => ({ kind: "ok", status: 200, json: oembedJson() }));
    const d = deps({ api });
    await extractFromUrl(VIDEO, d);
    const again = await extractFromUrl(VIDEO, d);
    expect(again.cached).toBe(true);
    expect(api.calls).toHaveLength(1);
  });
});

describe("extractFromUrl: YouTube", () => {
  it("never uses the page reader for a YouTube video", async () => {
    const api = new FakeApi(() => ({ kind: "ok", status: 200, json: oembedJson() }));
    await extractFromUrl(VIDEO, deps({ api, reader: neverReader }));
    expect(neverReader.calls).toHaveLength(0);
  });

  it("with no key, uses the key-free oEmbed lookup, so the length is missing", async () => {
    const api = new FakeApi(() => ({ kind: "ok", status: 200, json: oembedJson() }));
    const r = await extractFromUrl(VIDEO, deps({ api }));
    expect(api.calls).toHaveLength(1);
    const call = api.calls[0];
    expect(call?.url.startsWith("https://www.youtube.com/oembed?")).toBe(true);
    expect(decodeURIComponent(call?.url ?? "")).toContain("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(call?.headers).toBeUndefined();
    expect(r.status).toBe("ok");
    expect(r.result?.title).toMatchObject({ value: "Introduction to temporary traffic management", confidence: "high" });
    expect(r.result?.provider).toMatchObject({ value: "Example Civils Channel", confidence: "high" });
    expect(r.result?.durationMinutes.confidence).toBe("missing");
    expect(r.result?.durationMinutes.evidence).toBe("YouTube's key-free lookup doesn't give the length. Please enter it.");
    expect(r.result?.sourceType.value).toBe("video");
  });

  it.each(["", "   "])("treats a blank key %j as no key", async (youtubeApiKey) => {
    const api = new FakeApi(() => ({ kind: "ok", status: 200, json: oembedJson() }));
    await extractFromUrl(VIDEO, deps({ api, youtubeApiKey }));
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]?.url).toContain("/oembed");
  });

  it("with a key, calls the Data API and sends the key only in the x-goog-api-key header", async () => {
    const api = new FakeApi(() => ({ kind: "ok", status: 200, json: apiJson() }));
    const r = await extractFromUrl(VIDEO, deps({ api, youtubeApiKey: KEY }));
    expect(api.calls).toHaveLength(1);
    const call = api.calls[0];
    expect(call?.url.startsWith("https://www.googleapis.com/youtube/v3/videos?")).toBe(true);
    expect(call?.url).toContain("id=dQw4w9WgXcQ");
    expect(call?.url).toMatch(/part=snippet/);
    expect(call?.url).not.toContain(KEY);
    expect(call?.url).not.toMatch(/[?&]key=/i);
    expect(call?.headers).toEqual({ "x-goog-api-key": KEY });
    expect(r.status).toBe("ok");
    expect(r.result?.durationMinutes).toMatchObject({ value: 63, confidence: "high" });
    expect(r.result?.publishedAt).toMatchObject({ value: "2024-05-14", confidence: "high" });
  });

  it("never leaks the key into the response, the cache or any URL, on any path", async () => {
    const cache: ExtractCache = new Map();
    const scenarios: ApiOutcome[] = [
      { kind: "ok", status: 200, json: apiJson() },
      { kind: "http_error", status: 403 },
      { kind: "failed", message: `quota exceeded for key ${KEY}` },
      { kind: "unsafe_url", message: `blocked ${KEY}` },
      { kind: "ok", status: 200, json: { items: [] } },
    ];
    for (const out of scenarios) {
      const api = new FakeApi((url) => (url.includes("/oembed") ? { kind: "failed", message: `nope ${KEY}` } : out));
      const r = await extractFromUrl(VIDEO, deps({ api, youtubeApiKey: KEY, cache }));
      expect(JSON.stringify(r)).not.toContain(KEY);
      for (const c of api.calls) expect(c.url).not.toContain(KEY);
      cache.clear();
    }
    const throwing = new FakeApi(() => {
      throw new Error(`network down, key was ${KEY}`);
    });
    const r = await extractFromUrl(VIDEO, deps({ api: throwing, youtubeApiKey: KEY, cache }));
    expect(r.status).toBe("failed");
    expect(JSON.stringify(r)).not.toMatch(new RegExp(KEY));
    expect(JSON.stringify(r)).not.toContain("network down");
    expect(JSON.stringify([...cache.entries()])).not.toContain(KEY);
  });

  it("sends the key to nobody but the Data API call (the oEmbed call has no headers)", async () => {
    const api = new FakeApi((url) => (url.includes("/oembed") ? { kind: "ok", status: 200, json: oembedJson() } : { kind: "http_error", status: 403 }));
    await extractFromUrl(VIDEO, deps({ api, youtubeApiKey: KEY }));
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]?.headers).toEqual({ "x-goog-api-key": KEY });
    expect(api.calls[1]?.headers).toBeUndefined();
  });

  it.each<[string, ApiOutcome]>([
    ["an HTTP error", { kind: "http_error", status: 403 }],
    ["a fetch failure", { kind: "failed", message: "timeout" }],
    ["an unsafe-URL refusal", { kind: "unsafe_url", message: "refused" }],
    ["no items", { kind: "ok", status: 200, json: { items: [] } }],
    ["junk JSON", { kind: "ok", status: 200, json: "not what we expected" }],
  ])("falls back to oEmbed after %s from the Data API, and says the length is missing", async (_label, apiOutcome) => {
    const api = new FakeApi((url) => (url.includes("/oembed") ? { kind: "ok", status: 200, json: oembedJson() } : apiOutcome));
    const r = await extractFromUrl(VIDEO, deps({ api, youtubeApiKey: KEY }));
    expect(api.calls).toHaveLength(2);
    expect(r.status).toBe("ok");
    expect(r.result?.title.value).toBe("Introduction to temporary traffic management");
    expect(r.result?.durationMinutes.confidence).toBe("missing");
    expect(r.result?.notes.join(" ")).toMatch(/full lookup did not work/);
  });

  it("falls back to oEmbed when the Data API call throws", async () => {
    const api = new FakeApi((url) => {
      if (url.includes("/oembed")) return { kind: "ok", status: 200, json: oembedJson() };
      throw new Error("boom");
    });
    const r = await extractFromUrl(VIDEO, deps({ api, youtubeApiKey: KEY }));
    expect(r.status).toBe("ok");
    expect(api.calls).toHaveLength(2);
  });

  it.each<[string, (url: string) => ApiOutcome]>([
    ["both calls fail with HTTP errors", () => ({ kind: "http_error", status: 404 })],
    ["both calls fail to fetch", () => ({ kind: "failed", message: "down" })],
    ["oEmbed returns junk", (url) => (url.includes("/oembed") ? { kind: "ok", status: 200, json: { nothing: true } } : { kind: "http_error", status: 403 })],
    ["oEmbed returns an empty body", (url) => (url.includes("/oembed") ? { kind: "ok", status: 200, json: null } : { kind: "http_error", status: 403 })],
  ])("returns status failed with a plain message when %s", async (_label, handler) => {
    const api = new FakeApi(handler);
    const r = await extractFromUrl(VIDEO, deps({ api, youtubeApiKey: KEY }));
    expect(r.status).toBe("failed");
    expect(r.result).toBeNull();
    expect(r.message).toMatch(/YouTube/);
    expect(r.message).toMatch(/Check the link|fill in/);
    expect(r.url).toBe(VIDEO);
    expect(r.message).not.toContain(KEY);
  });

  it("fails plainly with no key when the oEmbed call fails", async () => {
    const api = new FakeApi(() => ({ kind: "http_error", status: 401 }));
    const r = await extractFromUrl(VIDEO, deps({ api }));
    expect(r.status).toBe("failed");
    expect(api.calls).toHaveLength(1);
  });

  it("does not cache a failed YouTube lookup", async () => {
    const cache: ExtractCache = new Map();
    const api = new FakeApi(() => ({ kind: "http_error", status: 404 }));
    await extractFromUrl(VIDEO, deps({ api, cache }));
    expect(cache.size).toBe(0);
  });

  it.each([
    "https://youtu.be/dQw4w9WgXcQ?t=30",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube.com/embed/dQw4w9WgXcQ",
    "https://www.youtube.com/live/dQw4w9WgXcQ?feature=share",
    "https://m.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabc&t=5s",
    "youtu.be/dQw4w9WgXcQ",
  ])("recognises %s and looks up only the canonical watch URL", async (input) => {
    const api = new FakeApi(() => ({ kind: "ok", status: 200, json: oembedJson() }));
    const r = await extractFromUrl(input, deps({ api }));
    expect(r.status).toBe("ok");
    const asked = decodeURIComponent(api.calls[0]?.url ?? "");
    expect(asked).toContain("url=https://www.youtube.com/watch?v=dQw4w9WgXcQ&format=json");
    expect(asked).not.toMatch(/list=|t=\d|feature=/);
  });

  it("sends a YouTube channel link to the page reader, not the video lookup", async () => {
    const reader = new FakeReader((u) => okPage("<title>A channel</title>", u));
    const r = await extractFromUrl("https://www.youtube.com/@examplechannel", deps({ reader }));
    expect(reader.calls).toHaveLength(1);
    expect(r.status).toBe("ok");
  });

  it("reads an upcoming premiere as upcoming through the Data API", async () => {
    const api = new FakeApi(() => ({ kind: "ok", status: 200, json: JSON.parse(fixture("json", "youtube-api-upcoming.json")) as unknown }));
    const r = await extractFromUrl("https://www.youtube.com/watch?v=UPCOMING_01", deps({ api, youtubeApiKey: KEY }));
    expect(r.result?.flags.upcoming).toBe(true);
    expect(r.result?.durationMinutes.confidence).toBe("missing");
  });

  it("follows a redirect that lands on YouTube with the YouTube lookups", async () => {
    const reader = new FakeReader(() => okPage("<html>youtube page we should not use</html>", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"));
    const api = new FakeApi(() => ({ kind: "ok", status: 200, json: oembedJson() }));
    const r = await extractFromUrl("https://short.example.com/go/abc", deps({ reader, api }));
    expect(r.status).toBe("ok");
    expect(r.result?.adapter).toBe("youtube");
    expect(r.result?.title.value).toBe("Introduction to temporary traffic management");
    expect(r.url).toBe("https://short.example.com/go/abc");
  });
});

describe("extractFromUrl: redirects pick adapters by the final URL as well as the requested one", () => {
  it("uses the ICE Knowledge Hub adapter when a short link redirects to it", async () => {
    const reader = new FakeReader(() => okPage(fixture("html", "ice-hub-explainer.html"), ICE_HUB_URL));
    const r = await extractFromUrl("https://short.example.com/abc", deps({ reader }));
    expect(r.status).toBe("ok");
    expect(r.result?.adapter).toBe("ice-hub+generic");
    expect(r.result?.theme).toMatchObject({ value: "Safety and risk management", confidence: "high" });
    expect(r.url).toBe("https://short.example.com/abc");
  });

  it("still uses the adapter for the requested URL if the final URL is elsewhere", async () => {
    const reader = new FakeReader(() => okPage(fixture("html", "ice-hub-explainer.html"), "https://www.example.com/landed-here"));
    const r = await extractFromUrl(ICE_HUB_URL, deps({ reader }));
    expect(r.result?.adapter).toBe("ice-hub+generic");
    // The theme comes from the requested address, which is where the user's link pointed.
    expect(r.result?.theme.value).toBe("Safety and risk management");
  });

  it("runs the adapters of both URLs once each", async () => {
    const reader = new FakeReader(() => okPage(fixture("html", "ice-event-upcoming.html"), "https://www.ciht.org.uk/events/x"));
    const r = await extractFromUrl("https://www.ice.org.uk/events/x", deps({ reader }));
    expect(r.result?.adapter).toBe("events+generic");
  });

  it("copes with a final URL it cannot parse", async () => {
    const reader = new FakeReader(() => okPage("<title>Hello world page</title>", "not a url"));
    const r = await extractFromUrl("https://example.com/p", deps({ reader }));
    expect(r.status).toBe("ok");
  });
});

describe("extractFromUrl: mostly missing results get a note", () => {
  it("says it could only find the title", async () => {
    const reader = new FakeReader((u) => okPage(fixture("html", "generic-title-only.html"), u));
    const r = await extractFromUrl("https://www.example.com/t", deps({ reader }));
    expect(r.status).toBe("ok");
    expect(r.result?.title.value).toBe("Drainage notes");
    expect(r.result?.notes).toContain("We could only find the title. Please fill in the rest.");
  });

  it("counts a guessed (Check) source type as not found", async () => {
    const body = `<html><head><title>Guess | Site</title><meta property="og:type" content="website"></head><body></body></html>`;
    const reader = new FakeReader((u) => okPage(body, u));
    const r = await extractFromUrl("https://www.example.com/t", deps({ reader }));
    expect(r.result?.sourceType.confidence).toBe("low");
    expect(r.result?.notes).toContain("We could only find the title. Please fill in the rest.");
  });

  it("says nothing was found for an empty page", async () => {
    const reader = new FakeReader((u) => okPage("", u));
    const r = await extractFromUrl("https://www.example.com/empty", deps({ reader }));
    expect(r.status).toBe("ok");
    expect(r.result?.notes).toContain("We could not find any details on this page. Please fill them in.");
  });

  it("adds no such note when several fields were found", async () => {
    const reader = new FakeReader((u) => okPage(fixture("html", "generic-opengraph-only.html"), u));
    const r = await extractFromUrl("https://www.example.com/notes", deps({ reader }));
    expect(r.result?.notes.join(" ")).not.toMatch(/could only find|could not find any/);
  });

  it("names the one field that was found when it is not the title", () => {
    const only = emptyResult("x");
    only.provider = field("Someone", "low", "a guess");
    expect(mostlyMissingNote(only)).toBe("We could only find the provider. Please fill in the rest.");
    const two = emptyResult("x");
    two.title = field("T", "high", "ev");
    two.provider = field("P", "low", "ev");
    expect(mostlyMissingNote(two)).toBeNull();
  });
});

describe("extractFromUrl: one adapter failing does not lose the others", () => {
  it("keeps the specific result if the generic adapter throws", async () => {
    vi.spyOn(genericAdapter, "extract").mockImplementation(() => {
      throw new Error("generic broke on <script>secret page content</script>");
    });
    const reader = new FakeReader(() => okPage(fixture("html", "ice-hub-explainer.html"), ICE_HUB_URL));
    const r = await extractFromUrl(ICE_HUB_URL, deps({ reader }));
    expect(r.status).toBe("ok");
    expect(r.result?.adapter).toBe("ice-hub");
    expect(r.result?.title.value).toBe("The principal designer role");
    expect(JSON.stringify(r)).not.toContain("secret page content");
  });

  it("returns failed, with a plain message, if every adapter throws", async () => {
    vi.spyOn(genericAdapter, "extract").mockImplementation(() => {
      throw new Error("generic broke with page content here");
    });
    const reader = new FakeReader((u) => okPage("<title>Hello world page</title>", u));
    const r = await extractFromUrl("https://example.com/p", deps({ reader }));
    expect(r.status).toBe("failed");
    expect(r.result).toBeNull();
    expect(JSON.stringify(r)).not.toContain("page content here");
  });
});

describe("extractFromUrl: large and hostile pages", () => {
  it("reads only the first part of an enormous page and says so", async () => {
    const huge = `<html><head><title>Huge | Site</title></head><body>${"<p>filler words in a paragraph</p>".repeat(120000)}</body></html>`;
    expect(huge.length).toBeGreaterThan(3_000_000);
    const reader = new FakeReader((u) => okPage(huge, u));
    const started = Date.now();
    const r = await extractFromUrl("https://example.com/huge", deps({ reader }));
    expect(Date.now() - started).toBeLessThan(15000);
    expect(r.status).toBe("ok");
    expect(r.result?.notes.join(" ")).toMatch(/only read the first part/);
    expect(JSON.stringify(r).length).toBeLessThan(6000);
  });

  it("does not echo scripts or markup from the page", async () => {
    const body = `<html><head><title>Alert &lt;script&gt;alert(1)&lt;/script&gt; | Site</title></head><body><main><h1>Real heading</h1><script>window.steal(document.cookie)</script></main></body></html>`;
    const reader = new FakeReader((u) => okPage(body, u));
    const r = await extractFromUrl("https://example.com/xss", deps({ reader }));
    expect(JSON.stringify(r)).not.toContain("steal");
  });

  it("copes with a body that is not a string", async () => {
    const reader = new FakeReader((u) => okPage(undefined as unknown as string, u));
    const r = await extractFromUrl("https://example.com/odd", deps({ reader }));
    expect(["ok", "failed"]).toContain(r.status);
  });
});

describe("extractFromUrl: response shape", () => {
  it("matches the ExtractResponse type for every outcome", async () => {
    const outcomes: ExtractResponse[] = [
      await extractFromUrl("", deps()),
      await extractFromUrl("https://example.com/a", deps({ reader: new FakeReader(() => ({ kind: "blocked", message: "Plain." })) })),
      await extractFromUrl("https://example.com/b", deps({ reader: new FakeReader((u) => okPage("<title>Hello world page</title>", u)) })),
    ];
    for (const r of outcomes) {
      expect(typeof r.status).toBe("string");
      expect(typeof r.url).toBe("string");
      expect(typeof r.message).toBe("string");
      expect(r.result === null || typeof r.result === "object").toBe(true);
      expect(r.status === "ok").toBe(r.result !== null);
    }
  });
});

describe("extractFromUrl: pages nested absurdly deep", () => {
  const nested = (depth: number, open = "<div>", close = "</div>") =>
    `<html><head><title>Deep page | Site</title></head><body><main><h1>Deep page</h1>${open.repeat(depth)}text${close.repeat(depth)}</main></body></html>`;

  it("refuses a page nested 5,000 deep at once, with a plain message and no result", async () => {
    const reader = new FakeReader((u) => okPage(nested(5000), u));
    const started = Date.now();
    const r = await extractFromUrl("https://example.com/deep", deps({ reader }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.status).toBe("failed");
    expect(r.result).toBeNull();
    expect(r.message).toMatch(/too complicated/);
    expect(r.message).toMatch(/Fill in the details yourself/);
    expect(JSON.stringify(r)).not.toContain("<div>");
  });

  it("refuses 100,000 nested tags, which is only about 500 KB, without freezing", async () => {
    const reader = new FakeReader((u) => okPage(nested(100_000), u));
    const started = Date.now();
    const r = await extractFromUrl("https://example.com/deeper", deps({ reader }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.status).toBe("failed");
  });

  it.each([
    ["nested list items", "<ul><li>", "</li></ul>"],
    ["self-closed divs", "<div/>", ""],
    ["unmatched end tags between", "<span><div></span>", ""],
    ["table cells", "<table><tr><td>", "</td></tr></table>"],
    ["bold tags", "<b>", "</b>"],
  ])("refuses a page of %s", async (_name, open, close) => {
    const reader = new FakeReader((u) => okPage(nested(4000, open, close), u));
    const started = Date.now();
    const r = await extractFromUrl("https://example.com/deep", deps({ reader }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(r.status).toBe("failed");
  });

  it("refuses it for a site with its own adapter too, and does not cache the refusal", async () => {
    const cache: ExtractCache = new Map();
    const reader = new FakeReader((u) => okPage(nested(5000), u));
    const r = await extractFromUrl("https://www.ciht.org.uk/events/deep", deps({ reader, cache }));
    expect(r.status).toBe("failed");
    expect(cache.size).toBe(0);
  });

  it("still reads an ordinary page that is nested a hundred levels deep", async () => {
    const reader = new FakeReader((u) => okPage(nested(100), u));
    const r = await extractFromUrl("https://example.com/ok", deps({ reader }));
    expect(r.status).toBe("ok");
    expect(r.result?.title.value).toBe("Deep page");
  });
});

describe("extractFromUrl: the page is parsed once for all the adapters", () => {
  it("gives the specific adapter and the generic adapter the same parsed document", async () => {
    const seen: unknown[] = [];
    vi.spyOn(genericAdapter, "extract").mockImplementation((input) => {
      seen.push(loadDoc(input.html));
      return emptyResult("generic");
    });
    vi.spyOn(iceHubAdapter, "extract").mockImplementation((input) => {
      seen.push(loadDoc(input.html));
      return emptyResult("ice-hub");
    });
    const reader = new FakeReader(() => okPage(fixture("html", "ice-hub-explainer.html"), ICE_HUB_URL));
    const r = await extractFromUrl(ICE_HUB_URL, deps({ reader }));
    expect(r.status).toBe("ok");
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
    // Outside the run, a page is parsed fresh again.
    expect(loadDoc(fixture("html", "ice-hub-explainer.html"))).not.toBe(seen[0]);
  });

  it("gives the same answers as reading the page with each adapter on its own", async () => {
    const body = fixture("html", "ice-hub-explainer.html");
    const reader = new FakeReader(() => okPage(body, ICE_HUB_URL));
    const r = await extractFromUrl(ICE_HUB_URL, deps({ reader }));
    expect(r.result?.title.value).toBe("The principal designer role");
    expect(r.result?.durationMinutes).toMatchObject({ value: 15, confidence: "high" });
  });

  it("reads only the first 1,000,000 characters of a long page", async () => {
    const body = `<html><head><title>Long | Site</title></head><body><main><h1>Long</h1>${"<p>filler words in a paragraph</p>".repeat(40_000)}</main></body></html>`;
    expect(body.length).toBeGreaterThan(1_000_000);
    const reader = new FakeReader((u) => okPage(body, u));
    const r = await extractFromUrl("https://example.com/long", deps({ reader }));
    expect(r.status).toBe("ok");
    expect(r.result?.notes.join(" ")).toMatch(/only read the first part/);
  });
});
