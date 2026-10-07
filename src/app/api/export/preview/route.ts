import { z } from "zod";
import { authedRoute, ok, readJson } from "@/lib/api/route";
import { profileSchema } from "@/lib/api/profile-param";
import { previewExport } from "@/lib/export";

export const runtime = "nodejs";

const body = z.object({
  profiles: z.array(profileSchema).min(1, "Choose at least one log to export."),
  year: z.union([z.literal("all"), z.coerce.number().int().min(1990).max(2200)]),
});

/** What the file will contain, using the same row builder as the download. */
export const POST = authedRoute(async ({ req, ctx }) => {
  const { profiles, year } = body.parse(await readJson(req, 5_000));
  const [entries, settings] = await Promise.all([ctx.store.listEntries(ctx.user.id), ctx.store.getSettings(ctx.user.id)]);
  return ok({ previews: previewExport({ entries, settings, profiles, year, userId: ctx.user.id }) });
});
