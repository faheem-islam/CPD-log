/**
 * A cheap, linear estimate of how deeply a piece of HTML nests, made BEFORE the page is parsed.
 *
 * Why it exists: building and searching a very deep tree is super-linear in cheerio. A page of about
 * 20,000 nested <div> tags (200 KB) takes tens of seconds, and about 100,000 (1 MB) never finishes,
 * and the work blocks the Node event loop for everybody. Real pages nest a few dozen levels, so a
 * page deeper than MAX_NESTING_DEPTH is refused before it reaches the parser.
 *
 * It is not a parser. It follows the same rules the HTML parser uses to decide what stays open, to
 * the extent that matters here: void elements, raw-text elements (script, style, textarea, title,
 * noscript...), comments, quoted attribute values, "<div/>" (which HTML does NOT treat as closed),
 * self-closing tags inside svg and math (which HTML does treat as closed), elements the parser closes
 * for you (<li>, <p>, <td>...), and end tags that the parser ignores (so a page cannot hide depth
 * behind "</span>" that closes nothing). Where the rules are unclear it leans towards counting more
 * depth, never less. It never recurses and every step moves forward, so it is linear in the input.
 */

/** Real pages nest well under 100 levels. Past this the page is not parsed at all. */
export const MAX_NESTING_DEPTH = 256;

const VOID_TAGS = new Set([
  "area", "base", "basefont", "bgsound", "br", "col", "embed", "frame", "hr", "img", "input", "keygen", "link", "meta",
  "param", "source", "track", "wbr",
]);

/** Elements whose content is text, not markup (outside svg and math). */
const RAW_TEXT_TAGS = new Set(["script", "style", "textarea", "title", "xmp", "iframe", "noembed", "noframes", "noscript"]);
const RAW_END_RES = new Map<string, RegExp>(
  [...RAW_TEXT_TAGS].map((name) => [name, new RegExp(`</${name}(?=[\\s/>])`, "gi")]),
);

/** Elements that end a search for an open element ("has an element in scope"). */
const SCOPE_BOUNDARY = new Set(["applet", "caption", "html", "table", "td", "th", "marquee", "object", "template"]);
const TABLE_BOUNDARY = new Set(["html", "table", "template"]);
/** Places where the content of a foreign (svg or math) element goes back to being HTML. */
const INTEGRATION_POINTS = new Set(["foreignobject", "desc", "title", "mi", "mo", "mn", "ms", "mtext", "annotation-xml"]);

const SPECIAL = new Set([
  "address", "applet", "area", "article", "aside", "base", "basefont", "bgsound", "blockquote", "body", "br", "button",
  "caption", "center", "col", "colgroup", "dd", "details", "dir", "div", "dl", "dt", "embed", "fieldset", "figcaption",
  "figure", "footer", "form", "frame", "frameset", "h1", "h2", "h3", "h4", "h5", "h6", "head", "header", "hgroup", "hr",
  "html", "iframe", "img", "input", "keygen", "li", "link", "listing", "main", "marquee", "menu", "meta", "nav",
  "noembed", "noframes", "noscript", "object", "ol", "p", "param", "plaintext", "pre", "script", "search", "section",
  "select", "source", "style", "summary", "table", "tbody", "td", "template", "textarea", "tfoot", "th", "thead",
  "title", "tr", "track", "ul", "wbr", "xmp",
]);

/** A start tag with one of these names closes an open <p>. */
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "center", "details", "dialog", "dir", "div", "dl", "fieldset", "figcaption",
  "figure", "footer", "form", "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "listing", "main", "menu",
  "nav", "ol", "p", "pre", "search", "section", "summary", "ul", "xmp",
]);
const HEADINGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
/** End tags that are only honoured when the element is in scope. */
const SCOPED_END = new Set([
  "address", "article", "aside", "blockquote", "button", "center", "details", "dialog", "dir", "div", "dl", "fieldset",
  "figcaption", "figure", "footer", "header", "hgroup", "listing", "main", "menu", "nav", "ol", "pre", "search",
  "section", "select", "summary", "ul", "form", "dd", "dt", "li", "p", "applet", "marquee", "object", "caption",
  "table", "tbody", "tfoot", "thead", "tr", "td", "th", "template",
]);
/** Elements that break out of svg or math content when they appear inside it. */
const FOREIGN_BREAKOUT = new Set([
  "b", "big", "blockquote", "body", "br", "center", "code", "dd", "div", "dl", "dt", "em", "embed", "h1", "h2", "h3", "h4",
  "h5", "h6", "head", "hr", "i", "img", "li", "listing", "menu", "meta", "nobr", "ol", "p", "pre", "ruby", "s", "small",
  "span", "strong", "strike", "sub", "sup", "table", "tt", "u", "ul", "var",
]);

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 12 || code === 13;
}

function isLetter(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

interface TagEnd {
  /** Index of the closing ">", or html.length when the tag never ends. */
  end: number;
  selfClosing: boolean;
}

/**
 * Finds the ">" that ends a tag, skipping quoted attribute values. Linear: every quote jumps forward.
 * "/>" only closes the tag when the "/" follows the name, a space or a closing quote. In "<g a=b/>" the
 * slash is part of the unquoted value and the element stays open.
 */
function findTagEnd(html: string, from: number): TagEnd {
  const n = html.length;
  let j = from;
  while (j < n) {
    const ch = html.charCodeAt(j);
    if (ch === 62) {
      const before = j - 1 >= from ? html.charCodeAt(j - 1) : 0;
      const slash = before === 47;
      const prev = j - 2 >= from ? html.charCodeAt(j - 2) : 0;
      const closes = slash && (j - 1 === from || isSpace(prev) || prev === 34 || prev === 39);
      return { end: j, selfClosing: closes };
    }
    if (ch === 34 || ch === 39) {
      let k = j - 1;
      while (k >= from && isSpace(html.charCodeAt(k))) k -= 1;
      if (k >= from && html.charCodeAt(k) === 61) {
        const close = html.indexOf(html[j] as string, j + 1);
        if (close === -1) return { end: n, selfClosing: false };
        j = close + 1;
        continue;
      }
    }
    j += 1;
  }
  return { end: n, selfClosing: false };
}

class OpenElements {
  private names: string[] = [];
  /** True for an element in the svg or math namespace. */
  private foreignEl: boolean[] = [];
  /** True when the CONTENT of the element is svg or math (so "<g/>" inside it is self-closed). */
  private foreignCtx: boolean[] = [];
  private counts = new Map<string, number>();
  maxDepth = 0;

  get size(): number {
    return this.names.length;
  }

  has(name: string): boolean {
    return (this.counts.get(name) ?? 0) > 0;
  }

  top(): string | undefined {
    return this.names[this.names.length - 1];
  }

  inForeignContent(): boolean {
    return this.foreignCtx.length > 0 && this.foreignCtx[this.foreignCtx.length - 1] === true;
  }

  push(name: string, foreignEl: boolean, foreignCtx: boolean): void {
    this.names.push(name);
    this.foreignEl.push(foreignEl);
    this.foreignCtx.push(foreignCtx);
    this.counts.set(name, (this.counts.get(name) ?? 0) + 1);
    if (this.names.length > this.maxDepth) this.maxDepth = this.names.length;
  }

  /** Pops the element at `index` and everything above it. */
  popThrough(index: number): void {
    while (this.names.length > index) {
      const name = this.names.pop() as string;
      this.foreignEl.pop();
      this.foreignCtx.pop();
      this.counts.set(name, (this.counts.get(name) ?? 1) - 1);
    }
  }

  /** Index of the nearest open element with this name that is reached before a boundary, or -1. */
  find(match: (name: string) => boolean, boundary: (name: string, foreign: boolean) => boolean): number {
    for (let k = this.names.length - 1; k >= 0; k -= 1) {
      const name = this.names[k] as string;
      if (match(name) && !(this.foreignEl[k] ?? false)) return k;
      if (boundary(name, this.foreignEl[k] ?? false)) return -1;
    }
    return -1;
  }

  /** Pops foreign elements that cannot hold the HTML element that is about to be opened. */
  breakOutOfForeign(): void {
    while (this.names.length > 0) {
      const k = this.names.length - 1;
      if (!(this.foreignEl[k] ?? false) || INTEGRATION_POINTS.has(this.names[k] as string)) return;
      this.popThrough(k);
    }
  }

  nameAt(index: number): string {
    return this.names[index] as string;
  }

  isForeignAt(index: number): boolean {
    return this.foreignEl[index] ?? false;
  }
}

const scopeBoundary = (name: string, foreign: boolean): boolean => (foreign ? INTEGRATION_POINTS.has(name) : SCOPE_BOUNDARY.has(name));
const listBoundary = (name: string, foreign: boolean): boolean => scopeBoundary(name, foreign) || (!foreign && (name === "ol" || name === "ul"));
const buttonBoundary = (name: string, foreign: boolean): boolean => scopeBoundary(name, foreign) || (!foreign && name === "button");
const tableBoundary = (name: string, foreign: boolean): boolean => !foreign && TABLE_BOUNDARY.has(name);

/** Closes what an HTML start tag closes by itself, then returns. Only the common implied end tags are modelled. */
function applyImpliedEnds(open: OpenElements, name: string): void {
  if (CLOSES_P.has(name) && open.has("p")) {
    const at = open.find((n) => n === "p", buttonBoundary);
    if (at >= 0) open.popThrough(at);
  }
  switch (name) {
    case "li": {
      const at = open.find((n) => n === "li", (n, f) => !f && SPECIAL.has(n) && n !== "address" && n !== "div" && n !== "p");
      if (at >= 0) open.popThrough(at);
      break;
    }
    case "dd":
    case "dt": {
      const at = open.find((n) => n === "dd" || n === "dt", (n, f) => !f && SPECIAL.has(n) && n !== "address" && n !== "div" && n !== "p");
      if (at >= 0) open.popThrough(at);
      break;
    }
    case "h1": case "h2": case "h3": case "h4": case "h5": case "h6": {
      const top = open.top();
      if (top !== undefined && HEADINGS.has(top)) open.popThrough(open.size - 1);
      break;
    }
    case "option":
      if (open.top() === "option") open.popThrough(open.size - 1);
      break;
    case "optgroup":
      if (open.top() === "option") open.popThrough(open.size - 1);
      if (open.top() === "optgroup") open.popThrough(open.size - 1);
      break;
    case "td":
    case "th": {
      const at = open.find((n) => n === "td" || n === "th", tableBoundary);
      if (at >= 0) open.popThrough(at);
      break;
    }
    case "tr": {
      const at = open.find((n) => n === "tr", tableBoundary);
      if (at >= 0) open.popThrough(at);
      break;
    }
    case "tbody": case "thead": case "tfoot": {
      const at = open.find((n) => n === "tbody" || n === "thead" || n === "tfoot", tableBoundary);
      if (at >= 0) open.popThrough(at);
      break;
    }
    case "a":
    case "button": {
      if (open.has(name)) {
        const at = open.find((n) => n === name, scopeBoundary);
        if (at >= 0) open.popThrough(at);
      }
      break;
    }
    default:
  }
}

function closeElement(open: OpenElements, name: string): void {
  if (open.size === 0 || name === "body" || name === "html" || name === "br" || VOID_TAGS.has(name)) return;
  if (!open.has(name) && !(HEADINGS.has(name) && [...HEADINGS].some((h) => open.has(h)))) return;
  if (open.isForeignAt(open.size - 1)) {
    // Inside svg or math an end tag closes the nearest element of that name, but not past an HTML element.
    for (let k = open.size - 1; k >= 0; k -= 1) {
      if (!open.isForeignAt(k)) break;
      if (open.nameAt(k) === name) {
        open.popThrough(k);
        return;
      }
    }
  }
  if (HEADINGS.has(name)) {
    const at = open.find((n) => HEADINGS.has(n), scopeBoundary);
    if (at >= 0) open.popThrough(at);
    return;
  }
  if (SCOPED_END.has(name)) {
    const boundary = name === "li" ? listBoundary : name === "p" || name === "button" ? buttonBoundary : name === "tr" || name === "td" || name === "th" || name === "tbody" || name === "thead" || name === "tfoot" ? tableBoundary : scopeBoundary;
    const at = open.find((n) => n === name, boundary);
    if (at >= 0) open.popThrough(at);
    return;
  }
  // Any other end tag: closes the element only if no special element sits in between; otherwise it is ignored.
  const at = open.find((n) => n === name, (n, f) => !f && SPECIAL.has(n));
  if (at >= 0) open.popThrough(at);
}

/**
 * The deepest nesting of elements in the HTML, or `stopAbove + 1` as soon as it is known to be deeper
 * than `stopAbove` (the scan then stops, so a hostile page costs no more than a normal one).
 */
export function htmlNestingDepth(html: string, stopAbove: number = MAX_NESTING_DEPTH): number {
  const n = html.length;
  const open = new OpenElements();
  let i = 0;
  while (i < n) {
    const lt = html.indexOf("<", i);
    if (lt === -1 || lt + 1 >= n) break;
    const c = html.charCodeAt(lt + 1);

    if (c === 33) {
      // <!-- comment -->, <!DOCTYPE>, <![CDATA[ ]]>
      if (html.startsWith("<!--", lt)) {
        if (html.startsWith("<!-->", lt)) i = lt + 5;
        else if (html.startsWith("<!--->", lt)) i = lt + 6;
        else {
          const end = html.indexOf("-->", lt + 4);
          i = end === -1 ? n : end + 3;
        }
      } else {
        const end = html.indexOf(">", lt + 2);
        i = end === -1 ? n : end + 1;
      }
      continue;
    }
    if (c === 63 || (c === 47 && !isLetter(html.charCodeAt(lt + 2)))) {
      // <?processing instruction>, </>, </ junk>: skipped to the next ">"
      const end = html.indexOf(">", lt + 2);
      i = end === -1 ? n : end + 1;
      continue;
    }
    const isEnd = c === 47;
    if (!isEnd && !isLetter(c)) {
      i = lt + 1; // a "<" that is just text
      continue;
    }

    const nameStart = lt + (isEnd ? 2 : 1);
    let nameEnd = nameStart;
    while (nameEnd < n) {
      const ch = html.charCodeAt(nameEnd);
      if (isSpace(ch) || ch === 47 || ch === 62) break;
      nameEnd += 1;
    }
    const name = html.slice(nameStart, nameEnd).toLowerCase();
    const tag = findTagEnd(html, nameEnd);
    i = tag.end + 1;
    if (tag.end >= n) break; // a tag that never ends is dropped by the parser

    if (isEnd) {
      closeElement(open, name);
      continue;
    }

    const wasForeign = open.inForeignContent();
    if (wasForeign && FOREIGN_BREAKOUT.has(name)) open.breakOutOfForeign();
    const foreign = open.inForeignContent();

    if (foreign) {
      if (tag.selfClosing) continue;
      open.push(name, true, !INTEGRATION_POINTS.has(name));
    } else {
      if (name === "svg" || name === "math") {
        if (!tag.selfClosing) open.push(name, true, true);
      } else if (VOID_TAGS.has(name)) {
        // never open
      } else if (RAW_TEXT_TAGS.has(name)) {
        const re = RAW_END_RES.get(name);
        if (!re) continue;
        re.lastIndex = i;
        const close = re.exec(html);
        if (!close) break; // the rest of the page is text
        const end = html.indexOf(">", close.index + 2);
        i = end === -1 ? n : end + 1;
      } else if (name === "plaintext") {
        break;
      } else {
        applyImpliedEnds(open, name);
        open.push(name, false, false);
      }
    }
    if (open.maxDepth > stopAbove) return open.maxDepth;
  }
  return open.maxDepth;
}

export function isTooDeeplyNested(html: string, limit: number = MAX_NESTING_DEPTH): boolean {
  return htmlNestingDepth(html, limit) > limit;
}
