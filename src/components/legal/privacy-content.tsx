import Link from "next/link";
import type { LegalSectionDef } from "./legal-page";
import { P, Placeholder, UL } from "./prose";

/**
 * Privacy notice TEMPLATE (UK GDPR). The facts about what the app does are written from how the code works.
 * Everything in [square brackets] is for the site owner to decide, and the whole text needs checking by someone qualified.
 */
export const privacySections: LegalSectionDef[] = [
  {
    id: "who",
    title: "Who is responsible for your data",
    body: (
      <>
        <P>
          <Placeholder>[Organisation or owner name]</Placeholder>, of <Placeholder>[Registered address]</Placeholder>, runs CPD Logger and
          is the controller of the personal data described in this notice. That means it decides why and how the data is used.
        </P>
        <UL>
          <li>
            Contact: <Placeholder>[Contact email]</Placeholder>
          </li>
          <li>
            Data protection contact: <Placeholder>[Data protection contact]</Placeholder>
          </li>
        </UL>
      </>
    ),
  },
  {
    id: "data",
    title: "What data is held",
    body: (
      <>
        <UL>
          <li>
            <strong>Your sign-in email address.</strong> It is how you sign in and how we know which log is yours.
          </li>
          <li>
            <strong>Profile details you enter.</strong> Your name, job role, responsibilities and engineering sector (they appear at the top
            of your Excel file), which logs you keep, and the names of any custom fields you add.
          </li>
          <li>
            <strong>The CPD entries you save.</strong> The link, title, provider, type, dates, theme, your hours, and the notes and learning
            points you write, with a record of how each detail was found and whether the text was AI-assisted.
          </li>
          <li>
            <strong>AI usage counts.</strong> How many times you used the AI feature in each month, so the monthly limit can be applied. A
            count only: CPD Logger does not keep what was sent or what came back.
          </li>
          <li>
            <strong>An essential session cookie</strong> that keeps you signed in (see “Cookies and local storage” below).
          </li>
        </UL>
        <P>
          <strong>Nothing is stored from the pages we read beyond the details you save.</strong> We do not keep page text, transcripts, or
          the files and screenshots you upload to import a record. The details read from a link are held in the server's memory for about ten
          minutes so that reading the same link twice does not repeat the request, and are not written to the database.
        </P>
        <P>
          Our hosting provider keeps routine technical logs, such as IP addresses and request times, to run and protect the service.{" "}
          <Placeholder>[Owner to confirm what the host keeps and for how long]</Placeholder>
        </P>
        <P>
          Your entries are visible only to you. On the hosted version, the database is set up so that each signed-in person can read and change only their own rows.
          The people who run the site can technically reach the database to keep it working.{" "}
          <Placeholder>[Owner to confirm who has that access and what controls apply. If you set up an organisation workspace, say here what an administrator can see]</Placeholder>
        </P>
      </>
    ),
  },
  {
    id: "why",
    title: "Why we use it, and the lawful basis",
    body: (
      <>
        <P>
          We use your data only to run CPD Logger for you. We do not use it for advertising, we do not build profiles of you, and we do not
          make decisions about you by automated means. We do not sell it.
        </P>
        <UL>
          <li>
            <strong>To sign you in and keep your log.</strong> Lawful basis:{" "}
            <Placeholder>[Performance of a contract with you, UK GDPR Article 6(1)(b). Owner to confirm]</Placeholder>
          </li>
          <li>
            <strong>To read links, draft entries and produce your export.</strong> Lawful basis:{" "}
            <Placeholder>[Performance of a contract with you. Owner to confirm]</Placeholder>
          </li>
          <li>
            <strong>To keep the service secure and fair to everyone:</strong> limits on how many links and AI uses each person gets, and
            optional error monitoring. Lawful basis:{" "}
            <Placeholder>[Legitimate interests, UK GDPR Article 6(1)(f). Owner to confirm and record a balancing test]</Placeholder>
          </li>
          <li>
            <strong>To use the optional AI feature when you choose to.</strong> Lawful basis:{" "}
            <Placeholder>[Owner to confirm, for example contract, or consent given each time you press the button]</Placeholder>
          </li>
          <li>
            <strong>To answer your requests and meet legal duties.</strong> Lawful basis:{" "}
            <Placeholder>[Legal obligation, UK GDPR Article 6(1)(c). Owner to confirm]</Placeholder>
          </li>
        </UL>
      </>
    ),
  },
  {
    id: "sharing",
    title: "Who your data is sent to",
    body: (
      <>
        <P>We use a small number of other organisations to run the service. They act on our instructions and are called processors.</P>
        <UL>
          <li>
            <strong>Hosting and database.</strong> The site runs on <Placeholder>[Hosting provider]</Placeholder>, and its server functions
            are set to run in London. Where the site uses Supabase, the database and sign-in records are held in the UK (London region).{" "}
            <Placeholder>[Owner to confirm the regions in use and the provider's data processing terms]</Placeholder>
          </li>
          <li>
            <strong>Sign-in emails.</strong> If you sign in with an emailed link, your email address goes to{" "}
            <Placeholder>[Email sending provider]</Placeholder> so the link can be delivered.
          </li>
          <li>
            <strong>The AI provider, only if the AI feature is switched on, and only when you use it.</strong> When you press “Expand my
            notes”, we send the resource title, its provider, its type, its theme and the notes you typed. When you import from a screenshot, we
            send the screenshot you uploaded. We never send text copied from a web page. The provider is{" "}
            <Placeholder>[AI provider name]</Placeholder>.{" "}
            <Placeholder>[Owner to confirm where it processes data, how long it keeps it, whether it trains on it, and which safeguards apply if data leaves the UK]</Placeholder>
          </li>
          <li>
            <strong>Error monitoring, only if it is switched on.</strong> Error reports go to{" "}
            <Placeholder>[Error monitoring provider]</Placeholder> with request details, cookies and user information removed before they
            leave the server.
          </li>
          <li>
            <strong>The sites whose links you paste.</strong> To read a link, our server asks that site for the page (for a YouTube link, it
            asks YouTube's data service). The site sees a request from our server and an identifying name for the reader, not your name or
            email address.
          </li>
        </UL>
        <P>We do not sell or rent your data, and we do not share it for anyone else's marketing.</P>
      </>
    ),
  },
  {
    id: "tracking",
    title: "No advertising or analytics tracking",
    body: (
      <>
        <P>
          CPD Logger has no advertising, no analytics scripts and no tracking pixels, and it does not load anything from advertising or social
          networks. Fonts are served from this site, not from a third party.
        </P>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies and local storage",
    body: (
      <>
        <UL>
          <li>
            <strong>Session cookie (essential).</strong> Set when you sign in so that you stay signed in. It is removed when you sign out or
            when it expires. <Placeholder>[Owner to list the cookie names and lifetimes in use. With Supabase sign-in, the names start with “sb-”]</Placeholder>
          </li>
          <li>
            <strong>Theme preference (local storage).</strong> If you choose light or dark in the app, your choice is saved in your browser
            under the name “cpd-theme”. It stays on your device and is never sent to us.
          </li>
        </UL>
        <P>
          We set no non-essential cookies, so we do not show a cookie consent banner.{" "}
          <Placeholder>[Owner to confirm with your adviser that this is right for your use. Re-check it if you ever add analytics, advertising, embedded video or anything else that sets a cookie or stores data on a visitor's device]</Placeholder>
        </P>
      </>
    ),
  },
  {
    id: "keeping",
    title: "How long data is kept",
    body: (
      <>
        <P>Your data is kept until you delete it.</P>
        <UL>
          <li>
            When you delete an entry from your log, it is hidden from the log and from exports, but kept as a deleted record so that you can
            undo it. Deleted entries are included in “Download all my data”. They are removed for good when you delete your account.{" "}
            <Placeholder>[Owner to say whether deleted entries are also removed after a set time]</Placeholder>
          </li>
          <li>
            When you delete your account, your entries, settings, AI usage counts and sign-in record are deleted straight away. If the sign-in
            record cannot be removed automatically, the page tells you, and you can ask us to remove it.
          </li>
          <li>
            Backups: <Placeholder>[Owner to state how long backups are kept, if the database provider makes them]</Placeholder>
          </li>
        </UL>
      </>
    ),
  },
  {
    id: "rights",
    title: "Your rights, and how to use them",
    body: (
      <>
        <P>Under UK data protection law you can ask to see, correct, delete, restrict or move your data, and you can object to how it is used. Most of this you can do yourself:</P>
        <UL>
          <li>
            <strong>See and take a copy.</strong> In <Link href="/settings#your-data">Settings</Link>, choose “Download all my data”. You get
            one file with your settings and every entry, including deleted ones.
          </li>
          <li>
            <strong>Correct.</strong> Edit your details in <Link href="/settings">Settings</Link> and your entries in{" "}
            <Link href="/log">your log</Link>.
          </li>
          <li>
            <strong>Delete.</strong> In <Link href="/settings#your-data">Settings</Link>, choose “Delete my account”. It asks you to confirm,
            then removes everything.
          </li>
          <li>
            <strong>Anything else</strong>, such as restricting or objecting to a use, or a question about this notice: contact{" "}
            <Placeholder>[Data protection contact]</Placeholder>. We will answer within one month.
          </li>
        </UL>
        <P>
          If you are not happy with how your data has been handled, you can complain to the Information Commissioner's Office (ICO) at{" "}
          <a href="https://ico.org.uk/make-a-complaint/">ico.org.uk/make-a-complaint</a> or on 0303 123 1113. We would like the chance to put
          things right first, but you do not have to contact us before the ICO.
        </P>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to this notice",
    body: (
      <>
        <P>
          If we change how your data is used, we will update this page and its effective date{" "}
          <Placeholder>[Owner to say how people will be told about important changes]</Placeholder>. The{" "}
          <Link href="/terms">terms of use</Link> are a separate page.
        </P>
      </>
    ),
  },
];
