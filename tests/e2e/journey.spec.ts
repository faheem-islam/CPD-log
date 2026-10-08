import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import ExcelJS from "exceljs";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractBlocked, extractFixture, mockExtract, settle } from "./helpers";

/**
 * One signed-in person goes through the whole product, in order, against a production build in local demo mode
 * with a throwaway database and no optional keys. The tests share one browser context on purpose.
 */
test.describe.configure({ mode: "serial" });

const EMAIL = "Engineer.One@example.com";
const HUB_URL = "https://knowledgehub.ice.org.uk/cpd/safety-risk/principal-designer-role/";
const HUB_TITLE = "The principal designer role";

let context: BrowserContext;
let page: Page;
const tmp = mkdtempSync(path.join(os.tmpdir(), "cpd-e2e-files-"));

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-GB", timezoneId: "Europe/London" });
  page = await context.newPage();
});
test.afterAll(async () => {
  await context.close();
});

async function signIn(p: Page, next?: string) {
  await p.getByLabel("Email address").fill(EMAIL);
  await p.getByRole("button", { name: "Sign in to the demo" }).click();
  if (next) await p.waitForURL((u) => `${u.pathname}${u.search}` === next);
}

test("signed-out visitors go to sign-in and come back to the page they asked for", async () => {
  await page.goto("/log?q=signs");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Flog%3Fq%3Dsigns$/);
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Sign in to CPD Logger");
  await signIn(page, "/log?q=signs");
  // Not the dashboard: the person asked for the log.
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Your log");
});

test("an unsafe next address is ignored", async ({ browser }) => {
  const c = await browser.newContext();
  const p = await c.newPage();
  await p.goto("/sign-in?next=//evil.example/steal");
  await p.getByLabel("Email address").fill("someone.else@example.com");
  await p.getByRole("button", { name: "Sign in to the demo" }).click();
  await p.waitForURL(/\/dashboard$/);
  expect(new URL(p.url()).host).toBe(new URL(page.url()).host);
  await c.close();
});

test("settings: the header details are saved and survive a reload", async () => {
  await page.goto("/settings");
  await page.getByLabel("Name", { exact: true }).fill("Engineer One");
  await page.getByLabel("Job role", { exact: true }).fill("Graduate highways engineer");
  await page.getByLabel("Responsibilities", { exact: true }).fill("Road signing design and checking");
  await page.getByLabel("Engineering sector", { exact: true }).fill("Highways and transport");
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Engineer One");
  await expect(page.getByLabel("Engineering sector", { exact: true })).toHaveValue("Highways and transport");
  // Optional features are shown, and with no keys they are all off.
  await expect(page.getByText(/AI help/).first()).toBeVisible();
  await expect(page.getByText(/Local demo mode/).first()).toBeVisible();
});

test("add from a link: details, time must be confirmed, takeaways typed by hand, saved", async () => {
  const mocked = await mockExtract(page, (url) => extractFixture("ice-hub-explainer.html", url));
  await page.goto("/dashboard");
  await page.getByRole("textbox", { name: "Paste a link" }).fill(HUB_URL);
  await page.getByRole("button", { name: "Read link" }).click();

  // Detected details come with badges and the title from the real adapter.
  await expect(page.getByLabel("Title")).toHaveValue(HUB_TITLE);
  expect(mocked.calls).toEqual([HUB_URL]);
  await expect(page.getByText("High").first()).toBeVisible();
  await expect(page.getByText(/verified/i)).toHaveCount(0);
  await page.getByRole("button", { name: "Continue to time spent" }).click();

  // The detected length (15 minutes) is only a suggestion, and it is High confidence, yet the box starts unticked.
  const confirm = page.getByRole("checkbox", { name: "I confirm this is the time I actually spent learning" });
  await expect(confirm).not.toBeChecked();
  await expect(page.getByLabel(/^Hours/)).toHaveValue("0.25");
  await page.getByLabel(/^Hours/).fill("0.5");
  await page.getByRole("button", { name: "Continue to takeaways" }).click();

  // No AI key: no expand button, a plain explanation, and the fields are typed by hand.
  await expect(page.getByRole("button", { name: "Expand my notes" })).toHaveCount(0);
  await expect(page.getByText(/AI help isn't switched on here/)).toBeVisible();
  await page.getByLabel("Key learning points").fill("The principal designer coordinates health and safety in the pre-construction phase.");
  await page.getByLabel("How it helped").fill("Clearer on what to ask designers for at each stage of a signing scheme.");
  await page.getByRole("button", { name: "Continue to review" }).click();

  // Save stays disabled until the person has confirmed the time they spent.
  const save = page.getByRole("button", { name: "Save to ICE log" });
  await expect(save).toBeDisabled();
  await page.getByRole("checkbox", { name: "I confirm this is the time I actually spent learning" }).check();
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByText(/Saved to your ICE log/)).toBeVisible();
  await expect(page.getByText(HUB_TITLE).first()).toBeVisible();
  await page.unroute("**/api/extract");
});

test("the hours box can never be skipped, even by going straight to the manual form", async () => {
  await page.goto("/add?manual=1");
  await page.getByLabel("Title").fill("Manual entry for the gate test");
  await page.getByLabel(/^Hours/).fill("1");
  await expect(page.getByRole("button", { name: "Save to ICE log" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "I confirm this is the time I actually spent learning" }).check();
  await expect(page.getByRole("button", { name: "Save to ICE log" })).toBeEnabled();
});

test("a blocked site keeps the link and opens the manual form", async () => {
  const url = "https://www.newcivilengineer.com/latest/some-article/";
  await mockExtract(page, (u) => extractBlocked(u));
  await page.goto("/dashboard");
  await page.getByRole("textbox", { name: "Paste a link" }).fill(url);
  await page.getByRole("button", { name: "Read link" }).click();
  await expect(page.getByRole("heading", { name: "Couldn't read this site automatically" })).toBeVisible();
  await expect(page.getByText("This site doesn't allow automated reading.")).toBeVisible();
  await expect(page.getByLabel("Link")).toHaveValue(url);
  // The form is open and nothing offers a way round the block.
  await expect(page.getByLabel("Title")).toBeVisible();
  await expect(page.getByText(/headless|mirror|another user.?agent/i)).toHaveCount(0);
  await page.unroute("**/api/extract");
});

const YEAR = Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric" }).format(new Date()));
const AUDIT = "Highway safety audit webinar";
const SUDS = "Sustainable drainage design for roads";

async function makeIceWorkbook(file: string) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("ICE CPD log");
  ws.addRow(["My CPD record"]);
  ws.addRow([]);
  ws.addRow(["Name", "Engineer One"]);
  ws.addRow([]);
  // The table starts on row 5, so the first data row is row 6.
  ws.addRow(["Details of CPD activity", "ICE CPD Framework theme", "Dates", "Effective learning time", "Dev. Plan ref", "Key Learning Points", "Key Benefits/Value added"]);
  ws.addRow([AUDIT, "Safety and risk management", new Date(Date.UTC(YEAR, 2, 4)), 2, "unplanned", "Stage 2 road safety audits find hazards before a scheme opens.", "I will ask for the audit brief earlier in scheme design."]);
  ws.addRow([SUDS, "Sustainable development", `12/03/${YEAR}`, "1h 30m", "unplanned", "How filter drains and swales are sized for highway run-off.", "Useful when reviewing drainage strategies on the A-road schemes."]);
  ws.addRow(["Bad row with no usable date", "Transport", "not a date", 1, "unplanned", "Some learning that was written down.", "Some benefit."]);
  await wb.xlsx.writeFile(file);
}

test("import: a spreadsheet with a bad row can't be committed until the row is left out", async () => {
  const file = path.join(tmp, "my-cpd-record.xlsx");
  await makeIceWorkbook(file);
  await page.goto("/import");
  await settle(page);
  await page.getByLabel("Choose a file").setInputFiles(file);

  const row6 = page.getByRole("checkbox", { name: "Include row 6", exact: true });
  const row7 = page.getByRole("checkbox", { name: "Include row 7", exact: true });
  const row8 = page.getByRole("checkbox", { name: "Include row 8", exact: true });
  await expect(row6).toBeChecked();
  await expect(row7).toBeChecked();
  // The row with the unreadable date starts left out, and says why.
  await expect(row8).not.toBeChecked();
  const commit = page.getByRole("button", { name: /^Import \d+ rows?$/ });
  await expect(commit).toHaveText("Import 2 rows");

  // Ticking the bad row blocks the import until it is fixed or left out again.
  await row8.check();
  await expect(commit).toBeDisabled();
  await row8.uncheck();
  await expect(commit).toBeEnabled();
  await commit.click();
  await expect(page).toHaveURL(/\/log/);
  await expect(page.getByText(/Imported 2 entries/)).toBeVisible();
});

test("import: a screenshot says plainly that it needs the AI feature when there is no key", async () => {
  // A 1x1 PNG, created here.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const file = path.join(tmp, "my-record.png");
  writeFileSync(file, png);
  await page.goto("/import");
  await settle(page);
  await page.getByLabel("Choose a file").setInputFiles(file);
  await expect(page.getByText(/Screenshots need the AI feature/).first()).toBeVisible();
  // Nothing was imported and the page offers the Excel/CSV route.
  await expect(page.getByText(/Excel or CSV/).first()).toBeVisible();
});

test("log: search, edit, delete and undo", async () => {
  await page.goto("/log");
  await expect(page.getByRole("button", { name: `Edit ${SUDS}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Edit ${HUB_TITLE}`, exact: true })).toBeVisible();

  await page.getByRole("textbox", { name: "Search your log" }).fill("drainage");
  await expect(page.getByRole("button", { name: `Edit ${SUDS}`, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Edit ${HUB_TITLE}`, exact: true })).toHaveCount(0);
  await page.getByRole("textbox", { name: "Search your log" }).fill("");

  // Edit in a dialog.
  await page.getByRole("button", { name: `Edit ${SUDS}`, exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(`${SUDS} (updated)`);
  await dialog.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("button", { name: `Edit ${SUDS} (updated)`, exact: true })).toBeVisible();

  // Delete is a soft delete with an Undo.
  await page.getByRole("button", { name: `Delete ${SUDS} (updated)`, exact: true }).click();
  await expect(page.getByRole("button", { name: `Edit ${SUDS} (updated)`, exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Undo" }).click();
  await expect(page.getByRole("button", { name: `Edit ${SUDS} (updated)`, exact: true })).toBeVisible();
});

test("dashboard: hours and themes recorded, never 'compliant'", async () => {
  await page.goto("/dashboard");
  await settle(page);
  const body = page.locator("main");
  await expect(body.getByText(/themes? recorded/i).first()).toBeVisible();
  await expect(body.getByText(/for information only/i).first()).toBeVisible();
  await expect(body.getByText(/compliant/i)).toHaveCount(0);
  // 0.5 + 2 + 1.5 hours across the three entries this year.
  await expect(body.getByText("4", { exact: true }).first()).toBeVisible();
  await expect(body.getByText(HUB_TITLE).first()).toBeVisible();
});

test("export: the downloaded workbook has the ICE layout, real dates, numeric hours and a Summary", async () => {
  await page.goto("/export");
  await settle(page);
  await expect(page.getByText(/no import feature/i).first()).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download Excel file" }).click()]);
  const out = path.join(tmp, "downloaded.xlsx");
  await download.saveAs(out);
  expect(download.suggestedFilename()).toMatch(/\.xlsx$/);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const names = wb.worksheets.map((w) => w.name);
  expect(names).toContain("Summary");
  const ice = wb.worksheets.find((w) => w.name.startsWith("ICE"));
  expect(ice, `sheets: ${names.join(", ")}`).toBeTruthy();
  if (!ice) return;

  // Header block on rows 1-2, table header on row 4.
  expect([1, 2, 3].map((c) => ice.getCell(1, c).value)).toEqual(["Name", "Job role and responsibilities", "Engineering sector"]);
  expect(ice.getCell(2, 1).value).toBe("Engineer One");
  expect(String(ice.getCell(2, 2).value)).toContain("Graduate highways engineer");
  expect(ice.getCell(2, 3).value).toBe("Highways and transport");
  expect([1, 2, 3, 4, 5, 6, 7].map((c) => ice.getCell(4, c).value)).toEqual([
    "Details of CPD activity",
    "ICE CPD Framework theme",
    "Dates",
    "Effective learning time",
    "Dev. Plan ref",
    "Key Learning Points",
    "Key Benefits/Value added",
  ]);
  // Frozen below the table header, with a filter on it.
  const view = ice.views[0];
  expect(view?.state).toBe("frozen");
  expect(view && "ySplit" in view ? view.ySplit : undefined).toBe(4);
  expect(ice.autoFilter).toBeTruthy();

  // Three entries, oldest first. Dates are real date cells; hours are real numbers.
  const dates: Date[] = [];
  const hours: number[] = [];
  for (let r = 5; r <= 7; r++) {
    const d = ice.getCell(r, 3);
    expect(d.value instanceof Date, `row ${r} date is a Date`).toBe(true);
    expect(d.numFmt).toBe("dd/mm/yyyy");
    dates.push(d.value as Date);
    const h = ice.getCell(r, 4);
    expect(typeof h.value, `row ${r} hours is a number`).toBe("number");
    hours.push(h.value as number);
  }
  expect(dates[0]?.toISOString()).toBe(`${YEAR}-03-04T00:00:00.000Z`);
  expect(dates[1]?.toISOString()).toBe(`${YEAR}-03-12T00:00:00.000Z`);
  expect(hours.slice(0, 2)).toEqual([2, 1.5]);
  expect(hours[2]).toBe(0.5);
  expect(String(ice.getCell(5, 1).value)).toContain(AUDIT);
  expect(ice.getCell(5, 2).value).toBe("Safety and risk management");
  expect(ice.getCell(5, 5).value).toBe("unplanned");
  expect(ice.getCell(8, 1).value ?? null).toBeNull();

  // Summary: hours by year and by theme, as numbers.
  const summary = wb.getWorksheet("Summary");
  const cells: Array<string | number | Date | null> = [];
  summary?.eachRow((row) => row.eachCell((c) => cells.push(c.value as string | number | Date | null)));
  expect(cells).toContain(YEAR);
  expect(cells).toContain(4);
  expect(cells.filter((c) => typeof c === "string" && /Safety and risk management/.test(c)).length).toBeGreaterThan(0);
  expect(cells.filter((c) => typeof c === "string" && /no import feature/i.test(c)).length).toBeGreaterThan(0);
});

test("IStructE is switched on, marked provisional, and exported on its own sheet with the note", async () => {
  await page.goto("/settings");
  await settle(page);
  await page.getByRole("checkbox", { name: "IStructE", exact: true }).check();
  await page.getByRole("button", { name: "Save settings" }).click();
  await expect(page.getByText("Settings saved")).toBeVisible();

  await page.goto("/add?manual=1");
  await settle(page);
  await page.getByRole("radio", { name: /IStructE/ }).check();
  await page.getByLabel("Title").fill("Structural robustness of highway sign gantries");
  await page.getByLabel(/^Hours/).fill("2");
  await page.getByLabel("Category").selectOption({ label: "Self-directed study" });
  await page.getByLabel("Development gained").fill("I learned how gantry foundations are checked for wind and impact loads, which helps me review sign gantry designs.");
  await page.getByRole("checkbox", { name: "I confirm this is the time I actually spent learning" }).check();
  await page.getByRole("button", { name: "Save to IStructE log" }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  // The dashboard can switch to IStructE and says the panel is provisional.
  await page.goto("/dashboard?profile=istructe");
  await settle(page);
  await expect(page.locator("main").getByText(/provisional/i).first()).toBeVisible();
  await expect(page.locator("main").getByText(/of 30 hours/).first()).toBeVisible();

  await page.goto("/export");
  await settle(page);
  await expect(page.locator("main").getByText(/provisional/i).first()).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download Excel file" }).click()]);
  const out = path.join(tmp, "both.xlsx");
  await download.saveAs(out);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(out);
  const sheet = wb.worksheets.find((w) => /IStructE/.test(w.name));
  expect(sheet, `sheets: ${wb.worksheets.map((w) => w.name).join(", ")}`).toBeTruthy();
  if (!sheet) return;
  let note = false;
  sheet.eachRow((row) => row.eachCell((c) => { if (typeof c.value === "string" && /provisional/i.test(c.value)) note = true; }));
  expect(note, "the IStructE sheet carries the provisional note").toBe(true);
  const headerRow = [1, 2, 3, 4, 5, 6, 7].map((c) => sheet.getCell(3, c).value);
  expect(headerRow).toEqual(["Date", "Activity title", "Category", "Hours", "Structural safety (Y/N)", "Sustainability (Y/N)", "Development gained"]);
  expect(sheet.getCell(4, 1).value instanceof Date).toBe(true);
  expect(sheet.getCell(4, 4).value).toBe(2);
});

const PAGES = ["/dashboard", "/add", "/add?manual=1", "/log", "/import", "/export", "/settings", "/help", "/privacy", "/terms"] as const;

for (const theme of ["light", "dark"] as const) {
  test(`accessibility: axe finds no serious or critical problems on any main page (${theme}, with data)`, async () => {
    await page.emulateMedia({ colorScheme: theme });
    for (const url of PAGES) {
      await page.goto(url);
      await settle(page);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = results.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
      expect(
        bad.map((v) => `${v.id} (${v.impact}): ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`),
        `${url} in ${theme} mode`,
      ).toEqual([]);
    }
    await page.emulateMedia({ colorScheme: "light" });
  });
}

test("phone width: no page scrolls sideways at 375px with data present", async () => {
  await page.setViewportSize({ width: 375, height: 812 });
  // A very long unbroken title must not widen the page.
  const long = `Longtitle${"x".repeat(160)}`;
  await page.goto("/add?manual=1");
  await settle(page);
  await page.getByRole("radio", { name: /ICE/ }).check();
  await page.getByLabel("Title").fill(long);
  await page.getByLabel(/^Hours/).fill("1");
  await page.getByRole("checkbox", { name: "I confirm this is the time I actually spent learning" }).check();
  await page.getByRole("button", { name: "Save to ICE log" }).click();
  await expect(page).toHaveURL(/\/dashboard/);

  for (const url of PAGES) {
    await page.goto(url);
    await settle(page);
    const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
    expect(scroll, `${url} is ${scroll}px wide in a ${client}px window`).toBeLessThanOrEqual(client);
  }
  // The bottom navigation is there on a phone and its targets are big enough.
  await page.goto("/dashboard");
  await settle(page);
  const nav = page.getByRole("navigation", { name: "Main" }).last();
  await expect(nav).toBeVisible();
  for (const link of await nav.getByRole("link").all()) {
    const box = await link.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
    expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("delete account: everything goes, and signing in again starts empty", async () => {
  await page.goto("/settings");
  await settle(page);
  await page.getByRole("button", { name: "Delete my account" }).click();
  await page.getByRole("button", { name: "Yes, delete everything" }).click();
  await expect(page).toHaveURL(/\/sign-in/, { timeout: 30_000 });

  // The old session no longer works.
  await page.goto("/log");
  await expect(page).toHaveURL(/\/sign-in\?next=%2Flog/);
  await signIn(page, "/log");
  await expect(page.getByText(/Nothing in your log yet/)).toBeVisible();
});
