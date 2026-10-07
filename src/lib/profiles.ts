import { z } from "zod";
import raw from "@/config/profiles.json";
import type { ProfileId } from "./types";

const column = z.object({
  key: z.string(),
  label: z.string(),
  type: z.enum(["text", "date", "hours", "yesno"]),
  width: z.number(),
});

const iceSchema = z.object({
  id: z.literal("ice"),
  label: z.string(),
  fullName: z.string(),
  provisional: z.literal(false),
  sheetName: z.string(),
  headerBlock: z.array(z.object({ key: z.string(), label: z.string() })).length(3),
  columns: z.array(column),
  themes: z.object({ mandatory: z.array(z.string()).length(3), additional: z.array(z.string()) }),
  themeSlugs: z.record(z.string(), z.object({ theme: z.string(), exact: z.boolean() })),
  benefitPrompts: z.array(z.object({ key: z.enum(["helped", "future", "nextYear"]), label: z.string() })),
  rules: z.object({ mandatoryEachYear: z.number(), rollingYears: z.number(), hoursTarget: z.null() }),
  rulesText: z.string(),
  exportNote: z.string(),
});

const istructeSchema = z.object({
  id: z.literal("istructe"),
  label: z.string(),
  fullName: z.string(),
  provisional: z.literal(true),
  sheetName: z.string(),
  provisionalNote: z.string(),
  columns: z.array(column),
  categories: z.array(z.string()),
  rules: z.object({
    annualHours: z.number(),
    structuralSafetyHours: z.number(),
    sustainabilityHours: z.number(),
    rollingYears: z.number(),
    rollingHours: z.number(),
  }),
  rulesText: z.string(),
  exportNote: z.string(),
});

const customSchema = z.object({
  id: z.literal("custom"),
  label: z.string(),
  fullName: z.string(),
  provisional: z.literal(false),
  sheetName: z.string(),
  baseColumns: z.array(column),
  maxCustomFields: z.number(),
  exportNote: z.string(),
});

const configSchema = z.object({ ice: iceSchema, istructe: istructeSchema, custom: customSchema });

export type ProfileConfig = z.infer<typeof configSchema>;
export type IceProfile = ProfileConfig["ice"];
export type IstructeProfile = ProfileConfig["istructe"];
export type CustomProfile = ProfileConfig["custom"];
export type ColumnDef = z.infer<typeof column>;

/** The profile config is validated once, so a bad edit to profiles.json fails loudly. */
export const PROFILES: ProfileConfig = configSchema.parse(raw);

export const ICE_ALL_THEMES: string[] = [...PROFILES.ice.themes.mandatory, ...PROFILES.ice.themes.additional];

export function profileLabel(id: ProfileId): string {
  return PROFILES[id].label;
}

export function isProfileId(v: unknown): v is ProfileId {
  return v === "ice" || v === "istructe" || v === "custom";
}

/** Case-insensitive match of free text to one of the allowed values. */
export function matchOption(value: string, options: readonly string[]): string | null {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const v = norm(value);
  if (!v) return null;
  const exact = options.find((o) => norm(o) === v);
  if (exact) return exact;
  const partial = options.find((o) => norm(o).includes(v) || v.includes(norm(o)));
  return partial ?? null;
}
