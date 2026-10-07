/** Patterns for things that must never reach logs, error reports or responses. */
const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{8,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /sb_(?:secret|publishable)_[A-Za-z0-9_-]{10,}/g,
  /(x-api-key|x-goog-api-key|authorization|apikey)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m, name?: string, sep?: string) =>
      typeof name === "string" && typeof sep === "string" ? `${name}${sep}[redacted]` : "[redacted]",
    );
  }
  return out;
}

/** Logs a short, redacted message. Never pass request bodies, notes or tokens to it. */
export function logError(context: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[${context}] ${redactSecrets(message).slice(0, 500)}`);
}
