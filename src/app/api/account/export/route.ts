import { authedRoute } from "@/lib/api/route";
import { allDataFilename, buildAllData } from "@/lib/export";

export const runtime = "nodejs";

/** "Download all my data": everything held for this person, including entries in the bin. */
export const GET = authedRoute(async ({ ctx }) => {
  const [settings, entries] = await Promise.all([
    ctx.store.getSettings(ctx.user.id),
    ctx.store.listEntries(ctx.user.id, { includeDeleted: true }),
  ]);
  const now = new Date();
  const data = buildAllData({ settings, entries, now, userId: ctx.user.id });
  return new Response(JSON.stringify(data, null, 2), {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${allDataFilename(now)}"`,
      "Cache-Control": "no-store",
    },
  });
});
