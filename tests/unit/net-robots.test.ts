import { describe, expect, it, vi } from "vitest";
import {
  ROBOTS_DISALLOWED_MESSAGE,
  ROBOTS_MAX_BYTES,
  ROBOTS_TTL_MS,
  ROBOTS_UNCONFIRMED_MESSAGE,
  ROBOTS_UNCONFIRMED_TTL_MS,
  createRobotsChecker,
  isPathAllowed,
  parseRobots,
  patternMatches,
  rulesForAgent,
} from "@/lib/net/robots";
import type { RobotsDecision } from "@/lib/net/robots";
import type { SafeFailure, SafeResult, SafeSuccess, Transport, TransportResponse } from "@/lib/net/safe-request";
import type { Resolver } from "@/lib/net/ssrf";

const allowed = (robots: string, path: string, token?: string) => isPathAllowed(parseRobots(robots), path, token);

describe("robots.txt: choosing the group", () => {
  it("applies the group that names CPDLoggerBot, case-insensitively, over the * group", () => {
    const robots = ["User-agent: *", "Disallow: /", "", "User-agent: CPDLoggerBot", "Allow: /", "Disallow: /private/"].join("\n");
    expect(allowed(robots, "/anything")).toBe(true);
    expect(allowed(robots, "/private/x")).toBe(false);
    for (const spelling of ["cpdloggerbot", "CPDLOGGERBOT", "CpdLoggerBot", "cPdLoGgErBoT"]) {
      expect(allowed(`User-agent: *\nDisallow: /\n\nUser-agent: ${spelling}\nAllow: /`, "/page"), spelling).toBe(true);
    }
    expect(allowed("USER-AGENT: cpdloggerbot\nDISALLOW: /secret", "/secret")).toBe(false);
  });

  it("falls back to * when no group names us", () => {
    const robots = ["User-agent: Googlebot", "Disallow: /g/", "", "User-agent: *", "Disallow: /all/"].join("\n");
    expect(allowed(robots, "/all/x")).toBe(false);
    expect(allowed(robots, "/g/x")).toBe(true); // Googlebot's rules are not ours
  });

  it("allows everything when the file has no group for us and no * group", () => {
    expect(allowed("User-agent: Googlebot\nDisallow: /", "/x")).toBe(true);
    expect(allowed("", "/x")).toBe(true);
    expect(allowed("   \n\n# only a comment\n", "/x")).toBe(true);
  });

  it("lets a group that names us win even if it is empty", () => {
    const robots = "User-agent: CPDLoggerBot\nDisallow:\n\nUser-agent: *\nDisallow: /";
    expect(allowed(robots, "/page")).toBe(true);
  });

  it("matches a user agent written with a version, but not a different bot with a similar name", () => {
    expect(allowed("User-agent: CPDLoggerBot/1.0\nDisallow: /x", "/x")).toBe(false);
    expect(allowed("User-agent: CPDLoggerBotExtra\nDisallow: /x", "/x")).toBe(true);
    expect(allowed("User-agent: NotCPDLoggerBot\nDisallow: /x", "/x")).toBe(true);
    expect(allowed("User-agent: CPD\nDisallow: /x", "/x")).toBe(true);
  });

  it("shares one group between consecutive User-agent lines, with blank lines and comments between them", () => {
    const robots = ["User-agent: Googlebot", "", "# a comment", "User-agent: CPDLoggerBot", "User-agent: Bingbot", "Disallow: /shared"].join("\n");
    expect(allowed(robots, "/shared")).toBe(false);
    expect(rulesForAgent(parseRobots(robots), "bingbot")).toHaveLength(1);
  });

  it("starts a new group when a User-agent line follows a rule", () => {
    const robots = ["User-agent: Googlebot", "Disallow: /g", "User-agent: CPDLoggerBot", "Disallow: /ours"].join("\n");
    expect(allowed(robots, "/g")).toBe(true);
    expect(allowed(robots, "/ours")).toBe(false);
  });

  it("combines several groups that name us", () => {
    const robots = ["User-agent: CPDLoggerBot", "Disallow: /a", "", "User-agent: Other", "Disallow: /z", "", "User-agent: cpdloggerbot", "Disallow: /b"].join("\n");
    expect(allowed(robots, "/a")).toBe(false);
    expect(allowed(robots, "/b")).toBe(false);
    expect(allowed(robots, "/z")).toBe(true);
  });

  it("combines several * groups when none names us", () => {
    const robots = ["User-agent: *", "Disallow: /a", "", "User-agent: Other", "Disallow: /z", "", "User-agent: *", "Disallow: /b"].join("\n");
    expect(allowed(robots, "/a")).toBe(false);
    expect(allowed(robots, "/b")).toBe(false);
  });

  it("ignores rules that appear before any User-agent line", () => {
    expect(allowed("Disallow: /\nUser-agent: Other\nDisallow: /x", "/page")).toBe(true);
  });

  it("ignores Crawl-delay, Sitemap and unknown lines, and they do not split a group", () => {
    const robots = ["User-agent: Googlebot", "Crawl-delay: 10", "Sitemap: https://example.com/sitemap.xml", "User-agent: CPDLoggerBot", "Host: example.com", "Disallow: /x"].join("\n");
    expect(allowed(robots, "/x")).toBe(false);
    expect(allowed("User-agent: *\nCrawl-delay: 10\nSitemap: https://a/b", "/x")).toBe(true);
  });

  it("copes with CRLF, lone CR, a byte-order mark, comments, odd spacing and no final newline", () => {
    expect(allowed("\uFEFFUser-agent: *\r\nDisallow: /crlf\r\n", "/crlf")).toBe(false);
    expect(allowed("User-agent: *\rDisallow: /cr\r", "/cr")).toBe(false);
    expect(allowed("User-agent:*   # everyone\nDisallow:   /spaced    # note", "/spaced")).toBe(false);
    expect(allowed("   User-agent  :  *  \n   Disallow  :  /x  ", "/x")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /nonewline", "/nonewline")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /a#b", "/a")).toBe(false); // "#b" is a comment
  });

  it("accepts the common typos crawlers accept", () => {
    expect(allowed("User-agent: *\nDisallow /nocolon", "/nocolon")).toBe(false);
    expect(allowed("User-agent: *\nDissallow: /typo", "/typo")).toBe(false);
    expect(allowed("Useragent: *\nDisallow: /x", "/x")).toBe(false);
    expect(allowed("User agent: *\nDisallow: /x", "/x")).toBe(false);
  });

  it("does not throw on junk input", () => {
    for (const junk of [":::", "\u0000\u0001", "Disallow", "User-agent", "User-agent:", "Disallow:\n:\n:::\n#", "x".repeat(100000), "\n".repeat(100000)]) {
      expect(() => parseRobots(junk)).not.toThrow();
    }
    expect(allowed("User-agent:\nDisallow: /x", "/x")).toBe(true); // an agent line with no name belongs to nobody
  });
});

describe("robots.txt: matching rules", () => {
  it("empty Disallow allows everything, and an empty Allow changes nothing", () => {
    expect(allowed("User-agent: *\nDisallow:", "/anything")).toBe(true);
    expect(allowed("User-agent: *\nDisallow:\nDisallow: /private", "/private/x")).toBe(false);
    expect(allowed("User-agent: *\nAllow:\nDisallow: /x", "/x")).toBe(false);
  });

  it("Disallow: / blocks everything, including the root", () => {
    expect(allowed("User-agent: *\nDisallow: /", "/")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /", "/a/b?c=d")).toBe(false);
  });

  it("is a prefix match on the path, and case-sensitive", () => {
    const robots = "User-agent: *\nDisallow: /Private";
    expect(allowed(robots, "/Private")).toBe(false);
    expect(allowed(robots, "/Private/page")).toBe(false);
    expect(allowed(robots, "/PrivateStuff")).toBe(false);
    expect(allowed(robots, "/private")).toBe(true);
    expect(allowed(robots, "/pub/Private")).toBe(true);
  });

  it("matches against the path plus the query string", () => {
    expect(allowed("User-agent: *\nDisallow: /search?", "/search?q=1")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /search?", "/search")).toBe(true);
    expect(allowed("User-agent: *\nDisallow: /*?session=", "/a/b?session=2")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /*?session=", "/a/b?x=1&session=2")).toBe(true); // "?session=" is not in this path
    expect(allowed("User-agent: *\nDisallow: /*session=", "/a/b?x=1&session=2")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /*?session=", "/a/b?x=1")).toBe(true);
  });

  it("* matches any run of characters, including none and slashes", () => {
    const robots = "User-agent: *\nDisallow: /private*/secret\nDisallow: /*.pdf\nDisallow: /a*b*c";
    expect(allowed(robots, "/private/secret")).toBe(false);
    expect(allowed(robots, "/private-area/x/secret/y")).toBe(false);
    expect(allowed(robots, "/privat/secret")).toBe(true);
    expect(allowed(robots, "/docs/paper.pdf")).toBe(false);
    expect(allowed(robots, "/docs/paper.pdf?dl=1")).toBe(false);
    expect(allowed(robots, "/axxbxxc")).toBe(false);
    expect(allowed(robots, "/abc")).toBe(false);
    expect(allowed(robots, "/acb")).toBe(true);
  });

  it("$ anchors the end of the path, and * and $ work together", () => {
    const robots = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /exact$\nDisallow: /dir/*$";
    expect(allowed(robots, "/paper.pdf")).toBe(false);
    expect(allowed(robots, "/paper.pdf?x=1")).toBe(true); // not at the end
    expect(allowed(robots, "/paper.pdfx")).toBe(true);
    expect(allowed(robots, "/exact")).toBe(false);
    expect(allowed(robots, "/exact/more")).toBe(true);
    expect(allowed(robots, "/exactly")).toBe(true);
    expect(allowed(robots, "/dir/anything/here")).toBe(false);
    expect(allowed(robots, "/dir/")).toBe(false);
  });

  it("Disallow: /$ blocks only the exact root", () => {
    const robots = "User-agent: *\nDisallow: /$";
    expect(allowed(robots, "/")).toBe(false);
    expect(allowed(robots, "/page")).toBe(true);
    expect(allowed(robots, "/?a=1")).toBe(true);
  });

  it("a $ in the middle of a pattern is just a character", () => {
    expect(allowed("User-agent: *\nDisallow: /a$b", "/a$b")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /a$b", "/ab")).toBe(true);
  });

  it("the longest matching pattern wins", () => {
    const robots = "User-agent: *\nDisallow: /folder/\nAllow: /folder/page.html";
    expect(allowed(robots, "/folder/page.html")).toBe(true);
    expect(allowed(robots, "/folder/other.html")).toBe(false);
    const reversed = "User-agent: *\nAllow: /folder/page.html\nDisallow: /folder/";
    expect(allowed(reversed, "/folder/page.html")).toBe(true);
    const longerDisallow = "User-agent: *\nAllow: /a/\nDisallow: /a/b/";
    expect(allowed(longerDisallow, "/a/b/c")).toBe(false);
    expect(allowed(longerDisallow, "/a/x")).toBe(true);
  });

  it("an Allow wins a tie, in either order", () => {
    expect(allowed("User-agent: *\nAllow: /page\nDisallow: /page", "/page")).toBe(true);
    expect(allowed("User-agent: *\nDisallow: /page\nAllow: /page", "/page")).toBe(true);
    // Equal length, different patterns: /*.php (6) vs /a.php (6).
    expect(allowed("User-agent: *\nDisallow: /*.php\nAllow: /a.php", "/a.php")).toBe(true);
  });

  it("compares by pattern length, so a longer wildcard rule can beat a shorter literal one", () => {
    const robots = "User-agent: *\nAllow: /a\nDisallow: /*/secret";
    expect(allowed(robots, "/a/secret")).toBe(false); // "/*/secret" (9) beats "/a" (2)
    expect(allowed(robots, "/a/open")).toBe(true);
  });

  it("allows a path no rule matches", () => {
    expect(allowed("User-agent: *\nDisallow: /private", "/public")).toBe(true);
  });

  it("treats the root path when the path is empty", () => {
    expect(allowed("User-agent: *\nDisallow: /", "")).toBe(false);
  });

  it("normalises percent-encoding on both sides", () => {
    expect(allowed("User-agent: *\nDisallow: /caf\u00e9", new URL("https://example.com/caf\u00e9").pathname)).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /caf%C3%A9", "/caf%c3%a9")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /%7euser", "/~user")).toBe(false);
    expect(allowed("User-agent: *\nDisallow: /~user", "/%7Euser")).toBe(false);
    // An encoded slash is not the same as a slash.
    expect(allowed("User-agent: *\nDisallow: /a%2Fb", "/a/b")).toBe(true);
    expect(allowed("User-agent: *\nDisallow: /a%2fb", "/a%2Fb")).toBe(false);
  });

  it("patternMatches handles the edge cases directly", () => {
    expect(patternMatches("/", "/anything")).toBe(true);
    expect(patternMatches("*", "/anything")).toBe(true);
    expect(patternMatches("**", "")).toBe(true);
    expect(patternMatches("/a*", "/a")).toBe(true);
    expect(patternMatches("/a*$", "/abc")).toBe(true);
    expect(patternMatches("/a*b$", "/ab")).toBe(true);
    expect(patternMatches("/a*ab$", "/ab")).toBe(false); // the "a" and "ab" would overlap
    expect(patternMatches("/*ab$", "/ab")).toBe(true);
    expect(patternMatches("/abc$", "/abc")).toBe(true);
    expect(patternMatches("/abc$", "/abcd")).toBe(false);
  });
});

describe("robots.txt: a hostile file cannot make matching slow", () => {
  it("handles thousands of wildcards in linear time", () => {
    const pattern = `/${"*a".repeat(5000)}b`;
    const robots = `User-agent: *\nDisallow: ${pattern}`;
    const path = `/${"a".repeat(2000)}`;
    const started = Date.now();
    expect(allowed(robots, path)).toBe(true);
    expect(allowed(robots, `${path}b`)).toBe(true); // 2000 a's cannot supply 5000 "a" pieces
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("handles a pattern built to make a naive regex backtrack", () => {
    const robots = `User-agent: *\nDisallow: ${"/*".repeat(40)}x$`;
    const started = Date.now();
    expect(allowed(robots, `/${"/".repeat(500)}y`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it("parses a very large file quickly", () => {
    const lines: string[] = ["User-agent: *"];
    for (let i = 0; i < 20000; i++) lines.push(`Disallow: /path-${i}/*/x$`);
    const started = Date.now();
    const rules = parseRobots(lines.join("\n"));
    expect(rules.groups[0]?.rules).toHaveLength(20000);
    expect(isPathAllowed(rules, "/zzz")).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

// ---------------------------------------------------------------------------------------------
// The checker: fetching, outcomes and the cache
// ---------------------------------------------------------------------------------------------

function ok(status: number, body = "", extra: Partial<SafeSuccess> = {}): SafeSuccess {
  return { ok: true, status, finalUrl: "https://example.com/robots.txt", contentType: "text/plain", headers: {}, body, bodyRead: true, truncated: false, redirects: 0, ...extra };
}
function bad(code: SafeFailure["code"]): SafeFailure {
  return { ok: false, code, message: "internal wording that must not leak" };
}

function checkerWith(respond: (url: string, n: number) => SafeResult | Promise<SafeResult>, now: () => number = () => 0, extra: { maxEntries?: number } = {}) {
  const fetch = vi.fn(async (url: string) => respond(url, fetch.mock.calls.length - 1));
  return { fetch, checker: createRobotsChecker({ fetch, now, ...extra }) };
}

function blockedWith(d: RobotsDecision, kind: "robots_disallowed" | "robots_unconfirmed") {
  expect(d.allowed).toBe(false);
  if (d.allowed) return;
  expect(d.kind).toBe(kind);
}

describe("robots checker: outcomes", () => {
  it("a 2xx file that disallows the page gives robots_disallowed with the plain message", async () => {
    const { checker, fetch } = checkerWith(() => ok(200, "User-agent: *\nDisallow: /private/"));
    const d = await checker.check("https://example.com/private/page");
    blockedWith(d, "robots_disallowed");
    if (!d.allowed) {
      expect(d.message).toBe("This site asks automated tools not to read this page, so we haven't. You can type the details in yourself.");
      expect(d.message).toBe(ROBOTS_DISALLOWED_MESSAGE);
    }
    expect(fetch).toHaveBeenCalledWith("https://example.com/robots.txt");
  });

  it("a 2xx file that does not disallow the page allows it", async () => {
    const { checker } = checkerWith(() => ok(200, "User-agent: *\nDisallow: /private/"));
    expect(await checker.check("https://example.com/public/page")).toEqual({ allowed: true, source: "robots_txt" });
  });

  it("checks the query string, and accepts a URL object", async () => {
    const { checker } = checkerWith(() => ok(200, "User-agent: *\nDisallow: /*?preview="));
    blockedWith(await checker.check(new URL("https://example.com/a?preview=1")), "robots_disallowed");
    expect((await checker.check(new URL("https://example.com/a?x=1"))).allowed).toBe(true);
  });

  it.each([400, 401, 403, 404, 410, 418, 429, 451, 499])("any 4xx (%i) means there is no robots file, so reading is allowed", async (status) => {
    const { checker } = checkerWith(() => ok(status, "User-agent: *\nDisallow: /"));
    expect(await checker.check("https://example.com/page")).toEqual({ allowed: true, source: "no_robots_file" });
  });

  it.each([500, 502, 503, 504, 520, 599])("a %i means we could not confirm, so we do not read", async (status) => {
    const { checker } = checkerWith(() => ok(status, "User-agent: *\nAllow: /"));
    const d = await checker.check("https://example.com/page");
    blockedWith(d, "robots_unconfirmed");
    if (!d.allowed) {
      expect(d.message).toBe("We couldn't confirm that this site allows automated reading, so we haven't read it. You can type the details in yourself.");
      expect(d.message).toBe(ROBOTS_UNCONFIRMED_MESSAGE);
      expect(d.message).not.toMatch(/says no|disallow/i);
    }
  });

  it.each(["timeout", "network", "unsafe_url", "too_many_redirects", "bad_redirect", "tls", "unresolvable", "dns_failed", "unsupported_encoding"] as const)(
    "a failed fetch (%s) means we could not confirm",
    async (code) => {
      const { checker } = checkerWith(() => bad(code));
      const d = await checker.check("https://example.com/page");
      blockedWith(d, "robots_unconfirmed");
      if (!d.allowed) expect(d.message).not.toContain("internal wording");
    },
  );

  it("a fetch that throws means we could not confirm", async () => {
    const { checker } = checkerWith(() => {
      throw new Error("boom");
    });
    blockedWith(await checker.check("https://example.com/page"), "robots_unconfirmed");
  });

  it("a redirect that went nowhere (3xx with no usable target) means we could not confirm", async () => {
    const { checker } = checkerWith(() => ok(302, ""));
    blockedWith(await checker.check("https://example.com/page"), "robots_unconfirmed");
  });

  it("a 2xx with a non-text body counts as a file with no rules", async () => {
    const { checker } = checkerWith(() => ok(200, "", { bodyRead: false, contentType: "application/pdf" }));
    expect((await checker.check("https://example.com/page")).allowed).toBe(true);
  });

  it("gives an unconfirmed answer for something that is not a URL, without throwing", async () => {
    const { checker, fetch } = checkerWith(() => ok(200));
    blockedWith(await checker.check("not a url"), "robots_unconfirmed");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("drops the last line when the file was cut at the size cap, so half a rule is never used", async () => {
    const body = "User-agent: *\nDisallow: /ok\nDisallow: /pri";
    const { checker } = checkerWith(() => ok(200, body, { truncated: true }));
    blockedWith(await checker.check("https://example.com/ok/x"), "robots_disallowed");
    expect((await checker.check("https://example.com/private")).allowed).toBe(true); // "/pri" was cut off and ignored
    const whole = checkerWith(() => ok(200, "User-agent: *\nDisallow: /pri", { truncated: false }));
    blockedWith(await whole.checker.check("https://example.com/private"), "robots_disallowed");
  });
});

describe("robots checker: cache", () => {
  it("keeps a result for one hour and then asks again", async () => {
    let t = 1_000;
    const { checker, fetch } = checkerWith(() => ok(200, "User-agent: *\nDisallow: /x"), () => t);
    await checker.check("https://example.com/a");
    t += ROBOTS_TTL_MS - 1;
    await checker.check("https://example.com/b");
    await checker.check("https://example.com/c");
    expect(fetch).toHaveBeenCalledTimes(1);
    t += 1; // exactly one hour after it was stored
    await checker.check("https://example.com/d");
    expect(fetch).toHaveBeenCalledTimes(2);
    t += ROBOTS_TTL_MS - 1;
    await checker.check("https://example.com/e");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("answers different paths on one origin from the same cached file", async () => {
    const { checker, fetch } = checkerWith(() => ok(200, "User-agent: *\nDisallow: /x"));
    blockedWith(await checker.check("https://example.com/x/1"), "robots_disallowed");
    expect((await checker.check("https://example.com/y")).allowed).toBe(true);
    blockedWith(await checker.check("https://example.com/x"), "robots_disallowed");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("caches 'no robots file' for an hour too", async () => {
    let t = 0;
    const { checker, fetch } = checkerWith(() => ok(404), () => t);
    await checker.check("https://example.com/a");
    t = ROBOTS_TTL_MS - 1;
    await checker.check("https://example.com/b");
    expect(fetch).toHaveBeenCalledTimes(1);
    t = ROBOTS_TTL_MS;
    await checker.check("https://example.com/c");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("keeps an unconfirmed result for at most one minute", async () => {
    let t = 50_000;
    const answers: SafeResult[] = [ok(503), ok(200, "User-agent: *\nDisallow: /x")];
    const { checker, fetch } = checkerWith(() => answers.shift() ?? ok(200), () => t);
    expect(ROBOTS_UNCONFIRMED_TTL_MS).toBe(60_000);
    blockedWith(await checker.check("https://example.com/p"), "robots_unconfirmed");
    t += ROBOTS_UNCONFIRMED_TTL_MS - 1;
    blockedWith(await checker.check("https://example.com/p"), "robots_unconfirmed"); // still remembered, no new fetch
    expect(fetch).toHaveBeenCalledTimes(1);
    t += 1;
    blockedWith(await checker.check("https://example.com/x"), "robots_disallowed"); // asked again and got the file
    expect(fetch).toHaveBeenCalledTimes(2);
    t += ROBOTS_UNCONFIRMED_TTL_MS; // now it is a normal one-hour entry, not a one-minute one
    await checker.check("https://example.com/p");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("measures the lifetime from when the answer arrived, not when it was asked for", async () => {
    let t = 0;
    const { checker, fetch } = checkerWith(async () => {
      t += 30_000; // the fetch takes 30 seconds
      return ok(503);
    }, () => t);
    await checker.check("https://example.com/p"); // stored at t = 30 000
    t = 30_000 + ROBOTS_UNCONFIRMED_TTL_MS - 1;
    await checker.check("https://example.com/p");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps one entry per origin: scheme, host and port all matter", async () => {
    const { checker, fetch } = checkerWith(() => ok(404));
    for (const url of ["http://example.com/", "https://example.com/", "https://www.example.com/", "https://example.com:8443/", "https://other.example.org/"]) {
      await checker.check(url);
    }
    expect(fetch).toHaveBeenCalledTimes(5);
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "http://example.com/robots.txt",
      "https://example.com/robots.txt",
      "https://www.example.com/robots.txt",
      "https://example.com:8443/robots.txt",
      "https://other.example.org/robots.txt",
    ]);
  });

  it("shares one fetch between checks that run at the same time", async () => {
    let release: (r: SafeResult) => void = () => undefined;
    const pending = new Promise<SafeResult>((resolve) => {
      release = resolve;
    });
    const { checker, fetch } = checkerWith(() => pending);
    const all = Promise.all([1, 2, 3, 4, 5].map((n) => checker.check(`https://example.com/p${n}`)));
    release(ok(200, "User-agent: *\nDisallow: /p3"));
    const results = await all;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.allowed)).toEqual([true, true, false, true, true]);
  });

  it("forgets everything on clear()", async () => {
    const { checker, fetch } = checkerWith(() => ok(404));
    await checker.check("https://example.com/a");
    checker.clear();
    await checker.check("https://example.com/a");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("does not remember more origins than the limit", async () => {
    const { checker, fetch } = checkerWith(() => ok(404), () => 0, { maxEntries: 2 });
    await checker.check("https://a.example.com/");
    await checker.check("https://b.example.com/");
    await checker.check("https://c.example.com/"); // pushes a.example.com out
    expect(fetch).toHaveBeenCalledTimes(3);
    await checker.check("https://c.example.com/");
    await checker.check("https://b.example.com/");
    expect(fetch).toHaveBeenCalledTimes(3);
    await checker.check("https://a.example.com/");
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------------------------
// The checker with the real safeRequest and a fake transport: same address rules, redirects, size cap
// ---------------------------------------------------------------------------------------------

const publicResolver: Resolver = async (host) => [{ address: host === "internal.example.org" ? "10.1.1.1" : "93.184.216.34", family: 4 }];

function res(status: number, body: string | Uint8Array = "", headers: Record<string, string | undefined> = {}): TransportResponse {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  return {
    status,
    headers: { "content-type": "text/plain", ...headers },
    body: (async function* () {
      for (let i = 0; i < bytes.length; i += 65536) yield bytes.subarray(i, i + 65536);
    })(),
  };
}

describe("robots checker with the real request code", () => {
  it("fetches /robots.txt on the same origin with our user agent and a text accept header", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const request: Transport = async (req) => {
      calls.push({ url: req.url.href, headers: req.headers });
      return res(200, "User-agent: *\nDisallow: /nope");
    };
    const checker = createRobotsChecker({ request, resolve: publicResolver, contact: "ops@example.com" });
    blockedWith(await checker.check("https://example.com/nope/page?token=SECRET#frag"), "robots_disallowed");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://example.com/robots.txt"); // no path, query or fragment of the page leaks into it
    expect(calls[0]?.headers["user-agent"]).toBe("CPDLoggerBot/1.0 (+ops@example.com)");
    expect(calls[0]?.headers["accept"]).toMatch(/^text\/plain/);
    expect(Object.keys(calls[0]?.headers ?? {})).not.toContain("cookie");
  });

  it("follows a redirect to the real robots.txt", async () => {
    const calls: string[] = [];
    const request: Transport = async (req) => {
      calls.push(req.url.href);
      return calls.length === 1 ? res(301, "", { location: "https://www.example.com/robots.txt" }) : res(200, "User-agent: *\nDisallow: /x");
    };
    const checker = createRobotsChecker({ request, resolve: publicResolver });
    blockedWith(await checker.check("https://example.com/x"), "robots_disallowed");
    expect(calls).toEqual(["https://example.com/robots.txt", "https://www.example.com/robots.txt"]);
  });

  it("does not follow a robots.txt redirect to a private address, and reports unconfirmed", async () => {
    const calls: string[] = [];
    const request: Transport = async (req) => {
      calls.push(req.url.href);
      return res(302, "", { location: "http://169.254.169.254/latest/meta-data/" });
    };
    const checker = createRobotsChecker({ request, resolve: publicResolver });
    blockedWith(await checker.check("https://example.com/page"), "robots_unconfirmed");
    expect(calls).toEqual(["https://example.com/robots.txt"]);
  });

  it("reports unconfirmed when the robots.txt fetch hits a server error or a network failure", async () => {
    const five: Transport = async () => res(500, "oops");
    blockedWith(await createRobotsChecker({ request: five, resolve: publicResolver }).check("https://example.com/p"), "robots_unconfirmed");
    const down: Transport = async () => {
      throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
    };
    blockedWith(await createRobotsChecker({ request: down, resolve: publicResolver }).check("https://example.com/p"), "robots_unconfirmed");
    const slow: Transport = async () => {
      throw Object.assign(new Error("slow"), { code: "UND_ERR_HEADERS_TIMEOUT" });
    };
    blockedWith(await createRobotsChecker({ request: slow, resolve: publicResolver }).check("https://example.com/p"), "robots_unconfirmed");
  });

  it("treats a 404 on robots.txt as 'no file' even through the real request code", async () => {
    const request: Transport = async () => res(404, "<html>Not found</html>", { "content-type": "text/html" });
    expect(await createRobotsChecker({ request, resolve: publicResolver }).check("https://example.com/p")).toEqual({ allowed: true, source: "no_robots_file" });
  });

  it("reads only the first 512 KiB of a huge file, and does not treat that as an error", async () => {
    expect(ROBOTS_MAX_BYTES).toBe(512 * 1024);
    const head = "User-agent: *\nDisallow: /early\n";
    const filler = "# padding\n".repeat(Math.ceil((ROBOTS_MAX_BYTES + 5000) / 10));
    const body = `${head}${filler}Disallow: /late\n`;
    expect(Buffer.byteLength(body)).toBeGreaterThan(ROBOTS_MAX_BYTES);
    const request: Transport = async () => res(200, body);
    const checker = createRobotsChecker({ request, resolve: publicResolver });
    blockedWith(await checker.check("https://example.com/early"), "robots_disallowed");
    expect((await checker.check("https://example.com/late")).allowed).toBe(true); // past the cap, so not read
  });

  it("uses the injected clock for the cache", async () => {
    let t = 0;
    let fetched = 0;
    const request: Transport = async () => {
      fetched++;
      return res(200, "User-agent: *\nAllow: /");
    };
    const checker = createRobotsChecker({ request, resolve: publicResolver, now: () => t });
    await checker.check("https://example.com/a");
    await checker.check("https://example.com/b");
    expect(fetched).toBe(1);
    t = ROBOTS_TTL_MS + 1;
    await checker.check("https://example.com/c");
    expect(fetched).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------------------------

describe("robots checker: the Content-Type of robots.txt does not matter", () => {
  it.each(["application/octet-stream", "binary/octet-stream", "application/x-unknown", "application/pdf", "image/png", "video/mp4"])(
    "obeys the rules in a robots.txt served as %s",
    async (type) => {
      const request: Transport = async () => res(200, "User-agent: *\nDisallow: /private/", { "content-type": type });
      const checker = createRobotsChecker({ request, resolve: publicResolver });
      blockedWith(await checker.check("https://example.com/private/page"), "robots_disallowed");
      expect(await checker.check("https://example.com/public/page")).toEqual({ allowed: true, source: "robots_txt" });
    },
  );

  it("obeys a robots.txt with no Content-Type header, and one declared as a UTF-8 octet stream", async () => {
    for (const headers of [{ "content-type": undefined }, { "content-type": "application/octet-stream; charset=utf-8" }]) {
      const request: Transport = async () => res(200, "User-agent: *\nDisallow: /", headers);
      blockedWith(await createRobotsChecker({ request, resolve: publicResolver }).check("https://example.com/page"), "robots_disallowed");
    }
  });

  it("still cuts a non-text robots.txt at the size cap without calling that an error", async () => {
    const body = `User-agent: *\nDisallow: /early\n${"# padding\n".repeat(Math.ceil((ROBOTS_MAX_BYTES + 5000) / 10))}Disallow: /late\n`;
    const request: Transport = async () => res(200, body, { "content-type": "application/octet-stream" });
    const checker = createRobotsChecker({ request, resolve: publicResolver });
    blockedWith(await checker.check("https://example.com/early"), "robots_disallowed");
    expect((await checker.check("https://example.com/late")).allowed).toBe(true);
  });
});

describe("robots checker: the fetch has a deadline", () => {
  it("gives up after the time it is given and reports that it could not confirm", async () => {
    const request: Transport = (req) =>
      new Promise<TransportResponse>((_resolve, reject) => {
        req.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const checker = createRobotsChecker({ request, resolve: publicResolver, timeoutMs: 40 });
    const outcome = await Promise.race([checker.check("https://example.com/page"), new Promise<"pending">((r) => setTimeout(() => r("pending"), 1500))]);
    expect(outcome).not.toBe("pending");
    blockedWith(outcome as RobotsDecision, "robots_unconfirmed");
  });
});
