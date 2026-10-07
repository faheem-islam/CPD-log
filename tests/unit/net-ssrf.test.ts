import { describe, expect, it, vi } from "vitest";
import {
  BlockedAddressError,
  UnsafeUrlError,
  assertSafeUrl,
  createValidatingLookup,
  isBlockedIp,
} from "@/lib/net/ssrf";
import type { ResolvedAddress, Resolver } from "@/lib/net/ssrf";

const PUBLIC_IP = "93.184.216.34";

/** A resolver that answers from a table and records what it was asked. Unknown names are NXDOMAIN. */
function fakeResolver(table: Record<string, string[]>) {
  return vi.fn<Resolver>(async (hostname) => {
    const found = table[hostname];
    if (!found) throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
    return found.map((address): ResolvedAddress => ({ address, family: address.includes(":") ? 6 : 4 }));
  });
}

const publicResolver = () => fakeResolver({ "example.com": [PUBLIC_IP], "www.example.com": [PUBLIC_IP] });

async function unsafeCode(raw: string, resolve: Resolver = publicResolver()): Promise<string> {
  try {
    await assertSafeUrl(raw, { resolve });
  } catch (e) {
    if (e instanceof UnsafeUrlError) return e.code;
    throw e;
  }
  return "allowed";
}

/** Teredo address embedding a server and a client IPv4 (the client part is stored inverted). */
function teredo(server: string, client: string): string {
  const [s0 = 0, s1 = 0, s2 = 0, s3 = 0] = server.split(".").map(Number);
  const [c0 = 0, c1 = 0, c2 = 0, c3 = 0] = client.split(".").map((n) => 255 - Number(n));
  const hex = (a: number, b: number) => ((a << 8) | b).toString(16);
  return `2001:0:${hex(s0, s1)}:${hex(s2, s3)}:0:0:${hex(c0, c1)}:${hex(c2, c3)}`;
}

describe("isBlockedIp: IPv4 ranges", () => {
  const blocked: Array<[string, string]> = [
    ["0.0.0.0/8", "0.0.0.0"],
    ["0.0.0.0/8", "0.1.2.3"],
    ["0.0.0.0/8", "0.255.255.255"],
    ["10/8", "10.0.0.0"],
    ["10/8", "10.1.2.3"],
    ["10/8", "10.255.255.255"],
    ["100.64/10", "100.64.0.0"],
    ["100.64/10", "100.100.100.100"],
    ["100.64/10", "100.127.255.255"],
    ["127/8", "127.0.0.1"],
    ["127/8", "127.1.2.3"],
    ["127/8", "127.255.255.254"],
    ["169.254/16 (cloud metadata)", "169.254.169.254"],
    ["169.254/16", "169.254.0.1"],
    ["169.254/16", "169.254.255.255"],
    ["172.16/12", "172.16.0.0"],
    ["172.16/12", "172.20.1.1"],
    ["172.16/12", "172.31.255.255"],
    ["192.0.0.0/24", "192.0.0.1"],
    ["192.0.0.0/24", "192.0.0.255"],
    ["192.0.2/24", "192.0.2.1"],
    ["192.88.99/24", "192.88.99.1"],
    ["192.168/16", "192.168.0.1"],
    ["192.168/16", "192.168.255.255"],
    ["198.18/15", "198.18.0.0"],
    ["198.18/15", "198.19.255.255"],
    ["198.51.100/24", "198.51.100.7"],
    ["203.0.113/24", "203.0.113.9"],
    ["224/4 multicast", "224.0.0.1"],
    ["224/4 multicast", "239.255.255.255"],
    ["240/4 reserved", "240.0.0.1"],
    ["240/4 reserved", "250.1.2.3"],
    ["broadcast", "255.255.255.255"],
  ];
  it.each(blocked)("blocks %s: %s", (_range, ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  // The first address just outside each range must NOT be blocked, so the table is not too greedy.
  const publicNeighbours = [
    "1.0.0.0",
    "9.255.255.255",
    "11.0.0.0",
    "100.63.255.255",
    "100.128.0.0",
    "126.255.255.255",
    "128.0.0.1",
    "169.253.255.255",
    "169.255.0.0",
    "172.15.255.255",
    "172.32.0.0",
    "192.0.1.1",
    "192.0.3.0",
    "192.88.98.255",
    "192.88.100.0",
    "192.167.255.255",
    "192.169.0.0",
    "198.17.255.255",
    "198.20.0.0",
    "198.51.99.255",
    "198.51.101.0",
    "203.0.112.255",
    "203.0.114.0",
    "223.255.255.255",
    "8.8.8.8",
    "1.1.1.1",
    "93.184.216.34",
    "151.101.1.69",
  ];
  it.each(publicNeighbours)("allows public address %s", (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it("understands the odd spellings of an IPv4 address", () => {
    for (const spelling of ["2130706433", "0x7f.0.0.1", "017700000001", "127.1", "0177.0.0.1", "0x7f000001", "2852039166", "0xa9fea9fe", "0251.0376.0251.0376", "167772161", "3232235521"]) {
      expect(isBlockedIp(spelling), spelling).toBe(true);
    }
    // 134744072 is 8.8.8.8 written as one decimal number
    expect(isBlockedIp("134744072")).toBe(false);
  });

  it("fails closed on text that is not an IP address", () => {
    for (const junk of ["", "   ", "not-an-ip", "999.1.1.1", "1.2.3.4.5", "08.8.8.8", "::g", "1:2:3:4:5:6:7:8:9", ":::", "1::2::3", "example.com"]) {
      expect(isBlockedIp(junk), JSON.stringify(junk)).toBe(true);
    }
    expect(isBlockedIp(undefined as unknown as string)).toBe(true);
    expect(isBlockedIp(null as unknown as string)).toBe(true);
    expect(isBlockedIp(42 as unknown as string)).toBe(true);
  });
});

describe("isBlockedIp: IPv6", () => {
  const blocked: Array<[string, string]> = [
    ["unspecified", "::"],
    ["loopback", "::1"],
    ["loopback, long form", "0:0:0:0:0:0:0:1"],
    ["loopback, in brackets", "[::1]"],
    ["link-local fe80::/10", "fe80::1"],
    ["link-local upper edge", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["link-local with zone id", "fe80::1%eth0"],
    ["old site-local", "fec0::1"],
    ["ULA fc00::/7", "fc00::1"],
    ["ULA fd", "fd12:3456:789a::1"],
    ["ULA upper edge", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff"],
    ["AWS metadata", "fd00:ec2::254"],
    ["multicast", "ff02::1"],
    ["discard-only", "100::1"],
    ["documentation", "2001:db8::1"],
    ["documentation 3fff", "3fff::1"],
    ["IETF protocol assignments", "2001:2::1"],
    ["SRv6 SIDs", "5f00::1"],
    ["IPv4-mapped loopback", "::ffff:127.0.0.1"],
    ["IPv4-mapped loopback, hex form", "::ffff:7f00:1"],
    ["IPv4-mapped private", "::ffff:10.1.2.3"],
    ["IPv4-mapped metadata", "::ffff:169.254.169.254"],
    ["IPv4-mapped unspecified", "::ffff:0.0.0.0"],
    ["IPv4-translated (SIIT) loopback", "::ffff:0:127.0.0.1"],
    ["IPv4-compatible loopback", "::127.0.0.1"],
    ["NAT64 loopback", "64:ff9b::7f00:1"],
    ["NAT64 loopback, dotted", "64:ff9b::127.0.0.1"],
    ["NAT64 metadata", "64:ff9b::a9fe:a9fe"],
    ["NAT64 private", "64:ff9b::10.0.0.1"],
    ["NAT64 local-use /48", "64:ff9b:1::1"],
    ["6to4 loopback", "2002:7f00:1::"],
    ["6to4 private 10/8", "2002:a00:1::1"],
    ["6to4 private 192.168", "2002:c0a8:101::"],
    ["6to4 metadata", "2002:a9fe:a9fe::1"],
    ["Teredo, private client", teredo("8.8.8.8", "10.0.0.1")],
    ["Teredo, loopback client", teredo("8.8.8.8", "127.0.0.1")],
    ["Teredo, private server", teredo("192.168.1.1", "8.8.4.4")],
    ["reserved space 4000::/3", "4000::1"],
    ["reserved space 8000::/1", "8000::1"],
    ["reserved space 0100::/8", "100:1::1"],
  ];
  it.each(blocked)("blocks %s: %s", (_name, ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  const allowed: Array<[string, string]> = [
    ["Cloudflare DNS", "2606:4700:4700::1111"],
    ["Google DNS", "2001:4860:4860::8888"],
    ["a Google web address", "2a00:1450:4009:81e::200e"],
    ["IPv4-mapped public", "::ffff:8.8.8.8"],
    ["NAT64 public", "64:ff9b::808:808"],
    ["6to4 public", "2002:808:808::1"],
    ["Teredo, public server and client", teredo("8.8.8.8", "8.8.4.4")],
    ["2001:200::/23 is public space", "2001:200::1"],
  ];
  it.each(allowed)("allows %s: %s", (_name, ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it("keeps the edges of the fe80::/10 and fc00::/7 ranges exact", () => {
    expect(isBlockedIp("fec0::1")).toBe(true); // site-local, deprecated but not public
    expect(isBlockedIp("fe7f::1")).toBe(true); // outside fe80::/10 but not global unicast either
    expect(isBlockedIp("fbff::1")).toBe(true);
    expect(isBlockedIp("2400:cb00::1")).toBe(false);
  });
});

describe("assertSafeUrl: what is allowed", () => {
  it("returns the parsed URL for a plain public address", async () => {
    const resolve = publicResolver();
    const url = await assertSafeUrl("https://example.com/a/b?x=1#frag", { resolve });
    expect(url).toBeInstanceOf(URL);
    expect(url.href).toBe("https://example.com/a/b?x=1#frag");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("example.com");
  });

  it("accepts the default and the explicit standard ports, either scheme", async () => {
    for (const raw of ["http://example.com:80/", "https://example.com:443/", "http://example.com:443/", "https://example.com:80/", "http://example.com/"]) {
      expect(await unsafeCode(raw), raw).toBe("allowed");
    }
  });

  it("accepts an uppercase scheme and host, and an international host name", async () => {
    const resolve = fakeResolver({ "example.com": [PUBLIC_IP], "xn--bcher-kva.example": [PUBLIC_IP] });
    expect((await assertSafeUrl("HTTPS://Example.COM/x", { resolve })).hostname).toBe("example.com");
    expect((await assertSafeUrl("https://bücher.example/", { resolve })).hostname).toBe("xn--bcher-kva.example");
  });

  it("accepts a public IP literal without asking DNS", async () => {
    const resolve = publicResolver();
    expect((await assertSafeUrl("https://8.8.8.8/", { resolve })).hostname).toBe("8.8.8.8");
    expect((await assertSafeUrl("https://[2606:4700:4700::1111]/", { resolve })).hostname).toBe("[2606:4700:4700::1111]");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("trims whitespace around the link", async () => {
    expect((await assertSafeUrl("  https://example.com/x  ", { resolve: publicResolver() })).pathname).toBe("/x");
  });

  it("accepts a trailing dot on a public name", async () => {
    const resolve = fakeResolver({ "example.com": [PUBLIC_IP] });
    await expect(assertSafeUrl("https://example.com./", { resolve })).resolves.toBeInstanceOf(URL);
    expect(resolve).toHaveBeenCalledWith("example.com");
  });
});

describe("assertSafeUrl: schemes, credentials and ports", () => {
  it.each(["file:///etc/passwd", "ftp://example.com/", "gopher://example.com/", "data:text/html,hello", "javascript:alert(1)", "ws://example.com/", "mailto:a@example.com", "blob:https://example.com/x"])(
    "refuses the scheme in %s",
    async (raw) => {
      const resolve = publicResolver();
      expect(await unsafeCode(raw, resolve)).toBe("scheme");
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it.each(["https://user:pass@example.com/", "https://user@example.com/", "https://:secret@example.com/", "http://example.com%2f@127.0.0.1/"])(
    "refuses credentials in %s",
    async (raw) => {
      expect(await unsafeCode(raw)).toBe("credentials");
    },
  );

  it.each(["http://example.com:8080/", "https://example.com:8443/", "http://example.com:22/", "http://example.com:25/", "http://example.com:6379/", "https://example.com:65535/", "http://example.com:1/"])(
    "refuses the port in %s",
    async (raw) => {
      const resolve = publicResolver();
      expect(await unsafeCode(raw, resolve)).toBe("port");
      expect(resolve).not.toHaveBeenCalled();
    },
  );

  it.each(["", "   ", "example.com/page", "not a url", "http://", "https://exa mple.com/", "http://exa\tmple.com/", "http://example.com/\nfoo", "http://[::1", "http://1.2.3.4.5/", "http://1.2.3.256/", "http://foo.0x7f/", "http://99999999999/", "//example.com/"])(
    "refuses text that is not a web address: %j",
    async (raw) => {
      expect(await unsafeCode(raw)).toBe("malformed");
    },
  );

  it("refuses things that are not strings", async () => {
    await expect(assertSafeUrl(undefined as unknown as string)).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeUrl(42 as unknown as string)).rejects.toBeInstanceOf(UnsafeUrlError);
    await expect(assertSafeUrl(null as unknown as string)).rejects.toBeInstanceOf(UnsafeUrlError);
  });

  it("refuses a very long link", async () => {
    expect(await unsafeCode(`https://example.com/${"a".repeat(3000)}`)).toBe("too_long");
  });

  it("refuses control characters the URL parser would silently delete", async () => {
    expect(await unsafeCode("https://exam\u0000ple.com/")).toBe("malformed");
    expect(await unsafeCode("https://example.com/\u007f")).toBe("malformed");
  });
});

describe("assertSafeUrl: blocked host names", () => {
  it.each([
    "http://localhost/",
    "http://LOCALHOST/",
    "http://localhost./",
    "http://localhost../",
    "http://foo.localhost/",
    "http://a.b.localhost/",
    "http://printer.local/",
    "http://db.internal/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://metadata.google.internal./",
    "http://metadata/",
    "http://router.lan/",
    "http://nas.home.arpa/",
    "http://intranet.corp/",
    "http://wiki.intranet/",
    "http://host.private/",
    "http://thing.localdomain/",
    "http://x.home/",
    "http://1.0.0.127.in-addr.arpa/",
    "http://hiddenservice.onion/",
    "http://intranet/",
    "http://printer/",
    "http://kubernetes/",
    "http://ip6-localhost/",
    "http://svc.cluster.local/",
  ])("refuses %s without asking DNS", async (raw) => {
    const resolve = publicResolver();
    const code = await unsafeCode(raw, resolve);
    expect(["blocked_host", "blocked_ip"]).toContain(code);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("does not block a public name that merely contains a blocked word", async () => {
    const resolve = fakeResolver({ "localhost.example.com": [PUBLIC_IP], "internal-audit.example.com": [PUBLIC_IP], "notlocal.com": [PUBLIC_IP] });
    for (const raw of ["https://localhost.example.com/", "https://internal-audit.example.com/", "https://notlocal.com/"]) {
      await expect(assertSafeUrl(raw, { resolve }), raw).resolves.toBeInstanceOf(URL);
    }
  });
});

describe("assertSafeUrl: IP literals in every spelling", () => {
  it.each([
    ["decimal", "http://2130706433/"],
    ["hex", "http://0x7f.0.0.1/"],
    ["hex, one number", "http://0x7f000001/"],
    ["octal", "http://017700000001/"],
    ["dotted octal", "http://0177.0.0.1/"],
    ["short form 127.1", "http://127.1/"],
    ["short form 127.0.1", "http://127.0.1/"],
    ["plain loopback", "http://127.0.0.1/"],
    ["other loopback", "http://127.5.5.5/"],
    ["zero", "http://0/"],
    ["0.0.0.0", "http://0.0.0.0/"],
    ["metadata decimal", "http://2852039166/"],
    ["metadata", "http://169.254.169.254/latest/meta-data/"],
    ["metadata hex", "http://0xa9fea9fe/"],
    ["private 10/8", "http://10.0.0.1/"],
    ["private 172.16/12", "http://172.16.0.1/"],
    ["private 192.168/16", "http://192.168.1.1/"],
    ["private decimal", "http://3232235777/"],
    ["CGNAT", "http://100.64.0.1/"],
    ["multicast", "http://224.0.0.1/"],
    ["broadcast", "http://255.255.255.255/"],
    ["full-width digits", "http://１２７.０.０.１/"],
    ["trailing dot", "http://127.0.0.1./"],
    ["percent-encoded dot", "http://127.0.0.1%2e/"],
    ["IPv6 loopback", "http://[::1]/"],
    ["IPv6 unspecified", "http://[::]/"],
    ["IPv4-mapped IPv6", "http://[::ffff:127.0.0.1]/"],
    ["IPv4-mapped IPv6, hex", "http://[::ffff:7f00:1]/"],
    ["AWS IPv6 metadata", "http://[fd00:ec2::254]/"],
    ["NAT64", "http://[64:ff9b::7f00:1]/"],
    ["NAT64, dotted", "http://[64:ff9b::127.0.0.1]/"],
    ["6to4", "http://[2002:7f00:1::]/"],
    ["link-local", "http://[fe80::1]/"],
    ["ULA", "http://[fc00::1]/"],
  ])("refuses %s: %s", async (_name, raw) => {
    const resolve = publicResolver();
    expect(await unsafeCode(raw, resolve)).toBe("blocked_ip");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("is not fooled by a URL parser difference around backslashes or @", async () => {
    // WHATWG treats "\" like "/", so the host here is 127.0.0.1, not example.com.
    expect(await unsafeCode("http://127.0.0.1\\@example.com/")).toBe("blocked_ip");
    // Here the host is example.com and "@127.0.0.1" is path text. The request must use the parsed URL.
    const url = await assertSafeUrl("http://example.com\\@127.0.0.1/", { resolve: publicResolver() });
    expect(url.hostname).toBe("example.com");
    expect(await unsafeCode("http://127.0.0.1#@example.com/")).toBe("blocked_ip");
    expect(await unsafeCode("http://example.com@127.0.0.1/")).toBe("credentials");
  });
});

describe("assertSafeUrl: the resolved address check", () => {
  it("refuses a name that resolves to a private address", async () => {
    for (const ip of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "192.168.0.10", "172.16.5.5", "100.64.1.1", "::1", "fd00:ec2::254", "fe80::1", "::ffff:10.0.0.1"]) {
      const resolve = fakeResolver({ "sneaky.example.com": [ip] });
      expect(await unsafeCode("https://sneaky.example.com/", resolve), ip).toBe("blocked_ip");
    }
  });

  it("refuses a name that resolves to a mix of public and private addresses", async () => {
    expect(await unsafeCode("https://mixed.example.com/", fakeResolver({ "mixed.example.com": [PUBLIC_IP, "10.0.0.5"] }))).toBe("blocked_ip");
    expect(await unsafeCode("https://mixed.example.com/", fakeResolver({ "mixed.example.com": ["10.0.0.5", PUBLIC_IP] }))).toBe("blocked_ip");
    expect(await unsafeCode("https://mixed.example.com/", fakeResolver({ "mixed.example.com": [PUBLIC_IP, "2606:4700:4700::1111", "127.0.0.1"] }))).toBe("blocked_ip");
    expect(await unsafeCode("https://mixed.example.com/", fakeResolver({ "mixed.example.com": ["2606:4700:4700::1111", "::1"] }))).toBe("blocked_ip");
  });

  it("allows a name whose addresses are all public, IPv4 and IPv6", async () => {
    const resolve = fakeResolver({ "ok.example.com": [PUBLIC_IP, "2606:4700:4700::1111", "8.8.8.8"] });
    await expect(assertSafeUrl("https://ok.example.com/", { resolve })).resolves.toBeInstanceOf(URL);
  });

  it("treats a resolver answer that is not a valid address as blocked", async () => {
    expect(await unsafeCode("https://weird.example.com/", fakeResolver({ "weird.example.com": ["not-an-ip"] }))).toBe("blocked_ip");
  });

  it("says the name could not be found when DNS has no answer", async () => {
    expect(await unsafeCode("https://missing.example.com/", fakeResolver({}))).toBe("unresolvable");
    expect(await unsafeCode("https://empty.example.com/", fakeResolver({ "empty.example.com": [] }))).toBe("unresolvable");
  });

  it("says DNS failed (not 'unsafe') on a temporary lookup error", async () => {
    const resolve: Resolver = async () => {
      throw Object.assign(new Error("timeout"), { code: "EAI_AGAIN" });
    };
    expect(await unsafeCode("https://slow.example.com/", resolve)).toBe("dns_failed");
    const odd: Resolver = async () => {
      throw new Error("something else");
    };
    expect(await unsafeCode("https://slow.example.com/", odd)).toBe("dns_failed");
  });

  it("asks DNS exactly once per call, with the lower-case host", async () => {
    const resolve = fakeResolver({ "example.com": [PUBLIC_IP] });
    await assertSafeUrl("https://EXAMPLE.com/path", { resolve });
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith("example.com");
  });
});

describe("UnsafeUrlError messages", () => {
  it("is an Error with a code, a friendly message, and never contains the link", async () => {
    const secret = "SUPER-SECRET-TOKEN";
    const inputs = [
      `http://127.0.0.1/?key=${secret}`,
      `https://user:${secret}@example.com/`,
      `ftp://example.com/?key=${secret}`,
      `http://example.com:8080/?key=${secret}`,
      `http://localhost/?key=${secret}`,
      `https://missing.example.com/?key=${secret}`,
      `http://exa mple.com/?key=${secret}`,
    ];
    for (const raw of inputs) {
      const err = await assertSafeUrl(raw, { resolve: fakeResolver({}) }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(UnsafeUrlError);
      expect(err).toBeInstanceOf(Error);
      const e = err as UnsafeUrlError;
      expect(e.name).toBe("UnsafeUrlError");
      expect(e.message).not.toContain(secret);
      expect(e.message).not.toContain("127.0.0.1");
      expect(e.message.length).toBeGreaterThan(20);
      expect(e.message).toMatch(/[.]$/);
    }
  });

  it("tells the person what to do next", async () => {
    const err = await assertSafeUrl("http://localhost/", { resolve: publicResolver() }).catch((e: unknown) => e as UnsafeUrlError);
    expect((err as UnsafeUrlError).message).toContain("public web address");
    expect((err as UnsafeUrlError).message).toContain("type the details in yourself");
    const scheme = await assertSafeUrl("ftp://example.com/").catch((e: unknown) => e as UnsafeUrlError);
    expect((scheme as UnsafeUrlError).message).toContain("http:// or https://");
  });
});

describe("createValidatingLookup", () => {
  type Result = { err: NodeJS.ErrnoException | null; address: unknown; family: unknown };
  function call(lookup: ReturnType<typeof createValidatingLookup>, host: string, options: unknown): Promise<Result> {
    return new Promise((resolve) => {
      (lookup as unknown as (h: string, o: unknown, cb: (...args: unknown[]) => void) => void)(host, options, (err: unknown, address: unknown, family: unknown) =>
        resolve({ err: err as NodeJS.ErrnoException | null, address, family }),
      );
    });
  }

  it("hands back an array of {address, family} for all:true", async () => {
    const lookup = createValidatingLookup(fakeResolver({ "example.com": [PUBLIC_IP, "2606:4700:4700::1111"] }));
    const r = await call(lookup, "example.com", { all: true });
    expect(r.err).toBeNull();
    expect(r.address).toEqual([
      { address: PUBLIC_IP, family: 4 },
      { address: "2606:4700:4700::1111", family: 6 },
    ]);
  });

  it("hands back address and family for a single-address call", async () => {
    const lookup = createValidatingLookup(fakeResolver({ "example.com": [PUBLIC_IP, "2606:4700:4700::1111"] }));
    const r = await call(lookup, "example.com", {});
    expect(r.err).toBeNull();
    expect(r.address).toBe(PUBLIC_IP);
    expect(r.family).toBe(4);
  });

  it("accepts a bare family number and the (hostname, callback) form", async () => {
    const lookup = createValidatingLookup(fakeResolver({ "example.com": [PUBLIC_IP, "2606:4700:4700::1111"] }));
    const six = await call(lookup, "example.com", 6);
    expect(six.address).toBe("2606:4700:4700::1111");
    expect(six.family).toBe(6);
    const twoArgs = await new Promise<Result>((resolve) => {
      (lookup as unknown as (h: string, cb: (...args: unknown[]) => void) => void)("example.com", (err: unknown, address: unknown, family: unknown) =>
        resolve({ err: err as NodeJS.ErrnoException | null, address, family }),
      );
    });
    expect(twoArgs.address).toBe(PUBLIC_IP);
  });

  it("honours a family filter, including the string forms", async () => {
    const lookup = createValidatingLookup(fakeResolver({ "example.com": [PUBLIC_IP, "2606:4700:4700::1111"] }));
    expect((await call(lookup, "example.com", { all: true, family: 4 })).address).toEqual([{ address: PUBLIC_IP, family: 4 }]);
    expect((await call(lookup, "example.com", { all: true, family: "IPv6" })).address).toEqual([{ address: "2606:4700:4700::1111", family: 6 }]);
    const none = createValidatingLookup(fakeResolver({ "v4only.example.com": [PUBLIC_IP] }));
    const r = await call(none, "v4only.example.com", { all: true, family: 6 });
    expect(r.err?.code).toBe("ENOTFOUND");
  });

  it("refuses a private answer with a typed error, in both call shapes", async () => {
    const lookup = createValidatingLookup(fakeResolver({ "rebind.example.com": ["127.0.0.1"] }));
    for (const options of [{ all: true }, {}, { family: 4 }]) {
      const r = await call(lookup, "rebind.example.com", options);
      expect(r.err).toBeInstanceOf(BlockedAddressError);
      expect(r.err?.code).toBe("ERR_CPD_BLOCKED_ADDRESS");
      expect(r.err?.message).not.toContain("127.0.0.1");
    }
  });

  it("refuses the whole answer if ANY address is private, so no private address is ever connected to", async () => {
    const lookup = createValidatingLookup(fakeResolver({ "mixed.example.com": [PUBLIC_IP, "169.254.169.254"] }));
    for (const options of [{ all: true }, {}]) {
      const r = await call(lookup, "mixed.example.com", options);
      expect(r.err).toBeInstanceOf(BlockedAddressError);
      expect(r.address === undefined || r.address === "" || (Array.isArray(r.address) && r.address.length === 0)).toBe(true);
    }
  });

  it("resolves once per lookup and returns exactly what it checked (no second resolve to rebind on)", async () => {
    let answers = [["93.184.216.34"], ["127.0.0.1"]];
    const resolve = vi.fn<Resolver>(async () => (answers.shift() ?? []).map((address) => ({ address, family: 4 as const })));
    const lookup = createValidatingLookup(resolve);
    const first = await call(lookup, "flip.example.com", { all: true });
    expect(first.address).toEqual([{ address: "93.184.216.34", family: 4 }]);
    expect(resolve).toHaveBeenCalledTimes(1);
    const second = await call(lookup, "flip.example.com", { all: true });
    expect(second.err).toBeInstanceOf(BlockedAddressError);
    answers = [];
  });

  it("reports ENOTFOUND for an empty answer and passes a resolver error code through", async () => {
    const empty = await call(createValidatingLookup(fakeResolver({ "e.example.com": [] })), "e.example.com", { all: true });
    expect(empty.err?.code).toBe("ENOTFOUND");
    const boom = createValidatingLookup(async () => {
      throw Object.assign(new Error("secret internal detail"), { code: "EAI_AGAIN" });
    });
    const r = await call(boom, "x.example.com", {});
    expect(r.err?.code).toBe("EAI_AGAIN");
    expect(r.err?.message).not.toContain("secret internal detail");
  });

  it("checks an IP literal passed to lookup without asking the resolver", async () => {
    const resolve = fakeResolver({});
    const lookup = createValidatingLookup(resolve);
    expect((await call(lookup, "127.0.0.1", { all: true })).err).toBeInstanceOf(BlockedAddressError);
    expect((await call(lookup, "::1", {})).err).toBeInstanceOf(BlockedAddressError);
    const ok = await call(lookup, "8.8.8.8", {});
    expect(ok.address).toBe("8.8.8.8");
    expect(resolve).not.toHaveBeenCalled();
  });
});

describe("assertSafeUrl: spaces in a pasted link", () => {
  it("percent-encodes plain spaces in the path and the query, as a browser does", async () => {
    const url = await assertSafeUrl("https://example.com/events/My Event 2026.html", { resolve: publicResolver() });
    expect(url.href).toBe("https://example.com/events/My%20Event%202026.html");
    const withQuery = await assertSafeUrl("https://example.com/search?title=bridge bearings&year=2026", { resolve: publicResolver() });
    expect(withQuery.href).toBe("https://example.com/search?title=bridge%20bearings&year=2026");
  });

  it("accepts a link that has spaces and a trailing space, an http link, and a space right after the host", async () => {
    expect((await assertSafeUrl("  http://example.com/a b/c d  ", { resolve: publicResolver() })).pathname).toBe("/a%20b/c%20d");
    expect((await assertSafeUrl("https://example.com/ a", { resolve: publicResolver() })).pathname).toBe("/%20a");
    expect((await assertSafeUrl("https://example.com?q=a b", { resolve: publicResolver() })).search).toBe("?q=a%20b");
    expect((await assertSafeUrl("https://example.com/page#my section", { resolve: publicResolver() })).hash).toBe("#my%20section");
  });

  it("does not let a space in the path change which host is requested", async () => {
    const url = await assertSafeUrl("https://example.com/a b@evil.example/x", { resolve: publicResolver() });
    expect(url.hostname).toBe("example.com");
    const resolve = fakeResolver({ "example.com": [PUBLIC_IP] });
    await assertSafeUrl("https://example.com/redirect to http://127.0.0.1/", { resolve });
    expect(resolve).toHaveBeenCalledWith("example.com");
  });

  it.each([
    "https://exa mple.com/page",
    "https ://example.com/page",
    "https:// example.com/page",
    "https://example.com :443/x",
    "https://example.com and more words",
    "https://user name@example.com/x",
    "hello world",
    "see https://example.com/x",
    "example.com/my page",
  ])("still refuses a space in the scheme or the host: %j", async (raw) => {
    expect(await unsafeCode(raw)).toBe("malformed");
  });

  it.each(["https://example.com/a\tb", "https://example.com/a\nb", "https://example.com/a\rb", "https://example.com/a\u0000b", "https://example.com/a\u007fb", "https://example.com/a b\tc"])(
    "still refuses tabs, line breaks and other control characters: %j",
    async (raw) => {
      expect(await unsafeCode(raw)).toBe("malformed");
    },
  );

  it("counts the length of the link after the spaces are encoded", async () => {
    expect(await unsafeCode(`https://example.com/${"a b ".repeat(300)}z`)).toBe("too_long"); // 1,221 characters as pasted, 2,401 once encoded
    expect(await unsafeCode(`https://example.com/${"a b ".repeat(100)}z`)).toBe("allowed");
  });

  it("still applies every other rule to a link with spaces", async () => {
    expect(await unsafeCode("http://127.0.0.1/my page")).toBe("blocked_ip");
    expect(await unsafeCode("http://localhost/my page")).toBe("blocked_host");
    expect(await unsafeCode("ftp://example.com/my page")).toBe("scheme");
    expect(await unsafeCode("https://user:pw@example.com/my page")).toBe("credentials");
    expect(await unsafeCode("https://example.com:8080/my page")).toBe("port");
  });
});
