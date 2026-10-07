import { z } from "zod";
import { fail, ok, publicRoute, readJson } from "@/lib/api/route";
import { isHttps } from "@/lib/api/origin";
import { safeNext } from "@/lib/auth/safe-next";
import { setLocalSessionCookie } from "@/lib/auth/local-session";
import { getEnv, storeMode } from "@/lib/env";
import { findOrCreateLocalAccount } from "@/lib/store/local";

export const runtime = "nodejs";

const body = z.object({ email: z.string().max(254), next: z.string().max(500).optional() });

/** Local demo sign-in: email only, no password. It does not prove who you are. Not available with Supabase. */
export const POST = publicRoute(async (req) => {
  if (storeMode(getEnv()) !== "local") return fail("not_found", "This sign-in is only for local demo mode.", 404);
  const { email, next } = body.parse(await readJson(req, 5_000));
  const account = await findOrCreateLocalAccount(email);
  await setLocalSessionCookie(account.id, isHttps(req));
  return ok({ redirectTo: safeNext(next) });
});
