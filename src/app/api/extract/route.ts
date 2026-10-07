import { z } from "zod";
import { authedRoute, fail, ok, readJson } from "@/lib/api/route";
import { getEnv } from "@/lib/env";
import { extractFromUrl } from "@/lib/extract";
import { getApiFetcher, getPageReader } from "@/lib/net";
import { createRateLimiter } from "@/lib/security/rate-limit";

export const runtime = "nodejs";
export const maxDuration = 30;

const body = z.object({ url: z.string().max(2048) });

// Per server instance. On serverless hosting each instance counts on its own, so this is a cost guard, not a hard limit.
let limiter: ReturnType<typeof createRateLimiter> | undefined;

export const POST = authedRoute(async ({ req, ctx }) => {
  const env = getEnv();
  limiter ??= createRateLimiter({ limit: env.EXTRACT_RATE_LIMIT_PER_HOUR, windowMs: 60 * 60 * 1000 });
  const verdict = limiter.check(ctx.user.id);
  if (!verdict.allowed) {
    return fail(
      "rate_limited",
      `You've read a lot of links in the last hour. Try again in about ${Math.ceil(verdict.retryAfterSeconds / 60)} minute(s), or type the details in yourself.`,
      429,
      { retryAfterSeconds: verdict.retryAfterSeconds },
    );
  }
  const { url } = body.parse(await readJson(req, 5_000));
  const result = await extractFromUrl(url, {
    reader: getPageReader(),
    api: getApiFetcher(),
    youtubeApiKey: env.YOUTUBE_API_KEY,
  });
  return ok(result);
});
