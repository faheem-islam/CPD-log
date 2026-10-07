"use client";

import { FileDown, HelpCircle, LayoutDashboard, ListChecks, PlusCircle, Settings, Upload } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const MAIN = [
  { href: "/dashboard", label: "Home", Icon: LayoutDashboard },
  { href: "/add", label: "Add", Icon: PlusCircle },
  { href: "/log", label: "Log", Icon: ListChecks },
  { href: "/export", label: "Export", Icon: FileDown },
  { href: "/settings", label: "Settings", Icon: Settings },
] as const;

const MORE = [
  { href: "/import", label: "Import", Icon: Upload },
  { href: "/help", label: "Help", Icon: HelpCircle },
] as const;

function isCurrent(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function SideNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Main" className="flex flex-col gap-1">
      {[...MAIN, ...MORE].map(({ href, label, Icon }) => (
        <Link key={href} href={href} className="nav-link" aria-current={isCurrent(pathname, href) ? "page" : undefined}>
          <Icon aria-hidden="true" size={22} />
          {label === "Home" ? "Dashboard" : label}
        </Link>
      ))}
    </nav>
  );
}

export function BottomNav() {
  const pathname = usePathname() ?? "";
  return (
    <nav aria-label="Main" className="chrome fixed inset-x-0 bottom-0 z-40 pb-[env(safe-area-inset-bottom)] lg:hidden">
      <ul className="mx-auto grid max-w-lg grid-cols-5">
        {MAIN.map(({ href, label, Icon }) => (
          <li key={href} className="min-w-0">
            <Link
              href={href}
              className="nav-link flex-col justify-center gap-0.5 !rounded-none !px-1 !py-2 text-xs"
              style={{ minHeight: "3.5rem" }}
              aria-current={isCurrent(pathname, href) ? "page" : undefined}
            >
              <Icon aria-hidden="true" size={24} />
              <span>{label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}
