import { expect, test, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractFixture, mockExtract, settle } from "./helpers";

/**
 * Not part of the normal run. `E2E_SCREENSHOTS=1 npm run e2e -- screenshots` writes PNGs to ./screenshots
 * (desktop and 390px phone, light and dark, with data and empty) so the design can be looked at.
 * The data is typed in by this script into a throwaway database. The app itself ships with none.
 */
test.skip(!process.env.E2E_SCREENSHOTS, "Set E2E_SCREENSHOTS=1 to take screenshots.");
test.describe.configure({ mode: "serial" });

const OUT = path.resolve(import.meta.dirname, "../../screenshots");
mkdirSync(OUT, { recursive: true });
const YEAR = new Date().getFullYear();

const ICE_THEMES = ["Safety and risk management", "Sustainable development", "Ethical and professional behaviours", "Transport", "Delivery excellence", "Water"];

async function signIn(page: Page, email: string) {
  await page.goto("/sign-in");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Sign in to the demo" }).click();
  await page.waitForURL(/\/dashboard/);
}

async function post(page: Page, url: string, data: unknown) {
  const res = await page.request.post(url, { data, headers: { Origin: "http://127.0.0.1:3100" } });
  expect(res.ok(), `${url}: ${await res.text()}`).toBe(true);
}

function entry(over: Record<string, unknown>) {
  return {
    profile: "ice", title: "x", url: null, provider: null, sourceType: "article", publishedAt: null, dateCompleted: `${YEAR}-02-10`, dateEnd: null,
    detectedDurationMinutes: null, hours: 1, hoursConfirmed: true, theme: null, category: null, structuralSafety: null, sustainability: null,
    devPlanRef: "unplanned", learningPoints: "", benefits: { helped: "", future: "", nextYear: "" }, developmentGained: "", custom: {}, notes: "",
    aiAssisted: false, confidence: {}, ...over,
  };
}

async function shot(page: Page, name: string, fullPage = true) {
  await settle(page);
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage });
}

const MODES = [
  { key: "desktop-light", width: 1280, height: 800, scheme: "light" as const },
  { key: "desktop-dark", width: 1280, height: 800, scheme: "dark" as const },
  { key: "mobile-light", width: 390, height: 844, scheme: "light" as const },
  { key: "mobile-dark", width: 390, height: 844, scheme: "dark" as const },
];

test("empty account", async ({ browser }) => {
  for (const m of MODES) {
    const ctx = await browser.newContext({ viewport: { width: m.width, height: m.height }, colorScheme: m.scheme, locale: "en-GB", timezoneId: "Europe/London" });
    const page = await ctx.newPage();
    if (m.key === "desktop-light") {
      await page.goto("/sign-in");
      await shot(page, "signin-desktop-light");
    }
    await signIn(page, `empty-${m.key}@example.com`);
    for (const [name, url] of [["dashboard", "/dashboard"], ["log", "/log"], ["export", "/export"], ["import", "/import"]] as const) {
      await page.goto(url);
      await shot(page, `empty-${name}-${m.key}`);
    }
    await ctx.close();
  }
});

test("populated account", async ({ browser }) => {
  const seed = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: "en-GB", timezoneId: "Europe/London" });
  const sp = await seed.newPage();
  await signIn(sp, "populated@example.com");
  await post(sp, "/api/entries", { entry: entry({ title: "The principal designer role", provider: "Institution of Civil Engineers (ICE)", url: "https://knowledgehub.ice.org.uk/cpd/safety-risk/principal-designer-role/", theme: ICE_THEMES[0], hours: 0.25, dateCompleted: `${YEAR}-01-14`, learningPoints: "The principal designer coordinates health and safety in the pre-construction phase.", benefits: { helped: "Clearer on what to request from designers at each stage.", future: "", nextYear: "" } }) });
  await post(sp, "/api/entries", { entry: entry({ title: "Road safety audit: stage 2 findings on a trunk road junction", provider: "CIHT", sourceType: "webinar", theme: ICE_THEMES[0], hours: 1, dateCompleted: `${YEAR}-02-03`, learningPoints: "How stage 2 audit problems are recorded and responded to.", benefits: { helped: "Will use the response log format on my current scheme.", future: "", nextYear: "" } }) });
  await post(sp, "/api/entries", { entry: entry({ title: "Sustainable drainage design for roads", provider: "National Highways", sourceType: "video", theme: ICE_THEMES[1], hours: 1.5, dateCompleted: `${YEAR}-03-12`, learningPoints: "How filter drains and swales are sized for highway run-off.", benefits: { helped: "Useful when reviewing drainage strategies.", future: "", nextYear: "" } }) });
  await post(sp, "/api/entries", { entry: entry({ title: "Traffic Signs Manual chapter 7: road markings", provider: "gov.uk", sourceType: "document", theme: ICE_THEMES[3], hours: 2, dateCompleted: `${YEAR}-04-02`, learningPoints: "Changes to centre line and edge marking dimensions.", benefits: { helped: "Checked a markings drawing against the current dimensions.", future: "", nextYear: "" } }) });
  await post(sp, "/api/entries", { entry: entry({ title: `Longtitle${"x".repeat(120)}`, provider: "A very long provider name that goes on and on for a while", theme: ICE_THEMES[4], hours: 0.5, dateCompleted: `${YEAR}-04-20`, learningPoints: "Short note." }) });
  await post(sp, "/api/entries", { entry: entry({ title: "Last year: ethics in practice", provider: "ICE", theme: ICE_THEMES[2], hours: 1, dateCompleted: `${YEAR - 1}-11-05`, learningPoints: "Reporting concerns about professional conduct.", benefits: { helped: "Know who to speak to.", future: "", nextYear: "" } }) });
  await sp.request.put("/api/settings", { data: { name: "Alex Example", jobRole: "Graduate highways engineer", responsibilities: "Road signing design and checking", sector: "Highways and transport", activeProfiles: ["ice", "istructe"], customFields: [] }, headers: { Origin: "http://127.0.0.1:3100" } });
  await post(sp, "/api/entries", { entry: entry({ profile: "istructe", title: "Structural robustness of sign gantries", category: "Self-directed study", structuralSafety: true, sustainability: false, hours: 3, dateCompleted: `${YEAR}-03-30`, developmentGained: "I learned how gantry foundations are checked for wind and impact loads, which helps me review designs." }) });
  const state = await seed.storageState();
  await seed.close();

  for (const m of MODES) {
    const ctx = await browser.newContext({ viewport: { width: m.width, height: m.height }, colorScheme: m.scheme, locale: "en-GB", timezoneId: "Europe/London", storageState: state });
    const page = await ctx.newPage();
    for (const [name, url] of [
      ["dashboard-ice", "/dashboard"], ["dashboard-istructe", "/dashboard?profile=istructe"], ["log", "/log"], ["export", "/export"], ["settings", "/settings"],
      ["help", "/help"], ["privacy", "/privacy"], ["add-link", "/add"], ["add-manual", "/add?manual=1"],
    ] as const) {
      await page.goto(url);
      await shot(page, `data-${name}-${m.key}`);
    }
    // The review step, from the real adapters over a hand-written fixture.
    await mockExtract(page, (u) => extractFixture("ice-hub-explainer.html", u));
    await page.goto("/add?url=" + encodeURIComponent("https://knowledgehub.ice.org.uk/cpd/safety-risk/principal-designer-role/"));
    await expect(page.getByLabel("Title")).toHaveValue("The principal designer role");
    await shot(page, `data-add-review-${m.key}`);
    await page.getByRole("button", { name: "Continue to time spent" }).click();
    await shot(page, `data-add-time-${m.key}`);
    await page.unroute("**/api/extract");

    // Log edit dialog.
    await page.goto("/log");
    await settle(page);
    await page.getByRole("button", { name: "Edit Sustainable drainage design for roads", exact: true }).click();
    await shot(page, `data-log-edit-${m.key}`, false);

    // Import review with a bad row.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("ICE CPD log");
    ws.addRow(["Details of CPD activity", "ICE CPD Framework theme", "Dates", "Effective learning time", "Key Learning Points", "Key Benefits/Value added"]);
    ws.addRow(["Highway lighting columns: passive safety", "Safety and risk management", new Date(Date.UTC(YEAR, 4, 6)), 1.5, "How passive safety columns behave on impact.", "Will check column types on a current scheme."]);
    ws.addRow(["Climate adaptation for road assets", "Sustainable development", `19/05/${YEAR}`, "2h", "", ""]);
    ws.addRow(["Row with a date nobody can read", "Transport", "someday", 1, "x", ""]);
    const file = path.join(os.tmpdir(), `shots-import-${m.key}.xlsx`);
    await wb.xlsx.writeFile(file);
    await page.goto("/import");
    await settle(page);
    await page.getByLabel("Choose a file").setInputFiles(file);
    await expect(page.getByRole("checkbox", { name: "Include row 2", exact: true })).toBeVisible();
    await shot(page, `data-import-review-${m.key}`);
    await ctx.close();
  }
});
