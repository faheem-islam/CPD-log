import Link from "next/link";

/**
 * "Fill in by hand": every step offers it. It is a real link (so it is a link for keyboards and screen readers),
 * but a plain click keeps the person on the page and swaps in the manual form. Control, Command, Shift and
 * middle clicks are left to the browser, so "open in a new tab" still opens /add?manual=1.
 */
export function ManualLink({ onClick, className = "" }: { onClick: () => void; className?: string }) {
  return (
    <Link
      href="/add?manual=1"
      className={className}
      onClick={(e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        e.preventDefault();
        onClick();
      }}
    >
      Fill in by hand
    </Link>
  );
}
