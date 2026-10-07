import { afterEach, describe, expect, it, vi } from "vitest";
import { createApiFetcher, createPageReader, looksBinary, API_MAX_BYTES, READER_MESSAGES } from "@/lib/net/reader";
import { createRobotsChecker } from "@/lib/net/robots";
import type { HeadersIn, Transport, TransportRequest, TransportResponse } from "@/lib/net/safe-request";
import type { Resolver } from "@/lib/net/ssrf";
import type { ReadOutcome } from "@/lib/net/types";
import { getApiFetcher, getPageReader, resetNetSingletons } from "@/lib/net";
import { resetEnvCache } from "@/lib/env";

const PUBLIC_IP = "93.184.216.34";
const resolve: Resolver = async (host) => [{ address: host.startsWith("internal") ? "10.1.1.1" : PUBLIC_IP, family: 4 }];

const HTML = "<!doctype html><html><head><title>Webinar on bearings</title></head><body><h1>Bridge bearings</h1><p>A one hour webinar.</p></body></html>";

function res(status: number, body: string | Uint8Array = "", headers: HeadersIn = {}): TransportResponse {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
    body: (async function* () {
      if (bytes.length > 0) yield bytes;
    })(),
  };
}

type PageHandler = (req: TransportRequest) => TransportResponse | Promise<TransportResponse>;

interface Site {
  reader: ReturnType<typeof createPageReader>;
  calls: Array<{ url: string; headers: Record<string, string> }>;
  pageCalls: () => string[];
}

/** A reader wired to a fake transport. robots.txt answers with `robots` (default: 404, no file); everything else goes to `page`. */
function site(page: PageHandler, robots: PageHandler | string | number = 404, extra: { timeoutMs?: number; now?: () => number } = {}): Site {
  const calls: Site["calls"] = [];
  const transport: Transport = async (req) => {
    calls.push({ url: req.url.href, headers: { ...req.headers } });
    if (req.url.pathname === "/robots.txt") {
      if (typeof robots === "function") return robots(req);
      if (typeof robots === "number") return res(robots, "", { "content-type": "text/plain" });
      return res(200, robots, { "content-type": "text/plain" });
    }
    return page(req);
  };
  const reader = createPageReader({ request: transport, resolve, contact: "ops@example.com", ...extra });
  return { reader, calls, pageCalls: () => calls.filter((c) => !c.url.endsWith("/robots.txt")).map((c) => c.url) };
}

type OkOutcome = Extract<ReadOutcome, { kind: "ok" }>;
type OutcomeOf<K extends ReadOutcome["kind"]> = K extends "ok" ? OkOutcome : { kind: K; message: string };

function expectKind<K extends ReadOutcome["kind"]>(outcome: ReadOutcome, kind: K): OutcomeOf<K> {
  expect(outcome.kind, JSON.stringify(outcome)).toBe(kind);
  return outcome as unknown as OutcomeOf<K>;
}

const URL_UNDER_TEST = "https://example.com/events/bearings-webinar";

describe("reader: a page that can be read", () => {
  it("returns ok with the final URL, status, content type and body", async () => {
    const { reader } = site(() => res(200, HTML));
    const out = expectKind(await reader.read(URL_UNDER_TEST), "ok");
    expect(out.finalUrl).toBe(URL_UNDER_TEST);
    expect(out.status).toBe(200);
    expect(out.contentType).toBe("text/html; charset=utf-8");
    expect(out.body).toBe(HTML);
    expect(out.fromCache).toBe(false);
  });

  it.each(["text/html", "text/html; charset=iso-8859-1", "application/xhtml+xml", "text/plain", "text/xml"])("accepts %s", async (type) => {
    const { reader } = site(() => res(200, HTML, { "content-type": type }));
    expectKind(await reader.read(URL_UNDER_TEST), "ok");
  });

  it("accepts a page with no content type", async () => {
    const { reader } = site(() => res(200, HTML, { "content-type": undefined }));
    expectKind(await reader.read(URL_UNDER_TEST), "ok");
  });

  it("reports the address it ended up on after redirects", async () => {
    const { reader, pageCalls } = site((req) => (req.url.pathname === "/events/bearings-webinar" ? res(301, "", { location: "/events/2026/bearings", "content-type": undefined }) : res(200, HTML)));
    const out = expectKind(await reader.read(URL_UNDER_TEST), "ok");
    expect(out.finalUrl).toBe("https://example.com/events/2026/bearings");
    expect(pageCalls()).toHaveLength(2);
  });

  it("works for an http address too, and keeps the query string for the request", async () => {
    const { reader, pageCalls } = site(() => res(200, HTML));
    expectKind(await reader.read("http://example.com/page?id=7&x=y#section"), "ok");
    expect(pageCalls()[0]).toBe("http://example.com/page?id=7&x=y#section");
  });
});

describe("reader: addresses that are not public web addresses", () => {
  it.each([
    "http://127.0.0.1/",
    "http://localhost/",
    "http://169.254.169.254/latest/meta-data/",
    "http://2130706433/",
    "http://[::1]/",
    "http://10.0.0.1/",
    "http://internal.example.com/",
    "ftp://example.com/file",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "https://user:pass@example.com/",
    "http://example.com:8080/",
  ])("%s gives unsafe_url without any request, not even for robots.txt", async (url) => {
    const { reader, calls } = site(() => res(200, HTML));
    const out = expectKind(await reader.read(url), "unsafe_url");
    expect(out.message).toMatch(/public web address|http:\/\/ or https:\/\//);
    expect(calls).toHaveLength(0);
  });

  it("explains it in plain words and points to typing the details in", async () => {
    const { reader } = site(() => res(200, HTML));
    const out = expectKind(await reader.read("http://192.168.1.1/admin"), "unsafe_url");
    expect(out.message).toBe("That link points to a private or internal address, not a public web address, so we haven't tried to read it. You can type the details in yourself.");
  });

  it("does not echo the address or its query string back", async () => {
    const { reader } = site(() => res(200, HTML));
    const out = await reader.read("http://127.0.0.1/?token=SECRET-TOKEN");
    expect(JSON.stringify(out)).not.toContain("SECRET-TOKEN");
    expect(JSON.stringify(out)).not.toContain("127.0.0.1");
  });

  it("says a site that does not exist could not be found (failed, not unsafe)", async () => {
    const nx: Resolver = async () => {
      throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    };
    const reader = createPageReader({ request: async () => res(200, HTML), resolve: nx });
    const out = expectKind(await reader.read("https://no-such-site.example.com/"), "failed");
    expect(out.message).toMatch(/couldn't find a website/);
  });

  it("handles text that is not a link at all", async () => {
    const { reader, calls } = site(() => res(200, HTML));
    for (const text of ["", "hello", "example.com/page", "   "]) {
      expectKind(await reader.read(text), "unsafe_url");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a redirect to a private address and never requests it", async () => {
    for (const target of ["http://169.254.169.254/latest/meta-data/", "http://127.0.0.1:8080/admin", "file:///etc/passwd", "http://internal.example.com/"]) {
      const { reader, pageCalls } = site(() => res(302, "", { location: target, "content-type": undefined }));
      const out = expectKind(await reader.read(URL_UNDER_TEST), "unsafe_url");
      expect(out.message).toMatch(/redirects to an address that isn't a public web address/);
      expect(pageCalls()).toEqual([URL_UNDER_TEST]);
    }
  });
});

describe("reader: robots.txt", () => {
  it("does not read the page when robots.txt disallows it", async () => {
    const { reader, pageCalls, calls } = site(() => res(200, HTML), "User-agent: *\nDisallow: /events/");
    const out = expectKind(await reader.read(URL_UNDER_TEST), "robots_disallowed");
    expect(out.message).toBe("This site asks automated tools not to read this page, so we haven't. You can type the details in yourself.");
    expect(pageCalls()).toHaveLength(0);
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/robots.txt"]);
  });

  it("obeys a group that names CPDLoggerBot", async () => {
    const { reader } = site(() => res(200, HTML), "User-agent: *\nDisallow:\n\nUser-agent: cpdloggerbot\nDisallow: /");
    expectKind(await reader.read(URL_UNDER_TEST), "robots_disallowed");
  });

  it("reads the page when robots.txt allows it", async () => {
    const { reader } = site(() => res(200, HTML), "User-agent: *\nDisallow: /private/");
    expectKind(await reader.read(URL_UNDER_TEST), "ok");
  });

  it.each([404, 403, 401, 410])("reads the page when robots.txt is %i (no file)", async (status) => {
    const { reader } = site(() => res(200, HTML), status);
    expectKind(await reader.read(URL_UNDER_TEST), "ok");
  });

  it.each([500, 502, 503])("does not read the page when robots.txt answers %i, and says we could not confirm", async (status) => {
    const { reader, pageCalls } = site(() => res(200, HTML), status);
    const out = expectKind(await reader.read(URL_UNDER_TEST), "robots_unconfirmed");
    expect(out.message).toBe("We couldn't confirm that this site allows automated reading, so we haven't read it. You can type the details in yourself.");
    expect(out.message).not.toMatch(/asks automated tools not to/);
    expect(pageCalls()).toHaveLength(0);
  });

  it("does not read the page when robots.txt times out or the network fails", async () => {
    for (const code of ["UND_ERR_HEADERS_TIMEOUT", "ECONNREFUSED", "ECONNRESET"]) {
      const { reader, pageCalls } = site(() => res(200, HTML), () => {
        throw Object.assign(new Error("x"), { code });
      });
      expectKind(await reader.read(URL_UNDER_TEST), "robots_unconfirmed");
      expect(pageCalls()).toHaveLength(0);
    }
  });

  it("asks robots.txt once for several reads of the same site", async () => {
    const { reader, calls } = site(() => res(200, HTML));
    await reader.read("https://example.com/a");
    await reader.read("https://example.com/b");
    await reader.read("https://example.com/c");
    expect(calls.filter((c) => c.url.endsWith("/robots.txt"))).toHaveLength(1);
  });

  it("asks again for another site", async () => {
    const { reader, calls } = site(() => res(200, HTML));
    await reader.read("https://example.com/a");
    await reader.read("https://other.example.org/a");
    expect(calls.filter((c) => c.url.endsWith("/robots.txt")).map((c) => c.url)).toEqual(["https://example.com/robots.txt", "https://other.example.org/robots.txt"]);
  });

  it("checks robots.txt again for a redirect target on another site, and stops if that site disallows it", async () => {
    const { reader, pageCalls, calls } = site(
      (req) => (req.url.hostname === "example.com" ? res(302, "", { location: "https://other.example.org/landing", "content-type": undefined }) : res(200, HTML)),
      (req) => (req.url.hostname === "other.example.org" ? res(200, "User-agent: *\nDisallow: /landing", { "content-type": "text/plain" }) : res(404)),
    );
    const out = expectKind(await reader.read(URL_UNDER_TEST), "robots_disallowed");
    expect(out.message).toMatch(/asks automated tools not to read this page/);
    expect(pageCalls()).toEqual([URL_UNDER_TEST]); // the landing page itself was never requested
    expect(calls.map((c) => c.url)).toEqual(["https://example.com/robots.txt", URL_UNDER_TEST, "https://other.example.org/robots.txt"]);
  });

  it("checks a same-site redirect target against the same robots.txt", async () => {
    const { reader, pageCalls } = site(() => res(302, "", { location: "/private/area", "content-type": undefined }), "User-agent: *\nDisallow: /private/");
    expectKind(await reader.read(URL_UNDER_TEST), "robots_disallowed");
    expect(pageCalls()).toEqual([URL_UNDER_TEST]);
  });

  it("stops if it cannot confirm robots.txt for a redirect target", async () => {
    const { reader, pageCalls } = site(
      (req) => (req.url.hostname === "example.com" ? res(302, "", { location: "https://other.example.org/landing", "content-type": undefined }) : res(200, HTML)),
      (req) => (req.url.hostname === "other.example.org" ? res(503) : res(404)),
    );
    expectKind(await reader.read(URL_UNDER_TEST), "robots_unconfirmed");
    expect(pageCalls()).toEqual([URL_UNDER_TEST]);
  });

  it("uses an injected robots checker", async () => {
    const robots = createRobotsChecker({ fetch: async () => ({ ok: true, status: 200, finalUrl: "x", contentType: "text/plain", headers: {}, body: "User-agent: *\nDisallow: /", bodyRead: true, truncated: false, redirects: 0 }) });
    const reader = createPageReader({ request: async () => res(200, HTML), resolve, robots });
    expectKind(await reader.read(URL_UNDER_TEST), "robots_disallowed");
  });
});

describe("reader: what the site said", () => {
  it("401 gives login_required", async () => {
    const { reader } = site(() => res(401, "<h1>Unauthorized</h1>", { "www-authenticate": "Basic" }));
    const out = expectKind(await reader.read(URL_UNDER_TEST), "login_required");
    expect(out.message).toBe("This page needs you to sign in, so we can't read it. You can type the details in yourself.");
  });

  it.each([403, 429, 451])("%i gives blocked, with the message that we did not try to get around it", async (status) => {
    const { reader } = site(() => res(status, "<h1>No</h1>"));
    const out = expectKind(await reader.read(URL_UNDER_TEST), "blocked");
    expect(out.message).toBe("This site doesn't allow automated reading. We haven't tried to get around that. You can type the details in yourself.");
  });

  it("a challenge page gives challenge, whatever status it arrives with", async () => {
    const challenge = '<html><head><title>Just a moment...</title></head><body><noscript><span id="challenge-error-text">Enable JavaScript and cookies to continue</span></noscript></body></html>';
    for (const status of [200, 403, 429, 503]) {
      const { reader } = site(() => res(status, challenge));
      const out = expectKind(await reader.read(URL_UNDER_TEST), "challenge");
      expect(out.message).toMatch(/security check or an access-denied page/);
      expect(out.message).toMatch(/haven't tried to get around that/);
      expect(out.message).toMatch(/type the details in yourself/);
    }
  });

  it("a challenge header gives challenge even with an empty body", async () => {
    const { reader } = site(() => res(403, "", { "cf-mitigated": "challenge" }));
    expectKind(await reader.read(URL_UNDER_TEST), "challenge");
  });

  it("a sign-in page reached by redirect gives login_required", async () => {
    const { reader } = site((req) =>
      req.url.pathname === "/login" ? res(200, "<html><body><h1>Sign in</h1><input type=password></body></html>") : res(302, "", { location: "/login?next=%2Fevents", "content-type": undefined }),
    );
    const out = expectKind(await reader.read(URL_UNDER_TEST), "login_required");
    expect(out.message).toMatch(/needs you to sign in/);
  });

  it("an identity-provider page gives login_required", async () => {
    const { reader } = site((req) =>
      req.url.hostname === "accounts.google.com" ? res(200, "<html><body>Choose an account</body></html>") : res(302, "", { location: "https://accounts.google.com/o/oauth2/auth", "content-type": undefined }),
    );
    expectKind(await reader.read(URL_UNDER_TEST), "login_required");
  });

  it("a page that is just a password form gives login_required", async () => {
    const { reader } = site(() => res(200, '<html><body><form><input type="email"><input type="password"><button>Go</button></form></body></html>'));
    expectKind(await reader.read(URL_UNDER_TEST), "login_required");
  });

  it("does not mistake a normal page with a sign-in link and a newsletter box for a login wall", async () => {
    const long = `<html><body><a href="/signin">Sign in</a><form><input type="email"></form><main>${"<p>Plenty of ordinary article text about bridge bearings and how to inspect them.</p>".repeat(40)}</main></body></html>`;
    const { reader } = site(() => res(200, long));
    expectKind(await reader.read(URL_UNDER_TEST), "ok");
  });

  it("404 and 410 give failed with a message about the page", async () => {
    const missing = expectKind(await site(() => res(404, "<h1>Not here</h1>")).reader.read(URL_UNDER_TEST), "failed");
    expect(missing.message).toMatch(/wasn't found \(error 404\)/);
    expect(missing.message).toMatch(/Check the link/);
    const gone = expectKind(await site(() => res(410)).reader.read(URL_UNDER_TEST), "failed");
    expect(gone.message).toMatch(/removed \(error 410\)/);
  });

  it.each([500, 502, 503, 504])("%i gives failed, with the status and what to do", async (status) => {
    const { reader } = site(() => res(status, "<h1>Oops</h1>"));
    const out = expectKind(await reader.read(URL_UNDER_TEST), "failed");
    expect(out.message).toContain(String(status));
    expect(out.message).toMatch(/Try again later/);
    expect(out.message).toMatch(/type the details in yourself/);
  });

  it("other 4xx give failed", async () => {
    for (const status of [400, 405, 406, 408, 418]) {
      const out = expectKind(await site(() => res(status, "no")).reader.read(URL_UNDER_TEST), "failed");
      expect(out.message).toContain(String(status));
    }
  });

  it("a 3xx with nowhere to go gives failed", async () => {
    const out = expectKind(await site(() => res(302, "")).reader.read(URL_UNDER_TEST), "failed");
    expect(out.message).toMatch(/redirects without saying where to/);
  });

  it("a timeout gives failed, and says how long we waited", async () => {
    const hang: PageHandler = (req) =>
      new Promise<TransportResponse>((_resolve, reject) => {
        req.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const { reader } = site(hang, 404, { timeoutMs: 50 });
    const out = expectKind(await reader.read(URL_UNDER_TEST), "failed");
    expect(out.message).toMatch(/took too long to answer/);
    expect(out.message).toMatch(/type the details in yourself/);
  });

  it("a transport timeout error gives failed", async () => {
    const { reader } = site(() => {
      throw Object.assign(new Error("x"), { code: "UND_ERR_HEADERS_TIMEOUT" });
    });
    expect(expectKind(await reader.read(URL_UNDER_TEST), "failed").message).toMatch(/took too long/);
  });

  it("a page that is too large gives failed", async () => {
    const { reader } = site(() => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: (async function* () {
        for (let i = 0; i < 100; i++) yield new Uint8Array(1024 * 1024);
      })(),
      destroy: () => undefined,
    }));
    const out = expectKind(await reader.read(URL_UNDER_TEST), "failed");
    expect(out.message).toMatch(/bigger than we can read \(over 2 MB\)/);
  });

  it("a network error gives failed, without leaking the error text", async () => {
    const { reader } = site(() => {
      throw Object.assign(new Error("connect ECONNREFUSED 10.20.30.40:443"), { code: "ECONNREFUSED" });
    });
    const out = expectKind(await reader.read(URL_UNDER_TEST), "failed");
    expect(out.message).toMatch(/couldn't connect to that site/);
    expect(out.message).not.toContain("10.20.30.40");
  });

  it("a bad certificate gives failed with its own message", async () => {
    const { reader } = site(() => {
      throw Object.assign(new Error("cert"), { code: "CERT_HAS_EXPIRED" });
    });
    expect(expectKind(await reader.read(URL_UNDER_TEST), "failed").message).toMatch(/security certificate wasn't accepted/);
  });

  it("too many redirects gives failed", async () => {
    const { reader } = site(() => res(302, "", { location: "/again", "content-type": undefined }));
    expect(expectKind(await reader.read(URL_UNDER_TEST), "failed").message).toMatch(/redirects more than 5 times/);
  });

  it("a PDF, an image or a data feed gives failed, naming the type", async () => {
    for (const type of ["application/pdf", "image/png", "application/octet-stream", "video/mp4"]) {
      const out = expectKind(await site(() => res(200, "bytes", { "content-type": type })).reader.read(URL_UNDER_TEST), "failed");
      expect(out.message).toContain(`(${type})`);
      expect(out.message).toMatch(/not a web page/);
    }
    const json = expectKind(await site(() => res(200, '{"a":1}', { "content-type": "application/json" })).reader.read(URL_UNDER_TEST), "failed");
    expect(json.message).toMatch(/not a web page/);
  });

  it("an empty page gives failed", async () => {
    expect(expectKind(await site(() => res(200, "   \n")).reader.read(URL_UNDER_TEST), "failed").message).toMatch(/came back empty/);
    expect(expectKind(await site(() => res(204, "")).reader.read(URL_UNDER_TEST), "failed").message).toMatch(/came back empty/);
  });

  it("does not write a hostile content type into the message", async () => {
    const out = expectKind(await site(() => res(200, "x", { "content-type": "application/<script>alert(1)</script>" })).reader.read(URL_UNDER_TEST), "failed");
    expect(out.message).not.toContain("<script>");
  });
});

describe("reader: politeness", () => {
  it("never retries: a failure means exactly one robots.txt request and one page request", async () => {
    for (const handler of [() => res(500, "x"), () => res(403, "x"), () => res(429, "x"), () => res(401, "x")] as PageHandler[]) {
      const { reader, calls } = site(handler);
      await reader.read(URL_UNDER_TEST);
      expect(calls).toHaveLength(2);
    }
    const down = site(() => {
      throw Object.assign(new Error("x"), { code: "ECONNRESET" });
    });
    await down.reader.read(URL_UNDER_TEST);
    expect(down.calls).toHaveLength(2);
  });

  it("does not retry with different headers after a block or a challenge", async () => {
    const { reader, calls } = site(() => res(403, "<title>Just a moment...</title>"));
    await reader.read(URL_UNDER_TEST);
    await reader.read(URL_UNDER_TEST);
    const agents = new Set(calls.map((c) => c.headers["user-agent"]));
    expect([...agents]).toEqual(["CPDLoggerBot/1.0 (+ops@example.com)"]);
    expect(calls.filter((c) => !c.url.endsWith("/robots.txt"))).toHaveLength(2); // one attempt per read, none extra
  });

  it("sends the same fixed headers for the page and for robots.txt, and never a cookie or Authorization", async () => {
    const { reader, calls } = site(() => res(200, HTML, { "set-cookie": "a=b" }));
    await reader.read(URL_UNDER_TEST);
    await reader.read("https://example.com/second");
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const call of calls) {
      expect(call.headers["user-agent"]).toBe("CPDLoggerBot/1.0 (+ops@example.com)");
      expect(Object.keys(call.headers).sort()).toEqual(["accept", "accept-encoding", "user-agent"]);
    }
  });

  it("uses the contact-not-set user agent when no contact is configured", async () => {
    const calls: string[] = [];
    const reader = createPageReader({
      request: async (req) => {
        calls.push(req.headers["user-agent"] ?? "");
        return res(req.url.pathname === "/robots.txt" ? 404 : 200, HTML);
      },
      resolve,
    });
    await reader.read(URL_UNDER_TEST);
    expect(new Set(calls)).toEqual(new Set(["CPDLoggerBot/1.0 (+contact-not-set)"]));
  });
});

describe("reader: never throws and never leaks", () => {
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
  afterEach(() => spies.forEach((s) => s.mockClear()));

  it("turns any surprise into a plain failed outcome", async () => {
    const weird: Transport = async () => {
      throw "a bare string";
    };
    const out = await createPageReader({ request: weird, resolve }).read(URL_UNDER_TEST);
    expect(out.kind).toBe("robots_unconfirmed"); // the first request (robots.txt) is the one that failed
    const brokenRobots = { check: async () => { throw new Error("internal path /srv/app/secret"); }, clear: () => undefined };
    const out2 = expectKind(await createPageReader({ request: async () => res(200, HTML), resolve, robots: brokenRobots }).read(URL_UNDER_TEST), "failed");
    expect(out2.message).toBe(READER_MESSAGES.unexpected);
    expect(out2.message).not.toContain("/srv/app");
  });

  it("turns a resolver that throws into a failed outcome", async () => {
    const boom: Resolver = async () => {
      throw new Error("resolver exploded 10.0.0.1");
    };
    const out = expectKind(await createPageReader({ request: async () => res(200, HTML), resolve: boom }).read(URL_UNDER_TEST), "failed");
    expect(out.message).not.toContain("10.0.0.1");
  });

  it("keeps the query string out of every non-ok outcome and out of the console", async () => {
    const secret = "SECRET-QUERY-VALUE-123";
    const url = `https://example.com/page?key=${secret}`;
    const handlers: PageHandler[] = [() => res(500), () => res(403), () => res(401), () => res(404), () => res(200, "", { "content-type": "application/pdf" }), () => {
      throw Object.assign(new Error(`failed ${url}`), { code: "ECONNRESET" });
    }];
    for (const handler of handlers) {
      const out = await site(handler).reader.read(url);
      expect(out.kind).not.toBe("ok");
      expect(JSON.stringify(out)).not.toContain(secret);
    }
    for (const bad of [`http://127.0.0.1/?key=${secret}`, `ftp://example.com/?key=${secret}`]) {
      expect(JSON.stringify(await site(() => res(200)).reader.read(bad))).not.toContain(secret);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// The JSON API fetcher
// ---------------------------------------------------------------------------------------------

function api(handler: PageHandler, extra: { timeoutMs?: number; maxBytes?: number } = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const request: Transport = async (req) => {
    calls.push({ url: req.url.href, headers: { ...req.headers } });
    return handler(req);
  };
  return { fetcher: createApiFetcher({ request, resolve, contact: "ops@example.com", ...extra }), calls };
}

const json = (status: number, value: unknown, headers: HeadersIn = {}) => res(status, typeof value === "string" ? value : JSON.stringify(value), { "content-type": "application/json; charset=UTF-8", ...headers });

describe("api fetcher", () => {
  it("returns parsed JSON for a 2xx answer", async () => {
    const { fetcher } = api(() => json(200, { items: [{ id: "abc", contentDetails: { duration: "PT1H2M" } }] }));
    const out = await fetcher.getJson("https://www.googleapis.com/youtube/v3/videos?id=abc&part=contentDetails");
    expect(out).toEqual({ kind: "ok", status: 200, json: { items: [{ id: "abc", contentDetails: { duration: "PT1H2M" } }] } });
  });

  it("sends the key as a header, never in the URL, with our user agent and no cookies", async () => {
    const { fetcher, calls } = api(() => json(200, {}));
    await fetcher.getJson("https://www.googleapis.com/youtube/v3/videos?id=abc", { headers: { "x-goog-api-key": "KEY-VALUE-1" } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.headers["x-goog-api-key"]).toBe("KEY-VALUE-1");
    expect(calls[0]?.url).not.toContain("KEY-VALUE-1");
    expect(calls[0]?.headers["user-agent"]).toBe("CPDLoggerBot/1.0 (+ops@example.com)");
    expect(calls[0]?.headers["accept"]).toBe("application/json");
    expect(Object.keys(calls[0]?.headers ?? {})).not.toContain("cookie");
  });

  it("does not check robots.txt", async () => {
    const { fetcher, calls } = api(() => json(200, { ok: true }));
    await fetcher.getJson("https://www.youtube.com/oembed?url=https%3A%2F%2Fyoutu.be%2Fabc&format=json");
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual(["/oembed"]);
  });

  it.each([400, 401, 403, 404, 429, 500, 503])("a %i gives http_error with the status and no body", async (status) => {
    const { fetcher } = api(() => json(status, { error: { message: "quota SECRET-DETAIL" } }));
    const out = await fetcher.getJson("https://www.googleapis.com/youtube/v3/videos?id=abc");
    expect(out).toEqual({ kind: "http_error", status });
  });

  it("gives failed for an answer that is not JSON, or empty", async () => {
    for (const body of ["<html>oops</html>", "", "   ", "{not json", "undefined"]) {
      const { fetcher } = api(() => json(200, body));
      const out = await fetcher.getJson("https://www.googleapis.com/x");
      expect(out.kind).toBe("failed");
    }
    expect((await api(() => json(204, "")).fetcher.getJson("https://www.googleapis.com/x")).kind).toBe("failed");
  });

  it("reads JSON whatever the content type says", async () => {
    for (const type of ["text/javascript; charset=UTF-8", "application/octet-stream", "application/vnd.api+json", "text/plain"]) {
      const { fetcher } = api(() => json(200, { a: 1 }, { "content-type": type }));
      expect(await fetcher.getJson("https://www.googleapis.com/x")).toEqual({ kind: "ok", status: 200, json: { a: 1 } });
    }
  });

  it("applies the same address rules: unsafe addresses give unsafe_url and nothing is requested", async () => {
    const { fetcher, calls } = api(() => json(200, {}));
    for (const url of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://localhost/", "file:///etc/passwd", "http://[::1]/", "https://internal.example.com/x", "https://u:p@www.googleapis.com/", "https://www.googleapis.com:8443/"]) {
      const out = await fetcher.getJson(url, { headers: { "x-goog-api-key": "K" } });
      expect(out.kind, url).toBe("unsafe_url");
    }
    expect(calls).toHaveLength(0);
  });

  it("revalidates redirects: a redirect to a private address is refused", async () => {
    const { fetcher, calls } = api(() => res(302, "", { location: "http://169.254.169.254/latest/meta-data/", "content-type": undefined }));
    const out = await fetcher.getJson("https://www.googleapis.com/x", { headers: { "x-goog-api-key": "K" } });
    expect(out.kind).toBe("unsafe_url");
    expect(calls).toHaveLength(1);
  });

  it("does not forward the key header to another origin, but does within the same origin", async () => {
    const { fetcher, calls } = api((req) => {
      if (req.url.pathname === "/start") return res(302, "", { location: "/same-origin", "content-type": undefined });
      if (req.url.pathname === "/same-origin") return res(302, "", { location: "https://elsewhere.example.org/final", "content-type": undefined });
      return json(200, { done: true });
    });
    const out = await fetcher.getJson("https://www.googleapis.com/start", { headers: { "x-goog-api-key": "KEY-VALUE-2" } });
    expect(out.kind).toBe("ok");
    expect(calls.map((c) => c.headers["x-goog-api-key"])).toEqual(["KEY-VALUE-2", "KEY-VALUE-2", undefined]);
  });

  it("refuses to send a Cookie or Authorization header, and says why without echoing the value", async () => {
    const { fetcher, calls } = api(() => json(200, {}));
    const refused: Array<Record<string, string>> = [{ Authorization: "Bearer SECRET-BEARER" }, { cookie: "SECRET-COOKIE=1" }];
    for (const headers of refused) {
      const out = await fetcher.getJson("https://www.googleapis.com/x", { headers });
      expect(out.kind).toBe("failed");
      expect(JSON.stringify(out)).not.toContain("SECRET");
    }
    expect(calls).toHaveLength(0);
  });

  it("gives up after the time limit", async () => {
    const hang: PageHandler = (req) =>
      new Promise<TransportResponse>((_resolve, reject) => {
        req.signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
    const { fetcher } = api(hang, { timeoutMs: 40 });
    const out = await fetcher.getJson("https://www.googleapis.com/x");
    expect(out.kind).toBe("failed");
    if (out.kind === "failed") expect(out.message).toMatch(/took too long/);
  });

  it("caps the answer at 1 MB", async () => {
    expect(API_MAX_BYTES).toBe(1024 * 1024);
    const exact = `{"a":"${"x".repeat(API_MAX_BYTES - 8)}"}`;
    expect(Buffer.byteLength(exact)).toBe(API_MAX_BYTES);
    const ok = await api(() => json(200, exact)).fetcher.getJson("https://www.googleapis.com/x");
    expect(ok.kind).toBe("ok");
    const over = await api(() => json(200, `${exact} `)).fetcher.getJson("https://www.googleapis.com/x");
    expect(over.kind).toBe("failed");
    if (over.kind === "failed") expect(over.message).toMatch(/bigger than we can read \(over 1 MB\)/);
    const endless = await api(() => ({ status: 200, headers: { "content-type": "application/json" }, body: (async function* () { for (;;) yield new Uint8Array(65536); })(), destroy: () => undefined })).fetcher.getJson("https://www.googleapis.com/x");
    expect(endless.kind).toBe("failed");
  });

  it("gives failed for network errors, without leaking details", async () => {
    const { fetcher } = api(() => {
      throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.9:443 key=SECRET-KEY"), { code: "ECONNREFUSED" });
    });
    const out = await fetcher.getJson("https://www.googleapis.com/x?key=SECRET-KEY", { headers: { "x-goog-api-key": "SECRET-KEY" } });
    expect(out.kind).toBe("failed");
    expect(JSON.stringify(out)).not.toContain("SECRET-KEY");
    expect(JSON.stringify(out)).not.toContain("10.0.0.9");
  });

  it("never logs", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    try {
      const { fetcher } = api(() => json(200, { a: 1 }));
      await fetcher.getJson("https://www.googleapis.com/x?key=SECRET", { headers: { "x-goog-api-key": "SECRET" } });
      await fetcher.getJson("http://127.0.0.1/?key=SECRET");
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      spies.forEach((s) => s.mockRestore());
    }
  });
});

// ---------------------------------------------------------------------------------------------
// The singletons, wired to the real environment loader. Only addresses that are refused before
// any connection are used, so no network is touched.
// ---------------------------------------------------------------------------------------------

describe("getPageReader and getApiFetcher", () => {
  const saved = process.env.CPD_BOT_CONTACT;
  afterEach(() => {
    if (saved === undefined) delete process.env.CPD_BOT_CONTACT;
    else process.env.CPD_BOT_CONTACT = saved;
    resetEnvCache();
    resetNetSingletons();
  });

  it("returns one shared instance each, and they refuse unsafe addresses without a connection", async () => {
    process.env.CPD_BOT_CONTACT = "ops@example.com";
    resetEnvCache();
    resetNetSingletons();
    const reader = getPageReader();
    expect(getPageReader()).toBe(reader);
    const fetcher = getApiFetcher();
    expect(getApiFetcher()).toBe(fetcher);
    expect((await reader.read("http://127.0.0.1/")).kind).toBe("unsafe_url");
    expect((await reader.read("file:///etc/passwd")).kind).toBe("unsafe_url");
    expect((await fetcher.getJson("http://169.254.169.254/latest/meta-data/")).kind).toBe("unsafe_url");
  });
});

// ---------------------------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------------------------

/** Settles with "pending" if the promise has not settled after `ms`, so a hang fails the test fast instead of timing out. */
async function settlesWithin<T>(promise: Promise<T>, ms = 1500): Promise<T | "pending"> {
  return Promise.race([promise, new Promise<"pending">((resolveLater) => setTimeout(() => resolveLater("pending"), ms))]);
}

describe("reader: a hostile page does not block the server", () => {
  it("reads a 2 MB page of repeated blank <title> tags quickly (it used to block for about 9 seconds)", async () => {
    const body = `${`<title>${" ".repeat(300)}`.repeat(6800)}<p>hello</p>`;
    expect(body.length).toBeGreaterThan(2_000_000);
    const { reader } = site(() => res(200, body));
    const started = Date.now();
    const out = expectKind(await reader.read(URL_UNDER_TEST), "ok");
    expect(Date.now() - started).toBeLessThan(2500);
    expect(out.body).toBe(body);
  });
});

describe("reader: robots.txt with an unusual Content-Type is still obeyed", () => {
  it.each(["application/octet-stream", "binary/octet-stream", "application/x-robots", "image/png", "application/pdf"])("obeys a Disallow in a robots.txt served as %s", async (type) => {
    const { reader, pageCalls } = site(
      () => res(200, HTML),
      () => res(200, "User-agent: *\nDisallow: /", { "content-type": type }),
    );
    expectKind(await reader.read(URL_UNDER_TEST), "robots_disallowed");
    expect(pageCalls()).toHaveLength(0);
  });

  it("obeys a robots.txt with no Content-Type at all", async () => {
    const { reader } = site(
      () => res(200, HTML),
      () => res(200, "User-agent: *\nDisallow: /events/", { "content-type": undefined }),
    );
    expectKind(await reader.read(URL_UNDER_TEST), "robots_disallowed");
  });

  it("still reads the page when that file allows it", async () => {
    const { reader } = site(
      () => res(200, HTML),
      () => res(200, "User-agent: *\nDisallow: /private/", { "content-type": "application/octet-stream" }),
    );
    expectKind(await reader.read(URL_UNDER_TEST), "ok");
  });
});

describe("reader: a redirect to a sign-in page is a sign-in page, whatever robots.txt says about it", () => {
  const loginPage = () => res(200, "<html><body><h1>Sign in</h1></body></html>");

  it("gives login_required when robots.txt disallows /login, and never requests the sign-in page", async () => {
    const { reader, pageCalls } = site((req) => (req.url.pathname === "/login" ? loginPage() : res(302, "", { location: "/login?next=%2Fevents", "content-type": undefined })), "User-agent: *\nDisallow: /login");
    const out = expectKind(await reader.read(URL_UNDER_TEST), "login_required");
    expect(out.message).toBe(READER_MESSAGES.login_required);
    expect(out.message).not.toMatch(/automated tools/);
    expect(pageCalls()).toEqual([URL_UNDER_TEST]);
  });

  it.each(["https://login.example.org/start?x=1", "https://accounts.google.com/o/oauth2/auth", "https://login.microsoftonline.com/common/oauth2/authorize", "https://acme.okta.com/app/x/sso/saml", "https://sso.example.org/"])(
    "gives login_required for a redirect to %s, even though that host's robots.txt disallows everything",
    async (target) => {
      const { reader, calls } = site(
        (req) => (req.url.href === URL_UNDER_TEST ? res(302, "", { location: target, "content-type": undefined }) : loginPage()),
        (req) => (req.url.hostname === "example.com" ? res(404) : res(200, "User-agent: *\nDisallow: /", { "content-type": "text/plain" })),
      );
      expectKind(await reader.read(URL_UNDER_TEST), "login_required");
      expect(calls.map((c) => new URL(c.url).hostname)).not.toContain(new URL(target).hostname);
    },
  );

  it("still reports robots_disallowed for a redirect that is not a sign-in page", async () => {
    const { reader } = site(() => res(302, "", { location: "/members/area", "content-type": undefined }), "User-agent: *\nDisallow: /members/");
    expectKind(await reader.read(URL_UNDER_TEST), "robots_disallowed");
  });
});

describe("reader: every wait has a deadline", () => {
  const hang: PageHandler = (req) =>
    new Promise<TransportResponse>((_resolve, reject) => {
      req.signal.addEventListener("abort", () => reject(new Error("aborted")));
    });

  it("gives up on a DNS lookup that never answers", async () => {
    const never: Resolver = () => new Promise(() => undefined);
    const reader = createPageReader({ request: async () => res(200, HTML), resolve: never, timeoutMs: 50 });
    const out = await settlesWithin(reader.read(URL_UNDER_TEST));
    expect(out).not.toBe("pending");
    const failure = expectKind(out as ReadOutcome, "failed");
    expect(failure.message).toMatch(/took too long to answer/);
    expect(failure.message).toMatch(/type the details in yourself/);
  });

  it("gives up on a robots.txt that never answers, after the same time, and does not read the page", async () => {
    const { reader, pageCalls } = site(() => res(200, HTML), hang, { timeoutMs: 50 });
    const out = await settlesWithin(reader.read(URL_UNDER_TEST));
    expect(out).not.toBe("pending");
    expectKind(out as ReadOutcome, "robots_unconfirmed");
    expect(pageCalls()).toHaveLength(0);
  });

  it("is still fast when nothing is slow", async () => {
    const { reader } = site(() => res(200, HTML), 404, { timeoutMs: 50 });
    expectKind(await reader.read(URL_UNDER_TEST), "ok");
  });
});

describe("reader: a 403 is a block unless the page is plainly a vendor's challenge", () => {
  it.each([403, 429, 451])("a %i page that only says 'Access Denied' gives blocked, not challenge", async (status) => {
    const { reader } = site(() => res(status, "<html><head><title>Access Denied</title></head><body>Your IP is not on the allow list.</body></html>"));
    const out = expectKind(await reader.read(URL_UNDER_TEST), "blocked");
    expect(out.message).toBe(READER_MESSAGES.blocked);
  });

  it("a 403 with only a human-check sentence is a block", async () => {
    const { reader } = site(() => res(403, "<html><body><p>Please verify you are human</p></body></html>"));
    expectKind(await reader.read(URL_UNDER_TEST), "blocked");
  });

  it("a 429 with a CAPTCHA widget and nothing else is a block", async () => {
    const { reader } = site(() => res(429, '<html><body><div class="cf-turnstile"></div></body></html>'));
    expectKind(await reader.read(URL_UNDER_TEST), "blocked");
  });

  it.each([
    ["a cf-mitigated header", "", { "cf-mitigated": "challenge" }],
    ["_cf_chl_opt", "<script>window._cf_chl_opt={cvId:'3'}</script>", {}],
    ["captcha-delivery.com", '<script src="https://ct.captcha-delivery.com/c.js"></script>', {}],
    ["px-captcha", '<div id="px-captcha"></div>', {}],
    ["an Incapsula incident ID", "<body>Request unsuccessful. Incapsula incident ID: 123-456</body>", {}],
  ] as const)("a 403 with %s gives challenge", async (_name, body, headers) => {
    const { reader } = site(() => res(403, body, { ...headers }));
    expectKind(await reader.read(URL_UNDER_TEST), "challenge");
  });

  it("a 503 or a 200 with the same plain wording is still a challenge", async () => {
    const page = "<html><head><title>Access Denied</title></head><body>Your IP is not on the allow list.</body></html>";
    expectKind(await site(() => res(503, page)).reader.read(URL_UNDER_TEST), "challenge");
    expectKind(await site(() => res(200, page)).reader.read(URL_UNDER_TEST), "challenge");
  });
});

describe("reader: pages that only look like a security check are read", () => {
  const copy =
    "Join us for a one hour CPD webinar on inspecting elastomeric bridge bearings. The session covers how to read wear patterns, when to schedule replacement and what to record in the inspection log. Places are free for members and cost twenty pounds for everyone else.";
  const page = (head: string, body: string, title = "Bearings webinar") => `<html><head><title>${title}</title>${head}</head><body><h1>${title}</h1><p>${copy}</p>${body}</body></html>`;

  it.each([
    ["the Cloudflare script", page("", '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>')],
    ["a reCAPTCHA contact form", page("", '<form><input type="text"><input type="email"><textarea></textarea><div class="g-recaptcha"></div><button>Send</button></form>')],
    ["'access denied' in the copy", page("", "<p>Some members see an 'Access denied' message when they open the recording from a work laptop.</p>")],
    ["a title that begins 'Just a moment'", page("", "", "Just a moment of reflection: CPD for chaplains")],
  ])("reads a 200 page with %s", async (_name, html) => {
    const { reader } = site(() => res(200, html));
    expectKind(await reader.read(URL_UNDER_TEST), "ok");
  });
});

describe("reader: a file sent with no Content-Type is not read as a page", () => {
  const withNoType = (bytes: Uint8Array) => site(() => res(200, bytes, { "content-type": undefined })).reader.read(URL_UNDER_TEST);

  it("a PDF is not a page", async () => {
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n%"), Buffer.from([0xe2, 0xe3, 0xcf, 0xd3]), Buffer.from("\n1 0 obj\n<< /Type /Catalog >>\nendobj\n")]);
    const out = expectKind(await withNoType(pdf), "failed");
    expect(out.message).toMatch(/not a web page/);
    expect(out.message).toBe(READER_MESSAGES.not_a_page(""));
  });

  it.each([
    ["a PNG", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52]],
    ["a JPEG", [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]],
    ["a ZIP or Word file", [0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x06, 0x00, 0x08, 0x00]],
    ["bytes with a NUL in them", [0x68, 0x65, 0x6c, 0x6c, 0x6f, 0x00, 0x77, 0x6f, 0x72, 0x6c, 0x64]],
    ["mostly invalid bytes", Array.from({ length: 300 }, (_, i) => 0x80 + (i % 64))],
  ])("%s is not a page", async (_name, bytes) => {
    expectKind(await withNoType(Uint8Array.from(bytes)), "failed");
  });

  it("an HTML page with no Content-Type is still read, even with an odd byte or two", async () => {
    expectKind(await withNoType(Buffer.from(HTML)), "ok");
    const latin1 = Buffer.concat([Buffer.from("<html><body><p>Caf"), Buffer.from([0xe9]), Buffer.from(" talk on bearings, with a longer line of ordinary text so the stray byte is a tiny part of it.</p></body></html>")]);
    expectKind(await withNoType(latin1), "ok");
  });

  it("a page that does name a text type is not second-guessed", async () => {
    expectKind(await site(() => res(200, "%PDF-1.4 is just text in this page", { "content-type": "text/plain" })).reader.read(URL_UNDER_TEST), "ok");
  });

  it("looksBinary", () => {
    expect(looksBinary("")).toBe(false);
    expect(looksBinary("<html><body>Hello</body></html>")).toBe(false);
    expect(looksBinary("Tabs\tand\nnewlines\r\nand a form feed\f are fine")).toBe(false);
    expect(looksBinary("%PDF-1.7")).toBe(true);
    expect(looksBinary("GIF89a")).toBe(true);
    expect(looksBinary("text with a \u0000 in it")).toBe(true);
    expect(looksBinary("\u0001\u0002\u0003\u0004\u0005abcdefghij")).toBe(true);
    expect(looksBinary("\ufffd".repeat(30) + "abcdef")).toBe(true);
    expect(looksBinary("a normal sentence with one \ufffd in it and plenty of other characters around it")).toBe(false);
  });
});

describe("api fetcher: an API key is never sent in clear text", () => {
  it("refuses an http address when there is a header to send, and sends nothing", async () => {
    const { fetcher, calls } = api(() => json(200, { ok: true }));
    const out = await fetcher.getJson("http://www.googleapis.com/youtube/v3/videos?id=1", { headers: { "x-goog-api-key": "SECRETKEY" } });
    expect(out.kind).toBe("unsafe_url");
    expect(calls).toHaveLength(0);
    expect(JSON.stringify(out)).not.toContain("SECRETKEY");
    if (out.kind === "unsafe_url") expect(out.message).toMatch(/https/);
  });

  it("still fetches an http address when there are no headers to protect", async () => {
    const { fetcher, calls } = api(() => json(200, { ok: true }));
    expect((await fetcher.getJson("http://www.googleapis.com/x")).kind).toBe("ok");
    expect((await fetcher.getJson("http://www.googleapis.com/x", { headers: {} })).kind).toBe("ok");
    expect(calls).toHaveLength(2);
  });

  it("sends the key over https, and does not follow it to an http address on a redirect", async () => {
    const { fetcher, calls } = api((req) => (req.url.protocol === "https:" ? res(302, "", { location: "http://www.googleapis.com/next", "content-type": undefined }) : json(200, { done: true })));
    const out = await fetcher.getJson("https://www.googleapis.com/start", { headers: { "x-goog-api-key": "SECRETKEY" } });
    expect(out.kind).toBe("ok");
    expect(calls.map((c) => c.headers["x-goog-api-key"])).toEqual(["SECRETKEY", undefined]);
  });
});
