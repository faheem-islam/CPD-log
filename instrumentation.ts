/**
 * Optional error monitoring. Runs only when SENTRY_DSN is set. Configuration is deliberately minimal:
 * no tracing, no session replay, and events are stripped of request bodies, cookies, headers and user data.
 */
export async function register(): Promise<void> {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) return;
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const Sentry = await import("@sentry/nextjs");
  const { redactSecrets } = await import("./src/lib/security/redact");
  Sentry.init({
    dsn,
    tracesSampleRate: 0,
    beforeSend(event) {
      delete event.request;
      delete event.user;
      delete event.extra;
      delete event.contexts;
      if (event.message) event.message = redactSecrets(event.message);
      for (const ex of event.exception?.values ?? []) {
        if (ex.value) ex.value = redactSecrets(ex.value);
      }
      return event;
    },
  });
}
