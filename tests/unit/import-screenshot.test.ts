import { describe, expect, it } from "vitest";
import { normaliseTranscription, parseTranscribedText } from "@/lib/import/screenshot";
import { SCREENSHOT_WARNING } from "@/lib/import/validate";
import { makeCtx } from "./import-test-helpers";

const ctx = makeCtx();
const GOOD = "Learned how to check a drainage design against the standard.";

describe("normaliseTranscription", () => {
  it("removes pipe borders and the separator row", () => {
    const md = ["| Date | Title | Hours |", "|---|---|---|", "| 04/03/2026 | A | 1 |"].join("\n");
    expect(normaliseTranscription(md)).toEqual({ text: "Date\tTitle\tHours\n04/03/2026\tA\t1", droppedLines: 0 });
  });

  it("handles a table with no outer borders and aligned separators", () => {
    const md = ["Date | Title | Hours", ":--- | :---: | ---:", "04/03/2026 | A | 1"].join("\n");
    expect(normaliseTranscription(md).text).toBe("Date\tTitle\tHours\n04/03/2026\tA\t1");
  });

  it("drops sentences around the table and counts them", () => {
    const md = ["Here is the table:", "", "| Date | Title |", "| --- | --- |", "| 04/03/2026 | A |", "", "Let me know if you need more."].join("\n");
    const r = normaliseTranscription(md);
    expect(r.text).toBe("Date\tTitle\n04/03/2026\tA");
    expect(r.droppedLines).toBe(2);
  });

  it("strips code fences", () => {
    const md = ["```", "| Date | Title |", "|---|---|", "| 04/03/2026 | A |", "```"].join("\n");
    expect(normaliseTranscription(md).text).toBe("Date\tTitle\n04/03/2026\tA");
  });

  it("keeps escaped pipes in a cell and turns <br> into a line break (quoted)", () => {
    const md = ["| Date | Title |", "|---|---|", "| 04/03/2026 | A \\| B<br>second line |"].join("\n");
    expect(normaliseTranscription(md).text).toBe('Date\tTitle\n04/03/2026\t"A | B\nsecond line"');
  });

  it("quotes a cell that holds a double quote", () => {
    const md = ["| Date | Title |", "|---|---|", '| 04/03/2026 | say "hi" |'].join("\n");
    expect(normaliseTranscription(md).text).toBe('Date\tTitle\n04/03/2026\t"say ""hi"""');
  });

  it("leaves tab-separated text alone and counts prose lines it drops", () => {
    const tsv = ["Date\tTitle\tHours", "04/03/2026\tA | B\t1"].join("\n");
    expect(normaliseTranscription(tsv)).toEqual({ text: tsv, droppedLines: 0 });
    const withProse = ["Here you go", "Date\tTitle", "04/03/2026\tA"].join("\n");
    expect(normaliseTranscription(withProse)).toEqual({ text: "Date\tTitle\n04/03/2026\tA", droppedLines: 1 });
  });

  it("leaves CSV text alone", () => {
    expect(normaliseTranscription("Date,Title\n04/03/2026,A")).toEqual({ text: "Date,Title\n04/03/2026,A", droppedLines: 0 });
  });

  it("does not treat a single stray pipe as a table", () => {
    expect(normaliseTranscription("Date,Title\n04/03/2026,A | B")).toEqual({ text: "Date,Title\n04/03/2026,A | B", droppedLines: 0 });
  });
});

describe("parseTranscribedText", () => {
  it("reads a markdown pipe table", () => {
    const md = [
      "| Date | Details of CPD activity | ICE CPD Framework theme | Effective learning time | Key Learning Points |",
      "|------|------------------------|-------------------------|-------------------------|---------------------|",
      `| 04/03/2026 | Test activity | Water | 1.5 | ${GOOD} |`,
      `| 05/03/2026 | Another test activity | Energy | 2 | ${GOOD} |`,
    ].join("\n");
    const r = parseTranscribedText(md, ctx);
    expect(r.fileKind).toBe("screenshot");
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]?.input).toMatchObject({ title: "Test activity", dateCompleted: "2026-03-04", hours: 1.5, theme: "Water", learningPoints: GOOD });
    expect(r.rows[1]?.input).toMatchObject({ title: "Another test activity", dateCompleted: "2026-03-05", hours: 2, theme: "Energy" });
  });

  it("reads tab-separated text", () => {
    const tsv = ["Date\tTitle\tHours", "04/03/2026\tA\t1", "05/03/2026\tB\t2"].join("\n");
    const r = parseTranscribedText(tsv, ctx);
    expect(r.rows.map((x) => x.input.title)).toEqual(["A", "B"]);
  });

  it("reads CSV text as well", () => {
    const r = parseTranscribedText("Date,Title,Hours\n04/03/2026,A,1", ctx);
    expect(r.rows).toHaveLength(1);
  });

  it("gives every row the screenshot warning and marks every field Check", () => {
    const md = ["| Date | Title | Hours |", "|---|---|---|", "| 04/03/2026 | A | 1 |", "| 05/03/2026 | B | 2 |"].join("\n");
    const r = parseTranscribedText(md, ctx);
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) {
      expect(row.issues.filter((i) => i.message === SCREENSHOT_WARNING)).toHaveLength(1);
      expect(row.issues.find((i) => i.message === SCREENSHOT_WARNING)?.severity).toBe("warning");
      expect(row.include).toBe(true);
      for (const c of Object.values(row.input.confidence)) expect(["low", "missing"]).toContain(c.level);
    }
  });

  it("still blocks a row that has an error, and keeps the warning on it", () => {
    const md = ["| Date | Title | Hours |", "|---|---|---|", "| not clear | A | 1 |"].join("\n");
    const r = parseTranscribedText(md, ctx);
    expect(r.rows[0]?.include).toBe(false);
    expect(r.rows[0]?.issues[0]?.severity).toBe("error");
    expect(r.rows[0]?.issues.some((i) => i.message === SCREENSHOT_WARNING)).toBe(true);
  });

  it("flags duplicates against what the user already has", () => {
    const c = makeCtx({ existing: [{ dateCompleted: "2026-03-04", title: "A" }] });
    const r = parseTranscribedText("Date\tTitle\tHours\n04/03/2026\tA\t1", c);
    expect(r.rows[0]?.duplicate).toBe(true);
    expect(r.rows[0]?.include).toBe(false);
  });

  it("says how many lines were left out", () => {
    const md = ["Sure, here is the text from the image:", "| Date | Title | Hours |", "|---|---|---|", "| 04/03/2026 | A | 1 |"].join("\n");
    const r = parseTranscribedText(md, ctx);
    expect(r.warnings).toContain("1 line of the transcription was not part of the table and was left out.");
    const two = parseTranscribedText(["Sure.", ...md.split("\n")].join("\n"), ctx);
    expect(two.warnings).toContain("2 lines of the transcription were not part of the table and were left out.");
  });

  it("reads a table where the model left out the separator row, or used Windows line endings", () => {
    const md = ["| Date | Title | Hours |", "| 04/03/2026 | A | 1 |"].join("\r\n");
    expect(parseTranscribedText(md, ctx).rows).toHaveLength(1);
  });

  it("explains what to do when nothing looks like a table", () => {
    expect(() => parseTranscribedText("I cannot read that image.", ctx)).toThrow(/header row/);
    expect(() => parseTranscribedText("", ctx)).toThrow(/header row/);
  });

  it("leaves a cell that is empty in the table empty", () => {
    const md = ["| Date | Title | Hours | Theme |", "|---|---|---|---|", "| 04/03/2026 | A | 1 | |"].join("\n");
    const r = parseTranscribedText(md, ctx);
    expect(r.rows[0]?.input.theme).toBeNull();
  });
});
