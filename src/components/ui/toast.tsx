"use client";

import { X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";

type Tone = "info" | "ok" | "error";

export interface ToastOptions {
  message: string;
  tone?: Tone;
  /** An action such as Undo. */
  action?: { label: string; onClick: () => void | Promise<void> };
  /** Milliseconds. Errors and actions stay longer. */
  durationMs?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
}

const ToastContext = createContext<{ toast: (t: ToastOptions) => void } | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>.");
  return ctx;
}

const TONE: Record<Tone, string> = {
  info: "bg-sign text-sign-ink",
  ok: "bg-route text-on-route",
  error: "bg-danger text-on-danger",
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const timers = useRef(new Map<number, ReturnType<typeof setTimeout>>());

  const dismiss = useCallback((id: number) => {
    const t = timers.current.get(id);
    if (t) clearTimeout(t);
    timers.current.delete(id);
    setItems((list) => list.filter((i) => i.id !== id));
  }, []);

  const toast = useCallback(
    (opts: ToastOptions) => {
      const id = nextId.current++;
      setItems((list) => [...list.slice(-3), { ...opts, id }]);
      const ms = opts.durationMs ?? (opts.action ? 10000 : opts.tone === "error" ? 9000 : 5000);
      timers.current.set(id, setTimeout(() => dismiss(id), ms));
    },
    [dismiss],
  );

  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-24 z-50 flex flex-col items-center gap-2 px-4 lg:bottom-6"
        role="region"
        aria-label="Notifications"
        aria-live="polite"
      >
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={`pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl px-4 py-2 text-base font-bold ${TONE[t.tone ?? "info"]}`}
          >
            <span className="min-w-0 flex-1">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className="min-h-tap min-w-tap rounded-lg px-3 font-bold underline"
                onClick={async () => {
                  await t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button type="button" className="flex min-h-tap min-w-tap items-center justify-center rounded-lg" onClick={() => dismiss(t.id)} aria-label="Dismiss message">
              <X aria-hidden="true" size={20} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
