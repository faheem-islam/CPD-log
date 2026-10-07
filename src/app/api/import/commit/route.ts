import { z } from "zod";
import { authedRoute, ok, readJson } from "@/lib/api/route";
import { profileSchema } from "@/lib/api/profile-param";
import { commitRows, IMPORT_LIMITS, type ImportRow } from "@/lib/import";

export const runtime = "nodejs";

const body = z.object({ profile: profileSchema, rows: z.array(z.record(z.string(), z.unknown())).max(IMPORT_LIMITS.maxRows) });

/** Saves the ticked rows of one profile. A row that still has an error blocks the whole commit. */
export const POST = authedRoute(async ({ req, ctx }) => {
  const { profile, rows } = body.parse(await readJson(req, 6_000_000));
  const existing = (await ctx.store.listEntries(ctx.user.id)).map((e) => ({ dateCompleted: e.dateCompleted, title: e.title }));
  const settings = await ctx.store.getSettings(ctx.user.id);
  const inputs = commitRows(rows as unknown as ImportRow[], { profile, settings, existing, now: new Date() });
  // The review screen is where the person confirmed each row, including its hours.
  const created = await ctx.store.createEntries(
    ctx.user.id,
    inputs.map((i) => ({ ...i, profile, hoursConfirmed: true })),
  );
  return ok({ created: created.length }, { status: 201 });
});
