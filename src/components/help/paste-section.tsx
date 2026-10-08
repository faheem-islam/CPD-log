import { ChevronDown } from "lucide-react";
import Link from "next/link";
import { P, UL } from "@/components/legal/prose";
import { HelpSection } from "./help-section";

/** Plain answers to "what does it read, what does it keep, what leaves the site". Matches the privacy notice. */
export function PasteSection() {
  return (
    <HelpSection id="paste-link">
      <h3>What is read</h3>
      <UL>
        <li>Only public web pages. CPD Logger doesn't sign in to anything, so a page behind a login can't be read.</li>
        <li>
          The site's robots.txt file is checked first and respected. If a site asks automated tools not to read a page, or the file can't be
          checked, the page isn't read.
        </li>
        <li>The reader names itself CPDLoggerBot, so site owners can see who is asking.</li>
        <li>
          For YouTube links, the details come from YouTube's own data service. Depending on how this site is set up, YouTube may give no length.
          If so, the length shows as Not found and you enter the time yourself.
        </li>
        <li>There is a limit on how many links you can read in an hour.</li>
      </UL>
      <P>
        If a site blocks automated reading, shows a security check or needs a login, CPD Logger doesn't try to get round it. You are told, your
        link is kept, and you type the details in yourself with “Fill in by hand”.
      </P>

      <details className="group max-w-[65ch] rounded-xl bg-surface-2">
        <summary className="flex min-h-tap cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-2 font-bold [&::-webkit-details-marker]:hidden">
          <span className="min-w-0">Why a link might not be read</span>
          <ChevronDown aria-hidden="true" size={20} className="shrink-0 group-open:rotate-180" />
        </summary>
        <div className="space-y-3 px-4 pb-4 pt-1">
          <UL>
            <li>The page needs you to sign in.</li>
            <li>The site's robots.txt file asks automated tools not to read it.</li>
            <li>The site showed a security check or an access-denied page instead of the page itself.</li>
            <li>We couldn't confirm what the site allows, for example because its robots.txt file didn't answer.</li>
            <li>The link goes to a file or data feed rather than a web page.</li>
            <li>The page has been moved or removed, or the link has a typo.</li>
          </UL>
          <P>In every case the fix is the same: use “Fill in by hand”. CPD Logger doesn't retry another way.</P>
        </div>
      </details>

      <h3>What is stored</h3>
      <P>
        Only the details you save: the link, title, provider, type, dates, theme, your hours, and the text you write. Page text, transcripts and
        the files you upload to import a record are never stored. Details read from a link are held in memory for a few minutes so that
        reading the same link twice doesn't repeat the request.
      </P>

      <h3>What is sent to the AI provider</h3>
      <P>
        Nothing, unless the site owner has switched the AI feature on and you use it. Then:
      </P>
      <UL>
        <li>
          When you press “Expand my notes”: the resource title, its provider, its type, its theme and the notes you typed.
        </li>
        <li>When you import from a screenshot: the screenshot you upload.</li>
        <li>Text copied from web pages is never sent.</li>
      </UL>
      <P>
        There is a monthly limit on how many times you can use the AI feature. <Link href="/settings#features">Settings</Link> shows what is
        switched on for this site. The <Link href="/privacy">privacy notice</Link> has the full detail.
      </P>
    </HelpSection>
  );
}
