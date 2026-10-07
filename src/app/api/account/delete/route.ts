import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { authedRoute, ok, readJson } from "@/lib/api/route";
import { clearLocalSessionCookie } from "@/lib/auth/local-session";
import { createUserSupabase } from "@/lib/auth/supabase-server";
import { getEnv } from "@/lib/env";
import { logError } from "@/lib/security/redact";
import { deleteLocalAccount } from "@/lib/store/local";

export const runtime = "nodejs";

const body = z.object({ confirm: z.literal(true, { message: "Confirm that you want to delete your account." }) });

/**
 * Deletes the account and everything stored for it (UK GDPR erasure). In Supabase mode, removing the
 * sign-in record needs the server-only service-role key; without it, the data is deleted and the person is told.
 */
export const POST = authedRoute(async ({ req, ctx }) => {
  body.parse(await readJson(req, 1_000));
  const env = getEnv();

  if (ctx.mode === "local") {
    await deleteLocalAccount(ctx.user.id);
    await clearLocalSessionCookie();
    return ok({ deleted: "everything", message: "Your account and all of its data have been deleted." });
  }

  await ctx.store.deleteAllUserData(ctx.user.id);
  let accountRemoved = false;
  if (env.SUPABASE_SERVICE_ROLE_KEY && env.NEXT_PUBLIC_SUPABASE_URL) {
    try {
      const admin = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { error } = await admin.auth.admin.deleteUser(ctx.user.id);
      accountRemoved = !error;
      if (error) logError("account-delete", new Error("Supabase refused to remove the sign-in record."));
    } catch (err) {
      logError("account-delete", err);
    }
  }
  const client = await createUserSupabase();
  await client.auth.signOut();
  return ok(
    accountRemoved
      ? { deleted: "everything", message: "Your account and all of its data have been deleted." }
      : {
          deleted: "data_only",
          message:
            "All of your entries and settings have been deleted and you've been signed out. Your sign-in record could not be removed automatically, so please ask the site owner to remove it.",
        },
  );
});
