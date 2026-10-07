import { authedRoute, BadRequest, fail, ok } from "@/lib/api/route";
import { profileSchema } from "@/lib/api/profile-param";
import { IMPORT_LIMITS, parseSpreadsheet, parseTranscribedText, type ImportContext } from "@/lib/import";
import { getLlmProvider, meteredProvider, transcribeScreenshot } from "@/lib/llm";
import type { LlmImageMediaType } from "@/lib/llm";
import { getEnv } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 60;

const IMAGE_EXT: Record<string, LlmImageMediaType> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** Reads an Excel/CSV file, or (with the AI key) a screenshot, into rows for the person to review. Nothing is saved here. */
export const POST = authedRoute(async ({ req, ctx }) => {
  const declared = Number(req.headers.get("content-length") ?? 0);
  if (declared > IMPORT_LIMITS.maxBytes + 200_000) {
    return fail("import_error", "That file is larger than 5 MB. Remove unused rows or sheets and try again.", 413);
  }
  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new BadRequest("Choose a file to import.");
  const profile = profileSchema.parse(form.get("profile"));
  if (file.size > IMPORT_LIMITS.maxBytes) {
    return fail("import_error", "That file is larger than 5 MB. Remove unused rows or sheets and try again.", 413);
  }

  const existing = (await ctx.store.listEntries(ctx.user.id)).map((e) => ({ dateCompleted: e.dateCompleted, title: e.title }));
  const settings = await ctx.store.getSettings(ctx.user.id);
  const importCtx: ImportContext = { profile, settings, existing, now: new Date() };

  const ext = file.name.toLowerCase().split(".").pop() ?? "";
  const imageType = IMAGE_EXT[ext] ?? (Object.values(IMAGE_EXT).includes(file.type as LlmImageMediaType) ? (file.type as LlmImageMediaType) : null);

  if (imageType) {
    const llm = getLlmProvider();
    if (!llm) {
      return fail(
        "ai_off",
        "Screenshots need the AI feature, which isn't switched on for this site. Export your record to Excel or CSV and import that instead.",
        501,
      );
    }
    const base64 = Buffer.from(await file.arrayBuffer()).toString("base64");
    const metered = meteredProvider(llm, { store: ctx.store, userId: ctx.user.id, cap: getEnv().AI_MONTHLY_CAP });
    // The model only transcribes. Our own code turns the text into rows, and every row is flagged for checking.
    const { text } = await transcribeScreenshot(metered, { mediaType: imageType, base64 });
    return ok(parseTranscribedText(text, { ...importCtx, fromScreenshot: true }));
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  return ok(await parseSpreadsheet(buffer, file.name, importCtx));
});
