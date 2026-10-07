import { z } from "zod";
import { authedRoute, BadRequest, ok, readJson } from "@/lib/api/route";
import { profileSchema } from "@/lib/api/profile-param";
import { IMPORT_LIMITS, revalidateRows, type ImportRow } from "@/lib/import";
import { looksLikeEntryInput } from "@/lib/import/revalidate";

export const runtime = "nodejs";

const body = z.object({ profile: profileSchema, rows: z.array(z.record(z.string(), z.unknown())).max(IMPORT_LIMITS.maxRows) });

/** Re-checks rows after the person edits them on the review screen. */
export const POST = authedRoute(async ({ req, ctx }) => {
  const { profile, rows } = body.parse(await readJson(req, 6_000_000));
  for (const r of rows) {
    if (!looksLikeEntryInput(r.input)) throw new BadRequest("One of the rows is missing details. Re-read the file and try again.");
  }
  const existing = (await ctx.store.listEntries(ctx.user.id)).map((e) => ({ dateCompleted: e.dateCompleted, title: e.title }));
  const settings = await ctx.store.getSettings(ctx.user.id);
  const fromScreenshot = rows.some((r) => r.fromScreenshot === true);
  const checked = revalidateRows(rows as unknown as ImportRow[], { profile, settings, existing, now: new Date(), fromScreenshot });
  return ok({ rows: checked });
});
