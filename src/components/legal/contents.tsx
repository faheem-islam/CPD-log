import { ChevronDown } from "lucide-react";

export interface ContentsItem {
  id: string;
  title: string;
}

/**
 * The in-page contents list. A column to the left of the text on a wide screen (it stays in view while
 * you read), and a list above the text on a phone or tablet. Plain links to anchors, so it works with the keyboard
 * and without any script.
 *
 * `collapsible` is for long documents: below the large breakpoint the list sits inside a disclosure that starts closed,
 * so a phone shows the text sooner. Only one of the two lists is ever on screen (the other is display: none, so
 * assistive technology does not see it either).
 */
export function Contents({
  items,
  numbered = false,
  sideFrom = "lg",
  collapsible = false,
}: {
  items: ContentsItem[];
  numbered?: boolean;
  /** The screen width from which the list sits beside the text. Pages with a sidebar need "xl". */
  sideFrom?: "lg" | "xl";
  collapsible?: boolean;
}) {
  // Full class names, so Tailwind can see them.
  const sticky = sideFrom === "xl" ? "xl:sticky xl:top-6 xl:self-start" : "lg:sticky lg:top-6 lg:self-start";
  const columns = sideFrom === "xl" ? "sm:grid-cols-2 xl:grid-cols-1" : "sm:grid-cols-2 lg:grid-cols-1";

  const list = (
    <ol className={`grid grid-cols-1 gap-x-4 gap-y-0.5 ${columns}`}>
      {items.map((item, i) => (
        <li key={item.id}>
          <a
            href={`#${item.id}`}
            className="flex min-h-tap items-center gap-3 rounded-xl px-3 py-2 text-base font-bold leading-snug text-ink no-underline hover:bg-ink/5"
          >
            {numbered && (
              <span aria-hidden="true" className="num w-5 shrink-0 text-right font-display text-lg text-muted">
                {i + 1}
              </span>
            )}
            <span className="min-w-0">{item.title}</span>
          </a>
        </li>
      ))}
    </ol>
  );

  if (collapsible && sideFrom === "lg") {
    return (
      <>
        <details className="group min-w-0 rounded-xl bg-surface-2 lg:hidden">
          <summary className="flex min-h-tap cursor-pointer list-none items-center justify-between gap-3 rounded-xl px-4 py-2 font-bold [&::-webkit-details-marker]:hidden">
            <span className="min-w-0">On this page</span>
            <ChevronDown aria-hidden="true" size={20} className="shrink-0 group-open:rotate-180" />
          </summary>
          <nav aria-label="On this page" className="px-1 pb-3">
            {list}
          </nav>
        </details>
        <nav aria-label="On this page" className={`hidden min-w-0 lg:block ${sticky}`}>
          <p className="eyebrow mb-2 px-3">On this page</p>
          {list}
        </nav>
      </>
    );
  }

  return (
    <nav aria-label="On this page" className={`min-w-0 ${sticky}`}>
      <p className="eyebrow mb-2 px-3">On this page</p>
      {list}
    </nav>
  );
}
