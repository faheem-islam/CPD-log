import type { Entry, ProfileId, UserSettings } from "@/lib/types";
import { PROFILES } from "@/lib/profiles";
import { assertOwnEntries, cellDisplay, checkYear, exportRows, iceHeaderBlock, normaliseProfiles, type ExportColumn, type ExportYear } from "./rows";

export interface ExportPreview {
  profile: ProfileId;
  /** The sheet name used in the file. */
  sheetName: string;
  /** Columns in the exact order of the file. */
  columns: ExportColumn[];
  /** One array of display strings per row, in the same order as the file. Dates are dd/mm/yyyy, hours have two decimals. */
  rows: string[][];
  totalHours: number;
  count: number;
  /** ICE only: the Name, Job role and responsibilities, and Engineering sector block above the table. */
  headerBlock?: { label: string; value: string }[];
  /** IStructE only: the provisional note shown above the table. */
  note?: string;
}

export interface PreviewInput {
  entries: readonly Entry[];
  settings: UserSettings;
  profiles: readonly ProfileId[];
  year: ExportYear;
  /** When given, every entry must belong to this user or the preview is refused. Entries of more than one user are always refused. */
  userId?: string;
}

/**
 * What the Export page shows before download. It uses the same exportRows as the workbook, and refuses the same
 * profiles, years and entries, so the preview and the file cannot drift apart.
 */
export function previewExport(input: PreviewInput): ExportPreview[] {
  const profiles = normaliseProfiles(input.profiles);
  checkYear(input.year);
  assertOwnEntries(input.entries, input.userId);
  const out: ExportPreview[] = [];
  for (const profile of profiles) {
    const table = exportRows(profile, input.entries, input.settings, { year: input.year });
    const preview: ExportPreview = {
      profile,
      sheetName: PROFILES[profile].sheetName,
      columns: table.columns,
      rows: table.rows.map((r) => r.cells.map(cellDisplay)),
      totalHours: table.totalHours,
      count: table.count,
    };
    if (profile === "ice") preview.headerBlock = iceHeaderBlock(input.settings);
    if (profile === "istructe") preview.note = PROFILES.istructe.provisionalNote;
    out.push(preview);
  }
  return out;
}
