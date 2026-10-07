import "server-only";
import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { getOptionalContext, type AppContext } from "@/lib/auth/context";
import { EnvError } from "@/lib/env";
import { ImportError } from "@/lib/import";
import { AiCapError, ExpandError, LlmError, TranscribeError } from "@/lib/llm";
import { UnsafeUrlError } from "@/lib/net";
import { logError, redactSecrets } from "@/lib/security/redact";
import { isSameOrigin } from "@/lib/security/same-origin";
import { StoreError, StoreInputError } from "@/lib/store/mapping";

import type { ApiErrorBody, ApiErrorCode } from "./route-types";

export type { ApiErrorBody, ApiErrorCode };

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, { ...init, headers: { "Cache-Control": "no-store", ...(init?.headers ?? {}) } });
}

export function fail(code: ApiErrorCode, message: string, status: number, extra?: { retryAfterSeconds?: number }): NextResponse {
  const body: ApiErrorBody = { error: { code, message, ...(extra ?? {}) } };
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (extra?.retryAfterSeconds) headers["Retry-After"] = String(extra.retryAfterSeconds);
  return NextResponse.json(body, { status, headers });
}

/** Reads a JSON body with a size cap. Throws a BadRequest the wrapper turns into a 400. */
export class BadRequest extends Error {}

export async function readJson(req: Request, maxBytes = 200_000): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > maxBytes) throw new BadRequest("That request is too large.");
  const text = await req.text();
  if (text.length > maxBytes) throw new BadRequest("That request is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new BadRequest("The request was not valid JSON.");
  }
}

/** Maps anything thrown by a handler to a safe, plain-language response. Keys are scrubbed from every message. */
export function errorResponse(err: unknown): NextResponse {
  if (err instanceof BadRequest) return fail("bad_request", err.message, 400);
  if (err instanceof ZodError) {
    const first = err.issues[0];
    return fail("bad_request", first ? `${first.path.join(".") || "Request"}: ${first.message}` : "The request was not valid.", 400);
  }
  if (err instanceof AiCapError) return fail("ai_cap", err.message, 429);
  if (err instanceof ExpandError || err instanceof TranscribeError) return fail("ai_failed", redactSecrets(err.message), 422);
  if (err instanceof LlmError) return fail("ai_failed", redactSecrets(err.message), 502);
  if (err instanceof ImportError) return fail("import_error", err.message, 400);
  if (err instanceof UnsafeUrlError) return fail("bad_request", err.message, 400);
  if (err instanceof StoreInputError) return fail("bad_request", err.message, 400);
  if (err instanceof StoreError) return fail("store_error", err.message, 503);
  if (err instanceof EnvError) return fail("config", "The server is not set up correctly. See the README.", 500);
  logError("api", err);
  return fail("internal", "Something went wrong on our side. Try again in a moment.", 500);
}

type Handler<P> = (args: { req: Request; ctx: AppContext; params: P }) => Promise<Response>;

/**
 * Wraps a signed-in route: same-origin check for mutations, session check, and error mapping.
 * Handlers return a Response and may throw; everything thrown ends up as a safe JSON error.
 */
export function authedRoute<P = Record<string, never>>(handler: Handler<P>) {
  return async (req: Request, routeCtx?: { params: Promise<P> }): Promise<Response> => {
    try {
      if (!isSameOrigin(req)) return fail("same_origin", "That request did not come from this site, so it was refused.", 403);
      const ctx = await getOptionalContext();
      if (!ctx) return fail("unauthorised", "You need to sign in again.", 401);
      const params = (routeCtx?.params ? await routeCtx.params : ({} as P)) as P;
      return await handler({ req, ctx, params });
    } catch (err) {
      return errorResponse(err);
    }
  };
}

/** For routes that must work signed out (sign-in). Same-origin and error mapping only. */
export function publicRoute(handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      if (!isSameOrigin(req)) return fail("same_origin", "That request did not come from this site, so it was refused.", 403);
      return await handler(req);
    } catch (err) {
      return errorResponse(err);
    }
  };
}
