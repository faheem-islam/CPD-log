import { Prose } from "@/components/legal/prose";
import { helpTitle, type HelpSectionId } from "./sections";

/** One chapter of the Help page: a tonal band with an anchor, so the contents list and shared links can jump to it. */
export function HelpSection({ id, children }: { id: HelpSectionId; children: React.ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-heading`} className="band min-w-0 scroll-mt-6 space-y-4">
      <h2 id={`${id}-heading`}>{helpTitle(id)}</h2>
      <Prose>{children}</Prose>
    </section>
  );
}
