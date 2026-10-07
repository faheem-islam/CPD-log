import { z } from "zod";
import { authedRoute, fail, ok, readJson } from "@/lib/api/route";
import type { EntryInput } from "@/lib/types";
import { entryWarnings } from "@/lib/warnings";

export const runtime = "nodejs";

const idSchema = z.string().min(8).max(64);
const body = z.object({
  patch: z.record(z.string(), z.unknown()),
  aiReviewed: z.boolean().optional(),
});

export const PATCH = authedRoute<{ id: string }>(async ({ req, ctx, params }) => {
  const id = idSchema.parse(params.id);
  const { patch, aiReviewed } = body.parse(await readJson(req, 100_000));
  if (patch.aiAssisted === true && aiReviewed !== true) {
    return fail("bad_request", "Tick the box to say you've read and checked the AI-assisted text before saving.", 400);
  }
  // Editing the hours is the person confirming them.
  const next = "hours" in patch ? { ...patch, hoursConfirmed: true } : patch;
  const updated = await ctx.store.updateEntry(ctx.user.id, id, next as Partial<EntryInput>);
  if (!updated) return fail("not_found", "That entry isn't in your log any more.", 404);
  const others = await ctx.store.listEntries(ctx.user.id);
  return ok({ entry: updated, warnings: entryWarnings(updated, { others: others.filter((o) => o.id !== updated.id) }) });
});

/** Soft delete: the entry can be restored with Undo. */
export const DELETE = authedRoute<{ id: string }>(async ({ ctx, params }) => {
  const id = idSchema.parse(params.id);
  const entry = await ctx.store.softDeleteEntry(ctx.user.id, id);
  if (!entry) return fail("not_found", "That entry isn't in your log any more.", 404);
  return ok({ entry });
});
