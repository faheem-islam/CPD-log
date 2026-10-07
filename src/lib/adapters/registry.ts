/** The ordered list of adapters and the choice of which ones to run for a URL. */
import type { Adapter } from "@/lib/types";
import { eventsAdapter } from "./events";
import { genericAdapter } from "./generic";
import { govDocsAdapter } from "./gov-docs";
import { iceHubAdapter } from "./ice-hub";
import { youtubeAdapter } from "./youtube";

/** Specific adapters first, the generic fallback last. */
export const ADAPTERS: readonly Adapter[] = [youtubeAdapter, iceHubAdapter, eventsAdapter, govDocsAdapter, genericAdapter];

/** Adapter id to specificity, for mergeResults. */
export const SPECIFICITY_BY_ID: Readonly<Record<string, number>> = Object.fromEntries(ADAPTERS.map((a) => [a.id, a.specificity]));

/** Every specific adapter that matches the URL, then the generic adapter. The generic one is always included, once, last. */
export function selectAdapters(url: URL): Adapter[] {
  const specific = ADAPTERS.filter((a) => a.id !== genericAdapter.id && a.matches(url));
  return [...specific, genericAdapter];
}
