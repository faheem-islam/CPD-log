"use client";

import { Download, LogOut, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@/components/ui/dialog";
import { api, ApiClientError } from "@/lib/api/client";

type Phase = "ask" | "deleting" | "done";

/**
 * Your data: a download of everything held for this person, a sign-out for phones (where the page frame has none),
 * and the danger zone. Deleting is permanent, so it asks first in a dialog, says what will go, and recommends a copy.
 */
export function YourData({ email }: { email: string }) {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("ask");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [partial, setPartial] = useState(false);
  // Changed only to put the dialog back if the browser closed it while the deletion was running.
  const [dialogKey, setDialogKey] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    },
    [],
  );

  function goToSignIn() {
    if (redirectTimer.current) clearTimeout(redirectTimer.current);
    window.location.assign("/sign-in");
  }

  /** Called by Escape, the X button and "Keep my account". `e` is the browser's event when there is one. */
  function close(e?: React.SyntheticEvent) {
    // Once the request has gone to the server it cannot be called back, so Escape and the X must not look like a cancel.
    // The dialog stays up and says so, and whatever the outcome is, it is shown here.
    if (phase === "deleting") {
      e?.preventDefault();
      // Some browsers close a dialog on a second Escape even when the first was stopped. Show it again.
      const dialog = rootRef.current?.querySelector("dialog");
      if (dialog && !dialog.open) setDialogKey((k) => k + 1);
      return;
    }
    // Once the account is gone there is nothing to come back to.
    if (phase === "done") {
      goToSignIn();
      return;
    }
    setOpen(false);
    setError(null);
  }

  async function confirmDelete() {
    if (phase === "deleting") return;
    setPhase("deleting");
    setError(null);
    try {
      const res = await api<{ deleted: "everything" | "data_only"; message: string }>("/api/account/delete", {
        method: "POST",
        json: { confirm: true },
      });
      setMessage(res.message);
      setPartial(res.deleted === "data_only");
      setPhase("done");
      // Long enough to read a short message; longer when there is something to act on.
      redirectTimer.current = setTimeout(goToSignIn, res.deleted === "data_only" ? 12000 : 3000);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong. Nothing was deleted. Try again.");
      setPhase("ask");
    }
  }

  return (
    <div ref={rootRef} className="space-y-5">
      <div className="space-y-3 rounded-xl bg-surface-2 px-4 py-4">
        <h3>Download a copy</h3>
        <p className="max-w-prose text-base text-muted">
          Everything we hold for you in one file: your settings and every entry, including ones you have deleted. It is for your own
          backup.
        </p>
        <a href="/api/account/export" download className="btn btn-secondary">
          <Download aria-hidden="true" size={20} />
          Download all my data
        </a>
      </div>

      <div className="space-y-3 rounded-xl bg-surface-2 px-4 py-4">
        <h3>Signed in as</h3>
        <p className="text-base [overflow-wrap:anywhere]">{email}</p>
        <form action="/api/auth/sign-out" method="post">
          <button type="submit" className="btn btn-secondary">
            <LogOut aria-hidden="true" size={18} />
            Sign out
          </button>
        </form>
      </div>

      <div className="space-y-3 rounded-xl bg-surface-2 px-4 py-4">
        <h3>Delete your account</h3>
        <p className="max-w-prose text-base">
          This permanently removes your account, every entry and your settings. It cannot be undone, so download a copy first if you want to
          keep your record.
        </p>
        <button
          type="button"
          className="btn btn-danger"
          onClick={() => {
            setPhase("ask");
            setError(null);
            setOpen(true);
          }}
        >
          <Trash2 aria-hidden="true" size={18} />
          Delete my account
        </button>
      </div>

      <Dialog key={dialogKey} open={open} onClose={close} title={phase === "done" ? "Account deleted" : "Delete your account?"}>
        {phase === "done" ? (
          <div className="space-y-4">
            <p className={`notice ${partial ? "notice-warn" : "notice-ok"}`} role="status">
              {message}
            </p>
            <p className="text-base text-muted">You are being taken to the sign-in page.</p>
            <button type="button" className="btn btn-primary" onClick={goToSignIn} autoFocus>
              Go to sign-in
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <p className="text-base">
              This permanently deletes your account, all of your entries and your settings. There is no way to get them back.
            </p>
            <p className="notice notice-info text-base">
              We recommend you keep a copy first.{" "}
              <a href="/api/account/export" download>
                Download a copy of your data
              </a>{" "}
              before you go on.
            </p>
            {error && (
              <p className="notice notice-error font-bold" role="alert">
                {error}
              </p>
            )}
            <p className={phase === "deleting" ? "notice notice-warn font-bold" : "sr-only"} role="status">
              {phase === "deleting" ? "Deleting your account. This cannot be stopped now, so please wait." : ""}
            </p>
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <button type="button" className="btn btn-secondary" onClick={() => close()} disabled={phase === "deleting"}>
                Keep my account
              </button>
              {/* aria-disabled, not disabled, so keyboard focus stays on the button while the request runs. */}
              <button
                type="button"
                className="btn btn-danger"
                onClick={confirmDelete}
                aria-disabled={phase === "deleting" || undefined}
              >
                {phase === "deleting" ? "Deleting…" : "Yes, delete everything"}
              </button>
            </div>
          </div>
        )}
      </Dialog>
    </div>
  );
}
