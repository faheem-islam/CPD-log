/** Date helpers. Everything is UK day-first and works in UTC so it never shifts by a day. */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

/** ISO date inside a longer string, e.g. a timestamp. Lookarounds, not \b, so "2026-03-04T10:00" matches. */
export const ISO_DATE_RE = /(?<!\d)(\d{4})-(\d{2})-(\d{2})(?!\d)/;

function pad(n: number, w = 2): string {
  return String(n).padStart(w, "0");
}

export function isValidYmd(y: number, m: number, d: number): boolean {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function toIso(y: number, m: number, d: number): string | null {
  return isValidYmd(y, m, d) ? `${pad(y, 4)}-${pad(m)}-${pad(d)}` : null;
}

function fullYear(y: number): number {
  return y < 100 ? 2000 + y : y;
}

/**
 * Parse one UK-style date. Accepts 04/03/2026, 4.3.26, 4 March 2026, Wed 4th Mar 2026,
 * March 4, 2026 and ISO 2026-03-04 (also inside a timestamp). Day always comes before month.
 * Returns YYYY-MM-DD or null.
 */
export function parseUkDate(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  if (!s) return null;

  const iso = ISO_DATE_RE.exec(s);
  if (iso) return toIso(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const numeric = /(?<!\d)(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})(?!\d)/.exec(s);
  if (numeric) return toIso(fullYear(Number(numeric[3])), Number(numeric[2]), Number(numeric[1]));

  const dayFirst = /(?<!\d)(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([A-Za-z]{3,9})\.?,?\s+(\d{4})(?!\d)/.exec(s);
  if (dayFirst) {
    const month = MONTHS[(dayFirst[2] ?? "").toLowerCase()];
    if (month) return toIso(Number(dayFirst[3]), month, Number(dayFirst[1]));
  }

  const monthFirst = /([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})(?!\d)/.exec(s);
  if (monthFirst) {
    const month = MONTHS[(monthFirst[1] ?? "").toLowerCase()];
    if (month) return toIso(Number(monthFirst[3]), month, Number(monthFirst[2]));
  }
  return null;
}

/** A date range ("4-6 March 2026", "04/03/2026 - 06/03/2026") uses its first day. */
export function parseDateOrRangeStart(input: string | null | undefined): string | null {
  if (!input) return null;
  const s = input.trim();
  const direct = parseUkDate(s);
  const sameMonth = /^(\d{1,2})(?:st|nd|rd|th)?\s*[-–—]\s*\d{1,2}(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?\s+(\d{4})$/.exec(s);
  if (sameMonth) {
    const month = MONTHS[(sameMonth[2] ?? "").toLowerCase()];
    if (month) return toIso(Number(sameMonth[3]), month, Number(sameMonth[1]));
  }
  if (direct) {
    // "04/03/2026 - 06/03/2026": parseUkDate already took the first match.
    return direct;
  }
  const parts = s.split(/\s+(?:-|–|—|to)\s+/i);
  if (parts.length > 1) return parseUkDate(parts[0]);
  return null;
}

/** Excel serial date to ISO, in UTC. Serial 25569 is 1970-01-01. Fractions (time of day) are dropped. */
export function excelSerialToIso(serial: number): string | null {
  if (!Number.isFinite(serial) || serial < 1 || serial > 120000) return null;
  const ms = Math.round((Math.floor(serial) - 25569) * 86400000);
  const d = new Date(ms);
  return toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

/** A JS Date to ISO using its UTC parts. exceljs hands back UTC-midnight dates for date cells. */
export function dateToIsoUtc(d: Date): string | null {
  if (Number.isNaN(d.getTime())) return null;
  return toIso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function isoToUtcDate(iso: string): Date {
  const m = ISO_DATE_RE.exec(iso);
  if (!m) throw new Error(`Not an ISO date: ${iso}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** dd/mm/yyyy */
export function formatUkDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = ISO_DATE_RE.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
}

/** 4 March 2026 */
export function formatLongDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const m = ISO_DATE_RE.exec(iso);
  if (!m) return "";
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${Number(m[3])} ${names[Number(m[2]) - 1]} ${m[1]}`;
}

export function yearOf(iso: string): number {
  return Number(iso.slice(0, 4));
}

/** Today's date in the UK as YYYY-MM-DD, whatever timezone the server runs in. */
export function todayUk(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function currentYearUk(now: Date = new Date()): number {
  return yearOf(todayUk(now));
}

/** Minutes between two clock times in the same text, e.g. "18:00-19:00", "6pm to 7:30pm", "18.00 – 19.00". */
export function parseTimeRange(input: string | null | undefined): number | null {
  if (!input) return null;
  const clock = String.raw`(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)?`;
  const re = new RegExp(String.raw`(?<![\d:.])${clock}\s*(?:-|–|—|to|until)\s*${clock}(?![\d])`, "i");
  const m = re.exec(input);
  if (!m) return null;
  const to24 = (h: string | undefined, min: string | undefined, ap: string | undefined): number | null => {
    let hh = Number(h);
    const mm = min ? Number(min) : 0;
    if (!Number.isFinite(hh) || mm > 59) return null;
    if (ap) {
      if (hh < 1 || hh > 12) return null;
      const pm = ap.toLowerCase() === "pm";
      hh = (hh % 12) + (pm ? 12 : 0);
    } else if (hh > 23) return null;
    return hh * 60 + mm;
  };
  let start = to24(m[1], m[2], m[3]);
  const end = to24(m[4], m[5], m[6]);
  if (start === null || end === null) return null;
  // "10-11am": the first time takes the second one's am/pm when it has none.
  if (!m[3] && m[6] && start < 24 * 60) {
    const startNoSuffix = to24(m[1], m[2], m[6]);
    if (startNoSuffix !== null && startNoSuffix < end) start = startNoSuffix;
  }
  const diff = end - start;
  return diff > 0 && diff <= 12 * 60 ? diff : null;
}

/** "PT1H30M" or "P0DT0H15M0S" to minutes. Seconds round to the nearest minute. */
export function parseIsoDurationMinutes(input: string | null | undefined): number | null {
  if (!input) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(input.trim());
  if (!m) return null;
  const total = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) + Math.round(Number(m[4] ?? 0) / 60);
  return total > 0 ? total : null;
}

/**
 * Human durations to minutes: "15m", "1h 30m", "1 hour 30 minutes", "90 mins", "1.5 hours", "1:30".
 * A bare number is NOT guessed here; callers decide whether it means hours or minutes.
 */
export function parseDurationMinutes(input: string | null | undefined): number | null {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const clock = /^(\d{1,3}):([0-5]\d)$/.exec(s);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]) || null;
  const re = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m)(?![a-z])/g;
  let total = 0;
  let found = false;
  let match: RegExpExecArray | null;
  while ((match = re.exec(s))) {
    found = true;
    const n = Number(match[1]);
    total += (match[2] ?? "").startsWith("h") ? n * 60 : n;
  }
  return found && total > 0 ? Math.round(total) : null;
}

export function roundHours(h: number): number {
  return Math.round(h * 100) / 100;
}

export function minutesToHours(min: number): number {
  return roundHours(min / 60);
}

/** Hours with at most two decimals and no trailing zeros: 1.5, 0.25, 2. */
export function formatHours(h: number): string {
  return String(roundHours(h));
}

export function formatDuration(min: number | null | undefined): string {
  if (min === null || min === undefined) return "";
  const h = Math.floor(min / 60);
  const m = Math.round(min % 60);
  if (h && m) return `${h}h ${m}m`;
  if (h) return `${h}h`;
  return `${m}m`;
}
