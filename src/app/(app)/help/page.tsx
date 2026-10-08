import type { Metadata } from "next";
import { AccuracySection } from "@/components/help/accuracy-section";
import { GettingHelpSection, KeyboardSection } from "@/components/help/access-sections";
import { CopyingSection } from "@/components/help/copying-section";
import { IstructeSection } from "@/components/help/istructe-section";
import { PasteSection } from "@/components/help/paste-section";
import { HELP_SECTIONS } from "@/components/help/sections";
import { Contents } from "@/components/legal/contents";
import { PageBody, PageHeader } from "@/components/shell/app-shell";
import { requirePageContext } from "@/lib/auth/context";

export const metadata: Metadata = { title: "Help" };

export default async function HelpPage() {
  await requirePageContext();
  return (
    <>
      <PageHeader
        title="Help"
        intro="How far to trust what the link reader suggests, how to get your entries into ICE's tool, and what happens to your data."
      />
      <PageBody>
        {/* The sidebar already takes room, so the contents list moves beside the text only from the extra-large breakpoint. */}
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] xl:gap-10">
          <Contents items={[...HELP_SECTIONS]} sideFrom="xl" />
          <div className="reveal min-w-0 max-w-[46rem] space-y-4">
            <AccuracySection />
            <CopyingSection />
            <IstructeSection />
            <PasteSection />
            <KeyboardSection />
            <GettingHelpSection />
          </div>
        </div>
      </PageBody>
    </>
  );
}
