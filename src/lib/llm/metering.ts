import { todayUk } from "@/lib/dates";
import type { AiUsageResult, Store } from "@/lib/store/types";
import type { LlmProvider, LlmRequest, LlmResponse } from "./types";

/**
 * Monthly cap on AI calls per user.
 *
 * The call is counted BEFORE the model is called, and the count-and-check is one atomic step in the Store
 * (a queued write in the local store, one SQL statement in Postgres), so two requests at the same moment cannot
 * both slip under the cap.
 *
 * No refund: if the model call then fails (a timeout, a bad answer) the call still counts. The Store has no way to
 * give a call back, and a failed request can still have been billed by the provider, so counting every attempt is
 * the simplest behaviour that is honest about cost. The cap is a cost guard, not a promise of a number of successes.
 *
 * If the Store itself fails, the error is passed on and the model is NOT called.
 *
 * Two ways to use it. withAiMeter wraps one whole feature, so it counts even when that feature ends without calling the
 * model (blank notes, a screenshot that fails its checks). meteredProvider wraps the provider instead and counts only
 * real model calls, so nothing else costs an allowance and a route that builds its provider with it cannot forget to meter.
 */

const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export class AiCapError extends Error {
  /** The monthly allowance. */
  readonly cap: number;
  readonly used: number;
  /** The day the allowance resets, as "1 November". */
  readonly resetsOn: string;

  constructor(message: string, cap: number, used: number, resetsOn: string) {
    super(message);
    this.name = "AiCapError";
    this.cap = cap;
    this.used = used;
    this.resetsOn = resetsOn;
  }
}

export interface AiMeterArgs {
  /** Only incrementAiUsage is used, so a full Store or a small stand-in both work. */
  store: Pick<Store, "incrementAiUsage">;
  userId: string;
  /** Calls allowed per month. 0 (or less) means the AI features are switched off. */
  cap: number;
  /** The moment to meter at. A Date, or a function returning one. Defaults to now. */
  now?: Date | (() => Date);
}

/** The UK calendar month, "YYYY-MM". */
export function monthKeyUk(now: Date): string {
  return todayUk(now).slice(0, 7);
}

/** "1 November" for the month after the UK month of `now`. */
export function nextResetLabel(now: Date): string {
  const thisMonth = Number(monthKeyUk(now).slice(5, 7)); // 1 to 12
  return `1 ${MONTH_NAMES[thisMonth % 12] ?? "next month"}`; // index thisMonth is the month after it
}

/**
 * Count one AI call for this user, then run `fn`. Throws AiCapError (without running `fn`) when the monthly
 * allowance is used up.
 */
export async function withAiMeter<T>(args: AiMeterArgs, fn: (usage: AiUsageResult) => Promise<T>): Promise<T> {
  const at = typeof args.now === "function" ? args.now() : (args.now ?? new Date());
  const resetsOn = nextResetLabel(at);

  if (!Number.isFinite(args.cap) || args.cap <= 0) {
    throw new AiCapError(
      "AI help is switched off on this server because the monthly allowance is set to 0. You can still type your learning points yourself.",
      0,
      0,
      resetsOn,
    );
  }

  const usage = await args.store.incrementAiUsage(args.userId, monthKeyUk(at), args.cap);
  if (!usage.allowed) {
    throw new AiCapError(
      `You've used this month's AI allowance (${usage.cap} ${usage.cap === 1 ? "call" : "calls"}). It resets on ${resetsOn}. You can still type your learning points yourself.`,
      usage.cap,
      usage.used,
      resetsOn,
    );
  }
  return fn(usage);
}

/**
 * A provider that counts one call (and checks the allowance) just before each real model call, and never otherwise.
 * Use it instead of wrapping a whole feature in withAiMeter: blank notes, a screenshot that fails its checks, and any
 * other path that returns without calling the model then cost nothing, and a route that builds its provider this way
 * cannot forget to meter.
 */
export function meteredProvider(llm: LlmProvider, args: AiMeterArgs): LlmProvider {
  return {
    name: llm.name,
    complete(req: LlmRequest): Promise<LlmResponse> {
      return withAiMeter(args, () => llm.complete(req));
    },
  };
}
