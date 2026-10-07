"use client";

import { Mail } from "lucide-react";
import { useState } from "react";
import { api, ApiClientError } from "@/lib/api/client";

/**
 * Email sign-in. With Supabase it sends a one-time link. In local demo mode it signs you straight in
 * with no password, which does not prove who you are, and the page says so.
 */
export function SignInForm({ mode, next }: { mode: "supabase" | "local"; next: string }) {
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === "local") {
        const res = await api<{ redirectTo: string }>("/api/auth/local", { json: { email, next } });
        window.location.assign(res.redirectTo);
        return;
      }
      await api("/api/auth/magic-link", { json: { email, next } });
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <div className="notice notice-ok" role="status">
        <p className="font-bold">Check your email</p>
        <p>
          We've sent a sign-in link to <strong>{email}</strong>. Open it on this device to finish signing in. It can take a minute to arrive.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <div>
        <label htmlFor="email" className="label">
          Email address
        </label>
        <input
          id="email"
          name="email"
          type="email"
          inputMode="email"
          autoComplete="email"
          required
          className="input"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "email-error" : "email-hint"}
        />
        <p id="email-hint" className="hint mt-1">
          {mode === "supabase" ? "We'll email you a link. No password to remember." : "Demo mode: no password and no email is sent."}
        </p>
        {error && (
          <p id="email-error" className="field-error mt-1" role="alert">
            {error}
          </p>
        )}
      </div>
      <button type="submit" className="btn btn-primary w-full" disabled={busy || email.trim() === ""}>
        <Mail aria-hidden="true" size={20} />
        {mode === "supabase" ? "Email me a sign-in link" : "Sign in to the demo"}
      </button>
    </form>
  );
}
