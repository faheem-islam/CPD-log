import type { Metadata } from "next";
import { FirstSteps } from "@/components/dashboard/first-steps";
import { PasteBox } from "@/components/dashboard/paste-box";
import { ProfileSwitch } from "@/components/dashboard/profile-switch";
import { CustomNote, HoursStat, IceHoursNote, IcePanel, IstructePanel } from "@/components/dashboard/progress-panels";
import { RecentEntries, type RecentEntry } from "@/components/dashboard/recent-entries";
import { chooseView } from "@/components/dashboard/view";
import { PageBody, PageHeader } from "@/components/shell/app-shell";
import { requirePageContext } from "@/lib/auth/context";
import { hoursInYear, iceProgress, istructeProgress } from "@/lib/compliance";
import { currentYearUk } from "@/lib/dates";
import { profileLabel } from "@/lib/profiles";

export const metadata: Metadata = { title: "Dashboard" };

const RECENT_COUNT = 5;

export default async function DashboardPage({ searchParams }: { searchParams: Promise<{ profile?: string | string[] }> }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const requested = Array.isArray(sp.profile) ? sp.profile[0] : sp.profile;

  // Live entries, newest first. Only the few fields the page shows go into the markup.
  const entries = await ctx.store.listEntries(ctx.user.id);
  const year = currentYearUk();
  const { view, canSwitch } = chooseView(ctx.settings.activeProfiles, requested);

  const recent: RecentEntry[] = entries
    .filter((e) => ctx.settings.activeProfiles.includes(e.profile))
    .slice(0, RECENT_COUNT)
    .map((e) => ({ id: e.id, title: e.title, dateCompleted: e.dateCompleted, hours: e.hours, profile: e.profile }));

  const ice = view === "ice" ? iceProgress(entries, year) : null;
  const istructe = view === "istructe" ? istructeProgress(entries, year) : null;
  const hours =
    ice?.hoursThisYear ??
    istructe?.annual.hours ??
    hoursInYear(
      entries.filter((e) => e.profile === "custom"),
      year,
    );

  return (
    <>
      <PageHeader title="Dashboard">
        {/* The plate hangs a little below the blue band, so it reads as a sign on a gantry. */}
        <div className="-mb-14 mt-4">
          <PasteBox />
        </div>
      </PageHeader>

      <PageBody className="reveal space-y-10 !pt-14">
        {entries.length === 0 && <FirstSteps />}

        <section aria-labelledby="year-heading" className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
            <h2 id="year-heading">
              Your {profileLabel(view)} log in {year}
            </h2>
            {canSwitch && (view === "ice" || view === "istructe") && <ProfileSwitch current={view} />}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] lg:items-start">
            <div className="min-w-0 lg:col-start-2 lg:row-start-1">
              <HoursStat hours={hours} year={year} logLabel={`${profileLabel(view)} log`}>
                {ice && <IceHoursNote progress={ice} />}
              </HoursStat>
            </div>
            <div className="min-w-0 lg:col-start-1 lg:row-start-1">
              {ice && <IcePanel progress={ice} />}
              {istructe && <IstructePanel progress={istructe} />}
              {view === "custom" && <CustomNote />}
            </div>
          </div>
        </section>

        {entries.length > 0 && <RecentEntries entries={recent} />}
      </PageBody>
    </>
  );
}
