import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getApiFetcher, getPageReader, resetNetSingletons } from "@/lib/net";
import { resetEnvCache } from "@/lib/env";

// The singletons are the only way the app builds the reader and the fetcher, and they are the only place the
// contact from the environment reaches the User-Agent. These tests run the real code from getPageReader() down to
// the HTTP client, with the HTTP client and the DNS lookup replaced, so no network is touched.

const seen = vi.hoisted(() => ({ requests: [] as Array<{ url: string; headers: Record<string, string> }> }));

vi.mock("node:dns", () => ({
  promises: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
}));

vi.mock("undici", () => {
  class Agent {
    close = async () => undefined;
  }
  const request = async (url: URL, options: { headers: Record<string, string> }) => {
    seen.requests.push({ url: url.href, headers: { ...options.headers } });
    const isRobots = url.pathname === "/robots.txt";
    const isJson = url.pathname.endsWith(".json");
    const body = isRobots ? "" : isJson ? '{"ok":true}' : "<html><body><h1>Bridge bearings webinar</h1><p>A one hour session.</p></body></html>";
    return {
      statusCode: isRobots ? 404 : 200,
      headers: { "content-type": isJson ? "application/json" : "text/html; charset=utf-8" },
      body: Readable.from([Buffer.from(body)]),
    };
  };
  return { Agent, request };
});

const saved = process.env.CPD_BOT_CONTACT;

function useContact(contact: string | undefined): void {
  if (contact === undefined) delete process.env.CPD_BOT_CONTACT;
  else process.env.CPD_BOT_CONTACT = contact;
  resetEnvCache();
  resetNetSingletons();
}

beforeEach(() => {
  seen.requests.length = 0;
});

afterEach(() => {
  useContact(saved);
});

describe("getPageReader and getApiFetcher publish the contact from the environment", () => {
  it("the page reader sends it on the robots.txt request and on the page request", async () => {
    useContact("ops@example.com");
    const out = await getPageReader().read("https://example.com/events/bearings");
    expect(out.kind).toBe("ok");
    expect(seen.requests.map((r) => new URL(r.url).pathname)).toEqual(["/robots.txt", "/events/bearings"]);
    for (const request of seen.requests) expect(request.headers["user-agent"]).toBe("CPDLoggerBot/1.0 (+ops@example.com)");
  });

  it("the API fetcher sends it", async () => {
    useContact("ops@example.com");
    const out = await getApiFetcher().getJson("https://www.googleapis.com/youtube/v3/videos.json");
    expect(out.kind).toBe("ok");
    expect(seen.requests).toHaveLength(1);
    expect(seen.requests[0]?.headers["user-agent"]).toBe("CPDLoggerBot/1.0 (+ops@example.com)");
  });

  it("a contact set to a link is published as given", async () => {
    useContact("https://example.org/bot-info");
    await getApiFetcher().getJson("https://www.googleapis.com/youtube/v3/videos.json");
    expect(seen.requests[0]?.headers["user-agent"]).toBe("CPDLoggerBot/1.0 (+https://example.org/bot-info)");
  });

  it("a contact with characters the HTTP client would refuse still works, as printable ASCII", async () => {
    useContact("ops@example.com — Zoë");
    expect((await getPageReader().read("https://example.com/events/bearings")).kind).toBe("ok");
    for (const request of seen.requests) expect(request.headers["user-agent"]).toBe("CPDLoggerBot/1.0 (+ops@example.com Zoe)");
  });

  it("says contact-not-set when the environment has no contact", async () => {
    useContact(undefined);
    await getPageReader().read("https://example.com/events/bearings");
    await getApiFetcher().getJson("https://www.googleapis.com/youtube/v3/videos.json");
    expect(seen.requests.length).toBeGreaterThanOrEqual(3);
    for (const request of seen.requests) expect(request.headers["user-agent"]).toBe("CPDLoggerBot/1.0 (+contact-not-set)");
  });

  it("builds each singleton once, and builds a new one after a reset with the new contact", async () => {
    useContact("first@example.com");
    const reader = getPageReader();
    expect(getPageReader()).toBe(reader);
    await reader.read("https://example.com/a");
    useContact("second@example.com");
    expect(getPageReader()).not.toBe(reader);
    await getPageReader().read("https://other.example.org/a");
    const agents = seen.requests.map((r) => r.headers["user-agent"]);
    expect(agents.slice(0, 2)).toEqual(["CPDLoggerBot/1.0 (+first@example.com)", "CPDLoggerBot/1.0 (+first@example.com)"]);
    expect(agents.slice(2)).toEqual(["CPDLoggerBot/1.0 (+second@example.com)", "CPDLoggerBot/1.0 (+second@example.com)"]);
  });

  it("still refuses an unsafe address before any request", async () => {
    useContact("ops@example.com");
    expect((await getPageReader().read("http://127.0.0.1/")).kind).toBe("unsafe_url");
    expect((await getApiFetcher().getJson("http://169.254.169.254/latest/meta-data/")).kind).toBe("unsafe_url");
    expect(seen.requests).toHaveLength(0);
  });
});
