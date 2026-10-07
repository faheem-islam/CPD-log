import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVENT_HOSTS, eventHostFor, eventsAdapter, findProviderCpdHours, textOffersRecording,
} from "@/lib/adapters/events";
import { findDates, findTimeRanges, isUpcomingEvent, loadDoc, parseStamp, stampLengthMinutes, textOf } from "@/lib/adapters/common";
import type { AdapterResult } from "@/lib/types";

/** 2026-10-07 09:00 UTC, which is 10:00 in the UK (BST). */
const NOW = new Date("2026-10-07T09:00:00Z");
const html = (name: string): string => readFileSync(path.resolve(import.meta.dirname, "../fixtures/html", name), "utf8");
const run = (url: string, body: string, now: Date = NOW): AdapterResult => eventsAdapter.extract({ url, html: body, now });
const ICE = "https://www.ice.org.uk/events/upcoming-events/some-session";
const CIHT = "https://www.ciht.org.uk/events/some-session/";
const page = (inner: string, head = "") => `<!doctype html><html><head><title>Session</title>${head}</head><body><main><h1>A session</h1>${inner}</main></body></html>`;
const ld = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

function expectWellFormed(r: AdapterResult): void {
  for (const key of ["title", "provider", "sourceType", "theme", "durationMinutes", "publishedAt", "eventDate", "providerCpdHours"] as const) {
    const f = r[key];
    expect(f.evidence.length).toBeGreaterThan(5);
    expect(f.value === null).toBe(f.confidence === "missing");
  }
}

describe("events adapter: which URLs it takes", () => {
  it.each([
    ["https://www.ice.org.uk/events/upcoming-events/recording-cpd", "ICE events"],
    ["https://ice.org.uk/events/x", "ICE events without www"],
    ["https://www.ice.org.uk/events", "the ICE events index"],
    ["https://www.ciht.org.uk/events/x", "CIHT"],
    ["https://ciht.org.uk/anything", "CIHT any path"],
    ["https://www.theihe.org/events/x", "IHE"],
    ["https://www.ilp.org.uk/events/x", "ILP"],
    ["https://www.adeptnet.org.uk/events/x", "ADEPT"],
    ["https://www.roadsafetygb.org.uk/events/x", "Road Safety GB"],
    ["https://events.ciht.org.uk/x", "a CIHT subdomain"],
  ])("matches %s (%s)", (url) => {
    expect(eventsAdapter.matches(new URL(url))).toBe(true);
  });

  it.each([
    ["https://www.ice.org.uk/about-ice/", "ICE pages that are not events"],
    ["https://knowledgehub.ice.org.uk/events/x", "the Knowledge Hub, which has its own adapter"],
    ["https://www.ice.org.uk.evil.example/events/x", "a look-alike suffix"],
    ["https://evil-ice.org.uk/events/x", "a look-alike prefix"],
    ["https://ice.org.uk.example.com/events/x", "a look-alike host"],
    ["https://example.com/ciht.org.uk/events", "a host in the path"],
    ["https://www.ice.org.uk/eventsx/y", "a path that only starts with events"],
    ["https://www.gov.uk/events", "another host"],
  ])("does not match %s (%s)", (url) => {
    expect(eventsAdapter.matches(new URL(url))).toBe(false);
  });

  it("has a config for every host the brief names", () => {
    expect(EVENT_HOSTS.map((h) => h.domains[0]).sort()).toEqual(
      ["adeptnet.org.uk", "ciht.org.uk", "ice.org.uk", "ilp.org.uk", "roadsafetygb.org.uk", "theihe.org"].sort(),
    );
    expect(eventHostFor(new URL("https://www.theihe.org/events/x"))?.short).toBe("IHE");
  });
});

describe("events adapter: ICE recording page under /events/upcoming-events/", () => {
  const r = run("https://www.ice.org.uk/events/upcoming-events/recording-cpd", html("ice-event-recording.html"));

  it("is flagged as a recording and not as upcoming, whatever the path says", () => {
    expect(r.flags.recording).toBe(true);
    expect(r.flags.upcoming).toBe(false);
  });
  it("reads 18:00-19:00 as a Check duration and says it is the scheduled length", () => {
    expect(r.durationMinutes.value).toBe(60);
    expect(r.durationMinutes.confidence).toBe("low");
    expect(r.durationMinutes.evidence).toContain("18:00-19:00");
    expect(r.durationMinutes.evidence).toMatch(/scheduled length/);
    expect(r.durationMinutes.evidence).toMatch(/not your learning time/);
  });
  it("finds the date even though date and time are in sibling blocks", () => {
    expect(r.eventDate.value).toBe("2025-03-12");
    expect(r.eventDate.confidence).toBe("low");
    expect(r.eventDate.evidence).toContain("12 March 2025");
  });
  it("names ICE as provider and reads the title", () => {
    expect(r.provider).toMatchObject({ value: "Institution of Civil Engineers (ICE)", confidence: "high" });
    expect(r.title).toMatchObject({ value: "Recording: planning your CPD year", confidence: "high" });
  });
  it("says in a note to log it after watching", () => {
    expect(r.notes.join(" ")).toMatch(/after you have watched/);
    expectWellFormed(r);
  });
});

describe("events adapter: recording is not decided from the path alone, and neither is upcoming", () => {
  it("a recording page with no date is not upcoming and has no event date", () => {
    const r = run("https://www.ice.org.uk/events/upcoming-events/recording-cpd", page("<p>Watch the recording.</p><p>18:00-19:00</p>"));
    expect(r.flags).toEqual({ upcoming: false, recording: true });
    expect(r.eventDate.confidence).toBe("missing");
    expect(r.durationMinutes.value).toBe(60);
  });

  it("a past event under /upcoming-events/ with no recording wording is neither", () => {
    const r = run(ICE, page("<p>Date: 12 March 2025</p><p>Time: 18:00-19:00</p>"));
    expect(r.flags).toEqual({ upcoming: false, recording: false });
    expect(r.eventDate.value).toBe("2025-03-12");
  });

  it("a future event is upcoming wherever its URL points", () => {
    const body = page("<p>Date: 16 March 2027</p><p>Time: 18:00-19:00</p>");
    expect(run("https://www.ice.org.uk/events/past-events/x", body).flags.upcoming).toBe(true);
    expect(run("https://www.ice.org.uk/events/x", body).flags.upcoming).toBe(true);
    expect(run(CIHT, body).flags.upcoming).toBe(true);
  });

  it("the ICE upcoming fixture is upcoming, not a recording, and says to log it after attending", () => {
    const r = run("https://www.ice.org.uk/events/upcoming-events/safe-working-near-water/", html("ice-event-upcoming.html"));
    expect(r.flags).toEqual({ upcoming: true, recording: false });
    expect(r.notes.join(" ")).toMatch(/Log it only after you have attended/);
    expect(r.eventDate).toMatchObject({ value: "2027-03-16", confidence: "high" });
    expect(r.eventDate.evidence).toContain("16 March 2027");
    expect(r.sourceType).toMatchObject({ value: "webinar", confidence: "high" });
    expectWellFormed(r);
  });

  it("the upcoming fixture is not upcoming once now is after the event", () => {
    const later = new Date("2027-03-17T09:00:00Z");
    expect(run("https://www.ice.org.uk/events/x", html("ice-event-upcoming.html"), later).flags.upcoming).toBe(false);
  });

  it("an event page mentioning a future recording does not count as a recording", () => {
    const r = run("https://www.ice.org.uk/events/upcoming-events/safe-working-near-water/", html("ice-event-upcoming.html"));
    expect(r.flags.recording).toBe(false);
  });

  it("a recording page that also shows a future date gets a note to check", () => {
    const r = run(ICE, page("<p>Date: 16 March 2027</p><p>Watch the recording</p>"));
    expect(r.flags).toEqual({ upcoming: true, recording: true });
    expect(r.notes.join(" ")).toMatch(/recording but also gives a future date/);
  });

  it("a URL with 'recording' in any path part is a recording", () => {
    expect(run("https://www.ice.org.uk/events/recordings/x", page("<p>Hello</p>")).flags.recording).toBe(true);
    expect(run("https://www.ciht.org.uk/events/x/RECORDING", page("<p>Hello</p>")).flags.recording).toBe(true);
    expect(run("https://www.ciht.org.uk/events/x?recording=1", page("<p>Hello</p>")).flags.recording).toBe(false);
  });

  it("a title that starts 'Recording:' marks a recording", () => {
    const body = `<html><head><title>Recording: A session | CIHT</title></head><body><main><h1>Recording: A session</h1></main></body></html>`;
    expect(run(CIHT, body).flags.recording).toBe(true);
  });
});

describe("textOffersRecording", () => {
  it.each([
    "Watch the recording",
    "You can watch the recording at any time.",
    "Watch this recording now",
    "View the replay",
    "Access the session recording",
    "Recording available",
    "The recording is now available",
    "Available on demand",
    "Watch on demand",
    "This webinar is on demand",
    "On-demand webinar",
    "On demand session",
    "Watch the webinar again",
    "Join us live. Watch it on demand",
    "Speakers and agenda. Watch the recording. Contact us",
    "Event is on demand",
  ])("is true for %j", (text) => {
    expect(textOffersRecording(text)).toBe(true);
  });

  it.each([
    "A recording will be available after the event.",
    "The session will be recorded.",
    "We will share the recording afterwards.",
    "Recording coming soon",
    "Recording not yet available",
    "If you miss it, watch the recording once the session ends",
    "Browse our on-demand library",
    "Explore more on demand courses from other providers",
    "Book your place",
    "Record your own CPD",
    "Watch out for the next session",
    "This session will be available on demand after the live event",
  ])("is false for %j", (text) => {
    expect(textOffersRecording(text)).toBe(false);
  });
});

describe("events adapter: text gluing across block elements", () => {
  const glued = `<main><h1>Bridge inspection update</h1>
    <div class="event-date">Wednesday 4 March 2026</div><div class="event-time">18:00-19:00</div></main>`;

  it("cheerio's own .text() would glue the date and the time together", () => {
    const naive = loadDoc(glued)("main").text();
    expect(naive).toContain("202618:00");
  });

  it("textOf keeps a space at every block boundary", () => {
    const text = textOf(loadDoc(glued));
    expect(text).toContain("4 March 2026 18:00-19:00");
    expect(text).not.toContain("202618");
  });

  it("the adapter still finds both the date and the time range", () => {
    const r = run(CIHT, `<html><head><title>Bridge inspection update</title></head><body>${glued}</body></html>`);
    expect(r.eventDate.value).toBe("2026-03-04");
    expect(r.durationMinutes.value).toBe(60);
  });

  it("works with sibling inline elements too", () => {
    const text = textOf(loadDoc("<p><span>4 March 2026</span><span>18:00-19:00</span></p>"));
    expect(text).toBe("4 March 2026 18:00-19:00");
  });

  it("keeps ordinal suffixes together", () => {
    const text = textOf(loadDoc("<p>Wed 4<sup>th</sup> March 2026</p>"));
    expect(text).toContain("4th March 2026");
    expect(findDates(text)[0]?.iso).toBe("2026-03-04");
  });

  it("does not put a space inside a word split by inline markup", () => {
    expect(textOf(loadDoc("<p><b>Web</b>inar and <em>Dur</em>ation</p>"))).toBe("Webinar and Duration");
  });

  it("handles lists, table cells and line breaks", () => {
    expect(textOf(loadDoc("<ul><li>Date</li><li>4 March 2026</li></ul>"))).toBe("Date 4 March 2026");
    expect(textOf(loadDoc("<table><tr><td>Time</td><td>18:00-19:00</td></tr></table>"))).toBe("Time 18:00-19:00");
    expect(textOf(loadDoc("<p>Date<br>4 March 2026</p>"))).toBe("Date 4 March 2026");
  });

  it("leaves out scripts, styles and templates but does not change the page", () => {
    const doc = loadDoc("<body><p>Hello</p><script>var x = 'secret';</script><style>p{}</style><template><p>hidden</p></template></body>");
    expect(textOf(doc)).toBe("Hello");
    expect(doc("script").length).toBe(1);
  });
});

describe("events adapter: ISO dates inside timestamps and UK day-first dates", () => {
  const dateOf = (inner: string, head = ""): string | null => run(CIHT, page(inner, head)).eventDate.value;

  it("reads ISO dates inside timestamps from JSON-LD, with and without a zone", () => {
    for (const startDate of ["2027-03-16", "2027-03-16T18:00", "2027-03-16T18:00:00", "2027-03-16T18:00:00Z", "2027-03-16T18:00:00+00:00", "2027-03-16T18:00:00.000+0000", "2027-03-16 18:00"]) {
      const r = run(CIHT, page("<p>x</p>", ld({ "@type": "Event", name: "E", startDate })));
      expect(r.eventDate.value).toBe("2027-03-16");
      expect(r.eventDate.confidence).toBe("high");
    }
  });

  it("reads an ISO timestamp from a <time> tag as High", () => {
    const r = run(CIHT, page('<p class="event-date"><time datetime="2027-03-16T18:00:00+00:00">tomorrow-ish</time></p>'));
    expect(r.eventDate).toMatchObject({ value: "2027-03-16", confidence: "high" });
    expect(r.eventDate.evidence).toMatch(/date tag/);
  });

  it("gives the UK date for a timestamp in UTC late in a British Summer Time evening", () => {
    // 23:30 UTC on 1 July is 00:30 on 2 July in the UK.
    const r = run(CIHT, page("<p>x</p>", ld({ "@type": "Event", name: "E", startDate: "2026-07-01T23:30:00Z" })));
    expect(r.eventDate.value).toBe("2026-07-02");
    // In winter the UK is on UTC, so the date does not move.
    const w = run(CIHT, page("<p>x</p>", ld({ "@type": "Event", name: "E", startDate: "2027-01-15T23:30:00Z" })));
    expect(w.eventDate.value).toBe("2027-01-15");
  });

  it("reads UK day-first numeric dates, never month-first", () => {
    expect(dateOf("<p>Date: 04/03/2027</p>")).toBe("2027-03-04");
    expect(dateOf("<p>Date: 3/4/2027</p>")).toBe("2027-04-03");
    expect(dateOf("<p>Date: 4.3.27</p>")).toBe("2027-03-04");
    expect(dateOf("<p>Date: 13/01/2027</p>")).toBe("2027-01-13");
  });

  it("reads written dates in the usual UK shapes", () => {
    expect(dateOf("<p>Date: Thursday 4th March 2027</p>")).toBe("2027-03-04");
    expect(dateOf("<p>Date: 4 Mar 2027</p>")).toBe("2027-03-04");
    expect(dateOf("<p>When: 4 September 2027</p>")).toBe("2027-09-04");
    expect(dateOf("<p>Date: March 4, 2027</p>")).toBe("2027-03-04");
  });

  it("uses the first day of a range", () => {
    expect(dateOf("<p>Date: 4-6 March 2027</p>")).toBe("2027-03-04");
    expect(dateOf("<p>Date: 4 - 6 March 2027</p>")).toBe("2027-03-04");
  });

  it("does not accept impossible dates", () => {
    expect(dateOf("<p>Date: 31/02/2027</p>")).toBeNull();
    expect(dateOf("<p>Date: 13/13/2027</p>")).toBeNull();
    expect(dateOf("<p>Date: 32 March 2027</p>")).toBeNull();
  });

  it("does not take a published, posted or booking date as the event date", () => {
    expect(dateOf("<p>Published date: 1 March 2027</p><p>Date: 4 April 2027</p>")).toBe("2027-04-04");
    expect(dateOf("<p>Posted 1 March 2027</p><p>Date: 4 April 2027</p>")).toBe("2027-04-04");
    expect(dateOf("<p>Booking closes: 1 March 2027</p>")).toBeNull();
    expect(dateOf("<p>Registration closes 1 March 2027</p>")).toBeNull();
    expect(dateOf("<p>Published 1 March 2027</p>")).toBeNull();
    expect(dateOf("<p>Last updated 1 March 2027</p>")).toBeNull();
  });

  it("ignores a <time> tag that is a published or posted date", () => {
    const body = page('<p class="post-date"><time datetime="2027-03-01">1 March</time></p><p>Date: 4 April 2027</p>');
    const r = run(CIHT, body);
    expect(r.eventDate.value).toBe("2027-04-04");
    expect(r.eventDate.confidence).toBe("low");
    const body2 = page('<p>Published <time datetime="2027-03-01">1 March</time></p><p>Date: 4 April 2027</p>');
    expect(run(CIHT, body2).eventDate.value).toBe("2027-04-04");
  });

  it("ignores <time> tags in the page footer or navigation", () => {
    const body = `<html><head><title>x</title></head><body><nav><time datetime="2027-01-01">New year</time></nav><main><h1>Session</h1></main><footer><time datetime="2027-02-02">x</time></footer></body></html>`;
    expect(run(CIHT, body).eventDate.confidence).toBe("missing");
  });

  it("is Check, not High, when the date is only in the text", () => {
    const r = run(CIHT, page("<p>Date: 4 April 2027</p>"));
    expect(r.eventDate.confidence).toBe("low");
    expect(r.eventDate.evidence).toMatch(/not machine-readable/);
  });

  it("guesses an unlabelled date as Check and says it is a guess", () => {
    const r = run(CIHT, page("<p>Join us on 4 April 2027 for a session.</p>"));
    expect(r.eventDate).toMatchObject({ value: "2027-04-04", confidence: "low" });
    expect(r.eventDate.evidence).toMatch(/guessed/);
  });

  it("says when the page has more than one date", () => {
    const r = run(CIHT, page("<p>Join us on 4 April 2027 for a session. A follow-up is on 6 June 2027.</p>"));
    expect(r.eventDate.value).toBe("2027-04-04");
    expect(r.eventDate.evidence).toMatch(/more than one date/);
  });

  it("makes machine-readable data beat text", () => {
    const body = page("<p>Date: 5 May 2027</p>", ld({ "@type": "Event", name: "E", startDate: "2027-03-16T18:00:00Z" }));
    expect(run(CIHT, body).eventDate).toMatchObject({ value: "2027-03-16", confidence: "high" });
  });
});

describe("events adapter: upcoming from the date and, today, the time", () => {
  const todayLd = (startDate: string, endDate?: string) => page("<p>x</p>", ld({ "@type": "Event", name: "E", startDate, ...(endDate ? { endDate } : {}) }));

  it("a time later today, with no zone, is upcoming (taken as UK time)", () => {
    expect(run(CIHT, todayLd("2026-10-07T18:00:00", "2026-10-07T19:00:00")).flags.upcoming).toBe(true);
  });
  it("a time that ended earlier today is not upcoming", () => {
    expect(run(CIHT, todayLd("2026-10-07T08:00:00", "2026-10-07T09:30:00")).flags.upcoming).toBe(false);
  });
  it("an event in progress is still upcoming (log it after attending)", () => {
    expect(run(CIHT, todayLd("2026-10-07T09:00:00", "2026-10-07T11:00:00")).flags.upcoming).toBe(true);
  });
  it("uses the exact instant when the timestamp has a zone", () => {
    // Now is 09:00 UTC. 17:00+01:00 is 16:00 UTC, later; 08:00+01:00 is 07:00 UTC, earlier.
    expect(run(CIHT, todayLd("2026-10-07T17:00:00+01:00")).flags.upcoming).toBe(true);
    expect(run(CIHT, todayLd("2026-10-07T08:00:00+01:00")).flags.upcoming).toBe(false);
    expect(run(CIHT, todayLd("2026-10-07T09:00:01Z")).flags.upcoming).toBe(true);
    expect(run(CIHT, todayLd("2026-10-07T09:00:00Z")).flags.upcoming).toBe(false);
  });
  it("a date-only event today counts as upcoming, with a note", () => {
    const r = run(CIHT, page("<p>Date: 7 October 2026</p>"));
    expect(r.flags.upcoming).toBe(true);
    expect(r.notes.join(" ")).toMatch(/event is today/);
  });
  it("yesterday is not upcoming and tomorrow is", () => {
    expect(run(CIHT, page("<p>Date: 6 October 2026</p>")).flags.upcoming).toBe(false);
    expect(run(CIHT, page("<p>Date: 8 October 2026</p>")).flags.upcoming).toBe(true);
  });
  it("a missing date is never upcoming", () => {
    expect(run(CIHT, page("<p>No date here at all</p>")).flags.upcoming).toBe(false);
  });
  it("the injected clock decides, not the real one", () => {
    const body = page("<p>Date: 16 March 2027</p>");
    expect(run(CIHT, body, new Date("2027-03-15T10:00:00Z")).flags.upcoming).toBe(true);
    expect(run(CIHT, body, new Date("2027-03-17T10:00:00Z")).flags.upcoming).toBe(false);
  });
  it("a multi-day event is upcoming until its end", () => {
    const ev = ld({ "@type": "Event", name: "E", startDate: "2026-10-06T09:00:00", endDate: "2026-10-08T17:00:00" });
    expect(run(CIHT, page("<p>x</p>", ev)).flags.upcoming).toBe(true);
  });
  it("marks a cancelled event in a note", () => {
    const ev = ld({ "@type": "Event", name: "E", startDate: "2027-03-16", eventStatus: "https://schema.org/EventCancelled" });
    expect(run(CIHT, page("<p>x</p>", ev)).notes.join(" ")).toMatch(/cancelled/);
  });
});

describe("isUpcomingEvent and parseStamp", () => {
  it("compares dates in UK time", () => {
    // 23:30 UTC on 6 October is 00:30 on 7 October in the UK (BST).
    const lateNow = new Date("2026-10-06T23:30:00Z");
    expect(isUpcomingEvent({ date: "2026-10-07" }, lateNow)).toBe(true); // today in the UK, no time known
    expect(isUpcomingEvent({ date: "2026-10-06" }, lateNow)).toBe(false);
  });
  it("parses stamps", () => {
    expect(parseStamp("2026-03-04")).toMatchObject({ date: "2026-03-04", minuteOfDay: null, instantMs: null });
    expect(parseStamp("2026-03-04T18:30")).toMatchObject({ date: "2026-03-04", minuteOfDay: 18 * 60 + 30, instantMs: null });
    expect(parseStamp("2026-03-04T18:30:00Z")).toMatchObject({ date: "2026-03-04", minuteOfDay: 18 * 60 + 30 });
    expect(parseStamp("2026-07-04T18:30:00Z")).toMatchObject({ date: "2026-07-04", minuteOfDay: 19 * 60 + 30 });
    expect(parseStamp("2026-03-04T25:00")).toMatchObject({ date: "2026-03-04", minuteOfDay: null });
    expect(parseStamp("2026-02-31")).toBeNull();
    expect(parseStamp("4 March 2026")).toMatchObject({ date: "2026-03-04" });
    expect(parseStamp("garbage")).toBeNull();
    expect(parseStamp("")).toBeNull();
    expect(parseStamp(null)).toBeNull();
  });
  it("works out lengths from two stamps", () => {
    expect(stampLengthMinutes(parseStamp("2026-03-04T18:00"), parseStamp("2026-03-04T19:30"))).toBe(90);
    expect(stampLengthMinutes(parseStamp("2026-03-04T18:00:00+00:00"), parseStamp("2026-03-04T19:30:00+00:00"))).toBe(90);
    expect(stampLengthMinutes(parseStamp("2026-03-04T18:00"), parseStamp("2026-03-04T17:00"))).toBeNull();
    expect(stampLengthMinutes(parseStamp("2026-03-04T08:00"), parseStamp("2026-03-04T21:00"))).toBeNull();
    expect(stampLengthMinutes(parseStamp("2026-03-04"), parseStamp("2026-03-05"))).toBeNull();
    expect(stampLengthMinutes(null, parseStamp("2026-03-04T18:00"))).toBeNull();
    // One has a zone and one does not: not comparable, so no length.
    expect(stampLengthMinutes(parseStamp("2026-03-04T18:00"), parseStamp("2026-03-04T19:00Z"))).toBeNull();
  });
});

describe("events adapter: duration from a time range is Check and says it is the scheduled length", () => {
  const dur = (inner: string) => run(CIHT, page(inner)).durationMinutes;

  it.each([
    ["Time: 18:00-19:00", 60, "18:00-19:00"],
    ["Time: 18:00 - 19:30", 90, "18:00 - 19:30"],
    ["Time: 18:00 – 19:00", 60, "18:00 – 19:00"],
    ["Time: 18:00 to 19:15", 75, "18:00 to 19:15"],
    ["Time: 18.00 - 19.00", 60, "18.00 - 19.00"],
    ["Time: 6pm to 7:30pm", 90, "6pm to 7:30pm"],
    ["Time: 10-11am", 60, "10-11am"],
    ["Time: 10am-4pm", 360, "10am-4pm"],
    ["Time: 09:30 - 16:00", 390, "09:30 - 16:00"],
    ["Time: 18:00 GMT - 19:30 GMT", 90, "18:00 GMT - 19:30 GMT"],
    ["Time: 10:00am – 11:30am", 90, "10:00am – 11:30am"],
  ])("reads %j as %i minutes", (inner, minutes, raw) => {
    const f = dur(`<p>${inner}</p>`);
    expect(f.value).toBe(minutes);
    expect(f.confidence).toBe("low");
    expect(f.evidence).toContain(raw);
    expect(f.evidence).toMatch(/scheduled length/);
    expect(f.evidence).toMatch(/not your learning time/);
  });

  it.each([
    ["Date: 4-5 March 2027"],
    ["Rooms 10-11 are open"],
    ["Years 2026-2027"],
    ["Call 0161 496 0000"],
    ["Time: 19:00-18:00"],
    ["Time: 06:00-20:00"],
    ["Time: 25:00-26:00"],
    ["Price £10-11 per head"],
    ["Date 04.03.2027 - 05.03.2027"],
    ["Version 1.2-1.3"],
  ])("does not read a duration from %j", (inner) => {
    const f = dur(`<p>${inner}</p>`);
    expect(f.value).toBeNull();
    expect(f.confidence).toBe("missing");
    expect(f.evidence).toMatch(/Please enter/);
  });

  it("prefers the range next to a Time label over an earlier one, and notes that there is more than one", () => {
    const r = run(CIHT, page("<p>Registration 09:00-09:30</p><p>Time: 18:00-19:00</p>"));
    expect(r.durationMinutes.value).toBe(60);
    expect(r.notes.join(" ")).toMatch(/more than one time range/);
  });

  it("uses the first range when there is no label, and notes the others", () => {
    const r = run(CIHT, page("<p>Doors 17:30-17:45</p><p>Talk 18:00-19:00</p>"));
    expect(r.durationMinutes.value).toBe(15);
    expect(r.notes.join(" ")).toMatch(/more than one time range/);
  });

  it("does not note anything for the same range repeated", () => {
    const r = run(CIHT, page("<p>Time: 18:00-19:00</p><p>Starts 18:00-19:00</p>"));
    expect(r.notes.join(" ")).not.toMatch(/more than one time range/);
  });

  it("works out a length from JSON-LD start and end times and still calls it the scheduled length", () => {
    const r = run(CIHT, page("<p>x</p>", ld({ "@type": "Event", name: "E", startDate: "2027-03-16T18:00:00+00:00", endDate: "2027-03-16T19:45:00+00:00" })));
    expect(r.durationMinutes).toMatchObject({ value: 105, confidence: "low" });
    expect(r.durationMinutes.evidence).toMatch(/scheduled length/);
  });

  it("falls back to the text range when the JSON-LD times span days", () => {
    const r = run(CIHT, page("<p>Time: 10:00-11:00</p>", ld({ "@type": "Event", name: "E", startDate: "2027-03-16", endDate: "2027-03-18" })));
    expect(r.durationMinutes.value).toBe(60);
  });

  it("is missing, not guessed, when there are no times", () => {
    const r = run(CIHT, page("<p>Date: 4 April 2027</p>"));
    expect(r.durationMinutes.confidence).toBe("missing");
  });
});

describe("findTimeRanges and findDates", () => {
  it("lists every range with its minutes", () => {
    expect(findTimeRanges("A 09:00-09:30 B 6pm to 7pm").map((r) => r.minutes)).toEqual([30, 60]);
    expect(findTimeRanges("nothing here")).toEqual([]);
  });
  it("keeps date ranges out of time ranges", () => {
    expect(findTimeRanges("4-5 March 2026, 10-11 June")).toEqual([]);
  });
  it("lists dates in order and skips impossible ones", () => {
    expect(findDates("a 31/02/2026 b 4 March 2026 c 2026-05-06T10:00 d 7th June 2026").map((d) => d.iso)).toEqual(["2026-03-04", "2026-05-06", "2026-06-07"]);
  });
  it("is not fooled by dates glued to other digits", () => {
    expect(findDates("12026-03-041")).toEqual([]);
    expect(findDates("ref 1234-56-78")).toEqual([]);
  });
});

describe("events adapter: provider CPD hours (a hint, never the user's time)", () => {
  it.each([
    ["CPD hours: 2", 2],
    ["CPD hours 2", 2],
    ["CPD hours - 1.5", 1.5],
    ["CPD Hours: 0.5", 0.5],
    ["2 hours CPD", 2],
    ["2 hours of CPD", 2],
    ["1.5 hrs CPD", 1.5],
    ["CPD: 1.5 hours", 1.5],
    ["CPD - 3 hours", 3],
    ["2 CPD hours", 2],
    ["Earn 2.25 CPD hours by attending", 2.25],
    ["cpd hours: 4", 4],
    ["CPD: 90 minutes", 1.5],
    ["CPD 45 mins", 0.75],
  ])("reads %j as %d hours", (text, hours) => {
    const f = findProviderCpdHours(text);
    expect(f.value).toBe(hours);
    expect(f.confidence).toBe("low");
    expect(f.evidence.startsWith("Provider-stated:")).toBe(true);
    expect(f.evidence).toMatch(/not your own learning time/);
  });

  it.each([
    "CPD hours: 0",
    "CPD hours: 2026",
    "CPD hours: 100",
    "No CPD hours are offered",
    "CPD hours available on request",
    "CPD",
    "CPD points: 5",
    "2 hours of training",
    "",
  ])("finds nothing in %j", (text) => {
    const f = findProviderCpdHours(text);
    expect(f.value).toBeNull();
    expect(f.confidence).toBe("missing");
    expect(f.evidence).toMatch(/does not state/);
  });

  it("reads the ILP fixture and keeps it separate from the duration", () => {
    const r = run("https://www.ilp.org.uk/events/street-lighting-masterclass/", html("ilp-event.html"));
    expect(r.providerCpdHours).toMatchObject({ value: 2, confidence: "low" });
    expect(r.providerCpdHours.evidence.startsWith("Provider-stated:")).toBe(true);
    expect(r.durationMinutes).toMatchObject({ value: 120, confidence: "low" });
    expect(r.provider).toMatchObject({ value: "Institution of Lighting Professionals (ILP)", confidence: "high" });
    expectWellFormed(r);
  });

  it("does not turn CPD hours into the length", () => {
    const r = run("https://www.ilp.org.uk/events/x", page("<p>CPD hours: 2</p>"));
    expect(r.providerCpdHours.value).toBe(2);
    expect(r.durationMinutes.confidence).toBe("missing");
  });
});

describe("events adapter: source type", () => {
  const typeOf = (inner: string, head = "", url = CIHT) => run(url, page(inner, head)).sourceType;

  it("says webinar, High, when the title or address says webinar", () => {
    const f = run("https://www.ciht.org.uk/events/my-webinar/", "<html><head><title>x</title></head><body><main><h1>My webinar</h1></main></body></html>").sourceType;
    expect(f).toMatchObject({ value: "webinar", confidence: "high" });
  });
  it("says webinar, High, for an online attendance mode in structured data", () => {
    const f = typeOf("<p>x</p>", ld({ "@type": "Event", name: "E", startDate: "2027-03-16", eventAttendanceMode: "https://schema.org/OnlineEventAttendanceMode" }));
    expect(f).toMatchObject({ value: "webinar", confidence: "high" });
  });
  it("says live event, High, for an offline attendance mode", () => {
    const f = typeOf("<p>x</p>", ld({ "@type": "Event", name: "E", startDate: "2027-03-16", eventAttendanceMode: "https://schema.org/OfflineEventAttendanceMode" }));
    expect(f).toMatchObject({ value: "live_event", confidence: "high" });
  });
  it("says live event, Check, for a mixed attendance mode", () => {
    const f = typeOf("<p>x</p>", ld({ "@type": "Event", name: "E", startDate: "2027-03-16", eventAttendanceMode: "https://schema.org/MixedEventAttendanceMode" }));
    expect(f).toMatchObject({ value: "live_event", confidence: "low" });
  });
  it("says webinar, Check, when only the body text says webinar or online", () => {
    expect(typeOf("<p>Register for this webinar today</p>")).toMatchObject({ value: "webinar", confidence: "low" });
    expect(typeOf("<p>Joining via Zoom</p>")).toMatchObject({ value: "webinar", confidence: "low" });
  });
  it("prefers a venue over the word online, but a named meeting tool over a venue", () => {
    expect(typeOf("<p>Venue: The Hall. Book online.</p>")).toMatchObject({ value: "live_event", confidence: "low" });
    expect(typeOf("<p>Venue: The Hall. Also on Zoom.</p>")).toMatchObject({ value: "webinar", confidence: "low" });
    expect(typeOf("<p>A virtual session.</p>")).toMatchObject({ value: "webinar", confidence: "low" });
  });
  it("says live event, Check, for a venue", () => {
    expect(typeOf("<p>Venue: The Hall</p>")).toMatchObject({ value: "live_event", confidence: "low" });
    expect(typeOf("<p>This is an in-person day</p>")).toMatchObject({ value: "live_event", confidence: "low" });
  });
  it("guesses live event, Check, when the page is clearly an event but does not say how it is held", () => {
    const f = run("https://www.ciht.org.uk/events/some-day/", page("<p>Date: 4 April 2027</p>")).sourceType;
    expect(f).toMatchObject({ value: "live_event", confidence: "low" });
    expect(f.evidence).toMatch(/could not tell/);
  });
  it("is missing for a page on an events host that does not look like an event at all", () => {
    const f = run("https://www.ciht.org.uk/about-us/", "<html><head><title>About us</title></head><body><main><h1>About us</h1><p>We are a charity.</p></main></body></html>").sourceType;
    expect(f.confidence).toBe("missing");
    expect(f.evidence).toMatch(/does not look like an event/);
  });
});

describe("events adapter: the other host fixtures", () => {
  it("CIHT webinar: webinar from the title, date tag High, upcoming, and a nav 'On demand' link is not a recording", () => {
    const r = run("https://www.ciht.org.uk/events/webinar-active-travel-schemes/", html("ciht-event-webinar.html"));
    expect(r.provider).toMatchObject({ value: "Chartered Institution of Highways & Transportation (CIHT)", confidence: "high" });
    expect(r.title.value).toBe("Webinar: active travel schemes in practice");
    expect(r.sourceType).toMatchObject({ value: "webinar", confidence: "high" });
    expect(r.eventDate).toMatchObject({ value: "2026-11-18", confidence: "high" });
    expect(r.durationMinutes).toMatchObject({ value: 60, confidence: "low" });
    expect(r.flags).toEqual({ upcoming: true, recording: false });
    expectWellFormed(r);
  });

  it("IHE conference: venue, labelled date Check, posted and booking dates ignored", () => {
    const r = run("https://www.theihe.org/events/annual-conference-2026/", html("ihe-event.html"));
    expect(r.provider).toMatchObject({ value: "Institute of Highway Engineers (IHE)", confidence: "high" });
    expect(r.title.value).toBe("Annual conference 2026");
    expect(r.eventDate).toMatchObject({ value: "2026-12-03", confidence: "low" });
    expect(r.durationMinutes).toMatchObject({ value: 390, confidence: "low" });
    expect(r.sourceType).toMatchObject({ value: "live_event", confidence: "low" });
    expect(r.flags.upcoming).toBe(true);
    expect(r.providerCpdHours.confidence).toBe("missing");
    expectWellFormed(r);
  });

  it("ADEPT forum: numeric UK date, am/pm range, Teams means webinar (Check)", () => {
    const r = run("https://www.adeptnet.org.uk/events/highways-policy-forum", html("adept-event.html"));
    expect(r.provider.value).toMatch(/ADEPT/);
    expect(r.eventDate).toMatchObject({ value: "2027-05-20", confidence: "low" });
    expect(r.durationMinutes).toMatchObject({ value: 90, confidence: "low" });
    expect(r.sourceType).toMatchObject({ value: "webinar", confidence: "low" });
    expect(r.flags.upcoming).toBe(true);
    expectWellFormed(r);
  });

  it("Road Safety GB roundtable: past, on demand, so a recording and not upcoming", () => {
    const r = run("https://www.roadsafetygb.org.uk/events/safer-speeds-roundtable/", html("roadsafetygb-event.html"));
    expect(r.provider).toMatchObject({ value: "Road Safety GB", confidence: "high" });
    expect(r.eventDate).toMatchObject({ value: "2025-06-18", confidence: "high" });
    expect(r.durationMinutes).toMatchObject({ value: 60, confidence: "low" });
    expect(r.flags).toEqual({ upcoming: false, recording: true });
    expectWellFormed(r);
  });
});

describe("events adapter: robustness", () => {
  it("copes with empty, broken and hostile HTML", () => {
    for (const body of ["", "   ", "<", "<<<>>>", "<time datetime='x'>", "<script>alert(1)</script>", "\u0000\u0001", "<div".repeat(2000)]) {
      const r = run(CIHT, body);
      expect(r.provider.confidence).toBe("high");
      expect(r.flags.upcoming).toBe(false);
      expectWellFormed(r);
    }
  });

  it("ignores invalid JSON-LD", () => {
    const body = `<html><head><script type="application/ld+json">{ not json </script></head><body><main><h1>Session</h1><p>Date: 4 April 2027</p></main></body></html>`;
    expect(run(CIHT, body).eventDate.value).toBe("2027-04-04");
  });

  it("stays fast on a large page full of dates and times", () => {
    const row = "<p>Date: 4 April 2027 Time: 18:00-19:00 CPD hours: 2 Watch the recording</p>";
    const started = Date.now();
    const r = run(CIHT, page(row.repeat(8000)));
    expect(Date.now() - started).toBeLessThan(8000);
    expect(r.eventDate.value).toBe("2027-04-04");
  });

  it("is pure: the same input gives the same output", () => {
    const body = html("ice-event-recording.html");
    const u = "https://www.ice.org.uk/events/upcoming-events/recording-cpd";
    expect(run(u, body)).toEqual(run(u, body));
  });

  it("never puts raw markup characters from the page into evidence", () => {
    const r = run(CIHT, page("<p>Date: 4 April 2027</p><p>CPD hours: 2</p>"));
    for (const f of [r.eventDate, r.durationMinutes, r.providerCpdHours]) expect(f.evidence).not.toMatch(/[<>]/);
  });
});

describe("events adapter: facts in a banner above <main>", () => {
  const url = "https://www.ilp.org.uk/events/lighting-for-cycle-routes/";
  const r = run(url, html("ilp-event-hero-outside-main.html"));

  it("reads the date from the banner, as Check, and flags the event as upcoming", () => {
    expect(r.eventDate).toMatchObject({ value: "2027-03-04", confidence: "low" });
    expect(r.eventDate.evidence).toContain("Date 4 March 2027");
    expect(r.eventDate.evidence).toMatch(/outside the main part of the page/);
    expect(r.flags.upcoming).toBe(true);
    expect(r.notes.join(" ")).toMatch(/Log it only after you have attended/);
  });
  it("reads the time range and the CPD hours from the banner, as Check, and says they were outside <main>", () => {
    expect(r.durationMinutes).toMatchObject({ value: 60, confidence: "low" });
    expect(r.durationMinutes.evidence).toContain("18:00-19:00");
    expect(r.durationMinutes.evidence).toMatch(/outside the main part of the page/);
    expect(r.providerCpdHours).toMatchObject({ value: 1, confidence: "low" });
    expect(r.providerCpdHours.evidence).toMatch(/outside the main part of the page/);
    expectWellFormed(r);
  });
  it("gives the same facts when the page has no <main>, but then without the outside warning", () => {
    const noMain = html("ilp-event-hero-outside-main.html").replace("<main>", "<div>").replace("</main>", "</div>");
    const x = run(url, noMain);
    expect(x.eventDate).toMatchObject({ value: "2027-03-04", confidence: "low" });
    expect(x.durationMinutes.value).toBe(60);
    expect(x.providerCpdHours.value).toBe(1);
    expect(x.eventDate.evidence).not.toMatch(/outside/);
  });
  it("does not use the footer's 'Members need 30 hours CPD per year'", () => {
    expect(r.providerCpdHours.value).toBe(1);
  });
  it("reads <main> first, so a fact there is not marked as outside", () => {
    const body = "<html><head><title>x</title></head><body><header><p>Date: 1 January 2027</p></header><main><h1>Session</h1><p>Date: 4 March 2027</p><p>Time: 10:00-11:00</p></main></body></html>";
    const x = run(url, body);
    expect(x.eventDate.value).toBe("2027-03-04");
    expect(x.eventDate.evidence).not.toMatch(/outside/);
    expect(x.durationMinutes.evidence).not.toMatch(/outside/);
  });
  it("does not read facts from the navigation, a sidebar or the footer", () => {
    const body = "<html><head><title>x</title></head><body><nav>Date: 4 March 2027 Time: 18:00-19:00 CPD hours: 2</nav><main><h1>Session</h1><p>Text.</p></main><aside>Date: 5 March 2027</aside><footer>Date: 6 March 2027 CPD hours: 3</footer></body></html>";
    const x = run(url, body);
    expect(x.eventDate.confidence).toBe("missing");
    expect(x.durationMinutes.confidence).toBe("missing");
    expect(x.providerCpdHours.confidence).toBe("missing");
    expect(x.flags.upcoming).toBe(false);
  });
  it("says 'We could not find' about a length it did not find, not that the page has none", () => {
    const x = run(url, page("<p>Date: 4 April 2027</p>"));
    expect(x.durationMinutes.confidence).toBe("missing");
    expect(x.durationMinutes.evidence).toMatch(/^We could not find/);
    expect(x.durationMinutes.evidence).not.toMatch(/does not give/);
  });
});

describe("events adapter: a <time> tag that is a news or publication date is not the event date", () => {
  const NEWS = "https://www.ciht.org.uk/news/new-guidance-published/";
  it("gives no event date for a news item (fixture with a post-meta entry-date and a plain date class)", () => {
    const r = run(NEWS, html("ciht-news-entry-date.html"));
    expect(r.eventDate.confidence).toBe("missing");
    expect(r.eventDate.value).toBeNull();
    expect(r.flags.upcoming).toBe(false);
    expect(r.notes.join(" ")).not.toMatch(/not happened yet/);
    expect(r.provider.confidence).toBe("high");
    expectWellFormed(r);
  });
  it.each([
    ["entry-date", '<div class="post-meta"><time class="entry-date" datetime="2027-05-01">May</time></div>'],
    ["an article-date class", '<p class="article-date"><time datetime="2027-05-01">May</time></p>'],
    ["a news container", '<div class="news-item"><time datetime="2027-05-01">May</time></div>'],
    ["a blog container", '<div class="blog-meta"><time datetime="2027-05-01">May</time></div>'],
  ])("does not take %s as High, even on an events address", (_name, inner) => {
    const r = run(CIHT, page(inner));
    expect(r.eventDate.confidence).not.toBe("high");
    expect(r.eventDate.value).toBeNull();
  });
  it("does not take a bare date class in a meta box as High on a page whose address is not an event address", () => {
    const r = run(NEWS, page('<div class="meta"><time class="date" datetime="2027-05-01">May</time></div>'));
    expect(r.eventDate.confidence).toBe("missing");
  });
  it("does not take a bare date class as High on a page whose address is not an event address", () => {
    const body = "<html><head><title>Annual conference review</title></head><body><main><h1>Annual conference review</h1><time class='date' datetime='2027-05-01'>May</time></main></body></html>";
    const r = run(NEWS, body);
    expect(r.eventDate.confidence).not.toBe("high");
  });
  it("does not use any <time> tag on a page that does not look like an event page", () => {
    const body = "<html><head><title>About us</title></head><body><main><h1>About us</h1><p class='event-date'><time datetime='2027-05-01'>May</time></p></main></body></html>";
    expect(run("https://www.ciht.org.uk/about-us/", body).eventDate.confidence).toBe("missing");
  });
  it("still reads a tag that says it is an event date, directly or through its container", () => {
    expect(run(CIHT, page('<p class="event-date"><time datetime="2027-03-16T18:00:00+00:00">x</time></p>')).eventDate)
      .toMatchObject({ value: "2027-03-16", confidence: "high" });
    expect(run(CIHT, page('<div class="event-details"><time class="date" datetime="2027-03-16">x</time></div>')).eventDate)
      .toMatchObject({ value: "2027-03-16", confidence: "high" });
    expect(run(CIHT, page('<p>Starts <time datetime="2027-03-16">x</time></p>')).eventDate)
      .toMatchObject({ value: "2027-03-16", confidence: "high" });
    expect(run(CIHT, page('<p class="start-date"><time datetime="2027-03-16">x</time></p>')).eventDate.confidence).toBe("high");
  });
});

describe("events adapter: more than one date in the text", () => {
  const IHE = "https://www.theihe.org/events/annual-conference/";
  const dateOf = (url: string, inner: string) => run(url, page(inner));

  it("does not take an early-bird or booking end date as the event date", () => {
    const r = dateOf(IHE, "<p>Early bird rate ends 31 January 2027. The conference takes place on 12 May 2027.</p>");
    expect(r.eventDate).toMatchObject({ value: "2027-05-12", confidence: "low" });
    expect(dateOf(IHE, "<p>Early bird rate ends 31 January 2027.</p>").eventDate.confidence).toBe("missing");
    expect(dateOf(IHE, "<p>Booking ended 31 January 2027.</p>").eventDate.confidence).toBe("missing");
    expect(dateOf(IHE, "<p>Offer ending 31 January 2027.</p>").eventDate.confidence).toBe("missing");
  });
  it("uses the first date that has not passed when an earlier one has (a past session, then the real event)", () => {
    const r = dateOf(CIHT, "<p>Following our successful session on 4 March 2025, join us again. Thursday 12 November 2026, 10:00-11:00.</p>");
    expect(r.eventDate).toMatchObject({ value: "2026-11-12", confidence: "low" });
    expect(r.eventDate.evidence).toMatch(/more than one date/);
    expect(r.eventDate.evidence).toMatch(/first one that has not passed/);
    expect(r.flags.upcoming).toBe(true);
    expect(r.notes.join(" ")).toMatch(/Log it only after you have attended/);
  });
  it("is flagged as upcoming whichever of the dates is first in the text", () => {
    const later = dateOf(CIHT, "<p>Join us on 12 November 2026. Our last event was on 4 March 2025.</p>");
    expect(later.eventDate.value).toBe("2026-11-12");
    expect(later.flags.upcoming).toBe(true);
  });
  it("takes the first of several dates that are all still to come, without the 'not passed' remark", () => {
    const r = dateOf(CIHT, "<p>Join us on 12 November 2026, or on 3 December 2026.</p>");
    expect(r.eventDate.value).toBe("2026-11-12");
    expect(r.eventDate.evidence).toMatch(/more than one date/);
    expect(r.eventDate.evidence).not.toMatch(/not passed/);
  });
  it("takes the first date when all of them have passed, and is not upcoming", () => {
    const r = dateOf(CIHT, "<p>Held on 4 March 2025 and again on 5 June 2025.</p>");
    expect(r.eventDate.value).toBe("2025-03-04");
    expect(r.flags.upcoming).toBe(false);
  });
  it("a labelled date still beats an unlabelled one", () => {
    const r = dateOf(CIHT, "<p>Following our session on 4 March 2025.</p><p>Date: 12 May 2027</p>");
    expect(r.eventDate).toMatchObject({ value: "2027-05-12", confidence: "low" });
  });
  it("a single date is unchanged and has no 'more than one' remark", () => {
    const r = dateOf(CIHT, "<p>Join us on 12 November 2026.</p>");
    expect(r.eventDate.value).toBe("2026-11-12");
    expect(r.eventDate.evidence).not.toMatch(/more than one/);
  });
});

describe("events adapter: a daily time on a multi-day event is one day's length", () => {
  it("says so for 'each day' and for a day range, and does not call it the length of the session", () => {
    const a = run(CIHT, page("<p>Date: 4-6 March 2027</p><p>Time: 09:00 - 17:00 each day</p>"));
    expect(a.durationMinutes).toMatchObject({ value: 480, confidence: "low" });
    expect(a.durationMinutes.evidence).toMatch(/each day/);
    expect(a.durationMinutes.evidence).toMatch(/one day's scheduled length/);
    expect(a.durationMinutes.evidence).not.toMatch(/scheduled length of the session/);
    const b = run(CIHT, page("<p>Date: 4-6 March 2027</p><p>Time: 09:00 - 17:00</p>"));
    expect(b.durationMinutes.evidence).toMatch(/one day's scheduled length/);
    const c = run(CIHT, page("<p>Time: 09:00 - 17:00 daily</p>"));
    expect(c.durationMinutes.evidence).toMatch(/one day's scheduled length/);
    const d = run(CIHT, page("<p>Time: 09:00 - 17:00</p>", ld({ "@type": "Event", name: "E", startDate: "2027-03-04", endDate: "2027-03-06" })));
    expect(d.durationMinutes.evidence).toMatch(/one day's scheduled length/);
  });
  it("leaves a single-day event's wording as it was", () => {
    const r = run(CIHT, page("<p>Date: 4 March 2027</p><p>Time: 18:00-19:00</p>"));
    expect(r.durationMinutes.evidence).toMatch(/scheduled length of the session, not your learning time/);
    expect(r.durationMinutes.evidence).not.toMatch(/one day's/);
  });
});

describe("events adapter: pages that do not look like event pages", () => {
  const REPORT = "https://www.ciht.org.uk/about-us/annual-report/";
  const report = (inner: string) =>
    `<html><head><title>Annual report</title></head><body><main><h1>Annual report</h1>${inner}</main></body></html>`;

  it("gives no event date, upcoming flag or length for a date in a sentence of an annual report", () => {
    const r = run(REPORT, report("<p>Our next annual conference will take place on 5 May 2027, from 10:00-11:00.</p>"));
    expect(r.eventDate.confidence).toBe("missing");
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.flags.upcoming).toBe(false);
    expect(r.notes.join(" ")).not.toMatch(/not happened yet/);
    expect(r.sourceType.confidence).toBe("missing");
    expect(r.provider.confidence).toBe("high");
    expectWellFormed(r);
  });
  it("gives the date as Check for the same sentence on an event address", () => {
    const r = run(CIHT, report("<p>Our next annual conference will take place on 5 May 2027.</p>"));
    expect(r.eventDate).toMatchObject({ value: "2027-05-05", confidence: "low" });
    expect(r.flags.upcoming).toBe(true);
  });
  it("gives the date as Check for the same sentence when the heading names an event", () => {
    const body = "<html><head><title>Annual conference</title></head><body><main><h1>Annual conference</h1><p>It takes place on 5 May 2027.</p></main></body></html>";
    expect(run(REPORT, body).eventDate).toMatchObject({ value: "2027-05-05", confidence: "low" });
  });
  it("still takes a labelled 'Date:' on a page with an address and heading that name no event word", () => {
    const body = "<html><head><title>Road safety day</title></head><body><main><h1>Road safety day</h1><p>Date: 4 March 2027</p><p>Time: 18:00-19:00</p></main></body></html>";
    const r = run("https://www.ciht.org.uk/whats-on/road-safety-day/", body);
    expect(r.eventDate).toMatchObject({ value: "2027-03-04", confidence: "low" });
    expect(r.durationMinutes).toMatchObject({ value: 60, confidence: "low" });
    expect(r.flags.upcoming).toBe(true);
  });
  it("still reads a JSON-LD Event on any address, as High", () => {
    const body = report("<p>x</p>") .replace("</head>", `${ld({ "@type": "Event", name: "E", startDate: "2027-03-16T18:00:00Z", endDate: "2027-03-16T19:00:00Z" })}</head>`);
    const r = run(REPORT, body);
    expect(r.eventDate).toMatchObject({ value: "2027-03-16", confidence: "high" });
    expect(r.durationMinutes).toMatchObject({ value: 60, confidence: "low" });
    expect(r.flags.upcoming).toBe(true);
  });
  it("an ICE events page is an event page whatever its heading says", () => {
    const body = "<html><head><title>Briefing</title></head><body><main><h1>Briefing</h1><p>It takes place on 5 May 2027, 10:00-11:00.</p></main></body></html>";
    const r = run("https://www.ice.org.uk/events/briefing", body);
    expect(r.eventDate.value).toBe("2027-05-05");
    expect(r.durationMinutes.value).toBe(60);
  });
});

describe("events adapter: an 'On demand' menu item is not a recording", () => {
  it.each([
    "Events | On demand | News",
    "Home On demand Contact",
    "On demand",
    "Our on-demand library has more sessions",
  ])("textOffersRecording is false for %j", (text) => {
    expect(textOffersRecording(text)).toBe(false);
  });
  it.each([
    "Access on demand",
    "You can stream on demand",
    "Available on demand",
    "Watch on demand",
    "This session is on demand",
  ])("textOffersRecording is still true for %j", (text) => {
    expect(textOffersRecording(text)).toBe(true);
  });
  it("does not flag a live future seminar whose menu is outside <nav> and <main>", () => {
    const body = "<html><head><title>Seminar</title></head><body><div class='menu'><a href='/events'>Events</a> <a href='/od'>On demand</a> <a href='/news'>News</a></div><div class='content'><h1>Highways seminar</h1><p>Date: 4 March 2027</p><p>Time: 18:00-19:00</p></div></body></html>";
    const r = run("https://www.ciht.org.uk/events/highways-seminar/", body);
    expect(r.flags).toEqual({ upcoming: true, recording: false });
    expect(r.notes.join(" ")).not.toMatch(/recording/);
  });
});

describe("events adapter: CPD hours the page states about something other than this event", () => {
  it.each([
    "Members need 30 hours CPD per year.",
    "12 hours CPD for the year",
    "Complete 30 hours of CPD a year",
    "CPD: 30 hours annually",
    "CPD hours: 30 each year",
    "Chartered members must complete 30 hours CPD",
    "ILP requires 20 hours CPD",
    "You should aim for a minimum of 25 hours CPD",
    "CPD hours: 30 per annum",
    "30 CPD hours every year",
  ])("does not read %j as this event's CPD hours", (text) => {
    expect(findProviderCpdHours(text).confidence).toBe("missing");
  });
  it("takes the event's own figure when a general statement comes first, or second", () => {
    expect(findProviderCpdHours("Members need 30 hours CPD per year. This event is worth 2 hours CPD.").value).toBe(2);
    expect(findProviderCpdHours("This event is worth 2 hours CPD. Members need 30 hours CPD per year.").value).toBe(2);
    expect(findProviderCpdHours("30 hours CPD per year is required. CPD hours: 3").value).toBe(3);
  });
  it("still reads a figure followed by something that is not a yearly amount", () => {
    expect(findProviderCpdHours("2 hours CPD per session").value).toBe(2);
    expect(findProviderCpdHours("Attendees must complete the short quiz to earn 2 hours CPD").value).toBe(2);
    expect(findProviderCpdHours("Earn 1.5 hours CPD").value).toBe(1.5);
  });
  it("accepts up to 40 hours and nothing above it", () => {
    expect(findProviderCpdHours("CPD hours: 40").value).toBe(40);
    expect(findProviderCpdHours("40 hours CPD").value).toBe(40);
    expect(findProviderCpdHours("CPD hours: 41").confidence).toBe("missing");
    expect(findProviderCpdHours("CPD hours: 50").confidence).toBe("missing");
    expect(findProviderCpdHours("99 hours CPD").confidence).toBe("missing");
  });
  it("a sidebar-style sentence on an event page is not offered as the event's hours", () => {
    const r = run("https://www.ilp.org.uk/events/x", page("<p>Date: 4 March 2027</p><p>Members need 30 hours CPD per year.</p>"));
    expect(r.providerCpdHours.confidence).toBe("missing");
  });
});

describe("events adapter: 'am' and 'pm' in ordinary words are not times", () => {
  it("does not read '2-3 amendments' as a one-hour session", () => {
    const r = run(CIHT, page("<p>Date: 4 March 2027</p><p>We will cover 2-3 amendments to the Act and 10-11 amazing speakers.</p>"));
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.eventDate.value).toBe("2027-03-04");
  });
  it("still reads a real am or pm range on the same page", () => {
    const r = run(CIHT, page("<p>Date: 4 March 2027</p><p>We will cover 2-3 amendments. Time: 10-11am</p>"));
    expect(r.durationMinutes).toMatchObject({ value: 60, confidence: "low" });
    expect(r.durationMinutes.evidence).toContain("10-11am");
  });
});
