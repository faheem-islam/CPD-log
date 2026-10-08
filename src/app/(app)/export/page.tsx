import type { Metadata } from "next";
import { AboutFile } from "@/components/export/about-file";
import { ExportView, type LogOption } from "@/components/export/export-view";
import { PageBody, PageHeader } from "@/components/shell/app-shell";
import { requirePageContext } from "@/lib/auth/context";
import { yearsPresent } from "@/lib/compliance";
import { PROFILES } from "@/lib/profiles";
import { PROFILE_IDS } from "@/lib/types";

export const metadata: Metadata = { title: "Export" };

export default async function ExportPage() {
  const ctx = await requirePageContext();
  const entries = await ctx.store.listEntries(ctx.user.id);

  // Only the logs the person keeps are offered, in the usual order.
  const kept = PROFILE_IDS.filter((id) => ctx.settings.activeProfiles.includes(id));
  const logs: LogOption[] = kept.map((id) => ({
    id,
    label: PROFILES[id].label,
    fullName: PROFILES[id].fullName,
    provisional: PROFILES[id].provisional,
    count: entries.filter((e) => e.profile === id).length,
  }));
  const inKept = entries.filter((e) => kept.includes(e.profile));

  return (
    <>
      <PageHeader title="Export" intro="Download your log as an Excel file, after checking what is in it." />
      <PageBody className="reveal space-y-10">
        <ExportView
          logs={logs}
          years={yearsPresent(inKept)}
          totalEntries={inKept.length}
          hiddenEntries={entries.length - inKept.length}
        />
        <AboutFile />
      </PageBody>
    </>
  );
}
