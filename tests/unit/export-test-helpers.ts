import ExcelJS from "exceljs";
import type { Entry, UserSettings } from "@/lib/types";

/** Test data only. Every value is made up for a test and says so. */
let seq = 0;

export function makeEntry(over: Partial<Entry> = {}): Entry {
  seq += 1;
  return {
    id: `entry-${seq}`,
    userId: "user-1",
    profile: "ice",
    title: `Test activity ${seq}`,
    url: null,
    provider: null,
    sourceType: "other",
    publishedAt: null,
    dateCompleted: "2026-03-04",
    dateEnd: null,
    detectedDurationMinutes: null,
    hours: 1.5,
    hoursConfirmed: true,
    theme: null,
    category: null,
    structuralSafety: null,
    sustainability: null,
    devPlanRef: "",
    learningPoints: "",
    benefits: { helped: "", future: "", nextYear: "" },
    developmentGained: "",
    custom: {},
    notes: "",
    aiAssisted: false,
    confidence: {},
    createdAt: "2026-03-05T09:00:00.000Z",
    updatedAt: "2026-03-05T09:00:00.000Z",
    deletedAt: null,
    ...over,
  };
}

export function makeSettings(over: Partial<UserSettings> = {}): UserSettings {
  return {
    name: "Test Person",
    jobRole: "Test job role",
    responsibilities: "Test responsibilities",
    sector: "Test sector",
    activeProfiles: ["ice", "istructe", "custom"],
    customFields: [],
    ...over,
  };
}

export const NOW = new Date(Date.UTC(2026, 9, 7, 12, 0, 0));

export async function readBack(buf: Buffer): Promise<ExcelJS.Workbook> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  return wb;
}

/** What a cell shows: dates as dd/mm/yyyy (UTC), numbers with two decimals when the format says so, text as is. */
export function shown(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v === null || v === undefined) return "";
  if (v instanceof Date) {
    const p = (n: number) => String(n).padStart(2, "0");
    return `${p(v.getUTCDate())}/${p(v.getUTCMonth() + 1)}/${v.getUTCFullYear()}`;
  }
  if (typeof v === "number") return cell.numFmt === "0.00" ? v.toFixed(2) : String(v);
  return String(v);
}

export function rowStrings(ws: ExcelJS.Worksheet, rowNumber: number, columns: number): string[] {
  return Array.from({ length: columns }, (_, i) => shown(ws.getCell(rowNumber, i + 1)));
}

/** The rows of a table: from the row after the header to the last row that holds something. */
export function tableRows(ws: ExcelJS.Worksheet, headerRow: number, columns: number): string[][] {
  const out: string[][] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = rowStrings(ws, r, columns);
    if (row.some((c) => c !== "")) out.push(row);
  }
  return out;
}

export function sheetNames(wb: ExcelJS.Workbook): string[] {
  return wb.worksheets.map((w) => w.name);
}
