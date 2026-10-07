import { describe, expect, it } from "vitest";
import { cleanModelText, removeTokens, sanitiseForPrompt, stripHidden, truncateChars, unwrapCodeFence } from "@/lib/llm/sanitise";

describe("stripHidden", () => {
  it("removes control characters but not ordinary whitespace", () => {
    expect(stripHidden("a\u0000b\u0007c\u001Fd\u007Fe\u0085f").text).toBe("abcdef");
    expect(stripHidden("a\tb\nc\r\nd").text).toBe("a\tb\nc\r\nd");
  });

  it("removes zero-width, bidi, word-joiner, BOM, soft-hyphen and tag characters", () => {
    const hidden = "\u200B\u200C\u200D\u200E\u200F\u202A\u202E\u2060\u2066\u2069\uFEFF\u00AD";
    expect(stripHidden(`a${hidden}b`).text).toBe("ab");
    expect(stripHidden("a\u{E0041}\u{E0020}\u{E007F}b").text).toBe("ab");
    expect(stripHidden("a\u{E0100}b").text).toBe("ab");
  });

  it("removes characters that render as blanks", () => {
    expect(stripHidden("a\u3164b\uFFA0c\u115Fd\u180Ee").text).toBe("abcde");
  });

  it("removes lone surrogates but keeps real emoji", () => {
    expect(stripHidden("a\uD800b\uDC00c").text).toBe("abc");
    expect(stripHidden("ok \u{1F600} ok").text).toBe("ok \u{1F600} ok");
  });

  it("reports whether anything was removed", () => {
    expect(stripHidden("plain").removed).toBe(false);
    expect(stripHidden("pl\u200Bain").removed).toBe(true);
  });
});

describe("truncateChars", () => {
  it("leaves short text alone", () => {
    expect(truncateChars("abc", 3)).toEqual({ text: "abc", truncated: false });
  });
  it("cuts long text and says so", () => {
    expect(truncateChars("abcdef", 3)).toEqual({ text: "abc", truncated: true });
  });
  it("does not split a surrogate pair", () => {
    const out = truncateChars("ab\u{1F600}cd", 3);
    expect(out.text).toBe("ab");
    expect(out.truncated).toBe(true);
    expect(out.text.endsWith("\uD83D")).toBe(false);
  });
  it("trims trailing space left by the cut", () => {
    expect(truncateChars("abc def", 4).text).toBe("abc");
  });
});

describe("removeTokens", () => {
  it("removes every copy, in any case", () => {
    expect(removeTokens("a TOKEN123x b token123X c", ["TOKEN123X"])).toBe("a  b  c");
  });

  it("removes a token that is rebuilt by removing another copy inside it", () => {
    expect(removeTokens("TOKTOKEN123EN123", ["TOKEN123"])).toBe("");
    expect(removeTokens("TTOKEN123OKEN123", ["TOKEN123"])).toBe("");
  });

  it("does nothing with no tokens or empty tokens", () => {
    expect(removeTokens("text", [])).toBe("text");
    expect(removeTokens("text", [""])).toBe("text");
  });

  it("treats the token as plain text, not a pattern", () => {
    expect(removeTokens("a.*b axxb", ["a.*b"])).toBe(" axxb");
    expect(removeTokens("x(1)y", ["(1)"])).toBe("xy");
  });
});

describe("sanitiseForPrompt", () => {
  it("collapses all whitespace, including line breaks, to single spaces", () => {
    expect(sanitiseForPrompt("  one \n\n two\t\tthree \r\n four  ", 100).text).toBe("one two three four");
  });

  it("strips hidden characters before collapsing", () => {
    expect(sanitiseForPrompt("ig\u200Bnore\u0000 this", 100).text).toBe("ignore this");
  });

  it("removes the boundary token, including when hidden characters were used to split it", () => {
    expect(sanitiseForPrompt("before B1234ABCD after", 100, ["B1234ABCD"]).text).toBe("before after");
    expect(sanitiseForPrompt("before B12\u200B34AB\u200DCD after", 100, ["B1234ABCD"]).text).toBe("before after");
    expect(sanitiseForPrompt("before b1234abcd after", 100, ["B1234ABCD"]).text).toBe("before after");
  });

  it("removes a token that whitespace removal would have joined up", () => {
    expect(sanitiseForPrompt("B12 34ABCD", 100, ["B1234ABCD"]).text).toBe("B12 34ABCD");
    expect(sanitiseForPrompt("B12\u200B\u200B34ABCD", 100, ["B1234ABCD"]).text).toBe("");
  });

  it("caps the length and reports it", () => {
    const out = sanitiseForPrompt("x".repeat(500), 200);
    expect(out.text).toHaveLength(200);
    expect(out.truncated).toBe(true);
  });

  it("returns empty text for things that are not strings", () => {
    for (const v of [null, undefined, 5, {}, []]) expect(sanitiseForPrompt(v, 100)).toEqual({ text: "", truncated: false });
  });

  it("returns empty text for input that is only hidden characters or spaces", () => {
    expect(sanitiseForPrompt("\u200B\u200B \u0000 \n\t", 100).text).toBe("");
  });
});

describe("cleanModelText", () => {
  it("keeps line breaks but limits blank lines and trims every line", () => {
    expect(cleanModelText("  one  \n\n\n\n  two   words \r\nthree").text).toBe("one\n\ntwo words\nthree");
  });

  it("removes hidden characters and says so", () => {
    expect(cleanModelText("a\u200Bb")).toEqual({ text: "ab", removedHidden: true });
    expect(cleanModelText("ab")).toEqual({ text: "ab", removedHidden: false });
  });
});

describe("unwrapCodeFence", () => {
  it("returns null unless the whole text is inside one fence", () => {
    for (const t of ["", "plain", "```", "``````x", "```\nonly an opening fence", "only a closing fence\n```", "text ```a``` text", "`` `a` ``"]) {
      expect(unwrapCodeFence(t), JSON.stringify(t)).toBeNull();
    }
  });

  it("returns what is inside, without the fences, the language tag or the line break before the closing fence", () => {
    expect(unwrapCodeFence("```\nA\tB\n```")).toBe("A\tB");
    expect(unwrapCodeFence("```json\n{\"a\":1}\n```")).toBe('{"a":1}');
    expect(unwrapCodeFence("  ```json  \r\n{\"a\":1}\r\n```  \n")).toBe('{"a":1}');
    expect(unwrapCodeFence("```\n\nA\n\n```")).toBe("\nA\n");
    expect(unwrapCodeFence("``````")).toBe("");
    expect(unwrapCodeFence("```json```")).toBe("");
  });

  it("takes a tag off a line that also has content only by default", () => {
    expect(unwrapCodeFence("```json {\"a\":1}```")).toBe('{"a":1}');
    expect(unwrapCodeFence("```json {\"a\":1}```", { tagOnOwnLine: true })).toBe('json {"a":1}');
    expect(unwrapCodeFence("```A\tB\n1\t2\n```", { tagOnOwnLine: true })).toBe("A\tB\n1\t2");
    expect(unwrapCodeFence("```tsv\nA\tB\n```", { tagOnOwnLine: true })).toBe("A\tB");
  });

  it("keeps leading tabs of the first row when told a tag must be on its own line", () => {
    expect(unwrapCodeFence("```\n\tA\tB\n```", { tagOnOwnLine: true })).toBe("\tA\tB");
    expect(unwrapCodeFence("```\tA\tB\n```", { tagOnOwnLine: true })).toBe("\tA\tB");
  });

  it("is linear: long runs of blank space take milliseconds", () => {
    const start = performance.now();
    unwrapCodeFence("```\nA" + " ".repeat(200_000) + "\n```");
    unwrapCodeFence("```\nA" + "\n \t".repeat(100_000) + "x");
    unwrapCodeFence("```" + " ".repeat(200_000) + "x```");
    expect(performance.now() - start).toBeLessThan(500);
  });
});
