import "server-only";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { features, getEnv, storeMode, type FeatureFlags, type StoreMode } from "@/lib/env";
import { createLocalStore, getLocalAccountById } from "@/lib/store/local";
import { createSupabaseStore } from "@/lib/store/supabase";
import type { Store } from "@/lib/store/types";
import type { SessionUser, UserSettings } from "@/lib/types";
import { readLocalSessionCookie } from "./local-session";
import { safeNext, signInPath } from "./safe-next";
import { createUserSupabase } from "./supabase-server";

export interface AppContext {
  user: SessionUser;
  store: Store;
  mode: StoreMode;
  features: FeatureFlags;
}

export interface PageContext extends AppContext {
  settings: UserSettings;
}

/**
 * The signed-in user and their store, or null. In Supabase mode the store uses the user's own session
 * so row-level security applies to every query. In local demo mode the cookie must name a real account.
 */
export async function getOptionalContext(): Promise<AppContext | null> {
  const env = getEnv();
  const mode = storeMode(env);
  const flags = features(env);

  if (mode === "supabase") {
    const client = await createUserSupabase();
    const { data, error } = await client.auth.getUser();
    const u = data?.user;
    if (error || !u) return null;
    return {
      user: { id: u.id, email: u.email ?? "" },
      store: createSupabaseStore(client),
      mode,
      features: flags,
    };
  }

  const id = await readLocalSessionCookie();
  if (!id) return null;
  const account = await getLocalAccountById(id);
  if (!account) return null;
  return {
    user: { id: account.id, email: account.email },
    store: createLocalStore(undefined, { requireAccount: true }),
    mode,
    features: flags,
  };
}

/** Where the middleware says the visitor was heading, so sign-in can send them back there. */
async function requestedPath(): Promise<string> {
  const h = await headers();
  const path = h.get("x-pathname") ?? "/dashboard";
  const search = h.get("x-search") ?? "";
  return safeNext(`${path}${search}`);
}

/**
 * Every signed-in page calls this once. It never asserts that a session exists: a missing session
 * redirects to sign-in with the page the person asked for.
 */
export async function requirePageContext(): Promise<PageContext> {
  const ctx = await getOptionalContext();
  if (!ctx) redirect(signInPath(await requestedPath()));
  const settings = await ctx.store.getSettings(ctx.user.id);
  return { ...ctx, settings };
}
