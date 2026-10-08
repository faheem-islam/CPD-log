import { FileDown, Plus, Upload } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { LogView } from "@/components/log/log-view";
import { toLogEntry } from "@/components/log/log-filters";
import { PageBody, PageHeader } from "@/components/shell/app-shell";
import { requirePageContext } from "@/lib/auth/context";
import { todayUk } from "@/lib/dates";

export const metadata: Metadata = { title: "Your log" };
export const dynamic = "force-dynamic";

const PARAMS = ["q", "year", "log", "theme", "type", "sort"] as const;

export default async function LogPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requirePageContext();
  const sp = await searchParams;
  const entries = await ctx.store.listEntries(ctx.user.id);

  // The filters in the address, handed on so the first paint already shows them.
  const initial = new URLSearchParams();
  for (const key of PARAMS) {
    const raw = sp[key];
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (value) initial.set(key, value);
  }

  return (
    <>
      <PageHeader title="Your log" intro="Search every entry you've saved, change a detail, or take one out.">
        <div className="mt-4 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          <Link href="/add" className="btn btn-amber col-span-2 !text-[#14202b] sm:col-auto">
            <Plus aria-hidden="true" size={20} />
            Add an entry
          </Link>
          <Link href="/import" className="btn bg-white/15 hover:bg-white/25">
            <Upload aria-hidden="true" size={20} />
            <span>
              Import<span className="hidden sm:inline"> entries</span>
            </span>
          </Link>
          <Link href="/export" className="btn bg-white/15 hover:bg-white/25">
            <FileDown aria-hidden="true" size={20} />
            <span>
              Export<span className="hidden sm:inline"> to Excel</span>
            </span>
          </Link>
        </div>
      </PageHeader>
      <PageBody>
        <LogView
          entries={entries.map(toLogEntry)}
          customFields={ctx.settings.customFields}
          todayIso={todayUk()}
          initialQuery={initial.toString()}
        />
      </PageBody>
    </>
  );
}
