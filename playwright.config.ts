import { defineConfig, devices } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const port = Number(process.env.E2E_PORT ?? 3100);
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "cpd-e2e-"));
const dbPath = path.join(dbDir, "local-db.json");

/** Use a system Chromium when one is provided (CI installs its own with `playwright install`). */
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: "retain-on-failure",
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Production build, local demo mode, a throwaway database file, and every optional key blank.
    command: `npm run start -- --port ${port} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${port}/sign-in`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NODE_ENV: "production",
      CPD_LOCAL_MODE: "true",
      CPD_LOCAL_DB: dbPath,
      CPD_E2E: "true",
      NEXT_PUBLIC_SUPABASE_URL: "",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "",
      ANTHROPIC_API_KEY: "",
      YOUTUBE_API_KEY: "",
      SENTRY_DSN: "",
    },
  },
});
