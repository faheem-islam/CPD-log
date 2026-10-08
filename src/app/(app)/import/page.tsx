import type { Metadata } from "next";
import { ImportFlow, type ImportLog } from "@/components/import/import-flow";
import { PageBody, PageHeader } from "@/components/shell/app-shell";
import { requirePageContext } from "@/lib/auth/context";
import { PROFILES } from "@/lib/profiles";
import { PROFILE_IDS } from "@/lib/types";

export const metadata: Metadata = { title: "Import" };

export default async function ImportPage() {
  const ctx = await requirePageContext();

  // Only the logs the person keeps, in the usual order. One log is filled at a time.
  const logs: ImportLog[] = PROFILE_IDS.filter((id) => ctx.settings.activeProfiles.includes(id)).map((id) => ({
    id,
    label: PROFILES[id].label,
    fullName: PROFILES[id].fullName,
    provisional: PROFILES[id].provisional,
  }));

  return (
    <>
      <PageHeader
        title="Import"
        intro="Bring in a CPD record you already keep in Excel or CSV. You check every row before anything is saved."
      />
      <PageBody className="reveal">
        <ImportFlow logs={logs} aiEnabled={ctx.features.ai} customFields={ctx.settings.customFields} />
      </PageBody>
    </>
  );
}
