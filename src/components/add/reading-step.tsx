"use client";

import type { RefObject } from "react";
import { LoadingRegion, Skeleton } from "@/components/ui/skeleton";
import { ManualLink } from "./manual-link";

/** Step 2: reading the page. Cancellable, and the manual form is one link away. */
export function ReadingStep({
  url,
  headingRef,
  onCancel,
  onManual,
}: {
  url: string;
  headingRef: RefObject<HTMLHeadingElement | null>;
  onCancel: () => void;
  onManual: () => void;
}) {
  return (
    <div className="band space-y-5">
      <div>
        <h2 ref={headingRef} tabIndex={-1}>
          Reading the link
        </h2>
        <p className="mt-1 text-sm text-muted [overflow-wrap:anywhere]">{url}</p>
      </div>
      <LoadingRegion label="Reading the link. This can take a few seconds.">
        <div className="space-y-4">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-4 w-20" />
          <Skeleton className="h-11 w-2/3" />
          <Skeleton className="h-4 w-28" />
          <Skeleton className="h-11 w-full" />
        </div>
      </LoadingRegion>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <button type="button" className="btn btn-secondary" onClick={onCancel}>
          Cancel
        </button>
        <ManualLink onClick={onManual} />
      </div>
    </div>
  );
}
