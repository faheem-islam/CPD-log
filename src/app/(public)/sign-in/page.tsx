import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { SignInForm } from "@/components/auth/sign-in-form";
import { Wordmark } from "@/components/ui/wordmark";
import { safeNext } from "@/lib/auth/safe-next";
import { getOptionalContext } from "@/lib/auth/context";
import { getEnv, storeMode } from "@/lib/env";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function SignInPage({ searchParams }: { searchParams: Promise<{ next?: string; error?: string }> }) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  // Someone who is already signed in goes where they asked, not always to the dashboard.
  if (await getOptionalContext()) redirect(next);
  const mode = storeMode(getEnv());

  return (
    <div className="chrome min-h-dvh px-4 py-8 sm:py-14">
      <div className="mx-auto max-w-md">
        <Wordmark href="/sign-in" />
        <div className="reveal mt-8 space-y-4">
          <div className="plate">
            <h1 className="!text-sign-ink">Sign in to CPD Logger</h1>
            <p className="mt-2 text-base opacity-95">Paste a link, confirm the details, and keep your CPD record in one place.</p>
          </div>
          <div className="band text-ink">
            {sp.error === "link" && (
              <p className="notice notice-error mb-4" role="alert">
                That sign-in link didn't work. It may have expired. Enter your email to get a new one.
              </p>
            )}
            <SignInForm mode={mode} next={next} />
            {mode === "local" && (
              <p className="notice notice-warn mt-4 text-sm">
                <strong>Local demo mode.</strong> Anyone who types an email address gets in, and nothing proves who they are. Use this to try the app, not to keep real records on a shared server.
              </p>
            )}
          </div>
          <p className="text-center text-sm text-sign-ink">
            By signing in you agree to the <Link href="/terms" className="!text-sign-ink">terms</Link> and the{" "}
            <Link href="/privacy" className="!text-sign-ink">privacy notice</Link>.
          </p>
        </div>
      </div>
    </div>
  );
}
