import { HelpCircle } from "lucide-react";
import Link from "next/link";
import { ThemeToggle } from "@/components/ui/theme-toggle";
import { Wordmark } from "@/components/ui/wordmark";
import { BottomNav, SideNav } from "./nav";

/**
 * Signed-in frame. Desktop: a dark-blue sidebar whose colour flows into the page header band (and,
 * on the dashboard, into the paste plate). Phone: a slim blue top bar and a bottom navigation bar
 * with 56px tap targets. The main landmark carries the page content.
 */
export function AppShell({
  email,
  modeLabel,
  children,
}: {
  email: string;
  modeLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[16.5rem_minmax(0,1fr)]">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-amber focus:px-4 focus:py-2 focus:text-[#14202b]">
        Skip to content
      </a>

      <aside className="chrome hidden lg:sticky lg:top-0 lg:flex lg:h-dvh lg:flex-col lg:gap-6 lg:p-5">
        <Wordmark />
        <SideNav />
        <div className="mt-auto space-y-2 text-sm">
          {modeLabel && <p className="rounded-lg bg-white/10 px-3 py-2 font-bold">{modeLabel}</p>}
          <p className="truncate px-1" title={email}>
            {email}
          </p>
          <div className="flex items-center justify-between">
            <ThemeToggle />
            <form action="/api/auth/sign-out" method="post">
              <button type="submit" className="btn btn-quiet !text-sign-ink">
                Sign out
              </button>
            </form>
          </div>
        </div>
      </aside>

      <div className="min-w-0">
        <header className="chrome flex items-center justify-between px-4 py-1 lg:hidden">
          <Wordmark />
          <div className="flex items-center">
            <ThemeToggle className="!text-sign-ink" />
            <Link href="/help" className="btn btn-quiet !px-0 !text-sign-ink" aria-label="Help">
              <HelpCircle aria-hidden="true" size={22} />
            </Link>
          </div>
        </header>
        <main id="main" tabIndex={-1} className="min-w-0 pb-28 lg:pb-12">
          {children}
        </main>
      </div>
      <BottomNav />
    </div>
  );
}

/**
 * Page header band. On desktop it continues the sidebar's blue; children (such as the paste plate)
 * sit inside it and overlap into the page below.
 */
export function PageHeader({ title, intro, children }: { title: string; intro?: string; children?: React.ReactNode }) {
  return (
    <div className="chrome px-4 pb-8 pt-6 sm:px-8 lg:pt-10">
      <div className="mx-auto max-w-page">
        <h1 className="!text-sign-ink">{title}</h1>
        {intro && <p className="mt-1 max-w-2xl text-base opacity-90">{intro}</p>}
        {children}
      </div>
    </div>
  );
}

export function PageBody({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`mx-auto max-w-page px-4 py-6 sm:px-8 ${className}`}>{children}</div>;
}
