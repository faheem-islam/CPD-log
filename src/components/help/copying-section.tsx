import Link from "next/link";
import { OL, P, UL } from "@/components/legal/prose";
import { PROFILES } from "@/lib/profiles";
import { HelpSection } from "./help-section";

/**
 * How to get entries into ICE's tool. ICE has no import, so this is copy-by-hand or attach. The column order is read from
 * the same profile config the Excel export uses, so this list cannot disagree with the file.
 */
export function CopyingSection() {
  const ice = PROFILES.ice;
  return (
    <HelpSection id="copy-to-ice">
      <P>
        ICE's CPD tool has no import feature, so entries can't be sent across automatically. CPD Logger never connects to ICE or IStructE and
        never submits anything for you. The Excel file is for your own records, to attach, or to copy across by hand.
      </P>

      <h3>To copy entries across by hand</h3>
      <OL>
        <li>
          Go to <Link href="/export">Export</Link>, choose the ICE log and the year, and select “Download Excel file”.
        </li>
        <li>
          Open the file. Your entries are on the sheet called “{ice.sheetName}”, one row for each entry, with your name, job role and
          responsibilities, and engineering sector from Settings at the top.
        </li>
        <li>In ICE's CPD tool, add a new record for each entry and copy the columns across by hand, in this order:</li>
      </OL>

      <ol className="band-2 max-w-[65ch] list-decimal space-y-1 py-4 pl-11 pr-5 font-bold marker:font-display marker:font-bold marker:text-muted sm:py-5">
        {ice.columns.map((c) => (
          <li key={c.key} className="pl-1">
            {c.label}
          </li>
        ))}
      </ol>

      <UL>
        <li>
          “Key Benefits/Value added” holds up to three labelled lines: how it helped, how you will use it in future, and how it will influence
          next year's plan. If you wrote only one, it appears without a label.
        </li>
        <li>“Dev. Plan ref” shows “unplanned” when you left it blank.</li>
      </UL>

      <h3>Or attach the file</h3>
      <P>
        ICE and IStructE both accept CPD records in other formats, as long as the content is complete, so you can attach the Excel file instead
        of copying it across. Check the institution's current guidance first, because their rules can change.
      </P>
    </HelpSection>
  );
}
