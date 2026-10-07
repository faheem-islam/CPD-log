import { redactSecrets } from "@/lib/security/redact";

/**
 * Remove anything that looks like a key from text that might be shown or logged.
 * Removes the exact secrets passed in, the patterns the app already redacts (Anthropic, Google, JWT, Supabase
 * keys, key/authorization headers), and any other long unbroken token that looks like a credential.
 */
export function scrubSecrets(text: string, ...secrets: (string | undefined)[]): string {
  let out = text;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) out = out.split(secret).join("[removed]");
  }
  out = out.replace(/\bBearer\s+[^\s"',;]+/gi, "Bearer [removed]");
  out = redactSecrets(out);
  out = out.replace(/\b(?:sk|pk|rk|key|token|secret)[-_][A-Za-z0-9_-]{12,}/gi, "[removed]");
  out = out.replace(/[A-Za-z0-9_-]{32,}/g, "[removed]");
  return out;
}
