/**
 * Runs the real extraction code over a hand-written fixture (or a refusing reader) and prints the ExtractResponse as JSON.
 *   tsx tests/e2e/extract-cli.ts fixture <file.html> <url>
 *   tsx tests/e2e/extract-cli.ts blocked <url>
 * The Playwright tests call this so they never import the app's source directly, and never touch the network.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { extractFromUrl } from "../../src/lib/extract";
import type { ApiFetcher, PageReader, ReadOutcome } from "../../src/lib/net/types";

const [mode, ...rest] = process.argv.slice(2);
const noApi: ApiFetcher = { getJson: async () => ({ kind: "failed", message: "No network in tests." }) };

function reader(): { reader: PageReader; url: string } {
  if (mode === "fixture") {
    const [file = "", url = ""] = rest;
    const body = readFileSync(path.resolve(import.meta.dirname, "../fixtures/html", file), "utf8");
    return {
      url,
      reader: { read: async (u): Promise<ReadOutcome> => ({ kind: "ok", finalUrl: u, status: 200, contentType: "text/html; charset=utf-8", body, fromCache: false }) },
    };
  }
  if (mode === "blocked") {
    return {
      url: rest[0] ?? "",
      reader: {
        read: async (): Promise<ReadOutcome> => ({
          kind: "blocked",
          message: "This site doesn't allow automated reading. We haven't tried to get around that. You can type the details in yourself.",
        }),
      },
    };
  }
  throw new Error(`Unknown mode: ${mode}`);
}

const { reader: r, url } = reader();
const response = await extractFromUrl(url, { reader: r, api: noApi, cache: new Map() });
process.stdout.write(JSON.stringify(response));
