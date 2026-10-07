import type { ExtractStatus } from "@/lib/types";

/** Why a page could not be read, in words a user can act on. */
export type ReadFailureKind = Exclude<ExtractStatus, "ok">;

export type ReadOutcome =
  | { kind: "ok"; finalUrl: string; status: number; contentType: string; body: string; fromCache: boolean }
  | { kind: ReadFailureKind; message: string };

/**
 * Reads public web pages politely. Implementations must: validate the URL (SSRF), obey robots.txt,
 * follow redirects manually re-validating each hop, cap time and size, send no cookies, and never
 * try to get around a block, a login or a bot challenge.
 */
export interface PageReader {
  read(url: string): Promise<ReadOutcome>;
}

export type ApiOutcome =
  | { kind: "ok"; status: number; json: unknown }
  | { kind: "http_error"; status: number }
  | { kind: "unsafe_url" | "failed"; message: string };

/** For documented JSON APIs (YouTube Data API, YouTube oEmbed). No robots.txt check, same SSRF rules. */
export interface ApiFetcher {
  getJson(url: string, opts?: { headers?: Record<string, string> }): Promise<ApiOutcome>;
}
