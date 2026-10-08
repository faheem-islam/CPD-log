import Link from "next/link";
import type { LegalSectionDef } from "./legal-page";
import { P, Placeholder, UL } from "./prose";

/**
 * Terms of use TEMPLATE. Everything in [square brackets] is for the site owner to decide, and the whole text
 * needs checking by someone qualified before it is relied on.
 */
export const termsSections: LegalSectionDef[] = [
  {
    id: "purpose",
    title: "What CPD Logger is for",
    body: (
      <>
        <P>
          CPD Logger helps you keep your own record of continuing professional development (CPD). You paste a link, it reads the public page and
          suggests the details of an entry, you check and confirm them, and you can export your log to Excel.
        </P>
        <P>
          It is not connected to the Institution of Civil Engineers (ICE), the Institution of Structural Engineers (IStructE) or any other
          body. It does not send, submit or file anything for you. What you copy across or attach to your institution's own system is up to
          you.
        </P>
        <P>
          The service is run by <Placeholder>[Organisation or owner name]</Placeholder>. By signing in you agree to these terms and to the{" "}
          <Link href="/privacy">privacy notice</Link>.
        </P>
      </>
    ),
  },
  {
    id: "advice",
    title: "No professional advice, and your responsibility",
    body: (
      <>
        <P>CPD Logger gives no professional, legal or regulatory advice. You are responsible for:</P>
        <UL>
          <li>your CPD record, including every entry, date and hour you save;</li>
          <li>checking what ICE, IStructE or your employer currently requires, because their rules change; and</li>
          <li>whatever you submit, attach or copy across to them.</li>
        </UL>
        <P>
          The dashboard shows which themes you have recorded and how many hours you have logged. That is a summary of your own entries. It is
          not a statement that you have met any requirement, and the IStructE targets are provisional.
        </P>
      </>
    ),
  },
  {
    id: "accuracy",
    title: "Detected values can be wrong",
    body: (
      <>
        <P>
          The details CPD Logger reads from a page, such as the title, provider, length, date or theme, are suggestions. Pages change, readers
          misread them, and some are guesses. Every suggestion carries a badge saying how it was found, but no badge is a guarantee.
        </P>
        <P>
          Check every detail before you save it. The hours are always your own figure: the length of a video or the reading time of a document is
          not the time you spent learning. Read the <Link href="/help#accuracy">Help page</Link> to see what each badge means and how well the
          readers have been tested.
        </P>
      </>
    ),
  },
  {
    id: "use",
    title: "Acceptable use",
    body: (
      <>
        <P>Please use CPD Logger for your own CPD record. You must not:</P>
        <UL>
          <li>use scripts, bots or other automated means to read links or use the service;</li>
          <li>try to get round the limits on link reading or on AI use, for example by making several accounts;</li>
          <li>try to reach anyone else's data, or to probe, overload or disrupt the service;</li>
          <li>use it to read pages you are not allowed to read, or to try to get past a site's blocks or login;</li>
          <li>sign in with an email address that is not yours, or save content that is unlawful.</li>
        </UL>
        <P>
          We may limit or close an account that breaks these terms.{" "}
          <Placeholder>[Owner to say whether and how much notice is given]</Placeholder>
        </P>
      </>
    ),
  },
  {
    id: "ai",
    title: "AI-assisted text",
    body: (
      <>
        <P>
          If the site owner has switched the AI feature on, “Expand my notes” turns your own short notes into draft learning points and
          benefits. It is meant to stay within what you wrote, but it can make mistakes or add things you did not say. The page warns you about
          numbers and names that are not in your notes, and it cannot catch everything.
        </P>
        <P>
          You must read and correct the text before you save it. The entry is marked as AI-assisted, and you are responsible for the wording you
          keep. Screenshot import works the same way: check every row before you import it.
        </P>
      </>
    ),
  },
  {
    id: "content",
    title: "Your content",
    body: (
      <>
        <P>
          Your entries and notes stay yours. By saving them you allow us to store and process them in order to run the service for you, as
          described in the <Link href="/privacy">privacy notice</Link>. You can download a copy or delete everything in{" "}
          <Link href="/settings#your-data">Settings</Link> at any time.
        </P>
      </>
    ),
  },
  {
    id: "availability",
    title: "Availability and limits",
    body: (
      <>
        <P>
          CPD Logger is provided as it is. To the extent the law allows, we give no warranty that it will always be available, that it will be
          free of errors, or that the readers will work on any particular site. We may change it, limit it or stop it.
        </P>
        <P>
          There are limits on how many links you can read in an hour and, if the AI feature is on, how many times you can use it in a month.
          Keep your own copy of your log: use “Download Excel file” on the <Link href="/export">Export</Link> page, or “Download all my data” in
          Settings, from time to time.
        </P>
      </>
    ),
  },
  {
    id: "liability",
    title: "Liability",
    body: (
      <>
        <P>
          <Placeholder>[Limitation of liability. To be written or checked by the site owner's legal adviser.]</Placeholder>
        </P>
        <P>Nothing in these terms limits liability that cannot be limited by law, such as for fraud, or for death or personal injury caused by negligence.</P>
      </>
    ),
  },
  {
    id: "ending",
    title: "Ending your use",
    body: (
      <>
        <P>
          You can stop at any time by deleting your account in <Link href="/settings#your-data">Settings</Link>. Deleting it removes your entries
          and settings.
        </P>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to these terms",
    body: (
      <>
        <P>
          We may update these terms. The effective date at the top of the page shows when they last changed.{" "}
          <Placeholder>[Owner to say how people will be told about important changes]</Placeholder>
        </P>
      </>
    ),
  },
  {
    id: "law",
    title: "Governing law and contact",
    body: (
      <>
        <P>
          <Placeholder>[Governing law: England and Wales - confirm]</Placeholder>
        </P>
        <P>
          Questions about these terms: <Placeholder>[Contact email]</Placeholder>
        </P>
      </>
    ),
  },
];
