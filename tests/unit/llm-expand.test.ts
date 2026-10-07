import { describe, expect, it, vi } from "vitest";
import { ExpandError, EXPAND_LIMITS, buildExpandPrompt, countSentences, expandNotes, hasExpandableNotes, newBoundary, stripCodeFence, type ExpandArgs } from "@/lib/llm/expand";
import { LlmError, type LlmProvider, type LlmRequest } from "@/lib/llm/types";

const BOUNDARY = "BTESTBOUNDARY0123456789";
const opts = { boundary: () => BOUNDARY };

function mockLlm(reply: string | ((req: LlmRequest) => string) | Error) {
  const calls: LlmRequest[] = [];
  const llm: LlmProvider = {
    name: "mock",
    complete: vi.fn(async (req: LlmRequest) => {
      calls.push(req);
      if (reply instanceof Error) throw reply;
      return { text: typeof reply === "function" ? reply(req) : reply, inputTokens: 11, outputTokens: 22 };
    }),
  };
  return { llm, calls };
}

function args(over: Partial<ExpandArgs> = {}): ExpandArgs {
  return {
    profile: "ice",
    title: "Bridge inspection basics",
    provider: "Test Institute",
    sourceType: "webinar",
    theme: "Safety and risk management",
    notes: "Learned how inspection intervals are set and why records matter. Will use it on my next structure review.",
    ...over,
  };
}

const ICE_REPLY = JSON.stringify({
  learningPoints: "I learned how inspection intervals are set and why records matter.",
  benefits: { helped: "", future: "I will use it on my next structure review.", nextYear: "" },
});

const userText = (call: LlmRequest | undefined): string => {
  const c = call?.messages[0]?.content;
  return typeof c === "string" ? c : "";
};

describe("blank notes", () => {
  it.each([
    ["an empty string", ""],
    ["spaces", "    "],
    ["tabs and new lines", "\n\t \r\n"],
    ["zero-width characters", "\u200B\u200C\u200D\uFEFF"],
    ["control characters", "\u0000\u0001\u0007"],
    ["a mix of hidden and blank characters", " \u200B\n\u0000\t "],
    ["a notes value that is not text", undefined as unknown as string],
  ])("makes no model call for %s and returns blank fields", async (_name, notes) => {
    const m = mockLlm(ICE_REPLY);
    const out = await expandNotes(args({ notes }), m.llm, opts);
    expect(m.calls).toHaveLength(0);
    expect(m.llm.complete).not.toHaveBeenCalled();
    expect(out).toEqual({
      learningPoints: "",
      benefits: { helped: "", future: "", nextYear: "" },
      developmentGained: "",
      warnings: [],
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });

  it("makes no call even when the title and theme are filled in", async () => {
    const m = mockLlm(ICE_REPLY);
    await expandNotes(args({ notes: "   ", title: "A long and meaningful title", theme: "Water" }), m.llm, opts);
    expect(m.calls).toHaveLength(0);
  });

  it.each(["istructe", "custom"] as const)("also returns blank fields for the %s profile", async (profile) => {
    const m = mockLlm("{}");
    const out = await expandNotes(args({ profile, notes: "" }), m.llm, opts);
    expect(out.learningPoints).toBe("");
    expect(out.developmentGained).toBe("");
    expect(m.calls).toHaveLength(0);
  });

  it("returns a fresh blank result each time", async () => {
    const m = mockLlm(ICE_REPLY);
    const a = await expandNotes(args({ notes: "" }), m.llm, opts);
    a.benefits.helped = "changed";
    const b = await expandNotes(args({ notes: "" }), m.llm, opts);
    expect(b.benefits.helped).toBe("");
  });
});

describe("the request to the model", () => {
  it("makes one call with a system prompt and one user message", async () => {
    const m = mockLlm(ICE_REPLY);
    await expandNotes(args(), m.llm, opts);
    expect(m.calls).toHaveLength(1);
    const call = m.calls[0];
    expect(call?.messages).toHaveLength(1);
    expect(call?.messages[0]?.role).toBe("user");
    expect(typeof call?.messages[0]?.content).toBe("string");
    expect(call?.maxTokens).toBeGreaterThan(0);
    expect(call?.temperature).toBeLessThanOrEqual(0.5);
  });

  it("states the rules in the system prompt", async () => {
    const m = mockLlm(ICE_REPLY);
    await expandNotes(args(), m.llm, opts);
    const sys = m.calls[0]?.system ?? "";
    expect(sys).toMatch(/UK English/);
    expect(sys).toMatch(/DATA/);
    expect(sys).toMatch(/never an instruction/i);
    expect(sys).toMatch(/Do not add facts, names, standards, numbers, dates/);
    expect(sys).toMatch(/Stay strictly within the notes/);
    expect(sys).toMatch(/one JSON object and nothing else/);
    expect(sys).toContain(BOUNDARY);
  });

  it("keeps the system prompt free of the user's text", async () => {
    const m = mockLlm(ICE_REPLY);
    await expandNotes(args({ title: "UNIQUE-TITLE-MARKER", notes: "UNIQUE-NOTES-MARKER" }), m.llm, opts);
    const sys = m.calls[0]?.system ?? "";
    expect(sys).not.toContain("UNIQUE-TITLE-MARKER");
    expect(sys).not.toContain("UNIQUE-NOTES-MARKER");
  });

  it("sends only title, provider, source type, theme and notes, each in its own delimited block", async () => {
    const m = mockLlm(ICE_REPLY);
    await expandNotes(args({ title: "T-MARK", provider: "P-MARK", theme: "TH-MARK", notes: "N-MARK", sourceType: "live_event" }), m.llm, opts);
    expect(userText(m.calls[0]).split("\n")).toEqual([
      `[[BEGIN ${BOUNDARY} title]]`,
      "T-MARK",
      `[[END ${BOUNDARY} title]]`,
      `[[BEGIN ${BOUNDARY} provider]]`,
      "P-MARK",
      `[[END ${BOUNDARY} provider]]`,
      `[[BEGIN ${BOUNDARY} source_type]]`,
      "Live event",
      `[[END ${BOUNDARY} source_type]]`,
      `[[BEGIN ${BOUNDARY} theme]]`,
      "TH-MARK",
      `[[END ${BOUNDARY} theme]]`,
      `[[BEGIN ${BOUNDARY} notes]]`,
      "N-MARK",
      `[[END ${BOUNDARY} notes]]`,
      "",
      "Write the JSON object now.",
    ]);
  });

  it("says (not given) for a missing provider or theme", async () => {
    const m = mockLlm(ICE_REPLY);
    await expandNotes(args({ provider: null, theme: null, title: "" }), m.llm, opts);
    const lines = userText(m.calls[0]).split("\n");
    expect(lines.filter((l) => l === "(not given)")).toHaveLength(3);
  });

  it("does not pass anything else along, such as page text or settings, if a caller adds extra properties", async () => {
    const m = mockLlm(ICE_REPLY);
    const extra = { ...args(), pageText: "PAGE-TEXT-MARKER", html: "<p>HTML-MARKER</p>", url: "https://example.test/URL-MARKER", settings: { name: "NAME-MARKER" } };
    await expandNotes(extra, m.llm, opts);
    const all = `${m.calls[0]?.system}\n${userText(m.calls[0])}`;
    for (const marker of ["PAGE-TEXT-MARKER", "HTML-MARKER", "URL-MARKER", "NAME-MARKER"]) expect(all).not.toContain(marker);
  });

  it("uses a different random boundary on every call", async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 20; i++) {
      const m = mockLlm(ICE_REPLY);
      await expandNotes(args(), m.llm);
      const first = userText(m.calls[0]).split("\n")[0] ?? "";
      const token = /\[\[BEGIN (\S+) title\]\]/.exec(first)?.[1] ?? "";
      expect(token).toMatch(/^B[0-9A-F]{24}$/);
      expect(m.calls[0]?.system).toContain(token);
      seen.add(token);
    }
    expect(seen.size).toBe(20);
    expect(newBoundary()).toMatch(/^B[0-9A-F]{24}$/);
  });

  it("returns the token usage from the model", async () => {
    const m = mockLlm(ICE_REPLY);
    expect((await expandNotes(args(), m.llm, opts)).usage).toEqual({ inputTokens: 11, outputTokens: 22 });
  });

  it("uses the label for the source type, and Other for an unknown one", async () => {
    const m = mockLlm(ICE_REPLY);
    await expandNotes(args({ sourceType: "document" }), m.llm, opts);
    expect(userText(m.calls[0])).toContain("\nDocument\n");
    await expandNotes(args({ sourceType: "podcast" as never }), m.llm, opts);
    expect(userText(m.calls[1])).toContain("\nOther\n");
  });

  it("rejects an unknown profile without calling the model", async () => {
    const m = mockLlm(ICE_REPLY);
    await expect(expandNotes(args({ profile: "rics" as never }), m.llm, opts)).rejects.toMatchObject({ kind: "bad_input" });
    expect(m.calls).toHaveLength(0);
  });

  it("describes only the allowed keys for each profile", async () => {
    const ice = mockLlm(ICE_REPLY);
    await expandNotes(args({ profile: "ice" }), ice.llm, opts);
    expect(ice.calls[0]?.system).toMatch(/"learningPoints"[\s\S]*"benefits"[\s\S]*"helped"[\s\S]*"future"[\s\S]*"nextYear"/);
    expect(ice.calls[0]?.system).not.toMatch(/developmentGained/);

    const ist = mockLlm('{"developmentGained":"x"}');
    await expandNotes(args({ profile: "istructe" }), ist.llm, opts);
    expect(ist.calls[0]?.system).toMatch(/developmentGained/);
    expect(ist.calls[0]?.system).toMatch(/ONE sentence/);
    expect(ist.calls[0]?.system).not.toMatch(/"benefits"|"learningPoints"/);

    const cus = mockLlm('{"learningPoints":"x"}');
    await expandNotes(args({ profile: "custom" }), cus.llm, opts);
    expect(cus.calls[0]?.system).toMatch(/learningPoints/);
    expect(cus.calls[0]?.system).not.toMatch(/"benefits"|developmentGained/);
  });

  it("tells the model to leave benefits blank unless the notes support them", async () => {
    const m = mockLlm(ICE_REPLY);
    await expandNotes(args(), m.llm, opts);
    const sys = m.calls[0]?.system ?? "";
    expect(sys).toMatch(/only if the notes say how it helped/);
    expect(sys).toMatch(/only if the notes say how the engineer will use it/);
    expect(sys).toMatch(/Use "" for any benefit the notes do not support/);
  });
});

describe("cleaning what goes in", () => {
  it("strips hidden characters and collapses whitespace in every field", async () => {
    const m = mockLlm(ICE_REPLY);
    await expandNotes(args({ title: "  A\u200B  title \n here ", provider: "P\u0000rov\tider", theme: " The\u200Dme ", notes: "line one\n\nline\u200B two\r\n\tline three" }), m.llm, opts);
    const lines = userText(m.calls[0]).split("\n");
    expect(lines[1]).toBe("A title here");
    expect(lines[4]).toBe("Prov ider");
    expect(lines[10]).toBe("Theme");
    expect(lines[13]).toBe("line one line two line three");
  });

  it("caps title at 200, provider at 100, theme at 120 and notes at 1200 characters", async () => {
    const m = mockLlm(ICE_REPLY);
    await expandNotes(args({ title: "t".repeat(500), provider: "p".repeat(500), theme: "h".repeat(500), notes: "n".repeat(5000) }), m.llm, opts);
    const lines = userText(m.calls[0]).split("\n");
    expect(lines[1]).toHaveLength(200);
    expect(lines[4]).toHaveLength(100);
    expect(lines[10]).toHaveLength(120);
    expect(lines[13]).toHaveLength(1200);
    expect(EXPAND_LIMITS).toEqual({ title: 200, provider: 100, theme: 120, notes: 1200 });
  });

  it("warns when the notes were cut", async () => {
    const m = mockLlm(ICE_REPLY);
    const out = await expandNotes(args({ notes: "word ".repeat(400) }), m.llm, opts);
    expect(out.warnings.some((w) => /longer than 1200 characters/.test(w))).toBe(true);
    const ok = await expandNotes(args({ notes: "short notes" }), m.llm, opts);
    expect(ok.warnings.some((w) => /longer than/.test(w))).toBe(false);
  });

  it("removes the boundary token from every field", async () => {
    const m = mockLlm(ICE_REPLY);
    await expandNotes(args({ title: `a ${BOUNDARY} b`, provider: BOUNDARY, theme: `x${BOUNDARY.toLowerCase()}y`, notes: `n ${BOUNDARY}` }), m.llm, opts);
    const user = userText(m.calls[0]);
    // The token appears only in the 10 marker lines.
    expect(user.split(BOUNDARY).length - 1).toBe(10);
    expect(user.toLowerCase().split(BOUNDARY.toLowerCase()).length - 1).toBe(10);
  });

  it("builds a prompt object that exposes exactly what the model sees for the scan", () => {
    const p = buildExpandPrompt(args({ title: " T ", provider: null, theme: null, notes: "N" }), BOUNDARY);
    expect(p?.sources).toEqual(["T", "N", "Webinar"]);
    expect(p?.notesTruncated).toBe(false);
  });

  it("returns null for blank notes and refuses a weak boundary token", () => {
    expect(buildExpandPrompt(args({ notes: " " }), BOUNDARY)).toBeNull();
    expect(() => buildExpandPrompt(args(), "short")).toThrow(ExpandError);
    expect(() => buildExpandPrompt(args(), "has space in it")).toThrow(ExpandError);
    expect(() => buildExpandPrompt(args(), "")).toThrow(ExpandError);
  });
});

describe("the answer: ICE", () => {
  it("fills learning points and the benefits the model returned", async () => {
    const m = mockLlm(ICE_REPLY);
    const out = await expandNotes(args(), m.llm, opts);
    expect(out.learningPoints).toBe("I learned how inspection intervals are set and why records matter.");
    expect(out.benefits).toEqual({ helped: "", future: "I will use it on my next structure review.", nextYear: "" });
    expect(out.developmentGained).toBe("");
    expect(out.warnings).toEqual([]);
  });

  it("leaves benefits blank when the model gives none, or leaves the benefits object out", async () => {
    const a = await expandNotes(args(), mockLlm(JSON.stringify({ learningPoints: "I learned records matter.", benefits: { helped: "", future: "", nextYear: "" } })).llm, opts);
    expect(a.benefits).toEqual({ helped: "", future: "", nextYear: "" });
    const b = await expandNotes(args(), mockLlm(JSON.stringify({ learningPoints: "I learned records matter." })).llm, opts);
    expect(b.benefits).toEqual({ helped: "", future: "", nextYear: "" });
    const c = await expandNotes(args(), mockLlm(JSON.stringify({ learningPoints: "I learned records matter.", benefits: { future: "I will use it." } })).llm, opts);
    expect(c.benefits).toEqual({ helped: "", future: "I will use it.", nextYear: "" });
  });

  it("accepts an answer in a markdown code fence", async () => {
    for (const wrap of ["```json\n%s\n```", "```\n%s\n```", "  ```JSON\r\n%s\r\n```  \n", "```json %s ```"]) {
      const out = await expandNotes(args(), mockLlm(wrap.replace("%s", ICE_REPLY)).llm, opts);
      expect(out.benefits.future).toBe("I will use it on my next structure review.");
    }
  });

  it("cleans hidden characters from the answer and says so", async () => {
    const reply = JSON.stringify({ learningPoints: "I learned\u200B records\u0000 matter.", benefits: { helped: "", future: "", nextYear: "" } });
    const out = await expandNotes(args(), mockLlm(reply).llm, opts);
    expect(out.learningPoints).toBe("I learned records matter.");
    expect(out.warnings).toContain("Some hidden characters were removed from the AI answer.");
  });

  it("tidies spacing but keeps line breaks in the answer", async () => {
    const reply = JSON.stringify({ learningPoints: "  First point.  \n\n\n\n Second   point. ", benefits: {} });
    const out = await expandNotes(args(), mockLlm(reply).llm, opts);
    expect(out.learningPoints).toBe("First point.\n\nSecond point.");
  });

  it("warns when every field is blank", async () => {
    const reply = JSON.stringify({ learningPoints: "", benefits: { helped: "", future: "", nextYear: "" } });
    const out = await expandNotes(args(), mockLlm(reply).llm, opts);
    expect(out.warnings.some((w) => /did not give the AI enough/.test(w))).toBe(true);
  });
});

describe("the answer: IStructE and Custom", () => {
  it("IStructE fills only the development sentence", async () => {
    const out = await expandNotes(args({ profile: "istructe" }), mockLlm('{"developmentGained":"I learned how inspection intervals are set and will apply it to my next structure review."}').llm, opts);
    expect(out.developmentGained).toMatch(/inspection intervals/);
    expect(out.learningPoints).toBe("");
    expect(out.benefits).toEqual({ helped: "", future: "", nextYear: "" });
    expect(out.warnings).toEqual([]);
  });

  it("IStructE warns about more than one sentence and keeps the text", async () => {
    const out = await expandNotes(args({ profile: "istructe" }), mockLlm('{"developmentGained":"I learned how records matter. I will use it on my next structure review."}').llm, opts);
    expect(out.developmentGained).toBe("I learned how records matter. I will use it on my next structure review.");
    expect(out.warnings.some((w) => /more than one sentence/.test(w))).toBe(true);
  });

  it("IStructE does not warn for abbreviations or decimals inside one sentence", async () => {
    const reply = '{"developmentGained":"I learned e.g. how intervals are set, approx. 2.5 years apart."}';
    const out = await expandNotes(args({ profile: "istructe", notes: "intervals e.g. set 2.5 years apart approx" }), mockLlm(reply).llm, opts);
    expect(out.warnings.filter((w) => /more than one sentence/.test(w))).toEqual([]);
  });

  it("Custom fills only learning points", async () => {
    const out = await expandNotes(args({ profile: "custom" }), mockLlm('{"learningPoints":"I learned how records matter."}').llm, opts);
    expect(out.learningPoints).toBe("I learned how records matter.");
    expect(out.developmentGained).toBe("");
    expect(out.benefits).toEqual({ helped: "", future: "", nextYear: "" });
  });
});

describe("rejecting bad answers", () => {
  async function rejected(profile: ExpandArgs["profile"], reply: string): Promise<ExpandError> {
    try {
      await expandNotes(args({ profile }), mockLlm(reply).llm, opts);
    } catch (e) {
      expect(e).toBeInstanceOf(ExpandError);
      return e as ExpandError;
    }
    throw new Error("Expected the answer to be rejected");
  }

  it.each([
    ["plain prose", "I learned that records matter."],
    ["prose around JSON", 'Here you go: {"learningPoints":"x","benefits":{}} Hope that helps!'],
    ["an empty reply", ""],
    ["only a fence", "```json\n```"],
    ["truncated JSON", '{"learningPoints":"x","benefits":{"helped":"'],
    ["a JSON array", '["x"]'],
    ["a JSON string", '"x"'],
    ["null", "null"],
    ["a number", "42"],
    ["a missing required key", '{"benefits":{}}'],
    ["a value that is not text", '{"learningPoints":5,"benefits":{}}'],
    ["a null value", '{"learningPoints":null,"benefits":{}}'],
    ["a nested object where text is expected", '{"learningPoints":{"a":"b"},"benefits":{}}'],
    ["benefits that is not an object", '{"learningPoints":"x","benefits":"none"}'],
    ["a benefit that is not text", '{"learningPoints":"x","benefits":{"helped":["a"]}}'],
    ["an extra top-level key", '{"learningPoints":"x","benefits":{},"isAdmin":true}'],
    ["an extra key inside benefits", '{"learningPoints":"x","benefits":{"other":"y"}}'],
    ["the IStructE key on the ICE profile", '{"learningPoints":"x","benefits":{},"developmentGained":"y"}'],
    ["learning points over 1200 characters", JSON.stringify({ learningPoints: "x".repeat(1201), benefits: {} })],
    ["a benefit over 600 characters", JSON.stringify({ learningPoints: "x", benefits: { helped: "x".repeat(601) } })],
    ["a __proto__ key", '{"learningPoints":"x","benefits":{},"__proto__":{"admin":true}}'],
    ["a constructor key", '{"learningPoints":"x","benefits":{},"constructor":"x"}'],
  ])("rejects %s (ICE)", async (_name, reply) => {
    const err = await rejected("ice", reply);
    expect(err.kind).toBe("bad_format");
    expect(err.message).toMatch(/nothing was filled in/);
    expect(err.message).toMatch(/Try again, or write your learning points yourself/);
  });

  it.each([
    ["the ICE keys", '{"learningPoints":"x"}'],
    ["an extra key", '{"developmentGained":"x","learningPoints":"y"}'],
    ["a missing key", "{}"],
    ["text over 400 characters", JSON.stringify({ developmentGained: "x".repeat(401) })],
    ["a non-text value", '{"developmentGained":["x"]}'],
  ])("rejects %s (IStructE)", async (_name, reply) => {
    expect((await rejected("istructe", reply)).kind).toBe("bad_format");
  });

  it.each([
    ["benefits", '{"learningPoints":"x","benefits":{}}'],
    ["the IStructE key", '{"learningPoints":"x","developmentGained":"y"}'],
    ["a missing key", "{}"],
  ])("rejects %s (Custom)", async (_name, reply) => {
    expect((await rejected("custom", reply)).kind).toBe("bad_format");
  });

  it("does not include any of the model's text in the error", async () => {
    const err = await rejected("ice", "MODEL-SAID-THIS-SECRET and some more");
    expect(err.message).not.toContain("MODEL-SAID-THIS-SECRET");
    const err2 = await rejected("ice", '{"learningPoints":"x","benefits":{},"leak":"MODEL-LEAK"}');
    expect(err2.message).not.toContain("MODEL-LEAK");
  });

  it("rejects an answer that repeats the boundary token as unusable", async () => {
    const reply = JSON.stringify({ learningPoints: `x ${BOUNDARY} y`, benefits: {} });
    const err = await rejected("ice", reply);
    expect(err.kind).toBe("unsafe_output");
    const lower = await rejected("ice", JSON.stringify({ learningPoints: BOUNDARY.toLowerCase(), benefits: {} }));
    expect(lower.kind).toBe("unsafe_output");
  });

  it("passes a model failure straight through unchanged", async () => {
    const failure = new LlmError("rate_limit", "The AI service is busy - try again in a minute", 429);
    await expect(expandNotes(args(), mockLlm(failure).llm, opts)).rejects.toBe(failure);
  });
});

describe("unsupported claims in the answer", () => {
  it("warns about numbers, years, standards and names that are not in the notes, and keeps the text", async () => {
    const reply = JSON.stringify({
      learningPoints: "I learned that BS 7671 sets 5 checks, updated in 2019 by Highways England.",
      benefits: { helped: "It cut rework by 30%.", future: "", nextYear: "" },
    });
    const out = await expandNotes(args(), mockLlm(reply).llm, opts);
    expect(out.learningPoints).toBe("I learned that BS 7671 sets 5 checks, updated in 2019 by Highways England.");
    expect(out.benefits.helped).toBe("It cut rework by 30%.");
    const joined = out.warnings.join("\n");
    expect(joined).toMatch(/"Key learning points"/);
    expect(joined).toContain('"BS 7671"');
    expect(joined).toContain('"5"');
    expect(joined).toContain('"2019"');
    expect(joined).toContain('"Highways England"');
    expect(joined).toMatch(/"How it helped"/);
    expect(joined).toContain('"30%"');
  });

  it("does not warn about things that are in the title, provider, theme or notes", async () => {
    const reply = JSON.stringify({
      learningPoints: "I learned about Bridge inspection from Test Institute under Safety and risk management, with 2 grades from BS 5489.",
      benefits: {},
    });
    const out = await expandNotes(args({ notes: "Two grades of defect, BS 5489 lighting" }), mockLlm(reply).llm, opts);
    expect(out.warnings).toEqual([]);
  });

  it("scans each benefit under its own label", async () => {
    const reply = JSON.stringify({ learningPoints: "I learned records matter.", benefits: { helped: "", future: "I will do it every 9 months.", nextYear: "I will book 12 sessions." } });
    const out = await expandNotes(args(), mockLlm(reply).llm, opts);
    expect(out.warnings.some((w) => w.includes('"How I will use it in future"') && w.includes('"9"'))).toBe(true);
    expect(out.warnings.some((w) => w.includes("How it will influence next year's plan") && w.includes('"12"'))).toBe(true);
  });

  it("warns when a benefit uses nothing from the notes, and keeps it", async () => {
    const reply = JSON.stringify({
      learningPoints: "I learned how inspection intervals are set.",
      benefits: { helped: "It improved my confidence in delivering projects.", future: "I will use it on my next structure review.", nextYear: "" },
    });
    const out = await expandNotes(args(), mockLlm(reply).llm, opts);
    expect(out.benefits.helped).toBe("It improved my confidence in delivering projects.");
    expect(out.warnings).toContain('Check "How it helped": it does not seem to use anything from your notes. Keep it only if it is true.');
    expect(out.warnings.some((w) => w.includes("How I will use it in future") && /does not seem/.test(w))).toBe(false);
  });

  it("does not run the benefit check on blank benefits, learning points, or other profiles", async () => {
    const blank = await expandNotes(args(), mockLlm(JSON.stringify({ learningPoints: "I learned something unrelated here.", benefits: {} })).llm, opts);
    expect(blank.warnings.some((w) => /does not seem/.test(w))).toBe(false);
    const ist = await expandNotes(args({ profile: "istructe" }), mockLlm('{"developmentGained":"Confidence grew."}').llm, opts);
    expect(ist.warnings.some((w) => /does not seem/.test(w))).toBe(false);
  });

  it("scans the IStructE and Custom fields", async () => {
    const ist = await expandNotes(args({ profile: "istructe" }), mockLlm('{"developmentGained":"I learned about Eurocode 7 in 2021."}').llm, opts);
    expect(ist.warnings.some((w) => w.includes('"Development gained"') && w.includes("Eurocode 7"))).toBe(true);
    const cus = await expandNotes(args({ profile: "custom" }), mockLlm('{"learningPoints":"I met Arup."}').llm, opts);
    expect(cus.warnings.some((w) => w.includes('"Learning points"') && w.includes("Arup"))).toBe(true);
  });

  it("compares against the cut-down notes the model actually saw", async () => {
    const notes = `${"filler ".repeat(300)} 77 extra`;
    const out = await expandNotes(args({ notes }), mockLlm('{"learningPoints":"It involved 77 things.","benefits":{}}').llm, opts);
    expect(out.warnings.some((w) => w.includes('"77"'))).toBe(true);
  });
});

describe("helpers", () => {
  it("stripCodeFence removes one fence around the whole text only", () => {
    expect(stripCodeFence('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(stripCodeFence('{"a":1}')).toBe('{"a":1}');
    expect(stripCodeFence('text ```json\n{"a":1}\n``` text')).toBe('text ```json\n{"a":1}\n``` text');
  });

  it("countSentences counts rough sentences", () => {
    expect(countSentences("")).toBe(0);
    expect(countSentences("One sentence here.")).toBe(1);
    expect(countSentences("One. Two. Three.")).toBe(3);
    expect(countSentences("Is it? Yes! Fine.")).toBe(3);
    expect(countSentences("It was about e.g. cost and approx. 2.5 weeks, i.e. soon.")).toBe(1);
    expect(countSentences("No full stop at the end")).toBe(1);
    expect(countSentences('She said "stop." Then left.')).toBe(2);
  });
});

describe("an answer cut off at the length limit", () => {
  function stoppedBecause(stopReason: string | undefined, reply: string): LlmProvider {
    return { name: "mock", complete: vi.fn(async () => ({ text: reply, inputTokens: 1, outputTokens: 1, stopReason })) };
  }

  it("is never used, even when what came back happens to be valid JSON", async () => {
    const err = await expandNotes(args(), stoppedBecause("max_tokens", ICE_REPLY), opts).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExpandError);
    expect((err as ExpandError).kind).toBe("bad_format");
  });

  it("is used when the model finished, or the provider did not say why it stopped", async () => {
    for (const stopReason of ["end_turn", undefined]) {
      const out = await expandNotes(args(), stoppedBecause(stopReason, ICE_REPLY), opts);
      expect(out.benefits.future).toBe("I will use it on my next structure review.");
    }
  });
});

describe("hasExpandableNotes", () => {
  it("is true when something is left after cleaning, and matches whether expandNotes calls the model", async () => {
    for (const notes of ["Learned about culverts.", "  x  ", "A\u200BB"]) {
      const m = mockLlm(ICE_REPLY);
      await expandNotes(args({ notes }), m.llm, opts);
      expect(hasExpandableNotes({ notes })).toBe(true);
      expect(m.calls).toHaveLength(1);
    }
  });

  it("is false for blank notes of every kind, exactly when expandNotes makes no call", async () => {
    for (const notes of ["", "   ", "\n\t \r\n", "\u200B\u200C\uFEFF", "\u0000\u0001", undefined as unknown as string, 42 as unknown as string]) {
      const m = mockLlm(ICE_REPLY);
      await expandNotes(args({ notes }), m.llm, opts);
      expect(hasExpandableNotes({ notes })).toBe(false);
      expect(m.calls).toHaveLength(0);
    }
  });
});

describe("the answer's code fence", () => {
  it("is removed quickly even around very long runs of blank space", () => {
    const start = performance.now();
    const unclosed = "```json\n{\"a\":1}" + " ".repeat(60000) + "x";
    expect(stripCodeFence(unclosed)).toBe(unclosed.trim());
    const closed = stripCodeFence("```json\n{\"a\":1}" + "\n \t".repeat(20000) + "\n```");
    expect(closed.startsWith('{"a":1}')).toBe(true);
    expect(performance.now() - start).toBeLessThan(1000);
  });

  it("takes off a language tag, with the content on the next line or the same one", () => {
    expect(stripCodeFence('```json {"a":1} ```')).toBe('{"a":1}');
    expect(stripCodeFence('  ```JSON\r\n{"a":1}\r\n```  \n')).toBe('{"a":1}');
    expect(stripCodeFence("```\n```")).toBe("");
  });
});

describe("a model answer that hides a claim in look-alike characters", () => {
  it("is flagged just as the plain text would be", async () => {
    const reply = JSON.stringify({
      learningPoints: "I learned that １２ audits under ＢＳ ５４８９ cut costs by ４０％ at Ｎｅｔｗｏｒｋ Ｒａｉｌ since １９９８.",
      benefits: { helped: "", future: "", nextYear: "" },
    });
    const out = await expandNotes(args({ notes: "Learned how records matter." }), mockLlm(reply).llm, opts);
    expect(out.warnings.length).toBeGreaterThan(0);
    const w = out.warnings.join("\n");
    for (const claim of ['"12"', '"BS 5489"', '"40%"', '"1998"', '"Network Rail"']) expect(w).toContain(claim);
  });

  it("flags a fraction or a multiple the notes never mentioned", async () => {
    const reply = JSON.stringify({ learningPoints: "I learned how costs fell by a third and output doubled.", benefits: {} });
    const out = await expandNotes(args({ notes: "Learned how records matter." }), mockLlm(reply).llm, opts);
    const w = out.warnings.join("\n");
    expect(w).toContain('"a third"');
    expect(w).toContain('"doubled"');
  });
});
