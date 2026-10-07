import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ANTHROPIC_ENDPOINT,
  ANTHROPIC_VERSION,
  LLM_TIMEOUT_MS,
  createAnthropicProvider,
  getLlmProvider,
} from "@/lib/llm/anthropic";
import { LlmError } from "@/lib/llm/types";
import { scrubSecrets } from "@/lib/llm/scrub";
import { parseEnv } from "@/lib/env";

const KEY = "sk-ant-api03-UNIQUEKEYVALUE0123456789abcdefghij";

interface Captured {
  url: string;
  init: RequestInit;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

function okBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    content: [{ type: "text", text: "Hello there" }],
    stop_reason: "end_turn",
    usage: { input_tokens: 12, output_tokens: 34 },
    ...over,
  };
}

function mockFetch(respond: (c: Captured) => Response | Promise<Response>) {
  const calls: Captured[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const captured: Captured = {
      url: String(url),
      init: init ?? {},
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(captured);
    return respond(captured);
  });
  return { fn: fn as unknown as typeof fetch, calls, mock: fn };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function provider(fetchImpl: typeof fetch, over: Partial<Parameters<typeof createAnthropicProvider>[0]> = {}) {
  return createAnthropicProvider({ apiKey: KEY, model: "test-model-1", fetchImpl, ...over });
}

const REQ = { system: "Be brief.", messages: [{ role: "user" as const, content: "Hi" }], maxTokens: 100 };

async function failure(p: ReturnType<typeof provider>, req = REQ): Promise<LlmError> {
  try {
    await p.complete(req);
  } catch (e) {
    expect(e).toBeInstanceOf(LlmError);
    return e as LlmError;
  }
  throw new Error("Expected the call to fail");
}

function everythingAbout(err: Error): string {
  return [err.message, err.name, String(err), err.stack ?? "", JSON.stringify(err), JSON.stringify(Object.getOwnPropertyNames(err).map((k) => (err as unknown as Record<string, unknown>)[k]))].join("\n");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("the request", () => {
  it("posts to the Messages API with the right headers", async () => {
    const m = mockFetch(() => json(200, okBody()));
    await provider(m.fn).complete(REQ);
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(ANTHROPIC_ENDPOINT).toBe("https://api.anthropic.com/v1/messages");
    expect(m.calls[0]?.init.method).toBe("POST");
    expect(m.calls[0]?.headers).toEqual({ "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" });
    expect(ANTHROPIC_VERSION).toBe("2023-06-01");
  });

  it("sends model, max_tokens, system and messages, and no temperature unless asked", async () => {
    const m = mockFetch(() => json(200, okBody()));
    await provider(m.fn).complete(REQ);
    expect(m.calls[0]?.body).toEqual({ model: "test-model-1", max_tokens: 100, system: "Be brief.", messages: [{ role: "user", content: "Hi" }] });
    await provider(m.fn).complete({ ...REQ, temperature: 0.2 });
    expect(m.calls[1]?.body.temperature).toBe(0.2);
    await provider(m.fn).complete({ ...REQ, temperature: 0 });
    expect(m.calls[2]?.body.temperature).toBe(0);
  });

  it("puts the key only in the x-api-key header: not in the URL, the body or any other header", async () => {
    const m = mockFetch(() => json(200, okBody()));
    await provider(m.fn).complete({ ...REQ, system: "sys", messages: [{ role: "user", content: "notes" }] });
    const c = m.calls[0];
    expect(c?.url).not.toContain(KEY);
    expect(String(c?.init.body)).not.toContain(KEY);
    const others = Object.entries(c?.headers ?? {}).filter(([k]) => k !== "x-api-key");
    for (const [, v] of others) expect(v).not.toContain(KEY);
  });

  it("maps text and image parts to the API's content blocks", async () => {
    const m = mockFetch(() => json(200, okBody()));
    await provider(m.fn).complete({
      system: "s",
      maxTokens: 50,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", mediaType: "image/png", base64: "QUJD" },
            { type: "text", text: "Transcribe." },
          ],
        },
      ],
    });
    expect(m.calls[0]?.body.messages).toEqual([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "QUJD" } },
          { type: "text", text: "Transcribe." },
        ],
      },
    ]);
  });

  it("passes several messages through in order", async () => {
    const m = mockFetch(() => json(200, okBody()));
    await provider(m.fn).complete({
      system: "s",
      maxTokens: 50,
      messages: [
        { role: "user", content: "one" },
        { role: "assistant", content: "two" },
        { role: "user", content: "three" },
      ],
    });
    expect((m.calls[0]?.body.messages as { role: string }[]).map((x) => x.role)).toEqual(["user", "assistant", "user"]);
  });

  it("uses the model it was created with, taken from configuration", async () => {
    const m = mockFetch(() => json(200, okBody()));
    await createAnthropicProvider({ apiKey: KEY, model: "  my-configured-model  ", fetchImpl: m.fn }).complete(REQ);
    expect(m.calls[0]?.body.model).toBe("my-configured-model");
  });

  it("sets a 30 second timeout signal by default and never follows redirects", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const m = mockFetch(() => json(200, okBody()));
    await provider(m.fn).complete(REQ);
    expect(spy).toHaveBeenCalledWith(30_000);
    expect(LLM_TIMEOUT_MS).toBe(30_000);
    expect(m.calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
    expect(m.calls[0]?.init.redirect).toBe("error");
  });

  it("allows the timeout to be shortened", async () => {
    const spy = vi.spyOn(AbortSignal, "timeout");
    const m = mockFetch(() => json(200, okBody()));
    await provider(m.fn, { timeoutMs: 1234 }).complete(REQ);
    expect(spy).toHaveBeenCalledWith(1234);
  });

  it("uses the global fetch at call time when none is given", async () => {
    const g = vi.fn(async () => json(200, okBody()));
    vi.stubGlobal("fetch", g);
    const p = createAnthropicProvider({ apiKey: KEY, model: "m" });
    await p.complete(REQ);
    expect(g).toHaveBeenCalledTimes(1);
  });

  it("refuses bad limits and empty requests without calling the network", async () => {
    const m = mockFetch(() => json(200, okBody()));
    const p = provider(m.fn);
    for (const maxTokens of [0, -1, 1.5, 100000, Number.NaN]) {
      expect((await failure(p, { ...REQ, maxTokens })).kind).toBe("bad_request");
    }
    expect((await failure(p, { ...REQ, messages: [] })).kind).toBe("bad_request");
    expect(m.calls).toHaveLength(0);
  });

  it("will not create a provider without a key or a model, and the error does not show the key", () => {
    expect(() => createAnthropicProvider({ apiKey: "   ", model: "m" })).toThrow(/ANTHROPIC_API_KEY/);
    expect(() => createAnthropicProvider({ apiKey: KEY, model: " " })).toThrow(/LLM_MODEL/);
    try {
      createAnthropicProvider({ apiKey: KEY, model: "" });
    } catch (e) {
      expect(String((e as Error).message)).not.toContain(KEY);
    }
  });

  it("is named anthropic", () => {
    expect(provider(mockFetch(() => json(200, okBody())).fn).name).toBe("anthropic");
  });
});

describe("the answer", () => {
  it("returns the text and token counts", async () => {
    const m = mockFetch(() => json(200, okBody()));
    expect(await provider(m.fn).complete(REQ)).toEqual({ text: "Hello there", inputTokens: 12, outputTokens: 34, stopReason: "end_turn" });
  });

  it("passes on why the model stopped, so a caller can tell a cut-off answer from a finished one", async () => {
    const cut = mockFetch(() => json(200, okBody({ stop_reason: "max_tokens" })));
    expect((await provider(cut.fn).complete(REQ)).stopReason).toBe("max_tokens");
    const none = mockFetch(() => json(200, okBody({ stop_reason: null })));
    expect(await provider(none.fn).complete(REQ)).not.toHaveProperty("stopReason");
  });

  it.each([
    ["a negative input count", { input_tokens: -1, output_tokens: 5 }],
    ["a fractional output count", { input_tokens: 5, output_tokens: 2.5 }],
    ["a count that is not a number", { input_tokens: "5", output_tokens: 5 }],
  ])("rejects usage with %s instead of passing it on", async (_name, usage) => {
    const m = mockFetch(() => json(200, okBody({ usage })));
    expect((await failure(provider(m.fn))).kind).toBe("bad_response");
  });

  it("joins several text blocks and ignores other kinds of block", async () => {
    const m = mockFetch(() =>
      json(200, okBody({ content: [{ type: "text", text: "A" }, { type: "tool_use", id: "x", name: "n", input: {} }, { type: "text", text: "B" }] })),
    );
    expect((await provider(m.fn).complete(REQ)).text).toBe("AB");
  });

  it.each([
    ["no text at all", { content: [] }],
    ["only blank text", { content: [{ type: "text", text: "   " }] }],
    ["only a non-text block", { content: [{ type: "tool_use" }] }],
  ])("fails clearly for %s", async (_n, over) => {
    const m = mockFetch(() => json(200, okBody(over)));
    const err = await failure(provider(m.fn));
    expect(err.kind).toBe("bad_response");
    expect(err.message).toMatch(/empty answer/);
  });

  it.each([
    ["not an object", "just text"],
    ["a missing usage block", { content: [{ type: "text", text: "x" }] }],
    ["usage with the wrong types", { content: [{ type: "text", text: "x" }], usage: { input_tokens: "1", output_tokens: 2 } }],
    ["content that is not a list", { content: "x", usage: { input_tokens: 1, output_tokens: 1 } }],
  ])("fails clearly for a reply with %s", async (_n, body) => {
    const m = mockFetch(() => json(200, body));
    expect((await failure(provider(m.fn))).kind).toBe("bad_response");
  });

  it("fails clearly when the reply is not JSON", async () => {
    const m = mockFetch(() => new Response("<html>oops</html>", { status: 200 }));
    const err = await failure(provider(m.fn));
    expect(err.kind).toBe("bad_response");
    expect(err.message).not.toContain("oops");
  });

  it("reports a refusal as such", async () => {
    const m = mockFetch(() => json(200, okBody({ stop_reason: "refusal" })));
    const err = await failure(provider(m.fn));
    expect(err.kind).toBe("refused");
    expect(err.message).toMatch(/declined/);
  });
});

describe("errors from the service", () => {
  it.each([
    [401, "auth", "The AI key was rejected - check ANTHROPIC_API_KEY on the server"],
    [403, "auth", "The AI key was rejected - check ANTHROPIC_API_KEY on the server"],
    [429, "rate_limit", "The AI service is busy - try again in a minute"],
    [500, "server", "The AI service had a problem on its side - try again in a minute"],
    [502, "server", "The AI service had a problem on its side - try again in a minute"],
    [503, "server", "The AI service had a problem on its side - try again in a minute"],
    [529, "server", "The AI service had a problem on its side - try again in a minute"],
  ])("maps HTTP %i to a friendly message", async (status, kind, message) => {
    const m = mockFetch(() => json(status, { type: "error", error: { type: "x", message: `bad key ${KEY}` } }));
    const err = await failure(provider(m.fn));
    expect(err.kind).toBe(kind);
    expect(err.message).toBe(message);
    expect(err.status).toBe(status);
  });

  it("maps 404 to a model-name message and 400 to a request message", async () => {
    const m404 = mockFetch(() => json(404, { error: { message: "model: nope" } }));
    expect((await failure(provider(m404.fn))).message).toMatch(/check LLM_MODEL/);
    const m400 = mockFetch(() => json(400, { error: { message: `prompt quotes ${KEY}` } }));
    const e400 = await failure(provider(m400.fn));
    expect(e400.kind).toBe("bad_request");
    expect(e400.message).not.toContain(KEY);
    const m413 = mockFetch(() => json(413, {}));
    expect((await failure(provider(m413.fn))).kind).toBe("bad_request");
  });

  it("never puts the key, or anything the service said, in the error", async () => {
    for (const status of [400, 401, 403, 404, 408, 413, 429, 500, 503]) {
      const m = mockFetch(() => json(status, { error: { message: `echo ${KEY} and Bearer ${KEY} and x-api-key: ${KEY}`, detail: "LEAKED-DETAIL" } }));
      const err = await failure(provider(m.fn));
      const all = everythingAbout(err);
      expect(all).not.toContain(KEY);
      expect(all).not.toContain("UNIQUEKEYVALUE");
      expect(all).not.toContain("LEAKED-DETAIL");
    }
  });

  it("does not retry", async () => {
    for (const status of [429, 500, 503]) {
      const m = mockFetch(() => json(status, {}));
      await failure(provider(m.fn));
      expect(m.calls).toHaveLength(1);
    }
  });

  it("does not log anything, even on failure", async () => {
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((k) => vi.spyOn(console, k).mockImplementation(() => undefined));
    await failure(provider(mockFetch(() => json(401, { error: KEY })).fn));
    await failure(provider(mockFetch(() => json(500, {})).fn));
    await provider(mockFetch(() => json(200, okBody())).fn).complete(REQ);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("network failures and timeouts", () => {
  it("maps a timeout to a friendly message", async () => {
    const m = mockFetch(() => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    });
    const err = await failure(provider(m.fn));
    expect(err.kind).toBe("timeout");
    expect(err.message).toMatch(/took too long/);
  });

  it("maps an abort to the same message", async () => {
    const m = mockFetch(() => {
      throw new DOMException("aborted", "AbortError");
    });
    expect((await failure(provider(m.fn))).kind).toBe("timeout");
  });

  it("really times out when the server never answers", async () => {
    const hang = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;
    const err = await failure(provider(hang, { timeoutMs: 25 }));
    expect(err.kind).toBe("timeout");
    expect(err.message).toMatch(/took too long/);
  });

  it("maps any other failure to a network message without its own text", async () => {
    const m = mockFetch(() => {
      throw new TypeError(`fetch failed: connect ECONNREFUSED while sending x-api-key: ${KEY}`);
    });
    const err = await failure(provider(m.fn));
    expect(err.kind).toBe("network");
    expect(err.message).toMatch(/could not reach the AI service/);
    const all = everythingAbout(err);
    expect(all).not.toContain(KEY);
    expect(all).not.toContain("ECONNREFUSED");
  });

  it("copes with a non-Error being thrown", async () => {
    const m = mockFetch(() => {
      throw KEY;
    });
    const err = await failure(provider(m.fn));
    expect(err.kind).toBe("network");
    expect(everythingAbout(err)).not.toContain(KEY);
  });

  it("carries no cause that could hold the key", async () => {
    const m = mockFetch(() => {
      throw new Error(KEY);
    });
    const err = await failure(provider(m.fn));
    expect(err.cause).toBeUndefined();
  });
});

describe("getLlmProvider", () => {
  it("returns null when ANTHROPIC_API_KEY is not set, blank or only spaces", () => {
    expect(getLlmProvider(parseEnv({}))).toBeNull();
    expect(getLlmProvider(parseEnv({ ANTHROPIC_API_KEY: "" }))).toBeNull();
    expect(getLlmProvider(parseEnv({ ANTHROPIC_API_KEY: "    " }))).toBeNull();
  });

  it("returns a provider when the key is set, using the model from configuration", async () => {
    const m = mockFetch(() => json(200, okBody()));
    const p = getLlmProvider(parseEnv({ ANTHROPIC_API_KEY: KEY, LLM_MODEL: "configured-model" }), m.fn);
    expect(p?.name).toBe("anthropic");
    await p?.complete(REQ);
    expect(m.calls[0]?.body.model).toBe("configured-model");
    expect(m.calls[0]?.headers["x-api-key"]).toBe(KEY);
  });

  it("uses the default model when LLM_MODEL is blank or missing", async () => {
    const m = mockFetch(() => json(200, okBody()));
    await getLlmProvider(parseEnv({ ANTHROPIC_API_KEY: KEY }), m.fn)?.complete(REQ);
    await getLlmProvider(parseEnv({ ANTHROPIC_API_KEY: KEY, LLM_MODEL: "  " }), m.fn)?.complete(REQ);
    expect(m.calls.map((c) => c.body.model)).toEqual(["claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001"]);
  });

  it("does not hard-code a model name in call sites (it is read from the environment settings)", async () => {
    const m = mockFetch(() => json(200, okBody()));
    for (const model of ["model-a", "model-b"]) {
      await getLlmProvider(parseEnv({ ANTHROPIC_API_KEY: KEY, LLM_MODEL: model }), m.fn)?.complete(REQ);
    }
    expect(m.calls.map((c) => c.body.model)).toEqual(["model-a", "model-b"]);
  });
});

describe("scrubSecrets", () => {
  it("removes the exact secrets passed in", () => {
    expect(scrubSecrets(`hello ${KEY} world`, KEY)).toBe("hello [removed] world");
    expect(scrubSecrets("a short-secret here", "short-secret")).toBe("a [removed] here");
  });

  it("ignores empty or very short secrets rather than wiping the text", () => {
    expect(scrubSecrets("keep this text", "", undefined, "ab")).toBe("keep this text");
  });

  it("removes strings that look like keys", () => {
    const text = [
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "AIzaSyA1234567890abcdefghijklmnop",
      "eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoiYW5vbiJ9.c2lnbmF0dXJlLXZhbHVl",
      "x-api-key: topsecretvalue",
      "Authorization: Bearer abc.def.ghi",
      "sb_secret_abcdefghijklmnop",
      "0123456789abcdef0123456789abcdef0123",
      "key_abcdefghijklmnop1234",
    ].join(" | ");
    const out = scrubSecrets(text);
    for (const frag of ["abcdefghijklmnopqrstuvwxyz", "AIzaSy", "eyJhbGci", "topsecretvalue", "abc.def.ghi", "sb_secret_abc", "0123456789abcdef0123456789abcdef0123", "key_abcdefghijklmnop1234"]) {
      expect(out).not.toContain(frag);
    }
  });

  it("leaves ordinary sentences alone", () => {
    const s = "The AI service is busy - try again in a minute. Check LLM_MODEL on the server.";
    expect(scrubSecrets(s)).toBe(s);
  });
});

describe("a key that cannot be sent", () => {
  it.each([
    ["a line break inside", "sk-ant-api03-ABC\nDEF"],
    ["a space inside", "sk-ant-api03-ABC DEF"],
    ["a null character", "sk-ant-api03-ABC\u0000DEF"],
    ["a non-ASCII letter", "sk-ant-api03-ABCü"],
    ["a character outside Latin-1", "sk-ant-api03-ABC\u2603"],
  ])("is refused up front as a key problem when it has %s, not later as a network failure", (_name, apiKey) => {
    const m = mockFetch(() => json(200, okBody()));
    let thrown: unknown;
    try {
      createAnthropicProvider({ apiKey, model: "test-model-1", fetchImpl: m.fn });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(LlmError);
    expect((thrown as LlmError).kind).toBe("auth");
    expect((thrown as LlmError).message).toMatch(/check ANTHROPIC_API_KEY/);
    expect(everythingAbout(thrown as LlmError)).not.toContain("ABC");
    expect(m.calls).toHaveLength(0);
  });

  it("is refused the same way when it comes from the environment", () => {
    expect(() => getLlmProvider(parseEnv({ ANTHROPIC_API_KEY: "sk-ant-api03-has a space" }))).toThrow(/check ANTHROPIC_API_KEY/);
  });

  it("still accepts an ordinary key, with blank space around it trimmed", async () => {
    const m = mockFetch(() => json(200, okBody()));
    await provider(m.fn, { apiKey: `  ${KEY}\n` }).complete(REQ);
    expect(m.calls[0]?.headers["x-api-key"]).toBe(KEY);
  });
});

describe("a deadline that passes while the answer is still arriving", () => {
  /** A response whose body never finishes, and errors with the signal's reason when the signal fires, as real fetch does. */
  function slowBody(): typeof fetch {
    return (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      });
      return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
  }

  it("is reported as a timeout, not as an answer that could not be read", async () => {
    const err = await failure(provider(slowBody(), { timeoutMs: 25 }));
    expect(err.kind).toBe("timeout");
    expect(err.message).toMatch(/took too long/);
  });

  it("still reports a body that is simply not JSON as unreadable", async () => {
    const m = mockFetch(() => new Response("<html>not json</html>", { status: 200 }));
    expect((await failure(provider(m.fn))).kind).toBe("bad_response");
  });
});
