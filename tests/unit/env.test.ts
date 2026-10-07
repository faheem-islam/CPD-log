import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EnvError, features, getEnv, parseEnv, resetEnvCache, storeMode } from "@/lib/env";

const URL_OK = "https://abc.supabase.co";
const SUPABASE = { NEXT_PUBLIC_SUPABASE_URL: URL_OK, NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value" };

function failure(source: Record<string, string | undefined>): EnvError {
  try {
    parseEnv(source);
  } catch (e) {
    expect(e).toBeInstanceOf(EnvError);
    expect((e as EnvError).name).toBe("EnvError");
    return e as EnvError;
  }
  throw new Error("Expected parseEnv to throw");
}

describe("blank strings count as unset", () => {
  it("an empty environment is valid and uses the defaults", () => {
    const env = parseEnv({});
    expect(env).toEqual({
      NODE_ENV: "development",
      LLM_MODEL: "claude-haiku-4-5-20251001",
      AI_MONTHLY_CAP: 100,
      EXTRACT_RATE_LIMIT_PER_HOUR: 30,
      CPD_BOT_CONTACT: "contact-not-set",
      CPD_LOCAL_MODE: false,
    });
    for (const key of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY", "ANTHROPIC_API_KEY", "YOUTUBE_API_KEY", "SENTRY_DSN", "CPD_LOCAL_DB"] as const) {
      expect(env[key]).toBeUndefined();
    }
  });

  it.each(["", " ", "   ", "\t", "\n", " \t\n "])("treats %j as unset for every variable", (blank) => {
    const names = [
      "NODE_ENV",
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_ANON_KEY",
      "SUPABASE_SERVICE_ROLE_KEY",
      "ANTHROPIC_API_KEY",
      "LLM_MODEL",
      "AI_MONTHLY_CAP",
      "YOUTUBE_API_KEY",
      "SENTRY_DSN",
      "CPD_BOT_CONTACT",
      "EXTRACT_RATE_LIMIT_PER_HOUR",
      "CPD_LOCAL_MODE",
      "CPD_LOCAL_DB",
    ];
    const source = Object.fromEntries(names.map((n) => [n, blank]));
    expect(parseEnv(source)).toEqual(parseEnv({}));
  });

  it("a blank key switches the feature off", () => {
    expect(features(parseEnv({ ANTHROPIC_API_KEY: "   ", YOUTUBE_API_KEY: "", SENTRY_DSN: " " }))).toMatchObject({ ai: false, youtubeApi: false, sentry: false });
    expect(features(parseEnv({ ANTHROPIC_API_KEY: "k", YOUTUBE_API_KEY: "k", SENTRY_DSN: "https://x@y.ingest.sentry.io/1" }))).toMatchObject({ ai: true, youtubeApi: true, sentry: true });
  });

  it("trims values that are set", () => {
    const env = parseEnv({ ANTHROPIC_API_KEY: "  key-1  ", LLM_MODEL: " my-model ", CPD_BOT_CONTACT: " me@example.test ", CPD_LOCAL_DB: " ./x.json " });
    expect(env.ANTHROPIC_API_KEY).toBe("key-1");
    expect(env.LLM_MODEL).toBe("my-model");
    expect(env.CPD_BOT_CONTACT).toBe("me@example.test");
    expect(env.CPD_LOCAL_DB).toBe("./x.json");
  });

  it("ignores variables it does not know about", () => {
    expect(() => parseEnv({ PATH: "/usr/bin", HOME: "/root", SOMETHING_ELSE: "x" })).not.toThrow();
  });
});

describe("the Supabase URL and anon key must come as a pair", () => {
  it("both set gives Supabase mode", () => {
    const env = parseEnv(SUPABASE);
    expect(storeMode(env)).toBe("supabase");
    expect(features(env).mode).toBe("supabase");
  });

  it("both blank gives local mode", () => {
    expect(storeMode(parseEnv({}))).toBe("local");
    expect(storeMode(parseEnv({ NEXT_PUBLIC_SUPABASE_URL: " ", NEXT_PUBLIC_SUPABASE_ANON_KEY: "" }))).toBe("local");
  });

  it("only the URL is an error that names both variables and says what to do", () => {
    const err = failure({ NEXT_PUBLIC_SUPABASE_URL: URL_OK });
    expect(err.message).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(err.message).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    expect(err.message).toMatch(/set both/);
    expect(err.message).toMatch(/leave both blank for local demo mode/);
  });

  it("only the anon key is the same error", () => {
    expect(failure({ NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value" }).message).toMatch(/set both/);
  });

  it("a blank half counts as missing", () => {
    expect(failure({ NEXT_PUBLIC_SUPABASE_URL: URL_OK, NEXT_PUBLIC_SUPABASE_ANON_KEY: "   " }).message).toMatch(/set both/);
    expect(failure({ NEXT_PUBLIC_SUPABASE_URL: "  ", NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-key-value" }).message).toMatch(/set both/);
  });

  it("the service-role key on its own does not switch Supabase mode on", () => {
    expect(storeMode(parseEnv({ SUPABASE_SERVICE_ROLE_KEY: "service-key" }))).toBe("local");
  });

  it("a URL that is not a URL is an error that says what a URL looks like", () => {
    const err = failure({ NEXT_PUBLIC_SUPABASE_URL: "not a url", NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" });
    expect(err.message).toMatch(/NEXT_PUBLIC_SUPABASE_URL: must be a full URL such as https:\/\/abc\.supabase\.co/);
  });

  it("a URL pasted with spaces around it is cleaned up", () => {
    expect(parseEnv({ NEXT_PUBLIC_SUPABASE_URL: `  ${URL_OK}\n`, NEXT_PUBLIC_SUPABASE_ANON_KEY: "k" }).NEXT_PUBLIC_SUPABASE_URL).toBe(URL_OK);
  });
});

describe("production without Supabase", () => {
  const MESSAGE = /cannot start in production without Supabase/;

  it("fails with the clear message", () => {
    const err = failure({ NODE_ENV: "production" });
    expect(err.message).toMatch(MESSAGE);
    expect(err.message).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(err.message).toMatch(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    expect(err.message).toMatch(/CPD_LOCAL_MODE=true/);
    expect(err.message).toMatch(/Going live/);
  });

  it("fails when the Supabase variables are blank", () => {
    expect(failure({ NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: " ", NEXT_PUBLIC_SUPABASE_ANON_KEY: "" }).message).toMatch(MESSAGE);
  });

  it.each(["true", "1"])("is allowed when CPD_LOCAL_MODE is %s", (v) => {
    const env = parseEnv({ NODE_ENV: "production", CPD_LOCAL_MODE: v });
    expect(env.CPD_LOCAL_MODE).toBe(true);
    expect(storeMode(env)).toBe("local");
  });

  it.each(["false", "0", "", "  "])("is still refused when CPD_LOCAL_MODE is %j", (v) => {
    expect(failure({ NODE_ENV: "production", CPD_LOCAL_MODE: v }).message).toMatch(MESSAGE);
  });

  it("is fine with Supabase", () => {
    expect(storeMode(parseEnv({ NODE_ENV: "production", ...SUPABASE }))).toBe("supabase");
  });

  it("stays in Supabase mode when CPD_LOCAL_MODE is also set", () => {
    expect(storeMode(parseEnv({ NODE_ENV: "production", CPD_LOCAL_MODE: "true", ...SUPABASE }))).toBe("supabase");
  });

  it("a half-set Supabase pair is reported as the pair problem, not as the production problem", () => {
    expect(failure({ NODE_ENV: "production", NEXT_PUBLIC_SUPABASE_URL: URL_OK }).message).toMatch(/set both/);
  });

  it.each(["development", "test"])("local mode needs no flag in %s", (nodeEnv) => {
    expect(storeMode(parseEnv({ NODE_ENV: nodeEnv }))).toBe("local");
  });

  it("rejects an unknown NODE_ENV", () => {
    expect(failure({ NODE_ENV: "staging" }).message).toMatch(/NODE_ENV/);
  });
});

describe("LLM_MODEL", () => {
  it("defaults to the Haiku model", () => {
    expect(parseEnv({}).LLM_MODEL).toBe("claude-haiku-4-5-20251001");
    expect(features(parseEnv({})).model).toBe("claude-haiku-4-5-20251001");
  });

  it("blank means the default", () => {
    expect(parseEnv({ LLM_MODEL: "" }).LLM_MODEL).toBe("claude-haiku-4-5-20251001");
    expect(parseEnv({ LLM_MODEL: "   " }).LLM_MODEL).toBe("claude-haiku-4-5-20251001");
  });

  it("can be changed", () => {
    expect(parseEnv({ LLM_MODEL: "some-other-model" }).LLM_MODEL).toBe("some-other-model");
    expect(features(parseEnv({ LLM_MODEL: "some-other-model" })).model).toBe("some-other-model");
  });
});

describe("AI_MONTHLY_CAP", () => {
  it("defaults to 100", () => {
    expect(parseEnv({}).AI_MONTHLY_CAP).toBe(100);
    expect(parseEnv({ AI_MONTHLY_CAP: "" }).AI_MONTHLY_CAP).toBe(100);
    expect(features(parseEnv({})).aiMonthlyCap).toBe(100);
  });

  it.each([
    ["25", 25],
    [" 25 ", 25],
    ["0", 0],
    ["1", 1],
    ["100000", 100000],
  ])("reads %j as %i", (value, expected) => {
    expect(parseEnv({ AI_MONTHLY_CAP: value }).AI_MONTHLY_CAP).toBe(expected);
  });

  it("zero is allowed and means the AI features are capped at nothing", () => {
    expect(features(parseEnv({ AI_MONTHLY_CAP: "0", ANTHROPIC_API_KEY: "k" })).aiMonthlyCap).toBe(0);
  });

  it.each([
    ["abc", /AI_MONTHLY_CAP/],
    ["ten", /AI_MONTHLY_CAP/],
    ["12abc", /AI_MONTHLY_CAP/],
    ["-1", /AI_MONTHLY_CAP: must be 0 or more/],
    ["-0.5", /AI_MONTHLY_CAP/],
    ["1.5", /AI_MONTHLY_CAP: must be a whole number/],
    ["Infinity", /AI_MONTHLY_CAP/],
    ["NaN", /AI_MONTHLY_CAP/],
  ])("rejects %j", (value, message) => {
    expect(failure({ AI_MONTHLY_CAP: value }).message).toMatch(message);
  });

  it("tells the person where to fix it", () => {
    expect(failure({ AI_MONTHLY_CAP: "abc" }).message).toMatch(/Fix them in \.env\.local \(see \.env\.example\)/);
  });

  it("lists every problem at once", () => {
    const err = failure({ AI_MONTHLY_CAP: "abc", EXTRACT_RATE_LIMIT_PER_HOUR: "-3", NEXT_PUBLIC_SUPABASE_URL: "nope" });
    expect(err.message).toMatch(/AI_MONTHLY_CAP/);
    expect(err.message).toMatch(/EXTRACT_RATE_LIMIT_PER_HOUR/);
    expect(err.message).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
  });
});

describe("other numbers and flags", () => {
  it("EXTRACT_RATE_LIMIT_PER_HOUR defaults to 30 and checks its value", () => {
    expect(parseEnv({}).EXTRACT_RATE_LIMIT_PER_HOUR).toBe(30);
    expect(parseEnv({ EXTRACT_RATE_LIMIT_PER_HOUR: "5" }).EXTRACT_RATE_LIMIT_PER_HOUR).toBe(5);
    expect(failure({ EXTRACT_RATE_LIMIT_PER_HOUR: "lots" }).message).toMatch(/EXTRACT_RATE_LIMIT_PER_HOUR/);
  });

  it("CPD_LOCAL_MODE accepts true, false, 1 and 0 and nothing else", () => {
    expect(parseEnv({ CPD_LOCAL_MODE: "true" }).CPD_LOCAL_MODE).toBe(true);
    expect(parseEnv({ CPD_LOCAL_MODE: "1" }).CPD_LOCAL_MODE).toBe(true);
    expect(parseEnv({ CPD_LOCAL_MODE: "false" }).CPD_LOCAL_MODE).toBe(false);
    expect(parseEnv({ CPD_LOCAL_MODE: "0" }).CPD_LOCAL_MODE).toBe(false);
    for (const bad of ["yes", "on", "TRUE", "2"]) {
      expect(failure({ CPD_LOCAL_MODE: bad }).message).toMatch(/CPD_LOCAL_MODE: must be "true" or "false"/);
    }
  });
});

describe("error messages never include secret values", () => {
  const SECRETS = {
    ANTHROPIC_API_KEY: "sk-ant-api03-SECRETANTHROPIC1234567890",
    SUPABASE_SERVICE_ROLE_KEY: "eyJSECRETSERVICEROLE.payload.signature",
    YOUTUBE_API_KEY: "AIzaSyYOUTUBESECRET1234567890abcdef",
    SENTRY_DSN: "https://SECRETSENTRY@o1.ingest.sentry.io/1",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-SECRETANON-key",
  };
  const everything = Object.values(SECRETS);

  function expectClean(message: string, extra: string[] = []): void {
    for (const s of [...everything, ...extra]) expect(message).not.toContain(s);
    for (const s of ["SECRETANTHROPIC", "SECRETSERVICEROLE", "YOUTUBESECRET", "SECRETSENTRY", "SECRETANON"]) expect(message).not.toContain(s);
  }

  it("an invalid number", () => {
    const err = failure({ ...SECRETS, AI_MONTHLY_CAP: "SECRETCAP" });
    expect(err.message).toMatch(/AI_MONTHLY_CAP/);
    expectClean(err.message, ["SECRETCAP"]);
  });

  it("an invalid URL", () => {
    const err = failure({ ...SECRETS, NEXT_PUBLIC_SUPABASE_URL: "SECRETURL not a url" });
    expect(err.message).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    expectClean(err.message, ["SECRETURL"]);
  });

  it("an invalid NODE_ENV and an invalid flag", () => {
    const err = failure({ ...SECRETS, NODE_ENV: "SECRETENV", CPD_LOCAL_MODE: "SECRETMODE" });
    expectClean(err.message, ["SECRETENV", "SECRETMODE"]);
  });

  it("an incomplete Supabase pair", () => {
    const err = failure({ ...SECRETS, NEXT_PUBLIC_SUPABASE_URL: URL_OK, NEXT_PUBLIC_SUPABASE_ANON_KEY: "" });
    expect(err.message).toMatch(/set both/);
    expectClean(err.message, [URL_OK]);
    const err2 = failure({ ...SECRETS, NEXT_PUBLIC_SUPABASE_URL: "" });
    expectClean(err2.message);
  });

  it("production without Supabase", () => {
    const { NEXT_PUBLIC_SUPABASE_ANON_KEY: _omit, ...rest } = SECRETS;
    const err = failure({ ...rest, NODE_ENV: "production" });
    expect(err.message).toMatch(/cannot start in production/);
    expectClean(err.message);
  });

  it("the whole error object, not just the message", () => {
    const err = failure({ ...SECRETS, AI_MONTHLY_CAP: "SECRETCAP" });
    const all = [err.message, err.stack ?? "", JSON.stringify(err), String(err)].join("\n");
    expectClean(all, ["SECRETCAP"]);
  });

  it("features() holds no secrets", () => {
    const env = parseEnv({ ...SECRETS, ...SUPABASE, SUPABASE_SERVICE_ROLE_KEY: SECRETS.SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_SUPABASE_ANON_KEY: SECRETS.NEXT_PUBLIC_SUPABASE_ANON_KEY });
    const flags = features(env);
    expectClean(JSON.stringify(flags));
    expect(flags).toEqual({ ai: true, youtubeApi: true, sentry: true, mode: "supabase", model: "claude-haiku-4-5-20251001", aiMonthlyCap: 100 });
  });
});

describe("getEnv reads process.env once", () => {
  const KEYS = ["NODE_ENV", "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "ANTHROPIC_API_KEY", "LLM_MODEL", "AI_MONTHLY_CAP", "CPD_LOCAL_MODE", "CPD_LOCAL_DB"] as const;
  const saved: Record<string, string | undefined> = {};
  const env = process.env as Record<string, string | undefined>;

  beforeEach(() => {
    for (const k of KEYS) {
      saved[k] = env[k];
      delete env[k];
    }
    resetEnvCache();
  });

  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete env[k];
      else env[k] = saved[k];
    }
    resetEnvCache();
  });

  it("reads the current process environment", () => {
    env.LLM_MODEL = "from-process-env";
    env.AI_MONTHLY_CAP = "7";
    const e = getEnv();
    expect(e.LLM_MODEL).toBe("from-process-env");
    expect(e.AI_MONTHLY_CAP).toBe(7);
  });

  it("caches the result until it is reset", () => {
    env.LLM_MODEL = "first";
    expect(getEnv().LLM_MODEL).toBe("first");
    env.LLM_MODEL = "second";
    expect(getEnv().LLM_MODEL).toBe("first");
    resetEnvCache();
    expect(getEnv().LLM_MODEL).toBe("second");
  });

  it("throws the same friendly error from the process environment, and does not cache a failure", () => {
    env.AI_MONTHLY_CAP = "abc";
    expect(() => getEnv()).toThrow(EnvError);
    delete env.AI_MONTHLY_CAP;
    expect(getEnv().AI_MONTHLY_CAP).toBe(100);
  });

  it("uses the defaults with nothing set", () => {
    const e = getEnv();
    expect(e.LLM_MODEL).toBe("claude-haiku-4-5-20251001");
    expect(storeMode()).toBe("local");
    expect(features().ai).toBe(false);
  });
});

describe("upper bounds", () => {
  it("rejects an absurd AI_MONTHLY_CAP", async () => {
    const { parseEnv } = await import("@/lib/env");
    expect(() => parseEnv({ NODE_ENV: "development", AI_MONTHLY_CAP: "99999999999" })).toThrow(/AI_MONTHLY_CAP/);
    expect(parseEnv({ NODE_ENV: "development", AI_MONTHLY_CAP: "250" }).AI_MONTHLY_CAP).toBe(250);
  });
});
