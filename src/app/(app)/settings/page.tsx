import type { Metadata } from "next";
import { Appearance } from "@/components/settings/appearance";
import { FeaturesList, type AiUsageStatus } from "@/components/settings/features-list";
import { SettingsSection } from "@/components/settings/section";
import { SettingsForm } from "@/components/settings/settings-form";
import { YourData } from "@/components/settings/your-data";
import { PageBody, PageHeader } from "@/components/shell/app-shell";
import { requirePageContext } from "@/lib/auth/context";
import { monthKeyUk, nextResetLabel } from "@/lib/llm";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const ctx = await requirePageContext();
  const { features } = ctx;
  const now = new Date();

  // How much of this month's AI allowance has gone. If the store cannot say, the page still loads.
  let usage: AiUsageStatus | null = null;
  if (features.ai && features.aiMonthlyCap > 0) {
    try {
      const u = await ctx.store.getAiUsage(ctx.user.id, monthKeyUk(now), features.aiMonthlyCap);
      usage = { used: u.used, cap: u.cap, resetsOn: nextResetLabel(now) };
    } catch {
      usage = null;
    }
  }

  return (
    <>
      <PageHeader title="Settings" intro="Your details for the ICE export, the logs you keep, and how the app looks." />
      <PageBody className="reveal space-y-4">
        <SettingsForm initial={ctx.settings} />

        <SettingsSection
          id="features"
          title="Optional features"
          intro="What this site has switched on. Whoever runs the site sets these, so they are for information only."
        >
          <FeaturesList
            features={{
              ai: features.ai,
              youtubeApi: features.youtubeApi,
              sentry: features.sentry,
              mode: features.mode,
              aiMonthlyCap: features.aiMonthlyCap,
            }}
            usage={usage}
          />
        </SettingsSection>

        <SettingsSection id="appearance" title="Appearance" intro="Light, dark, or whatever your device is set to.">
          <Appearance />
        </SettingsSection>

        <SettingsSection id="your-data" title="Your data" intro="Take a copy of everything, sign out, or delete your account.">
          <YourData email={ctx.user.email} />
        </SettingsSection>
      </PageBody>
    </>
  );
}
