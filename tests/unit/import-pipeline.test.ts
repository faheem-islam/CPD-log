import { describe, expect, it } from "vitest";
import { parseDelimitedText } from "@/lib/import/parse";
import { matchHeader, normHeader } from "@/lib/import/columns";
import { SCREENSHOT_WARNING } from "@/lib/import/validate";
import type { UserSettings } from "@/lib/types";
import { makeSettings } from "./export-test-helpers";
import { issueKeys, makeCtx, messages } from "./import-test-helpers";

const ctx = makeCtx();
const GOOD_POINTS = "Learned how to check a drainage design against the standard.";

function ice(lines: string[], c = ctx) {
  return parseDelimitedText(["Date,Title,Hours,Theme,Key Learning Points", ...lines].join("\n"), c);
}

describe("column matching", () => {
  it("normalises headers: case, punctuation, brackets", () => {
    expect(normHeader("Dev. Plan ref")).toBe("dev plan ref");
    expect(normHeader("Key Benefits/Value added")).toBe("key benefits value added");
    expect(normHeader("Structural safety (Y/N)")).toBe("structural safety");
    expect(normHeader("Hours (h)")).toBe("hours");
    expect(normHeader("(h)")).toBe("h");
    expect(normHeader("  Safety & risk ")).toBe("safety and risk");
  });

  it.each([
    ["Date", "date"], ["Dates", "date"], ["Date completed", "date"], ["Date of activity", "date"], ["DATE", "date"],
    ["Details of CPD activity", "title"], ["Activity", "title"], ["Activity title", "title"], ["Title", "title"], ["Description", "title"], ["Details", "title"],
    ["ICE CPD Framework theme", "theme"], ["Theme", "theme"], ["Objective", "theme"],
    ["Effective learning time", "hours"], ["Hours", "hours"], ["CPD hours", "hours"], ["CPD Hours:", "hours"],
    ["Time", "duration"], ["Duration", "duration"], ["Minutes", "minutes"], ["Mins", "minutes"],
    ["Dev. Plan ref", "devPlanRef"], ["Development plan ref", "devPlanRef"],
    ["Key Learning Points", "learningPoints"], ["Learning points", "learningPoints"], ["Learning outcomes", "learningPoints"], ["What I learned", "learningPoints"],
    ["Key Benefits/Value added", "benefits"], ["Benefits", "benefits"], ["Value added", "benefits"],
    ["Category", "category"], ["Structural safety", "structuralSafety"], ["Structural safety (Y/N)", "structuralSafety"],
    ["Sustainability", "sustainability"], ["Sustainability (Y/N)", "sustainability"], ["Development gained", "developmentGained"],
    ["Provider", "provider"], ["URL", "url"], ["Link", "url"],
  ])("reads %s as %s", (header, field) => {
    expect(matchHeader(header, "ice", makeSettings())).toBe(field);
  });

  it("leaves other headers alone", () => {
    for (const h of ["Name", "Notes", "Job role and responsibilities", "Engineering sector", "Date published", "", "   ", "Hourly rate"]) {
      expect(matchHeader(h, "ice", makeSettings())).toBeNull();
    }
  });

  it("matches the user's own custom field labels for the custom profile", () => {
    const s: UserSettings = makeSettings({ customFields: [{ key: "cert", label: "Certificate number", type: "text" }, { key: "link2", label: "Link", type: "text" }] });
    expect(matchHeader("certificate NUMBER", "custom", s)).toBe("custom.cert");
    expect(matchHeader("Certificate number", "ice", s)).toBeNull();
    // A custom field named like a standard column wins for the custom profile, but never for the core columns.
    expect(matchHeader("Link", "custom", s)).toBe("custom.link2");
    expect(matchHeader("Link", "ice", s)).toBe("url");
    const core: UserSettings = makeSettings({ customFields: [{ key: "d", label: "Date", type: "text" }] });
    expect(matchHeader("Date", "custom", core)).toBe("date");
  });
});

describe("header handling", () => {
  it("needs a date or title column plus one more", () => {
    expect(() => parseDelimitedText("Hours,Theme\n1,Water", ctx)).toThrow(/header row/);
    expect(() => parseDelimitedText("Title\nOnly a title", ctx)).toThrow(/header row/);
    expect(parseDelimitedText("Title,Hours\nA,1", ctx).headerRow).toBe(1);
    // Only one recognised column is not enough.
    expect(() => parseDelimitedText("Date,Notes\n04/03/2026,x", ctx)).toThrow(/header row/);
    expect(parseDelimitedText("Date,Hours\n04/03/2026,1", ctx).headerRow).toBe(1);
  });

  it("explains what to do when there is no header", () => {
    try {
      parseDelimitedText("a,b,c\n1,2,3", ctx);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).toMatch(/first 25 rows/);
      expect((e as Error).message).toMatch(/Date, Title and Hours/);
    }
  });

  it("reports mapped and unmapped columns, and uses only the first column for a field", () => {
    const r = parseDelimitedText("Date,Title,Hours,Notes,Date published,Date\n04/03/2026,A,1,x,2020-01-01,05/03/2026", ctx);
    expect(r.mapped).toEqual({ date: "Date", title: "Title", hours: "Hours" });
    expect(r.unmapped).toEqual(["Notes", "Date published", "Date"]);
    expect(r.rows[0]?.input.dateCompleted).toBe("2026-03-04");
  });

  it("warns when a column is missing", () => {
    const r = parseDelimitedText("Date,Title\n04/03/2026,A", ctx);
    expect(r.warnings.some((w) => /No hours column/.test(w))).toBe(true);
    expect(r.rows[0]?.include).toBe(false);
    const r2 = parseDelimitedText("Title,Hours\nA,1", ctx);
    expect(r2.warnings.some((w) => /No date column/.test(w))).toBe(true);
    const r3 = parseDelimitedText("Date,Hours\n04/03/2026,1", ctx);
    expect(r3.warnings.some((w) => /No title column/.test(w))).toBe(true);
    expect(r3.warnings.some((w) => /no ICE theme/.test(w))).toBe(true);
  });
});

describe("errors block a row", () => {
  it("blocks a missing date", () => {
    const r = ice([`,Missing date,1,Water,${GOOD_POINTS}`]);
    const row = r.rows[0];
    expect(issueKeys(row)).toContain("dateCompleted:error");
    expect(row?.include).toBe(false);
    expect(messages(row, "dateCompleted")[0]).toBe("Add the date. Use day, month, year, for example 04/03/2026.");
  });

  it("blocks an unreadable date and quotes it back", () => {
    const row = ice([`next Tuesday,Bad date,1,Water,${GOOD_POINTS}`]).rows[0];
    expect(row?.include).toBe(false);
    expect(messages(row, "dateCompleted")).toEqual(['Date "next Tuesday" is not a date we can read. Use day, month, year, for example 04/03/2026.']);
    expect(row?.input.dateCompleted).toBe("");
  });

  it("blocks an impossible date", () => {
    expect(ice([`31/02/2026,Bad,1,Water,${GOOD_POINTS}`]).rows[0]?.include).toBe(false);
  });

  it("blocks a missing title", () => {
    const row = ice([`04/03/2026,,1,Water,${GOOD_POINTS}`]).rows[0];
    expect(issueKeys(row)).toContain("title:error");
    expect(row?.include).toBe(false);
    expect(messages(row, "title")[0]).toBe("Add the activity title.");
  });

  it("blocks missing hours", () => {
    const row = ice([`04/03/2026,No hours,,Water,${GOOD_POINTS}`]).rows[0];
    expect(issueKeys(row)).toContain("hours:error");
    expect(row?.include).toBe(false);
    expect(row?.input.hours).toBe(0);
    expect(row?.input.confidence.hours?.level).toBe("missing");
  });

  it("blocks unreadable hours with a message that says how to fix it", () => {
    const row = ice([`04/03/2026,Bad hours,lots,Water,${GOOD_POINTS}`]).rows[0];
    expect(row?.include).toBe(false);
    expect(messages(row, "hours")).toEqual(['Hours "lots" is not a duration we can read. Use a number of hours such as 1.5, or text such as 1h 30m or 90 mins.']);
  });

  it("blocks zero and negative hours", () => {
    for (const h of ["0", "-1", "-0.5"]) {
      const row = ice([`04/03/2026,Bad,${h},Water,${GOOD_POINTS}`]).rows[0];
      expect(issueKeys(row), h).toContain("hours:error");
      expect(row?.include).toBe(false);
      expect(messages(row, "hours")[0]).toMatch(/more than 0/);
    }
  });

  it("blocks more than 24 hours in one day, with a message that asks for review", () => {
    const row = ice([`04/03/2026,Too many,25,Water,${GOOD_POINTS}`]).rows[0];
    expect(row?.include).toBe(false);
    expect(messages(row, "hours")[0]).toMatch(/25 hours is more than 24 hours for one day/);
    expect(ice([`04/03/2026,Exactly 24,24,Water,${GOOD_POINTS}`]).rows[0]?.include).toBe(true);
  });

  it("allows more than 24 hours over a multi-day range, up to 24 a day", () => {
    const ok = parseDelimitedText(`Date,Title,Hours\n04/03/2026 - 06/03/2026,Three days,35`, ctx).rows[0];
    expect(ok?.input.dateEnd).toBe("2026-03-06");
    expect(issueKeys(ok)).not.toContain("hours:error");
    expect(issueKeys(ok)).toContain("hours:warning");
    const bad = parseDelimitedText(`Date,Title,Hours\n04/03/2026 - 06/03/2026,Three days,80`, ctx).rows[0];
    expect(bad?.include).toBe(false);
    expect(messages(bad, "hours")[0]).toMatch(/more than 24 hours a day over 3 days/);
  });

  it("reports every problem on a row, errors first", () => {
    const row = ice([`,,,Cooking,`]).rows[0];
    const keys = issueKeys(row);
    expect(keys.slice(0, 3).sort()).toEqual(["dateCompleted:error", "hours:error", "title:error"]);
    const firstWarning = keys.findIndex((k) => k.endsWith(":warning"));
    expect(keys.slice(0, firstWarning).every((k) => k.endsWith(":error"))).toBe(true);
    expect(row?.include).toBe(false);
  });

  it("gives a row with an error a complete EntryInput anyway", () => {
    const input = ice([`,,,Cooking,`]).rows[0]?.input;
    expect(input).toBeDefined();
    expect(input).toMatchObject({ profile: "ice", title: "", dateCompleted: "", hours: 0, sourceType: "other", theme: null, devPlanRef: "unplanned", notes: "", aiAssisted: false, custom: {} });
  });
});

describe("warnings do not block a row", () => {
  it("warns about a theme that is not in the list, keeps it blank, and says so", () => {
    const row = ice([`04/03/2026,A,1,Cooking,${GOOD_POINTS}`]).rows[0];
    expect(row?.input.theme).toBeNull();
    expect(messages(row, "theme")).toEqual(['The theme "Cooking" is not one of the ICE CPD Framework themes, so it was left blank. Choose one on the review screen.']);
    expect(row?.include).toBe(true);
    expect(row?.input.confidence.theme).toEqual({ level: "missing", evidence: 'Not matched: "Cooking"' });
  });

  it('matches "Safety & risk" to "Safety and risk management" and marks it Check', () => {
    const row = ice([`04/03/2026,A,1,Safety & risk,${GOOD_POINTS}`]).rows[0];
    expect(row?.input.theme).toBe("Safety and risk management");
    expect(issueKeys(row)).not.toContain("theme:warning");
    expect(row?.input.confidence.theme?.level).toBe("low");
    expect(row?.input.confidence.theme?.evidence).toBe('From your file ("Safety & risk"), matched to "Safety and risk management"');
  });

  it("marks an exact theme High", () => {
    const row = ice([`04/03/2026,A,1,water,${GOOD_POINTS}`]).rows[0];
    expect(row?.input.theme).toBe("Water");
    expect(row?.input.confidence.theme).toEqual({ level: "high", evidence: "From your file" });
  });

  it("does not guess between two themes", () => {
    const row = ice([`04/03/2026,A,1,Transport and energy,${GOOD_POINTS}`]).rows[0];
    expect(row?.input.theme).toBeNull();
    expect(issueKeys(row)).toContain("theme:warning");
  });

  it("warns about missing learning points", () => {
    const row = ice(["04/03/2026,A,1,Water,"]).rows[0];
    expect(messages(row, "learningPoints")[0]).toMatch(/^No learning points/);
    expect(row?.include).toBe(true);
    expect(row?.input.confidence.learningPoints?.level).toBe("missing");
  });

  it("warns about missing learning points when the file has no such column", () => {
    const row = parseDelimitedText("Date,Title,Hours\n04/03/2026,A,1", ctx).rows[0];
    expect(issueKeys(row)).toContain("learningPoints:warning");
  });

  it("warns about vague learning points and benefits", () => {
    const row = parseDelimitedText("Date,Title,Hours,Key Learning Points,Benefits\n04/03/2026,A,1,Various things,General learning", ctx).rows[0];
    expect(issueKeys(row)).toEqual(expect.arrayContaining(["learningPoints:warning", "benefits:warning"]));
    expect(messages(row, "learningPoints")[0]).toMatch(/quite general/);
    expect(row?.include).toBe(true);
  });

  it("does not call a clear reflection vague", () => {
    const row = ice([`04/03/2026,A,1,Water,${GOOD_POINTS}`]).rows[0];
    expect(issueKeys(row)).toEqual([]);
  });

  it("warns about more than 30 hours, using a date range so it is not an error", () => {
    const row = parseDelimitedText("Date,Title,Hours\n01/03/2026 - 05/03/2026,Long course,35", ctx).rows[0];
    expect(row?.include).toBe(true);
    expect(messages(row, "hours")[0]).toBe("More than 30 hours for one activity is unusual. Check the figure, or split it into separate entries.");
  });

  it("warns about a date in the future", () => {
    const row = ice([`01/01/2027,Future,1,Water,${GOOD_POINTS}`]).rows[0];
    expect(messages(row, "dateCompleted")).toEqual(["This date is in the future. Log CPD after you have done it."]);
    expect(row?.include).toBe(true);
    expect(issueKeys(ice([`07/10/2026,Today,1,Water,${GOOD_POINTS}`]).rows[0])).toEqual([]);
  });

  it("warns about a link it cannot use", () => {
    const row = parseDelimitedText("Date,Title,Hours,Link\n04/03/2026,A,1,see attached", ctx).rows[0];
    expect(row?.input.url).toBeNull();
    expect(messages(row, "url")[0]).toMatch(/does not start with http/);
  });

  it("warns when the end of a range is before its start", () => {
    const row = parseDelimitedText("Date,Title,Hours\n06/03/2026 - 04/03/2026,A,1", ctx).rows[0];
    expect(row?.input.dateEnd).toBeNull();
    expect(issueKeys(row)).toContain("dateEnd:warning");
  });
});

describe("duplicates", () => {
  it("flags a row that matches an existing entry, unticks it and warns", () => {
    const c = makeCtx({ existing: [{ dateCompleted: "2026-03-04", title: "TEST: Activity!" }] });
    const r = ice([`04/03/2026,test activity,1,Water,${GOOD_POINTS}`, `05/03/2026,test activity,1,Water,${GOOD_POINTS}`], c);
    expect(r.rows[0]?.duplicate).toBe(true);
    expect(r.rows[0]?.include).toBe(false);
    expect(messages(r.rows[0], "duplicate")[0]).toMatch(/you already have an entry with the same date and title/);
    expect(r.rows[1]?.duplicate).toBe(false);
    expect(r.rows[1]?.include).toBe(true);
  });

  it("flags later rows that repeat an earlier row in the same file, not the first", () => {
    const r = ice([
      `04/03/2026,Same,1,Water,${GOOD_POINTS}`,
      `04/03/2026,  same ,2,Energy,${GOOD_POINTS}`,
      `04/03/2026,Same,3,Water,${GOOD_POINTS}`,
      `05/03/2026,Same,1,Water,${GOOD_POINTS}`,
    ]);
    expect(r.rows.map((x) => x.duplicate)).toEqual([false, true, true, false]);
    expect(r.rows.map((x) => x.include)).toEqual([true, false, false, true]);
    expect(messages(r.rows[1], "duplicate")[0]).toMatch(/duplicate of row 2 in this file/);
    expect(messages(r.rows[2], "duplicate")[0]).toMatch(/duplicate of row 2 in this file/);
  });

  it("does not call a different date or title a duplicate", () => {
    const c = makeCtx({ existing: [{ dateCompleted: "2026-03-04", title: "Other" }] });
    const r = ice([`04/03/2026,Mine,1,Water,${GOOD_POINTS}`, `05/03/2026,Other,1,Water,${GOOD_POINTS}`], c);
    expect(r.rows.every((x) => !x.duplicate)).toBe(true);
  });

  it("does not look for duplicates in rows that have no date or title", () => {
    const r = ice([`,Same,1,Water,${GOOD_POINTS}`, `,Same,1,Water,${GOOD_POINTS}`]);
    expect(r.rows.every((x) => !x.duplicate)).toBe(true);
  });

  it("still lets an error row count as the first of a pair", () => {
    const r = ice([`04/03/2026,Same,0,Water,${GOOD_POINTS}`, `04/03/2026,Same,1,Water,${GOOD_POINTS}`]);
    expect(r.rows[0]?.include).toBe(false);
    expect(r.rows[1]?.duplicate).toBe(true);
  });
});

describe("what a clean row looks like", () => {
  it("is complete, marked from your file, and ticked", () => {
    const r = parseDelimitedText(
      [
        "Date,Details of CPD activity,ICE CPD Framework theme,Effective learning time,Dev. Plan ref,Key Learning Points,Key Benefits/Value added,Provider,URL",
        `04/03/2026,Test activity,Energy,1.5,DP-3,${GOOD_POINTS},"How it helped: It helped.\nHow I will use it in future: I will use it.",Test provider,https://example.test/x`,
      ].join("\n"),
      ctx,
    );
    const row = r.rows[0];
    expect(row?.include).toBe(true);
    expect(row?.duplicate).toBe(false);
    expect(row?.issues).toEqual([]);
    expect(row?.input).toEqual({
      profile: "ice",
      title: "Test activity",
      url: "https://example.test/x",
      provider: "Test provider",
      sourceType: "other",
      publishedAt: null,
      dateCompleted: "2026-03-04",
      dateEnd: null,
      detectedDurationMinutes: null,
      hours: 1.5,
      hoursConfirmed: true,
      theme: "Energy",
      category: null,
      structuralSafety: null,
      sustainability: null,
      devPlanRef: "DP-3",
      learningPoints: GOOD_POINTS,
      benefits: { helped: "It helped.", future: "I will use it.", nextYear: "" },
      developmentGained: "",
      custom: {},
      notes: "",
      aiAssisted: false,
      confidence: expect.any(Object),
    });
    for (const key of ["title", "dateCompleted", "hours", "theme", "learningPoints", "benefits", "provider", "url", "devPlanRef"]) {
      expect(row?.input.confidence[key], key).toEqual({ level: "high", evidence: "From your file" });
    }
  });

  it("splits ICE's details cell back into title, provider and link", () => {
    const r = parseDelimitedText('Date,Details of CPD activity,Hours\n04/03/2026,"Test title\nProvider: Test provider\nhttps://example.test/page",1', ctx);
    expect(r.rows[0]?.input).toMatchObject({ title: "Test title", provider: "Test provider", url: "https://example.test/page" });
  });

  it("joins extra lines of a details cell into the title instead of dropping them", () => {
    const r = parseDelimitedText('Date,Details,Hours\n04/03/2026,"Webinar on drainage\nSecond line of detail",1', ctx);
    expect(r.rows[0]?.input.title).toBe("Webinar on drainage - Second line of detail");
  });

  it("takes a quote off that an earlier export put in front of a formula character", () => {
    const r = parseDelimitedText("Date,Title,Hours\n04/03/2026,'=Test title,1", ctx);
    expect(r.rows[0]?.input.title).toBe("=Test title");
  });

  it("defaults the dev plan ref to unplanned", () => {
    expect(ice([`04/03/2026,A,1,Water,${GOOD_POINTS}`]).rows[0]?.input.devPlanRef).toBe("unplanned");
  });

  it("keeps row numbers as they are in the file, skipping blank rows", () => {
    const r = parseDelimitedText("Date,Title,Hours\n\n04/03/2026,A,1\n\n\n05/03/2026,B,1", ctx);
    expect(r.rows.map((x) => x.n)).toEqual([3, 6]);
  });

  it("is the same for any text that a human could have typed with different spacing", () => {
    const a = parseDelimitedText("Date,Title,Hours\n04/03/2026,A,1", ctx).rows[0]?.input;
    const b = parseDelimitedText("  Date , Title ,  HOURS \n 04/03/2026 , A , 1 ", ctx).rows[0]?.input;
    expect(b).toEqual(a);
  });
});

describe("IStructE profile", () => {
  const c = makeCtx({ profile: "istructe" });
  const head = "Date,Activity title,Category,Hours,Structural safety (Y/N),Sustainability (Y/N),Development gained";

  it("reads category, Y/N and development gained", () => {
    const r = parseDelimitedText(`${head}\n04/03/2026,A,Self-directed study,2,Y,N,Learned how to check a connection detail.`, c);
    expect(r.rows[0]?.input).toMatchObject({
      profile: "istructe",
      category: "Self-directed study",
      structuralSafety: true,
      sustainability: false,
      developmentGained: "Learned how to check a connection detail.",
      theme: null,
    });
    expect(r.rows[0]?.issues).toEqual([]);
  });

  it("matches a category loosely and warns when it cannot", () => {
    const r = parseDelimitedText(`${head}\n04/03/2026,A,Courses,2,,,Learned how to check a connection detail.\n05/03/2026,B,Gardening,2,,,Learned how to check a connection detail.`, c);
    expect(r.rows[0]?.input.category).toBe("Courses, events and seminars");
    expect(r.rows[0]?.input.confidence.category?.level).toBe("low");
    expect(r.rows[1]?.input.category).toBeNull();
    expect(messages(r.rows[1], "category")[0]).toMatch(/not one of the IStructE categories/);
    expect(r.rows[1]?.include).toBe(true);
  });

  it("leaves unanswered Y/N blank and warns about text it does not understand", () => {
    const r = parseDelimitedText(`${head}\n04/03/2026,A,Work-based learning,2,-,perhaps,Learned how to check a connection detail.`, c);
    expect(r.rows[0]?.input.structuralSafety).toBeNull();
    expect(r.rows[0]?.input.sustainability).toBeNull();
    expect(messages(r.rows[0], "sustainability")[0]).toMatch(/was not understood/);
  });

  it("warns about missing and vague development gained", () => {
    const r = parseDelimitedText(`${head}\n04/03/2026,A,Work-based learning,2,,,\n05/03/2026,B,Work-based learning,2,,,Various things`, c);
    expect(issueKeys(r.rows[0])).toContain("developmentGained:warning");
    expect(messages(r.rows[1], "developmentGained")[0]).toMatch(/quite general/);
  });

  it("leaves out the ICE theme column and says so", () => {
    const r = parseDelimitedText("Date,Title,Hours,Theme\n04/03/2026,A,1,Water", c);
    expect(r.rows[0]?.input.theme).toBeNull();
    expect(r.unmapped).toEqual(["Theme"]);
    expect(r.warnings.some((w) => /different profile than IStructE: Theme/.test(w))).toBe(true);
  });

  it("does not warn about an ICE theme list for an IStructE row", () => {
    const r = parseDelimitedText(`${head}\n04/03/2026,A,Work-based learning,2,,,Learned how to check a connection detail.`, c);
    expect(issueKeys(r.rows[0])).toEqual([]);
  });
});

describe("Custom profile", () => {
  const s = makeSettings({
    customFields: [
      { key: "cert", label: "Certificate number", type: "text" },
      { key: "cost", label: "Cost", type: "number" },
      { key: "renew", label: "Renewal date", type: "date" },
      { key: "paid", label: "Paid by employer", type: "yes_no" },
    ],
  });
  const c = makeCtx({ profile: "custom", settings: s });

  it("reads Date, Activity, Hours and the user's own columns by their labels", () => {
    const r = parseDelimitedText(
      "Date,Activity,Hours,Certificate number,Cost,Renewal date,Paid by employer\n04/03/2026,A,2,C-1,25.5,01/04/2027,yes",
      c,
    );
    expect(r.rows[0]?.input).toMatchObject({
      profile: "custom",
      title: "A",
      hours: 2,
      custom: { cert: "C-1", cost: "25.5", renew: "2027-04-01", paid: "yes" },
    });
    expect(r.rows[0]?.input.confidence["custom.cert"]?.level).toBe("high");
    expect(r.rows[0]?.issues).toEqual([]);
    expect(r.mapped["custom.cert"]).toBe("Certificate number");
  });

  it("warns, without blocking, about a custom date or yes-no it cannot read", () => {
    const r = parseDelimitedText("Date,Activity,Hours,Renewal date,Paid by employer\n04/03/2026,A,2,soon,maybe", c);
    expect(r.rows[0]?.input.custom).toEqual({ renew: "soon" });
    expect(issueKeys(r.rows[0])).toEqual(expect.arrayContaining(["custom.renew:warning", "custom.paid:warning"]));
    expect(r.rows[0]?.include).toBe(true);
  });

  it("copes with custom field keys that are special names in JavaScript", () => {
    const odd = makeCtx({
      profile: "custom",
      settings: makeSettings({ customFields: [{ key: "__proto__", label: "Proto", type: "text" }, { key: "constructor", label: "Ctor", type: "text" }] }),
    });
    const r = parseDelimitedText("Date,Activity,Hours,Proto,Ctor\n04/03/2026,A,1,one,two", odd);
    const custom = r.rows[0]?.input.custom ?? {};
    expect(Object.getPrototypeOf(custom)).toBe(Object.prototype);
    expect(Object.keys(custom).sort()).toEqual(["__proto__", "constructor"]);
    expect(JSON.parse(JSON.stringify(custom))).toEqual(JSON.parse('{"__proto__":"one","constructor":"two"}'));
  });

  it("says which custom fields had no matching column", () => {
    const r = parseDelimitedText("Date,Activity,Hours,Cost\n04/03/2026,A,2,10", c);
    expect(r.warnings.some((w) => /Certificate number, Renewal date, Paid by employer/.test(w))).toBe(true);
    expect(r.rows[0]?.input.custom).toEqual({ cost: "10" });
  });

  it("has no learning-point or theme warnings", () => {
    const r = parseDelimitedText("Date,Activity,Hours\n04/03/2026,A,2", makeCtx({ profile: "custom" }));
    expect(r.rows[0]?.issues).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("screenshots", () => {
  it("gives every row the screenshot warning, marks fields Check, and still blocks real errors", () => {
    const r = parseDelimitedText(`Date,Title,Hours,Theme\n04/03/2026,A,1,Water\n,B,1,Water`, ctx, { fromScreenshot: true });
    expect(r.fileKind).toBe("screenshot");
    for (const row of r.rows) {
      expect(row.issues.some((i) => i.severity === "warning" && i.message === SCREENSHOT_WARNING)).toBe(true);
    }
    expect(r.rows[0]?.include).toBe(true);
    expect(r.rows[1]?.include).toBe(false);
    expect(r.rows[0]?.input.confidence.title).toEqual({ level: "low", evidence: "Read from a screenshot" });
    expect(r.rows[0]?.input.confidence.hours?.level).toBe("low");
    expect(r.rows[1]?.input.confidence.dateCompleted?.level).toBe("missing");
  });

  it("does not add the warning for ordinary text", () => {
    const r = parseDelimitedText("Date,Title,Hours\n04/03/2026,A,1", ctx);
    expect(r.rows[0]?.issues.some((i) => i.message === SCREENSHOT_WARNING)).toBe(false);
    expect(r.fileKind).toBe("text");
  });
});
