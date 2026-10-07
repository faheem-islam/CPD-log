import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { genericAdapter } from "@/lib/adapters/generic";
import { jsonLdNodes, textValue, typesOf } from "@/lib/adapters/jsonld";
import { loadDoc, stripSiteSuffix, titlesPlausiblyMatch } from "@/lib/adapters/common";
import type { AdapterResult } from "@/lib/types";

const NOW = new Date("2026-10-07T09:00:00Z");
const hasControlChars = (s: string): boolean => [...s].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
const html = (name: string): string => readFileSync(path.resolve(import.meta.dirname, "../fixtures/html", name), "utf8");
const U = "https://www.example.com/page";
const run = (body: string, url = U, now: Date = NOW): AdapterResult => genericAdapter.extract({ url, html: body, now });
const doc = (head: string, body = "<p>Text.</p>") => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const ldTag = (obj: unknown) => `<script type="application/ld+json">${JSON.stringify(obj)}</script>`;

function expectWellFormed(r: AdapterResult): void {
  for (const key of ["title", "provider", "sourceType", "theme", "durationMinutes", "publishedAt", "eventDate", "providerCpdHours"] as const) {
    const f = r[key];
    expect(f.evidence.length).toBeGreaterThan(5);
    expect(f.value === null).toBe(f.confidence === "missing");
  }
}

describe("generic adapter: identity", () => {
  it("matches every URL and has the lowest specificity", () => {
    expect(genericAdapter.id).toBe("generic");
    expect(genericAdapter.specificity).toBe(0);
    expect(genericAdapter.matches(new URL("https://anything.example/x"))).toBe(true);
  });
});

describe("generic adapter: article with JSON-LD in an @graph", () => {
  const r = run(html("generic-article-jsonld.html"));
  it("takes the title from the structured data, as High", () => {
    expect(r.title).toMatchObject({ value: "Bridge bearings explained", confidence: "high" });
    expect(r.title.evidence).toMatch(/structured data/);
  });
  it("takes the provider from og:site_name, as Check only", () => {
    expect(r.provider).toMatchObject({ value: "Example Engineering Insights", confidence: "low" });
    expect(r.provider.evidence).toMatch(/og:site_name/);
  });
  it("reads the type and published date from the structured data", () => {
    expect(r.sourceType).toMatchObject({ value: "article", confidence: "high" });
    expect(r.publishedAt).toMatchObject({ value: "2025-11-03", confidence: "high" });
  });
  it("never works out a duration from the word count", () => {
    expect(r.durationMinutes.value).toBeNull();
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.eventDate.confidence).toBe("missing");
    expect(r.theme.confidence).toBe("missing");
    expectWellFormed(r);
  });
});

describe("generic adapter: VideoObject", () => {
  const r = run(html("generic-video-jsonld.html"), "https://www.example.com/v/1");
  it("reads the ISO duration as High and rounds to the nearest minute", () => {
    expect(r.durationMinutes).toMatchObject({ value: 13, confidence: "high" });
    expect(r.durationMinutes.evidence).toMatch(/not your learning time/);
  });
  it("reads the other fields", () => {
    expect(r.title).toMatchObject({ value: "Site investigation basics", confidence: "high" });
    expect(r.sourceType).toMatchObject({ value: "video", confidence: "high" });
    expect(r.publishedAt).toMatchObject({ value: "2025-08-20", confidence: "high" });
    expect(r.provider).toMatchObject({ value: "Example Learning", confidence: "low" });
    expectWellFormed(r);
  });
  it("handles a very short video and a zero duration", () => {
    expect(run(doc(ldTag({ "@type": "VideoObject", name: "V", duration: "PT20S" }))).durationMinutes.value).toBe(1);
    expect(run(doc(ldTag({ "@type": "VideoObject", name: "V", duration: "PT0S" }))).durationMinutes.confidence).toBe("missing");
    expect(run(doc(ldTag({ "@type": "VideoObject", name: "V", duration: "soon" }))).durationMinutes.confidence).toBe("missing");
    expect(run(doc(ldTag({ "@type": "VideoObject", name: "V", duration: 600 }))).durationMinutes.confidence).toBe("missing");
  });
  it("makes a video length Check, with a caveat, when the page is an article with a video on it", () => {
    const body = doc(ldTag({ "@graph": [{ "@type": "Article", headline: "A", datePublished: "2026-01-01" }, { "@type": "VideoObject", name: "Clip", duration: "PT3M" }] }));
    const x = run(body);
    expect(x.durationMinutes).toMatchObject({ value: 3, confidence: "low" });
    expect(x.durationMinutes.evidence).toMatch(/only a video on it/);
    expect(x.sourceType).toMatchObject({ value: "article", confidence: "high" });
  });
});

describe("generic adapter: Event JSON-LD", () => {
  const r = run(html("generic-event-jsonld.html"), "https://www.example.com/e/1");
  it("reads the event date as High and works out the scheduled length as Check", () => {
    expect(r.eventDate).toMatchObject({ value: "2026-10-20", confidence: "high" });
    expect(r.durationMinutes).toMatchObject({ value: 90, confidence: "low" });
    expect(r.durationMinutes.evidence).toMatch(/scheduled length, not your learning time/);
  });
  it("flags a future event as upcoming and says so", () => {
    expect(r.flags).toEqual({ upcoming: true, recording: false });
    expect(r.notes.join(" ")).toMatch(/Log it only after you have attended/);
  });
  it("reads an in-person event as a live event", () => {
    expect(r.sourceType).toMatchObject({ value: "live_event", confidence: "high" });
    expectWellFormed(r);
  });
  it("does not flag a past event", () => {
    expect(run(html("generic-event-jsonld.html"), U, new Date("2026-10-21T09:00:00Z")).flags.upcoming).toBe(false);
  });
  it("guesses live event, Check, when attendance mode is not given", () => {
    const x = run(doc(ldTag({ "@type": "Event", name: "E", startDate: "2027-01-05" })));
    expect(x.sourceType).toMatchObject({ value: "live_event", confidence: "low" });
  });
  it("reads an online event as a webinar", () => {
    const x = run(doc(ldTag({ "@type": "Event", name: "E", startDate: "2027-01-05", eventAttendanceMode: "OnlineEventAttendanceMode" })));
    expect(x.sourceType).toMatchObject({ value: "webinar", confidence: "high" });
  });
  it("uses the event's own ISO duration when there are no end times", () => {
    const x = run(doc(ldTag({ "@type": "Event", name: "E", startDate: "2027-01-05", duration: "PT2H" })));
    expect(x.durationMinutes).toMatchObject({ value: 120, confidence: "low" });
  });
});

describe("generic adapter: OpenGraph only", () => {
  const r = run(html("generic-opengraph-only.html"));
  it("reads title, site, type and a timestamped published date", () => {
    expect(r.title).toMatchObject({ value: "Notes on drainage design", confidence: "high" });
    expect(r.provider).toMatchObject({ value: "Example Civils", confidence: "low" });
    expect(r.sourceType).toMatchObject({ value: "article", confidence: "high" });
    expect(r.sourceType.evidence).toMatch(/og:type/);
    expect(r.publishedAt).toMatchObject({ value: "2025-11-03", confidence: "high" });
    expect(r.durationMinutes.confidence).toBe("missing");
    expectWellFormed(r);
  });
  it("reads og:video:duration as seconds", () => {
    const head = '<meta property="og:type" content="video.other"><meta property="og:title" content="A clip"><meta property="og:video:duration" content="754">';
    const x = run(doc(head));
    expect(x.durationMinutes).toMatchObject({ value: 13, confidence: "high" });
    expect(x.sourceType).toMatchObject({ value: "video", confidence: "high" });
  });
  it("makes og:video:duration Check when the page is an article", () => {
    const head = '<meta property="og:type" content="article"><meta property="og:video:duration" content="120">';
    const x = run(doc(head));
    expect(x.durationMinutes).toMatchObject({ value: 2, confidence: "low" });
    expect(x.durationMinutes.evidence).toMatch(/only a video on it/);
  });
  it.each([["abc"], ["-5"], ["0"], [""], ["1e3"], ["99999999"], ["NaN"], ["12:30"]])("ignores a bad og:video:duration of %j", (v) => {
    const x = run(doc(`<meta property="og:type" content="video.other"><meta property="og:video:duration" content="${v}">`));
    expect(x.durationMinutes.confidence).toBe("missing");
  });
  it("accepts an ISO duration in og:video:duration", () => {
    expect(run(doc('<meta property="og:video:duration" content="PT5M">')).durationMinutes.value).toBe(5);
  });
  it("is Check, and says so, when only og:video is present", () => {
    const x = run(doc('<meta property="og:video" content="https://example.com/v.mp4">'));
    expect(x.sourceType).toMatchObject({ value: "video", confidence: "low" });
  });
});

describe("generic adapter: a bare title tag", () => {
  const r = run(html("generic-title-only.html"));
  it("gives a Check title with the site suffix removed, and says so", () => {
    expect(r.title.value).toBe("Drainage notes");
    expect(r.title.confidence).toBe("low");
    expect(r.title.evidence).toContain('removed "Example Civils Ltd"');
  });
  it("finds nothing else", () => {
    for (const key of ["provider", "sourceType", "theme", "durationMinutes", "publishedAt", "eventDate", "providerCpdHours"] as const) {
      expect(r[key].confidence).toBe("missing");
    }
    expectWellFormed(r);
  });
  it("says the title tag might carry a site name when nothing was removed", () => {
    const x = run(doc("<title>Drainage notes</title>"));
    expect(x.title.confidence).toBe("low");
    expect(x.title.evidence).toMatch(/site name/);
    expect(x.title.evidence).not.toMatch(/removed/);
  });
});

describe("generic adapter: title rules", () => {
  it("makes an h1 High only when it plausibly matches the title", () => {
    const ok = run(doc("<title>Bridge bearings explained | Example</title>", "<h1>Bridge bearings explained</h1>"));
    expect(ok.title).toMatchObject({ value: "Bridge bearings explained", confidence: "high" });
    const odd = run(doc("<title>Bridge bearings explained | Example</title>", "<h1>Welcome to our website</h1>"));
    expect(odd.title.value).toBe("Bridge bearings explained");
    expect(odd.title.confidence).toBe("low");
    expect(odd.title.evidence).toMatch(/disagree/);
  });
  it("gives an h1 on its own as Check, not High", () => {
    const x = run(doc("", "<h1>Only a heading</h1>"));
    expect(x.title).toMatchObject({ value: "Only a heading", confidence: "low" });
  });
  it("prefers og:title over a disagreeing h1", () => {
    const x = run(doc('<meta property="og:title" content="The real title">', "<h1>Welcome</h1>"));
    expect(x.title).toMatchObject({ value: "The real title", confidence: "high" });
  });
  it("prefers JSON-LD over everything", () => {
    const x = run(doc(`<title>Page | Site</title><meta property="og:title" content="OG title">${ldTag({ "@type": "Article", headline: "LD title" })}`, "<h1>Heading</h1>"));
    expect(x.title).toMatchObject({ value: "LD title", confidence: "high" });
  });
  it("ignores a WebPage name that does not match the page", () => {
    const x = run(doc(`<title>Bridge bearings | Site</title>${ldTag({ "@type": "WebPage", name: "Home" })}`, "<h1>Bridge bearings</h1>"));
    expect(x.title.value).toBe("Bridge bearings");
  });
  it("accepts a WebPage name that matches", () => {
    const x = run(doc(`<title>Bridge bearings | Site</title>${ldTag({ "@type": "WebPage", name: "Bridge bearings" })}`));
    expect(x.title).toMatchObject({ value: "Bridge bearings", confidence: "high" });
  });
  it("has no title when there is nothing", () => {
    const x = run("<html><body><p>Hello</p></body></html>");
    expect(x.title.confidence).toBe("missing");
  });
  it("cleans control characters and caps a very long title", () => {
    const x = run(doc(`<title>${"Long title ".repeat(100)}</title>`));
    expect((x.title.value ?? "").length).toBeLessThanOrEqual(300);
    const y = run(doc('<meta property="og:title" content="A&#0;B&#7;C">'));
    expect(hasControlChars(y.title.value ?? "")).toBe(false);
  });
});

describe("stripSiteSuffix", () => {
  it.each([
    ["Safe lifting | ICE", "Safe lifting", "ICE"],
    ["Safe lifting - ICE", "Safe lifting", "ICE"],
    ["Safe lifting – ICE", "Safe lifting", "ICE"],
    ["Safe lifting — ICE", "Safe lifting", "ICE"],
    ["Safe lifting :: ICE", "Safe lifting", "ICE"],
    ["Safe lifting · ICE", "Safe lifting", "ICE"],
    ["Safe lifting | Highways Magazine Online", "Safe lifting", "Highways Magazine Online"],
    ["Safe lifting - part two | ICE", "Safe lifting - part two", "ICE"],
  ])("%s", (input, value, removed) => {
    expect(stripSiteSuffix(input)).toEqual({ value, removed });
  });
  it("leaves titles without a separator, or with a long tail, alone", () => {
    expect(stripSiteSuffix("Safe lifting")).toEqual({ value: "Safe lifting", removed: null });
    expect(stripSiteSuffix("Safe-lifting")).toEqual({ value: "Safe-lifting", removed: null });
    const longTail = "Safe lifting | a very long phrase that is clearly part of the title itself";
    expect(stripSiteSuffix(longTail).removed).toBeNull();
  });
  it("removes a long tail when it is a known site name", () => {
    expect(stripSiteSuffix("Safe lifting | The Very Long Site Name Of The Institution", ["the very long site name of the institution"]).removed).toBe("The Very Long Site Name Of The Institution");
  });
  it("never strips the whole title", () => {
    expect(stripSiteSuffix("| ICE").removed).toBeNull();
    expect(stripSiteSuffix("A | B").removed).toBeNull();
  });
  it("matches titles loosely", () => {
    expect(titlesPlausiblyMatch("Safe lifting", "Safe lifting | ICE")).toBe(true);
    expect(titlesPlausiblyMatch("Welcome", "Safe lifting | ICE")).toBe(false);
    expect(titlesPlausiblyMatch("", "x")).toBe(false);
  });
});

describe("generic adapter: provider order", () => {
  it("prefers og:site_name, then publisher, then author, then the author tag, all Check", () => {
    const base = { "@type": "Article", headline: "H", publisher: { "@type": "Organization", name: "Pub Ltd" }, author: { "@type": "Person", name: "Ann Author" } };
    const a = run(doc(`<meta property="og:site_name" content="Site Name">${ldTag(base)}<meta name="author" content="Meta Author">`));
    expect(a.provider).toMatchObject({ value: "Site Name", confidence: "low" });
    const b = run(doc(`${ldTag(base)}<meta name="author" content="Meta Author">`));
    expect(b.provider).toMatchObject({ value: "Pub Ltd", confidence: "low" });
    const c = run(doc(ldTag({ "@type": "Article", headline: "H", author: { "@type": "Person", name: "Ann Author" } })));
    expect(c.provider).toMatchObject({ value: "Ann Author", confidence: "low" });
    expect(c.provider.evidence).toMatch(/author/);
    const d = run(doc('<meta name="author" content="Meta Author">'));
    expect(d.provider).toMatchObject({ value: "Meta Author", confidence: "low" });
    const e = run(doc("<title>x</title>"));
    expect(e.provider.confidence).toBe("missing");
  });
  it("reads a publisher given as a plain string or an array", () => {
    expect(run(doc(ldTag({ "@type": "Article", headline: "H", publisher: "Plain Pub" }))).provider.value).toBe("Plain Pub");
    expect(run(doc(ldTag({ "@type": "Article", headline: "H", publisher: [{ name: "First" }, { name: "Second" }] }))).provider.value).toBe("First");
  });
});

describe("generic adapter: source type rules", () => {
  const type = (head: string) => run(doc(head)).sourceType;
  it("reads WebPage as an article, Check", () => {
    expect(type(ldTag({ "@type": "WebPage", name: "x" }))).toMatchObject({ value: "article", confidence: "low" });
    expect(type('<meta property="og:type" content="website">')).toMatchObject({ value: "article", confidence: "low" });
  });
  it("reads webinar from the title or description, Check", () => {
    expect(type('<meta property="og:title" content="Our autumn webinar">')).toMatchObject({ value: "webinar", confidence: "low" });
    expect(type('<title>x</title><meta name="description" content="Join the webinar">')).toMatchObject({ value: "webinar", confidence: "low" });
  });
  it("gives nothing when there is no signal", () => {
    expect(type("<title>x</title>").confidence).toBe("missing");
  });
});

describe("generic adapter: published dates", () => {
  const pub = (head: string) => run(doc(head)).publishedAt;
  it.each([
    [ldTag({ "@type": "Article", headline: "H", datePublished: "2025-11-03T09:15:00+00:00" }), "2025-11-03"],
    [ldTag({ "@type": "Article", headline: "H", datePublished: "2025-11-03" }), "2025-11-03"],
    [ldTag({ "@type": "Article", headline: "H", datePublished: "3 November 2025" }), "2025-11-03"],
    [ldTag({ "@type": "Article", headline: "H", datePublished: "03/11/2025" }), "2025-11-03"],
    [ldTag({ "@type": "VideoObject", name: "V", uploadDate: "2025-11-03T23:59:59Z" }), "2025-11-03"],
    ['<meta property="article:published_time" content="2025-11-03T09:15:00+00:00">', "2025-11-03"],
    ['<meta itemprop="datePublished" content="2025-11-03">', "2025-11-03"],
    ['<meta name="date" content="2025-11-03">', "2025-11-03"],
  ])("reads %s", (head, iso) => {
    const f = pub(head);
    expect(f.value).toBe(iso);
    expect(f.confidence).toBe("high");
  });
  it.each([
    [ldTag({ "@type": "Article", headline: "H", datePublished: "yesterday" })],
    [ldTag({ "@type": "Article", headline: "H", datePublished: "2025-02-31" })],
    [ldTag({ "@type": "Article", headline: "H", datePublished: 20251103 })],
    ['<meta property="article:published_time" content="soon">'],
    [""],
  ])("ignores %s", (head) => {
    expect(pub(head).confidence).toBe("missing");
  });
  it("does not read a date from the page text", () => {
    expect(run(doc("", "<p>Published 3 November 2025</p>")).publishedAt.confidence).toBe("missing");
  });
});

describe("JSON-LD reading", () => {
  it("handles @graph, arrays, nested video and type lists, and schema.org prefixes", () => {
    const d = loadDoc(doc(
      ldTag([{ "@type": ["Thing", "https://schema.org/Article"] }, { "@graph": [{ "@type": "schema:Event" }] }]) +
        ldTag({ "@type": "WebPage", mainEntity: { "@type": "VideoObject", name: "Nested" } }),
    ));
    const types = jsonLdNodes(d).flatMap(typesOf);
    expect(types).toEqual(expect.arrayContaining(["thing", "article", "event", "webpage", "videoobject"]));
  });
  it("skips invalid JSON, wrapped JSON-LD still parses, other script types are ignored", () => {
    const d = loadDoc(
      '<script type="application/ld+json">{ nope</script>' +
        '<script type="application/ld+json"><!-- {"@type":"Article","headline":"Wrapped"} --></script>' +
        '<script type="text/javascript">{"@type":"Article","headline":"Not JSON-LD"}</script>',
    );
    const nodes = jsonLdNodes(d);
    expect(nodes.length).toBe(1);
    expect(nodes[0]?.["headline"]).toBe("Wrapped");
  });
  it("caps how many nodes it reads and how deep it goes", () => {
    const many = Array.from({ length: 5000 }, (_, i) => ({ "@type": "Thing", name: `n${i}` }));
    expect(jsonLdNodes(loadDoc(doc(ldTag(many)))).length).toBeLessThanOrEqual(300);
    let deep: Record<string, unknown> = { "@type": "Article", headline: "Deep" };
    for (let i = 0; i < 50; i += 1) deep = { "@type": "WebPage", mainEntity: deep };
    expect(jsonLdNodes(loadDoc(doc(ldTag(deep)))).length).toBeLessThan(10);
  });
  it("is not polluted by __proto__ keys and still reads the page", () => {
    const body = doc('<script type="application/ld+json">{"@type":"Article","headline":"Safe","__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}</script>');
    const r = run(body);
    expect(r.title.value).toBe("Safe");
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });
  it("handles values of the wrong type without throwing", () => {
    const weird = { "@type": ["Article", 5, null], headline: { nested: [1, 2] }, author: 7, publisher: [null, {}, { name: 5 }], datePublished: ["2025-01-01"], duration: {} };
    const r = run(doc(ldTag(weird)));
    expectWellFormed(r);
  });
});

describe("generic adapter: robustness", () => {
  it("copes with empty, broken and hostile HTML", () => {
    for (const body of ["", " ", "<", "<<<>>>", "<script>alert(1)</script>", "\u0000", "<div".repeat(3000), "<title>".repeat(500)]) {
      expectWellFormed(run(body));
    }
  });
  it("copes with a very large page without taking long", () => {
    const started = Date.now();
    const big = doc("<title>Big</title>", "<p>Some text here and there.</p>".repeat(100000));
    const r = run(big);
    expect(Date.now() - started).toBeLessThan(10000);
    expect(r.title.value).toBe("Big");
  });
  it("is pure: the same input gives the same output", () => {
    const body = html("generic-article-jsonld.html");
    expect(run(body)).toEqual(run(body));
  });
  it("does not put markup into evidence text", () => {
    const r = run(doc('<meta property="og:site_name" content="A &lt;b&gt;Site&lt;/b&gt;"><title>T | <b>x</b></title>'));
    for (const f of [r.title, r.provider]) expect(f.evidence).not.toMatch(/<b>/);
  });
});

describe("generic adapter: a site name in the h1 is not the page title", () => {
  it("does not return the logo h1 as a High title (fixture with a title tag, og:title and the logo as the only h1)", () => {
    const r = run(html("generic-site-name-h1.html"));
    expect(r.title.value).toBe("Notes on drainage design");
    expect(r.title.value).not.toBe("Example Civils");
    expect(r.title.evidence).not.toMatch(/main heading/);
  });
  it("does not take the logo h1 for the title when there is only a title tag with a site suffix", () => {
    const r = run(doc("<title>Notes on drainage design | Example Civils</title>", "<header><h1><a>Example Civils</a></h1></header><main><h2>Notes on drainage design</h2></main>"));
    expect(r.title).toMatchObject({ value: "Notes on drainage design", confidence: "low" });
    expect(r.title.evidence).toContain('removed "Example Civils"');
  });
  it("does not take the logo h1 for the title when the site suffix is too long to be removed as a suffix", () => {
    const r = run(doc("<title>Notes on drainage design | Example Civils and Associates Consulting Engineers Ltd</title>", "<header><h1>Example Civils</h1></header>"));
    expect(r.title.value).not.toBe("Example Civils");
    expect(r.title.confidence).toBe("low");
  });
  it("does not take the logo h1 for the title when og:title has the site name on the end", () => {
    const r = run(doc('<title>x</title><meta property="og:title" content="Notes on drainage design | Example Civils">', "<h1>Example Civils</h1>"));
    expect(r.title.value).toBe("Notes on drainage design | Example Civils");
    expect(r.title.evidence).not.toMatch(/main heading/);
  });
  it("does not trust a WebPage name that is only the site name", () => {
    const r = run(doc(`<title>Notes on drainage design | Example Civils</title>${ldTag({ "@type": "WebPage", name: "Example Civils" })}`, "<header><h1>Example Civils</h1></header>"));
    expect(r.title.value).toBe("Notes on drainage design");
    expect(r.title.evidence).not.toMatch(/structured data/);
  });
  it("treats a heading that is the og:site_name as a site name even when the title tag says something else", () => {
    const r = run(doc('<title>Drainage | Notes</title><meta property="og:site_name" content="Example Civils">', "<h1>Example Civils</h1>"));
    expect(r.title.value).not.toBe("Example Civils");
  });
  it("still gives a real heading High when it agrees with the title without its site name", () => {
    const a = run(doc("<title>Notes on drainage design | Example Civils</title>", "<h1>Notes on drainage design</h1>"));
    expect(a.title).toMatchObject({ value: "Notes on drainage design", confidence: "high" });
    expect(a.title.evidence).toMatch(/main heading, which matches/);
    const b = run(doc('<title>x</title><meta property="og:title" content="Notes on drainage design | Example Civils">', "<h1>Notes on drainage design</h1>"));
    expect(b.title).toMatchObject({ value: "Notes on drainage design", confidence: "high" });
  });
  it("still gives the site name when it really is the whole title (a home page)", () => {
    const r = run(doc("<title>Example Civils</title>", "<h1>Example Civils</h1>"));
    expect(r.title).toMatchObject({ value: "Example Civils", confidence: "high" });
  });
});

describe("generic adapter: lengths that a page states are held to 24 hours", () => {
  const video = (duration: unknown) => run(doc(ldTag({ "@type": "VideoObject", name: "V", duration }))).durationMinutes;
  it("refuses an absurd ISO duration and says why", () => {
    const f = video("PT99999999999999999H");
    expect(f.value).toBeNull();
    expect(f.confidence).toBe("missing");
    expect(f.evidence).toMatch(/more than 24 hours/);
    expect(f.evidence).toMatch(/Please enter/);
  });
  it("accepts exactly 24 hours and refuses one minute more", () => {
    expect(video("PT24H")).toMatchObject({ value: 1440, confidence: "high" });
    expect(video("P1D")).toMatchObject({ value: 1440, confidence: "high" });
    expect(video("PT24H1M").value).toBeNull();
    expect(video("P2D").value).toBeNull();
    expect(video("PT1441M").value).toBeNull();
    expect(video("PT90000S").value).toBeNull();
  });
  it("holds og:video:duration to the same limit, in seconds", () => {
    const og = (v: string) => run(doc(`<meta property="og:type" content="video.other"><meta property="og:video:duration" content="${v}">`)).durationMinutes;
    expect(og("86400")).toMatchObject({ value: 1440 });
    expect(og("86401").value).toBeNull();
    expect(og("86401").evidence).toMatch(/more than 24 hours/);
    expect(og("PT99999999999999999H").value).toBeNull();
    expect(og("P1D").value).toBe(1440);
  });
  it("holds an event's declared duration to the same limit, and says why", () => {
    const ev = (duration: string) => run(doc(ldTag({ "@type": "Event", name: "E", startDate: "2027-01-05", duration }))).durationMinutes;
    expect(ev("PT2H")).toMatchObject({ value: 120 });
    expect(ev("PT24H")).toMatchObject({ value: 1440 });
    expect(ev("PT24H1M").value).toBeNull();
    expect(ev("PT99999999999999999H").value).toBeNull();
    expect(ev("PT99999999999999999H").evidence).toMatch(/more than 24 hours/);
  });
  it("keeps the ordinary 'could not find' wording when the page gave no length at all", () => {
    expect(video(undefined).evidence).toMatch(/We could not find a length/);
  });
});

describe("generic adapter: a hostile JSON-LD value cannot lose the page's other fields", () => {
  /** JSON text for {"name":{"name":...{"name":"Deep name"}}}. Built as text: JSON.stringify itself overflows the stack on this. */
  const nestedNameJson = (depth: number) => `${'{"name":'.repeat(depth)}"Deep name"${"}".repeat(depth)}`;
  const rawLd = (json: string) => `<script type="application/ld+json">${json}</script>`;
  const nestedValue = (depth: number) => {
    let v: unknown = "Deep name";
    for (let i = 0; i < depth; i += 1) v = { name: v };
    return v;
  };
  it("does not throw for a name nested 5,000 or 20,000 levels deep, and keeps the title tag", () => {
    for (const depth of [5000, 20_000]) {
      const ld = `{"@type":"Article","headline":${nestedNameJson(depth)},"datePublished":"2026-01-02"}`;
      const r = run(doc(`<title>The real title | Site</title>${rawLd(ld)}`));
      expect(r.title.value).toBe("The real title");
      expect(r.publishedAt).toMatchObject({ value: "2026-01-02", confidence: "high" });
      expect(r.sourceType.value).toBe("article");
    }
  });
  it("does not throw for an event, publisher, author or status nested 10,000 deep, and keeps the event", () => {
    const deep = nestedNameJson(10_000); // four of these stay under the 600,000 character limit on one script
    const ld = `{"@type":"Event","name":"E","startDate":"2027-01-05","eventAttendanceMode":${deep},"publisher":${deep},"author":${deep},"eventStatus":${deep}}`;
    const r = run(doc(rawLd(ld)));
    expect(r.eventDate).toMatchObject({ value: "2027-01-05", confidence: "high" });
    expect(r.flags.upcoming).toBe(true);
  });
  it("textValue follows at most a few levels of nesting", () => {
    expect(textValue({ name: { name: { name: "three" } } })).toBe("three");
    expect(textValue([[[["four"]]]])).toBe("four");
    expect(textValue(nestedValue(4))).toBe("Deep name");
    expect(textValue(nestedValue(5))).toBeNull();
    expect(textValue(nestedValue(100_000))).toBeNull();
  });
});

describe("generic adapter: published dates use the UK date, as event dates do", () => {
  const pub = (head: string) => run(doc(head)).publishedAt;
  it.each([
    ["JSON-LD datePublished, UTC, summer evening", ldTag({ "@type": "Article", headline: "H", datePublished: "2026-06-30T23:30:00Z" }), "2026-07-01"],
    ["JSON-LD datePublished with +00:00", ldTag({ "@type": "Article", headline: "H", datePublished: "2026-06-30T23:30:00+00:00" }), "2026-07-01"],
    ["JSON-LD uploadDate", ldTag({ "@type": "VideoObject", name: "V", uploadDate: "2026-06-30T23:30:00Z" }), "2026-07-01"],
    ["JSON-LD with an offset east of UTC", ldTag({ "@type": "Article", headline: "H", datePublished: "2026-07-01T00:30:00+01:00" }), "2026-07-01"],
    ["JSON-LD with an offset west of UTC", ldTag({ "@type": "Article", headline: "H", datePublished: "2026-06-30T20:00:00-05:00" }), "2026-07-01"],
    ["article:published_time", '<meta property="article:published_time" content="2026-06-30T23:30:00+00:00">', "2026-07-01"],
    ["itemprop meta", '<meta itemprop="datePublished" content="2026-06-30T23:30:00Z">', "2026-07-01"],
    ["time itemprop", '<time itemprop="datePublished" datetime="2026-06-30T23:30:00Z">x</time>', "2026-07-01"],
    ["a time the page calls published", '<p><time class="published" datetime="2026-06-30T23:30:00Z">x</time></p>', "2026-07-01"],
  ])("%s", (_name, head, iso) => {
    expect(pub(head)).toMatchObject({ value: iso, confidence: "high" });
  });
  it("does not move a winter timestamp, a date with no time, or a time with no zone", () => {
    expect(pub(ldTag({ "@type": "Article", headline: "H", datePublished: "2026-01-02T23:59:59Z" })).value).toBe("2026-01-02");
    expect(pub(ldTag({ "@type": "Article", headline: "H", datePublished: "2026-06-30" })).value).toBe("2026-06-30");
    expect(pub(ldTag({ "@type": "Article", headline: "H", datePublished: "2026-06-30T23:30:00" })).value).toBe("2026-06-30");
    expect(pub(ldTag({ "@type": "Article", headline: "H", datePublished: "30 June 2026" })).value).toBe("2026-06-30");
  });
});

describe("generic adapter: bidi and invisible characters in page text", () => {
  it("removes them from the title tag, og tags and the provider", () => {
    const r = run(doc(
      '<title>Invoice \u202Etxt.exe\u2066 test</title><meta property="og:site_name" content="Site\u202E name\u200F">',
      "<p>Text</p>",
    ));
    expect(r.title.value).toBe("Invoice txt.exe test");
    expect(r.provider.value).toBe("Site name");
    for (const f of [r.title, r.provider]) expect(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/.test(`${f.value}${f.evidence}`)).toBe(false);
  });
  it("removes them from an h1, JSON-LD values and evidence quotes", () => {
    const r = run(doc(ldTag({ "@type": "Article", headline: "Head\u202Eline", publisher: { name: "Pub\u2067lisher" } }), "<h1>H\u202E1</h1>"));
    expect(r.title.value).toBe("Headline");
    expect(r.provider.value).toBe("Publisher");
  });
});
