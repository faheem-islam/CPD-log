import ExcelJS from "exceljs";
import type { ImportContext, ImportRow } from "@/lib/import/types";
import { makeSettings, NOW } from "./export-test-helpers";

/** Test data only. Every value here is made up for a test. */
export function makeCtx(over: Partial<ImportContext> = {}): ImportContext {
  return { profile: "ice", settings: makeSettings(), existing: [], now: NOW, ...over };
}

export async function toBuffer(wb: ExcelJS.Workbook): Promise<Buffer> {
  return Buffer.from((await wb.xlsx.writeBuffer()) as ArrayBuffer);
}

/** One sheet from an array of rows. A Date is written as a real date cell. */
export async function xlsxFromRows(rows: unknown[][], sheetName = "Sheet1"): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(sheetName);
  for (const r of rows) ws.addRow(r);
  return toBuffer(wb);
}

export function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m - 1, d));
}

export const HEADER = ["Date", "Title", "Hours"];

/** The first row's issues, as "field:severity" for compact asserts. */
export function issueKeys(row: ImportRow | undefined): string[] {
  return (row?.issues ?? []).map((i) => `${i.field}:${i.severity}`);
}

export function messages(row: ImportRow | undefined, field?: string): string[] {
  return (row?.issues ?? []).filter((i) => field === undefined || i.field === field).map((i) => i.message);
}

export function csv(lines: string[], eol = "\n"): Buffer {
  return Buffer.from(lines.join(eol), "utf8");
}
