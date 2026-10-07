import type { ExtractResponse, Entry } from "@/lib/types";
import type { EntryWarning } from "@/lib/warnings";
import type { ApiErrorBody } from "./route-types";

export type { ExtractResponse, EntryWarning, ApiErrorBody };

export interface EntryResponse {
  entry: Entry;
  warnings: EntryWarning[];
}

export interface ExpandResponse {
  learningPoints: string;
  benefits: { helped: string; future: string; nextYear: string };
  developmentGained: string;
  /** Things in the AI text that are not in the person's notes. Always shown. */
  warnings: string[];
  aiAssisted: true;
}
