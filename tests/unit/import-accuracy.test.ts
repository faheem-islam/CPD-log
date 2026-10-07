import { describe, expect, it } from "vitest";
import { buildWorkbook } from "@/lib/export/workbook";
import { matchHeader } from "@/lib/import/columns";
import { parseDelimitedText, parseSpreadsheet } from "@/lib/import/parse";
import { normaliseTranscription, parseTranscribedText } from "@/lib/import/screenshot";
import { parseDateCell, parseDateText, parseHoursCell } from "@/lib/import/values";
import type { CustomFieldDef } from "@/lib/types";
import { makeEntry, makeSettings, NOW } from "./export-test-helpers";
import { issueKeys, makeCtx, messages, utc } from "./import-test-helpers";

const ctx = makeCtx();
const cell = (v: string | number | Date) => ({ v, link: null });
const hours = (v: string | number | Date, role: "hours" | "minutes" | "duration" = "hours", header = "Hours") => parseHoursCell(cell(v), role, header);

// ---------------------------------------------------------------------------------------------------------------

describe("a secondary hours column does not block a row that has hours", () => {
  it("uses Hours when a Time column holds a time range, and says the Time column was not used", () => {
    const row = parseDelimitedText("Date,Activity,Time,Hours\n04/03/2026,Workshop,10:00 - 12:00,2", ctx).rows[0];
    expect(row?.input.hours).toBe(2);
    expect(issueKeys(row)).not.toContain("hours:error");
    expect(row?.input.confidence.hours?.level).toBe("high");
    expect(messages(row, "hours")).toEqual(['The "Time" column ("10:00 - 12:00") could not be read as a time, so the "Hours" column was used instead.']);
    expect(row?.include).toBe(true);
  });

  it("does the same for a Duration column that holds words", () => {
    const row = parseDelimitedText("Date,Title,Duration,Hours\n04/03/2026,A,Half day,3.5", ctx).rows[0];
    expect(row?.input.hours).toBe(3.5);
    expect(row?.include).toBe(true);
    expect(messages(row, "hours")[0]).toMatch(/"Duration" column \("Half day"\)/);
  });

  it("does the same for a Minutes column that cannot be read", () => {
    const row = parseDelimitedText("Date,Title,Hours,Minutes\n04/03/2026,A,1.5,about half an hour", ctx).rows[0];
    expect(row?.input.hours).toBe(1.5);
    expect(row?.include).toBe(true);
    expect(messages(row, "hours")[0]).toMatch(/"Minutes" column/);
  });

  it("still adds Hours and Minutes together, as before", () => {
    const row = parseDelimitedText("Date,Title,Hours,Minutes\n04/03/2026,A,1,30", ctx).rows[0];
    expect(row?.input.hours).toBe(1.5);
    expect(row?.input.confidence.hours?.level).toBe("low");
  });

  it("reads Minutes when Hours is empty, and Duration when both are", () => {
    const m = parseDelimitedText("Date,Title,Hours,Minutes\n04/03/2026,A,,90", ctx).rows[0];
    expect(m?.input.hours).toBe(1.5);
    const d = parseDelimitedText("Date,Title,Hours,Minutes,Duration\n04/03/2026,A,,lots,2 hours", ctx).rows[0];
    expect(d?.input.hours).toBe(2);
    expect(d?.include).toBe(true);
    expect(messages(d, "hours")[0]).toMatch(/"Minutes" column \("lots"\) could not be read as a time, so the "Duration" column was used instead/);
  });

  it("still blocks a row when the Hours column itself cannot be read", () => {
    const row = parseDelimitedText("Date,Title,Hours,Duration\n04/03/2026,A,lots,2 hours", ctx).rows[0];
    expect(row?.include).toBe(false);
    expect(messages(row, "hours")[0]).toBe('Hours "lots" is not a duration we can read. Use a number of hours such as 1.5, or text such as 1h 30m or 90 mins.');
  });

  it("still blocks a row whose only hours column cannot be read", () => {
    const row = parseDelimitedText("Date,Title,Duration\n04/03/2026,A,Half day", ctx).rows[0];
    expect(row?.include).toBe(false);
    expect(issueKeys(row)).toContain("hours:error");
  });
});

describe("custom field labels that look like standard columns", () => {
  const fields: CustomFieldDef[] = [
    { key: "dur", label: "Duration", type: "text" },
    { key: "tm", label: "Time", type: "text" },
    { key: "desc", label: "Description", type: "text" },
    { key: "ev", label: "Event", type: "text" },
    { key: "dt", label: "Date", type: "text" },
    { key: "hrs", label: "Hours", type: "text" },
  ];
  const settings = makeSettings({ customFields: fields });
  const values = { dur: "Half day", tm: "Morning", desc: "A long description", ev: "Annual conference", dt: "Spring term", hrs: "7 incl. travel" };

  it("round-trips through our own custom export", async () => {
    const entries = [makeEntry({ profile: "custom", title: "Round trip", dateCompleted: "2026-03-04", hours: 2.5, custom: values })];
    const buf = await buildWorkbook({ entries, settings, profiles: ["custom"], year: "all", now: NOW });
    const r = await parseSpreadsheet(buf, "export.xlsx", makeCtx({ profile: "custom", settings }));
    const row = r.rows[0];
    expect(row?.input).toMatchObject({ title: "Round trip", dateCompleted: "2026-03-04", hours: 2.5, custom: values });
    expect(row?.include).toBe(true);
    expect(issueKeys(row)).not.toContain("hours:error");
    expect(r.warnings.filter((w) => /No column matched/.test(w))).toEqual([]);
    expect(r.unmapped).toEqual([]);
  });

  it("prefers the user's own label over a loose synonym, but keeps Date, Activity and Hours for the core columns", () => {
    for (const label of ["Duration", "Time", "Description", "Event"]) expect(matchHeader(label, "custom", settings)).toMatch(/^custom\./);
    for (const label of ["Date", "Activity", "Hours"]) expect(matchHeader(label, "custom", settings)).toBe(label === "Activity" ? "title" : label.toLowerCase());
    // Other profiles never read custom labels.
    expect(matchHeader("Duration", "ice", settings)).toBe("duration");
  });

  it("gives a second column with a base name to the custom field of that name", () => {
    const r = parseDelimitedText("Date,Activity,Hours,Date,Hours\n04/03/2026,A,2,Spring term,7 incl. travel", makeCtx({ profile: "custom", settings }));
    expect(r.rows[0]?.input).toMatchObject({ dateCompleted: "2026-03-04", hours: 2, custom: { dt: "Spring term", hrs: "7 incl. travel" } });
  });

  it("does not leave a hand-made file without a title when its only Description column is also a custom field", () => {
    const r = parseDelimitedText("Date,Description,Hours\n04/03/2026,Pile design talk,1", makeCtx({ profile: "custom", settings }));
    expect(r.rows[0]?.input.title).toBe("Pile design talk");
    expect(r.warnings.some((w) => /No title column/.test(w))).toBe(false);
  });

  it("still reads Duration as hours when the user has no field of that name", () => {
    const r = parseDelimitedText("Date,Activity,Duration\n04/03/2026,A,2 hours", makeCtx({ profile: "custom", settings: makeSettings() }));
    expect(r.rows[0]?.input.hours).toBe(2);
  });
});

describe("a clock time in a Time or Duration column", () => {
  it("is not read as ten hours with high confidence", () => {
    const rows = parseDelimitedText("Date,Activity,Time\n04/03/2026,A,10:00\n05/03/2026,B,18:30", ctx).rows;
    const a = rows[0];
    expect(a?.input.hours).toBe(10);
    expect(a?.input.confidence.hours?.level).toBe("low");
    expect(messages(a, "hours")[0]).toBe('Read "10:00" in the "Time" column as 10 hours, not as a time of day. Check this is right.');
    // 18:30 is a time of day, not a length
    const b = rows[1];
    expect(b?.include).toBe(false);
    expect(messages(b, "hours")[0]).toMatch(/^Hours "18:30" is not a duration we can read/);
  });

  it("reads a short length as a guess and names it", () => {
    const r = hours("1:30", "duration", "Duration");
    expect(r).toMatchObject({ kind: "ok", hours: 1.5, guessed: true });
    expect((r as { reading: string }).reading).toBe('Read "1:30" in the "Duration" column as 1 hour 30 minutes, not as a time of day. Check this is right.');
    expect(hours("0:45", "duration", "Time")).toMatchObject({ hours: 0.75, guessed: true });
    expect(hours("1:30:00", "duration", "Time")).toMatchObject({ hours: 1.5, guessed: true });
  });

  it("treats 12:00 and later as a time of day", () => {
    for (const t of ["12:00", "12:30", "18:30", "23:59", "0:00"]) expect(hours(t, "duration", "Time"), t).toMatchObject({ kind: "bad" });
    expect(hours("11:59", "duration", "Time")).toMatchObject({ kind: "ok", guessed: true });
  });

  it("reads an Excel time cell in a Time column as a guess too", () => {
    const r = hours(new Date(Date.UTC(1899, 11, 30, 10, 0)), "duration", "Time");
    expect(r).toMatchObject({ kind: "ok", hours: 10, guessed: true });
    expect(hours(new Date(Date.UTC(1899, 11, 30, 18, 30)), "duration", "Time")).toMatchObject({ kind: "bad" });
  });

  it("is unchanged in an Hours or Minutes column, where 1:30 is a length", () => {
    expect(hours("10:00")).toMatchObject({ hours: 10, guessed: false });
    expect(hours("18:30", "hours")).toMatchObject({ hours: 18.5, guessed: false });
    expect(hours("1:30", "minutes", "Minutes")).toMatchObject({ hours: 1.5, guessed: false });
  });
});

describe("durations written with a multiplier, a range or other figures", () => {
  it.each(["2 x 1h", "3 x 30 mins", "2 sessions x 45 mins", "15 mins x 4", "2h x 3 days", "2-3 hours", "1h x 2", "2 hours per day", "half a day, 3h"])(
    "does not take one pair out of %s",
    (text) => {
      expect(hours(text), text).toMatchObject({ kind: "bad" });
      const row = parseDelimitedText(`Date,Title,Hours\n04/03/2026,A,"${text}"`, ctx).rows[0];
      expect(row?.include, text).toBe(false);
      expect(issueKeys(row)).toContain("hours:error");
    },
  );

  it("still reads whole-string units, with the usual separators", () => {
    expect(hours("1h 30m")).toMatchObject({ hours: 1.5, guessed: false });
    expect(hours("1 hour and 30 minutes")).toMatchObject({ hours: 1.5, guessed: false });
    expect(hours("1 hour, 30 minutes")).toMatchObject({ hours: 1.5, guessed: false });
    expect(hours("2 hrs + 15 mins")).toMatchObject({ hours: 2.25, guessed: false });
    expect(hours("1h30m")).toMatchObject({ hours: 1.5, guessed: false });
    expect(hours("45 mins")).toMatchObject({ hours: 0.75, guessed: false });
  });

  it("accepts ordinary words around one figure, as a guess it names", () => {
    const r = hours("about 2 hours");
    expect(r).toMatchObject({ kind: "ok", hours: 2, guessed: true });
    expect((r as { reading: string }).reading).toBe('Read "about 2 hours" in the "Hours" column as 2 hours. Check this is right.');
    expect(hours("45 mins in total")).toMatchObject({ hours: 0.75, guessed: true });
    const row = parseDelimitedText('Date,Title,Hours\n04/03/2026,A,"about 2 hours"', ctx).rows[0];
    expect(row?.input.confidence.hours?.level).toBe("low");
    expect(messages(row, "hours")[0]).toMatch(/^Read "about 2 hours"/);
  });
});

describe("a date range written without spaces", () => {
  it.each([
    ["04/03/2026-06/03/2026", "2026-03-04", "2026-03-06"],
    ["04.03.2026-06.03.2026", "2026-03-04", "2026-03-06"],
    ["4/3/26-6/3/26", "2026-03-04", "2026-03-06"],
    ["2026-03-04-2026-03-06", "2026-03-04", "2026-03-06"],
    ["04/03/2026 10:00-06/03/2026 12:00", "2026-03-04", "2026-03-06"],
  ])("reads %s as a range", (text, start, end) => {
    expect(parseDateText(text)).toEqual({ kind: "ok", start, end });
  });

  it("does not turn a three-day course of 30 hours into a false 24-hour error", () => {
    const row = parseDelimitedText("Date,Activity,Hours\n04/03/2026-06/03/2026,Course,30", ctx).rows[0];
    expect(row?.input).toMatchObject({ dateCompleted: "2026-03-04", dateEnd: "2026-03-06", hours: 30 });
    expect(issueKeys(row)).not.toContain("hours:error");
    expect(row?.include).toBe(true);
  });

  it("does not take a hyphen inside one date, or a timestamp, for a range", () => {
    for (const t of ["04-03-2026", "2026-03-04", "2026-03-04T10:00:00Z", "2026-03-04T10:00:00-05:00", "04/03/2026 14:00-16:00"]) {
      expect(parseDateText(t), t).toEqual({ kind: "ok", start: "2026-03-04", end: null });
    }
  });

  it("says when two dates were found but it was not a range", () => {
    for (const t of ["04/03/2026 and 05/03/2026", "04/03/2026 06/03/2026", "04/03/2026 (booked 01/02/2026)", "4 March 2026 / 12 March 2026 repeat"]) {
      const r = parseDateText(t);
      expect(r, t).toMatchObject({ kind: "ok", end: null });
      expect(r.kind === "ok" ? r.note : "", t).toMatch(/^Two dates were found in ".*", so only \d\d\/\d\d\/\d{4} was used\. If this is a date range, write it like 04\/03\/2026 - 06\/03\/2026\.$/);
    }
    const row = parseDelimitedText('Date,Title,Hours\n"04/03/2026 and 05/03/2026",A,1', ctx).rows[0];
    expect(issueKeys(row)).toContain("dateEnd:warning");
    expect(row?.input.dateCompleted).toBe("2026-03-04");
  });

  it("does not warn about one date written twice, or one date with a time", () => {
    for (const t of ["04/03/2026 (2026-03-04)", "4 March 2026, 10:00", "Wed 4th Mar 2026"]) {
      const r = parseDateText(t);
      expect(r.kind === "ok" ? r.note : "x", t).toBeUndefined();
    }
    expect(parseDateCell(cell("2026-03-04T10:00:00Z"))).toEqual({ kind: "ok", start: "2026-03-04", end: null });
  });
});

describe("a transcription with pipes in CSV titles", () => {
  const csv = ["Date,Title,Hours", "04/03/2026,Webinar | Part 1,1", "05/03/2026,Webinar | Part 2,1"].join("\n");

  it("is read as CSV, not as a markdown table", () => {
    expect(normaliseTranscription(csv)).toEqual({ text: csv, droppedLines: 0 });
    const r = parseTranscribedText(csv, ctx);
    expect(r.rows.map((x) => x.input.title)).toEqual(["Webinar | Part 1", "Webinar | Part 2"]);
    // the same text imports as a file
    expect(parseDelimitedText(csv, ctx).rows).toHaveLength(2);
  });

  it("still reads real tables, with or without borders and separator rows", () => {
    const bordered = ["| Date | Title | Hours |", "|---|---|---|", "| 04/03/2026 | A | 1 |"].join("\n");
    expect(parseTranscribedText(bordered, ctx).rows).toHaveLength(1);
    const borderless = ["Date | Title | Hours", "04/03/2026 | A | 1", "05/03/2026 | B | 2"].join("\n");
    expect(parseTranscribedText(borderless, ctx).rows.map((x) => x.input.title)).toEqual(["A", "B"]);
    const noSeparator = ["| Date | Title | Hours |", "| 04/03/2026 | A | 1 |", "| 05/03/2026 | B | 2 |"].join("\n");
    expect(parseTranscribedText(noSeparator, ctx).rows).toHaveLength(2);
  });

  it("reads a table with a sentence before it", () => {
    const md = ["Here is the table:", "| Date | Title | Hours |", "|---|---|---|", "| 04/03/2026 | A | 1 |"].join("\n");
    const r = parseTranscribedText(md, ctx);
    expect(r.rows).toHaveLength(1);
    expect(r.warnings).toContain("1 line of the transcription was not part of the table and was left out.");
  });
});

describe("a details cell that is only a link", () => {
  it("keeps the link as the title, and as the link", () => {
    const row = parseDelimitedText("Date,Details of CPD activity,Hours\n04/03/2026,https://www.ice.org.uk/events/webinar-1,1", ctx).rows[0];
    expect(row?.input).toMatchObject({ title: "https://www.ice.org.uk/events/webinar-1", url: "https://www.ice.org.uk/events/webinar-1" });
    expect(issueKeys(row)).not.toContain("title:error");
    expect(row?.include).toBe(true);
  });

  it("still splits a title, a provider and a link, and takes a link line out of a longer title", () => {
    const r = parseDelimitedText('Date,Details,Hours\n04/03/2026,"Test title\nProvider: Test provider\nhttps://example.test/page",1', ctx);
    expect(r.rows[0]?.input).toMatchObject({ title: "Test title", provider: "Test provider", url: "https://example.test/page" });
  });

  it("keeps a second link line as the title when the first is the link", () => {
    const r = parseDelimitedText('Date,Details,Hours\n04/03/2026,"https://example.test/a\nhttps://example.test/b",1', ctx);
    expect(r.rows[0]?.input).toMatchObject({ title: "https://example.test/b", url: "https://example.test/a" });
  });

  it("leaves a row with no title and no link blocked", () => {
    const row = parseDelimitedText("Date,Details,Hours\n04/03/2026,Provider: Someone,1", ctx).rows[0];
    expect(row?.include).toBe(false);
    expect(issueKeys(row)).toContain("title:error");
  });
});

describe("rows that look like a total", () => {
  it("does not skip a real activity whose title becomes sum or total once its brackets are taken off", () => {
    const r = parseDelimitedText("Date,Title,Hours\n04/03/2026,Total (2025),1\n05/03/2026,Sum (webinar),1\n06/03/2026,'@SUM(1),1\n07/03/2026,Total,9", ctx);
    expect(r.rows.map((x) => x.input.title)).toEqual(["Total (2025)", "Sum (webinar)", "@SUM(1)"]);
    expect(r.warnings.filter((w) => /total/.test(w))).toEqual(["Skipped row 5, which looks like a total."]);
  });

  it("still skips the usual total rows, with punctuation around them", () => {
    for (const word of ["Total", "TOTAL:", "Totals", "Grand total", "Sub-total", "Total hours", "  total  ", "(Total)", "Overall Total", "Hours total", "SUM"]) {
      const r = parseDelimitedText(`Date,Title,Hours\n04/03/2026,A,1\n,"${word}",9`, ctx);
      expect(r.rows, word).toHaveLength(1);
    }
  });

  it("skips a total that is in the title or date cell when the first cell is something else", () => {
    const r = parseDelimitedText("Ref,Date,Title,Hours\nA1,04/03/2026,Real,1\nA2,04/03/2026,Total,5\nA3,Total,,6", ctx);
    expect(r.rows.map((x) => x.input.title)).toEqual(["Real"]);
    expect(r.warnings).toContain("Skipped rows 3, 4, which look like a total.");
  });

  it("says row for one and rows for several, with a verb that agrees", () => {
    const one = parseDelimitedText("Date,Title,Hours\n04/03/2026,A,1\n,Total,1", ctx);
    expect(one.warnings).toContain("Skipped row 3, which looks like a total.");
    const two = parseDelimitedText("Date,Title,Hours\n04/03/2026,A,1\n,Total,1\n,Totals,1", ctx);
    expect(two.warnings).toContain("Skipped rows 3, 4, which look like a total.");
    const hdr = parseDelimitedText("Date,Title,Hours\n04/03/2026,A,1\nDate,Title,Hours\nDate,Title,Hours", ctx);
    expect(hdr.warnings).toContain("Skipped rows 3, 4, which repeat the header row.");
    const hdr1 = parseDelimitedText("Date,Title,Hours\n04/03/2026,A,1\nDate,Title,Hours", ctx);
    expect(hdr1.warnings).toContain("Skipped row 3, which repeats the header row.");
  });
});

describe("everything the importer reads can be read by the helpers it uses", () => {
  it("keeps the old behaviour for ordinary files", () => {
    const r = parseDelimitedText("Date,Title,Hours\n04/03/2026,A,1.5\n05/03/2026 - 06/03/2026,B,\"1h 30m\"", ctx);
    expect(r.rows.map((x) => [x.input.dateCompleted, x.input.dateEnd, x.input.hours])).toEqual([
      ["2026-03-04", null, 1.5],
      ["2026-03-05", "2026-03-06", 1.5],
    ]);
    expect(parseDateCell(cell(utc(2026, 3, 4)))).toMatchObject({ start: "2026-03-04" });
  });
});
