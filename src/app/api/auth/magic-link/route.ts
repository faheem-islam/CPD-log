import { z } from "zod";
import { fail, ok, publicRoute, readJson } from "@/lib/api/route";
import { publicOrigin } from "@/lib/api/origin";
import { safeNext } from "@/lib/auth/safe-next";
import { createUserSupabase } from "@/lib/auth/supabase-server";
import { getEnv, storeMode } from "@/lib/env";

export const runtime = "nodejs";

const body = z.object({
  email: z.string().trim().email("Enter a valid email address, for example name@example.com.").max(254),
  next: z.string().max(500).optional(),
});

/** Sends a one-time sign-in link by email through Supabase Auth. */
export const POST = publicRoute(async (req) => {
  if (storeMode(getEnv()) !== "supabase") return fail("not_found", "Email links are only used when Supabase is set up.", 404);
  const { email, next } = body.parse(await readJson(req, 5_000));
  const client = await createUserSupabase();
  const redirect = `${publicOrigin(req)}/auth/callback?next=${encodeURIComponent(safeNext(next))}`;
  const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: redirect } });
  if (error) {
    // Do not reveal whether an address is known. Report only that it could not be sent.
    return fail("bad_request", "We couldn't send the sign-in link. Check the address and try again in a minute.", 400);
  }
  return ok({ sent: true });
});
