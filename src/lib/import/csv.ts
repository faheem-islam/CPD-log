import { ImportError } from "./types";

export interface CsvParse {
  /** One array of fields per record. A blank line is a record with one empty field, so row numbers match the file. */
  records: string[][];
  /** A quoted value was opened and never closed. The rest of the file may have been merged into one cell. */
  unterminatedQuote: boolean;
  /** Parsing stopped at CsvLimits.maxNonBlank before the end of the text, so there is more than that many non-blank records. */
  truncated: boolean;
}

/**
 * Limits that keep a hostile file cheap to read. Without limits every record is kept exactly as written.
 * With limits, a record whose fields are all blank is stored as one shared blank record (so a file of nothing but
 * line breaks costs one array slot per line, not one array per line), a record keeps at most maxFields fields, and
 * parsing stops once more than maxNonBlank records with something in them have been read.
 */
export interface CsvLimits {
  maxNonBlank?: number;
  maxFields?: number;
}

/** The one blank record that is shared by every blank line when limits are used. Never changed. */
const SHARED_BLANK: string[] = Object.freeze([""]) as unknown as string[];

/**
 * RFC 4180 parser: quoted fields, "" for a quote, line breaks inside quotes, CRLF, LF or CR between records.
 * A stray quote in the middle of an unquoted field is kept as text.
 */
export function parseCsvRecords(text: string, delimiter: string, maxRecords = Number.POSITIVE_INFINITY, limits?: CsvLimits): CsvParse {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;
  /** True once a quoted field has closed, so a later quote in the same field is plain text. */
  let closed = false;
  let i = 0;
  const n = text.length;
  const maxFields = limits?.maxFields ?? Number.POSITIVE_INFINITY;
  const maxNonBlank = limits?.maxNonBlank ?? Number.POSITIVE_INFINITY;
  let nonBlank = 0;
  let truncated = false;

  const endField = () => {
    if (record.length < maxFields) record.push(field);
    field = "";
    closed = false;
  };
  const endRecord = () => {
    if (limits && field === "" && record.length === 0 && !closed) {
      // The commonest blank line: nothing at all before the line break.
      records.push(SHARED_BLANK);
      return;
    }
    endField();
    if (limits && record.every((f) => f.trim() === "")) {
      records.push(SHARED_BLANK);
    } else {
      records.push(record);
      nonBlank += 1;
      if (nonBlank > maxNonBlank) truncated = true;
    }
    record = [];
  };

  while (i < n && records.length < maxRecords && !truncated) {
    const c = text.charAt(i);
    if (inQuotes) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        closed = true;
      } else {
        // Everything up to the next quote is part of the value: take it in one piece.
        const quote = text.indexOf('"', i);
        const stop = quote === -1 ? n : quote;
        field += text.slice(i, stop);
        i = stop;
        continue;
      }
      i += 1;
      continue;
    }
    if (c === '"' && field === "" && !closed) {
      inQuotes = true;
    } else if (c === delimiter) {
      endField();
    } else if (c === "\r") {
      if (text.charAt(i + 1) === "\n") i += 1;
      endRecord();
    } else if (c === "\n") {
      endRecord();
    } else {
      // Plain text up to the next delimiter or line break (a quote inside it is just a quote): take it in one piece.
      let stop = i + 1;
      while (stop < n) {
        const d = text.charAt(stop);
        if (d === delimiter || d === "\n" || d === "\r") break;
        stop += 1;
      }
      field += text.slice(i, stop);
      i = stop;
      continue;
    }
    i += 1;
  }
  const unterminatedQuote = inQuotes && i >= n;
  if (!truncated && records.length < maxRecords && (field !== "" || record.length > 0 || closed)) endRecord();
  return { records, unterminatedQuote, truncated };
}

const DELIMITERS = ["\t", ";", ","] as const;

/** Enough columns to tell the delimiters apart. A line of five million commas must not become five million fields. */
const DETECT_MAX_FIELDS = 1000;

/** The start of the text is all that is needed to tell the delimiters apart: 200 records, or this many characters. */
const DETECT_SAMPLE_CHARS = 256 * 1024;

/** Picks tab, semicolon or comma by which one splits the first records into the same number of columns most often. */
export function detectDelimiter(text: string): string {
  let best = ",";
  let bestScore = 0;
  const sample = text.length > DETECT_SAMPLE_CHARS ? text.slice(0, DETECT_SAMPLE_CHARS) : text;
  for (const d of DELIMITERS) {
    const { records } = parseCsvRecords(sample, d, 200, { maxFields: DETECT_MAX_FIELDS });
    const counts = new Map<number, number>();
    for (const r of records) {
      if (r.every((f) => f.trim() === "")) continue;
      counts.set(r.length, (counts.get(r.length) ?? 0) + 1);
    }
    let modal = 0;
    let modalRows = 0;
    for (const [cols, rows] of counts) {
      if (rows > modalRows || (rows === modalRows && cols > modal)) {
        modal = cols;
        modalRows = rows;
      }
    }
    if (modal < 2) continue;
    const score = modalRows * 1000 + modal;
    if (score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

/** Windows-1252 differs from Latin-1 in 0x80 to 0x9F (curly quotes, dashes, the euro sign). Node's decoder treats the two as the same. */
const CP1252_HIGH: Record<number, string> = {
  0x80: "\u20AC", 0x82: "\u201A", 0x83: "\u0192", 0x84: "\u201E", 0x85: "\u2026", 0x86: "\u2020", 0x87: "\u2021",
  0x88: "\u02C6", 0x89: "\u2030", 0x8a: "\u0160", 0x8b: "\u2039", 0x8c: "\u0152", 0x8e: "\u017D", 0x91: "\u2018",
  0x92: "\u2019", 0x93: "\u201C", 0x94: "\u201D", 0x95: "\u2022", 0x96: "\u2013", 0x97: "\u2014", 0x98: "\u02DC",
  0x99: "\u2122", 0x9a: "\u0161", 0x9b: "\u203A", 0x9c: "\u0153", 0x9e: "\u017E", 0x9f: "\u0178",
};

export function decodeWindows1252(buf: Buffer): string {
  return buf.toString("latin1").replace(/[\u0080-\u009F]/g, (c) => CP1252_HIGH[c.charCodeAt(0)] ?? c);
}

export interface Decoded {
  text: string;
  notes: string[];
}

/** Bytes to text. Handles UTF-8 (with or without a BOM), UTF-16 with a BOM, and falls back to Windows-1252. */
export function decodeCsvBytes(buf: Buffer): Decoded {
  const notes: string[] = [];
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(buf.subarray(2)), notes };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return { text: new TextDecoder("utf-16le").decode(swapped), notes };
  }
  if (buf.includes(0)) {
    throw new ImportError(
      "That file does not look like a text file. Open it in Excel and save it again as CSV UTF-8 (Comma delimited), or as .xlsx, then upload that.",
      "unreadable",
    );
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf);
    return { text: text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, notes };
  } catch {
    notes.push("This file is not UTF-8, so it was read as Windows-1252. Check any accents or symbols such as pound signs and dashes.");
    return { text: decodeWindows1252(buf), notes };
  }
}
