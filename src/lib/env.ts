import { z } from "zod";

/** Blank strings count as unset. */
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optString = z.preprocess(blankToUndefined, z.string().trim().optional());
const optUrl = z.preprocess(blankToUndefined, z.string().url("must be a full URL such as https://abc.supabase.co").optional());
const optInt = (def: number) =>
  z.preprocess(blankToUndefined, z.coerce.number().int("must be a whole number").min(0, "must be 0 or more").default(def));
const optBool = z.preprocess(
  blankToUndefined,
  z
    .enum(["true", "false", "1", "0"], { message: 'must be "true" or "false"' })
    .optional()
    .transform((v) => v === "true" || v === "1"),
);

const schema = z.object({
  NODE_ENV: z.preprocess(blankToUndefined, z.enum(["development", "production", "test"]).default("development")),
  NEXT_PUBLIC_SUPABASE_URL: optUrl,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: optString,
  SUPABASE_SERVICE_ROLE_KEY: optString,
  ANTHROPIC_API_KEY: optString,
  LLM_MODEL: z.preprocess(blankToUndefined, z.string().trim().default("claude-haiku-4-5-20251001")),
  AI_MONTHLY_CAP: optInt(100),
  YOUTUBE_API_KEY: optString,
  SENTRY_DSN: optString,
  CPD_BOT_CONTACT: z.preprocess(blankToUndefined, z.string().trim().default("contact-not-set")),
  EXTRACT_RATE_LIMIT_PER_HOUR: optInt(30),
  CPD_LOCAL_MODE: optBool,
  CPD_LOCAL_DB: optString,
});

export type Env = z.infer<typeof schema>;
export type StoreMode = "supabase" | "local";

export class EnvError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EnvError";
  }
}

/** Parse an env-like object. Pure, so it can be tested. Messages never include values. */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const result = schema.safeParse(source);
  if (!result.success) {
    const lines = result.error.issues.map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`);
    throw new EnvError(
      `CPD Logger cannot start because some environment variables are invalid:\n${lines.join("\n")}\n` +
        "Fix them in .env.local (see .env.example) or in your host's environment settings.",
    );
  }
  const env = result.data;
  const hasUrl = Boolean(env.NEXT_PUBLIC_SUPABASE_URL);
  const hasAnon = Boolean(env.NEXT_PUBLIC_SUPABASE_ANON_KEY);
  if (hasUrl !== hasAnon) {
    throw new EnvError(
      "CPD Logger cannot start: set both NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY, or leave both blank for local demo mode.",
    );
  }
  if (!hasUrl && env.NODE_ENV === "production" && !env.CPD_LOCAL_MODE) {
    throw new EnvError(
      "CPD Logger cannot start in production without Supabase. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY " +
        "(see the README, 'Going live'). Local demo mode is only allowed in production if CPD_LOCAL_MODE=true.",
    );
  }
  return env;
}

let cached: Env | undefined;

/** Validated environment, read once per server process. */
export function getEnv(): Env {
  cached ??= parseEnv(process.env as Record<string, string | undefined>);
  return cached;
}

/** For tests only. */
export function resetEnvCache(): void {
  cached = undefined;
}

export function storeMode(env: Env = getEnv()): StoreMode {
  return env.NEXT_PUBLIC_SUPABASE_URL ? "supabase" : "local";
}

export interface FeatureFlags {
  ai: boolean;
  youtubeApi: boolean;
  sentry: boolean;
  mode: StoreMode;
  model: string;
  aiMonthlyCap: number;
}

/** What is switched on. Contains no secrets. Safe to show on the Settings page. */
export function features(env: Env = getEnv()): FeatureFlags {
  return {
    ai: Boolean(env.ANTHROPIC_API_KEY),
    youtubeApi: Boolean(env.YOUTUBE_API_KEY),
    sentry: Boolean(env.SENTRY_DSN),
    mode: storeMode(env),
    model: env.LLM_MODEL,
    aiMonthlyCap: env.AI_MONTHLY_CAP,
  };
}
