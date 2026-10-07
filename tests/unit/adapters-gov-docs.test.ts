import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { countAttachments, countWords, govDocsAdapter, govKindFor, LANDING_MAX_WORDS, LEGISLATION_PROVIDER, SFH_PROVIDER, WORDS_PER_MINUTE } from "@/lib/adapters/gov-docs";
import { loadDoc } from "@/lib/adapters/common";
import type { AdapterResult } from "@/lib/types";

const NOW = new Date("2026-10-07T09:00:00Z");
const html = (name: string): string => readFileSync(path.resolve(import.meta.dirname, "../fixtures/html", name), "utf8");
const run = (url: string, body: string): AdapterResult => govDocsAdapter.extract({ url, html: body, now: NOW });

const GOV = "https://www.gov.uk/guidance/some-guidance";
const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(" ");
const govPage = (inner: string, meta = "") =>
  `<html><head><title>A page - GOV.UK</title></head><body><main><h1>A page</h1>${meta}${inner}</main></body></html>`;
const pdfLinks = (n: number) => Array.from({ length: n }, (_, i) => `<a href="/media/file-${i}.pdf">File ${i}</a>`).join(" ");

function expectWellFormed(r: AdapterResult): void {
  for (const key of ["title", "provider", "sourceType", "theme", "durationMinutes", "publishedAt", "eventDate", "providerCpdHours"] as const) {
    const f = r[key];
    expect(f.evidence.length).toBeGreaterThan(5);
    expect(f.value === null).toBe(f.confidence === "missing");
  }
}

describe("gov-docs adapter: matching", () => {
  it.each([
    "https://www.gov.uk/guidance/x",
    "https://gov.uk/guidance/x",
    "https://www.legislation.gov.uk/uksi/2020/9999/regulation/3",
    "https://legislation.gov.uk/ukpga/1974/37/section/2",
    "https://www.standardsforhighways.co.uk/dmrb/search/abc",
    "https://standardsforhighways.co.uk/",
  ])("matches %s", (url) => {
    expect(govDocsAdapter.matches(new URL(url))).toBe(true);
  });
  it.each([
    "https://www.gov.uk.evil.example/guidance/x",
    "https://evilgov.uk/guidance/x",
    "https://assets.publishing.service.gov.uk/media/x.pdf",
    "https://www.nationalhighways.co.uk/",
    "https://standardsforhighways.co.uk.evil.example/",
    "https://example.com/www.gov.uk",
    "https://www.ice.org.uk/events/x",
  ])("does not match %s", (url) => {
    expect(govDocsAdapter.matches(new URL(url))).toBe(false);
  });
  it("tells the three sites apart", () => {
    expect(govKindFor(new URL("https://www.gov.uk/x"))).toBe("govuk");
    expect(govKindFor(new URL("https://www.legislation.gov.uk/x"))).toBe("legislation");
    expect(govKindFor(new URL("https://www.standardsforhighways.co.uk/x"))).toBe("sfh");
    expect(govKindFor(new URL("https://example.com/"))).toBeNull();
  });
  it("gives an empty result with a note for a URL that is not one of its sites", () => {
    const r = run("https://example.com/x", "<h1>X</h1>");
    expect(r.title.confidence).toBe("missing");
    expect(r.notes.length).toBe(1);
  });
});

describe("gov-docs adapter: a gov.uk landing page that only links to attachments", () => {
  const r = run("https://www.gov.uk/government/publications/traffic-signs-manual", html("govuk-publication-landing.html"));

  it("does not give a reading time and explains why", () => {
    expect(r.durationMinutes.value).toBeNull();
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.durationMinutes.evidence).toMatch(/landing page for a document/);
    expect(r.durationMinutes.evidence).toMatch(/links to 3 files/);
    expect(r.durationMinutes.evidence).toMatch(/cannot be read from this page/);
  });
  it("reads the title and publisher from the page", () => {
    expect(r.title).toMatchObject({ value: "Traffic Signs Manual", confidence: "high" });
    expect(r.provider).toMatchObject({ value: "Department for Transport", confidence: "high" });
    expect(r.provider.evidence).toMatch(/From:/);
  });
  it("calls it a document because of /government/publications/", () => {
    expect(r.sourceType).toMatchObject({ value: "document", confidence: "high" });
    expect(r.sourceType.evidence).toContain("/government/publications/");
  });
  it("puts first published in publishedAt and mentions last updated", () => {
    expect(r.publishedAt).toMatchObject({ value: "2024-05-14", confidence: "high" });
    expect(r.publishedAt.evidence).toContain("Published 14 May 2024");
    expect(r.publishedAt.evidence).toContain("last updated on 5 February 2026");
    expect(r.notes).toContain("Last updated 5 February 2026. The log uses the first published date.");
    expectWellFormed(r);
  });
});

describe("gov-docs adapter: a gov.uk HTML guidance page with a long body", () => {
  const r = run("https://www.gov.uk/guidance/planning-a-safe-roadworks-site-visit", html("govuk-guidance-html.html"));
  const body = loadDoc(html("govuk-guidance-html.html"))(".govspeak").text();

  it("estimates reading time from the words on the page, as an Estimate", () => {
    const n = countWords(body);
    expect(n).toBeGreaterThan(900);
    expect(r.durationMinutes.confidence).toBe("estimate");
    expect(r.durationMinutes.value).toBe(Math.max(1, Math.round(n / WORDS_PER_MINUTE)));
    expect(r.durationMinutes.value).toBe(5);
  });
  it("uses the agreed evidence wording", () => {
    expect(r.durationMinutes.evidence).toMatch(/^About \d+ words at 200 words a minute\. This estimates reading time, not learning time\.$/);
  });
  it("counts only the document text, not the contents list, metadata or print link", () => {
    const m = /About (\d+) words/.exec(r.durationMinutes.evidence);
    expect(Number(m?.[1])).toBe(countWords(body));
  });
  it("lists every organisation under From:", () => {
    expect(r.provider).toMatchObject({ value: "Department for Transport, National Highways", confidence: "high" });
  });
  it("treats guidance prose as an article, as Check", () => {
    expect(r.sourceType).toMatchObject({ value: "article", confidence: "low" });
  });
  it("reads dates and mentions last updated", () => {
    expect(r.publishedAt.value).toBe("2025-06-03");
    expect(r.publishedAt.evidence).toContain("21 January 2026");
    expectWellFormed(r);
  });
});

describe("gov-docs adapter: landing page versus full body", () => {
  it("a page with attachments and little text is a landing page", () => {
    const r = run(GOV, govPage(`<div class="govspeak"><p>${words(250)}</p></div><p>${pdfLinks(2)}</p>`));
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.durationMinutes.evidence).toMatch(/landing page/);
    expect(r.durationMinutes.evidence).toMatch(/2 files/);
  });
  it("says 'file' for one attachment", () => {
    const r = run(GOV, govPage(`<div class="govspeak"><p>${words(100)}</p></div>${pdfLinks(1)}`));
    expect(r.durationMinutes.evidence).toMatch(/links to 1 file and/);
  });
  it("the same short text with no attachments is an estimate", () => {
    const r = run(GOV, govPage(`<div class="govspeak"><p>${words(250)}</p></div>`));
    expect(r.durationMinutes).toMatchObject({ value: 1, confidence: "estimate" });
  });
  it("a long body with an attachment is still an estimate, from the body only", () => {
    const n = LANDING_MAX_WORDS + 200;
    const r = run(GOV, govPage(`<div class="govspeak"><p>${words(n)}</p></div>${pdfLinks(3)}`));
    expect(r.durationMinutes.confidence).toBe("estimate");
    expect(r.durationMinutes.value).toBe(Math.round(n / WORDS_PER_MINUTE));
    expect(r.durationMinutes.evidence).toContain(`About ${n} words`);
  });
  it("just under the landing-page limit with an attachment is still a landing page", () => {
    const r = run(GOV, govPage(`<div class="govspeak"><p>${words(LANDING_MAX_WORDS - 1)}</p></div>${pdfLinks(1)}`));
    expect(r.durationMinutes.confidence).toBe("missing");
  });
  it("never guesses a length from the number of files or their names", () => {
    const r = run(GOV, govPage(`<div class="govspeak"><p>${words(30)}</p></div><section class="attachment"><a href="/media/a-200-page-manual.pdf">A 200 page manual (PDF, 40 MB, 200 pages)</a></section>`));
    expect(r.durationMinutes.value).toBeNull();
  });
  it("a page with too little text and no attachments gives no reading time", () => {
    const r = run(GOV, govPage(`<div class="govspeak"><p>${words(20)}</p></div>`));
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.durationMinutes.evidence).toMatch(/too little text/);
  });
  it("a gov.uk page with no govspeak body gives no reading time rather than counting navigation", () => {
    const r = run(GOV, `<html><body><nav>${words(400)}</nav><main><h1>Browse</h1><ul>${"<li><a href='/x'>Item</a></li>".repeat(100)}</ul></main></body></html>`);
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.durationMinutes.evidence).toMatch(/could not find the main text/);
  });
  it("a gov.uk page with no .govspeak wrapper still counts running text in <main>, but not link lists", () => {
    const para = (n: number) => `<p>${words(n)}</p>`;
    const prose = run(GOV, `<html><body><main><h1>Guide</h1>${para(20).repeat(30)}</main></body></html>`);
    expect(prose.durationMinutes).toMatchObject({ value: 3, confidence: "estimate" });
    const tooFew = run(GOV, `<html><body><main><h1>Guide</h1>${para(40)}${para(40)}</main></body></html>`);
    expect(tooFew.durationMinutes.confidence).toBe("missing");
    const withFiles = run(GOV, `<html><body><main><h1>Guide</h1>${para(20).repeat(30)}${pdfLinks(2)}</main></body></html>`);
    expect(withFiles.durationMinutes.confidence).toBe("missing");
    expect(withFiles.durationMinutes.evidence).toMatch(/landing page/);
    const links = run(GOV, `<html><body><main><h1>Topic</h1><ul>${"<li><a href='/x'>A topic page link</a></li>".repeat(200)}</ul></main></body></html>`);
    expect(links.durationMinutes.confidence).toBe("missing");
  });
  it("does not count text in navigation, asides or footers of a gov.uk page", () => {
    const page = `<html><body><main><nav>${words(500)}</nav><aside>${words(500)}</aside><div class="govspeak"><p>${words(100)}</p></div></main></body></html>`;
    expect(run(GOV, page).durationMinutes.evidence).toContain("About 100 words");
  });
  it("is not hidden by a body class that happens to contain 'menu'", () => {
    const page = `<html><body class="menu-open"><main class="main-menu-layout"><div class="govspeak"><p>${words(300)}</p></div></main></body></html>`;
    expect(run(GOV, page).durationMinutes.evidence).toContain("About 300 words");
    const sfh = `<html><body class="menu-open"><main class="has-menu"><h1>X</h1><p>${words(300)}</p></main></body></html>`;
    expect(run("https://www.standardsforhighways.co.uk/x", sfh).durationMinutes.evidence).toContain("About 301 words");
  });
  it("rounds to the nearest minute with a minimum of one", () => {
    const at = (n: number) => run(GOV, govPage(`<div class="govspeak"><p>${words(n)}</p></div>`)).durationMinutes.value;
    expect(at(60)).toBe(1);
    expect(at(150)).toBe(1);
    expect(at(299)).toBe(1);
    expect(at(300)).toBe(2);
    expect(at(1000)).toBe(5);
    expect(at(2000)).toBe(10);
  });
  it("counts download links without a file extension, and the word Download", () => {
    const doc = (links: string) => loadDoc(`<body>${links}</body>`);
    expect(countAttachments(doc('<a href="/files/download">Download</a>'))).toBe(1);
    expect(countAttachments(doc('<a href="/x/doc.docx?dl=1">Doc</a><a href="/y.xlsx">Sheet</a>'))).toBe(2);
    expect(countAttachments(doc('<a href="/same.pdf">A</a><a href="/same.pdf">B</a>'))).toBe(1);
    expect(countAttachments(doc('<a href="/page.html">A</a>'))).toBe(0);
    expect(countAttachments(doc('<section class="attachment embedded"><h3>No link yet</h3></section>'))).toBe(1);
  });
});

describe("gov-docs adapter: legislation.gov.uk", () => {
  const r = run("https://www.legislation.gov.uk/uksi/2020/9999/regulation/3", html("legislation-section.html"));

  it("estimates reading time from a section page that holds the text", () => {
    expect(r.durationMinutes.confidence).toBe("estimate");
    expect(r.durationMinutes.value).toBe(2);
    expect(r.durationMinutes.evidence).toMatch(/^About \d+ words at 200 words a minute\./);
  });
  it("uses the fixed publisher and calls it a document", () => {
    expect(r.provider).toMatchObject({ value: LEGISLATION_PROVIDER, confidence: "high" });
    expect(LEGISLATION_PROVIDER).toBe("The National Archives (legislation.gov.uk)");
    expect(r.sourceType).toMatchObject({ value: "document", confidence: "high" });
  });
  it("reads the title from the heading", () => {
    expect(r.title).toMatchObject({ value: "The Example Highway Works Regulations 2020", confidence: "high" });
  });
  it("treats the made date as Check and says it is not the web publication date", () => {
    expect(r.publishedAt).toMatchObject({ value: "2020-02-12", confidence: "low" });
    expect(r.publishedAt.evidence).toMatch(/when the law was made, not when this web version was published/);
    expectWellFormed(r);
  });
  it("does not estimate from a contents page", () => {
    const page = `<html><body><div id="content"><h1>The Example Regulations 2020</h1><ol>${"<li><a href='#'>1. A long heading with several words in it for the list</a></li>".repeat(60)}</ol></div></body></html>`;
    const c = run("https://www.legislation.gov.uk/uksi/2020/9999/contents", page);
    expect(c.durationMinutes.confidence).toBe("missing");
    expect(c.durationMinutes.evidence).toMatch(/contents page/);
  });
  it("reads an enactment date", () => {
    const page = `<html><body><div id="content"><h1>The Example Act 2019</h1><p>Enactment Date 15 July 2019</p><p>${words(100)}</p></div></body></html>`;
    const a = run("https://www.legislation.gov.uk/ukpga/2019/1/section/1", page);
    expect(a.publishedAt).toMatchObject({ value: "2019-07-15", confidence: "low" });
  });
  it("prefers a machine-readable date when there is one, and keeps it High", () => {
    const page = `<html><head><meta name="DC.date.issued" content="2019-07-16"></head><body><div id="content"><h1>The Example Act 2019</h1><p>Made 15 July 2019</p><p>${words(100)}</p></div></body></html>`;
    const a = run("https://www.legislation.gov.uk/ukpga/2019/1/section/1", page);
    expect(a.publishedAt).toMatchObject({ value: "2019-07-16", confidence: "high" });
  });
});

describe("gov-docs adapter: Standards for Highways", () => {
  const r = run("https://www.standardsforhighways.co.uk/dmrb/search/00000000", html("sfh-page.html"));
  it("treats a page with a PDF download as a landing page", () => {
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.durationMinutes.evidence).toMatch(/landing page for a document/);
  });
  it("uses the fixed publisher and calls it a document", () => {
    expect(r.provider).toMatchObject({ value: SFH_PROVIDER, confidence: "high" });
    expect(SFH_PROVIDER).toBe("National Highways (Standards for Highways)");
    expect(r.sourceType).toMatchObject({ value: "document", confidence: "high" });
  });
  it("reads title and published date", () => {
    expect(r.title.value).toBe("CD 999 Example geometric design standard");
    expect(r.publishedAt).toMatchObject({ value: "2025-09-02", confidence: "high" });
    expectWellFormed(r);
  });
  it("calls a news page an article, as Check", () => {
    const n = run("https://www.standardsforhighways.co.uk/news/an-item", "<main><h1>News item</h1><p>Text.</p></main>");
    expect(n.sourceType).toMatchObject({ value: "article", confidence: "low" });
  });
  it("estimates a reading time for an HTML page with real text and no files", () => {
    const n = run("https://www.standardsforhighways.co.uk/about", `<main><h1>About</h1><p>${words(400)}</p></main>`);
    expect(n.durationMinutes).toMatchObject({ value: 2, confidence: "estimate" });
  });
});

describe("gov-docs adapter: publisher and dates on gov.uk", () => {
  it("falls back to GOV.UK, as Check, when there is no From line", () => {
    const r = run(GOV, govPage(`<div class="govspeak"><p>${words(100)}</p></div>`));
    expect(r.provider).toMatchObject({ value: "GOV.UK", confidence: "low" });
    expect(r.provider.evidence).toMatch(/no "From:" organisation/);
  });
  it("reads a From line in plain text", () => {
    const r = run(GOV, govPage(`<p>From: Department for Transport Published 3 June 2025</p><div class="govspeak"><p>${words(100)}</p></div>`));
    expect(r.provider).toMatchObject({ value: "Department for Transport", confidence: "high" });
  });
  it("reads From: when the organisation is not a link", () => {
    const r = run(GOV, govPage(`<dl><dt>From:</dt><dd>Office for Road Safety</dd></dl>`));
    expect(r.provider.value).toBe("Office for Road Safety");
  });
  it("does not duplicate an organisation named twice", () => {
    const r = run(GOV, govPage(`<dl><dt>From:</dt><dd><a href="/a">DfT</a> <a href="/a">DfT</a></dd></dl>`));
    expect(r.provider.value).toBe("DfT");
  });
  it("with only a last updated date, leaves published missing and says what was found", () => {
    const r = run(GOV, govPage(`<dl><dt>Last updated</dt><dd>5 February 2026</dd></dl>`));
    expect(r.publishedAt.confidence).toBe("missing");
    expect(r.publishedAt.evidence).toContain("5 February 2026");
    expect(r.notes.join(" ")).toContain("Last updated 5 February 2026");
  });
  it("does not mention last updated when it is the same day as published", () => {
    const r = run(GOV, govPage(`<dl><dt>Published</dt><dd>5 February 2026</dd><dt>Last updated</dt><dd>5 February 2026</dd></dl>`));
    expect(r.publishedAt.value).toBe("2026-02-05");
    expect(r.publishedAt.evidence).not.toMatch(/last updated/);
    expect(r.notes).toEqual([]);
  });
  it("reads 'First published' and UK numeric dates, day first", () => {
    const r = run(GOV, govPage(`<dl><dt>First published</dt><dd>04/03/2026</dd></dl>`));
    expect(r.publishedAt.value).toBe("2026-03-04");
  });
  it("reads a machine-readable published date", () => {
    const r = run(GOV, `<html><head><meta property="article:published_time" content="2025-01-02T10:00:00+00:00"></head><body><main><h1>X</h1></main></body></html>`);
    expect(r.publishedAt).toMatchObject({ value: "2025-01-02", confidence: "high" });
  });
  it("makes no published date from nothing", () => {
    const r = run(GOV, govPage("<p>No dates.</p>"));
    expect(r.publishedAt.confidence).toBe("missing");
  });
});

describe("gov-docs adapter: robustness", () => {
  it("copes with empty, broken and hostile HTML", () => {
    for (const body of ["", " ", "<", "<<<>>>", "<script>alert(1)</script>", "\u0000", "<div".repeat(2000)]) {
      for (const url of [GOV, "https://www.legislation.gov.uk/x/contents", "https://www.standardsforhighways.co.uk/x"]) {
        const r = run(url, body);
        expect(r.durationMinutes.confidence).toBe("missing");
        expect(r.provider.value).not.toBeNull();
        expectWellFormed(r);
      }
    }
  });
  it("countWords ignores punctuation-only tokens and counts numbers", () => {
    expect(countWords("a - b — 12 , . ! ?")).toBe(3);
    expect(countWords("")).toBe(0);
    expect(countWords("   ")).toBe(0);
  });
  it("stays fast on a very large body", () => {
    const started = Date.now();
    const r = run(GOV, govPage(`<div class="govspeak">${"<p>" + words(200) + "</p>".repeat(1) }</div>`.repeat(300)));
    expect(Date.now() - started).toBeLessThan(8000);
    expect(r.durationMinutes.confidence).toBe("estimate");
  });
  it("is pure: the same input gives the same output", () => {
    const body = html("govuk-guidance-html.html");
    const u = "https://www.gov.uk/guidance/planning-a-safe-roadworks-site-visit";
    expect(run(u, body)).toEqual(run(u, body));
  });
});

describe("gov-docs adapter: legislation contents pages", () => {
  const body = `<html><body><div id="content"><h1>The Example Regulations 2020</h1><ol>${"<li><a href='#'>1. A long heading with several words in it for the list</a></li>".repeat(60)}</ol></div></body></html>`;
  it.each([
    ["contents", "https://www.legislation.gov.uk/uksi/2020/9999/contents"],
    ["contents/made", "https://www.legislation.gov.uk/uksi/2020/9999/contents/made"],
    ["contents/enacted", "https://www.legislation.gov.uk/ukpga/2019/1/contents/enacted"],
    ["contents/made with a trailing slash", "https://www.legislation.gov.uk/uksi/2020/9999/contents/made/"],
    ["contents in upper case", "https://www.legislation.gov.uk/uksi/2020/9999/Contents/Made"],
  ])("gives no reading time for %s", (_name, url) => {
    const r = run(url, body);
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.durationMinutes.value).toBeNull();
    expect(r.durationMinutes.evidence).toMatch(/contents page/);
  });
  it("still estimates a section page whose address merely has a longer word starting with contents", () => {
    const section = `<html><body><div id="content"><h1>X</h1><p>${words(300)}</p></div></body></html>`;
    expect(run("https://www.legislation.gov.uk/uksi/2020/9999/regulation/3", section).durationMinutes.confidence).toBe("estimate");
    expect(run("https://www.legislation.gov.uk/uksi/2020/9999/contentsx", section).durationMinutes.confidence).toBe("estimate");
  });
});

describe("gov-docs adapter: a PDF link anywhere is not a landing page", () => {
  const LEG = "https://www.legislation.gov.uk/uksi/2020/9999/regulation/3";
  const paragraphs = Array.from({ length: 10 }, (_, i) => `<p>${words(12)} ${i}</p>`).join("");
  const legPage = (extra: string) => `<html><body><header><a href="/">legislation.gov.uk</a></header><div id="content"><h1>The Example Regulations 2020</h1>${extra}<div class="LegContent">${paragraphs}</div></div></body></html>`;

  it("a legislation section with a PDF link in its toolbar still gets a reading time", () => {
    const r = run(LEG, legPage('<div class="toolbar"><a href="https://www.legislation.gov.uk/uksi/2020/9999/data.pdf">PDF</a></div>'));
    expect(r.durationMinutes).toMatchObject({ value: 1, confidence: "estimate" });
    expect(r.durationMinutes.evidence).toMatch(/^About \d+ words/);
  });
  it("a legislation section is never a landing page, whatever it links to", () => {
    const withFile = run(LEG, legPage('<p><a href="/files/guide.pdf">Explanatory note (PDF)</a> <a href="/x.docx">Word</a></p>'));
    expect(withFile.durationMinutes).toMatchObject({ confidence: "estimate" });
    const withAttachment = run(LEG, legPage('<section class="attachment embedded"><a href="/a.pdf">A</a></section>'));
    expect(withAttachment.durationMinutes.confidence).toBe("estimate");
  });
  it("a gov.uk page with a PDF link in a toolbar, header, footer, menu, sidebar or sharing block is still an estimate", () => {
    const text = `<div class="govspeak"><p>${words(250)}</p></div>`;
    const links = [
      '<div class="toolbar"><a href="/doc.pdf">PDF</a></div>',
      '<aside><a href="/doc.pdf">PDF</a></aside>',
      '<nav><a href="/doc.pdf">PDF</a></nav>',
      '<ul class="main-menu"><li><a href="/doc.pdf">PDF</a></li></ul>',
      '<div class="share-links"><a href="/doc.pdf">PDF</a></div>',
      '<div class="print-link"><a href="/doc.pdf">PDF</a></div>',
      '<form><a href="/doc.pdf">PDF</a></form>',
    ];
    for (const link of links) {
      const r = run(GOV, `<html><body><header><a href="/x.pdf">PDF</a></header><main><h1>A page</h1>${link}${text}</main><footer><a href="/y.pdf">PDF</a></footer></body></html>`);
      expect(r.durationMinutes.confidence).toBe("estimate");
    }
  });
  it("a gov.uk guidance page that links to a form inside its text is an estimate, not a landing page", () => {
    const r = run(GOV, govPage(`<div class="govspeak"><p>${words(250)} <a href="/media/claim-form.pdf">Download the form (PDF)</a></p></div>`));
    expect(r.durationMinutes).toMatchObject({ value: 1, confidence: "estimate" });
  });
  it("a gov.uk page whose attachments are listed outside the text is still a landing page", () => {
    const r = run(GOV, govPage(`<div class="govspeak"><p>${words(250)}</p></div><section class="attachment"><a href="/media/a.pdf">Chapter 1</a></section>`));
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.durationMinutes.evidence).toMatch(/landing page/);
    expect(r.durationMinutes.evidence).toMatch(/links to 1 file/);
  });
  it("a Standards for Highways page with its download in <main> is still a landing page, and one with it only in a header or footer is not", () => {
    const sfh = "https://www.standardsforhighways.co.uk/dmrb/search/1";
    const inMain = run(sfh, `<html><body><main><h1>CD 1</h1><p>${words(100)}</p><a class="button" href="/files/cd1.pdf">Download PDF</a></main></body></html>`);
    expect(inMain.durationMinutes.confidence).toBe("missing");
    expect(inMain.durationMinutes.evidence).toMatch(/landing page/);
    const elsewhere = run(sfh, `<html><body><header><a href="/files/all.pdf">Download PDF</a></header><main><h1>CD 1</h1><p>${words(100)}</p></main><footer><a href="/files/terms.pdf">Terms (PDF)</a></footer></body></html>`);
    expect(elsewhere.durationMinutes.confidence).toBe("estimate");
  });
});

describe("countAttachments: only the page's content area counts", () => {
  const doc = (inner: string) => loadDoc(`<html><body>${inner}</body></html>`);
  it("ignores links in the header, footer, navigation, sidebar, toolbars and menus", () => {
    const d = doc('<header><a href="/a.pdf">A</a></header><nav><a href="/b.pdf">B</a></nav><main><p>Text</p><div class="toolbar"><a href="/c.pdf">C</a></div><aside><a href="/d.pdf">D</a></aside></main><footer><a href="/e.pdf">E</a></footer>');
    expect(countAttachments(d)).toBe(0);
  });
  it("counts the links in <main>, and only those when there is a <main>", () => {
    const d = doc('<a href="/outside.pdf">Outside</a><main><a href="/one.pdf">One</a><a href="/two.xlsx">Two</a></main>');
    expect(countAttachments(d)).toBe(2);
  });
  it("is not hidden by a class on the body or on an element above the content area", () => {
    const d = loadDoc('<html><body class="menu-open"><div class="menu-layout"><main><a href="/one.pdf">One</a></main></div></body></html>');
    expect(countAttachments(d)).toBe(1);
  });
  it("leaves out links inside the text when asked to", () => {
    const d = doc('<main><div class="govspeak"><a href="/form.pdf">Form</a></div><a href="/file.pdf">File</a></main>');
    expect(countAttachments(d)).toBe(2);
    expect(countAttachments(d, ".govspeak")).toBe(1);
  });
  it("counts an attachment section outside the toolbar but not one inside it", () => {
    expect(countAttachments(doc('<main><section class="attachment"><h3>One</h3></section></main>'))).toBe(1);
    expect(countAttachments(doc('<main><aside><section class="attachment"><h3>One</h3></section></aside></main>'))).toBe(0);
  });
});

describe("gov-docs adapter: the From: provider is small and clean", () => {
  const from = (inner: string) => run(GOV, govPage(inner)).provider;
  it("clips one huge organisation name", () => {
    const f = from(`<dl><dt>From:</dt><dd><a href="/o">${"A".repeat(200_000)}</a></dd></dl>`);
    expect(f.confidence).toBe("high");
    expect((f.value ?? "").length).toBeLessThanOrEqual(120);
    expect(JSON.stringify(f).length).toBeLessThan(600);
  });
  it("clips an organisation that is not a link", () => {
    const f = from(`<dl><dt>From:</dt><dd>${"B".repeat(200_000)}</dd></dl>`);
    expect((f.value ?? "").length).toBeLessThanOrEqual(120);
  });
  it("clips the joined list of organisations", () => {
    const orgs = Array.from({ length: 4 }, (_, i) => `<a href="/o${i}">${String(i).repeat(200)}</a>`).join(" ");
    const f = from(`<dl><dt>From:</dt><dd>${orgs}</dd></dl>`);
    expect((f.value ?? "").length).toBeLessThanOrEqual(300);
  });
  it("keeps only the first four organisations", () => {
    const orgs = Array.from({ length: 9 }, (_, i) => `<a href="/o${i}">Org ${i}</a>`).join(" ");
    expect(from(`<dl><dt>From:</dt><dd>${orgs}</dd></dl>`).value).toBe("Org 0, Org 1, Org 2, Org 3");
  });
  it("removes control characters and direction overrides", () => {
    const f = from("<dl><dt>From:</dt><dd><a href=\"/o\">Dept\u0007 for \u202Etxt.exe\u2066 Transport</a></dd></dl>");
    expect(f.value).toBe("Dept for txt.exe Transport");
    expect([...(f.value ?? "")].some((c) => c.charCodeAt(0) < 32 || (c >= "\u202A" && c <= "\u202E") || (c >= "\u2066" && c <= "\u2069"))).toBe(false);
  });
  it("cleans the plain-text From: line too", () => {
    const f = from("<p>From: Dept\u0007 for \u202ETransport Published 3 June 2025</p>");
    expect(f.value).toBe("Dept for Transport");
  });
  it("still reads ordinary names, several, in order and without duplicates", () => {
    expect(from('<dl><dt>From:</dt><dd><a href="/a">Department for Transport</a> and <a href="/b">National Highways</a> <a href="/c">Department for Transport</a></dd></dl>').value)
      .toBe("Department for Transport, National Highways");
  });
});

describe("gov-docs adapter: reading time of a very long document", () => {
  const longDoc = (n: number) => {
    const para = `<p>${"reading ".repeat(100)}</p>`;
    return `<html><head><title>A long document - GOV.UK</title></head><body><main><h1>A long document</h1><div class="govspeak">${para.repeat(n / 100)}</div></main></body></html>`;
  };
  it("counts all 100,000 words of a long document, not just the first 500,000 characters", () => {
    const page = longDoc(100_000);
    expect(page.length).toBeLessThan(1_000_000);
    const r = run(GOV, page);
    expect(r.durationMinutes.confidence).toBe("estimate");
    expect(r.durationMinutes.value).toBe(500);
    expect(r.durationMinutes.evidence).toContain("About 100000 words");
  });
  it("counts 60,000 words, which is over the text cap, exactly", () => {
    const r = run(GOV, longDoc(60_000));
    expect(r.durationMinutes.evidence).toContain("About 60000 words");
    expect(r.durationMinutes.value).toBe(300);
  });
  it("gives no reading time, and no word count, when the page is longer than we read", () => {
    const page = longDoc(150_000);
    expect(page.length).toBeGreaterThan(1_000_000);
    const r = run(GOV, page);
    expect(r.durationMinutes.confidence).toBe("missing");
    expect(r.durationMinutes.value).toBeNull();
    expect(r.durationMinutes.evidence).toMatch(/very long/);
    expect(r.durationMinutes.evidence).toMatch(/Please enter/);
    expect(r.durationMinutes.evidence).not.toMatch(/About \d+ words/);
    expect(r.durationMinutes.evidence).not.toMatch(/\d{4,}/);
  });
  it("does the same for a legislation or Standards for Highways page", () => {
    const body = `<html><body><main><div id="content"><h1>X</h1>${`<p>${"reading ".repeat(100)}</p>`.repeat(1500)}</div></main></body></html>`;
    expect(body.length).toBeGreaterThan(1_000_000);
    for (const url of ["https://www.legislation.gov.uk/ukpga/2019/1/section/1", "https://www.standardsforhighways.co.uk/dmrb/search/1"]) {
      expect(run(url, body).durationMinutes.confidence).toBe("missing");
    }
  });
  it("still estimates an ordinary long page from its full text", () => {
    const r = run(GOV, govPage(`<div class="govspeak"><p>${words(3000)}</p></div>`));
    expect(r.durationMinutes).toMatchObject({ value: 15, confidence: "estimate" });
    expect(r.durationMinutes.evidence).toContain("About 3000 words");
  });
});
