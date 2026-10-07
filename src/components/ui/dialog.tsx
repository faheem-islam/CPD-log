"use client";

import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";

/**
 * A modal built on the native <dialog>, which traps focus, closes on Escape and restores focus
 * to the control that opened it.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onCancel={onClose}
      className="m-auto w-[min(40rem,calc(100vw-1.5rem))] max-h-[calc(100dvh-1.5rem)] overflow-y-auto rounded-2xl bg-surface p-0 text-ink backdrop:bg-black/60"
    >
      {open && (
        <div className="p-5 sm:p-7">
          <div className="mb-4 flex items-start justify-between gap-3">
            <h2 id={titleId}>{title}</h2>
            <button type="button" className="btn btn-quiet !px-2" onClick={onClose} aria-label="Close">
              <X aria-hidden="true" size={22} />
            </button>
          </div>
          {children}
        </div>
      )}
    </dialog>
  );
}
