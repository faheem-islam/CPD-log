import { describe, expect, it } from "vitest";
import { isSameOrigin } from "@/lib/security/same-origin";
import { createRateLimiter } from "@/lib/security/rate-limit";
import { redactSecrets } from "@/lib/security/redact";

const req = (method: string, headers: Record<string, string>) => new Request("http://localhost:3000/api/x", { method, headers });

describe("isSameOrigin", () => {
  it("allows safe methods", () => expect(isSameOrigin(req("GET", {}))).toBe(true));
  it("allows a matching Origin", () => expect(isSameOrigin(req("POST", { host: "localhost:3000", origin: "http://localhost:3000" }))).toBe(true));
  it("refuses a different Origin", () => expect(isSameOrigin(req("POST", { host: "localhost:3000", origin: "https://evil.example" }))).toBe(false));
  it("refuses a malformed Origin", () => expect(isSameOrigin(req("POST", { host: "localhost:3000", origin: "null" }))).toBe(false));
  it("accepts Sec-Fetch-Site same-origin when Origin is absent", () => {
    expect(isSameOrigin(req("POST", { host: "localhost:3000", "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(isSameOrigin(req("POST", { host: "localhost:3000", "sec-fetch-site": "cross-site" }))).toBe(false);
  });
  it("refuses a bare POST", () => expect(isSameOrigin(req("POST", { host: "localhost:3000" }))).toBe(false));
  it("prefers x-forwarded-host", () => expect(isSameOrigin(req("DELETE", { host: "internal:3000", "x-forwarded-host": "app.example", origin: "https://app.example" }))).toBe(true));
});

describe("createRateLimiter", () => {
  it("limits per key inside the window and recovers after it", () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
    expect(rl.check("a").allowed).toBe(true);
    expect(rl.check("a").allowed).toBe(true);
    const blocked = rl.check("a");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(1);
    expect(rl.check("b").allowed).toBe(true);
    t = 1001;
    expect(rl.check("a").allowed).toBe(true);
  });
});

describe("redactSecrets", () => {
  it("removes keys and auth headers", () => {
    const out = redactSecrets("fail sk-ant-abc123456789xyz and x-api-key: topsecretvalue and AIzaSyA1234567890abcdefghij");
    expect(out).not.toMatch(/abc123456789xyz|topsecretvalue|AIzaSy/);
    expect(out).toContain("[redacted]");
  });
  it("leaves ordinary text alone", () => expect(redactSecrets("Could not read the page")).toBe("Could not read the page"));
});
