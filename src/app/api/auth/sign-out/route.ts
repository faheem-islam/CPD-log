import { NextResponse } from "next/server";
import { publicOrigin } from "@/lib/api/origin";
import { clearLocalSessionCookie } from "@/lib/auth/local-session";
import { createUserSupabase } from "@/lib/auth/supabase-server";
import { getEnv, storeMode } from "@/lib/env";
import { isSameOrigin } from "@/lib/security/same-origin";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  const to = `${publicOrigin(req)}/sign-in`;
  if (!isSameOrigin(req)) return NextResponse.redirect(to, 303);
  if (storeMode(getEnv()) === "supabase") {
    const client = await createUserSupabase();
    await client.auth.signOut();
  } else {
    await clearLocalSessionCookie();
  }
  return NextResponse.redirect(to, 303);
}
