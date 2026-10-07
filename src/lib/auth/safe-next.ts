/**
 * Only same-site relative paths may be used as a post-sign-in destination.
 * "//evil.example", "/\\evil.example", "https://evil.example" and control characters all fall back.
 */
export function safeNext(raw: string | null | undefined, fallback = "/dashboard"): string {
  if (!raw) return fallback;
  let v = raw.trim();
  try {
    v = decodeURIComponent(v);
  } catch {
    return fallback;
  }
  if (!v.startsWith("/") || v.startsWith("//") || v.includes("\\")) return fallback;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(v)) return fallback;
  if (v.startsWith("/sign-in") || v.startsWith("/api/") || v.startsWith("/auth/")) return fallback;
  return v;
}

export function signInPath(next: string): string {
  return `/sign-in?next=${encodeURIComponent(next)}`;
}
