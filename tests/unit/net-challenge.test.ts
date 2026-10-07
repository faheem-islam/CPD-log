import { describe, expect, it } from "vitest";
import { detectBotChallenge, detectLoginWall, identifyBotChallenge, inspectBotChallenge, looksLikeLoginUrl, scanHtml } from "@/lib/net/challenge";

// These fixtures are hand-written to show the SIGNS the detector looks for. They are not captures of live pages,
// so passing them proves the logic, not that any particular site's current page is recognised.

const CLOUDFLARE_JUST_A_MOMENT = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<meta http-equiv="Content-Type" content="text/html; charset=UTF-8"><meta name="robots" content="noindex,nofollow"></head>
<body class="no-js"><div class="main-wrapper" role="main"><div class="main-content">
<noscript><div class="h2"><span id="challenge-error-text">Enable JavaScript and cookies to continue</span></div></noscript></div></div>
<script>(function(){window._cf_chl_opt={cvId:'3',cZone:'example.com',cType:'managed'};var a=document.createElement('script');
a.src='/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=8abc';document.getElementsByTagName('head')[0].appendChild(a);})();</script></body></html>`;

const AKAMAI_ACCESS_DENIED = `<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1>
You don't have permission to access "http&#58;&#47;&#47;www&#46;example&#46;com&#47;page" on this server.<P>
Reference&#32;&#35;18&#46;2d351ab8&#46;1557333295&#46;a4e16ab
<P>https&#58;&#47;&#47;errors&#46;edgesuite&#46;net&#47;18&#46;2d351ab8&#46;1557333295&#46;a4e16ab</BODY></HTML>`;

const IMPERVA_BLOCK = `<html style="height:100%"><head><META NAME="ROBOTS" CONTENT="NOINDEX, NOFOLLOW"><meta name="viewport" content="initial-scale=1.0">
<script type="text/javascript" src="/_Incapsula_Resource?SWJIYLWA=5074a744e2e3d891814e9a2dace20bd4"></script></head>
<body style="margin:0px;height:100%"><iframe id="main-iframe" src="/_Incapsula_Resource?CWUDNSAI=24" frameborder=0 width="100%" height="100%">
Request unsuccessful. Incapsula incident ID: 1234000670123456789-12345678901234567</iframe></body></html>`;

const DATADOME_CHALLENGE = `<html lang="en"><head><title>example.com</title><style>#cmsg{animation: A 1.5s;}</style></head>
<body style="margin:0"><p id="cmsg">Please enable JS and disable any ad blocker</p>
<script data-cfasync="false">var dd={'rt':'c','cid':'AHrlqAAAAAMAmsq','t':'bv','host':'geo.captcha-delivery.com'}</script>
<script data-cfasync="false" src="https://ct.captcha-delivery.com/c.js"></script></body></html>`;

const PERIMETERX_BLOCK = `<html lang="en"><head><title>Access to this page has been denied</title></head><body>
<div class="px-captcha-container"><div id="px-captcha"></div></div><script src="https://captcha.px-cdn.net/PXabc/captcha.js?a=c"></script>
<p>Press &amp; Hold to confirm you are a human (and not a bot).</p></body></html>`;

const HCAPTCHA_INTERSTITIAL = `<html><head><title>One moment</title><script src="https://js.hcaptcha.com/1/api.js" async defer></script></head>
<body><form method="POST"><div class="h-captcha" data-sitekey="abc"></div><button>Continue</button></form></body></html>`;

const RECAPTCHA_INTERSTITIAL = `<html><body><h1>One more step</h1><p>Please complete the security check to access example.com</p>
<div class="g-recaptcha" data-sitekey="x"></div><script src="https://www.google.com/recaptcha/api.js"></script></body></html>`;

/** A long, ordinary article. About 3000 characters of visible text. */
const LONG_ARTICLE_BODY = Array.from({ length: 30 }, (_, i) => `<p>Paragraph ${i + 1}. Bridge bearings need inspecting on a regular cycle, and the condition of the elastomeric layers tells you a good deal about how the structure has moved over the years.</p>`).join("\n");

function article(extraHead = "", extraBody = "", title = "Inspecting bridge bearings"): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>${extraHead}</head><body>
<header><a href="/signin">Sign in</a> <a href="/subscribe">Newsletter</a></header><main><h1>${title}</h1>${LONG_ARTICLE_BODY}${extraBody}</main>
<footer><form action="/newsletter"><label>Email <input type="email" name="email"></label><button>Subscribe</button></form></footer></body></html>`;
}

describe("detectBotChallenge: positives", () => {
  it("recognises the Cloudflare 'Just a moment...' interstitial", () => {
    expect(detectBotChallenge({ status: 403, headers: {}, html: CLOUDFLARE_JUST_A_MOMENT })).toBe(true);
    expect(detectBotChallenge({ status: 503, headers: {}, html: CLOUDFLARE_JUST_A_MOMENT })).toBe(true);
    expect(detectBotChallenge({ status: 200, headers: {}, html: CLOUDFLARE_JUST_A_MOMENT })).toBe(true);
    expect(identifyBotChallenge({ status: 403, html: CLOUDFLARE_JUST_A_MOMENT })).toBe("cloudflare");
  });

  it("recognises 'Just a moment' by title alone, whatever the case or entities", () => {
    expect(detectBotChallenge({ status: 200, html: "<title>Just a moment...</title><p>x</p>" })).toBe(true);
    expect(detectBotChallenge({ status: 200, html: "<TITLE>JUST A MOMENT</TITLE>" })).toBe(true);
    expect(detectBotChallenge({ status: 200, html: "<title>Just&nbsp;a moment...</title>" })).toBe(true);
    expect(detectBotChallenge({ status: 200, html: "<title>Attention Required! | Cloudflare</title>" })).toBe(true);
  });

  it("recognises the cf-mitigated: challenge header, even with no body", () => {
    expect(detectBotChallenge({ status: 403, headers: { "cf-mitigated": "challenge" }, html: "" })).toBe(true);
    expect(detectBotChallenge({ status: 403, headers: { "CF-Mitigated": "Challenge" }, html: "" })).toBe(true);
    expect(detectBotChallenge({ status: 200, headers: { "cf-mitigated": ["challenge"] }, html: "<html>ok</html>" })).toBe(true);
    expect(detectBotChallenge({ status: 200, headers: { "cf-mitigated": "challenge" }, html: article() })).toBe(true);
  });

  it("recognises the /cdn-cgi/challenge-platform script on a nearly empty page or a blocking status", () => {
    const stub = '<html><body><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script></body></html>';
    expect(detectBotChallenge({ status: 200, html: stub })).toBe(true);
    expect(detectBotChallenge({ status: 403, html: article('<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>') })).toBe(true);
    expect(detectBotChallenge({ status: 200, html: article('<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>') })).toBe(true);
    expect(detectBotChallenge({ status: 200, html: article("<script>window._cf_chl_opt={}</script>") })).toBe(true);
  });

  it("recognises an Akamai access-denied page", () => {
    expect(detectBotChallenge({ status: 403, html: AKAMAI_ACCESS_DENIED })).toBe(true);
    expect(identifyBotChallenge({ status: 403, html: AKAMAI_ACCESS_DENIED })).toBe("akamai");
    expect(detectBotChallenge({ status: 200, html: "<p>see https://errors.edgesuite.net/18.2d.1</p>" })).toBe(true);
  });

  it("recognises an Imperva / Incapsula block page", () => {
    expect(detectBotChallenge({ status: 403, html: IMPERVA_BLOCK })).toBe(true);
    expect(identifyBotChallenge({ status: 403, html: IMPERVA_BLOCK })).toBe("imperva");
    expect(detectBotChallenge({ status: 200, html: "<html><body>Request unsuccessful. Incapsula incident ID: 12-34</body></html>" })).toBe(true);
    expect(detectBotChallenge({ status: 200, html: "<title>Pardon Our Interruption</title><p>As you were browsing something about your browser made us think you were a bot.</p>" })).toBe(true);
  });

  it("recognises a DataDome challenge", () => {
    expect(detectBotChallenge({ status: 403, html: DATADOME_CHALLENGE })).toBe(true);
    expect(identifyBotChallenge({ status: 200, html: DATADOME_CHALLENGE })).toBe("datadome");
  });

  it("recognises a PerimeterX / HUMAN block page", () => {
    expect(detectBotChallenge({ status: 403, html: PERIMETERX_BLOCK })).toBe(true);
    expect(identifyBotChallenge({ status: 403, html: PERIMETERX_BLOCK })).toBe("perimeterx");
    expect(detectBotChallenge({ status: 200, html: "<div id='px-captcha'></div>" })).toBe(true);
    expect(detectBotChallenge({ status: 200, html: "<p>Press &amp; Hold to confirm you are a human</p>" })).toBe(true);
  });

  it("recognises an hCaptcha or reCAPTCHA interstitial", () => {
    expect(detectBotChallenge({ status: 200, html: HCAPTCHA_INTERSTITIAL })).toBe(true);
    expect(identifyBotChallenge({ status: 200, html: HCAPTCHA_INTERSTITIAL })).toBe("captcha");
    expect(detectBotChallenge({ status: 200, html: RECAPTCHA_INTERSTITIAL })).toBe(true);
    expect(detectBotChallenge({ status: 429, html: '<div class="cf-turnstile" data-sitekey="k"></div>' })).toBe(true);
  });

  it("recognises 'access denied' pages", () => {
    expect(detectBotChallenge({ status: 403, html: "<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1></body></html>" })).toBe(true);
    expect(detectBotChallenge({ status: 200, html: "<html><body><h1>Access denied</h1><p>Your request was blocked.</p></body></html>" })).toBe(true);
    expect(detectBotChallenge({ status: 403, html: "<title>Access denied</title>" + LONG_ARTICLE_BODY })).toBe(true);
  });

  it.each([
    "Please verify you are human",
    "Verify you are human by completing the action below.",
    "We need to verify that you are a human before we continue.",
    "Verify you&#39;re human to continue",
    "Verify you’re human",
    "Confirm you are human",
    "Are you a robot?",
    "Enable JavaScript and cookies to continue",
    "Checking your browser before accessing example.com",
    "Our systems have detected unusual traffic from your computer network.",
    "Prove you are human",
  ])("recognises the phrase %j on a short page", (phrase) => {
    expect(detectBotChallenge({ status: 200, html: `<html><body><p>${phrase}</p></body></html>` })).toBe(true);
    expect(detectBotChallenge({ status: 403, html: `<html><body><p>${phrase}</p>${LONG_ARTICLE_BODY}</body></html>` })).toBe(true);
  });

  it("is not thrown by case, odd spacing or inline tags inside the phrase", () => {
    expect(detectBotChallenge({ status: 200, html: "<BODY><P>VERIFY   YOU\n ARE\tHUMAN</P>" })).toBe(true);
    expect(detectBotChallenge({ status: 200, html: "<p>Verify you are <b>human</b></p>" })).toBe(true);
    expect(detectBotChallenge({ status: 200, html: "<p>Verify you are<br>human</p>" })).toBe(true);
  });
});

describe("detectBotChallenge: negatives", () => {
  it("does not flag an ordinary long article with a sign-in link and a newsletter box", () => {
    expect(detectBotChallenge({ status: 200, headers: {}, html: article() })).toBe(false);
  });

  it("does not flag a normal Cloudflare-served page that only carries the passive script", () => {
    const withJsd = article('<script>(function(){var a=document.createElement("script");a.src="/cdn-cgi/challenge-platform/scripts/jsd/main.js";})()</script>');
    expect(detectBotChallenge({ status: 200, headers: { "cf-ray": "8abc-LHR", server: "cloudflare" }, html: withJsd })).toBe(false);
  });

  it("does not flag a long page that has a CAPTCHA widget on its contact form", () => {
    expect(detectBotChallenge({ status: 200, html: article('<script src="https://www.google.com/recaptcha/api.js"></script>', '<div class="g-recaptcha" data-sitekey="x"></div>') })).toBe(false);
    expect(detectBotChallenge({ status: 200, html: article("", '<div class="h-captcha"></div><script src="https://js.hcaptcha.com/1/api.js"></script>') })).toBe(false);
    expect(detectBotChallenge({ status: 200, html: article("", '<div class="cf-turnstile"></div>') })).toBe(false);
  });

  it("does not flag a long page that merely mentions the phrases", () => {
    const talky = article("", "<p>Some sites ask you to verify you are human, or tell you to enable JavaScript and cookies to continue. Are you a robot? Access denied messages are annoying.</p>");
    expect(detectBotChallenge({ status: 200, html: talky })).toBe(false);
    expect(detectBotChallenge({ status: 200, html: article("", "<p>Datadome, PerimeterX and _Incapsula_Resource are names of bot-protection vendors.</p>") })).toBe(false);
  });

  it("does not flag a long page whose title happens to include 'access denied'", () => {
    expect(detectBotChallenge({ status: 200, html: article("", "", "Access denied: why locked doors fail") })).toBe(false);
  });

  it("does not flag a long page that carries bot-protection tags but passed", () => {
    const tagged = article('<script src="https://js.datadome.co/tags.js"></script><script src="/_Incapsula_Resource?SWJIYLWA=1"></script><script src="https://client.perimeterx.net/PXabc/main.min.js"></script>');
    expect(detectBotChallenge({ status: 200, html: tagged })).toBe(false);
  });

  it("does not flag a JavaScript app shell, an empty page, a plain 404 or a plain 500", () => {
    expect(detectBotChallenge({ status: 200, html: '<html><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>' })).toBe(false);
    expect(detectBotChallenge({ status: 200, html: "" })).toBe(false);
    expect(detectBotChallenge({ status: 200, html: "   " })).toBe(false);
    expect(detectBotChallenge({ status: 404, html: "<html><body><h1>Page not found</h1><p>Try the home page.</p></body></html>" })).toBe(false);
    expect(detectBotChallenge({ status: 500, html: "<html><body><h1>Internal server error</h1></body></html>" })).toBe(false);
    expect(detectBotChallenge({ status: 403, html: "<html><body><h1>Forbidden</h1></body></html>" })).toBe(false);
    expect(detectBotChallenge({ status: 429, html: "<html><body>Too many requests</body></html>" })).toBe(false);
  });

  it("does not flag short ordinary pages or ordinary headers", () => {
    expect(detectBotChallenge({ status: 200, html: "<html><body><h1>Hello</h1></body></html>" })).toBe(false);
    expect(detectBotChallenge({ status: 200, html: "<p>Robotics for bridge inspection</p>" })).toBe(false);
    expect(detectBotChallenge({ status: 200, headers: { "cf-mitigated": "something-else", "x-robots-tag": "noindex" }, html: "<p>ok</p>" })).toBe(false);
    expect(detectBotChallenge({ status: 200, headers: undefined, html: "<p>ok</p>" })).toBe(false);
  });

  it("does not treat the word in an HTML comment or a script string as page text", () => {
    expect(detectBotChallenge({ status: 200, html: `<html><body><!-- verify you are human --><script>var s = "verify you are human";</script><style>.x{}</style><p>${"Plain text. ".repeat(200)}</p></body></html>` })).toBe(false);
  });
});

describe("scanHtml is linear and tolerant", () => {
  it("extracts the title, visible text and password inputs", () => {
    const scan = scanHtml('<html><head><title> My &amp; Title </title><style>p{}</style><script>var x="<p>hidden</p>"</script></head><body><!-- c --><p>Hello&nbsp;<b>world</b> &#8217;s</p><input type="password"><INPUT TYPE=PASSWORD><input type=\'password\'><input type="text"></body></html>');
    expect(scan.title).toBe("my & title");
    expect(scan.text).toBe("hello world 's");
    expect(scan.passwordInputs).toBe(3);
  });

  it("does not count lookalike input types", () => {
    expect(scanHtml('<input type="passwordish"><input name="password" type="text"><input type="hidden" value="type=password">').passwordInputs).toBe(0);
  });

  it("copes with unterminated tags, scripts, comments and stray angle brackets", () => {
    for (const html of ["<p>a < b and c > d</p>", "<script>never closed", "<!-- never closed", "<p", "<", "<<<<<", "<style>x", "<title>no end", "<a href='x", "text only", ""]) {
      expect(() => scanHtml(html), html).not.toThrow();
    }
    expect(scanHtml("<p>a < b</p>").text).toBe("a < b");
    expect(scanHtml("<title>never ends and keeps going").title.length).toBeLessThanOrEqual(300);
  });

  it("stays fast on hostile input that would make a backtracking regex crawl", () => {
    const started = Date.now();
    scanHtml("<a ".repeat(700_000));
    scanHtml("<script".repeat(300_000));
    scanHtml("<input ".repeat(300_000));
    scanHtml("<!--".repeat(500_000));
    scanHtml(`<title>${"<".repeat(1_000_000)}`);
    scanHtml(`${"<p>text</p>".repeat(200_000)}`);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it("handles a 2 MB page in reasonable time", () => {
    const html = `<html><body>${"<p>Some ordinary text with a <a href='/x'>link</a>.</p>".repeat(45_000)}</body></html>`;
    expect(html.length).toBeGreaterThan(2_000_000);
    const started = Date.now();
    expect(detectBotChallenge({ status: 200, html })).toBe(false);
    expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/", html })).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});

describe("detectLoginWall: positives", () => {
  const page = "<html><body><p>Hello</p></body></html>";
  it("recognises a 401", () => {
    expect(detectLoginWall({ status: 401, finalUrl: "https://example.com/members", html: "" })).toBe(true);
    expect(detectLoginWall({ status: 401, finalUrl: "https://example.com/", html: article() })).toBe(true);
  });

  it.each([
    "https://example.com/login",
    "https://example.com/login?next=%2Fcourse%2F5",
    "https://example.com/Login",
    "https://example.com/signin",
    "https://example.com/sign-in",
    "https://example.com/users/sign_in",
    "https://example.com/account/login.php",
    "https://example.com/auth/login/",
    "https://example.com/sso",
    "https://example.com/sso/start",
    "https://example.com/auth/saml2",
    "https://example.com/log-in",
    "https://accounts.google.com/v3/signin/identifier?continue=x",
    "https://accounts.google.com/ServiceLogin",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize?client_id=x",
    "https://login.live.com/",
    "https://acme.okta.com/app/acme/abc/sso/saml",
    "https://sso.example.com/",
    "https://login.example.com/start",
    "https://signin.example.com/",
    "https://acme.b2clogin.com/acme.onmicrosoft.com/oauth2/authorize",
    "https://appleid.apple.com/auth/authorize",
  ])("recognises a redirect that landed on %s", (finalUrl) => {
    expect(detectLoginWall({ status: 200, finalUrl, html: page })).toBe(true);
  });

  it("recognises a page that is essentially a password form", () => {
    const form = '<html><head><title>Welcome</title></head><body><h1>Account</h1><form method="post"><label>Email <input type="email" name="e"></label><label>Password <input type="password" name="p"></label><button>Continue</button><a href="/forgot">Forgot your password?</a></form></body></html>';
    expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/course/5", html: form })).toBe(true);
  });

  it("recognises 'sign in to continue' pages without a password box (single sign-on buttons)", () => {
    expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/course/5", html: "<html><body><h1>Sign in to continue</h1><button>Continue with Google</button><button>Continue with Microsoft</button></body></html>" })).toBe(true);
    expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/x", html: "<p>You must be logged in to view this page.</p>" })).toBe(true);
    expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/x", html: "<p>Please log in.</p>" })).toBe(true);
    expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/x", html: "<p>Login required</p>" })).toBe(true);
  });
});

describe("detectLoginWall: negatives", () => {
  it("does not flag a normal article that has a sign-in link and a newsletter box", () => {
    expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/articles/bearings", html: article() })).toBe(false);
  });

  it("does not flag a long page with a password box tucked into a header menu", () => {
    const withMenu = article("", '<div class="menu"><form><input type="password" name="p"></form></div>');
    expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/articles/bearings", html: withMenu })).toBe(false);
  });

  it("does not flag a long page that says 'sign in to continue' in passing", () => {
    expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/a", html: article("", "<p>Some sites make you sign in to continue reading.</p>") })).toBe(false);
  });

  it("does not flag addresses that only contain the word", () => {
    for (const finalUrl of [
      "https://example.com/blog/login-best-practices",
      "https://example.com/loginfo",
      "https://example.com/sso-guide",
      "https://example.com/blogin",
      "https://example.com/products?next=/login",
      "https://example.com/page#login",
      "https://login-example.com/",
      "https://notlogin.example.com/",
      "https://example.com/signing-off",
      "https://example.com/courses/sign",
    ]) {
      expect(detectLoginWall({ status: 200, finalUrl, html: article() }), finalUrl).toBe(false);
    }
  });

  it("does not flag short ordinary pages, empty pages, errors, or a bad final URL", () => {
    expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/", html: "<p>Hello</p>" })).toBe(false);
    expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/", html: "" })).toBe(false);
    expect(detectLoginWall({ status: 404, finalUrl: "https://example.com/missing", html: "<h1>Not found</h1>" })).toBe(false);
    expect(detectLoginWall({ status: 200, finalUrl: "not a url", html: "<p>Hello</p>" })).toBe(false);
    expect(detectLoginWall({ status: 403, finalUrl: "https://example.com/", html: "<h1>Forbidden</h1>" })).toBe(false);
  });

  it("does not flag text inputs whose name is password or other types", () => {
    expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/", html: '<form><input name="password-hint" type="text"><input type="email"></form>' })).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Review fixes
// ---------------------------------------------------------------------------------------------

/** About 2 MB of "<title>" followed by 300 blanks, then one line of text. The first title stays empty each time. */
const BLANK_TITLES = `${`<title>${" ".repeat(300)}`.repeat(6800)}<p>hello</p>`;

describe("scanHtml: a page of repeated blank <title> tags", () => {
  it("is scanned in one linear pass (a 2 MB page of this shape used to take about 5 seconds)", () => {
    expect(BLANK_TITLES.length).toBeGreaterThan(2_000_000);
    expect(BLANK_TITLES.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    const started = Date.now();
    const scan = scanHtml(BLANK_TITLES);
    expect(Date.now() - started).toBeLessThan(1500);
    expect(scan.title).toBe("");
    expect(scan.text).toBe("hello");
  });

  it("does the whole challenge and sign-in check on it quickly, from one shared scan", () => {
    const started = Date.now();
    const scan = scanHtml(BLANK_TITLES);
    expect(detectBotChallenge({ status: 200, html: BLANK_TITLES, scan })).toBe(false);
    expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/", html: BLANK_TITLES, scan })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it("is also quick when the titles have no closing tag, or text between them", () => {
    const started = Date.now();
    scanHtml("<title>x ".repeat(250_000));
    scanHtml("<title>text</title>".repeat(100_000));
    scanHtml("<title></title>".repeat(150_000));
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it("uses only the first <title> of the page, even when it is blank", () => {
    expect(scanHtml("<title></title><svg><title>Just a moment...</title></svg>").title).toBe("");
    expect(scanHtml("<title>First</title><title>Second</title>").title).toBe("first");
  });
});

describe("a scan made earlier can be passed in", () => {
  const pages = [CLOUDFLARE_JUST_A_MOMENT, AKAMAI_ACCESS_DENIED, IMPERVA_BLOCK, HCAPTCHA_INTERSTITIAL, article(), '<form><input type="password"></form>'];

  it("gives the same answers as scanning the page again", () => {
    for (const html of pages) {
      const scan = scanHtml(html);
      for (const status of [200, 403]) {
        expect(identifyBotChallenge({ status, html, scan })).toBe(identifyBotChallenge({ status, html }));
        expect(inspectBotChallenge({ status, html, scan })).toEqual(inspectBotChallenge({ status, html }));
      }
      expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/x", html, scan })).toBe(detectLoginWall({ status: 200, finalUrl: "https://example.com/x", html }));
    }
  });

  it("uses the scan it is given instead of reading the html again", () => {
    expect(identifyBotChallenge({ status: 200, html: "<p>plain</p>", scan: scanHtml("<title>Just a moment...</title>") })).toBe("cloudflare");
    expect(detectLoginWall({ status: 200, finalUrl: "https://example.com/", html: "<p>plain</p>", scan: scanHtml('<input type="password">') })).toBe(true);
  });
});

describe("scanHtml: comments and form fields", () => {
  it("drops the text of an HTML comment", () => {
    expect(scanHtml("<p>one<!-- verify you are human -->two</p>").text).toBe("one two");
    expect(detectBotChallenge({ status: 200, html: "<p>Hello</p><!-- verify you are human, are you a robot -->" })).toBe(false);
  });

  it("counts the fields a person fills in, and not buttons, hidden inputs, checkboxes or radios", () => {
    const html = '<form><input name=a><input type="email"><input type="password"><textarea></textarea><select></select><input type="hidden"><input type="submit"><input type="button"><input type="checkbox"><input type="radio"></form>';
    expect(scanHtml(html).formFields).toBe(5);
    expect(scanHtml('<button>Continue</button><input type="hidden" name="t" value="1">').formFields).toBe(0);
  });
});

describe("detectBotChallenge: ordinary short pages that carry challenge-like signs", () => {
  const COPY =
    "Join us for a one hour CPD webinar on inspecting elastomeric bridge bearings. The session covers how to read wear patterns, when to schedule replacement, and what to record in the inspection log. " +
    "There is a short question and answer at the end, and the slides are shared afterwards. Places are free for members and cost twenty pounds for everyone else. Booking closes the day before the session starts.";

  function eventPage(options: { head?: string; body?: string; title?: string; copy?: string } = {}): string {
    const title = options.title ?? "Bearings webinar";
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${options.head ?? ""}</head><body><h1>${title}</h1><p>${options.copy ?? COPY}</p>${options.body ?? ""}</body></html>`;
  }

  const contactForm =
    '<form action="/contact"><label>Name <input type="text" name="n"></label><label>Email <input type="email" name="e"></label><label>Message <textarea name="m"></textarea></label><div class="g-recaptcha" data-sitekey="x"></div><button>Send</button></form>';

  it("the fixture is short, as the real pages in question are", () => {
    const length = scanHtml(eventPage()).text.length;
    expect(length).toBeGreaterThan(400);
    expect(length).toBeLessThan(1200);
  });

  it("does not flag a 200 page of a few hundred characters just because Cloudflare injected its script", () => {
    const page = eventPage({ body: '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>' });
    expect(detectBotChallenge({ status: 200, headers: { server: "cloudflare" }, html: page })).toBe(false);
    expect(identifyBotChallenge({ status: 200, html: page })).toBeNull();
  });

  it("still flags that script on a nearly empty page, and on a 403 or 503", () => {
    const script = '<script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>';
    expect(detectBotChallenge({ status: 200, html: `<html><body><p>Checking</p>${script}</body></html>` })).toBe(true);
    expect(detectBotChallenge({ status: 403, html: eventPage({ body: script }) })).toBe(true);
    expect(detectBotChallenge({ status: 503, html: eventPage({ body: script }) })).toBe(true);
  });

  it("does not flag a short 200 page with a CAPTCHA widget on a contact form", () => {
    expect(detectBotChallenge({ status: 200, html: eventPage({ body: contactForm }) })).toBe(false);
    expect(detectBotChallenge({ status: 200, html: eventPage({ copy: "Contact the CPD team.", body: contactForm }) })).toBe(false);
    expect(detectBotChallenge({ status: 200, html: eventPage({ copy: "Contact us.", body: contactForm.replace("g-recaptcha", "h-captcha") }) })).toBe(false);
    expect(detectBotChallenge({ status: 200, html: eventPage({ copy: "Contact us.", body: contactForm.replace("g-recaptcha", "cf-turnstile") }) })).toBe(false);
  });

  it("does not flag a page of a few hundred characters with a widget and a button but nothing to fill in", () => {
    expect(detectBotChallenge({ status: 200, html: eventPage({ body: '<div class="g-recaptcha" data-sitekey="x"></div><button>Register</button>' }) })).toBe(false);
  });

  it("still flags a CAPTCHA widget that is the whole page, or any widget on a 403 or 429", () => {
    expect(detectBotChallenge({ status: 200, html: HCAPTCHA_INTERSTITIAL })).toBe(true);
    expect(detectBotChallenge({ status: 403, html: eventPage({ body: contactForm }) })).toBe(true);
    expect(detectBotChallenge({ status: 429, html: eventPage({ body: contactForm }) })).toBe(true);
  });

  it("does not flag a short page that mentions 'access denied' in its copy", () => {
    const page = eventPage({ copy: "Some members see an 'Access denied' message when they open the recording on a work laptop. If that happens, ask your IT team to allow the link, or watch it at home." });
    expect(scanHtml(page).text).toContain("access denied");
    expect(detectBotChallenge({ status: 200, html: page })).toBe(false);
  });

  it("still flags an access-denied page that says so at once, and one with a long page under an Access Denied title on a 403", () => {
    expect(detectBotChallenge({ status: 200, html: "<html><body><h1>Access denied</h1><p>Your request was blocked.</p></body></html>" })).toBe(true);
    expect(detectBotChallenge({ status: 403, html: `<title>Access Denied</title>${LONG_ARTICLE_BODY}` })).toBe(true);
  });

  it("does not flag a long 200 article whose title begins 'Just a moment'", () => {
    const html = article("", "", "Just a moment of reflection: CPD for chaplains");
    expect(detectBotChallenge({ status: 200, html })).toBe(false);
    expect(detectBotChallenge({ status: 200, html: article("", "", "Just a moment...") })).toBe(false);
  });

  it("does not flag a short page whose title only begins 'Just a moment'", () => {
    expect(detectBotChallenge({ status: 200, html: eventPage({ title: "Just a moment of reflection: CPD for chaplains" }) })).toBe(false);
    expect(detectBotChallenge({ status: 200, html: eventPage({ title: "Just a moment, please read this first" }) })).toBe(false);
  });

  it("still flags the real interstitial title, with dots, with the ellipsis character, or on a 403 or 503 page", () => {
    expect(detectBotChallenge({ status: 200, html: "<title>Just a moment...</title><p>x</p>" })).toBe(true);
    expect(detectBotChallenge({ status: 200, html: "<title>Just a moment\u2026</title><p>x</p>" })).toBe(true);
    expect(detectBotChallenge({ status: 200, html: "<title>Just a moment&hellip;</title><p>x</p>" })).toBe(true);
    expect(detectBotChallenge({ status: 403, html: article("", "", "Just a moment...") })).toBe(true);
    expect(detectBotChallenge({ status: 503, html: article("", "", "Just a moment...") })).toBe(true);
  });
});

describe("inspectBotChallenge: signs that only a vendor's challenge carries are strong", () => {
  const strongPages: Array<[string, Parameters<typeof inspectBotChallenge>[0]]> = [
    ["cf-mitigated header", { status: 403, headers: { "cf-mitigated": "challenge" }, html: "" }],
    ["_cf_chl_opt", { status: 403, html: "<script>window._cf_chl_opt={}</script>" }],
    ["Cloudflare interstitial", { status: 403, html: CLOUDFLARE_JUST_A_MOMENT }],
    ["captcha-delivery.com", { status: 403, html: DATADOME_CHALLENGE }],
    ["px-captcha", { status: 403, html: PERIMETERX_BLOCK }],
    ["Incapsula incident ID", { status: 403, html: IMPERVA_BLOCK }],
    ["Akamai reference page", { status: 403, html: AKAMAI_ACCESS_DENIED }],
  ];
  it.each(strongPages)("%s is strong", (_name, input) => {
    expect(inspectBotChallenge(input)?.strong).toBe(true);
  });

  const weakPages: Array<[string, Parameters<typeof inspectBotChallenge>[0]]> = [
    ["a plain access-denied page", { status: 403, html: "<title>Access Denied</title><p>Your IP is not on the allow list.</p>" }],
    ["a human-check sentence", { status: 403, html: "<p>Please verify you are human</p>" }],
    ["the bare Cloudflare script", { status: 403, html: '<p>x</p><script src="/cdn-cgi/challenge-platform/scripts/jsd/main.js"></script>' }],
    ["a CAPTCHA widget", { status: 429, html: '<div class="cf-turnstile"></div>' }],
    ["the Apache 403 wording", { status: 403, html: "<p>You don't have permission to access /private on this server.</p>" }],
  ];
  it.each(weakPages)("%s is weak", (_name, input) => {
    const found = inspectBotChallenge(input);
    expect(found).not.toBeNull();
    expect(found?.strong).toBe(false);
  });

  it("says nothing for an ordinary page", () => {
    expect(inspectBotChallenge({ status: 200, html: article() })).toBeNull();
  });
});

describe("looksLikeLoginUrl", () => {
  it("is exported for the reader to use on a redirect", () => {
    expect(looksLikeLoginUrl("https://example.com/login?next=%2Fevents")).toBe(true);
    expect(looksLikeLoginUrl("https://accounts.google.com/o/oauth2/auth")).toBe(true);
    expect(looksLikeLoginUrl("https://login.example.org/")).toBe(true);
    expect(looksLikeLoginUrl("https://example.com/events/bearings")).toBe(false);
    expect(looksLikeLoginUrl("not a url")).toBe(false);
  });
});
