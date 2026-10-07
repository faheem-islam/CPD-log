import { z } from "zod";
import { authedRoute, fail, ok } from "@/lib/api/route";

export const runtime = "nodejs";

export const POST = authedRoute<{ id: string }>(async ({ ctx, params }) => {
  const id = z.string().min(8).max(64).parse(params.id);
  const entry = await ctx.store.restoreEntry(ctx.user.id, id);
  if (!entry) return fail("not_found", "That entry can't be restored.", 404);
  return ok({ entry });
});
