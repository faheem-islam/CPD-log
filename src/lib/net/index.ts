/**
 * Network safety and polite page reading. Server only.
 *
 * Use getPageReader() and getApiFetcher() in the app. The create* functions take injectable parts
 * (transport, DNS resolver, clock) so tests never touch the network.
 */
import { getEnv } from "@/lib/env";
import { createApiFetcher, createPageReader } from "./reader";
import type { ApiFetcher, PageReader } from "./types";

export { assertSafeUrl, createValidatingLookup, isBlockedIp, UnsafeUrlError, BlockedAddressError } from "./ssrf";
export type { Resolver, ResolvedAddress, SsrfDeps, UnsafeUrlCode } from "./ssrf";
export { buildUserAgent, createUndiciTransport, safeRequest, BOT_PRODUCT_TOKEN } from "./safe-request";
export type {
  SafeFailure,
  SafeFailureCode,
  SafeRequestDeps,
  SafeRequestOptions,
  SafeResult,
  SafeSuccess,
  Transport,
  TransportRequest,
  TransportResponse,
} from "./safe-request";
export { createRobotsChecker, isPathAllowed, parseRobots } from "./robots";
export type { RobotsChecker, RobotsDecision } from "./robots";
export { detectBotChallenge, detectLoginWall, identifyBotChallenge, inspectBotChallenge } from "./challenge";
export { createApiFetcher, createPageReader } from "./reader";
export type { ApiFetcherDeps, PageReaderDeps } from "./reader";
export type { ApiFetcher, ApiOutcome, PageReader, ReadFailureKind, ReadOutcome } from "./types";

let pageReader: PageReader | undefined;
let apiFetcher: ApiFetcher | undefined;

/** One shared reader per server process, so the robots.txt cache is shared too. */
export function getPageReader(): PageReader {
  pageReader ??= createPageReader({ contact: getEnv().CPD_BOT_CONTACT });
  return pageReader;
}

/** One shared API fetcher per server process. */
export function getApiFetcher(): ApiFetcher {
  apiFetcher ??= createApiFetcher({ contact: getEnv().CPD_BOT_CONTACT });
  return apiFetcher;
}

/** For tests only. */
export function resetNetSingletons(): void {
  pageReader = undefined;
  apiFetcher = undefined;
}
