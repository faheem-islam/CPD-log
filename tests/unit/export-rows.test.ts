import { describe, expect, it } from "vitest";
import { PROFILES } from "@/lib/profiles";
import { cellDisplay, exportColumns, exportRows, iceDetails, iceHeaderBlock, selectEntries, sortEntries } from "@/lib/export/rows";
import { makeEntry, makeSettings } from "./export-test-helpers";

const settings = makeSettings();

describe("exportColumns", () => {
  it("follows the ICE config order exactly", () => {
    const labels = exportColumns("ice", settings).map((c) => c.label);
    expect(labels).toEqual([
      "Details of CPD activity",
      "ICE CPD Framework theme",
      "Dates",
      "Effective learning time",
      "Dev. Plan ref",
      "Key Learning Points",
      "Key Benefits/Value added",
    ]);
    expect(labels).toEqual(PROFILES.ice.columns.map((c) => c.label));
  });

  it("follows the IStructE config order exactly", () => {
    expect(exportColumns("istructe", settings).map((c) => c.label)).toEqual([
      "Date",
      "Activity title",
      "Category",
      "Hours",
      "Structural safety (Y/N)",
      "Sustainability (Y/N)",
      "Development gained",
    ]);
  });

  it("puts the user's own labels after Date, Activity and Hours for Custom", () => {
    const s = makeSettings({
      customFields: [
        { key: "cert", label: "Certificate number", type: "text" },
        { key: "cost", label: "Cost in pounds", type: "number" },
      ],
    });
    const cols = exportColumns("custom", s);
    expect(cols.map((c) => c.label)).toEqual(["Date", "Activity", "Hours", "Certificate number", "Cost in pounds"]);
    expect(cols[4]?.type).toBe("number");
  });

  it("falls back to the field key when a custom label is blank", () => {
    const s = makeSettings({ customFields: [{ key: "ref", label: "   ", type: "text" }] });
    expect(exportColumns("custom", s).map((c) => c.label)).toEqual(["Date", "Activity", "Hours", "ref"]);
  });
});

describe("selectEntries and sorting", () => {
  it("leaves out deleted entries, other profiles and other years", () => {
    const keep = makeEntry({ dateCompleted: "2026-01-10" });
    const deleted = makeEntry({ deletedAt: "2026-02-01T00:00:00.000Z" });
    const other = makeEntry({ profile: "istructe" });
    const oldYear = makeEntry({ dateCompleted: "2025-12-31" });
    const all = [keep, deleted, other, oldYear];
    expect(selectEntries(all, "ice", "all").map((e) => e.id).sort()).toEqual([keep.id, oldYear.id].sort());
    expect(selectEntries(all, "ice", 2026).map((e) => e.id)).toEqual([keep.id]);
    expect(selectEntries(all, "ice", 2024)).toEqual([]);
  });

  it("sorts by date ascending, then title, whatever order they arrive in", () => {
    const a = makeEntry({ dateCompleted: "2026-02-01", title: "Beta" });
    const b = makeEntry({ dateCompleted: "2026-02-01", title: "alpha" });
    const c = makeEntry({ dateCompleted: "2026-01-15", title: "Zulu" });
    expect(sortEntries([a, b, c]).map((e) => e.title)).toEqual(["Zulu", "alpha", "Beta"]);
    expect(sortEntries([c, b, a]).map((e) => e.title)).toEqual(["Zulu", "alpha", "Beta"]);
  });

  it("breaks a full tie by creation time and id so the order is stable", () => {
    const a = makeEntry({ title: "Same", createdAt: "2026-03-05T10:00:00.000Z", id: "b" });
    const b = makeEntry({ title: "Same", createdAt: "2026-03-05T09:00:00.000Z", id: "c" });
    const c = makeEntry({ title: "Same", createdAt: "2026-03-05T09:00:00.000Z", id: "a" });
    expect(sortEntries([a, b, c]).map((e) => e.id)).toEqual(["a", "c", "b"]);
  });
});

describe("exportRows for ICE", () => {
  it("builds the details cell as title, provider and link on separate lines", () => {
    const e = makeEntry({ title: "Test title", provider: "Test provider", url: "https://example.test/page" });
    expect(iceDetails(e)).toBe("Test title\nProvider: Test provider\nhttps://example.test/page");
    expect(iceDetails({ title: "Only title", provider: null, url: null })).toBe("Only title");
    expect(iceDetails({ title: "T", provider: "", url: "https://example.test/x" })).toBe("T\nhttps://example.test/x");
  });

  it("defaults Dev. Plan ref to unplanned and keeps a real one", () => {
    const t = exportRows("ice", [makeEntry({ devPlanRef: "" }), makeEntry({ devPlanRef: "  DP-2  ", dateCompleted: "2026-03-05" })], settings);
    const col = t.columns.findIndex((c) => c.key === "devPlanRef");
    expect(cellDisplay(t.rows[0]?.cells[col] ?? { kind: "empty" })).toBe("unplanned");
    expect(cellDisplay(t.rows[1]?.cells[col] ?? { kind: "empty" })).toBe("DP-2");
  });

  it("writes one benefits answer unlabelled and several as labelled lines", () => {
    const one = makeEntry({ benefits: { helped: "It helped me check a design.", future: "", nextYear: "" }, dateCompleted: "2026-03-01" });
    const many = makeEntry({
      benefits: { helped: "Helped.", future: "Use it in design reviews.", nextYear: "" },
      dateCompleted: "2026-03-02",
    });
    const t = exportRows("ice", [one, many], settings);
    const col = t.columns.findIndex((c) => c.key === "benefits");
    expect(cellDisplay(t.rows[0]?.cells[col] ?? { kind: "empty" })).toBe("It helped me check a design.");
    expect(cellDisplay(t.rows[1]?.cells[col] ?? { kind: "empty" })).toBe("How it helped: Helped.\nHow I will use it in future: Use it in design reviews.");
  });

  it("keeps a date range as text so no day is lost, and a single day as a date", () => {
    const range = makeEntry({ dateCompleted: "2026-03-04", dateEnd: "2026-03-06" });
    const single = makeEntry({ dateCompleted: "2026-03-10", dateEnd: "2026-03-10" });
    const t = exportRows("ice", [range, single], settings);
    const col = t.columns.findIndex((c) => c.key === "dates");
    expect(t.rows[0]?.cells[col]).toEqual({ kind: "text", value: "04/03/2026 - 06/03/2026" });
    expect(t.rows[1]?.cells[col]).toEqual({ kind: "date", iso: "2026-03-10" });
  });

  it("rounds hours to two decimals and totals them", () => {
    const t = exportRows("ice", [makeEntry({ hours: 0.1 + 0.2 }), makeEntry({ hours: 1.006 })], settings);
    expect(t.rows.map((r) => r.cells[3])).toEqual([
      { kind: "hours", value: 0.3 },
      { kind: "hours", value: 1.01 },
    ]);
    expect(t.totalHours).toBe(1.31);
    expect(t.count).toBe(2);
  });

  it("gives an empty cell for blank text and a non-finite hours figure", () => {
    const t = exportRows("ice", [makeEntry({ theme: null, hours: Number.NaN })], settings);
    expect(t.rows[0]?.cells[1]).toEqual({ kind: "empty" });
    expect(t.rows[0]?.cells[3]).toEqual({ kind: "empty" });
    expect(t.totalHours).toBe(0);
  });

  it("reads the header block from settings", () => {
    const block = iceHeaderBlock(makeSettings({ name: "A Name", jobRole: "Role", responsibilities: "Duties", sector: "Highways" }));
    expect(block).toEqual([
      { label: "Name", value: "A Name" },
      { label: "Job role and responsibilities", value: "Role\nDuties" },
      { label: "Engineering sector", value: "Highways" },
    ]);
    expect(iceHeaderBlock(makeSettings({ jobRole: "Role only", responsibilities: "" }))[1]?.value).toBe("Role only");
    expect(iceHeaderBlock(makeSettings({ jobRole: "", responsibilities: "Duties only" }))[1]?.value).toBe("Duties only");
    expect(iceHeaderBlock(makeSettings({ name: "", jobRole: "", responsibilities: "", sector: "" })).map((b) => b.value)).toEqual(["", "", ""]);
  });
});

describe("exportRows for IStructE", () => {
  it("maps Y, N and unanswered, and the category", () => {
    const t = exportRows(
      "istructe",
      [
        makeEntry({ profile: "istructe", title: "Test title", category: "Self-directed study", structuralSafety: true, sustainability: false, developmentGained: "Learned a thing." }),
        makeEntry({ profile: "istructe", dateCompleted: "2026-03-05", structuralSafety: null, sustainability: null }),
      ],
      settings,
    );
    expect(t.rows[0]?.cells.map(cellDisplay)).toEqual(["04/03/2026", "Test title", "Self-directed study", "1.50", "Y", "N", "Learned a thing."]);
    expect(t.rows[1]?.cells[4]).toEqual({ kind: "empty" });
    expect(t.rows[1]?.cells[5]).toEqual({ kind: "empty" });
  });
});

describe("exportRows for Custom", () => {
  const s = makeSettings({
    customFields: [
      { key: "text", label: "Notes for me", type: "text" },
      { key: "num", label: "Cost", type: "number" },
      { key: "day", label: "Renewal date", type: "date" },
      { key: "yn", label: "Paid for by employer", type: "yes_no" },
    ],
  });

  it("types each custom value by the field type", () => {
    const e = makeEntry({
      profile: "custom",
      custom: { text: "Free text", num: "12.50", day: "2026-04-01", yn: "yes" },
    });
    const t = exportRows("custom", [e], s);
    expect(t.rows[0]?.cells.slice(3)).toEqual([
      { kind: "text", value: "Free text" },
      { kind: "number", value: 12.5 },
      { kind: "date", iso: "2026-04-01" },
      { kind: "text", value: "Y" },
    ]);
  });

  it("keeps a value that does not fit its type as text instead of dropping it", () => {
    const e = makeEntry({ profile: "custom", custom: { num: "about 12", day: "next spring", yn: "maybe" } });
    const t = exportRows("custom", [e], s);
    expect(t.rows[0]?.cells.slice(4)).toEqual([
      { kind: "text", value: "about 12" },
      { kind: "text", value: "next spring" },
      { kind: "text", value: "maybe" },
    ]);
  });

  it("reads UK dates and No/false for yes-no fields", () => {
    const e = makeEntry({ profile: "custom", custom: { day: "01/04/2026", yn: "FALSE" } });
    const t = exportRows("custom", [e], s);
    expect(t.rows[0]?.cells[5]).toEqual({ kind: "date", iso: "2026-04-01" });
    expect(t.rows[0]?.cells[6]).toEqual({ kind: "text", value: "N" });
  });

  it("does not read inherited properties when a field key is a name like constructor or __proto__", () => {
    const odd = makeSettings({
      customFields: [
        { key: "constructor", label: "First", type: "text" },
        { key: "__proto__", label: "Second", type: "text" },
        { key: "toString", label: "Third", type: "number" },
      ],
    });
    const e = makeEntry({ profile: "custom", custom: {} });
    const t = exportRows("custom", [e], odd);
    expect(t.rows[0]?.cells.slice(3)).toEqual([{ kind: "empty" }, { kind: "empty" }, { kind: "empty" }]);
    const withValue = makeEntry({ profile: "custom", custom: Object.fromEntries([["constructor", "own value"]]) });
    expect(exportRows("custom", [withValue], odd).rows[0]?.cells[3]).toEqual({ kind: "text", value: "own value" });
  });

  it("leaves a missing custom value empty", () => {
    const t = exportRows("custom", [makeEntry({ profile: "custom" })], s);
    expect(t.rows[0]?.cells.slice(3)).toEqual([{ kind: "empty" }, { kind: "empty" }, { kind: "empty" }, { kind: "empty" }]);
  });
});

describe("exportRows text safety", () => {
  it("puts a quote in front of text that could be read as a formula", () => {
    const t = exportRows("istructe", [makeEntry({ profile: "istructe", title: '=HYPERLINK("http://example.test","x")', developmentGained: "+1 point" })], settings);
    expect(t.rows[0]?.cells[1]).toEqual({ kind: "text", value: `'=HYPERLINK("http://example.test","x")` });
    expect(t.rows[0]?.cells[6]).toEqual({ kind: "text", value: "'+1 point" });
  });

  it("removes characters Excel cannot store and uses \\n for line breaks", () => {
    const t = exportRows("istructe", [makeEntry({ profile: "istructe", title: "A\u0000B\u0007C\r\nD\rE" })], settings);
    expect(t.rows[0]?.cells[1]).toEqual({ kind: "text", value: "ABC\nD\nE" });
  });
});
