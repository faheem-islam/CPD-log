"use client";

import { ArrowRight, CircleAlert } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useRef, useState, useTransition } from "react";
import { addPathFor, checkPastedLink } from "./check-link";

/**
 * The paste box, drawn as a UK road-sign plate. The heading is also the label of the field, so there is
 * one visible "Paste a link" that names both. Submitting sends the person to the Add page with the link;
 * the Add page does the reading. Nothing is saved from here.
 */
export function PasteBox() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [opening, startTransition] = useTransition();
  const uid = useId();
  const inputId = `paste-url-${uid}`;
  const hintId = `paste-hint-${uid}`;
  const errorId = `paste-error-${uid}`;

  function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (opening) return;
    const result = checkPastedLink(value);
    if (!result.ok) {
      setError(result.message);
      inputRef.current?.focus();
      return;
    }
    setError(null);
    setValue(result.url);
    startTransition(() => router.push(addPathFor(result.url)));
  }

  return (
    <div className="plate">
      <h2 className="font-display text-2xl font-bold !text-sign-ink sm:text-3xl">
        <label htmlFor={inputId}>Paste a link</label>
      </h2>
      <p id={hintId} className="mt-1 max-w-2xl text-base opacity-95">
        A video, webinar, article or document. We read the page and fill in what we can. You check every detail before anything is saved.
      </p>

      {/* With scripts off, or before they have loaded, the form still works: it opens the Add page with the link. */}
      <form action="/add" method="get" onSubmit={submit} noValidate className="mt-5" aria-busy={opening || undefined}>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            ref={inputRef}
            id={inputId}
            name="url"
            type="url"
            inputMode="url"
            autoComplete="off"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="https://"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
            className="input min-h-[3.5rem] min-w-0 flex-1 !bg-white px-4 text-lg !text-[#14202b] placeholder:!text-[#4c5b69] [box-shadow:inset_0_-3px_0_#9db3d6]"
          />
          <button type="submit" className="btn btn-amber min-h-[3.5rem] px-7 text-lg" disabled={opening}>
            Read link
            <ArrowRight aria-hidden="true" size={22} strokeWidth={2.75} />
          </button>
        </div>

        <div role="alert">
          {error && (
            <p
              id={errorId}
              className="mt-3 flex items-start gap-2 rounded-lg bg-white px-3 py-2 text-base font-bold text-[#8f1d16]"
            >
              <CircleAlert aria-hidden="true" size={20} className="mt-0.5 shrink-0" />
              <span className="min-w-0">{error}</span>
            </p>
          )}
        </div>
        <p role="status" className="sr-only">
          {opening ? "Opening the Add page" : ""}
        </p>
      </form>

      <p className="mt-2">
        <Link href="/add?manual=1" className="inline-flex min-h-tap items-center font-bold !underline">
          Fill in by hand instead
        </Link>
      </p>
    </div>
  );
}
