import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_YOUTUBE_MINUTES, parseYoutubeId, youtubeAdapter, youtubeApiVideo, youtubeDurationMinutes, youtubeFromApi, youtubeFromOembed,
  youtubeJsonKind,
} from "@/lib/adapters/youtube";
import type { AdapterResult } from "@/lib/types";

const NOW = new Date("2026-10-07T09:00:00Z");
const hasControlChars = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const fixture = (name: string): string => readFileSync(path.resolve(import.meta.dirname, "../fixtures/json", name), "utf8");
const json = (name: string): unknown => JSON.parse(fixture(name)) as unknown;

function expectWellFormed(r: AdapterResult): void {
  for (const key of ["title", "provider", "sourceType", "theme", "durationMinutes", "publishedAt", "eventDate", "providerCpdHours"] as const) {
    const f = r[key];
    expect(typeof f.evidence).toBe("string");
    expect(f.evidence.length).toBeGreaterThan(5);
    expect(f.value === null).toBe(f.confidence === "missing");
  }
}

describe("parseYoutubeId", () => {
  const ID = "dQw4w9WgXcQ";
  const good: [string, string][] = [
    [`https://www.youtube.com/watch?v=${ID}`, "watch"],
    [`https://youtube.com/watch?v=${ID}`, "no www"],
    [`https://m.youtube.com/watch?v=${ID}`, "mobile"],
    [`https://music.youtube.com/watch?v=${ID}`, "music"],
    [`http://www.youtube.com/watch?v=${ID}`, "http"],
    [`https://www.youtube.com/watch?v=${ID}&t=42s`, "t after v"],
    [`https://www.youtube.com/watch?t=1m20s&v=${ID}`, "t before v"],
    [`https://www.youtube.com/watch?v=${ID}&list=PLabc123&index=4`, "playlist params"],
    [`https://www.youtube.com/watch?feature=share&v=${ID}&utm_source=x`, "other params"],
    [`https://youtu.be/${ID}`, "short link"],
    [`https://youtu.be/${ID}?t=30`, "short link with t"],
    [`https://youtu.be/${ID}?si=abcdef&t=30`, "short link with si"],
    [`https://www.youtube.com/shorts/${ID}`, "shorts"],
    [`https://www.youtube.com/shorts/${ID}?feature=share`, "shorts with params"],
    [`https://www.youtube.com/embed/${ID}`, "embed"],
    [`https://www.youtube.com/embed/${ID}?start=10`, "embed with start"],
    [`https://www.youtube-nocookie.com/embed/${ID}`, "nocookie embed"],
    [`https://www.youtube.com/live/${ID}`, "live"],
    [`https://www.youtube.com/live/${ID}?feature=share`, "live with params"],
    [`https://www.youtube.com/v/${ID}`, "old /v/ form"],
    [`https://WWW.YOUTUBE.COM/watch?v=${ID}`, "upper case host"],
    [`https://www.youtube.com/watch?v=${ID}#t=30`, "fragment"],
  ];
  it.each(good)("reads the id from %s (%s)", (url) => {
    expect(parseYoutubeId(url)).toBe(ID);
  });

  it("accepts a URL object", () => {
    expect(parseYoutubeId(new URL(`https://youtu.be/${ID}`))).toBe(ID);
  });

  it("accepts ids with underscores and dashes", () => {
    expect(parseYoutubeId("https://youtu.be/a_b-c_d-e_f")).toBe("a_b-c_d-e_f");
  });

  const bad: [string, string][] = [
    ["https://www.youtube.com/", "home page"],
    ["https://www.youtube.com/watch", "no v"],
    ["https://www.youtube.com/watch?v=", "empty v"],
    ["https://www.youtube.com/watch?v=short", "too short"],
    [`https://www.youtube.com/watch?v=${"a".repeat(12)}`, "too long"],
    ["https://www.youtube.com/watch?v=abc%20defghij", "encoded space"],
    ["https://www.youtube.com/watch?v=abc<script>", "markup in id"],
    [`https://www.youtube.com/watch/${ID}`, "id in the path of /watch"],
    ["https://www.youtube.com/playlist?list=PLabcdefghijk", "playlist"],
    ["https://www.youtube.com/@examplechannel", "channel handle"],
    ["https://www.youtube.com/channel/UCabcdefghijklmnopqrstuv", "channel id"],
    ["https://www.youtube.com/embed/videoseries?list=PLabcdefghijk", "playlist embed (videoseries is 11 characters)"],
    [`https://youtube.com.evil.example/watch?v=${ID}`, "look-alike suffix host"],
    [`https://notyoutube.com/watch?v=${ID}`, "look-alike prefix host"],
    [`https://evil.example/?next=https://youtu.be/${ID}`, "id only in a query value"],
    [`https://evil.example/youtu.be/${ID}`, "host only in the path"],
    [`ftp://youtu.be/${ID}`, "wrong scheme"],
    [`javascript:alert('${ID}')`, "script scheme"],
    ["not a url", "not a URL"],
    ["", "empty string"],
  ];
  it.each(bad)("returns null for %s (%s)", (url) => {
    expect(parseYoutubeId(url)).toBeNull();
  });
});

describe("youtubeDurationMinutes", () => {
  const cases: [string | null, number | null][] = [
    ["PT1H2M45S", 63],
    ["PT1H", 60],
    ["PT15M", 15],
    ["PT15M29S", 15],
    ["PT15M30S", 16],
    ["PT1M29S", 1],
    ["PT1M30S", 2],
    ["PT45S", 1],
    ["PT29S", 1],
    ["PT20S", 1],
    ["PT0S", null],
    ["P0D", null],
    ["PT", null],
    ["P1DT1H", 1500],
    ["pt5m", 5],
    ["1:02:03", null],
    ["12 minutes", null],
    ["PT-5M", null],
    ["", null],
    [null, null],
  ];
  it.each(cases)("%s gives %s", (input, expected) => {
    expect(youtubeDurationMinutes(input)).toBe(expected);
  });
});

describe("youtubeFromApi", () => {
  it("reads title, channel, length and date from the Data API response, all High", () => {
    const r = youtubeFromApi(json("youtube-api-video.json"), NOW);
    expect(r.adapter).toBe("youtube");
    expect(r.title).toMatchObject({ value: "Introduction to temporary traffic management", confidence: "high" });
    expect(r.provider).toMatchObject({ value: "Example Civils Channel", confidence: "high" });
    expect(r.sourceType).toMatchObject({ value: "video", confidence: "high" });
    expect(r.durationMinutes).toMatchObject({ value: 63, confidence: "high" });
    expect(r.publishedAt).toMatchObject({ value: "2024-05-14", confidence: "high" });
    expect(r.theme.confidence).toBe("missing");
    expect(r.eventDate.confidence).toBe("missing");
    expect(r.providerCpdHours.confidence).toBe("missing");
    expect(r.flags).toEqual({ upcoming: false, recording: false });
    expectWellFormed(r);
  });

  it("says in the evidence that video length is not learning time", () => {
    const r = youtubeFromApi(json("youtube-api-video.json"), NOW);
    expect(r.durationMinutes.evidence).toContain("1h 3m");
    expect(r.durationMinutes.evidence).toMatch(/not your learning time/);
    expect(r.provider.evidence).toMatch(/not always the organisation/);
    expect(r.publishedAt.evidence).toContain("14 May 2024");
  });

  it("rounds a short clip up to one minute and keeps the published date part", () => {
    const r = youtubeFromApi(json("youtube-api-short.json"), NOW);
    expect(r.durationMinutes.value).toBe(1);
    expect(r.durationMinutes.confidence).toBe("high");
    expect(r.publishedAt.value).toBe("2026-01-02");
    expect(r.provider.value).toBe("Example Civils Channel");
  });

  it("returns an empty result with a note when YouTube returned no video", () => {
    const r = youtubeFromApi(json("youtube-api-empty.json"), NOW);
    expect(r.title.confidence).toBe("missing");
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.notes.join(" ")).toMatch(/private or removed/);
    expectWellFormed(r);
  });

  it("marks an upcoming live stream or premiere, with no length and a note", () => {
    const r = youtubeFromApi(json("youtube-api-upcoming.json"), NOW);
    expect(r.flags.upcoming).toBe(true);
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.durationMinutes.evidence).toMatch(/live stream or a premiere/);
    expect(r.notes.join(" ")).toMatch(/has not started/);
    expect(r.title.value).toBe("Live Q and A on site safety");
  });

  it("uses now to spot a scheduled start in the future even when the broadcast flag says none", () => {
    const body = { items: [{ snippet: { title: "t", channelTitle: "c", liveBroadcastContent: "none" }, contentDetails: { duration: "PT10M" }, liveStreamingDetails: { scheduledStartTime: "2026-10-08T09:00:00Z" } }] };
    expect(youtubeFromApi(body, NOW).flags.upcoming).toBe(true);
    expect(youtubeFromApi(body, new Date("2026-10-09T00:00:00Z")).flags.upcoming).toBe(false);
    const started = { items: [{ snippet: { title: "t", channelTitle: "c" }, contentDetails: { duration: "PT10M" }, liveStreamingDetails: { scheduledStartTime: "2026-10-08T09:00:00Z", actualStartTime: "2026-10-08T09:01:00Z" } }] };
    expect(youtubeFromApi(started, NOW).flags.upcoming).toBe(false);
  });

  it("notes a live stream that is on now", () => {
    const body = { items: [{ snippet: { title: "t", channelTitle: "c", liveBroadcastContent: "live" }, contentDetails: { duration: "P0D" } }] };
    const r = youtubeFromApi(body, NOW);
    expect(r.flags.upcoming).toBe(false);
    expect(r.notes.join(" ")).toMatch(/on now/);
  });

  it("does not trust odd shapes", () => {
    for (const bad of [null, undefined, 42, "text", [], {}, { items: "no" }, { items: [null, 5, "x"] }, { items: [{}] }, { items: [{ snippet: "x" }] }]) {
      const r = youtubeFromApi(bad, NOW);
      expect(r.title.confidence).toBe("missing");
      expect(r.durationMinutes.confidence).toBe("missing");
      expectWellFormed(r);
    }
  });

  it("ignores values of the wrong type", () => {
    const body = { items: [{ snippet: { title: 123, channelTitle: { name: "x" }, publishedAt: 5 }, contentDetails: { duration: 90 } }] };
    const r = youtubeFromApi(body, NOW);
    expect(r.title.confidence).toBe("missing");
    expect(r.provider.confidence).toBe("missing");
    expect(r.publishedAt.confidence).toBe("missing");
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.sourceType.value).toBe("video");
  });

  it("cleans and caps text from the response", () => {
    const body = { items: [{ snippet: { title: `  A\u0000B\u0007C  ${"x".repeat(1000)}`, channelTitle: "Chan\nnel", publishedAt: "not a date" } }] };
    const r = youtubeFromApi(body, NOW);
    expect(hasControlChars(r.title.value ?? "")).toBe(false);
    expect((r.title.value ?? "").length).toBeLessThanOrEqual(300);
    expect(r.provider.value).toBe("Chan nel");
    expect(r.publishedAt.confidence).toBe("missing");
  });

  it("never puts an API key in the result (it never sees one)", () => {
    const text = JSON.stringify(youtubeFromApi(json("youtube-api-video.json"), NOW));
    expect(text).not.toMatch(/AIza|api[-_ ]?key/i);
  });
});

describe("youtubeFromOembed", () => {
  it("gives title and channel High but leaves the length missing, with the agreed wording", () => {
    const r = youtubeFromOembed(json("youtube-oembed.json"));
    expect(r.title).toMatchObject({ value: "Introduction to temporary traffic management", confidence: "high" });
    expect(r.provider).toMatchObject({ value: "Example Civils Channel", confidence: "high" });
    expect(r.sourceType).toMatchObject({ value: "video", confidence: "high" });
    expect(r.durationMinutes).toEqual({
      value: null,
      confidence: "missing",
      evidence: "YouTube's key-free lookup doesn't give the length. Please enter it.",
    });
    expect(r.publishedAt.value).toBeNull();
    expect(r.publishedAt.confidence).toBe("missing");
    expectWellFormed(r);
  });

  it("copes with missing or wrong-type fields", () => {
    for (const bad of [null, undefined, "x", 1, [], {}, { title: 5, author_name: ["a"] }]) {
      const r = youtubeFromOembed(bad);
      expect(r.title.confidence).toBe("missing");
      expect(r.provider.confidence).toBe("missing");
      expectWellFormed(r);
    }
  });

  it("keeps the title when the channel is missing", () => {
    const r = youtubeFromOembed({ title: "Only a title" });
    expect(r.title.value).toBe("Only a title");
    expect(r.provider.confidence).toBe("missing");
  });
});

describe("youtubeJsonKind and youtubeApiVideo", () => {
  it("tells the two responses apart", () => {
    expect(youtubeJsonKind(json("youtube-api-video.json"))).toBe("api");
    expect(youtubeJsonKind(json("youtube-api-empty.json"))).toBe("api");
    expect(youtubeJsonKind(json("youtube-oembed.json"))).toBe("oembed");
    expect(youtubeJsonKind({ foo: 1 })).toBeNull();
    expect(youtubeJsonKind(null)).toBeNull();
    expect(youtubeJsonKind("x")).toBeNull();
  });
  it("finds the first video with a snippet", () => {
    expect(youtubeApiVideo(json("youtube-api-video.json"))).not.toBeNull();
    expect(youtubeApiVideo(json("youtube-api-empty.json"))).toBeNull();
    expect(youtubeApiVideo({ items: [{ id: "x" }] })).toBeNull();
  });
});

describe("youtubeAdapter wrapper (takes the JSON text the orchestrator fetched)", () => {
  const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10";

  it("has the expected identity", () => {
    expect(youtubeAdapter.id).toBe("youtube");
    expect(youtubeAdapter.specificity).toBeGreaterThan(50);
  });

  it("matches only YouTube video links", () => {
    expect(youtubeAdapter.matches(new URL(url))).toBe(true);
    expect(youtubeAdapter.matches(new URL("https://youtu.be/dQw4w9WgXcQ"))).toBe(true);
    expect(youtubeAdapter.matches(new URL("https://www.youtube.com/@channel"))).toBe(false);
    expect(youtubeAdapter.matches(new URL("https://example.com/watch?v=dQw4w9WgXcQ"))).toBe(false);
  });

  it("reads a Data API response given as text", () => {
    const r = youtubeAdapter.extract({ url, html: fixture("youtube-api-video.json"), now: NOW });
    expect(r.durationMinutes.value).toBe(63);
    expect(r.title.confidence).toBe("high");
  });

  it("reads an oEmbed response given as text", () => {
    const r = youtubeAdapter.extract({ url, html: fixture("youtube-oembed.json"), now: NOW });
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.title.value).toBe("Introduction to temporary traffic management");
  });

  it("gives an empty result with a note for HTML or garbage", () => {
    for (const html of ["<html><title>YouTube</title></html>", "", "not json", "null", "[]", '{"foo":1}']) {
      const r = youtubeAdapter.extract({ url, html, now: NOW });
      expect(r.title.confidence).toBe("missing");
      expect(r.notes.length).toBeGreaterThan(0);
      expectWellFormed(r);
    }
  });

  it("is pure: the same input gives the same output", () => {
    const input = { url, html: fixture("youtube-api-video.json"), now: NOW };
    expect(youtubeAdapter.extract(input)).toEqual(youtubeAdapter.extract(input));
  });
});

describe("YouTube published dates are UK dates", () => {
  it("gives the UK date for an upload at 23:30 UTC on 30 June, which is 00:30 on 1 July in British Summer Time (fixture)", () => {
    const r = youtubeFromApi(json("youtube-api-summer-evening.json"), NOW);
    expect(r.publishedAt).toMatchObject({ value: "2026-07-01", confidence: "high" });
    expect(r.publishedAt.evidence).toContain("1 July 2026");
  });
  it("does not move a winter upload, which is on UTC, and takes the date as written when it has no time", () => {
    expect(youtubeFromApi(json("youtube-api-short.json"), NOW).publishedAt.value).toBe("2026-01-02");
    const plain = { items: [{ snippet: { title: "t", channelTitle: "c", publishedAt: "2026-06-30" } }] };
    expect(youtubeFromApi(plain, NOW).publishedAt.value).toBe("2026-06-30");
  });
  it("converts around the changes of the clock", () => {
    const at = (publishedAt: string) => youtubeFromApi({ items: [{ snippet: { title: "t", channelTitle: "c", publishedAt } }] }, NOW).publishedAt.value;
    expect(at("2026-03-28T23:30:00Z")).toBe("2026-03-28"); // before the clocks go forward on 29 March
    expect(at("2026-03-29T23:30:00Z")).toBe("2026-03-30"); // after
    expect(at("2026-10-24T23:30:00Z")).toBe("2026-10-25"); // still summer time on 24 October
    expect(at("2026-10-25T23:30:00Z")).toBe("2026-10-25"); // back on UTC
  });
  it("is the same through the adapter's own JSON route", () => {
    const r = youtubeAdapter.extract({ url: "https://www.youtube.com/watch?v=abcdefghijk", html: fixture("youtube-api-summer-evening.json"), now: NOW });
    expect(r.publishedAt.value).toBe("2026-07-01");
  });
});

describe("youtubeDurationMinutes: a sanity ceiling and an optional lower one", () => {
  it("refuses a length that overflows or is absurd", () => {
    expect(youtubeDurationMinutes("PT99999999999999999H")).toBeNull();
    expect(youtubeDurationMinutes("P99999999999999999D")).toBeNull();
    expect(youtubeDurationMinutes(`PT${"9".repeat(400)}H`)).toBeNull();
  });
  it("accepts up to seven days from YouTube's own data, and not a minute more", () => {
    expect(MAX_YOUTUBE_MINUTES).toBe(7 * 24 * 60);
    expect(youtubeDurationMinutes("P7D")).toBe(10080);
    expect(youtubeDurationMinutes("P7DT1M")).toBeNull();
  });
  it("takes a lower ceiling from the caller", () => {
    expect(youtubeDurationMinutes("PT24H", 1440)).toBe(1440);
    expect(youtubeDurationMinutes("PT24H1M", 1440)).toBeNull();
    expect(youtubeDurationMinutes("PT20S", 1440)).toBe(1);
  });
  it("shows no length for an absurd value in an API response", () => {
    const body = { items: [{ snippet: { title: "t", channelTitle: "c" }, contentDetails: { duration: "PT99999999999999999H" } }] };
    expect(youtubeFromApi(body, NOW).durationMinutes.confidence).toBe("missing");
  });
});
