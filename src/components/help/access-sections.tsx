import Link from "next/link";
import { P, Placeholder, UL } from "@/components/legal/prose";
import { HelpSection } from "./help-section";

export function KeyboardSection() {
  return (
    <HelpSection id="keyboard">
      <UL>
        <li>
          Everything can be used without a mouse. Tab and Shift+Tab move between controls, Enter or Space presses a button, and Esc closes a
          dialog.
        </li>
        <li>A “Skip to content” link appears the first time you press Tab on a page.</li>
        <li>Badges and notices always use words and an icon as well as colour.</li>
        <li>
          Light, dark or your device's setting: choose in <Link href="/settings#appearance">Settings</Link>.
        </li>
      </UL>
      <P>
        We check pages against WCAG 2.1 AA with automated tools. Those can't find every problem, so if something doesn't work for you, please
        tell us.
      </P>
    </HelpSection>
  );
}

export function GettingHelpSection() {
  return (
    <HelpSection id="getting-help">
      <P>
        <Placeholder>[Support contact to be added by the site owner]</Placeholder>
      </P>
      <P>
        If a reader got something wrong, say which link you pasted and which detail was wrong. Please don't send passwords or your whole CPD
        record.
      </P>
      <UL>
        <li>
          Download a copy of your data, or delete your account: <Link href="/settings#your-data">Settings</Link>
        </li>
        <li>
          <Link href="/privacy">Privacy notice</Link> and <Link href="/terms">Terms of use</Link>
        </li>
      </UL>
    </HelpSection>
  );
}
