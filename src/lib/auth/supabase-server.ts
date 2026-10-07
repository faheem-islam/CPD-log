import "server-only";
import { cookies } from "next/headers";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getEnv } from "@/lib/env";

type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };

/** A Supabase client bound to the signed-in user's cookies. Row-level security applies to everything it does. */
export async function createUserSupabase(): Promise<SupabaseClient> {
  const env = getEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) throw new Error("Supabase is not configured.");
  const jar = await cookies();
  return createServerClient(url, anon, {
    cookies: {
      getAll: () => jar.getAll(),
      setAll: (list: CookieToSet[]) => {
        try {
          for (const c of list) jar.set(c.name, c.value, c.options);
        } catch {
          // Called from a Server Component, where cookies are read-only. The middleware refreshes them.
        }
      },
    },
  });
}
