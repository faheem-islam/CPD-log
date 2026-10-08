import type { ProfileId } from "@/lib/types";

/** What the dashboard shows for this person: one progress panel, or hours and entries only. */
export type DashboardView = "ice" | "istructe" | "custom";

export interface ViewChoice {
  view: DashboardView;
  /** Both ICE and IStructE are active, so the person can switch between them. */
  canSwitch: boolean;
}

/**
 * Chooses the panel to show. ICE and IStructE have rules to track; Custom has none. With both of the
 * first two active, ?profile=ice|istructe picks one and the first active profile is the default.
 * A request for a log that is not active is ignored.
 */
export function chooseView(active: readonly ProfileId[], requested: string | undefined): ViewChoice {
  const tracked = active.filter((p): p is "ice" | "istructe" => p === "ice" || p === "istructe");
  const first = tracked[0];
  if (!first) return { view: "custom", canSwitch: false };
  const asked = tracked.find((p) => p === requested);
  return { view: asked ?? first, canSwitch: tracked.length > 1 };
}
