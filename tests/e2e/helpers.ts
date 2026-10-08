import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Page } from "@playwright/test";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CLI = path.join(ROOT, "tests/e2e/extract-cli.ts");
const TSX = path.join(ROOT, "node_modules/.bin/tsx");

function run(args: string[]): string {
  return execFileSync(TSX, [CLI, ...args], { cwd: ROOT, encoding: "utf8", maxBuffer: 5_000_000 });
}

/** The real extraction code and adapters, run over a hand-written fixture. No network. Returns the ExtractResponse JSON. */
export function extractFixture(file: string, url: string): string {
  return run(["fixture", file, url]);
}

/** The real extraction code with a reader that refuses, the way the real one reports a site that blocks bots. */
export function extractBlocked(url: string): string {
  return run(["blocked", url]);
}

/**
 * Replaces /api/extract in the browser with a response produced by the real adapters over a fixture.
 * Everything else (every other API route, the pages, the store) is the real built app.
 */
export async function mockExtract(page: Page, respond: (url: string) => string): Promise<{ calls: string[] }> {
  const calls: string[] = [];
  await page.route("**/api/extract", async (route) => {
    const body = route.request().postDataJSON() as { url?: string };
    calls.push(body.url ?? "");
    await route.fulfill({ status: 200, contentType: "application/json", body: respond(body.url ?? "") });
  });
  return { calls };
}

/** Waits for the page's load animation to finish and for a title, so axe does not measure half-faded colours. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.waitForFunction(() => document.title.trim().length > 0);
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => undefined))));
}
