import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { iceHubAdapter, mapContentType, themeFromIcePath } from "@/lib/adapters/ice-hub";
import { PROFILES } from "@/lib/profiles";
import type { AdapterResult } from "@/lib/types";

const NOW = new Date("2026-10-07T09:00:00Z");
const html = (name: string): string => readFileSync(path.resolve(import.meta.dirname, "../fixtures/html", name), "utf8");
const run = (url: string, body: string): AdapterResult => iceHubAdapter.extract({ url, html: body, now: NOW });
const hub = (slug: string, rest = "an-item/") => `https://knowledgehub.ice.org.uk/cpd/${slug}/${rest}`;

function expectWellFormed(r: AdapterResult): void {
  for (const key of ["title", "provider", "sourceType", "theme", "durationMinutes", "publishedAt", "eventDate", "providerCpdHours"] as const) {
    const f = r[key];
    expect(f.evidence.length).toBeGreaterThan(5);
    expect(f.value === null).toBe(f.confidence === "missing");
  }
}

describe("ice-hub adapter: matching", () => {
  it("matches the Knowledge Hub host only", () => {
    expect(iceHubAdapter.matches(new URL("https://knowledgehub.ice.org.uk/cpd/safety-risk/x/"))).toBe(true);
    expect(iceHubAdapter.matches(new URL("https://www.knowledgehub.ice.org.uk/anything"))).toBe(true);
    expect(iceHubAdapter.matches(new URL("https://www.ice.org.uk/events/x"))).toBe(false);
    expect(iceHubAdapter.matches(new URL("https://ice.org.uk/"))).toBe(false);
    expect(iceHubAdapter.matches(new URL("https://knowledgehub.ice.org.uk.evil.example/cpd/safety-risk/x/"))).toBe(false);
    expect(iceHubAdapter.matches(new URL("https://evilknowledgehub.ice.org.uk/cpd/safety-risk/x/"))).toBe(false);
    expect(iceHubAdapter.matches(new URL("https://example.com/knowledgehub.ice.org.uk"))).toBe(false);
  });
  it("has an id and a specificity above the generic adapter", () => {
    expect(iceHubAdapter.id).toBe("ice-hub");
    expect(iceHubAdapter.specificity).toBeGreaterThan(0);
  });
});

describe("ice-hub adapter: explainer fixture with /cpd/safety-risk/ and Duration 15m", () => {
  const r = run("https://knowledgehub.ice.org.uk/cpd/safety-risk/principal-designer-role/", html("ice-hub-explainer.html"));

  it("reads the title from the page heading", () => {
    expect(r.title.value).toBe("The principal designer role");
    expect(r.title.confidence).toBe("high");
    expect(r.title.evidence).toMatch(/heading/);
  });
  it("gives the provider as High from the site", () => {
    expect(r.provider).toMatchObject({ value: "Institution of Civil Engineers (ICE)", confidence: "high" });
    expect(r.provider.evidence).toMatch(/From the site/);
  });
  it("reads the Duration 15m label as High", () => {
    expect(r.durationMinutes).toMatchObject({ value: 15, confidence: "high" });
    expect(r.durationMinutes.evidence).toBe("The page says Duration 15m.");
  });
  it("reads the content type label", () => {
    expect(r.sourceType).toMatchObject({ value: "article", confidence: "high" });
    expect(r.sourceType.evidence).toContain("Explainer");
  });
  it("gives the exact slug safety-risk as a High theme", () => {
    expect(r.theme).toMatchObject({ value: "Safety and risk management", confidence: "high" });
    expect(r.theme.evidence).toContain("/cpd/safety-risk/");
  });
  it("reads the published date from the labelled text", () => {
    expect(r.publishedAt).toMatchObject({ value: "2025-09-10", confidence: "high" });
    expect(r.publishedAt.evidence).toBe("The page says Published 10 September 2025.");
  });
  it("leaves event fields alone and has no flags", () => {
    expect(r.eventDate.confidence).toBe("missing");
    expect(r.providerCpdHours.confidence).toBe("missing");
    expect(r.flags).toEqual({ upcoming: false, recording: false });
    expectWellFormed(r);
  });
});

describe("ice-hub adapter: a slug that is not the exact one stays Check", () => {
  const r = run("https://knowledgehub.ice.org.uk/cpd/ethics/speaking-up-at-work/", html("ice-hub-ethics.html"));
  it("gives a Check theme that says it is a guess from the web address", () => {
    expect(r.theme.value).toBe("Ethical and professional behaviours");
    expect(r.theme.confidence).toBe("low");
    expect(r.theme.evidence).toMatch(/^Guessed from the web address \(\/cpd\/ethics\/\)/);
    expect(r.theme.evidence).toMatch(/check/i);
  });
  it("still reads the other fields", () => {
    expect(r.title.value).toBe("Speaking up at work");
    expect(r.sourceType).toMatchObject({ value: "document", confidence: "high" });
    expect(r.durationMinutes).toMatchObject({ value: 90, confidence: "high" });
    expect(r.durationMinutes.evidence).toBe("The page says Duration: 1h 30m.");
    expect(r.publishedAt.value).toBe("2026-02-03");
    expectWellFormed(r);
  });
});

describe("ice-hub adapter: no Duration label", () => {
  const r = run("https://knowledgehub.ice.org.uk/cpd/water/river-crossing-inspection/", html("ice-hub-no-duration.html"));
  it("leaves the length missing and says why", () => {
    expect(r.durationMinutes.value).toBeNull();
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.durationMinutes.evidence).toMatch(/no Duration label/);
    expect(r.durationMinutes.evidence).toMatch(/Please enter/);
  });
  it("reads a case study as an article", () => {
    expect(r.sourceType).toMatchObject({ value: "article", confidence: "high" });
    expect(r.sourceType.evidence).toContain("Case study");
  });
  it("has a Check theme for the non-exact slug water", () => {
    expect(r.theme).toMatchObject({ value: "Water", confidence: "low" });
  });
  it("has no published date", () => {
    expect(r.publishedAt.confidence).toBe("missing");
    expectWellFormed(r);
  });
});

describe("themeFromIcePath", () => {
  it("is High only for slugs the config marks exact, and Check for every other configured slug", () => {
    const entries = Object.entries(PROFILES.ice.themeSlugs);
    expect(entries.length).toBeGreaterThan(3);
    for (const [slug, cfg] of entries) {
      const f = themeFromIcePath(new URL(hub(slug)));
      expect(f.value).toBe(cfg.theme);
      expect(f.confidence).toBe(cfg.exact ? "high" : "low");
      if (!cfg.exact) {
        expect(f.evidence).toContain(`/cpd/${slug}/`);
        expect(f.evidence).toMatch(/Guessed from the web address/);
      }
    }
  });

  it("makes exactly the safety-risk slug High in the shipped config", () => {
    const exact = Object.entries(PROFILES.ice.themeSlugs).filter(([, c]) => c.exact).map(([s]) => s);
    expect(exact).toEqual(["safety-risk"]);
  });

  it("returns a theme name that is one of the ICE themes", () => {
    const all = [...PROFILES.ice.themes.mandatory, ...PROFILES.ice.themes.additional];
    for (const cfg of Object.values(PROFILES.ice.themeSlugs)) expect(all).toContain(cfg.theme);
  });

  it("ignores letter case and percent-encoding in the path", () => {
    expect(themeFromIcePath(new URL("https://knowledgehub.ice.org.uk/CPD/Safety-Risk/Some-Item/")).confidence).toBe("high");
    expect(themeFromIcePath(new URL("https://knowledgehub.ice.org.uk/cpd/safety%2Drisk/x/")).confidence).toBe("high");
  });

  it("finds /cpd/ anywhere in the path and does not need a trailing slash", () => {
    expect(themeFromIcePath(new URL("https://knowledgehub.ice.org.uk/library/cpd/ethics/x")).confidence).toBe("low");
    expect(themeFromIcePath(new URL("https://knowledgehub.ice.org.uk/cpd/safety-risk")).confidence).toBe("high");
  });

  it("gives no theme for an unknown slug, and says so", () => {
    const f = themeFromIcePath(new URL(hub("something-new")));
    expect(f.value).toBeNull();
    expect(f.confidence).toBe("missing");
    expect(f.evidence).toContain("/cpd/something-new/");
    expect(f.evidence).toMatch(/Please choose/);
  });

  it("gives no theme without a /cpd/ segment", () => {
    for (const u of [
      "https://knowledgehub.ice.org.uk/",
      "https://knowledgehub.ice.org.uk/library/safety-risk/x/",
      "https://knowledgehub.ice.org.uk/safety-risk/",
      "https://knowledgehub.ice.org.uk/cpdx/safety-risk/",
      "https://knowledgehub.ice.org.uk/page?cpd=safety-risk",
      "https://knowledgehub.ice.org.uk/page#/cpd/safety-risk/",
    ]) {
      const f = themeFromIcePath(new URL(u));
      expect(f.confidence).toBe("missing");
      expect(f.value).toBeNull();
    }
  });

  it("gives no theme when /cpd/ has nothing after it", () => {
    expect(themeFromIcePath(new URL("https://knowledgehub.ice.org.uk/cpd/")).confidence).toBe("missing");
    expect(themeFromIcePath(new URL("https://knowledgehub.ice.org.uk/cpd")).confidence).toBe("missing");
  });

  it("does not treat a slug that only contains an exact one as exact", () => {
    for (const slug of ["safety-risk-extra", "safety", "risk", "safety_risk", "xsafety-risk"]) {
      expect(themeFromIcePath(new URL(hub(slug))).confidence).toBe("missing");
    }
  });

  it("does not read object prototype members as slugs", () => {
    for (const slug of ["constructor", "__proto__", "toString", "hasOwnProperty", "valueOf", "prototype"]) {
      const f = themeFromIcePath(new URL(hub(slug)));
      expect(f.confidence).toBe("missing");
      expect(f.value).toBeNull();
    }
  });
});

describe("ice-hub adapter: Duration label shapes", () => {
  const withDuration = (inner: string) => `<html><body><main><h1>An item</h1>${inner}</main></body></html>`;
  const minutes = (inner: string) => run(hub("safety-risk"), withDuration(inner)).durationMinutes;

  it.each([
    ["<p>Duration 15m</p>", 15],
    ["<p>Duration: 45 mins</p>", 45],
    ["<p>Duration 1h 30m</p>", 90],
    ["<p>Duration: 1h30m</p>", 90],
    ["<p>Duration 2 hours</p>", 120],
    ["<p>Duration - 1 hour 15 minutes</p>", 75],
    ["<dl><dt>Duration</dt><dd>20m</dd></dl>", 20],
    ["<div>Duration</div><div>25m</div>", 25],
    ["<span class='duration'>12m</span>", 12],
    ["<span class='resource-duration'>Duration 8m</span>", 8],
    ["<p>duration 5m</p>", 5],
  ])("reads %s", (inner, expected) => {
    const f = minutes(inner);
    expect(f.value).toBe(expected);
    expect(f.confidence).toBe("high");
    expect(f.evidence).toMatch(/^The page says /);
  });

  it.each([
    ["<p>The duration of the project was 3 months.</p>"],
    ["<p>Duration</p>"],
    ["<p>Duration: unknown</p>"],
    ["<p>Duration 0m</p>"],
    ["<p>Estimated reading 15m</p>"],
    ["<span class='duration'>00:00</span>"],
    ["<span class='duration'>3:45</span>"],
    ["<p>Durations vary 15m</p>"],
  ])("does not read a length from %s", (inner) => {
    const f = minutes(inner);
    expect(f.value).toBeNull();
    expect(f.confidence).toBe("missing");
  });
});

describe("ice-hub adapter: content type", () => {
  const typeOf = (label: string) => run(hub("safety-risk"), `<main><h1>Item</h1><span class="content-type">${label}</span></main>`).sourceType;

  it.each([
    ["Explainer", "article"],
    ["Guide", "document"],
    ["Case study", "article"],
    ["Webinar", "webinar"],
    ["On demand webinar", "webinar"],
    ["Video", "video"],
    ["Report", "document"],
    ["Technical briefing", "document"],
    ["Podcast", "other"],
    ["Event", "live_event"],
    ["Article", "article"],
  ] as const)("maps %s to %s with High confidence", (label, expected) => {
    const f = typeOf(label);
    expect(f.value).toBe(expected);
    expect(f.confidence).toBe("high");
    expect(f.evidence).toContain(label);
  });

  it("assumes an article, as Check, for a label it does not know, and says so", () => {
    const f = typeOf("Zorblax");
    expect(f).toMatchObject({ value: "article", confidence: "low" });
    expect(f.evidence).toContain("Zorblax");
    expect(f.evidence).toMatch(/do not recognise/);
  });

  it("assumes an article, as Check, when the page has no type label", () => {
    const f = run(hub("safety-risk"), "<main><h1>Item</h1><p>Text.</p></main>").sourceType;
    expect(f).toMatchObject({ value: "article", confidence: "low" });
    expect(f.evidence).toMatch(/does not say/);
  });

  it("reads a 'Content type:' label in the text", () => {
    const f = run(hub("safety-risk"), "<main><h1>Item</h1><p>Content type: Webinar Duration 30m</p></main>").sourceType;
    expect(f).toMatchObject({ value: "webinar", confidence: "high" });
  });

  it("reads a data attribute", () => {
    const f = run(hub("safety-risk"), '<main><h1>Item</h1><div data-content-type="Video"></div></main>').sourceType;
    expect(f).toMatchObject({ value: "video", confidence: "high" });
  });

  it("reads a plain badge placed just before the heading", () => {
    const badge = (inner: string) => run(hub("safety-risk"), `<main>${inner}<h1>Item</h1></main>`).sourceType;
    expect(badge('<span class="badge">Explainer</span>')).toMatchObject({ value: "article", confidence: "high" });
    expect(badge('<div class="tag"><span>Webinar</span></div>')).toMatchObject({ value: "webinar", confidence: "high" });
    expect(badge("<p>Case study</p>")).toMatchObject({ value: "article", confidence: "high" });
    // A word that is not a content type is not read as one.
    expect(badge("<span>Share</span>")).toMatchObject({ value: "article", confidence: "low" });
    expect(badge("<span>Read the explainer on safety and risk for new designers</span>").confidence).toBe("low");
  });

  it("reads a 'Type:' label in the text", () => {
    const f = run(hub("safety-risk"), "<main><h1>Item</h1><p>Type: Guide</p></main>").sourceType;
    expect(f).toMatchObject({ value: "document", confidence: "high" });
  });

  it("ignores an over-long type element", () => {
    const long = "word ".repeat(30);
    const f = typeOf(long);
    expect(f.confidence).toBe("low");
  });

  it("maps labels with mapContentType", () => {
    expect(mapContentType("Guidance note")).toBe("document");
    expect(mapContentType("???")).toBeNull();
  });
});

describe("ice-hub adapter: title and date", () => {
  it("ignores a logo heading that is only the site name and uses the title tag, as Check", () => {
    const r = run(hub("safety-risk"), "<html><head><title>Bearings in brief | ICE Knowledge Hub</title></head><body><h1>ICE Knowledge Hub</h1><p>Body</p></body></html>");
    expect(r.title.value).toBe("Bearings in brief");
    expect(r.title.confidence).toBe("low");
    expect(r.title.evidence).toMatch(/removed/);
  });

  it("does not return a title when the page has none", () => {
    const r = run(hub("safety-risk"), "<html><body><p>No title anywhere</p></body></html>");
    expect(r.title.confidence).toBe("missing");
    expect(r.title.value).toBeNull();
  });

  it("prefers machine-readable published dates", () => {
    const body = `<html><head><meta property="article:published_time" content="2024-12-01T10:00:00Z"></head><body><main><h1>X</h1><p>Published 5 May 2020</p></main></body></html>`;
    const r = run(hub("safety-risk"), body);
    expect(r.publishedAt.value).toBe("2024-12-01");
    expect(r.publishedAt.evidence).toMatch(/tags say/);
  });

  it("reads structured data dates", () => {
    const body = `<html><head><script type="application/ld+json">{"@type":"Article","headline":"Y","datePublished":"2023-03-04T09:00:00+00:00"}</script></head><body><h1>Y</h1></body></html>`;
    expect(run(hub("safety-risk"), body).publishedAt.value).toBe("2023-03-04");
  });

  it("reads a <time> tag that the page calls published", () => {
    const a = run(hub("safety-risk"), '<main><h1>X</h1><p><time class="published" datetime="2025-09-10T08:00:00Z">last Wednesday</time></p></main>');
    expect(a.publishedAt).toMatchObject({ value: "2025-09-10", confidence: "high" });
    const b = run(hub("safety-risk"), '<main><h1>X</h1><p>Published <time datetime="2025-09-11">yesterday</time></p></main>');
    expect(b.publishedAt).toMatchObject({ value: "2025-09-11", confidence: "high" });
    const c = run(hub("safety-risk"), '<main><h1>X</h1><p>Next session <time datetime="2027-09-11">soon</time></p></main>');
    expect(c.publishedAt.confidence).toBe("missing");
  });

  it("reads 'Published on 3 March 2026' and UK numeric dates, day first", () => {
    expect(run(hub("safety-risk"), "<main><h1>X</h1><p>Published on 3 March 2026</p></main>").publishedAt.value).toBe("2026-03-03");
    expect(run(hub("safety-risk"), "<main><h1>X</h1><p>Published: 04/03/2026</p></main>").publishedAt.value).toBe("2026-03-04");
  });

  it("does not take a date that is merely near the word published", () => {
    const r = run(hub("safety-risk"), "<main><h1>X</h1><p>Published by the ICE. Meeting on 4 March 2026.</p></main>");
    expect(r.publishedAt.confidence).toBe("missing");
  });
});

describe("ice-hub adapter: robustness", () => {
  it("copes with empty, broken and hostile HTML", () => {
    for (const body of ["", "   ", "<", "<<<>>>", "<h1>", "<script>alert(1)</script>", "\u0000\u0001", "<div".repeat(1000)]) {
      const r = run(hub("safety-risk"), body);
      expect(r.provider.confidence).toBe("high");
      expect(r.theme.confidence).toBe("high");
      expectWellFormed(r);
    }
  });

  it("still gives a theme when the URL cannot be parsed", () => {
    const r = run("not a url", "<h1>X</h1>");
    expect(r.theme.confidence).toBe("missing");
    expect(r.title.value).toBe("X");
  });

  it("is pure: the same input gives the same output", () => {
    const body = html("ice-hub-explainer.html");
    const u = "https://knowledgehub.ice.org.uk/cpd/safety-risk/principal-designer-role/";
    expect(run(u, body)).toEqual(run(u, body));
  });

  it("caps long text from the page", () => {
    const r = run(hub("safety-risk"), `<main><h1>${"Long ".repeat(500)}</h1></main>`);
    expect((r.title.value ?? "").length).toBeLessThanOrEqual(300);
  });
});

describe("ice-hub adapter: the Duration is this resource's own, not a related card's", () => {
  const withBody = (inner: string, aside = "") => `<html><body><main><article><h1>An item</h1>${inner}</article>${aside}</main></body></html>`;
  const minutes = (body: string) => run(hub("safety-risk"), body).durationMinutes;

  it("gives no length for an article with no Duration of its own and a related-resources card that has one (fixture)", () => {
    const r = run("https://knowledgehub.ice.org.uk/cpd/water/culvert-inspection-basics/", html("ice-hub-related-card.html"));
    expect(r.durationMinutes.value).toBeNull();
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.durationMinutes.evidence).toMatch(/no Duration label/);
    expect(r.durationMinutes.evidence).toMatch(/Please enter/);
    expect(r.title).toMatchObject({ value: "Culvert inspection basics", confidence: "high" });
    // The card's content type must not become this page's type either.
    expect(r.sourceType).toMatchObject({ value: "article", confidence: "high" });
    expectWellFormed(r);
  });
  it.each([
    ["an <aside>", '<aside><p>Duration 1h 30m</p></aside>'],
    ["a related block", '<div class="related-resources"><p>Duration 1h 30m</p></div>'],
    ["a card", '<div class="resource-card"><span class="duration">1h 30m</span></div>'],
    ["a featured block", '<div class="featured"><p>Duration 45m</p></div>'],
    ["a recommended block", '<section class="recommended"><p>Duration 45m</p></section>'],
    ["a similar-items block", '<div class="similar-items"><span class="duration">45m</span></div>'],
  ])("does not take the Duration in %s inside the article", (_name, block) => {
    const f = minutes(withBody(`<p>Some text.</p>${block}`));
    expect(f.value).toBeNull();
    expect(f.confidence).toBe("missing");
  });
  it("does not take a card's Duration from outside the article either", () => {
    const f = minutes(withBody("<p>Some text.</p>", '<aside class="related"><div class="card"><span class="duration">1h 30m</span></div></aside>'));
    expect(f.confidence).toBe("missing");
    const g = minutes(withBody("<p>Some text.</p>", '<div class="card"><p>Duration 20m</p></div>'));
    expect(g.confidence).toBe("missing");
  });
  it("takes the article's own Duration when a featured block with another one comes first", () => {
    const body = withBody('<div class="featured"><p>Duration 45m</p></div><dl><dt>Duration</dt><dd>15m</dd></dl><p>Text.</p>');
    expect(minutes(body)).toMatchObject({ value: 15, confidence: "high", evidence: "The page says Duration 15m." });
  });
  it("takes the article's own Duration when a card with a duration class comes first", () => {
    const body = withBody('<div class="card"><span class="duration">1h 30m</span></div><span class="duration">12m</span>');
    expect(minutes(body)).toMatchObject({ value: 12, confidence: "high" });
  });
  it("takes the article's own Duration, not a later one in the sidebar", () => {
    const body = withBody("<p>Duration 20m</p>", '<aside><p>Duration 60m</p></aside>');
    expect(minutes(body).value).toBe(20);
  });
  it("prefers the part of the page that holds the heading over an earlier mention elsewhere on the page", () => {
    const body = '<html><body><div class="banner"><p>Duration 99m</p></div><main><article><h1>An item</h1><p>Duration 10m</p></article></main></body></html>';
    expect(minutes(body)).toMatchObject({ value: 10, confidence: "high" });
  });
});

describe("ice-hub adapter: a Duration outside <main>", () => {
  const url = hub("safety-risk");
  it("reads a Duration in a banner above <main> as Check, and says where it was", () => {
    const body = "<html><body><header><h2>Resource</h2><p>Duration 20m</p></header><main><article><h1>An item</h1><p>Text.</p></article></main></body></html>";
    const f = run(url, body).durationMinutes;
    expect(f).toMatchObject({ value: 20, confidence: "low" });
    expect(f.evidence).toMatch(/Duration 20m/);
    expect(f.evidence).toMatch(/not in the main part of the page/);
    expect(f.evidence).toMatch(/Check it/);
  });
  it("reads a banner's duration class as Check too", () => {
    const body = "<html><body><div class='hero'><span class='duration'>1h</span></div><main><h1>An item</h1></main></body></html>";
    expect(run(url, body).durationMinutes).toMatchObject({ value: 60, confidence: "low" });
  });
  it("does not read one from the navigation or footer", () => {
    const body = "<html><body><nav><p>Duration 20m</p></nav><main><h1>An item</h1></main><footer><p>Duration 30m</p></footer></body></html>";
    expect(run(url, body).durationMinutes.confidence).toBe("missing");
  });
  it("says there is no Duration label we could find, and not that the page has none, when it finds nothing", () => {
    const f = run(url, "<main><h1>An item</h1><p>Text</p></main>").durationMinutes;
    expect(f.confidence).toBe("missing");
    expect(f.evidence).toMatch(/^We could not read a length/);
    expect(f.evidence).toMatch(/no Duration label/);
  });
  it("a Duration with no heading on the page is still read from the page", () => {
    expect(run(url, "<html><body><p>Duration 7m</p></body></html>").durationMinutes).toMatchObject({ value: 7, confidence: "high" });
  });
});

describe("ice-hub adapter: a Duration that cannot be right", () => {
  const minutes = (inner: string) => run(hub("safety-risk"), `<main><h1>An item</h1>${inner}</main>`).durationMinutes;
  it("refuses 99999 hours and says why", () => {
    const f = minutes("<p>Duration 99999h</p>");
    expect(f.value).toBeNull();
    expect(f.confidence).toBe("missing");
    expect(f.evidence).toMatch(/more than 40 hours/);
    expect(f.evidence).toMatch(/Please enter/);
    expect(minutes("<span class='duration'>99999h</span>").value).toBeNull();
  });
  it("accepts exactly 40 hours and refuses one minute more", () => {
    expect(minutes("<p>Duration 40h</p>")).toMatchObject({ value: 2400, confidence: "high" });
    expect(minutes("<p>Duration 40 hours</p>").value).toBe(2400);
    expect(minutes("<p>Duration 40h 1m</p>").value).toBeNull();
    expect(minutes("<p>Duration 2401 minutes</p>").value).toBeNull();
    expect(minutes("<p>Duration 41h</p>").evidence).toMatch(/more than 40 hours/);
  });
  it("uses a later sensible Duration when an earlier one is absurd", () => {
    expect(minutes("<p>Duration 99999h</p><p>Duration 15m</p>")).toMatchObject({ value: 15, confidence: "high" });
  });
});
