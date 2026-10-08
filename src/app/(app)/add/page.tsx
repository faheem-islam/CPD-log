import type { Metadata } from "next";
import { AddFlow } from "@/components/add/add-flow";
import { PageHeader } from "@/components/shell/app-shell";
import { requirePageContext } from "@/lib/auth/context";
import { todayUk } from "@/lib/dates";

export const metadata: Metadata = { title: "Add an entry" };
export const dynamic = "force-dynamic";

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/**
 * /add, optionally with ?url=<link> (starts reading it straight away) or ?manual=1 (opens the manual form).
 * The server loads the settings, the feature flags, today's UK date and a light list of the person's live
 * entries (for the same-day hours warning). Everything passed to the client is plain data.
 */
export default async function AddPage({ searchParams }: { searchParams: Promise<{ url?: string | string[]; manual?: string | string[] }> }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const url = first(sp.url)?.trim().slice(0, 2048) || undefined;
  const manual = first(sp.manual) === "1";
  const entries = await ctx.store.listEntries(ctx.user.id);
  const others = entries.map((e) => ({ id: e.id, dateCompleted: e.dateCompleted, hours: e.hours }));

  return (
    <>
      <PageHeader title="Add a CPD entry" intro="Paste a link and check what we found. Nothing is saved until you press Save." />
      <AddFlow
        key={`${url ?? ""}|${manual}`}
        settings={{ activeProfiles: ctx.settings.activeProfiles, customFields: ctx.settings.customFields }}
        features={{ ai: ctx.features.ai, youtubeApi: ctx.features.youtubeApi }}
        todayIso={todayUk()}
        others={others}
        owner={ctx.user.id}
        initialUrl={url}
        startManual={manual}
      />
    </>
  );
}
