import { z } from "zod";
import { authedRoute, fail, ok, readJson } from "@/lib/api/route";
import { getEnv } from "@/lib/env";
import { expandNotes, getLlmProvider, meteredProvider } from "@/lib/llm";
import { SOURCE_TYPES, PROFILE_IDS } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 45;

const body = z.object({
  profile: z.enum(PROFILE_IDS as unknown as [string, ...string[]]),
  title: z.string().max(500),
  provider: z.string().max(300).nullable(),
  sourceType: z.enum(SOURCE_TYPES as unknown as [string, ...string[]]),
  theme: z.string().max(200).nullable(),
  notes: z.string().max(5000),
});

/** Turns the person's own 1-2 lines into the profile's text fields. Only title, provider, type, theme and their notes are sent. */
export const POST = authedRoute(async ({ req, ctx }) => {
  const llm = getLlmProvider();
  if (!llm) {
    return fail("ai_off", "AI help isn't switched on for this site. Type your learning points and benefits in yourself.", 501);
  }
  const args = body.parse(await readJson(req, 20_000));
  const metered = meteredProvider(llm, { store: ctx.store, userId: ctx.user.id, cap: getEnv().AI_MONTHLY_CAP });
  const result = await expandNotes(
    {
      profile: args.profile as "ice" | "istructe" | "custom",
      title: args.title,
      provider: args.provider,
      sourceType: args.sourceType as (typeof SOURCE_TYPES)[number],
      theme: args.theme,
      notes: args.notes,
    },
    metered,
  );
  return ok({
    learningPoints: result.learningPoints,
    benefits: result.benefits,
    developmentGained: result.developmentGained,
    warnings: result.warnings,
    aiAssisted: true,
  });
});
