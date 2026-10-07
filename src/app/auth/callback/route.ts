import { NextResponse } from "next/server";
import { publicOrigin } from "@/lib/api/origin";
import { safeNext } from "@/lib/auth/safe-next";
import { createUserSupabase } from "@/lib/auth/supabase-server";
import { getEnv, storeMode } from "@/lib/env";

export const runtime = "nodejs";

/** Where the emailed sign-in link lands. Exchanges the code for a session, then returns the person to the page they asked for. */
export async function GET(req: Request): Promise<Response> {
  const origin = publicOrigin(req);
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get("next"));
  if (storeMode(getEnv()) !== "supabase") return NextResponse.redirect(`${origin}/sign-in`);

  const client = await createUserSupabase();
  const code = url.searchParams.get("code");
  const tokenHash = url.searchParams.get("token_hash");
  let failed = true;
  if (code) {
    const { error } = await client.auth.exchangeCodeForSession(code);
    failed = Boolean(error);
  } else if (tokenHash) {
    const { error } = await client.auth.verifyOtp({ token_hash: tokenHash, type: "email" });
    failed = Boolean(error);
  }
  if (failed) return NextResponse.redirect(`${origin}/sign-in?error=link&next=${encodeURIComponent(next)}`);
  return NextResponse.redirect(`${origin}${next}`);
}
