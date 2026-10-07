import { z } from "zod";
import { authedRoute, BadRequest, readJson } from "@/lib/api/route";
import { profileSchema } from "@/lib/api/profile-param";
import { buildWorkbook, exportFilename } from "@/lib/export";
import type { ProfileId } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 30;

const yearSchema = z.union([z.literal("all"), z.coerce.number().int().min(1990).max(2200)]);
const body = z.object({ profiles: z.array(profileSchema).min(1, "Choose at least one log to export."), year: yearSchema });

/** Accepts JSON, or a plain HTML form post so the browser can download the file directly. */
async function readExportRequest(req: Request): Promise<z.infer<typeof body>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const form = await req.formData();
    return body.parse({ profiles: form.getAll("profiles"), year: form.get("year") ?? "all" });
  }
  return body.parse(await readJson(req, 5_000));
}

export const POST = authedRoute(async ({ req, ctx }) => {
  const { profiles, year } = await readExportRequest(req);
  const [entries, settings] = await Promise.all([ctx.store.listEntries(ctx.user.id), ctx.store.getSettings(ctx.user.id)]);
  if (!Array.isArray(profiles)) throw new BadRequest("Choose at least one log to export.");
  const now = new Date();
  const file = await buildWorkbook({ entries, settings, profiles: profiles as ProfileId[], year, now, userId: ctx.user.id });
  return new Response(new Uint8Array(file), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${exportFilename(year, now)}"`,
      "Cache-Control": "no-store",
    },
  });
});
