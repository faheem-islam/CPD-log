/**
 * Runs the real reader and adapters, live, over eval/urls.csv and writes eval/report.md.
 *   npm run eval
 * It reads sites politely (robots.txt, identifiable User-Agent, one request at a time, a pause between URLs)
 * and never tries to get around a block. Set YOUTUBE_API_KEY in .env.local to include the YouTube Data API.
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getEnv } from "../src/lib/env";
import { extractFromUrl } from "../src/lib/extract";
import { getApiFetcher, getPageReader } from "../src/lib/net";
import { parseEvalCsv, renderReport, scoreUrl, type UrlScore } from "../src/lib/eval/score";

try {
  process.loadEnvFile(path.resolve(".env.local"));
} catch {
  // No .env.local is fine: the evaluation then runs with no optional keys.
}

const PAUSE_MS = 2000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const csvPath = path.resolve("eval/urls.csv");
  const rows = parseEvalCsv(readFileSync(csvPath, "utf8"));
  if (rows.length === 0) {
    console.log("eval/urls.csv has no URLs. Add some and run again.");
    return;
  }
  const env = getEnv();
  const reader = getPageReader();
  const api = getApiFetcher();
  console.log(`Evaluating ${rows.length} URL(s). YouTube API key: ${env.YOUTUBE_API_KEY ? "set" : "not set (oEmbed only)"}.`);

  const scores: UrlScore[] = [];
  for (const [i, row] of rows.entries()) {
    process.stdout.write(`[${i + 1}/${rows.length}] ${row.url} ... `);
    try {
      // A fresh cache per URL so every run reads the live page.
      const response = await extractFromUrl(row.url, { reader, api, youtubeApiKey: env.YOUTUBE_API_KEY, cache: new Map() });
      scores.push(scoreUrl(row, response));
      console.log(response.status);
    } catch (err) {
      scores.push(scoreUrl(row, null, err instanceof Error ? err.message.slice(0, 200) : "Unknown error"));
      console.log("error");
    }
    if (i < rows.length - 1) await sleep(PAUSE_MS);
  }

  const when = new Date().toISOString();
  const outPath = path.resolve("eval/report.md");
  writeFileSync(outPath, renderReport(scores, when), "utf8");
  console.log(`\nWrote ${path.relative(process.cwd(), outPath)}.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
