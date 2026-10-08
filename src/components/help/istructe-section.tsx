import { TriangleAlert } from "lucide-react";
import { P } from "@/components/legal/prose";
import { PROFILES } from "@/lib/profiles";
import { HelpSection } from "./help-section";

/**
 * The IStructE profile is a best guess from published guidance. The numbers come from the same profile config the dashboard
 * uses, so changing the config changes this page too.
 */
export function IstructeSection() {
  const { rules, columns } = PROFILES.istructe;
  const years = rules.rollingYears === 3 ? "three" : String(rules.rollingYears);
  return (
    <HelpSection id="istructe">
      <p className="notice notice-warn flex max-w-[65ch] gap-3">
        <TriangleAlert aria-hidden="true" size={22} className="mt-0.5 shrink-0" />
        <span className="min-w-0">
          <strong>Provisional.</strong> Compare this layout with your IStructE My Account CPD form before you rely on it.
        </span>
      </p>
      <P>
        The IStructE log is built from published guidance, not from the real My Account form, so its columns may not match what IStructE asks
        for. Treat the Excel file as a guide to copy from, and check it against the form each time until the layout has been confirmed.
      </P>
      <P>
        The targets on your dashboard are provisional too: {rules.annualHours} hours a year, including {rules.structuralSafetyHours} on
        structural safety and {rules.sustainabilityHours} on sustainability, and {rules.rollingHours} hours over a rolling {years}{" "}
        years. They are shown so you can see where you are, not as a statement of what IStructE requires of you.
      </P>
      <P>
        The columns in the file are: {columns.map((c) => c.label).join(", ")}. As with ICE, CPD Logger never connects to IStructE and never
        submits anything for you.
      </P>
    </HelpSection>
  );
}
