/**
 * Recognise two kinds of page we must not try to read past:
 *  - a bot challenge or "access denied" interstitial (Cloudflare, Akamai, Imperva, DataDome, PerimeterX, CAPTCHAs)
 *  - a sign-in page
 *
 * These are heuristics on a hand-written list of signs. They can miss a page and they can be wrong about a page,
 * so they are only used to choose a plain-language message. Nothing here tries to solve, skip or get around a
 * challenge or a login.
 *
 * Several signs (a CAPTCHA widget, the Cloudflare script path, phrases such as "verify you are human") also
 * appear on perfectly normal pages. Those only count when the page is nearly empty of other text, or the status
 * is 403, 429 or 503. A long article that merely mentions them is not flagged. Each sign is either "strong" (it is
 * specific to one vendor's challenge, such as _cf_chl_opt or px-captcha) or "weak" (it can be a plain error page).
 *
 * The HTML is read in one linear pass with indexOf, never with a regular expression that can backtrack over
 * untrusted markup.
 */

export type ChallengeVendor = "cloudflare" | "akamai" | "imperva" | "datadome" | "perimeterx" | "captcha" | "generic";

export interface ChallengeInput {
  status: number;
  headers?: Record<string, string | string[] | undefined>;
  html: string;
  /** The result of scanHtml(html), if the caller already has it. Scanning a big page twice is wasted work. */
  scan?: HtmlScan;
}

export interface LoginWallInput {
  status: number;
  finalUrl: string;
  html: string;
  /** The result of scanHtml(html), if the caller already has it. */
  scan?: HtmlScan;
}

/** Less visible text than this counts as "nearly empty". Real challenge pages have a few hundred characters. */
const SHORT_PAGE_CHARS = 1200;
/** A page with less text than this is a stub: next to nothing on it but one check. */
const STUB_PAGE_CHARS = 300;
/** A page with less text than this is blank: a line, or nothing at all. */
const BLANK_PAGE_CHARS = 50;
/** An error page says "access denied" in its first words. Later than this it is part of a sentence about something else. */
const ERROR_WORDING_WITHIN_CHARS = 20;
/** A sign-in page is mostly the form. */
const LOGIN_PAGE_CHARS = 1000;

// ---------------------------------------------------------------------------------------------
// HTML scan
// ---------------------------------------------------------------------------------------------

export interface HtmlScan {
  /** Lower-case, entities decoded, whitespace collapsed. */
  title: string;
  /** Visible text (scripts, styles and comments removed), lower-case, entities decoded, whitespace collapsed. */
  text: string;
  /** The whole document in lower-case ASCII, same length as the input, for substring checks. */
  lower: string;
  passwordInputs: number;
  /** Inputs a person types or picks into (not hidden, button, checkbox or radio inputs), plus textareas and selects. */
  formFields: number;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"',
  ndash: "-", mdash: "-", hellip: "...",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z]{2,8});/g, (whole, body: string) => {
    if (body.startsWith("#")) {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return " ";
      return String.fromCodePoint(code);
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function tidy(input: string): string {
  return decodeEntities(input)
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Lower-case A-Z only, so every index still lines up with the original string. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

function isNameChar(code: number): boolean {
  return (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || code === 45 || code === 58;
}

/** The value of the first attribute with this name in a tag's attribute text (already lower-case). "" if absent. */
function attributeValue(attrs: string, wanted: string): string {
  const n = attrs.length;
  const isSpace = (c: number) => c === 32 || c === 9 || c === 10 || c === 12 || c === 13;
  let i = 0;
  while (i < n) {
    while (i < n && (isSpace(attrs.charCodeAt(i)) || attrs.charCodeAt(i) === 47)) i++; // whitespace and "/"
    const nameStart = i;
    while (i < n && !isSpace(attrs.charCodeAt(i)) && attrs.charCodeAt(i) !== 61 && attrs.charCodeAt(i) !== 47 && attrs.charCodeAt(i) !== 62) i++;
    const name = attrs.slice(nameStart, i);
    while (i < n && isSpace(attrs.charCodeAt(i))) i++;
    let value = "";
    if (attrs.charCodeAt(i) === 61) {
      i++;
      while (i < n && isSpace(attrs.charCodeAt(i))) i++;
      const quote = attrs[i];
      if (quote === '"' || quote === "'") {
        const end = attrs.indexOf(quote, i + 1);
        value = attrs.slice(i + 1, end === -1 ? n : end);
        i = end === -1 ? n : end + 1;
      } else {
        const valueStart = i;
        while (i < n && !isSpace(attrs.charCodeAt(i)) && attrs.charCodeAt(i) !== 62) i++;
        value = attrs.slice(valueStart, i);
      }
    }
    if (name === wanted) return value.trim();
    if (name === "" && i < n) i++; // a stray character, step over it so the loop always moves on
  }
  return "";
}

/** Input types that are not something a person fills in. */
const NON_FIELD_INPUT_TYPES = new Set(["hidden", "submit", "button", "image", "reset", "checkbox", "radio"]);

export function scanHtml(html: string): HtmlScan {
  const source = typeof html === "string" ? html : "";
  const lower = asciiLower(source);
  const n = source.length;
  const parts: string[] = [];
  let title = "";
  // Only the first <title> counts. Looking again after a blank one made a page of repeated "<title>" quadratic.
  let titleSeen = false;
  let passwordInputs = 0;
  let formFields = 0;
  let i = 0;

  while (i < n) {
    const lt = lower.indexOf("<", i);
    if (lt === -1) {
      parts.push(source.slice(i));
      break;
    }
    if (lt > i) parts.push(source.slice(i, lt));

    if (lower.startsWith("<!--", lt)) {
      const end = lower.indexOf("-->", lt + 4);
      i = end === -1 ? n : end + 3;
      parts.push(" ");
      continue;
    }

    const closing = lower.charCodeAt(lt + 1) === 47; // "/"
    const nameStart = lt + (closing ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < n && isNameChar(lower.charCodeAt(nameEnd))) nameEnd++;
    const name = lower.slice(nameStart, nameEnd);

    if (name === "" || lower.charCodeAt(nameStart) < 97 || lower.charCodeAt(nameStart) > 122) {
      if (lower.startsWith("<!", lt) || lower.startsWith("<?", lt)) {
        const gt = lower.indexOf(">", lt + 2);
        i = gt === -1 ? n : gt + 1; // doctype, CDATA, processing instruction
      } else {
        parts.push("<"); // a stray "<" in text
        i = lt + 1;
      }
      continue;
    }

    const gt = lower.indexOf(">", nameEnd);
    const tagEnd = gt === -1 ? n : gt + 1;

    if (!closing && (name === "script" || name === "style")) {
      const close = lower.indexOf(`</${name}`, tagEnd);
      if (close === -1) {
        i = n;
      } else {
        const closeGt = lower.indexOf(">", close);
        i = closeGt === -1 ? n : closeGt + 1;
      }
      parts.push(" ");
      continue;
    }

    if (!closing && name === "title" && !titleSeen) {
      titleSeen = true;
      const close = lower.indexOf("</title", tagEnd);
      const end = close === -1 ? Math.min(n, tagEnd + 300) : Math.min(close, tagEnd + 300);
      title = tidy(source.slice(tagEnd, end));
      i = close === -1 ? end : close;
      parts.push(" ");
      continue;
    }

    if (!closing && name === "input") {
      // Bounded slice, so a hostile tag cannot make this run long.
      const type = attributeValue(lower.slice(nameEnd, Math.min(tagEnd, nameEnd + 1000)), "type");
      if (type === "password") passwordInputs++;
      if (!NON_FIELD_INPUT_TYPES.has(type)) formFields++;
    } else if (!closing && (name === "textarea" || name === "select")) {
      formFields++;
    }

    parts.push(" ");
    i = tagEnd;
  }

  return { title, text: tidy(parts.join("")), lower, passwordInputs, formFields };
}

function lowerHeaders(headers: ChallengeInput["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = (Array.isArray(value) ? value.join(", ") : value).toLowerCase();
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Bot challenges
// ---------------------------------------------------------------------------------------------

const CAPTCHA_MARKERS = [
  "hcaptcha.com",
  "h-captcha",
  "g-recaptcha",
  "google.com/recaptcha",
  "recaptcha.net/recaptcha",
  "cf-turnstile",
  "challenges.cloudflare.com/turnstile",
];

/** Phrases a challenge page uses to tell a visitor to prove they are a person. Matched on lower-case visible text. */
const HUMAN_CHECK_PHRASES = [
  "verify you are human",
  "verify you are a human",
  "verify that you are human",
  "verify that you are a human",
  "verify you're human",
  "verify that you're human",
  "verifying you are human",
  "confirm you are human",
  "confirm you're human",
  "confirm that you are human",
  "prove you are human",
  "prove you're human",
  "are you a robot",
  "are you human",
  "i'm not a robot",
  "enable javascript and cookies to continue",
  "checking your browser before accessing",
  "checking if the site connection is secure",
  "unusual traffic from your computer network",
  "security check to access",
];

export interface BotChallengeFinding {
  vendor: ChallengeVendor;
  /**
   * True when the sign belongs to one vendor's challenge and nothing else (a cf-mitigated header, _cf_chl_opt,
   * captcha-delivery.com, px-captcha, an Incapsula incident ID). False when it could also be a plain error page.
   */
  strong: boolean;
}

/** "Just a moment", with or without the dots, and nothing after it. A longer title is somebody's headline. */
function isJustAMomentTitle(title: string): boolean {
  return /^just a moment(?:\.{1,3}|\u2026)?$/.test(title);
}

/** As identifyBotChallenge, but also says whether the sign is one that only a challenge page carries. */
export function inspectBotChallenge(input: ChallengeInput): BotChallengeFinding | null {
  const headers = lowerHeaders(input.headers);
  const status = input.status;
  const { title, text, lower, formFields } = input.scan ?? scanHtml(input.html);
  const short = text.length < SHORT_PAGE_CHARS;
  const blockedStatus = status === 403 || status === 429 || status === 503;
  // Signs that also show up on ordinary pages only count on a nearly empty page or a blocking status.
  const suspicious = short || blockedStatus;
  // A CAPTCHA widget or the Cloudflare script on a page with real content or a form is just a protected page.
  const stub = text.length < STUB_PAGE_CHARS;
  const blank = text.length < BLANK_PAGE_CHARS;
  const strong = (vendor: ChallengeVendor): BotChallengeFinding => ({ vendor, strong: true });
  const weak = (vendor: ChallengeVendor): BotChallengeFinding => ({ vendor, strong: false });

  // Cloudflare
  if ((headers["cf-mitigated"] ?? "").includes("challenge")) return strong("cloudflare");
  if (title.includes("attention required! | cloudflare")) return strong("cloudflare");
  // The real interstitial's title is exactly this and its page is short. A headline that starts with the words is not a challenge.
  if (isJustAMomentTitle(title) && suspicious) return strong("cloudflare");
  if (
    lower.includes("_cf_chl_opt") ||
    lower.includes("challenge-error-text") ||
    lower.includes("cf-browser-verification") ||
    lower.includes('id="challenge-form"') ||
    (lower.includes("/challenge-platform/") && lower.includes("/orchestrate/"))
  ) {
    return strong("cloudflare");
  }
  // Cloudflare also injects this script into normal pages that passed. On its own it only counts with a blocking
  // status or on a page with no text to speak of.
  if ((blockedStatus || blank) && lower.includes("/cdn-cgi/challenge-platform")) return weak("cloudflare");

  // Akamai
  if (lower.includes("errors.edgesuite.net") || text.includes("errors.edgesuite.net")) return strong("akamai");
  if (title.includes("access denied") && /reference #\d+\.[0-9a-f]/.test(text)) return strong("akamai");
  // Apache and many other servers word their plain 403 page this way too.
  if (suspicious && text.includes("you don't have permission to access") && text.includes("on this server")) return weak("akamai");

  // Imperva / Incapsula
  if (lower.includes("incapsula incident id") || lower.includes("request unsuccessful. incapsula")) return strong("imperva");
  if (short && title.includes("pardon our interruption")) return strong("imperva");
  if (suspicious && lower.includes("_incapsula_resource")) return weak("imperva");

  // DataDome. captcha-delivery.com is only used for its challenge pages.
  if (lower.includes("captcha-delivery.com")) return strong("datadome");
  if (suspicious && lower.includes("datadome")) return weak("datadome");

  // PerimeterX / HUMAN
  if (lower.includes("px-captcha") || lower.includes("captcha.px-cdn.net")) return strong("perimeterx");
  if (text.includes("press & hold") && text.includes("human")) return strong("perimeterx");
  if (suspicious && (text.includes("access to this page has been denied") || lower.includes("perimeterx"))) return weak("perimeterx");

  // A CAPTCHA widget is normal on a contact form. It is the whole page only on a stub with nothing to fill in, or
  // on a 403/429/503.
  if ((blockedStatus || (stub && formFields === 0)) && CAPTCHA_MARKERS.some((marker) => lower.includes(marker))) return weak("captcha");

  // Plain-language human checks and access-denied pages.
  if (suspicious && HUMAN_CHECK_PHRASES.some((phrase) => text.includes(phrase))) return weak("generic");
  if (title.includes("access denied") && (short || status >= 400)) return weak("generic");
  // An error page says it in its first words. A short page that mentions "access denied" further in is about something else.
  const deniedAt = text.indexOf("access denied");
  if (short && deniedAt !== -1 && deniedAt <= ERROR_WORDING_WITHIN_CHARS) return weak("generic");

  return null;
}

/** Which vendor's challenge this looks like, or null. "generic" means a human-check or access-denied page of unknown make. */
export function identifyBotChallenge(input: ChallengeInput): ChallengeVendor | null {
  return inspectBotChallenge(input)?.vendor ?? null;
}

/** True if the response looks like a bot challenge, a human check or an "access denied" page instead of the real page. */
export function detectBotChallenge(input: ChallengeInput): boolean {
  return identifyBotChallenge(input) !== null;
}

// ---------------------------------------------------------------------------------------------
// Login walls
// ---------------------------------------------------------------------------------------------

const LOGIN_HOSTS = new Set([
  "accounts.google.com",
  "login.microsoftonline.com",
  "login.microsoft.com",
  "login.live.com",
  "login.windows.net",
  "appleid.apple.com",
  "id.atlassian.com",
  "login.salesforce.com",
]);
const LOGIN_HOST_PREFIXES = ["login.", "signin.", "sso.", "adfs."];
const LOGIN_HOST_SUFFIXES = [".okta.com", ".auth0.com", ".b2clogin.com", ".onelogin.com"];
const LOGIN_PATH_SEGMENTS = new Set(["login", "log-in", "logon", "signin", "sign-in", "sign_in", "signon", "sign-on", "sso", "saml", "saml2"]);

const SIGN_IN_PHRASES = [
  /\b(?:sign|log)[ -]?in (?:to|with) (?:continue|view|read|access|see)\b/,
  /\bplease (?:sign|log)[ -]?in\b/,
  /\byou (?:must|need to) (?:be )?(?:signed|logged)[ -]?in\b/,
  /\b(?:sign|log)[ -]?in required\b/,
];

/** True for an address that is a sign-in or single-sign-on page: a known identity host, a login-style host name, or a /login-style path segment. */
export function looksLikeLoginUrl(finalUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(finalUrl);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  if (LOGIN_HOSTS.has(host)) return true;
  if (LOGIN_HOST_PREFIXES.some((p) => host.startsWith(p))) return true;
  if (LOGIN_HOST_SUFFIXES.some((s) => host.endsWith(s))) return true;
  return url.pathname
    .toLowerCase()
    .split("/")
    .some((segment) => segment !== "" && LOGIN_PATH_SEGMENTS.has(segment.split(".")[0] ?? ""));
}

/**
 * True if we landed on a sign-in page: a 401, a final address that is a login or SSO page, or a page that is
 * essentially a password form. A normal page that only has a "Sign in" link or a newsletter box is not flagged.
 */
export function detectLoginWall(input: LoginWallInput): boolean {
  if (input.status === 401) return true;
  if (looksLikeLoginUrl(input.finalUrl)) return true;
  const { text, passwordInputs } = input.scan ?? scanHtml(input.html);
  if (passwordInputs > 0 && text.length < LOGIN_PAGE_CHARS) return true;
  if (text.length < 600 && SIGN_IN_PHRASES.some((re) => re.test(text))) return true;
  return false;
}
