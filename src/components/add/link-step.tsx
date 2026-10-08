"use client";

import { ArrowRight } from "lucide-react";
import type { RefObject } from "react";
import { ManualLink } from "./manual-link";

/**
 * Step 1: the paste box as a road-sign plate. The label is the plate's heading, so the box is named
 * "Paste a link". One primary action: Read link.
 */
export function LinkStep({
  link,
  onLinkChange,
  onSubmit,
  error,
  inputRef,
  onManual,
}: {
  link: string;
  onLinkChange: (v: string) => void;
  onSubmit: () => void;
  error: string | null;
  inputRef: RefObject<HTMLInputElement | null>;
  onManual: () => void;
}) {
  return (
    <div>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="plate">
          <label htmlFor="add-link" className="block font-display text-2xl font-bold sm:text-3xl">
            Paste a link
          </label>
          <p id="add-link-hint" className="mt-1 max-w-xl text-base">
            A video, article, webinar or document. We read the title, provider and length for you to check.
          </p>
          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-start">
            <input
              ref={inputRef}
              id="add-link"
              name="link"
              type="text"
              inputMode="url"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              className="input min-w-0 sm:flex-1"
              placeholder="https://"
              value={link}
              onChange={(e) => onLinkChange(e.target.value)}
              aria-describedby={error ? "add-link-hint add-link-error" : "add-link-hint"}
              aria-invalid={error ? true : undefined}
            />
            <button type="submit" className="btn btn-amber w-full sm:w-auto sm:shrink-0">
              Read link
              <ArrowRight aria-hidden="true" size={20} />
            </button>
          </div>
        </div>
      </form>
      {error && (
        <p id="add-link-error" className="notice notice-error mt-3" role="alert">
          {error}
        </p>
      )}
      <p className="mt-4 px-1">
        No link to hand? <ManualLink onClick={onManual} />
      </p>
    </div>
  );
}
