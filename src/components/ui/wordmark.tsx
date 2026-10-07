import Link from "next/link";

/** The CPD Logger mark: a small gantry sign. Decorative, so hidden from assistive tech. */
export function Wordmark({ href = "/dashboard" }: { href?: string }) {
  return (
    <Link href={href} className="flex min-h-tap items-center gap-2 no-underline" aria-label="CPD Logger home">
      <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden="true" focusable="false">
        <rect x="1.5" y="5" width="27" height="16" rx="3.5" fill="none" stroke="currentColor" strokeWidth="2.5" />
        <path d="M9 13h12M17 9l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 21v6M22 21v6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <span className="font-display text-xl font-extrabold leading-none tracking-tight">CPD Logger</span>
    </Link>
  );
}
