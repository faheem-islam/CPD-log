import { Check } from "lucide-react";
import Link from "next/link";
import { profileLabel } from "@/lib/profiles";

/**
 * A two-way switch between the ICE and IStructE views. They are plain links to ?profile=..., so the
 * page is rendered on the server and works without any script. The current one carries aria-current.
 */
export function ProfileSwitch({ current }: { current: "ice" | "istructe" }) {
  const options = ["ice", "istructe"] as const;
  return (
    <nav aria-label="Choose a log">
      <ul role="list" className="inline-flex gap-1 rounded-xl bg-surface-2 p-1">
        {options.map((id) => {
          const active = id === current;
          return (
            <li key={id}>
              <Link
                href={`/dashboard?profile=${id}`}
                scroll={false}
                replace
                aria-current={active ? "page" : undefined}
                className={`flex min-h-tap min-w-[5.5rem] items-center justify-center rounded-lg px-4 text-base font-bold no-underline ${
                  active ? "bg-sign text-sign-ink" : "text-ink hover:bg-ink/10"
                }`}
              >
                {active && <Check aria-hidden="true" size={18} strokeWidth={3} className="mr-1.5 shrink-0" />}
                {profileLabel(id)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
