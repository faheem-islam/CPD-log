/**
 * Mutating routes must come from our own pages. Browsers always send Origin on cross-site and on
 * same-site POST/PUT/PATCH/DELETE; we also accept Sec-Fetch-Site: same-origin. Anything else is refused.
 */
export function isSameOrigin(req: Request): boolean {
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return true;

  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  const site = req.headers.get("sec-fetch-site");
  return site === "same-origin";
}
