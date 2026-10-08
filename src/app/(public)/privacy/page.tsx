import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { isSignedIn } from "@/components/legal/signed-in";
import { privacySections } from "@/components/legal/privacy-content";

export const metadata: Metadata = { title: "Privacy notice" };

export default async function PrivacyPage() {
  const signedIn = await isSignedIn();
  return (
    <LegalPage
      title="Privacy notice"
      intro="What personal data CPD Logger holds, why, who it goes to, and how to see it, take it away or delete it."
      sections={privacySections}
      signedIn={signedIn}
      other={{ href: "/terms", label: "Terms of use" }}
    />
  );
}
