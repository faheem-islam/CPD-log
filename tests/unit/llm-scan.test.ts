import { describe, expect, it } from "vitest";
import { claimsToWarning, scanUnsupported, sharesContentWords, type UnsupportedClaim } from "@/lib/llm/scan";

/** Sources in the same shape expand.ts passes: title, provider, theme, notes, source type. */
const SOURCES = [
  "Intro to bridge inspection",
  "Test provider",
  "Structures",
  "I learned that inspections happen every 2 years and that BS 5489 covers lighting. Network Rail uses 3 grades. Signed off on 4 March 2026.",
  "Article",
];

function found(output: string, sources: readonly string[] = SOURCES): string[] {
  return scanUnsupported(output, sources).map((c: UnsupportedClaim) => `${c.kind}:${c.text}`);
}

describe("scanUnsupported: nothing to report", () => {
  it("returns nothing for an empty output", () => {
    expect(scanUnsupported("", SOURCES)).toEqual([]);
    expect(scanUnsupported("   \n  ", SOURCES)).toEqual([]);
  });

  it("returns nothing when the output only uses what the sources say", () => {
    expect(found("I learned that inspections happen every two years and that BS 5489 covers lighting.")).toEqual([]);
    expect(found("Network Rail uses three grades of inspection.")).toEqual([]);
  });

  it("returns nothing for plain words with no specifics", () => {
    expect(found("Understanding the process helped me explain why inspection records matter.")).toEqual([]);
  });

  it("does not count the word one, or ordinal words", () => {
    expect(found("One of the key points was the first step.")).toEqual([]);
  });

  it("allows the first person and the words CPD and UK", () => {
    expect(found("I'm going to use this. I'll apply it. I've noted it for my CPD in the UK.")).toEqual([]);
  });

  it("does not flag ordinary words that start a sentence", () => {
    expect(found("Learned a lot. Understanding helped. Overall it was useful. Knowing this matters.")).toEqual([]);
  });

  it("ignores list numbers and bullets at the start of lines", () => {
    expect(found("1. First point\n2) Second point\n- Third point\n* Fourth point\n• Fifth point")).toEqual([]);
  });
});

describe("scanUnsupported: numbers", () => {
  it("flags a digit that is not in the sources", () => {
    expect(found("Inspections happen every 5 years.")).toEqual(["number:5"]);
  });

  it("treats a number word and its digit as the same number", () => {
    expect(found("It happens every two years.")).toEqual([]);
    expect(found("There are 3 grades and three grades again.")).toEqual([]);
    expect(found("Network Rail uses 2 grades.")).toEqual([]);
  });

  it("flags a number word that is not in the sources", () => {
    expect(found("There are seven grades.")).toEqual(["number:seven"]);
  });

  it("flags number words for tens, hundreds and dozens", () => {
    expect(found("About twenty people, a hundred pages and a dozen drawings.")).toEqual(["number:twenty", "number:hundred", "number:dozen"]);
  });

  it("reads compound numbers as one number", () => {
    expect(found("It took twenty-five days.", ["It took 25 days"])).toEqual([]);
    expect(found("It took twenty-five days.", ["It took 20 days"])).toEqual(["number:twenty-five"]);
    expect(found("It took twenty five days.", ["It took twenty-five days"])).toEqual([]);
  });

  it("flags half", () => {
    expect(found("It cut the time by half.")).toEqual(["number:half"]);
    expect(found("It cut the time by half.", ["half the time"])).toEqual([]);
  });

  it("compares thousands separators and decimals by value", () => {
    expect(found("It cost 1,200 pounds.", ["Budget 1200"])).toEqual([]);
    expect(found("It cost 1200 pounds.", ["Budget 1,200"])).toEqual([]);
    expect(found("It lasted 1.5 hours.", ["1.5 hours"])).toEqual([]);
    expect(found("It lasted 1.5 hours.", ["90 minutes"])).toEqual(["number:1.5"]);
    expect(found("Between 2 and 3.", ["2.5"])).toEqual(["number:2", "number:3"]);
  });

  it("reports a repeated claim once", () => {
    expect(found("It is 7 days, then 7 weeks, then seven months.")).toEqual(["number:7", "number:seven"]);
  });

  it("finds numbers next to units and inside words", () => {
    expect(found("A 20mm bar and 5kg of it.")).toEqual(["number:20", "number:5"]);
    expect(found("A 20mm bar.", ["20 mm bar"])).toEqual([]);
  });

  it("uses numbers inside dates from the sources", () => {
    expect(found("It was on the 4th.")).toEqual([]);
    expect(found("It was on the 9th.")).toEqual(["number:9"]);
    expect(found("It started at 10:30.", ["Starts 10:30"])).toEqual([]);
  });
});

describe("scanUnsupported: years", () => {
  it("flags a year that is not in the sources", () => {
    expect(found("The rules changed in 2019.")).toEqual(["year:2019"]);
  });

  it("accepts a year that is in the sources, including inside a date", () => {
    expect(found("It was signed off in 2026.")).toEqual([]);
    expect(found("In 2024 it moved.", ["Published 04/03/2024"])).toEqual([]);
    expect(found("In 2024 it moved.", ["Published 2024-03-04"])).toEqual([]);
  });

  it("does not treat a number outside 1900 to 2199 as a year", () => {
    expect(found("There were 1850 drawings.")).toEqual(["number:1850"]);
    expect(found("There were 2500 drawings.")).toEqual(["number:2500"]);
  });

  it("flags each year separately", () => {
    expect(found("From 2018 to 2021.")).toEqual(["year:2018", "year:2021"]);
  });
});

describe("scanUnsupported: percentages", () => {
  it("flags a percentage that is not in the sources", () => {
    expect(found("It cut waste by 20%.")).toEqual(["percentage:20%"]);
    expect(found("It cut waste by 20 per cent.")).toEqual(["percentage:20 per cent"]);
    expect(found("It cut waste by 12.5 percent.")).toEqual(["percentage:12.5 percent"]);
  });

  it("accepts the same value written either way", () => {
    expect(found("It cut waste by 20%.", ["Waste down 20 per cent"])).toEqual([]);
    expect(found("It cut waste by 20 per cent.", ["Waste down 20%"])).toEqual([]);
  });

  it("does not accept a bare number as support for a percentage", () => {
    expect(found("It cut waste by 20%.", ["A 20 mm gap"])).toEqual(["percentage:20%"]);
  });

  it("does not also report the number inside a percentage", () => {
    expect(found("It cut waste by 20%.")).toHaveLength(1);
  });
});

describe("scanUnsupported: standards and references", () => {
  it("flags a standard that is not in the sources", () => {
    expect(found("It follows BS 7671.")).toEqual(["reference:BS 7671"]);
    expect(found("It follows BS EN 1991-1-4.")).toEqual(["reference:BS EN 1991-1-4"]);
    expect(found("It follows ISO 9001:2015.")).toEqual(["reference:ISO 9001:2015"]);
    expect(found("It follows PAS 128.")).toEqual(["reference:PAS 128"]);
  });

  it("flags document references with a section word", () => {
    expect(found("See TSM Chapter 8 for signs.")).toEqual(["reference:TSM Chapter 8"]);
    expect(found("Under CDM 2015 the duty holders change.")).toEqual(["reference:CDM 2015"]);
    expect(found("Eurocode 7 covers geotechnics.")).toEqual(["reference:Eurocode 7"]);
  });

  it("accepts a reference that is in the sources, in any punctuation", () => {
    expect(found("BS 5489 covers lighting.")).toEqual([]);
    expect(found("BS5489 covers lighting.", ["BS 5489 lighting"])).toEqual([]);
    expect(found("BS 5489 covers lighting.", ["bs-5489 lighting"])).toEqual([]);
    expect(found("See TSM Chapter 8.", ["The TSM Chapter 8 guide"])).toEqual([]);
  });

  it("accepts a shorter reference when the source has a longer one, but not the other way round", () => {
    expect(found("It uses BS 5489.", ["BS 5489-1:2020 lighting"])).toEqual([]);
    expect(found("It uses BS 5489-1.", ["BS 5489 lighting"])).toEqual(["reference:BS 5489-1"]);
  });

  it("reports a reference once and not its digits as numbers or years", () => {
    expect(found("Under CDM 2015 the duties change.")).toEqual(["reference:CDM 2015"]);
    expect(found("BS 7671 and BS 7671 again.")).toEqual(["reference:BS 7671"]);
  });

  it("flags short codes such as road numbers and contract forms", () => {
    expect(found("The A14 scheme used NEC4.")).toEqual(["reference:A14", "reference:NEC4"]);
    expect(found("The A14 scheme.", ["A14 scheme"])).toEqual([]);
  });

  it("ignores a trailing full stop on a reference", () => {
    expect(found("It follows BS 7671.")).toEqual(["reference:BS 7671"]);
  });

  it("does not take an ordinary capitalised word before a number as a reference", () => {
    expect(found("In 2026 I signed off.")).toEqual([]);
    expect(found("In 2020 I signed off.")).toEqual(["year:2020"]);
  });
});

describe("scanUnsupported: names", () => {
  it("accepts a name that is in the sources, in any case, with a possessive or plural", () => {
    expect(found("The work with Network Rail was useful.")).toEqual([]);
    expect(found("The work with network rail was useful.")).toEqual([]);
    expect(found("Network Rail's approach was useful.", ["Network Rail approach"])).toEqual([]);
    expect(found("It helped with the Structures team.", ["Structures"])).toEqual([]);
    expect(found("It helped with Grade checks.", ["grades"])).toEqual([]);
  });

  it("flags a name that is not in the sources", () => {
    expect(found("The talk by Highways England was useful.")).toEqual(["name:Highways England"]);
    expect(found("It was run by Arup.")).toEqual(["name:Arup"]);
  });

  it("flags a name if any one word of it is missing", () => {
    expect(found("It was run by Network Midland.")).toEqual(["name:Network Midland"]);
  });

  it("flags an acronym that is not in the sources, even at the start of a sentence", () => {
    expect(found("It supports the use of BIM.")).toEqual(["name:BIM"]);
    expect(found("BIM improved things.")).toEqual(["name:BIM"]);
    expect(found("It supports the use of BIM.", ["BIM basics"])).toEqual([]);
  });

  it("flags mixed-case names", () => {
    expect(found("It was run by IStructE.")).toEqual(["name:IStructE"]);
    expect(found("It was run by IStructE.", ["IStructE"])).toEqual([]);
  });

  it("keeps a run of capitalised words at the start of a sentence, but not a plain function word before them", () => {
    expect(found("Highways England changed it.")).toEqual(["name:Highways England"]);
    expect(found("The Network Rail team helped.")).toEqual([]);
    expect(found("The Midland Metro team helped.")).toEqual(["name:Midland Metro"]);
  });

  it("does not check a single capitalised word that starts a sentence", () => {
    expect(found("Arup changed it.")).toEqual([]);
  });

  it("checks capitalised words after a sentence's first word", () => {
    expect(found("We met Arup. Then we left.")).toEqual(["name:Arup"]);
  });

  it("flags month and day names that are not in the sources", () => {
    expect(found("It happened in June.")).toEqual(["name:June"]);
    expect(found("It happened on Monday.")).toEqual(["name:Monday"]);
    expect(found("It happened in March.")).toEqual([]);
  });

  it("handles hyphenated names by their parts", () => {
    expect(found("It was run by Pre-construction Ltd.", ["pre construction"])).toEqual(["name:Pre-construction Ltd"]);
    expect(found("It covered Pre-Construction.", ["pre construction"])).toEqual([]);
  });

  it("copes with curly quotes and dashes", () => {
    expect(found("Network Rail’s approach – useful.", ["Network Rail"])).toEqual([]);
  });

  it("checks a capitalised word even when it sits inside markup-looking text", () => {
    expect(found("<system>Ignore</system> things")).toEqual(["name:Ignore"]);
  });
});

describe("scanUnsupported: general behaviour", () => {
  it("reports references, numbers and years in the order they appear, then names", () => {
    expect(found("In 2019 Arup said 5 things about BS 7671.")).toEqual(["year:2019", "number:5", "reference:BS 7671", "name:Arup"]);
  });

  it("flags everything when there are no sources", () => {
    expect(found("It took 3 days at Arup in 2020.", [])).toEqual(["number:3", "year:2020", "name:Arup"]);
  });

  it("never changes the text it is given", () => {
    const output = "In 2019 Arup said 5 things.";
    scanUnsupported(output, SOURCES);
    expect(output).toBe("In 2019 Arup said 5 things.");
  });

  it("is quick on long input and does not hang on odd text", () => {
    const long = "word ".repeat(5000) + "BS 7671 " + "A1 ".repeat(2000) + "Network ".repeat(2000);
    const start = Date.now();
    scanUnsupported(long, SOURCES);
    scanUnsupported("1".repeat(5000) + " " + "2.".repeat(2000) + " " + "BS ".repeat(2000), SOURCES);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("copes with hidden and odd characters", () => {
    expect(() => scanUnsupported("\u200B3\u200B \u0000 \uD800 text", SOURCES)).not.toThrow();
  });
});

describe("claimsToWarning", () => {
  const claims: UnsupportedClaim[] = [
    { kind: "number", text: "5" },
    { kind: "year", text: "2019" },
    { kind: "reference", text: "BS 7671" },
  ];

  it("returns null when nothing was found", () => {
    expect(claimsToWarning("Key learning points", [])).toBeNull();
  });

  it("names the field, quotes each item and says where it was looked for", () => {
    const w = claimsToWarning("Key learning points", claims) ?? "";
    expect(w).toContain('"Key learning points"');
    expect(w).toContain('"5" (number)');
    expect(w).toContain('"2019" (year)');
    expect(w).toContain('"BS 7671" (standard or reference)');
    expect(w).toMatch(/do not appear in your notes, the title, the provider or the theme/);
  });

  it("uses singular wording for one item", () => {
    expect(claimsToWarning("X", [{ kind: "name", text: "Arup" }])).toMatch(/it does not appear/);
  });

  it("lists at most the maximum and says how many more", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ kind: "number" as const, text: String(i + 10) }));
    const w = claimsToWarning("X", many, 6) ?? "";
    expect(w).toContain("and 3 more");
    expect(w).not.toContain('"17"');
  });
});

describe("sharesContentWords", () => {
  const notes = ["Learned how culvert inspections are scheduled. Will use this on the A14 drainage review."];

  it("is true when the text uses a meaningful word from the sources, in another form", () => {
    expect(sharesContentWords("I will inspect the culverts myself.", notes)).toBe(true);
    expect(sharesContentWords("It made the drainage review easier.", notes)).toBe(true);
    expect(sharesContentWords("Scheduling is clearer now.", notes)).toBe(true);
  });

  it("is false when the text shares nothing but ordinary words", () => {
    expect(sharesContentWords("It improved my confidence in delivering projects.", notes)).toBe(false);
    expect(sharesContentWords("I will use this next year and help the team.", notes)).toBe(false);
  });

  it("ignores short words and the words benefits always use", () => {
    expect(sharesContentWords("It helped, and I learned the plan for next year.", ["It helped. I learned the plan for next year."])).toBe(false);
  });

  it("is false for empty text and for empty sources", () => {
    expect(sharesContentWords("", notes)).toBe(false);
    expect(sharesContentWords("culvert inspections", [])).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(sharesContentWords("CULVERT work", notes)).toBe(true);
  });
});

describe("scanUnsupported: look-alike characters cannot hide a claim", () => {
  const PLAIN_SOURCES = ["Plain title", "Plain provider", "Plain theme", "I attended a session about drainage.", "Article"];

  it("flags fullwidth digits, letters and punctuation exactly as it flags the plain text", () => {
    const plain = found("I learned that 12 audits under BS 5489 cut costs by 40% at Network Rail since 1998.", PLAIN_SOURCES);
    const fullwidth = found("I learned that １２ audits under ＢＳ ５４８９ cut costs by ４０％ at Ｎｅｔｗｏｒｋ Ｒａｉｌ since １９９８.", PLAIN_SOURCES);
    expect(plain).toEqual(["number:12", "reference:BS 5489", "percentage:40%", "year:1998", "name:Network Rail"]);
    expect(fullwidth).toEqual(plain);
  });

  it("flags the exact claims, shown in their plain form", () => {
    expect(found("I learned that １２ audits under ＢＳ ５４８９ cut costs by ４０％ since １９９８.", PLAIN_SOURCES)).toEqual([
      "number:12",
      "reference:BS 5489",
      "percentage:40%",
      "year:1998",
    ]);
  });

  it("flags a fullwidth number word, an ideographic space and a mathematical digit", () => {
    expect(found("Saved ｔｈｒｅｅ audits by BS　5489 in 𝟐𝟎𝟐𝟓", PLAIN_SOURCES)).toEqual(["number:three", "reference:BS 5489", "year:2025"]);
  });

  it("flags digits written in another script", () => {
    expect(found("I learned that ١٢ audits were needed in ২০২৪.", PLAIN_SOURCES)).toEqual(["number:12", "year:2024"]);
  });

  it("flags a ligature and a superscript the same way as plain letters and digits", () => {
    expect(found("The ﬁnal score was 9².", PLAIN_SOURCES)).toEqual(found("The final score was 92.", PLAIN_SOURCES));
  });

  it("accepts a claim that is in the sources even when the two use different forms of the same characters", () => {
    expect(found("I learned that １２ audits were done under ＢＳ ５４８９.", ["Notes: 12 audits under BS 5489."])).toEqual([]);
    expect(found("I learned that 12 audits were done under BS 5489.", ["Notes: １２ audits under ＢＳ　５４８９."])).toEqual([]);
    expect(found("I attended 3 sessions in 2025.", ["Three sessions in ２０２５."])).toEqual([]);
  });

  it("does not change what is reported for ordinary text", () => {
    expect(found("Understanding the process helped me explain why records matter.")).toEqual([]);
  });
});

describe("scanUnsupported: fractions and multiples", () => {
  const NOTES = ["Plain title", "Plain provider", "Plain theme", "Notes about costs.", "Article"];

  it("flags a fraction, a multiple and a fold", () => {
    expect(found("Costs fell by a third and then a quarter; output doubled and then tripled, twice, tenfold.", NOTES)).toEqual([
      "number:a third",
      "number:a quarter",
      "number:doubled",
      "number:tripled",
      "number:twice",
      "number:tenfold",
    ]);
  });

  it("flags fractions with a number in front, and fold written as two words", () => {
    expect(found("Two thirds of the sites and three quarters of the budget, a five-fold gain, a two fold rise.", NOTES)).toEqual([
      "number:Two thirds",
      "number:three quarters",
      "number:five-fold",
      "number:two fold",
    ]);
  });

  it("flags the bare words double, triple and quadruple only when they act as a multiple", () => {
    expect(found("It will double the capacity and triple its output.", NOTES)).toEqual(["number:double", "number:triple"]);
    expect(found("I will double-check the double glazing details and the triple bottom line.", NOTES)).toEqual([]);
  });

  it("does not report the number word inside a fraction or fold as a second claim", () => {
    const claims = found("Two thirds of the work, a threefold rise.", NOTES);
    expect(claims).toEqual(["number:Two thirds", "number:threefold"]);
  });

  it("leaves everyday uses alone", () => {
    expect(found("A third party checked it in the third edition. We review it once a quarter and every quarter.", NOTES)).toEqual([]);
    expect(found("The third time, the third stage and a third person all matter.", NOTES)).toEqual([]);
  });

  it("accepts the same fraction or multiple when the sources say it, in the same or an equal form", () => {
    expect(found("Costs fell by a third.", ["Notes: cost fell by one third"])).toEqual([]);
    expect(found("Output was twice as high.", ["Notes: output doubled"])).toEqual([]);
    expect(found("Output went up threefold.", ["Notes: it tripled"])).toEqual([]);
    expect(found("Costs were halved.", ["Notes: cost cut by half"])).toEqual([]);
  });

  it("does not accept a different fraction or multiple from the sources", () => {
    expect(found("Costs fell by a third.", ["Notes: cost fell by a quarter"])).toEqual(["number:a third"]);
    expect(found("Output tripled.", ["Notes: output doubled"])).toEqual(["number:tripled"]);
  });

  it("reports the same one once", () => {
    expect(found("It doubled. Then it doubled again, and twice more.", NOTES)).toEqual(["number:doubled", "number:twice"]);
  });
});
