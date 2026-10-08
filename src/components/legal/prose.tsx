/**
 * Small building blocks for reading text (Help, Privacy, Terms). Lines stop at about 65 characters so a long
 * page stays easy to read on a wide screen. No colours or borders: structure comes from spacing and type.
 */

/** A run of text. Wrap a section's content in this so paragraphs, lists and sub-headings share one rhythm. */
export function Prose({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <div className={`space-y-3 text-base [&>h3]:pt-3 [&>h3:first-child]:pt-0 ${className}`}>{children}</div>;
}

export function P({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <p className={`max-w-[65ch] ${className}`}>{children}</p>;
}

export function UL({ children }: { children: React.ReactNode }) {
  return <ul className="max-w-[65ch] list-disc space-y-2 pl-6 marker:text-muted">{children}</ul>;
}

export function OL({ children }: { children: React.ReactNode }) {
  return <ol className="max-w-[65ch] list-decimal space-y-2 pl-6 marker:font-bold marker:text-muted">{children}</ol>;
}

/**
 * A detail the site owner has to fill in. It is bracketed in the text and tinted, so it cannot be mistaken for
 * finished wording. The tint is amber with the normal ink colour on top, which keeps the text readable in both themes.
 */
export function Placeholder({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded bg-amber/30 px-1 font-medium text-ink [box-decoration-break:clone] [-webkit-box-decoration-break:clone]">
      {children}
    </span>
  );
}
