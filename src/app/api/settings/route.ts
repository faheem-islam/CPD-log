import { authedRoute, ok, readJson } from "@/lib/api/route";

export const runtime = "nodejs";

export const GET = authedRoute(async ({ ctx }) => ok({ settings: await ctx.store.getSettings(ctx.user.id) }));

/** The store validates every field and refuses anything unexpected. */
export const PUT = authedRoute(async ({ req, ctx }) => {
  const settings = await ctx.store.saveSettings(ctx.user.id, (await readJson(req, 50_000)) as never);
  return ok({ settings });
});
