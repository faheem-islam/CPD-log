import { P } from "@/components/legal/prose";
import { BadgeGuide } from "./badge-guide";
import { HelpSection } from "./help-section";

/**
 * The honest explainer. It says what the badges mean and, just as plainly, what has not been measured.
 * Nothing here may claim that a detected value is checked or that a person's CPD is complete.
 */
export function AccuracySection() {
  return (
    <HelpSection id="accuracy">
      <P>
        When you paste a link, CPD Logger reads the public page and suggests details for your entry. Those suggestions can be wrong, so every
        one carries a badge saying how it was found. You confirm every detail before an entry is saved.
      </P>

      <h3>What the badges mean</h3>
      <BadgeGuide />
      <P>
        None of these badges means that anyone has checked the value. They describe how it was found, not whether it is right. Even a High value
        can be wrong if the page is wrong or the reader misread it.
      </P>

      <h3>How well do the readers work?</h3>
      <P>
        The readers are tested only against sample pages written by hand. Those tests show that the logic works on the page layouts we
        imagined. They do not show how often a reader is right on the real sites, and that has not been measured. The site owner can measure it
        with the evaluation script (<code className="whitespace-nowrap rounded bg-surface-2 px-1.5 py-0.5 font-sans text-sm font-bold">npm run eval</code>) on pages they have checked themselves. Until then, treat
        every suggestion as a starting point.
      </P>

      <h3>ICE Knowledge Hub themes</h3>
      <P>
        On the ICE Knowledge Hub the theme is read from the web address. Only the exact address section “safety-risk” is marked High. Every
        other theme suggested from an address is a guess, marked Check, and the theme names in this app should be checked against ICE's own
        framework page. Choose the theme that matches what you learned.
      </P>

      <h3>Time spent is always your figure</h3>
      <P>
        The length of a video or webinar is how long it runs, not how long you spent learning. Effective learning time is your own figure, and an
        entry can't be saved until you tick “I confirm this is the time I actually spent learning”.
      </P>

      <h3>AI-assisted text</h3>
      <P>
        If the site owner has switched the AI feature on, “Expand my notes” rewrites your own notes into the learning points and benefits
        fields. It only works from what you wrote, but it can still contain mistakes or add things you didn't say. It warns you about numbers
        and names that aren't in your notes, and it can't catch everything. Read it, correct it, and tick “I've read and checked the AI-assisted
        text” before you save. The entry is marked as AI-assisted, and the wording you keep is your responsibility.
      </P>

      <h3>Log events after you have attended</h3>
      <P>
        If a page describes an event that hasn't happened yet, CPD Logger tells you. Log it after you have attended, with the time you actually
        spent. Don't record learning in advance.
      </P>
    </HelpSection>
  );
}
