import type { ApiErrorBody, ApiErrorCode } from "./route-types";

/** An error from our own API, already worded for the person using the app. */
export class ApiClientError extends Error {
  readonly code: ApiErrorCode | "network";
  readonly status: number;
  readonly retryAfterSeconds?: number;
  constructor(message: string, code: ApiErrorCode | "network", status: number, retryAfterSeconds?: number) {
    super(message);
    this.name = "ApiClientError";
    this.code = code;
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

interface ApiOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as multipart form data (file uploads). */
  form?: FormData;
  signal?: AbortSignal;
}

/**
 * Calls one of our own /api routes from the browser. Same-origin only. On failure it throws an
 * ApiClientError whose message can be shown to the person as it is.
 */
export async function api<T>(path: string, opts: ApiOptions = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method: opts.method ?? (opts.json !== undefined || opts.form ? "POST" : "GET"),
      headers: opts.json !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: opts.form ?? (opts.json !== undefined ? JSON.stringify(opts.json) : undefined),
      signal: opts.signal,
      credentials: "same-origin",
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") throw err;
    throw new ApiClientError("We couldn't reach the server. Check your connection and try again.", "network", 0);
  }

  if (res.status === 401) {
    // The session has ended. Go back through sign-in and return to this page afterwards.
    if (typeof window !== "undefined") {
      const here = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/sign-in?next=${encodeURIComponent(here)}`);
    }
    throw new ApiClientError("You need to sign in again.", "unauthorised", 401);
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const err = (data as ApiErrorBody | null)?.error;
    throw new ApiClientError(
      err?.message ?? "Something went wrong. Try again in a moment.",
      err?.code ?? "internal",
      res.status,
      err?.retryAfterSeconds,
    );
  }
  return data as T;
}
