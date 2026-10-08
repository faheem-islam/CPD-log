import { ArrowLeft, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { PageBody, PageHeader } from "@/components/shell/app-shell";
import { Wordmark } from "@/components/ui/wordmark";
import { Contents } from "./contents";
import { Placeholder, Prose } from "./prose";

export interface LegalSectionDef {
  id: string;
  title: string;
  body: React.ReactNode;
}

/**
 * The frame for Privacy and Terms. They are public, so there is no sidebar: a slim blue bar with the wordmark and a way
 * back (to sign-in for a visitor, to the app for someone signed in), the usual blue page header, then the text at a readable width with a contents list beside it.
 *
 * Both documents are TEMPLATES. The notice below stays at the top until the site owner has filled in every
 * bracketed placeholder and had the text checked; to remove it, delete the <TemplateNotice /> line.
 */
export function LegalPage({
  title,
  intro,
  sections,
  other,
  signedIn = false,
}: {
  title: string;
  intro: string;
  sections: LegalSectionDef[];
  /** A link to the other legal page, shown in the footer. */
  other: { href: string; label: string };
  /** Signed-in people get a way back into the app; visitors get a way back to sign-in. */
  signedIn?: boolean;
}) {
  const home = signedIn ? "/dashboard" : "/sign-in";
  const homeLabel = signedIn ? "Back to the app" : "Back to sign in";
  return (
    <div className="min-h-dvh">
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-amber focus:px-4 focus:py-2 focus:text-[#14202b]"
      >
        Skip to content
      </a>
      <header className="chrome px-4 sm:px-8">
        <div className="mx-auto flex max-w-page items-center justify-between gap-3 py-1">
          <Wordmark href={home} />
          <Link href={home} className="btn btn-quiet !text-sign-ink">
            <ArrowLeft aria-hidden="true" size={20} />
            {homeLabel}
          </Link>
        </div>
      </header>

      <main id="main" tabIndex={-1} className="min-w-0">
        <PageHeader title={title} intro={intro} />
        <PageBody className="space-y-8">
          <TemplateNotice />
          <div className="grid grid-cols-1 gap-8 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)] lg:gap-12">
            <Contents items={sections} numbered collapsible />
            <article className="reveal min-w-0 max-w-[46rem] space-y-10">
              <p className="text-muted">
                Effective date: <Placeholder>[Effective date]</Placeholder>
              </p>
              {sections.map((s, i) => (
                <section key={s.id} id={s.id} aria-labelledby={`${s.id}-heading`} className="scroll-mt-6">
                  <h2 id={`${s.id}-heading`} className="mb-3 flex items-baseline gap-3">
                    <span aria-hidden="true" className="num min-w-[1.5rem] text-muted">
                      {i + 1}
                    </span>
                    <span className="min-w-0">{s.title}</span>
                  </h2>
                  <Prose>{s.body}</Prose>
                </section>
              ))}
            </article>
          </div>
        </PageBody>
      </main>

      <footer className="mx-auto flex max-w-page flex-wrap items-center gap-x-6 gap-y-1 px-4 pb-10 pt-2 text-base sm:px-8">
        <Link href={home} className="inline-flex min-h-tap items-center">
          {homeLabel}
        </Link>
        <Link href={other.href} className="inline-flex min-h-tap items-center">
          {other.label}
        </Link>
        {signedIn && (
          <Link href="/help" className="inline-flex min-h-tap items-center">
            Help
          </Link>
        )}
      </footer>
    </div>
  );
}

/** Shown on both pages until the site owner has completed and checked them. */
function TemplateNotice() {
  return (
    <div className="notice notice-warn flex max-w-3xl gap-3">
      <TriangleAlert aria-hidden="true" size={22} className="mt-0.5 shrink-0" />
      <div className="min-w-0 space-y-1">
        <p className="font-bold">This is a template for the site owner to complete and have checked. It is not legal advice.</p>
        <p>
          Replace each <Placeholder>[bracketed placeholder]</Placeholder> with the real detail, then remove this notice before the
          site goes live.
        </p>
      </div>
    </div>
  );
}
