import { describe, expect, it } from "vitest";
import {
  parseUkDate, parseDateOrRangeStart, excelSerialToIso, parseTimeRange, parseIsoDurationMinutes,
  parseDurationMinutes, formatHours, formatUkDate, todayUk, ISO_DATE_RE, isoToUtcDate,
} from "@/lib/dates";

describe("parseUkDate", () => {
  it("reads day-first numeric dates", () => {
    expect(parseUkDate("04/03/2026")).toBe("2026-03-04");
    expect(parseUkDate("4.3.26")).toBe("2026-03-04");
    expect(parseUkDate("31/12/2025")).toBe("2025-12-31");
  });
  it("reads written dates", () => {
    expect(parseUkDate("Wed 4th March 2026")).toBe("2026-03-04");
    expect(parseUkDate("4 Sept 2026")).toBe("2026-09-04");
    expect(parseUkDate("March 4, 2026")).toBe("2026-03-04");
  });
  it("reads ISO dates inside timestamps (lookarounds, not word boundaries)", () => {
    expect(parseUkDate("2026-03-04T10:00:00Z")).toBe("2026-03-04");
    expect(ISO_DATE_RE.test("x2026-03-04T10:00")).toBe(true);
    expect(ISO_DATE_RE.test("12026-03-041")).toBe(false);
  });
  it("rejects impossible dates", () => {
    expect(parseUkDate("31/02/2026")).toBeNull();
    expect(parseUkDate("13/13/2026")).toBeNull();
    expect(parseUkDate("hello")).toBeNull();
    expect(parseUkDate("")).toBeNull();
  });
});

describe("date ranges", () => {
  it("uses the first day", () => {
    expect(parseDateOrRangeStart("4-6 March 2026")).toBe("2026-03-04");
    expect(parseDateOrRangeStart("04/03/2026 - 06/03/2026")).toBe("2026-03-04");
    expect(parseDateOrRangeStart("4 March 2026 to 6 March 2026")).toBe("2026-03-04");
  });
});

describe("excelSerialToIso", () => {
  it("converts in UTC", () => {
    expect(excelSerialToIso(25569)).toBe("1970-01-01");
    expect(excelSerialToIso(46085)).toBe("2026-03-04");
    expect(excelSerialToIso(46085.75)).toBe("2026-03-04");
  });
  it("rejects nonsense", () => {
    expect(excelSerialToIso(0)).toBeNull();
    expect(excelSerialToIso(Number.NaN)).toBeNull();
  });
});

describe("time ranges and durations", () => {
  it("reads clock ranges", () => {
    expect(parseTimeRange("18:00-19:00")).toBe(60);
    expect(parseTimeRange("Time: 18:00 – 19:30 GMT")).toBe(90);
    expect(parseTimeRange("6pm to 7:30pm")).toBe(90);
    expect(parseTimeRange("10-11am")).toBe(60);
    expect(parseTimeRange("18.00 - 19.00")).toBe(60);
  });
  it("rejects bad ranges", () => {
    expect(parseTimeRange("19:00-18:00")).toBeNull();
    expect(parseTimeRange("no times here")).toBeNull();
  });
  it("reads ISO durations", () => {
    expect(parseIsoDurationMinutes("PT1H30M")).toBe(90);
    expect(parseIsoDurationMinutes("PT15M")).toBe(15);
    expect(parseIsoDurationMinutes("PT0S")).toBeNull();
    expect(parseIsoDurationMinutes("nope")).toBeNull();
  });
  it("reads human durations", () => {
    expect(parseDurationMinutes("15m")).toBe(15);
    expect(parseDurationMinutes("Duration 15m")).toBe(15);
    expect(parseDurationMinutes("1h 30m")).toBe(90);
    expect(parseDurationMinutes("1 hour 30 minutes")).toBe(90);
    expect(parseDurationMinutes("1.5 hours")).toBe(90);
    expect(parseDurationMinutes("1:30")).toBe(90);
    expect(parseDurationMinutes("90 mins")).toBe(90);
    expect(parseDurationMinutes("12")).toBeNull();
  });
});

describe("formatting", () => {
  it("formats hours to at most two decimals", () => {
    expect(formatHours(1.5)).toBe("1.5");
    expect(formatHours(0.25)).toBe("0.25");
    expect(formatHours(2)).toBe("2");
    expect(formatHours(3.0166)).toBe("3.02");
  });
  it("formats UK dates", () => {
    expect(formatUkDate("2026-03-04")).toBe("04/03/2026");
    expect(formatUkDate(null)).toBe("");
  });
  it("gives the UK date across the midnight boundary", () => {
    expect(todayUk(new Date("2026-06-30T23:30:00Z"))).toBe("2026-07-01");
    expect(todayUk(new Date("2026-01-30T23:30:00Z"))).toBe("2026-01-30");
  });
  it("makes UTC dates", () => {
    expect(isoToUtcDate("2026-03-04").toISOString()).toBe("2026-03-04T00:00:00.000Z");
  });
});
