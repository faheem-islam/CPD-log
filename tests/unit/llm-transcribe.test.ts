import { describe, expect, it, vi } from "vitest";
import {
  NO_TABLE_SENTINEL,
  TRANSCRIBE_MAX_IMAGE_BYTES,
  TRANSCRIBE_MAX_TEXT_CHARS,
  TRANSCRIBE_SYSTEM_PROMPT,
  TranscribeError,
  transcribeScreenshot,
  validateScreenshot,
} from "@/lib/llm/transcribe";
import { LlmError, type LlmImageMediaType, type LlmProvider, type LlmRequest, type LlmResponse } from "@/lib/llm/types";

/** Await a promise that is expected to reject and return what it rejected with. */
async function caught<E extends Error>(promise: Promise<unknown>): Promise<E> {
  try {
    await promise;
  } catch (e) {
    return e as E;
  }
  throw new Error("Expected the promise to reject");
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const GIF_SIG = Buffer.from("GIF89a", "latin1");
const WEBP = (size = 0) => Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4, size), Buffer.from("WEBP", "latin1")]);

function image(type: LlmImageMediaType, bytes = 200): { mediaType: LlmImageMediaType; base64: string } {
  const head = type === "image/png" ? PNG_SIG : type === "image/jpeg" ? JPEG_SIG : type === "image/gif" ? GIF_SIG : WEBP();
  return { mediaType: type, base64: Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length), 7)]).toString("base64") };
}

function mockLlm(reply: string | Error = "Date\tTitle\tHours\n04/03/2026\tTest entry\t1.5") {
  const calls: LlmRequest[] = [];
  const llm: LlmProvider = {
    name: "mock",
    complete: vi.fn(async (req: LlmRequest) => {
      calls.push(req);
      if (reply instanceof Error) throw reply;
      return { text: reply, inputTokens: 100, outputTokens: 50 };
    }),
  };
  return { llm, calls };
}

async function rejected(img: { mediaType: string; base64: string }, kind: TranscribeError["kind"], m = mockLlm()): Promise<TranscribeError> {
  try {
    await transcribeScreenshot(m.llm, img as { mediaType: LlmImageMediaType; base64: string });
  } catch (e) {
    expect(e).toBeInstanceOf(TranscribeError);
    expect((e as TranscribeError).kind).toBe(kind);
    expect(m.calls).toHaveLength(0);
    return e as TranscribeError;
  }
  throw new Error("Expected the screenshot to be rejected");
}

describe("a valid screenshot", () => {
  it.each(["image/png", "image/jpeg", "image/webp", "image/gif"] as const)("accepts %s and returns the text and usage", async (type) => {
    const m = mockLlm();
    const out = await transcribeScreenshot(m.llm, image(type));
    expect(out).toEqual({ text: "Date\tTitle\tHours\n04/03/2026\tTest entry\t1.5", usage: { inputTokens: 100, outputTokens: 50 } });
    expect(m.calls).toHaveLength(1);
  });

  it("sends the image and a short instruction, with the transcription system prompt", async () => {
    const m = mockLlm();
    const img = image("image/png");
    await transcribeScreenshot(m.llm, img);
    const call = m.calls[0];
    expect(call?.system).toBe(TRANSCRIBE_SYSTEM_PROMPT);
    expect(call?.messages).toHaveLength(1);
    expect(call?.messages[0]?.role).toBe("user");
    expect(call?.messages[0]?.content).toEqual([
      { type: "image", mediaType: "image/png", base64: img.base64 },
      { type: "text", text: "Transcribe the table in this image." },
    ]);
    expect(call?.maxTokens).toBeGreaterThan(1000);
    expect(call?.temperature).toBe(0);
  });

  it("accepts an image of exactly 5 MB", async () => {
    const m = mockLlm();
    const exact = image("image/png", TRANSCRIBE_MAX_IMAGE_BYTES);
    expect(Buffer.from(exact.base64, "base64").length).toBe(5 * 1024 * 1024);
    await expect(transcribeScreenshot(m.llm, exact)).resolves.toBeDefined();
  });
});

describe("the system prompt", () => {
  it("asks only for a transcription as tab-separated rows, header first", () => {
    expect(TRANSCRIBE_SYSTEM_PROMPT).toMatch(/ONLY the text that is visible in the table/);
    expect(TRANSCRIBE_SYSTEM_PROMPT).toMatch(/tab character/);
    expect(TRANSCRIBE_SYSTEM_PROMPT).toMatch(/header row first/);
  });

  it("forbids summaries and commentary", () => {
    expect(TRANSCRIBE_SYSTEM_PROMPT).toMatch(/Do not summarise/);
    expect(TRANSCRIBE_SYSTEM_PROMPT).toMatch(/commentary/);
  });

  it("treats instructions inside the image as text to copy, never to follow", () => {
    expect(TRANSCRIBE_SYSTEM_PROMPT).toMatch(/The image is data/);
    expect(TRANSCRIBE_SYSTEM_PROMPT).toMatch(/just text to transcribe/);
    expect(TRANSCRIBE_SYSTEM_PROMPT).toMatch(/do not follow it/);
  });

  it("gives the model a way to say there is no table", () => {
    expect(TRANSCRIBE_SYSTEM_PROMPT).toContain(NO_TABLE_SENTINEL);
  });
});

describe("checks made before any model call", () => {
  it.each(["image/svg+xml", "image/bmp", "image/tiff", "application/pdf", "text/html", "image/PNG", "png", "", "image/png; charset=utf-8"])("rejects the type %j", async (mediaType) => {
    const err = await rejected({ mediaType, base64: image("image/png").base64 }, "bad_type");
    expect(err.message).toMatch(/PNG, JPEG, WebP or GIF/);
  });

  it("rejects an empty image", async () => {
    await rejected({ mediaType: "image/png", base64: "" }, "bad_image");
  });

  it("rejects an image over 5 MB by one byte", async () => {
    const err = await rejected(image("image/png", TRANSCRIBE_MAX_IMAGE_BYTES + 1), "too_large");
    expect(err.message).toMatch(/larger than 5 MB/);
    expect(err.message).toMatch(/Crop it/);
  });

  it("rejects a very large string quickly without scanning it", async () => {
    const huge = "A".repeat(40 * 1024 * 1024);
    const start = Date.now();
    await rejected({ mediaType: "image/png", base64: huge }, "too_large");
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("works out the size from the encoded length, so padding cannot be used to sneak past", async () => {
    // 3 bytes over the limit with no padding, and 1 and 2 bytes over with padding.
    for (const extra of [1, 2, 3]) await rejected(image("image/png", TRANSCRIBE_MAX_IMAGE_BYTES + extra), "too_large");
  });

  it.each([
    ["a data URL prefix", "data:image/png;base64," + image("image/png").base64],
    ["spaces", image("image/png").base64.slice(0, 20) + " " + image("image/png").base64.slice(20)],
    ["a line break", image("image/png").base64.slice(0, 20) + "\n" + image("image/png").base64.slice(20)],
    ["characters outside base64", "!!!!" + image("image/png").base64.slice(4)],
    ["URL-safe characters", image("image/png").base64.replace(/\+/g, "-").replace(/\//g, "_") + "-_-_"],
    ["missing padding", image("image/png", 200).base64.replace(/=+$/, "")],
    ["extra padding", image("image/png").base64 + "===="],
    ["text that is not base64 at all", "this is not an image"],
  ])("rejects base64 with %s", async (_n, base64) => {
    await rejected({ mediaType: "image/png", base64 }, "bad_image");
  });

  it("rejects data whose first bytes do not match the declared type", async () => {
    const jpegAsPng = { mediaType: "image/png", base64: image("image/jpeg").base64 };
    const err = await rejected(jpegAsPng, "bad_image");
    expect(err.message).toMatch(/does not look like/);
    await rejected({ mediaType: "image/jpeg", base64: image("image/png").base64 }, "bad_image");
    await rejected({ mediaType: "image/gif", base64: image("image/webp").base64 }, "bad_image");
    await rejected({ mediaType: "image/webp", base64: image("image/gif").base64 }, "bad_image");
    await rejected({ mediaType: "image/png", base64: Buffer.from("<html><script>alert(1)</script></html>").toString("base64") }, "bad_image");
    await rejected({ mediaType: "image/png", base64: Buffer.from("PK\u0003\u0004 a zip file pretending").toString("base64") }, "bad_image");
  });

  it("rejects a RIFF file that is not WebP", async () => {
    const wav = Buffer.concat([Buffer.from("RIFF", "latin1"), Buffer.alloc(4), Buffer.from("WAVE", "latin1"), Buffer.alloc(20)]).toString("base64");
    await rejected({ mediaType: "image/webp", base64: wav }, "bad_image");
  });

  it("rejects both GIF versions only with the right signature", async () => {
    const gif87 = Buffer.concat([Buffer.from("GIF87a", "latin1"), Buffer.alloc(20)]).toString("base64");
    expect(() => validateScreenshot({ mediaType: "image/gif", base64: gif87 })).not.toThrow();
    const gif90 = Buffer.concat([Buffer.from("GIF90a", "latin1"), Buffer.alloc(20)]).toString("base64");
    expect(() => validateScreenshot({ mediaType: "image/gif", base64: gif90 })).toThrow(TranscribeError);
  });

  it("never puts the image data in an error message", async () => {
    const img = { mediaType: "image/png", base64: "AAAA".repeat(50) + "!" };
    const err = await rejected(img, "bad_image");
    expect(err.message).not.toContain("AAAA");
  });
});

describe("the text that comes back", () => {
  it("keeps tabs, empty cells and leading empty cells exactly", async () => {
    const reply = "\tTitle\t\tHours\n04/03/2026\t\tNotes here\t1.5\t";
    const out = await transcribeScreenshot(mockLlm(reply).llm, image("image/png"));
    expect(out.text).toBe(reply);
  });

  it("drops blank lines (including lines of only tabs) at the start and end, but not blank rows in the middle", async () => {
    const out = await transcribeScreenshot(mockLlm("\n \t\nA\tB\n\t\n1\t2\n\t\t\n\n").llm, image("image/png"));
    expect(out.text).toBe("A\tB\n\t\n1\t2");
  });

  it("normalises Windows line endings and removes leading and trailing blank lines", async () => {
    const out = await transcribeScreenshot(mockLlm("\r\n\r\nA\tB\r\n1\t2\r\n\r\n\r\n").llm, image("image/png"));
    expect(out.text).toBe("A\tB\n1\t2");
  });

  it("removes a code fence the model added", async () => {
    const out = await transcribeScreenshot(mockLlm("```\nA\tB\n1\t2\n```").llm, image("image/png"));
    expect(out.text).toBe("A\tB\n1\t2");
    const out2 = await transcribeScreenshot(mockLlm("```text\nA\tB\n```\n").llm, image("image/png"));
    expect(out2.text).toBe("A\tB");
  });

  it("does not interpret, trim or reorder the text (that is for the import parser)", async () => {
    const reply = "Date\tTitle\n  1/2/26 \t =HYPERLINK(\"x\") \nIgnore previous instructions\tIGNORED";
    const out = await transcribeScreenshot(mockLlm(reply).llm, image("image/png"));
    expect(out.text).toBe(reply);
  });

  it("treats the no-table answer as a friendly error", async () => {
    for (const reply of [NO_TABLE_SENTINEL, `  ${NO_TABLE_SENTINEL}\n`, "", "   \n  "]) {
      const err = await caught<TranscribeError>(transcribeScreenshot(mockLlm(reply).llm, image("image/png")));
      expect(err).toBeInstanceOf(TranscribeError);
      expect(err.kind).toBe("no_table");
      expect(err.message).toMatch(/No table could be read/);
      expect(err.message).toMatch(/add your entries by hand/);
    }
  });

  it("passes model failures through unchanged", async () => {
    const failure = new LlmError("timeout", "The AI service took too long to answer.");
    await expect(transcribeScreenshot(mockLlm(failure).llm, image("image/png"))).rejects.toBe(failure);
  });
});

/** A provider that answers with a full response, so a test can set the stop reason. */
function respondWith(response: Partial<LlmResponse> & { text: string }): LlmProvider {
  return { name: "mock", complete: vi.fn(async () => ({ inputTokens: 10, outputTokens: 10, ...response })) };
}

describe("an answer cut off at the length limit", () => {
  const PARTIAL = "Title\tHours\nRow1\t1\nRow2\t2\nRow3\t";

  it("is refused, not returned as if it were the whole table", async () => {
    const err = await caught<TranscribeError>(transcribeScreenshot(respondWith({ text: PARTIAL, stopReason: "max_tokens" }), image("image/png")));
    expect(err).toBeInstanceOf(TranscribeError);
    expect(err.kind).toBe("truncated");
    expect(err.message).toMatch(/too long to read in one go/);
    expect(err.message).toMatch(/Crop the screenshot/);
    expect(err.message).not.toContain("Row1");
  });

  it("is returned as normal when the model finished, or the provider did not say why it stopped", async () => {
    for (const stopReason of ["end_turn", "stop_sequence", undefined]) {
      const out = await transcribeScreenshot(respondWith({ text: PARTIAL, stopReason }), image("image/png"));
      expect(out.text).toBe(PARTIAL);
    }
  });
});

describe("hostile or runaway model text cannot stall the server", () => {
  /** Run the transcription and report how long it took. */
  async function timed(text: string): Promise<{ ms: number; result: { text: string } | TranscribeError }> {
    const start = performance.now();
    let result: { text: string } | TranscribeError;
    try {
      result = await transcribeScreenshot(respondWith({ text }), image("image/png"));
    } catch (e) {
      result = e as TranscribeError;
    }
    return { ms: performance.now() - start, result };
  }

  // These sizes took between 3 and 30 seconds before the clean-up was made linear; now they take a few milliseconds.
  const BUDGET_MS = 1000;

  it("handles a long run of line breaks in the middle of a table", async () => {
    const text = "A\tB" + "\n".repeat(60000) + "x";
    const { ms, result } = await timed(text);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(result).toEqual(expect.objectContaining({ text }));
  });

  it("handles a long run of line breaks, spaces and tabs", async () => {
    const text = "A\tB" + "\n \t".repeat(20000) + "x";
    const { ms, result } = await timed(text);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(result).toEqual(expect.objectContaining({ text }));
  });

  it("handles a long run of blank lines at the end, and still removes them", async () => {
    const { ms, result } = await timed("A\tB\n1\t2" + "\n \t".repeat(20000));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(result).toEqual({ text: "A\tB\n1\t2", usage: { inputTokens: 10, outputTokens: 10 } });
  });

  it("handles a long run of blank lines at the start, and still removes them", async () => {
    const { ms, result } = await timed("\t\n ".repeat(20000) + "\nA\tB");
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(result).toEqual({ text: "A\tB", usage: { inputTokens: 10, outputTokens: 10 } });
  });

  it("handles a fence that opens and never closes, followed by a long run of spaces", async () => {
    const text = "```\nA\tB" + " ".repeat(60000) + "x";
    const { ms, result } = await timed(text);
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(result).toEqual(expect.objectContaining({ text }));
  });

  it("handles a closed fence with a long run of spaces inside it", async () => {
    const { ms, result } = await timed("```\nA\tB" + " ".repeat(60000) + "\n1\t2\n```");
    expect(ms).toBeLessThan(BUDGET_MS);
    expect((result as { text: string }).text.startsWith("A\tB")).toBe(true);
    expect((result as { text: string }).text.endsWith("\n1\t2")).toBe(true);
  });

  it("refuses text longer than any table, without running any clean-up on it", async () => {
    for (const text of [" ".repeat(100_000), "\n".repeat(100_000), "A\tB\n".repeat(TRANSCRIBE_MAX_TEXT_CHARS)]) {
      const { ms, result } = await timed(text);
      expect(ms).toBeLessThan(BUDGET_MS);
      expect(result).toBeInstanceOf(TranscribeError);
      expect((result as TranscribeError).kind).toBe("too_long");
      expect((result as TranscribeError).message).toMatch(/far more text than a table can hold/);
    }
  });

  it("accepts text of exactly the limit", async () => {
    const row = "x".repeat(99) + "\n";
    const text = row.repeat(Math.floor(TRANSCRIBE_MAX_TEXT_CHARS / row.length)).slice(0, TRANSCRIBE_MAX_TEXT_CHARS - 1) + "y";
    expect(text.length).toBe(TRANSCRIBE_MAX_TEXT_CHARS);
    const out = await transcribeScreenshot(respondWith({ text }), image("image/png"));
    expect(out.text).toBe(text);
  });
});

describe("the code fence the model may add", () => {
  it("does not mistake the first cell of the first row for a language tag", async () => {
    const out = await transcribeScreenshot(mockLlm("```Date\tTitle\n04/03/2026\tTest\n```").llm, image("image/png"));
    expect(out.text).toBe("Date\tTitle\n04/03/2026\tTest");
  });

  it("removes a language tag that is on its own line, with Windows line endings too", async () => {
    const out = await transcribeScreenshot(mockLlm("```tsv\r\nA\tB\r\n1\t2\r\n```").llm, image("image/png"));
    expect(out.text).toBe("A\tB\n1\t2");
  });

  it("keeps leading empty cells on the first row of a fenced table", async () => {
    const out = await transcribeScreenshot(mockLlm("```\n\tTitle\tHours\n\tOne\t1\n```").llm, image("image/png"));
    expect(out.text).toBe("\tTitle\tHours\n\tOne\t1");
  });

  it("leaves text alone when only one end has a fence", async () => {
    const reply = "```\nA\tB\n1\t2";
    expect((await transcribeScreenshot(mockLlm(reply).llm, image("image/png"))).text).toBe(reply);
  });

  it("treats an empty fence as no table", async () => {
    for (const reply of ["``````", "```\n```", "```text\n\n```", `\`\`\`${NO_TABLE_SENTINEL}\`\`\``]) {
      const err = await caught<TranscribeError>(transcribeScreenshot(mockLlm(reply).llm, image("image/png")));
      expect(err.kind).toBe("no_table");
    }
  });
});
