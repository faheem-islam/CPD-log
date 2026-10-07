import { z } from "zod";
import { getEnv, type Env } from "@/lib/env";
import { scrubSecrets } from "./scrub";
import { LlmError, type LlmContentPart, type LlmErrorKind, type LlmMessage, type LlmProvider, type LlmRequest, type LlmResponse } from "./types";

/**
 * Anthropic Messages API over plain fetch.
 *
 * The API key is read once, kept in this closure and sent only in the x-api-key header. It is never put in a URL
 * or a body, never logged, and never copied into an error. Error messages are fixed sentences; the response body
 * of a failed call is not read, so nothing the server echoes can reach the user or the logs. Every message also
 * goes through scrubSecrets as a second guard.
 *
 * There are no retries. A failed call fails once, with a message saying what to do.
 */

export const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const LLM_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TOKENS_LIMIT = 8192;

export interface AnthropicOptions {
  apiKey: string;
  /** The model name from configuration (LLM_MODEL). Call sites never hard-code one. */
  model: string;
  /** For tests. Defaults to the global fetch at call time. */
  fetchImpl?: typeof fetch;
  /** For tests. Defaults to 30 seconds. */
  timeoutMs?: number;
}

const responseSchema = z.object({
  content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  stop_reason: z.string().nullable().optional(),
  // Token counts are whole numbers. A negative or fractional count would corrupt any usage totals built from it.
  usage: z.object({ input_tokens: z.number().int().min(0), output_tokens: z.number().int().min(0) }),
});

/** Printable ASCII with no spaces: the only characters that can travel in an HTTP header value. */
const API_KEY_RE = /^[\x21-\x7e]+$/;

function toApiContent(content: string | LlmContentPart[]): string | Record<string, unknown>[] {
  if (typeof content === "string") return content;
  return content.map((part) =>
    part.type === "text"
      ? { type: "text", text: part.text }
      : { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.base64 } },
  );
}

function toApiMessages(messages: LlmMessage[]): { role: string; content: string | Record<string, unknown>[] }[] {
  return messages.map((m) => ({ role: m.role, content: toApiContent(m.content) }));
}

export function createAnthropicProvider(options: AnthropicOptions): LlmProvider {
  const apiKey = options.apiKey.trim();
  const model = options.model.trim();
  if (!apiKey) throw new Error("An AI key is needed to create the AI provider. Set ANTHROPIC_API_KEY on the server.");
  if (!model) throw new Error("An AI model name is needed. Set LLM_MODEL on the server, or leave it blank for the default.");
  // A key with a space, a line break or a non-ASCII character inside it makes fetch fail while it builds the headers.
  // Say so here, rather than let that look like a network outage. The key itself is never put in the message.
  if (!API_KEY_RE.test(apiKey)) throw new LlmError("auth", "The AI key was rejected - check ANTHROPIC_API_KEY on the server");
  const timeoutMs = options.timeoutMs ?? LLM_TIMEOUT_MS;

  function fail(kind: LlmErrorKind, message: string, status?: number): never {
    throw new LlmError(kind, scrubSecrets(message, apiKey), status);
  }

  return {
    name: "anthropic",

    async complete(req: LlmRequest): Promise<LlmResponse> {
      if (!Number.isInteger(req.maxTokens) || req.maxTokens < 1 || req.maxTokens > MAX_OUTPUT_TOKENS_LIMIT) {
        fail("bad_request", "The AI request was not valid: the answer length limit is out of range.");
      }
      if (req.messages.length === 0) fail("bad_request", "The AI request was not valid: there was no message to send.");

      const body: Record<string, unknown> = {
        model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages: toApiMessages(req.messages),
      };
      if (req.temperature !== undefined) body.temperature = req.temperature;

      const doFetch = options.fetchImpl ?? globalThis.fetch;
      // One signal for the whole call, so a slow body read is cut off by the same deadline as a slow connection.
      const signal = AbortSignal.timeout(timeoutMs);
      let res: Response;
      try {
        res = await doFetch(ANTHROPIC_ENDPOINT, {
          method: "POST",
          headers: {
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          signal,
          // Never follow a redirect: the key header would go with it.
          redirect: "error",
          cache: "no-store",
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name === "TimeoutError" || name === "AbortError") {
          fail("timeout", "The AI service took too long to answer. Try again in a minute.");
        }
        fail("network", "CPD Logger could not reach the AI service. Check the server's internet connection and try again.");
      }

      if (!res.ok) {
        // Do not read the body: it is not needed and must not be echoed.
        await res.body?.cancel().catch(() => undefined);
        const s = res.status;
        if (s === 401 || s === 403) fail("auth", "The AI key was rejected - check ANTHROPIC_API_KEY on the server", s);
        if (s === 429) fail("rate_limit", "The AI service is busy - try again in a minute", s);
        if (s === 404) fail("bad_request", "The AI model was not found - check LLM_MODEL on the server", s);
        if (s === 408) fail("timeout", "The AI service took too long to answer. Try again in a minute.", s);
        if (s >= 500) fail("server", "The AI service had a problem on its side - try again in a minute", s);
        fail("bad_request", "The AI service could not process this request. Try shorter notes or a smaller image.", s);
      }

      let json: unknown;
      try {
        json = await res.json();
      } catch (err) {
        // The deadline can also pass while the body is still arriving. That is a timeout, not an unreadable answer.
        const name = err instanceof Error ? err.name : "";
        if (signal.aborted || name === "TimeoutError" || name === "AbortError") {
          fail("timeout", "The AI service took too long to answer. Try again in a minute.");
        }
        fail("bad_response", "The AI service sent an answer CPD Logger could not read. Try again.", res.status);
      }
      const parsed = responseSchema.safeParse(json);
      if (!parsed.success) fail("bad_response", "The AI service sent an answer CPD Logger could not read. Try again.", res.status);
      if (parsed.data.stop_reason === "refusal") {
        fail("refused", "The AI service declined this request. Try different wording, or do this step by hand.");
      }
      const text = parsed.data.content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text ?? "")
        .join("");
      if (text.trim() === "") fail("bad_response", "The AI service sent back an empty answer. Try again.", res.status);

      const result: LlmResponse = { text, inputTokens: parsed.data.usage.input_tokens, outputTokens: parsed.data.usage.output_tokens };
      if (parsed.data.stop_reason) result.stopReason = parsed.data.stop_reason;
      return result;
    },
  };
}

/** The provider when ANTHROPIC_API_KEY is set, otherwise null (the AI features are off). */
export function getLlmProvider(env: Env = getEnv(), fetchImpl?: typeof fetch): LlmProvider | null {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  return createAnthropicProvider({ apiKey, model: env.LLM_MODEL, fetchImpl });
}
