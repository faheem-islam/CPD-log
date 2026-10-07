import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOT_PRODUCT_TOKEN,
  MAX_CONTACT_CHARS,
  SAFE_REQUEST_MESSAGES,
  buildUserAgent,
  createUndiciTransport,
  decodeBody,
  isTextContentType,
  safeRequest,
} from "@/lib/net/safe-request";
import type { HeadersIn, SafeFailure, SafeResult, SafeSuccess, Transport, TransportRequest, TransportResponse } from "@/lib/net/safe-request";
import { BlockedAddressError, UNSAFE_URL_MESSAGES } from "@/lib/net/ssrf";
import type { Resolver } from "@/lib/net/ssrf";

const PUBLIC_IP = "93.184.216.34";

/** Everything resolves to a public address unless the table says otherwise. */
function resolverWith(table: Record<string, string[]> = {}): Resolver {
  return async (hostname) => (table[hostname] ?? [PUBLIC_IP]).map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
}

type Script = (req: TransportRequest, index: number) => TransportResponse | Promise<TransportResponse>;

function makeTransport(script: Script) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const transport: Transport = async (req) => {
    calls.push({ url: req.url.href, headers: { ...req.headers } });
    return script(req, calls.length - 1);
  };
  return { transport, calls };
}

function reply(status: number, body: string | Uint8Array = "", headers: HeadersIn = {}): TransportResponse {
  const bytes = typeof body === "string" ? Buffer.from(body) : body;
  return {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...headers },
    body: (async function* () {
      if (bytes.length > 0) yield bytes;
    })(),
  };
}

function redirect(location: string, status = 302, extra: HeadersIn = {}): TransportResponse {
  return reply(status, "", { location, "content-type": undefined, ...extra });
}

function expectFailure(r: SafeResult, code: SafeFailure["code"]): SafeFailure {
  if (r.ok) throw new Error(`Expected failure ${code}, got status ${r.status}`);
  expect(r.code).toBe(code);
  return r;
}

function expectOk(r: SafeResult): SafeSuccess {
  if (!r.ok) throw new Error(`Expected success, got ${r.code}: ${r.message}`);
  return r;
}

describe("user agent", () => {
  it("is exactly CPDLoggerBot/1.0 (+contact)", () => {
    expect(BOT_PRODUCT_TOKEN).toBe("CPDLoggerBot");
    expect(buildUserAgent("https://example.com/bot")).toBe("CPDLoggerBot/1.0 (+https://example.com/bot)");
    expect(buildUserAgent("ops@example.com")).toBe("CPDLoggerBot/1.0 (+ops@example.com)");
  });

  it("falls back to contact-not-set for a missing or blank contact", () => {
    expect(buildUserAgent()).toBe("CPDLoggerBot/1.0 (+contact-not-set)");
    expect(buildUserAgent("")).toBe("CPDLoggerBot/1.0 (+contact-not-set)");
    expect(buildUserAgent("   ")).toBe("CPDLoggerBot/1.0 (+contact-not-set)");
  });

  it("strips control characters so a contact cannot inject a header", () => {
    expect(buildUserAgent("a@b.com\r\nX-Evil: 1")).toBe("CPDLoggerBot/1.0 (+a@b.comX-Evil: 1)");
    expect(buildUserAgent("\u0000\u0007")).toBe("CPDLoggerBot/1.0 (+contact-not-set)");
  });

  it("is what the transport receives, with the right contact", async () => {
    const { transport, calls } = makeTransport(() => reply(200, "<p>hi</p>"));
    await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith(), contact: "ops@example.com" });
    expect(calls[0]?.headers["user-agent"]).toBe("CPDLoggerBot/1.0 (+ops@example.com)");
    const second = makeTransport(() => reply(200, "<p>hi</p>"));
    await safeRequest("https://example.com/", {}, { request: second.transport, resolve: resolverWith() });
    expect(second.calls[0]?.headers["user-agent"]).toBe("CPDLoggerBot/1.0 (+contact-not-set)");
  });
});

describe("request headers: no cookies, no Authorization", () => {
  it("sends only the user agent, an HTML accept and identity encoding", async () => {
    const { transport, calls } = makeTransport(() => reply(200, "<p>hi</p>"));
    await safeRequest("https://example.com/page?x=1", {}, { request: transport, resolve: resolverWith() });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]?.headers ?? {}).sort()).toEqual(["accept", "accept-encoding", "user-agent"]);
    expect(calls[0]?.headers["accept"]).toMatch(/^text\/html,application\/xhtml\+xml/);
    expect(calls[0]?.headers["accept-encoding"]).toBe("identity");
    expect(calls[0]?.url).toBe("https://example.com/page?x=1");
  });

  it("ignores Set-Cookie: it is not replayed on the next hop and not returned to the caller", async () => {
    const { transport, calls } = makeTransport((_req, i) =>
      i === 0 ? redirect("/next", 302, { "set-cookie": ["session=abc; Path=/", "tracker=1"] }) : reply(200, "<p>done</p>", { "set-cookie": "again=1", "x-other": "kept" }),
    );
    const res = expectOk(await safeRequest("https://example.com/start", {}, { request: transport, resolve: resolverWith() }));
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      const names = Object.keys(call.headers).map((n) => n.toLowerCase());
      expect(names).not.toContain("cookie");
      expect(names).not.toContain("authorization");
    }
    expect(Object.keys(res.headers)).not.toContain("set-cookie");
    expect(res.headers["x-other"]).toBe("kept");
  });

  it("refuses to send a cookie or Authorization header even if the caller asks", async () => {
    const refused: Array<Record<string, string>> = [{ cookie: "a=b" }, { Cookie: "a=b" }, { authorization: "Bearer x" }, { Authorization: "Basic abc" }, { "Proxy-Authorization": "x" }];
    for (const headers of refused) {
      const { transport, calls } = makeTransport(() => reply(200, "ok"));
      const r = await safeRequest("https://example.com/", { headers }, { request: transport, resolve: resolverWith() });
      const failure = expectFailure(r, "bad_request");
      expect(failure.message).not.toContain("Bearer");
      expect(calls).toHaveLength(0);
    }
  });

  it("refuses header values that could inject another header", async () => {
    const { transport, calls } = makeTransport(() => reply(200, "ok"));
    expectFailure(await safeRequest("https://example.com/", { headers: { "x-api-key": "k\r\nCookie: a=b" } }, { request: transport, resolve: resolverWith() }), "bad_request");
    expectFailure(await safeRequest("https://example.com/", { headers: { "bad name": "k" } }, { request: transport, resolve: resolverWith() }), "bad_request");
    expect(calls).toHaveLength(0);
  });

  it("does not let the caller replace the user agent", async () => {
    const { transport, calls } = makeTransport(() => reply(200, "ok"));
    await safeRequest("https://example.com/", { headers: { "User-Agent": "Mozilla/5.0", Host: "evil.example", "Accept-Encoding": "gzip" } }, { request: transport, resolve: resolverWith(), contact: "c@example.com" });
    expect(calls[0]?.headers["user-agent"]).toBe("CPDLoggerBot/1.0 (+c@example.com)");
    expect(calls[0]?.headers["accept-encoding"]).toBe("identity");
    expect(calls[0]?.headers["host"]).toBeUndefined();
  });

  it("sends caller headers (an API key) to the first origin and on same-origin redirects, but never to another origin", async () => {
    const { transport, calls } = makeTransport((_req, i) => {
      if (i === 0) return redirect("/second");
      if (i === 1) return redirect("https://other.example.org/third");
      return reply(200, "{}", { "content-type": "application/json" });
    });
    expectOk(await safeRequest("https://api.example.com/first", { headers: { "x-goog-api-key": "KEY123" } }, { request: transport, resolve: resolverWith() }));
    expect(calls.map((c) => c.headers["x-goog-api-key"])).toEqual(["KEY123", "KEY123", undefined]);
  });

  it("uses the accept header the caller asks for", async () => {
    const { transport, calls } = makeTransport(() => reply(200, "ok"));
    await safeRequest("https://example.com/robots.txt", { accept: "text/plain" }, { request: transport, resolve: resolverWith() });
    expect(calls[0]?.headers["accept"]).toBe("text/plain");
  });
});

describe("address checks before any request", () => {
  it("never calls the transport for an unsafe first URL", async () => {
    const { transport, calls } = makeTransport(() => reply(200, "ok"));
    for (const raw of ["http://127.0.0.1/", "http://169.254.169.254/latest/meta-data/", "http://localhost/", "file:///etc/passwd", "https://u:p@example.com/", "http://example.com:8080/", "http://[::1]/"]) {
      expectFailure(await safeRequest(raw, {}, { request: transport, resolve: resolverWith() }), "unsafe_url");
    }
    expect(calls).toHaveLength(0);
  });

  it("refuses a name that resolves to a private address", async () => {
    const { transport, calls } = makeTransport(() => reply(200, "ok"));
    const resolve = resolverWith({ "evil.example.com": ["10.0.0.5"], "mixed.example.com": [PUBLIC_IP, "192.168.1.1"] });
    expectFailure(await safeRequest("https://evil.example.com/", {}, { request: transport, resolve }), "unsafe_url");
    expectFailure(await safeRequest("https://mixed.example.com/", {}, { request: transport, resolve }), "unsafe_url");
    expect(calls).toHaveLength(0);
  });

  it("reports a name that does not exist as unresolvable, not unsafe", async () => {
    const { transport } = makeTransport(() => reply(200, "ok"));
    const resolve: Resolver = async () => {
      throw Object.assign(new Error("nx"), { code: "ENOTFOUND" });
    };
    const f = expectFailure(await safeRequest("https://nope.example.com/", {}, { request: transport, resolve }), "unresolvable");
    expect(f.message).toMatch(/couldn't find a website/);
  });

  it("does not put the URL, query string or key in any failure message", async () => {
    const secret = "TOP-SECRET-KEY-9f8e";
    const { transport } = makeTransport(() => {
      throw Object.assign(new Error(`connect ECONNREFUSED 10.1.2.3:443 ${secret}`), { code: "ECONNREFUSED" });
    });
    const urls = [`https://example.com/x?key=${secret}`, `http://127.0.0.1/?key=${secret}`, `ftp://example.com/?key=${secret}`, `https://example.com:9999/?key=${secret}`];
    for (const url of urls) {
      const r = await safeRequest(url, { headers: { "x-goog-api-key": secret } }, { request: transport, resolve: resolverWith() });
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(secret);
      expect(JSON.stringify(r)).not.toContain("10.1.2.3");
    }
  });
});

describe("redirects", () => {
  it("follows a relative Location, resolving it against the current URL", async () => {
    const { transport, calls } = makeTransport((_req, i) => {
      if (i === 0) return redirect("../up/next?a=1");
      if (i === 1) return redirect("//cdn.example.org/protocol-relative");
      if (i === 2) return redirect("?only=query");
      return reply(200, "<p>end</p>");
    });
    const res = expectOk(await safeRequest("https://example.com/a/b/start", {}, { request: transport, resolve: resolverWith() }));
    expect(calls.map((c) => c.url)).toEqual([
      "https://example.com/a/b/start",
      "https://example.com/a/up/next?a=1",
      "https://cdn.example.org/protocol-relative",
      "https://cdn.example.org/protocol-relative?only=query",
    ]);
    expect(res.finalUrl).toBe("https://cdn.example.org/protocol-relative?only=query");
    expect(res.redirects).toBe(3);
    expect(res.status).toBe(200);
  });

  it("handles every redirect status", async () => {
    for (const status of [301, 302, 303, 307, 308]) {
      const { transport, calls } = makeTransport((_req, i) => (i === 0 ? redirect("/final", status) : reply(200, "ok")));
      const res = expectOk(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }));
      expect(res.finalUrl, String(status)).toBe("https://example.com/final");
      expect(calls).toHaveLength(2);
    }
  });

  it("follows exactly 5 redirects and refuses a 6th", async () => {
    const chain = (n: number) => makeTransport((_req, i) => (i < n ? redirect(`/hop${i + 1}`) : reply(200, "<p>arrived</p>")));
    const five = chain(5);
    const ok = expectOk(await safeRequest("https://example.com/", {}, { request: five.transport, resolve: resolverWith() }));
    expect(ok.redirects).toBe(5);
    expect(five.calls).toHaveLength(6);

    const six = chain(6);
    const failure = expectFailure(await safeRequest("https://example.com/", {}, { request: six.transport, resolve: resolverWith() }), "too_many_redirects");
    expect(failure.message).toMatch(/more than 5 times/);
    expect(six.calls).toHaveLength(6); // it stopped at the sixth redirect answer and requested nothing more
  });

  it("stops a redirect loop", async () => {
    const { transport, calls } = makeTransport(() => redirect("/loop"));
    expectFailure(await safeRequest("https://example.com/loop", {}, { request: transport, resolve: resolverWith() }), "too_many_redirects");
    expect(calls.length).toBeLessThanOrEqual(6);
  });

  it("refuses a redirect from a public address to a private one, and never requests it", async () => {
    for (const target of [
      "http://169.254.169.254/latest/meta-data/",
      "http://127.0.0.1/admin",
      "http://localhost/",
      "http://[::1]/",
      "http://[fd00:ec2::254]/",
      "http://2130706433/",
      "http://10.0.0.1/",
      "http://metadata.google.internal/computeMetadata/v1/",
    ]) {
      const { transport, calls } = makeTransport((_req, i) => (i === 0 ? redirect(target) : reply(200, "SECRET INTERNAL PAGE")));
      const r = await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() });
      const f = expectFailure(r, "unsafe_url");
      expect(f.message).toMatch(/redirects to an address that isn't a public web address/);
      expect(calls, target).toHaveLength(1);
    }
  });

  it("refuses a redirect to a name that resolves to a private address", async () => {
    const { transport, calls } = makeTransport((_req, i) => (i === 0 ? redirect("https://internal-looking.example.org/") : reply(200, "x")));
    const resolve = resolverWith({ "internal-looking.example.org": ["10.9.9.9"] });
    expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve }), "unsafe_url");
    expect(calls).toHaveLength(1);
  });

  it("refuses a redirect that changes scheme to something that is not http or https", async () => {
    for (const target of ["file:///etc/passwd", "ftp://example.com/x", "gopher://example.com/", "javascript:alert(1)", "data:text/html,x"]) {
      const { transport, calls } = makeTransport((_req, i) => (i === 0 ? redirect(target) : reply(200, "x")));
      expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "unsafe_url");
      expect(calls, target).toHaveLength(1);
    }
  });

  it("refuses a redirect to a non-standard port or one carrying credentials", async () => {
    for (const target of ["http://example.org:8080/", "https://user:pw@example.org/", "http://example.org:22/"]) {
      const { transport, calls } = makeTransport((_req, i) => (i === 0 ? redirect(target) : reply(200, "x")));
      expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "unsafe_url");
      expect(calls).toHaveLength(1);
    }
  });

  it("explains an unreadable Location", async () => {
    const { transport } = makeTransport(() => redirect("http://[::1"));
    const f = expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "bad_redirect");
    expect(f.message).toMatch(/couldn't understand/);
  });

  it("returns a 3xx with no Location as an ordinary answer", async () => {
    const { transport } = makeTransport(() => reply(302, "", { "content-type": "text/html" }));
    const res = expectOk(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }));
    expect(res.status).toBe(302);
    expect(res.redirects).toBe(0);
    const blank = makeTransport(() => reply(301, "", { location: "   " }));
    expect(expectOk(await safeRequest("https://example.com/", {}, { request: blank.transport, resolve: resolverWith() })).status).toBe(301);
  });

  it("does not follow a redirect with a lower redirect limit", async () => {
    const { transport } = makeTransport(() => redirect("/again"));
    expectFailure(await safeRequest("https://example.com/", { maxRedirects: 0 }, { request: transport, resolve: resolverWith() }), "too_many_redirects");
  });

  it("calls the guard before following a redirect, and stops if it returns a failure", async () => {
    const guard = vi.fn(async (url: URL, _hop: number): Promise<SafeFailure | null> =>
      url.hostname === "blocked.example.org" ? { ok: false, code: "robots_disallowed", message: "No." } : null,
    );
    const first = makeTransport((_req, i) => (i === 0 ? redirect("https://allowed.example.org/p") : reply(200, "ok")));
    expectOk(await safeRequest("https://example.com/", { guard }, { request: first.transport, resolve: resolverWith() }));
    expect(guard).toHaveBeenCalledTimes(1);
    expect(guard.mock.calls[0]?.[0].href).toBe("https://allowed.example.org/p");
    expect(guard.mock.calls[0]?.[1]).toBe(1);

    const second = makeTransport((_req, i) => (i === 0 ? redirect("https://blocked.example.org/p") : reply(200, "ok")));
    const f = expectFailure(await safeRequest("https://example.com/", { guard }, { request: second.transport, resolve: resolverWith() }), "robots_disallowed");
    expect(f.message).toBe("No.");
    expect(second.calls).toHaveLength(1);
  });
});

describe("response size cap", () => {
  function infiniteBody(chunkSize: number) {
    let pulled = 0;
    let closed = false;
    const body: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            pulled++;
            return { done: false, value: new Uint8Array(chunkSize).fill(97) };
          },
          async return() {
            closed = true;
            return { done: true, value: undefined };
          },
        };
      },
    };
    return { body, stats: () => ({ pulled, closed }) };
  }

  it("aborts an endless body at the 2 MB cap instead of buffering it", async () => {
    const endless = infiniteBody(1024 * 1024);
    const destroy = vi.fn();
    const { transport } = makeTransport(() => ({ status: 200, headers: { "content-type": "text/html" }, body: endless.body, destroy }));
    const f = expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "too_large");
    expect(f.message).toMatch(/bigger than we can read \(over 2 MB\)/);
    expect(endless.stats().pulled).toBe(3); // 1 MB, 2 MB, then the chunk that crosses the cap
    expect(endless.stats().closed).toBe(true);
    expect(destroy).toHaveBeenCalled();
  });

  it("accepts a body of exactly the cap and refuses one byte more", async () => {
    const cap = 2 * 1024 * 1024;
    const exact = makeTransport(() => reply(200, new Uint8Array(cap).fill(97)));
    const ok = expectOk(await safeRequest("https://example.com/", {}, { request: exact.transport, resolve: resolverWith() }));
    expect(ok.body).toHaveLength(cap);
    const over = makeTransport(() => reply(200, new Uint8Array(cap + 1).fill(97), { "content-length": undefined }));
    expectFailure(await safeRequest("https://example.com/", {}, { request: over.transport, resolve: resolverWith() }), "too_large");
  });

  it("counts bytes across many small chunks", async () => {
    let produced = 0;
    const { transport } = makeTransport(() => ({
      status: 200,
      headers: { "content-type": "text/plain" },
      body: (async function* () {
        for (;;) {
          produced += 1000;
          yield new Uint8Array(1000);
          if (produced > 10_000_000) return; // safety net so a bug cannot hang the test
        }
      })(),
    }));
    expectFailure(await safeRequest("https://example.com/", { maxBytes: 5000 }, { request: transport, resolve: resolverWith() }), "too_large");
    expect(produced).toBeLessThanOrEqual(6000);
  });

  it("refuses at once when Content-Length already says it is too big, without reading", async () => {
    const endless = infiniteBody(1024);
    const { transport } = makeTransport(() => ({ status: 200, headers: { "content-type": "text/html", "content-length": String(5 * 1024 * 1024) }, body: endless.body, destroy: vi.fn() }));
    expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "too_large");
    expect(endless.stats().pulled).toBe(0);
  });

  it("can keep the first part instead of failing (used for robots.txt)", async () => {
    const { transport } = makeTransport(() => reply(200, "A".repeat(100) + "B".repeat(100)));
    const res = expectOk(await safeRequest("https://example.com/", { maxBytes: 150, onOverflow: "truncate" }, { request: transport, resolve: resolverWith() }));
    expect(res.truncated).toBe(true);
    expect(res.body).toBe("A".repeat(100) + "B".repeat(50));
    const small = makeTransport(() => reply(200, "tiny"));
    expect(expectOk(await safeRequest("https://example.com/", { maxBytes: 150, onOverflow: "truncate" }, { request: small.transport, resolve: resolverWith() })).truncated).toBe(false);
  });

  it("honours a smaller cap set by the caller", async () => {
    const { transport } = makeTransport(() => reply(200, "x".repeat(2000)));
    expectFailure(await safeRequest("https://example.com/", { maxBytes: 1000 }, { request: transport, resolve: resolverWith() }), "too_large");
  });
});

describe("timeouts", () => {
  it("gives up on a response that never arrives, and tells the transport to stop", async () => {
    let aborted = false;
    const { transport } = makeTransport(
      (req) =>
        new Promise<TransportResponse>((_resolve, reject) => {
          req.signal.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const started = Date.now();
    const f = expectFailure(await safeRequest("https://example.com/", { timeoutMs: 40 }, { request: transport, resolve: resolverWith() }), "timeout");
    expect(f.message).toMatch(/took too long to answer/);
    expect(aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("gives up even if the transport ignores the abort signal", async () => {
    const { transport } = makeTransport(() => new Promise<TransportResponse>(() => undefined));
    expectFailure(await safeRequest("https://example.com/", { timeoutMs: 30 }, { request: transport, resolve: resolverWith() }), "timeout");
  });

  it("gives up on a body that starts and then stalls, and closes it", async () => {
    let closed = false;
    const { transport } = makeTransport(() => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: {
        [Symbol.asyncIterator]() {
          let sent = false;
          return {
            async next() {
              if (!sent) {
                sent = true;
                return { done: false, value: Buffer.from("<html>start") };
              }
              return new Promise<IteratorResult<Uint8Array>>(() => undefined);
            },
            async return() {
              closed = true;
              return { done: true, value: undefined };
            },
          };
        },
      },
      destroy: () => {
        closed = true;
      },
    }));
    expectFailure(await safeRequest("https://example.com/", { timeoutMs: 30 }, { request: transport, resolve: resolverWith() }), "timeout");
    expect(closed).toBe(true);
  });

  it("gives up if DNS never answers", async () => {
    const resolve: Resolver = () => new Promise(() => undefined);
    const { transport, calls } = makeTransport(() => reply(200, "x"));
    expectFailure(await safeRequest("https://example.com/", { timeoutMs: 30 }, { request: transport, resolve }), "timeout");
    expect(calls).toHaveLength(0);
  });

  it("counts the whole chain against one deadline, using the injected clock", async () => {
    let clock = 1_000_000;
    const { transport, calls } = makeTransport(() => {
      clock += 5000; // each hop "takes" 5 seconds
      return redirect("/again");
    });
    const f = expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith(), now: () => clock }), "timeout");
    expect(f.message).toMatch(/more than 8 seconds/);
    expect(calls).toHaveLength(2); // the third hop was never started
  });

  it("notices a deadline passing while the body streams", async () => {
    let clock = 0;
    const { transport } = makeTransport(() => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: (async function* () {
        yield Buffer.from("a");
        clock += 9000;
        yield Buffer.from("b");
        yield Buffer.from("c");
      })(),
    }));
    expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith(), now: () => clock }), "timeout");
  });

  it("does not time out a fast answer", async () => {
    const { transport } = makeTransport(() => reply(200, "<p>fast</p>"));
    const res = expectOk(await safeRequest("https://example.com/", { timeoutMs: 5000 }, { request: transport, resolve: resolverWith() }));
    expect(res.body).toBe("<p>fast</p>");
  });
});

describe("content types and decoding", () => {
  it("returns ok with an empty body for a PDF, and says what it was", async () => {
    const destroy = vi.fn();
    const endless = (async function* () {
      yield Buffer.from("%PDF-1.7 ...");
    })();
    const { transport } = makeTransport(() => ({ status: 200, headers: { "content-type": "application/pdf" }, body: endless, destroy }));
    const res = expectOk(await safeRequest("https://example.com/paper.pdf", {}, { request: transport, resolve: resolverWith() }));
    expect(res.status).toBe(200);
    expect(res.contentType).toBe("application/pdf");
    expect(res.body).toBe("");
    expect(res.bodyRead).toBe(false);
    expect(destroy).toHaveBeenCalled();
  });

  it.each(["image/png", "image/jpeg", "video/mp4", "application/octet-stream", "application/zip", "application/vnd.ms-excel", "font/woff2"])("does not read a %s body", async (type) => {
    const { transport } = makeTransport(() => reply(200, "binary", { "content-type": type }));
    const res = expectOk(await safeRequest("https://example.com/f", {}, { request: transport, resolve: resolverWith() }));
    expect(res.body).toBe("");
    expect(res.bodyRead).toBe(false);
    expect(res.contentType).toBe(type);
  });

  it.each(["text/html", "text/plain; charset=utf-8", "application/xhtml+xml", "application/json", "application/ld+json", "text/xml", "application/atom+xml", "TEXT/HTML"])("reads a %s body", async (type) => {
    const { transport } = makeTransport(() => reply(200, "hello", { "content-type": type }));
    const res = expectOk(await safeRequest("https://example.com/f", {}, { request: transport, resolve: resolverWith() }));
    expect(res.body).toBe("hello");
    expect(res.bodyRead).toBe(true);
  });

  it("treats a missing content type as text", async () => {
    const { transport } = makeTransport(() => reply(200, "plain", { "content-type": undefined }));
    const res = expectOk(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }));
    expect(res.body).toBe("plain");
    expect(res.contentType).toBe("");
  });

  it("reads any body when the caller asks (JSON APIs)", async () => {
    const { transport } = makeTransport(() => reply(200, '{"a":1}', { "content-type": "application/vnd.api+json-ish" }));
    const res = expectOk(await safeRequest("https://example.com/", { readBody: "always" }, { request: transport, resolve: resolverWith() }));
    expect(res.body).toBe('{"a":1}');
  });

  it("reports error statuses as answers, with the body, so the caller can classify them", async () => {
    const { transport } = makeTransport(() => reply(503, "<title>Just a moment...</title>"));
    const res = expectOk(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }));
    expect(res.status).toBe(503);
    expect(res.body).toContain("Just a moment");
  });

  it("refuses a body in a compressed form it did not ask for", async () => {
    const { transport } = makeTransport(() => reply(200, "\u001f\u008b", { "content-encoding": "gzip" }));
    expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "unsupported_encoding");
    const ident = makeTransport(() => reply(200, "fine", { "content-encoding": "identity" }));
    expect(expectOk(await safeRequest("https://example.com/", {}, { request: ident.transport, resolve: resolverWith() })).body).toBe("fine");
  });

  it("decodes with the charset in Content-Type", async () => {
    const latin1 = Buffer.from([0x50, 0x72, 0x69, 0x63, 0x65, 0x3a, 0x20, 0xa3, 0x35]); // "Price: £5" in ISO-8859-1
    const a = makeTransport(() => reply(200, latin1, { "content-type": "text/html; charset=ISO-8859-1" }));
    expect(expectOk(await safeRequest("https://example.com/", {}, { request: a.transport, resolve: resolverWith() })).body).toBe("Price: £5");
    const b = makeTransport(() => reply(200, Buffer.from([0x80, 0x31]), { "content-type": 'text/html; charset="windows-1252"' }));
    expect(expectOk(await safeRequest("https://example.com/", {}, { request: b.transport, resolve: resolverWith() })).body).toBe("€1");
  });

  it("decodes the web's Latin-1 labels as windows-1252, so smart quotes and dashes survive", () => {
    const bytes = Buffer.from([0x93, 0x68, 0x69, 0x94, 0x20, 0x96, 0x20, 0x80, 0x35, 0x20, 0x91, 0x73, 0x92, 0x20, 0x85, 0x20, 0xa3, 0xe9]);
    const expected = "“hi” – €5 ‘s’ … £é";
    for (const label of ["iso-8859-1", "latin1", "windows-1252", "us-ascii", "cp1252", "ISO8859-1"]) {
      expect(decodeBody(bytes, `text/html; charset=${label}`), label).toBe(expected);
    }
  });

  it("decodes a large windows-1252 body correctly", () => {
    const big = Buffer.alloc(100_000, 0x93);
    const text = decodeBody(big, "text/html; charset=windows-1252");
    expect(text).toHaveLength(100_000);
    expect(text.startsWith("““")).toBe(true);
    expect(text.endsWith("“")).toBe(true);
  });

  it("still decodes other legacy charsets with the platform decoder", () => {
    expect(decodeBody(Buffer.from([0xc1, 0xc2]), "text/html; charset=windows-1251")).toBe("БВ");
    expect(decodeBody(Buffer.from([0xa4]), "text/html; charset=iso-8859-15")).toBe("€");
  });

  it("defaults to UTF-8, strips a byte-order mark, and joins characters split across chunks", async () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Café £5 – 日本")]);
    const { transport } = makeTransport(() => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: (async function* () {
        for (let i = 0; i < bytes.length; i += 2) yield bytes.subarray(i, i + 2); // 2-byte chunks split multi-byte characters
      })(),
    }));
    expect(expectOk(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() })).body).toBe("Café £5 – 日本");
  });

  it("falls back to UTF-8 for a charset name it does not know", () => {
    expect(decodeBody(Buffer.from("héllo"), "text/html; charset=not-a-real-charset")).toBe("héllo");
    expect(decodeBody(Buffer.from("héllo"), "text/html; charset=")).toBe("héllo");
  });

  it("replaces invalid bytes instead of throwing", () => {
    expect(decodeBody(Buffer.from([0x61, 0xff, 0x62]), "text/html; charset=utf-8")).toBe("a�b");
  });

  it("uses an HTML meta charset when the header has none", () => {
    const html = Buffer.concat([Buffer.from('<html><head><meta charset="windows-1252"></head><body>caf'), Buffer.from([0xe9]), Buffer.from("</body>")]);
    expect(decodeBody(html, "text/html")).toContain("café");
    const old = Buffer.concat([Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">x'), Buffer.from([0xa3])]);
    expect(decodeBody(old, "text/html")).toContain("x£");
    // The header wins over the meta tag.
    expect(decodeBody(Buffer.from('<meta charset="iso-8859-1">é'), "text/html; charset=utf-8")).toContain("é");
  });

  it("recognises text-like content types", () => {
    expect(isTextContentType("")).toBe(true);
    expect(isTextContentType("text/css")).toBe(true);
    expect(isTextContentType("application/pdf")).toBe(false);
    expect(isTextContentType("image/svg+xml")).toBe(true);
  });
});

describe("transport errors become plain failures and never throw", () => {
  const cases: Array<[string, SafeFailure["code"], string]> = [
    ["ENOTFOUND", "unresolvable", "ENOTFOUND"],
    ["EAI_AGAIN", "dns_failed", "EAI_AGAIN"],
    ["ECONNREFUSED", "network", "ECONNREFUSED"],
    ["ECONNRESET", "network", "ECONNRESET"],
    ["UND_ERR_CONNECT_TIMEOUT", "timeout", "UND_ERR_CONNECT_TIMEOUT"],
    ["UND_ERR_HEADERS_TIMEOUT", "timeout", "UND_ERR_HEADERS_TIMEOUT"],
    ["UND_ERR_BODY_TIMEOUT", "timeout", "UND_ERR_BODY_TIMEOUT"],
    ["CERT_HAS_EXPIRED", "tls", "CERT_HAS_EXPIRED"],
    ["DEPTH_ZERO_SELF_SIGNED_CERT", "tls", "DEPTH_ZERO_SELF_SIGNED_CERT"],
    ["ERR_CPD_BLOCKED_ADDRESS", "unsafe_url", "ERR_CPD_BLOCKED_ADDRESS"],
  ];
  it.each(cases)("%s becomes %s", async (code, expected) => {
    const { transport } = makeTransport(() => {
      throw Object.assign(new Error(`internal detail 10.9.8.7 ${code}`), { code });
    });
    const f = expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), expected);
    expect(f.message).not.toContain("10.9.8.7");
    expect(f.message).not.toContain("internal detail");
  });

  it("finds the code on a wrapped cause", async () => {
    const { transport } = makeTransport(() => {
      throw new Error("fetch failed", { cause: Object.assign(new Error("inner"), { code: "ENOTFOUND" }) });
    });
    expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "unresolvable");
  });

  it("copes with a transport that throws something that is not an Error", async () => {
    const { transport } = makeTransport(() => {
      throw "just a string";
    });
    expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "network");
  });

  it("copes with an error while the body streams", async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: (async function* () {
        yield Buffer.from("start");
        throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
      })(),
    }));
    expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "network");
  });
});

// ---------------------------------------------------------------------------------------------
// Real sockets on the loopback interface only. No internet is touched.
// ---------------------------------------------------------------------------------------------

interface TestServer {
  port: number;
  connections: () => number;
  requests: () => Array<{ url: string; headers: http.IncomingHttpHeaders }>;
  close: () => Promise<void>;
}

async function startServer(handler?: http.RequestListener): Promise<TestServer> {
  let connections = 0;
  const seen: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];
  const server = http.createServer((req, res) => {
    seen.push({ url: req.url ?? "", headers: req.headers });
    if (handler) return handler(req, res);
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<p>you reached the server</p>");
  });
  server.on("connection", () => {
    connections++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    port,
    connections: () => connections,
    requests: () => seen,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

describe("real sockets (loopback only)", () => {
  const servers: TestServer[] = [];
  const transports: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.close()));
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });
  async function server(handler?: http.RequestListener) {
    const s = await startServer(handler);
    servers.push(s);
    return s;
  }

  it("refuses a loopback URL before any connection is made (the server records zero connections)", async () => {
    const s = await server();
    const attempts = [
      `http://127.0.0.1:${s.port}/`,
      `http://localhost:${s.port}/`,
      `http://[::1]:${s.port}/`,
      `http://2130706433:${s.port}/`,
      `http://0x7f.0.0.1:${s.port}/`,
      `http://127.1:${s.port}/`,
      `http://[::ffff:127.0.0.1]:${s.port}/`,
    ];
    for (const url of attempts) {
      const r = await safeRequest(url); // no injected parts: the real resolver and the real HTTP agent
      expectFailure(r, "unsafe_url");
    }
    await settle();
    expect(s.connections()).toBe(0);
    expect(s.requests()).toHaveLength(0);
  });

  it("refuses a name that resolves to loopback before connecting", async () => {
    const s = await server();
    const resolve = resolverWith({ "rebind.example.com": ["127.0.0.1"] });
    // Use the standard port in the text so only the address rule is in play; nothing listens there, and nothing is dialled.
    const r = await safeRequest("http://rebind.example.com/", {}, { resolve });
    expectFailure(r, "unsafe_url");
    await settle();
    expect(s.connections()).toBe(0);
  });

  it("the real transport sends our headers, no cookies, and does not follow a redirect itself", async () => {
    const s = await server((req, res) => {
      if (req.url === "/redir") {
        res.writeHead(302, { location: "/elsewhere", "set-cookie": "sid=1; Path=/" });
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("hello");
    });
    const transport = createUndiciTransport();
    transports.push(transport);
    const headers = { "user-agent": "CPDLoggerBot/1.0 (+test@example.com)", accept: "text/html", "accept-encoding": "identity" };
    const res = await transport({ url: new URL(`http://127.0.0.1:${s.port}/redir`), headers, signal: new AbortController().signal });
    expect(res.status).toBe(302);
    expect(res.headers["location"]).toBe("/elsewhere");
    res.destroy?.();
    await settle();
    expect(s.requests().map((r) => r.url)).toEqual(["/redir"]); // /elsewhere was never requested
    const sent = s.requests()[0]?.headers ?? {};
    expect(sent["user-agent"]).toBe("CPDLoggerBot/1.0 (+test@example.com)");
    expect(sent["cookie"]).toBeUndefined();
    expect(sent["authorization"]).toBeUndefined();

    const second = await transport({ url: new URL(`http://127.0.0.1:${s.port}/page`), headers, signal: new AbortController().signal });
    let text = "";
    for await (const chunk of second.body) text += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    expect(text).toBe("hello");
    expect(s.requests()[1]?.headers["cookie"]).toBeUndefined();
  });

  it("the real transport honours the abort signal", async () => {
    const s = await server(() => {
      // never answer
    });
    const transport = createUndiciTransport();
    transports.push(transport);
    const controller = new AbortController();
    const pending = transport({ url: new URL(`http://127.0.0.1:${s.port}/slow`), headers: {}, signal: controller.signal });
    setTimeout(() => controller.abort(), 30);
    await expect(pending).rejects.toBeDefined();
  });

  it("the connection itself refuses a name that now resolves to loopback (DNS rebinding after the check)", async () => {
    const s = await server();
    // The agent's lookup is given a resolver that answers loopback. Even with no assertSafeUrl in front,
    // the socket must never be opened.
    const transport = createUndiciTransport({ resolve: async () => [{ address: "127.0.0.1", family: 4 }] });
    transports.push(transport);
    const error = await transport({ url: new URL(`http://rebind.example.com:${s.port}/`), headers: {}, signal: new AbortController().signal }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    expect(code).toBe("ERR_CPD_BLOCKED_ADDRESS");
    await settle();
    expect(s.connections()).toBe(0);
    expect(s.requests()).toHaveLength(0);
  });

  it("https connections go through the same validating lookup", async () => {
    // No server is needed: the lookup refuses before any socket opens, so nothing is dialled and no certificate is involved.
    let asked = 0;
    const transport = createUndiciTransport({
      resolve: async () => {
        asked++;
        return [{ address: "169.254.169.254", family: 4 }];
      },
    });
    transports.push(transport);
    const error = await transport({ url: new URL("https://rebind.example.com/"), headers: {}, signal: new AbortController().signal }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    const code = (error as { code?: string; cause?: { code?: string } }).code ?? (error as { cause?: { code?: string } }).cause?.code;
    expect(code).toBe("ERR_CPD_BLOCKED_ADDRESS");
    expect(asked).toBeGreaterThanOrEqual(1);
  });

  it("safeRequest turns that connect-time refusal into an unsafe_url answer", async () => {
    // First answer public (passes the pre-check), then loopback (what a rebinding server would do on the second lookup).
    const s = await server();
    let calls = 0;
    const resolve: Resolver = async () => {
      calls++;
      return [{ address: calls === 1 ? PUBLIC_IP : "127.0.0.1", family: 4 }];
    };
    const transport = createUndiciTransport({ resolve });
    transports.push(transport);
    const r = await safeRequest(`http://rebind.example.com/`, {}, { resolve, request: transport });
    expectFailure(r, "unsafe_url");
    expect(calls).toBeGreaterThanOrEqual(2);
    await settle();
    expect(s.connections()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------------------------

const PRINTABLE_ASCII = /^[\u0020-\u007e]+$/;

describe("user agent: printable ASCII only", () => {
  it("turns accents into plain letters and drops anything else outside printable ASCII", () => {
    expect(buildUserAgent("ops@example.com \u2014 Zo\u00eb")).toBe("CPDLoggerBot/1.0 (+ops@example.com Zoe)");
    expect(buildUserAgent("Caf\u00e9 \u2615 ops@example.com")).toBe("CPDLoggerBot/1.0 (+Cafe ops@example.com)");
    expect(buildUserAgent("ops@example.com \ud83d\ude00")).toBe("CPDLoggerBot/1.0 (+ops@example.com)");
    expect(buildUserAgent("\ufb01le@example.com")).toBe("CPDLoggerBot/1.0 (+file@example.com)");
  });

  it("falls back to contact-not-set when nothing printable is left", () => {
    expect(buildUserAgent("\u65e5\u672c\u8a9e")).toBe("CPDLoggerBot/1.0 (+contact-not-set)");
    expect(buildUserAgent("\ud83d\ude00\ud83d\ude00")).toBe("CPDLoggerBot/1.0 (+contact-not-set)");
    expect(buildUserAgent("\ud800")).toBe("CPDLoggerBot/1.0 (+contact-not-set)"); // a lone surrogate
  });

  it("never produces a character the HTTP client would refuse, whatever the contact holds", () => {
    const nasty = ["\u2014", "\u00e9", "\u0000", "\u007f", "\u0085", "\u00a0", "\u2028", "\u200b", "\ud83d", "\ufeff", "ops@example.com", " ", "\t", "\r\n"];
    for (let i = 0; i < nasty.length; i++) {
      for (let j = 0; j < nasty.length; j++) {
        const ua = buildUserAgent(`${nasty[i]}${nasty[j]}x${nasty[j]}${nasty[i]}`);
        expect(ua, JSON.stringify([nasty[i], nasty[j]])).toMatch(PRINTABLE_ASCII);
      }
    }
  });

  it("keeps at most 200 characters of the contact, and no trailing space where it was cut", () => {
    expect(MAX_CONTACT_CHARS).toBe(200);
    expect(buildUserAgent("a".repeat(300))).toBe(`CPDLoggerBot/1.0 (+${"a".repeat(200)})`);
    expect(buildUserAgent("a".repeat(200))).toBe(`CPDLoggerBot/1.0 (+${"a".repeat(200)})`);
    expect(buildUserAgent("a".repeat(199))).toBe(`CPDLoggerBot/1.0 (+${"a".repeat(199)})`);
    expect(buildUserAgent(`${"a".repeat(199)} ${"b".repeat(50)}`)).toBe(`CPDLoggerBot/1.0 (+${"a".repeat(199)})`);
    expect(buildUserAgent(`${"\u00e9".repeat(500)}`)).toBe(`CPDLoggerBot/1.0 (+${"e".repeat(200)})`);
  });

  it("is what the transport receives, even for a contact with an em dash and an accent", async () => {
    const { transport, calls } = makeTransport(() => reply(200, "<p>hi</p>"));
    expectOk(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith(), contact: "ops@example.com \u2014 Zo\u00eb \u65e5\u672c" }));
    expect(calls[0]?.headers["user-agent"]).toBe("CPDLoggerBot/1.0 (+ops@example.com Zoe)");
    expect(calls[0]?.headers["user-agent"]).toMatch(PRINTABLE_ASCII);
  });
});

describe("request headers: values the HTTP client would throw on", () => {
  it.each([["an em dash", "key\u20141"], ["CJK text", "\u65e5\u672c\u8a9e"], ["an emoji", "k\ud83d\ude00"], ["U+0100", "\u0100"]])(
    "refuses a header value with %s before any request, and says so in plain words",
    async (_name, value) => {
      const { transport, calls } = makeTransport(() => reply(200, "ok"));
      const f = expectFailure(await safeRequest("https://example.com/", { headers: { "x-api-key": value } }, { request: transport, resolve: resolverWith() }), "bad_request");
      expect(f.message).toBe(SAFE_REQUEST_MESSAGES.bad_header);
      expect(f.message).not.toContain(value);
      expect(calls).toHaveLength(0);
    },
  );

  it("still sends a value with characters up to U+00FF, and says cookies only for cookies", async () => {
    const { transport, calls } = makeTransport(() => reply(200, "ok"));
    expectOk(await safeRequest("https://example.com/", { headers: { "x-note": "caf\u00e9" } }, { request: transport, resolve: resolverWith() }));
    expect(calls[0]?.headers["x-note"]).toBe("caf\u00e9");
    const refused = expectFailure(await safeRequest("https://example.com/", { headers: { cookie: "a=b" } }, { request: transport, resolve: resolverWith() }), "bad_request");
    expect(refused.message).toBe(SAFE_REQUEST_MESSAGES.bad_request);
    expect(calls).toHaveLength(1);
  });
});

describe("cookies in the second spelling are handled like cookies", () => {
  it("refuses to send Cookie2", async () => {
    const refused: Array<Record<string, string>> = [{ cookie2: "$Version=1" }, { Cookie2: "$Version=1" }];
    for (const headers of refused) {
      const { transport, calls } = makeTransport(() => reply(200, "ok"));
      expectFailure(await safeRequest("https://example.com/", { headers }, { request: transport, resolve: resolverWith() }), "bad_request");
      expect(calls).toHaveLength(0);
    }
  });

  it("drops Set-Cookie2 from the answer, whatever its case", async () => {
    const { transport } = makeTransport(() => reply(200, "<p>hi</p>", { "Set-Cookie2": "a=b", "set-cookie2": "c=d", "x-other": "kept" }));
    const res = expectOk(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }));
    expect(Object.keys(res.headers).map((k) => k.toLowerCase())).not.toContain("set-cookie2");
    expect(res.headers["x-other"]).toBe("kept");
  });
});

describe("a connect-time refusal says what happened on the first address, and only calls it a redirect when it was one", () => {
  const blocked = () => Object.assign(new Error("blocked"), { code: "ERR_CPD_BLOCKED_ADDRESS" });

  it("does not mention a redirect when the first address resolves to a private one at connect time", async () => {
    for (const make of [blocked, () => new BlockedAddressError()]) {
      const { transport } = makeTransport(() => {
        throw make();
      });
      const f = expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "unsafe_url");
      expect(f.message).toBe(UNSAFE_URL_MESSAGES.private_network);
      expect(f.message).not.toMatch(/redirect/i);
    }
  });

  it("does not mention a redirect when that happens while the body streams on the first address", async () => {
    const { transport } = makeTransport(() => ({
      status: 200,
      headers: { "content-type": "text/html" },
      body: (async function* () {
        yield Buffer.from("<p>");
        throw blocked();
      })(),
    }));
    const f = expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "unsafe_url");
    expect(f.message).not.toMatch(/redirect/i);
  });

  it("says a redirect when the refused address was reached by a redirect", async () => {
    const { transport } = makeTransport((_req, i) => {
      if (i === 0) return redirect("https://other.example.org/x");
      throw blocked();
    });
    const f = expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "unsafe_url");
    expect(f.message).toBe(SAFE_REQUEST_MESSAGES.redirect_unsafe);
    expect(f.message).toMatch(/redirects to an address that isn't a public web address/);
  });
});

describe("TLS errors: only a certificate problem blames the certificate", () => {
  it.each(["EPROTO", "ERR_SSL_WRONG_VERSION_NUMBER", "ERR_SSL_PROTOCOL_ERROR", "ERR_SSL_TLSV1_ALERT_PROTOCOL_VERSION"])("%s says the secure connection failed, not that a certificate was refused", async (code) => {
    const { transport } = makeTransport(() => {
      throw Object.assign(new Error(`handshake detail 10.9.8.7 ${code}`), { code });
    });
    const f = expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "tls");
    expect(f.message).toBe(SAFE_REQUEST_MESSAGES.tls_handshake);
    expect(f.message).toMatch(/couldn't make a secure connection/);
    expect(f.message).not.toMatch(/certificate/);
    expect(f.message).not.toContain("10.9.8.7");
  });

  it.each(["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "CERT_UNTRUSTED", "CERT_SIGNATURE_FAILURE", "SELF_SIGNED_CERT_IN_CHAIN", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID", "DEPTH_ZERO_SELF_SIGNED_CERT"])(
    "%s still says the certificate was not accepted",
    async (code) => {
      const { transport } = makeTransport(() => {
        throw Object.assign(new Error("x"), { code });
      });
      const f = expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "tls");
      expect(f.message).toBe(SAFE_REQUEST_MESSAGES.tls);
      expect(f.message).toMatch(/security certificate wasn't accepted/);
    },
  );

  it("finds the code on a wrapped cause", async () => {
    const { transport } = makeTransport(() => {
      throw new Error("fetch failed", { cause: Object.assign(new Error("inner"), { code: "EPROTO" }) });
    });
    expect(expectFailure(await safeRequest("https://example.com/", {}, { request: transport, resolve: resolverWith() }), "tls").message).toBe(SAFE_REQUEST_MESSAGES.tls_handshake);
  });
});

describe("extra headers are only ever sent over https", () => {
  it("refuses an http first address when there is a header to send, before any request", async () => {
    const { transport, calls } = makeTransport(() => reply(200, "ok"));
    const f = expectFailure(await safeRequest("http://api.example.com/x?a=1", { headers: { "x-goog-api-key": "SECRETKEY" } }, { request: transport, resolve: resolverWith() }), "unsafe_url");
    expect(f.message).toBe(SAFE_REQUEST_MESSAGES.insecure_headers);
    expect(JSON.stringify(f)).not.toContain("SECRETKEY");
    expect(calls).toHaveLength(0);
  });

  it("still allows http when there are no extra headers, and https when there are", async () => {
    const plain = makeTransport(() => reply(200, "ok"));
    expectOk(await safeRequest("http://api.example.com/x", {}, { request: plain.transport, resolve: resolverWith() }));
    expectOk(await safeRequest("http://api.example.com/x", { headers: {} }, { request: plain.transport, resolve: resolverWith() }));
    const secure = makeTransport(() => reply(200, "ok"));
    expectOk(await safeRequest("https://api.example.com/x", { headers: { "x-goog-api-key": "K" } }, { request: secure.transport, resolve: resolverWith() }));
    expect(secure.calls[0]?.headers["x-goog-api-key"]).toBe("K");
  });

  it("does not send the header on a redirect from https to http on the same host", async () => {
    const { transport, calls } = makeTransport((_req, i) => (i === 0 ? redirect("http://api.example.com/next") : reply(200, "ok")));
    expectOk(await safeRequest("https://api.example.com/x", { headers: { "x-goog-api-key": "K" } }, { request: transport, resolve: resolverWith() }));
    expect(calls.map((c) => c.headers["x-goog-api-key"])).toEqual(["K", undefined]);
  });

  it("ignores only the headers it sets itself, so a user agent alone does not count as an extra header", async () => {
    const { transport } = makeTransport(() => reply(200, "ok"));
    expectOk(await safeRequest("http://api.example.com/x", { headers: { "User-Agent": "x", Host: "y" } }, { request: transport, resolve: resolverWith() }));
  });
});

describe("real sockets: the user agent we build is accepted by the HTTP client", () => {
  const servers: TestServer[] = [];
  const transports: Array<{ close: () => Promise<void> }> = [];
  afterEach(async () => {
    await Promise.all(transports.splice(0).map((t) => t.close()));
    await Promise.all(servers.splice(0).map((s) => s.close()));
  });

  it("sends a contact with an em dash, an accent, CJK text and an emoji", async () => {
    const s = await startServer();
    servers.push(s);
    const transport = createUndiciTransport();
    transports.push(transport);
    const userAgent = buildUserAgent("ops@example.com \u2014 Zo\u00eb \u65e5\u672c\u8a9e \ud83d\ude00");
    const res = await transport({ url: new URL(`http://127.0.0.1:${s.port}/page`), headers: { "user-agent": userAgent, accept: "text/html" }, signal: new AbortController().signal });
    expect(res.status).toBe(200);
    res.destroy?.();
    await settle();
    expect(s.requests()[0]?.headers["user-agent"]).toBe("CPDLoggerBot/1.0 (+ops@example.com Zoe)");
  });
});
