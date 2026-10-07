import type ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { buildAllData } from "@/lib/export/all-data";
import { previewExport } from "@/lib/export/preview";
import { escapeOoxmlText } from "@/lib/export/safe-text";
import { HEADER_ROW, buildWorkbook, exportFilename } from "@/lib/export/workbook";
import type { Entry, ProfileId, UserSettings } from "@/lib/types";
import { makeEntry, makeSettings, NOW, readBack, shown } from "./export-test-helpers";

const settings = makeSettings({
  customFields: [
    { key: "cert", label: "Certificate number", type: "text" },
    { key: "when", label: "Renewal date", type: "date" },
  ],
});

async function build(entries: Entry[], profiles: ProfileId[], over: { now?: Date; settings?: UserSettings } = {}): Promise<ExcelJS.Workbook> {
  return readBack(await buildWorkbook({ entries, settings: over.settings ?? settings, profiles, year: "all", now: over.now ?? NOW }));
}

/** Every string a sheet holds, with the cell it is in. */
function allText(ws: ExcelJS.Worksheet): { address: string; text: string }[] {
  const out: { address: string; text: string }[] = [];
  ws.eachRow((row) => row.eachCell((c) => out.push({ address: c.address, text: shown(c) })));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------

describe("a date range is not cut off in its column", () => {
  const range = { dateCompleted: "2026-05-04", dateEnd: "2026-05-06" };

  it("wraps the range text in the ICE, IStructE and Custom sheets, so the end date shows", async () => {
    const wb = await build(
      [makeEntry({ ...range, title: "Ice range" }), makeEntry({ ...range, profile: "istructe", title: "IStructE range" }), makeEntry({ ...range, profile: "custom", title: "Custom range" })],
      ["ice", "istructe", "custom"],
    );
    const ice = wb.getWorksheet("ICE CPD log");
    const ist = wb.getWorksheet("IStructE CPD log (provisional)");
    const cus = wb.getWorksheet("Custom CPD log");
    const cells = [ice?.getCell(HEADER_ROW.ice + 1, 3), ist?.getCell(HEADER_ROW.istructe + 1, 1), cus?.getCell(HEADER_ROW.custom + 1, 1)];
    for (const c of cells) {
      expect(c?.value).toBe("04/05/2026 - 06/05/2026");
      expect(c?.alignment?.wrapText).toBe(true);
      expect(c?.alignment?.vertical).toBe("top");
    }
  });

  it("leaves a single date as a real date cell that does not need to wrap", async () => {
    const wb = await build([makeEntry({ title: "One day", dateCompleted: "2026-05-04" })], ["ice"]);
    const c = wb.getWorksheet("ICE CPD log")?.getCell("C5");
    expect(c?.value).toBeInstanceOf(Date);
    expect(c?.alignment?.wrapText).toBeFalsy();
  });

  it("keeps the column widths from the profile config", async () => {
    const wb = await build([makeEntry(range)], ["ice"]);
    expect(wb.getWorksheet("ICE CPD log")?.getColumn(3).width).toBe(14);
  });
});

describe("the About block does not contradict itself", () => {
  const lines = (wb: ExcelJS.Workbook): string[] => {
    const ws = wb.getWorksheet("Summary") as ExcelJS.Worksheet;
    const out: string[] = [];
    let on = false;
    ws.eachRow((row) => {
      const v = shown(row.getCell(1));
      if (v === "About this file") on = true;
      else if (on && v) out.push(v);
    });
    return out;
  };

  it("does not say every value was confirmed, and then list hours that were not", async () => {
    const wb = await build([makeEntry({ title: "Unconfirmed", hoursConfirmed: false })], ["ice"]);
    const about = lines(wb).join("\n");
    expect(about).toMatch(/1 entry has effective learning time you have not confirmed\./);
    expect(about).not.toMatch(/every value/i);
    expect(about).not.toMatch(/confirmed by you/i);
    expect(about).toMatch(/Values were entered or reviewed by you in CPD Logger\. Anything detected automatically from a link or file should be checked by you before you rely on it\./);
  });

  it("never uses the word verified anywhere on the Summary sheet", async () => {
    for (const hoursConfirmed of [true, false]) {
      const wb = await build([makeEntry({ hoursConfirmed }), makeEntry({ profile: "istructe", hoursConfirmed })], ["ice", "istructe", "custom"]);
      const text = allText(wb.getWorksheet("Summary") as ExcelJS.Worksheet).map((c) => c.text).join("\n");
      expect(text).not.toMatch(/verif/i);
    }
  });
});

describe("text that looks like an OOXML escape is written so it reads back unchanged", () => {
  const nasty = ["A_x0041_B _x000D_ end", "tank_x00FF_data", "_x005F_x0041_", "_x00ff_ lower", "_x41_ short", "plain_text_ x0041", "a__x0041_"];

  it("escapes only the underscore that starts a sequence", () => {
    expect(escapeOoxmlText("A_x0041_B")).toBe("A_x005F_x0041_B");
    expect(escapeOoxmlText("_x005F_")).toBe("_x005F_x005F_");
    expect(escapeOoxmlText("a_b_c x0041_")).toBe("a_b_c x0041_");
    expect(escapeOoxmlText("_x41_")).toBe("_x41_");
    expect(escapeOoxmlText("")).toBe("");
  });

  it("round-trips titles, learning points, the header block, custom labels and values, and summary labels", async () => {
    const custom = makeSettings({
      name: "Name_x0041_",
      jobRole: "Role_x0042_",
      responsibilities: "",
      customFields: [{ key: "cert", label: "Cert_x0043_", type: "text" }],
    });
    const entries = nasty.map((t, i) => makeEntry({ title: `T${t}`, dateCompleted: `2026-03-0${i + 1}`, learningPoints: `L${t}`, theme: `Other${t}`, custom: {} }));
    const cus = nasty.map((t, i) => makeEntry({ profile: "custom", title: `C${t}`, dateCompleted: `2026-04-0${i + 1}`, custom: { cert: `V${t}` } }));
    const ist = [makeEntry({ profile: "istructe", title: "I", category: "Cat_x0044_", developmentGained: `D${nasty[0]}` })];
    const wb = await build([...entries, ...cus, ...ist], ["ice", "custom", "istructe"], { settings: custom });
    const ice = wb.getWorksheet("ICE CPD log") as ExcelJS.Worksheet;
    const titles = Array.from({ length: nasty.length }, (_, i) => String(ice.getCell(HEADER_ROW.ice + 1 + i, 1).value));
    expect(titles).toEqual(nasty.map((t) => `T${t}`));
    const points = Array.from({ length: nasty.length }, (_, i) => String(ice.getCell(HEADER_ROW.ice + 1 + i, 6).value));
    expect(points).toEqual(nasty.map((t) => `L${t}`));
    expect(String(ice.getCell(2, 1).value)).toBe("Name_x0041_");
    expect(String(ice.getCell(2, 2).value)).toBe("Role_x0042_");
    const cs = wb.getWorksheet("Custom CPD log") as ExcelJS.Worksheet;
    expect(String(cs.getCell(1, 4).value)).toBe("Cert_x0043_");
    expect(Array.from({ length: nasty.length }, (_, i) => String(cs.getCell(2 + i, 4).value))).toEqual(nasty.map((t) => `V${t}`));
    const summary = allText(wb.getWorksheet("Summary") as ExcelJS.Worksheet).map((c) => c.text);
    expect(summary).toContain("OtherA_x0041_B _x000D_ end");
    expect(summary).toContain("Cat_x0044_");
    const is = wb.getWorksheet("IStructE CPD log (provisional)") as ExcelJS.Worksheet;
    expect(String(is.getCell(HEADER_ROW.istructe + 1, 7).value)).toBe(`D${nasty[0]}`);
  });

  it("does not change how a title looks in the preview, which shows what was typed", () => {
    const [p] = previewExport({ entries: [makeEntry({ title: "tank_x00FF_data" })], settings, profiles: ["ice"], year: "all" });
    expect(p?.rows[0]?.[0]).toBe("tank_x00FF_data");
  });
});

describe("the preview refuses what the workbook refuses", () => {
  const base = { entries: [makeEntry()], settings };
  const attempts: [string, { profiles: ProfileId[]; year: number | "all" }][] = [
    ["an unknown profile", { profiles: ["nope" as ProfileId], year: "all" }],
    ["no profile", { profiles: [], year: "all" }],
    ["a year given as text", { profiles: ["ice"], year: "2026" as unknown as number }],
    ["a year that is not a number", { profiles: ["ice"], year: Number.NaN }],
    ["a year that is not whole", { profiles: ["ice"], year: 2026.5 }],
    ["a year long ago", { profiles: ["ice"], year: 1899 }],
  ];

  it.each(attempts)("refuses %s, with the same words as the file", async (_label, over) => {
    const message = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        expect(e).toBeInstanceOf(RangeError);
        return (e as Error).message;
      }
      throw new Error("should have thrown");
    };
    const fromPreview = message(() => previewExport({ ...base, ...over }));
    let fromFile = "";
    await buildWorkbook({ ...base, ...over, now: NOW }).catch((e: Error) => {
      fromFile = e.message;
    });
    expect(fromPreview).toBe(fromFile);
    expect(fromPreview).not.toMatch(/undefined|Cannot read/);
  });

  it("still shows each profile once, in the order asked for", () => {
    const out = previewExport({ ...base, profiles: ["custom", "ice", "custom"], year: "all" });
    expect(out.map((p) => p.profile)).toEqual(["custom", "ice"]);
  });
});

describe("entries that belong to someone else are not exported", () => {
  const mine = makeEntry({ userId: "user-1", title: "Mine" });
  const theirs = makeEntry({ userId: "user-2", title: "Theirs" });
  const input = { settings, profiles: ["ice"] as ProfileId[], year: "all" as const, now: NOW };
  const REFUSED = /do not all belong to one user/;

  it("stops a workbook and a preview that were handed entries of two people", async () => {
    await expect(buildWorkbook({ ...input, entries: [mine, theirs] })).rejects.toThrow(REFUSED);
    expect(() => previewExport({ ...input, entries: [mine, theirs] })).toThrow(REFUSED);
  });

  it("stops them when the entries are not the user's the caller names", async () => {
    await expect(buildWorkbook({ ...input, entries: [theirs], userId: "user-1" })).rejects.toThrow(REFUSED);
    expect(() => previewExport({ ...input, entries: [theirs], userId: "user-1" })).toThrow(REFUSED);
    expect(() => buildAllData({ settings, entries: [theirs], now: NOW, userId: "user-1" })).toThrow(REFUSED);
  });

  it("lets through the user's own entries, with or without a user id", async () => {
    await expect(buildWorkbook({ ...input, entries: [mine], userId: "user-1" })).resolves.toBeInstanceOf(Buffer);
    expect(previewExport({ ...input, entries: [mine], userId: "user-1" })[0]?.count).toBe(1);
    await expect(buildWorkbook({ ...input, entries: [mine] })).resolves.toBeInstanceOf(Buffer);
    expect(previewExport({ ...input, entries: [] })[0]?.count).toBe(0);
  });
});

describe("what the earlier mutation run found was not tested", () => {
  it("neutralises a theme and a category that start with a formula character in the Summary sheet", async () => {
    const wb = await build(
      [
        makeEntry({ theme: "=cmd|' /C calc'!A0", title: "Formula theme" }),
        makeEntry({ profile: "istructe", category: "@SUM(1+1)", title: "Formula category" }),
        makeEntry({ profile: "istructe", category: "+1+1", title: "Plus category" }),
      ],
      ["ice", "istructe"],
    );
    const summary = allText(wb.getWorksheet("Summary") as ExcelJS.Worksheet);
    const texts = summary.map((c) => c.text);
    expect(texts).toContain("'=cmd|' /C calc'!A0");
    expect(texts).toContain("'@SUM(1+1)");
    expect(texts).toContain("'+1+1");
    // Nowhere in the workbook does a cell start with a formula character.
    for (const ws of wb.worksheets) {
      for (const c of allText(ws)) expect(c.text, `${ws.name}!${c.address}`).not.toMatch(/^[=+@]/);
    }
  });

  it("writes the UK date in Generated on, not the UTC date, late on a summer evening", async () => {
    const summer = new Date(Date.UTC(2026, 6, 7, 23, 30));
    const wb = await build([makeEntry()], ["ice"], { now: summer });
    const text = allText(wb.getWorksheet("Summary") as ExcelJS.Worksheet).map((c) => c.text).join("\n");
    expect(text).toContain("Generated on 08/07/2026 by CPD Logger.");
    expect(text).not.toContain("Generated on 07/07/2026");
    expect(exportFilename("all", summer)).toBe("cpd-log-all-years-2026-07-08.xlsx");
    // In winter the two dates are the same.
    const winter = new Date(Date.UTC(2026, 0, 7, 23, 30));
    const w = await build([makeEntry()], ["ice"], { now: winter });
    expect(allText(w.getWorksheet("Summary") as ExcelJS.Worksheet).map((c) => c.text).join("\n")).toContain("Generated on 07/01/2026 by CPD Logger.");
  });
});
