/**
 * Checks and tidies a pasted link before the person is sent to the Add page. This is only a first
 * look so obvious slips get a helpful message straight away. The server does the real safety checks.
 */

export const EMPTY_LINK_MESSAGE = "Paste a link to a video, webinar, article or document.";
export const NOT_A_LINK_MESSAGE =
  "That doesn't look like a web link. Paste the full address from your browser, starting with https://";
export const NOT_WEB_MESSAGE = "Only web links can be read. Paste an address that starts with http:// or https://";

export const TOO_LONG_MESSAGE =
  "That link is too long to read. Paste the shorter address from your browser's address bar.";

/** The Add page reads at most this many characters of a link, so a longer one would be cut short without a word. */
export const MAX_LINK_LENGTH = 2048;
/** A link that grows past this once it is written into the address of the Add page can be refused by the server. */
const MAX_ENCODED_LENGTH = 8000;

export type LinkCheck = { ok: true; url: string } | { ok: false; message: string };

/** A bare host with a path, such as youtu.be/abc123. A lone "report.pdf" is left alone: it is a file name. */
const BARE_HOST_WITH_PATH = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?::\d+)?[/?#]/i;

export function checkPastedLink(raw: string): LinkCheck {
  // Links copied from chat apps and documents often arrive wrapped in quotes or angle brackets.
  let text = raw.trim().replace(/^[<"'“‘]+/, "").replace(/[>"'”’]+$/, "").trim();
  if (!text) return { ok: false, message: EMPTY_LINK_MESSAGE };
  if (/\s/.test(text)) return { ok: false, message: NOT_A_LINK_MESSAGE };

  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text);
  const hasWebScheme = /^https?:\/\//i.test(text);
  if (!hasWebScheme) {
    if (/^www\./i.test(text) || BARE_HOST_WITH_PATH.test(text)) {
      text = `https://${text}`;
    } else if (scheme && !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+:\d+/i.test(text)) {
      // mailto:, javascript:, ftp: and so on. (A host with a port, such as example.com:8080, is not a scheme.)
      return { ok: false, message: NOT_WEB_MESSAGE };
    } else {
      return { ok: false, message: NOT_A_LINK_MESSAGE };
    }
  }

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return { ok: false, message: NOT_A_LINK_MESSAGE };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, message: NOT_WEB_MESSAGE };
  if (!parsed.hostname) return { ok: false, message: NOT_A_LINK_MESSAGE };
  if (text.length > MAX_LINK_LENGTH || encodeURIComponent(text).length > MAX_ENCODED_LENGTH) return { ok: false, message: TOO_LONG_MESSAGE };
  return { ok: true, url: text };
}

/** Where the Add page picks the link up. */
export function addPathFor(url: string): string {
  return `/add?url=${encodeURIComponent(url)}`;
}
