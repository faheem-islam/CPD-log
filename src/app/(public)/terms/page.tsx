import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";
import { isSignedIn } from "@/components/legal/signed-in";
import { termsSections } from "@/components/legal/terms-content";

export const metadata: Metadata = { title: "Terms of use" };

export default async function TermsPage() {
  const signedIn = await isSignedIn();
  return (
    <LegalPage
      title="Terms of use"
      intro="The ground rules for using CPD Logger, and what it does and does not do for you."
      sections={termsSections}
      signedIn={signedIn}
      other={{ href: "/privacy", label: "Privacy notice" }}
    />
  );
}
