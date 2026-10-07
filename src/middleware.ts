import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { parseEnv, storeMode } from "@/lib/env";

type CookieToSet = { name: string; value: string; options?: Record<string, unknown> };

export async function middleware(req: NextRequest) {
  const env = parseEnv(process.env as Record<string, string | undefined>);
  const { pathname, search } = req.nextUrl;

  // Pass the requested path to server components so sign-in can return people to the page they asked for.
  const forwarded = new Headers(req.headers);
  forwarded.set("x-pathname", pathname);
  forwarded.set("x-search", search);
  let res = NextResponse.next({ request: { headers: forwarded } });

  // Supabase mode: keep the session cookie fresh. Signed-out visitors are sent to sign-in by
  // requirePageContext() in the page itself, with a relative redirect that keeps them on the host they used.
  if (storeMode(env) === "supabase") {
    const supabase = createServerClient(env.NEXT_PUBLIC_SUPABASE_URL ?? "", env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "", {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (list: CookieToSet[]) => {
          for (const c of list) req.cookies.set(c.name, c.value);
          res = NextResponse.next({ request: { headers: forwarded } });
          for (const c of list) res.cookies.set(c.name, c.value, c.options);
        },
      },
    });
    await supabase.auth.getUser();
  }

  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|woff2?)$).*)"],
};
