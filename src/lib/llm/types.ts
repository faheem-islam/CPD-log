/**
 * Provider-agnostic shapes for the AI features. Nothing here knows about a specific vendor.
 *
 * What may be sent to a model: a resource's title, provider, source type and theme, the user's own notes,
 * and screenshots the user uploads themselves. Text copied from a web page never goes to a model.
 */

export type LlmImageMediaType = "image/png" | "image/jpeg" | "image/webp" | "image/gif";

export interface LlmTextPart {
  type: "text";
  text: string;
}

export interface LlmImagePart {
  type: "image";
  mediaType: LlmImageMediaType;
  /** Raw base64, no "data:" prefix. */
  base64: string;
}

export type LlmContentPart = LlmTextPart | LlmImagePart;

export interface LlmMessage {
  role: "user" | "assistant";
  content: string | LlmContentPart[];
}

export interface LlmRequest {
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  temperature?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmResponse extends LlmUsage {
  text: string;
  /**
   * Why the model stopped, as the provider reported it ("end_turn", "max_tokens", ...). Absent when the provider
   * did not say. "max_tokens" means the answer was cut off at the length limit and is incomplete.
   */
  stopReason?: string;
}

export interface LlmProvider {
  readonly name: string;
  complete(req: LlmRequest): Promise<LlmResponse>;
}

export type LlmErrorKind = "auth" | "rate_limit" | "server" | "timeout" | "network" | "bad_request" | "bad_response" | "refused";

/** A failed model call. The message is written for the user and never contains an API key. */
export class LlmError extends Error {
  readonly kind: LlmErrorKind;
  /** The HTTP status, when there was one. */
  readonly status: number | undefined;

  constructor(kind: LlmErrorKind, message: string, status?: number) {
    super(message);
    this.name = "LlmError";
    this.kind = kind;
    this.status = status;
  }
}
