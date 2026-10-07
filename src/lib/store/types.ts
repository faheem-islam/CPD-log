import type { Entry, EntryInput, UserSettings } from "@/lib/types";

export interface AiUsageResult {
  /** False when the monthly cap has been reached. The count is not incremented then. */
  allowed: boolean;
  used: number;
  cap: number;
}

/**
 * One interface, two implementations: local JSON file (demo) and Supabase (row-level security).
 * Every method is scoped to a user id. A user can never reach another user's rows.
 * Entries are soft-deleted: deleteEntry sets deletedAt, restoreEntry clears it.
 */
export interface Store {
  getSettings(userId: string): Promise<UserSettings>;
  saveSettings(userId: string, settings: UserSettings): Promise<UserSettings>;

  /** Live entries by default (deletedAt is null), newest date first. */
  listEntries(userId: string, opts?: { includeDeleted?: boolean }): Promise<Entry[]>;
  getEntry(userId: string, id: string): Promise<Entry | null>;
  createEntry(userId: string, input: EntryInput): Promise<Entry>;
  createEntries(userId: string, inputs: EntryInput[]): Promise<Entry[]>;
  updateEntry(userId: string, id: string, patch: Partial<EntryInput>): Promise<Entry | null>;
  softDeleteEntry(userId: string, id: string): Promise<Entry | null>;
  restoreEntry(userId: string, id: string): Promise<Entry | null>;

  /** Removes the user's entries, settings and usage. Used by "Delete my account". */
  deleteAllUserData(userId: string): Promise<void>;

  /** Month is "YYYY-MM". */
  getAiUsage(userId: string, month: string, cap: number): Promise<AiUsageResult>;
  /** Atomically adds one call if under the cap. */
  incrementAiUsage(userId: string, month: string, cap: number): Promise<AiUsageResult>;
}
