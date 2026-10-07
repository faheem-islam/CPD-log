/** The public origin of the site as the visitor sees it, including behind a proxy. Used only for redirects. */
export function publicOrigin(req: Request): string {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ?? url.protocol.replace(":", "");
  return `${proto === "https" ? "https" : "http"}://${host}`;
}

export function isHttps(req: Request): boolean {
  return publicOrigin(req).startsWith("https://");
}
