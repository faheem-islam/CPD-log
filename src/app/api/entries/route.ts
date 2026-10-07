import { z } from "zod";
import { authedRoute, BadRequest, fail, ok, readJson } from "@/lib/api/route";
import type { EntryInput } from "@/lib/types";
import { entryWarnings } from "@/lib/warnings";

export const runtime = "nodejs";

const body = z.object({
  entry: z.record(z.string(), z.unknown()),
  /** The person ticked "I've read and checked the AI-assisted text". Required when the entry is AI-assisted. */
  aiReviewed: z.boolean().optional(),
});

export const GET = authedRoute(async ({ ctx }) => {
  const entries = await ctx.store.listEntries(ctx.user.id);
  return ok({ entries });
});

export const POST = authedRoute(async ({ req, ctx }) => {
  const { entry, aiReviewed } = body.parse(await readJson(req, 100_000));
  // Rule: time spent is never saved without the person confirming it.
  if (entry.hoursConfirmed !== true) {
    return fail("bad_request", "Confirm the hours you actually spent before saving.", 400);
  }
  if (entry.aiAssisted === true && aiReviewed !== true) {
    return fail("bad_request", "Tick the box to say you've read and checked the AI-assisted text before saving.", 400);
  }
  if (typeof entry.profile !== "string") throw new BadRequest("Choose which log this belongs in.");
  const created = await ctx.store.createEntry(ctx.user.id, entry as unknown as EntryInput);
  const others = await ctx.store.listEntries(ctx.user.id);
  const warnings = entryWarnings(created, { others: others.filter((o) => o.id !== created.id) });
  return ok({ entry: created, warnings }, { status: 201 });
});
