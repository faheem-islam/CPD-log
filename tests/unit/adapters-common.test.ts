import { describe, expect, it } from "vitest";
import {
  DEFAULT_MISSING_EVIDENCE, MAX_HTML_CHARS, MAX_TEXT_CHARS, TITLE_MATCH_THRESHOLD, attempt, cleanText, clip, contentText, emptyResult,
  field, findDates, findLabelledDate, findTimeRanges, hostMatches, isFound, loadDoc, measureText, missing, normSpace, pathSegments, quote,
  safeUrl, textOf, titlesPlausiblyMatch, wideText, withParsedPage,
} from "@/lib/adapters/common";
import { MAX_NESTING_DEPTH, htmlNestingDepth, isTooDeeplyNested } from "@/lib/adapters/nesting";
import { MERGED_FIELD_KEYS } from "@/lib/adapters/merge";

describe("field, missing and emptyResult", () => {
  it("build fields in the agreed shape", () => {
    expect(field(5, "high", "ev")).toEqual({ value: 5, confidence: "high", evidence: "ev" });
    expect(missing("none")).toEqual({ value: null, confidence: "missing", evidence: "none" });
  });
  it("isFound is false for missing and for empty values", () => {
    expect(isFound(field("x", "low", "ev"))).toBe(true);
    expect(isFound(missing("ev"))).toBe(false);
    expect(isFound({ value: null, confidence: "high", evidence: "bad" })).toBe(false);
  });
  it("emptyResult has every field missing with plain evidence and no flags", () => {
    const r = emptyResult("x");
    expect(r.adapter).toBe("x");
    for (const k of MERGED_FIELD_KEYS) {
      expect(r[k].confidence).toBe("missing");
      expect(r[k].value).toBeNull();
      expect(r[k].evidence).toBe(DEFAULT_MISSING_EVIDENCE[k]);
    }
    expect(r.flags).toEqual({ upcoming: false, recording: false });
    expect(r.notes).toEqual([]);
  });
  it("emptyResult returns a fresh object each time", () => {
    const a = emptyResult("a");
    a.notes.push("x");
    a.flags.upcoming = true;
    expect(emptyResult("b").notes).toEqual([]);
    expect(emptyResult("b").flags.upcoming).toBe(false);
  });
  it("default missing evidence says what to do and uses no jargon", () => {
    for (const text of Object.values(DEFAULT_MISSING_EVIDENCE)) {
      expect(text.length).toBeGreaterThan(15);
      expect(text).not.toMatch(/\bnull\b|undefined|low confidence/i);
    }
  });
});

describe("text cleaning", () => {
  it("collapses all kinds of space, including no-break and zero-width", () => {
    expect(normSpace("  a    b\t\nc​d  ")).toBe("a b c d");
    expect(normSpace("a‍b")).toBe("ab");
    expect(normSpace("﻿hello")).toBe("hello");
  });
  it("clips with an ellipsis and leaves short text alone", () => {
    expect(clip("abcdef", 6)).toBe("abcdef");
    expect(clip("abcdefg", 6)).toBe("abcde…");
    expect(clip("", 3)).toBe("");
  });
  it("removes control characters but keeps tabs and newlines as spaces", () => {
    expect(cleanText("a\u0000b\u0007c\u001fd\u007fe")).toBe("a b c d e");
    expect(cleanText("a\tb\nc")).toBe("a b c");
  });
  it("caps text and quotes", () => {
    expect(cleanText("x".repeat(1000)).length).toBe(300);
    expect(cleanText("x".repeat(1000), 10).length).toBe(10);
    expect(quote("y".repeat(500)).length).toBeLessThanOrEqual(80);
    expect(quote("  plain   words ")).toBe("plain words");
  });
});

describe("hostMatches, pathSegments and safeUrl", () => {
  it("matches the domain and www, and subdomains only when allowed", () => {
    expect(hostMatches("ice.org.uk", "ice.org.uk", false)).toBe(true);
    expect(hostMatches("www.ice.org.uk", "ice.org.uk", false)).toBe(true);
    expect(hostMatches("WWW.ICE.ORG.UK", "ice.org.uk", false)).toBe(true);
    expect(hostMatches("ice.org.uk.", "ice.org.uk", false)).toBe(true);
    expect(hostMatches("a.ice.org.uk", "ice.org.uk", false)).toBe(false);
    expect(hostMatches("a.ice.org.uk", "ice.org.uk", true)).toBe(true);
  });
  it("does not match look-alikes, even when subdomains are allowed", () => {
    for (const host of ["evilice.org.uk", "ice.org.uk.evil.example", "ice-org.uk", "xice.org.uk", "ice.org.ukx", "org.uk", ""]) {
      expect(hostMatches(host, "ice.org.uk", true)).toBe(false);
    }
  });
  it("splits and decodes path segments, and survives bad encoding", () => {
    expect(pathSegments(new URL("https://x.com/a/b%20c//d/"))).toEqual(["a", "b c", "d"]);
    expect(pathSegments(new URL("https://x.com/%E0%A4%A/ok"))).toEqual(["%E0%A4%A", "ok"]);
    expect(pathSegments(new URL("https://x.com/"))).toEqual([]);
  });
  it("safeUrl returns null instead of throwing", () => {
    expect(safeUrl("https://x.com/a")?.hostname).toBe("x.com");
    expect(safeUrl("not a url")).toBeNull();
    expect(safeUrl("")).toBeNull();
  });
});

describe("findLabelledDate", () => {
  it("reads a date straight after the label, with a colon, dash or none", () => {
    expect(findLabelledDate("Published 4 March 2026", ["Published"])?.iso).toBe("2026-03-04");
    expect(findLabelledDate("Published: 4 March 2026", ["Published"])?.iso).toBe("2026-03-04");
    expect(findLabelledDate("Published - 04/03/2026", ["Published"])?.iso).toBe("2026-03-04");
    expect(findLabelledDate("Published on 4 March 2026", ["Published"])?.iso).toBe("2026-03-04");
    expect(findLabelledDate("published 2026-03-04T10:00:00Z", ["Published"])?.iso).toBe("2026-03-04");
  });
  it("allows a weekday between the label and the date", () => {
    expect(findLabelledDate("Date: Wednesday 4 March 2026", ["Date"])?.iso).toBe("2026-03-04");
    expect(findLabelledDate("Date Wed, 4 March 2026", ["Date"])?.iso).toBe("2026-03-04");
  });
  it("does not take a date that only appears later in the same sentence", () => {
    expect(findLabelledDate("Published by the ICE, see 4 March 2026", ["Published"])).toBeNull();
    expect(findLabelledDate("Date of the meeting was 4 March 2026", ["Date"])).toBeNull();
  });
  it("does not match inside another word", () => {
    expect(findLabelledDate("Unpublished 4 March 2026", ["Published"])).toBeNull();
    expect(findLabelledDate("Update 4 March 2026", ["Date"])).toBeNull();
  });
  it("prefers the longer label and finds a later match when the first has no date", () => {
    expect(findLabelledDate("First published 4 March 2026", ["Published", "First published"])?.raw).toBe("First published 4 March 2026");
    expect(findLabelledDate("Published soon. Published 5 May 2026", ["Published"])?.iso).toBe("2026-05-05");
  });
  it("skips a label that follows a stop word, and does nothing with no labels", () => {
    expect(findLabelledDate("Published date: 4 March 2026", ["Date"], /published\s*$/i)).toBeNull();
    expect(findLabelledDate("Published 4 March 2026", [])).toBeNull();
  });
  it("rejects impossible dates", () => {
    expect(findLabelledDate("Published 31 February 2026", ["Published"])).toBeNull();
    expect(findLabelledDate("Published 31/02/2026", ["Published"])).toBeNull();
  });
});

describe("findDates", () => {
  it("handles every written shape and ranges", () => {
    const text = "1) 4th March 2026 2) March 4, 2026 3) 4-6 March 2026 4) 04.03.26 5) 2026-03-04 6) 4 Sept 2026 7) 3 of May 2026";
    expect(findDates(text).map((d) => d.iso)).toEqual([
      "2026-03-04", "2026-03-04", "2026-03-04", "2026-03-04", "2026-03-04", "2026-09-04", "2026-05-03",
    ]);
  });
  it("caps how many it returns", () => {
    expect(findDates("4 March 2026 ".repeat(500), 5)).toHaveLength(5);
  });
  it("finds nothing in empty or date-free text", () => {
    expect(findDates("")).toEqual([]);
    expect(findDates("no dates here, only 2026 and March")).toEqual([]);
  });
});

describe("textOf and contentText", () => {
  it("can be limited to one element and can skip parts of it", () => {
    const doc = loadDoc("<body><div id='a'><p>One</p><p class='skip'>Two</p><p>Three</p></div><div id='b'>Four</div></body>");
    expect(textOf(doc, doc("#a"))).toBe("One Two Three");
    expect(textOf(doc, doc("#a"), ".skip")).toBe("One Three");
    expect(textOf(doc, doc("#b"))).toBe("Four");
  });
  it("does not skip the element it was asked to read, even if it matches the skip selector", () => {
    const doc = loadDoc("<body class='menu-open'><p>Kept</p></body>");
    expect(textOf(doc, doc("body"), "[class*='menu']")).toBe("Kept");
  });
  it("reads a fragment with no body and a document with no content", () => {
    expect(textOf(loadDoc("<p>Hi <b>there</b></p>"))).toBe("Hi there");
    expect(textOf(loadDoc(""))).toBe("");
  });
  it("leaves comments, scripts, styles, svg, iframes and noscript out", () => {
    const doc = loadDoc("<body>A<!-- hidden --><script>var a=1</script><style>p{}</style><svg><text>svgtext</text></svg><iframe>frame</iframe><noscript>nojs</noscript>B</body>");
    expect(textOf(doc)).toBe("AB");
  });
  it("caps the length of what it returns", () => {
    const doc = loadDoc(`<body>${"<p>0123456789</p>".repeat(100000)}</body>`);
    expect(textOf(doc).length).toBeLessThanOrEqual(MAX_TEXT_CHARS);
  });
  it("is linear on a page with a huge number of sibling elements (no quadratic DOM edits)", () => {
    const doc = loadDoc(`<body>${"<p>Some text here.</p>".repeat(100000)}</body>`);
    const started = Date.now();
    const text = contentText(doc);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(text.startsWith("Some text here. Some text here.")).toBe(true);
  });
  it("contentText prefers <main>, otherwise the body without navigation and footers", () => {
    const withMain = loadDoc("<body><nav>Menu</nav><main><p>Main text</p></main><footer>Foot</footer></body>");
    expect(contentText(withMain)).toBe("Main text");
    const noMain = loadDoc("<body><nav>Menu</nav><div>Body text</div><footer>Foot</footer><div role='navigation'>More menu</div></body>");
    expect(contentText(noMain)).toBe("Body text");
  });
  it("does not change the document it reads", () => {
    const doc = loadDoc("<body><p>A</p><p>B</p></body>");
    const before = doc.html();
    textOf(doc);
    contentText(doc);
    expect(doc.html()).toBe(before);
  });
});

describe("invisible and direction-changing characters in page text", () => {
  it("removes bidi overrides, embeddings, isolates, marks and the word joiner", () => {
    expect(cleanText("Invoice \u202Etxt.exe\u2066 test")).toBe("Invoice txt.exe test");
    expect(normSpace("a\u202Ab\u202Bc\u202Cd\u202De\u202Ef")).toBe("abcdef");
    expect(normSpace("a\u2066b\u2067c\u2068d\u2069e")).toBe("abcde");
    expect(normSpace("a\u200Eb\u200Fc\u2060d")).toBe("abcd");
    expect(quote("Pay \u202Efdp.exe now")).toBe("Pay fdp.exe now");
  });
  it("keeps the existing handling of zero-width spaces and joiners", () => {
    expect(normSpace("a\u200Bb")).toBe("a b");
    expect(normSpace("a\u200Cb")).toBe("a b");
    expect(normSpace("a\u200Db")).toBe("ab");
  });
  it("leaves ordinary text, accents and other scripts alone", () => {
    expect(cleanText("Café Zürich – 日本語 العربية")).toBe("Café Zürich – 日本語 العربية");
  });
});

describe("titlesPlausiblyMatch", () => {
  it("measures the overlap against the longer title, at exactly the threshold", () => {
    expect(TITLE_MATCH_THRESHOLD).toBe(0.6);
    // 3 of 5 words shared: 0.6, which is enough.
    expect(titlesPlausiblyMatch("alpha beta gamma delta epsilon", "alpha beta gamma zeta eta")).toBe(true);
    // 2 of 5 words shared: 0.4, which is not.
    expect(titlesPlausiblyMatch("alpha beta gamma delta epsilon", "alpha beta zeta eta theta")).toBe(false);
    // 3 of 6: 0.5.
    expect(titlesPlausiblyMatch("alpha beta gamma", "alpha beta gamma delta epsilon zeta")).toBe(false);
  });
  it("is symmetric", () => {
    expect(titlesPlausiblyMatch("Safe lifting", "Safe lifting | ICE")).toBe(titlesPlausiblyMatch("Safe lifting | ICE", "Safe lifting"));
    expect(titlesPlausiblyMatch("alpha beta gamma", "alpha beta gamma delta epsilon zeta"))
      .toBe(titlesPlausiblyMatch("alpha beta gamma delta epsilon zeta", "alpha beta gamma"));
  });
  it("does not match a short site name to a title that ends with it", () => {
    expect(titlesPlausiblyMatch("Example Civils", "Notes on drainage design | Example Civils")).toBe(false);
    expect(titlesPlausiblyMatch("Notes on drainage design | Example Civils", "Example Civils")).toBe(false);
    expect(titlesPlausiblyMatch("Notes on drainage design", "Notes on drainage design | Example Civils")).toBe(true);
  });
});

describe("time ranges: am and pm are whole words", () => {
  const ranges = (text: string) => findTimeRanges(text).map((r) => r.raw);
  it("does not read '2-3 amendments' or '10-11 amazing' as times", () => {
    expect(ranges("We cover 2-3 amendments to the Act and 10-11 amazing speakers")).toEqual([]);
    expect(ranges("Open 9-5 pmo")).toEqual([]);
    expect(ranges("From 6-7 pmbok chapters")).toEqual([]);
  });
  it("still reads real am and pm ranges, with a full stop, comma, bracket or end of text after them", () => {
    expect(ranges("Join us 10-11am.")).toEqual(["10-11am"]);
    expect(ranges("Join us 10-11 am, then lunch")).toEqual(["10-11 am"]);
    expect(ranges("(6pm to 7:30pm)")).toEqual(["6pm to 7:30pm"]);
    expect(ranges("2-3pm")).toEqual(["2-3pm"]);
    expect(ranges("6pm - 7pm GMT")).toEqual(["6pm - 7pm GMT"]);
    expect(findTimeRanges("10-11am")[0]?.minutes).toBe(60);
  });
  it("still reads 24-hour ranges, also when a unit follows", () => {
    expect(ranges("18:00-19:00")).toEqual(["18:00-19:00"]);
    expect(ranges("18:00-19:00hrs")).toEqual(["18:00-19:00"]);
    expect(ranges("18:00-19:00 pmo")).toEqual(["18:00-19:00"]);
  });
});

describe("htmlNestingDepth", () => {
  const rep = (s: string, n: number) => s.repeat(n);

  it("counts plain nesting and ignores siblings", () => {
    expect(htmlNestingDepth("<div><p>a</p><p>b</p></div>")).toBe(2);
    expect(htmlNestingDepth("<html><body><main><article><section><p>x</p></section></article></main></body></html>")).toBe(6);
    expect(htmlNestingDepth("")).toBe(0);
    expect(htmlNestingDepth("just text")).toBe(0);
  });
  it("counts a deep page and stops early once it is past the limit", () => {
    expect(htmlNestingDepth(rep("<div>", 1000), 1_000_000)).toBe(1000);
    expect(htmlNestingDepth(rep("<div>", 1000), 50)).toBe(51);
    expect(isTooDeeplyNested(rep("<div>", MAX_NESTING_DEPTH + 1))).toBe(true);
    expect(isTooDeeplyNested(rep("<div>", MAX_NESTING_DEPTH))).toBe(false);
    expect(MAX_NESTING_DEPTH).toBeLessThanOrEqual(256);
  });
  it("does not count void elements, comments, doctypes, scripts, styles or text that looks like tags", () => {
    expect(htmlNestingDepth(`<!doctype html>${rep("<br><img src=x><hr><input><meta><link>", 2000)}`)).toBe(0);
    expect(htmlNestingDepth(rep("<!-- <div><div><div> -->", 2000))).toBe(0);
    expect(htmlNestingDepth(`<script>${rep("document.write('<div>');", 2000)}</script>`)).toBe(0);
    expect(htmlNestingDepth(`<style>${rep("a::before{content:'<div>'}", 500)}</style><p>x</p>`)).toBe(1);
    expect(htmlNestingDepth(`<noscript>${rep("<div>", 2000)}</noscript>`)).toBe(0);
    expect(htmlNestingDepth(`<textarea>${rep("<div>", 2000)}</textarea>`)).toBe(0);
    expect(htmlNestingDepth(`<title>${rep("<div>", 2000)}</title>`)).toBe(0);
    expect(htmlNestingDepth(`a < b and c <3 ${rep("1 < 2 ", 100)}`)).toBe(0);
    expect(htmlNestingDepth("<![CDATA[ text ]]><?xml version='1.0' ?><p>x</p>")).toBe(1);
  });
  it("is not fooled by a '>' inside a quoted attribute value", () => {
    expect(htmlNestingDepth(rep('<div title=">">', 600), 1_000_000)).toBe(600);
    expect(htmlNestingDepth(rep("<div title='>' data-x=\"a>b\">", 600), 1_000_000)).toBe(600);
  });
  it("does not read markup that sits inside a quoted attribute value as tags", () => {
    expect(htmlNestingDepth(rep('<a title="1 > <div><div><div>">x</a>', 400), 1_000_000)).toBe(1);
    expect(htmlNestingDepth(rep("<a data-x='<div><div>' href=\"/a\">x</a>", 400), 1_000_000)).toBe(1);
    // A quote that never closes swallows the rest of the page, like the parser does, and costs one pass.
    expect(htmlNestingDepth(`<a title="${rep("<div>", 5000)}`, 1_000_000)).toBe(0);
  });
  it("counts uppercase tags and a '/>' on an ordinary element, which HTML does not treat as closed", () => {
    expect(htmlNestingDepth(rep("<DIV>", 600), 1_000_000)).toBe(600);
    expect(htmlNestingDepth(rep("<div/>", 600), 1_000_000)).toBe(600);
    expect(htmlNestingDepth(rep("<span />", 600), 1_000_000)).toBe(600);
  });
  it("does not count a '/>' inside svg, where it does close the element", () => {
    expect(htmlNestingDepth(`<svg>${rep('<path d="M0 0"/><circle r="1" />', 5000)}</svg>`)).toBe(1);
    expect(htmlNestingDepth(`<svg/>${rep("<p>x</p>", 10)}`)).toBe(1);
  });
  it("counts what is nested again inside svg's HTML parts, and a slash that is part of an unquoted value", () => {
    expect(htmlNestingDepth(`<svg>${rep("<foreignObject><div/>", 400)}`, 1_000_000)).toBeGreaterThanOrEqual(800);
    expect(htmlNestingDepth(`<svg>${rep("<g class=a/>", 600)}`, 1_000_000)).toBeGreaterThanOrEqual(600);
  });
  it("does not count unclosed list items, paragraphs, cells, options or definitions that the parser closes itself", () => {
    expect(htmlNestingDepth(`<ul>${rep("<li>item", 5000)}</ul>`)).toBe(2);
    expect(htmlNestingDepth(`<div>${rep("<p>text", 5000)}</div>`)).toBe(2);
    expect(htmlNestingDepth(`<table>${rep("<tr><td>a<td>b", 3000)}</table>`)).toBeLessThanOrEqual(4);
    expect(htmlNestingDepth(`<select>${rep("<option>a", 5000)}</select>`)).toBe(2);
    expect(htmlNestingDepth(`<dl>${rep("<dt>a<dd>b", 3000)}</dl>`)).toBe(2);
    expect(htmlNestingDepth(rep("<h1>a<h2>b<h3>c", 2000))).toBe(1);
    expect(htmlNestingDepth(rep("<a href=x>link", 5000))).toBe(1);
  });
  it("does not let end tags that the parser ignores hide the depth", () => {
    const evasions: [string, string][] = [
      ["a span closed across a div", "<span><div></span>"],
      ["a list item closed across a list", "<li><ul></li>"],
      ["a div closed across a table cell", "<div><table><tr><td></div>"],
      ["a bold closed across a div", "<b><div></b>"],
      ["a paragraph and a div", "<p><div>"],
      ["a nest of tables", "<table><tr><td>"],
      ["a nest of lists", "<ul><li>"],
      ["a nest of definitions", "<dl><dd><dl>"],
      ["an end tag for something that is not open", "<div></section>"],
    ];
    for (const [, unit] of evasions) {
      expect(htmlNestingDepth(`<html><body>${rep(unit, 1500)}`, 1_000_000)).toBeGreaterThan(MAX_NESTING_DEPTH);
    }
  });
  it("is linear: a 1 MB page of hostile tags is read in well under a second", () => {
    const started = Date.now();
    htmlNestingDepth(`${rep("<div>", 250)}${rep("</span>", 100_000)}${rep("<p>", 100_000)}${rep("<li>", 100_000)}`, MAX_NESTING_DEPTH);
    htmlNestingDepth(rep("<a<a<a", 150_000), MAX_NESTING_DEPTH);
    htmlNestingDepth(rep('<a b="', 100_000), MAX_NESTING_DEPTH);
    htmlNestingDepth(rep("<!--", 200_000), MAX_NESTING_DEPTH);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe("loadDoc: deep and long pages", () => {
  it("reads a page nested absurdly deep as an empty page, at once, instead of parsing it", () => {
    const started = Date.now();
    const doc = loadDoc(`<html><head><title>Deep</title></head><body><main>${"<div>".repeat(30_000)}x</main></body></html>`);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(doc("title").length).toBe(0);
    expect(contentText(doc)).toBe("");
  });
  it("still reads a deep but ordinary page", () => {
    const doc = loadDoc(`<html><head><title>Ok</title></head><body><main>${"<div>".repeat(100)}text${"</div>".repeat(100)}</main></body></html>`);
    expect(doc("title").text()).toBe("Ok");
    expect(contentText(doc)).toBe("text");
  });
  it("reads only the first part of a very long page", () => {
    expect(MAX_HTML_CHARS).toBeLessThanOrEqual(1_000_000);
    const doc = loadDoc(`<body>${"<p>some filler</p>".repeat(100_000)}<p id="late">late</p></body>`);
    expect(doc("#late").length).toBe(0);
    expect(doc("p").length).toBeGreaterThan(1000);
  });
});

describe("withParsedPage", () => {
  const page = "<html><head><title>One</title></head><body><p>Hello</p></body></html>";
  it("gives every loadDoc of the same page the same document, and only while it runs", () => {
    let first: unknown;
    let second: unknown;
    withParsedPage(page, () => {
      first = loadDoc(page);
      second = loadDoc(page);
    });
    expect(first).toBe(second);
    expect(loadDoc(page)).not.toBe(first);
  });
  it("does not hand its document to a different page", () => {
    withParsedPage(page, () => {
      expect(loadDoc("<p>Other</p>")("p").text()).toBe("Other");
    });
  });
  it("puts things back when the work throws, and can be nested", () => {
    expect(() => withParsedPage(page, () => {
      throw new Error("boom");
    })).toThrow("boom");
    const outside = loadDoc(page);
    withParsedPage(page, () => {
      const outer = loadDoc(page);
      withParsedPage("<p>inner</p>", () => {
        expect(loadDoc("<p>inner</p>")("p").text()).toBe("inner");
      });
      expect(loadDoc(page)).toBe(outer);
    });
    expect(loadDoc(page)).not.toBe(outside);
  });
  it("returns what the work returns, and a deep page is shared as an empty page", () => {
    expect(withParsedPage(page, () => 42)).toBe(42);
    const deep = `<body>${"<div>".repeat(5000)}</body>`;
    withParsedPage(deep, () => expect(loadDoc(deep)("div").length).toBe(0));
  });
});

describe("attempt", () => {
  it("returns the result, or the fallback when the step throws", () => {
    expect(attempt(() => 5, 0)).toBe(5);
    expect(attempt(() => {
      throw new Error("x");
    }, "fallback")).toBe("fallback");
  });
});

describe("measureText and wideText", () => {
  it("says when the text was cut short, and not when it was not", () => {
    const doc = loadDoc(`<body>${"<p>0123456789</p>".repeat(1000)}</body>`);
    const small = measureText(doc, undefined, undefined, 100);
    expect(small.truncated).toBe(true);
    expect(small.text.length).toBe(100);
    const all = measureText(doc, undefined, undefined, 1_000_000);
    expect(all.truncated).toBe(false);
    expect(all.text.length).toBe(1000 * 11 - 1);
    expect(measureText(loadDoc("<p>short</p>")).truncated).toBe(false);
  });
  it("counts a long document in full when asked for a larger limit than the usual cap", () => {
    const doc = loadDoc(`<body>${"<p>alpha beta gamma delta</p>".repeat(30_000)}</body>`);
    expect(measureText(doc).truncated).toBe(true);
    expect(measureText(doc).text.length).toBe(MAX_TEXT_CHARS);
    const full = measureText(doc, undefined, undefined, 4_000_000);
    expect(full.truncated).toBe(false);
    expect(full.text.split(" ").length).toBe(120_000);
  });
  it("wideText reads a banner outside <main>, but not navigation, footers or sidebars", () => {
    const doc = loadDoc(
      "<body><nav>Menu</nav><header><p>Banner Date: 4 March 2027</p></header><main><p>Main text</p></main><aside>Side</aside><footer>Foot</footer><div role='navigation'>More menu</div></body>",
    );
    expect(contentText(doc)).toBe("Main text");
    expect(wideText(doc)).toBe("Banner Date: 4 March 2027 Main text");
  });
  it("keeps a space after a sub or sup only when text follows, and none before an element (H2O, 4th)", () => {
    expect(textOf(loadDoc("<p>H<sub>2</sub><b>O</b></p>"))).toBe("H2O");
    expect(textOf(loadDoc("<p>10<sup>2</sup><i>m</i> and 4<sup>th</sup> March</p>"))).toBe("102m and 4th March");
    expect(textOf(loadDoc("<p><span>a</span><span>b</span></p>"))).toBe("a b");
  });
});
