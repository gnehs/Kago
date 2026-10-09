/**
 * An SVG is a document, not a picture: it can carry scripts, pull in other files and addresses, and be written so
 * that drawing it never ends. One that is to be shown as an icon is read here and written out again from what was
 * understood of it: only the elements and attributes that draw, pointing only at other parts of the same file.
 * Anything this cannot read with certainty is not an icon, rather than something to be guessed at.
 */

const SVG_NS = "http://www.w3.org/2000/svg";
const XLINK_NS = "http://www.w3.org/1999/xlink";

const ELEMENTS = new Set([
  "svg", "g", "defs", "symbol", "use", "title", "desc", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "image",
  "linearGradient", "radialGradient", "stop", "clipPath", "mask", "pattern", "marker", "style", "filter", "feBlend", "feColorMatrix", "feComponentTransfer",
  "feComposite", "feConvolveMatrix", "feDiffuseLighting", "feDisplacementMap", "feDistantLight", "feDropShadow", "feFlood", "feFuncA", "feFuncB", "feFuncG",
  "feFuncR", "feGaussianBlur", "feMerge", "feMergeNode", "feMorphology", "feOffset", "fePointLight", "feSpecularLighting", "feSpotLight", "feTile", "feTurbulence"
]);
/** The elements whose text is part of the picture, or names it. Text anywhere else is only the spacing between tags. */
const TEXT_ELEMENTS = new Set(["text", "tspan", "title", "desc", "style"]);

const MAX_DEPTH = 64;
const MAX_ELEMENTS = 20_000;
/** How many elements a file may come to once every `<use>` is replaced by what it points at. */
const MAX_DRAWN = 100_000;

/** An element that stays: what it holds is kept in the order it was written, text and elements alike. */
type Node = { name: string; attributes: Array<[string, string]>; children: Array<Node | string> };

const ENTITIES = new Map([["lt", "<"], ["gt", ">"], ["amp", "&"], ["quot", '"'], ["apos", "'"]]);

/** Text as it was meant, with the five entities XML knows by itself and the numbered ones read; null for any other, which only a DTD could define. */
function decode(raw: string): string | null {
  let valid = true;
  const text = raw.replace(/&([^;&]*);?/g, (whole, body: string) => {
    if (!whole.endsWith(";")) valid = false;
    else if (ENTITIES.has(body)) return ENTITIES.get(body)!;
    else {
      const code = /^#x[0-9a-f]{1,6}$/i.test(body) ? Number.parseInt(body.slice(2), 16) : /^#\d{1,7}$/.test(body) ? Number.parseInt(body.slice(1), 10) : -1;
      if (code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)) return String.fromCodePoint(code);
      valid = false;
    }
    return "";
  });
  // Control characters have no place in XML, and are how a forbidden word is written so that it is not seen.
  return valid && !/[\0-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text) ? text : null;
}

const encode = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Whether every `url()` in a value points at a part of the same file. */
function localUrlsOnly(value: string): boolean {
  for (const match of value.matchAll(/url\s*\(([^)]*)\)?/gi)) {
    if (!/^\s*(["']?)#[^\s"'()\\<>]+\1\s*$/.test(match[1] ?? "") || !match[0].endsWith(")")) return false;
  }
  return true;
}

/** Whether a stylesheet or a `style` attribute only styles: no escapes to hide a word in, nothing fetched, nothing run. */
const safeCss = (css: string) => !/\\|@import|@namespace|@font-face|expression\s*\(|javascript\s*:|-moz-binding|behavior\s*:|image-set|\/\//i.test(css) && localUrlsOnly(css);

const localReference = (value: string) => /^#[^\s"'()\\<>]+$/.test(value.trim());
const embeddedPicture = (value: string) => /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\s]+$/.test(value.trim());

/** The attributes of an element that may stay, as they will be written. */
function keptAttributes(element: string, attributes: Array<[string, string]>): Array<[string, string]> {
  const kept = new Map<string, string>();
  for (const [name, value] of attributes) {
    // The namespaces are written by Kago, on the root, and nowhere else.
    if (name === "xmlns" || name.startsWith("xmlns:")) continue;
    if (name === "href" || name === "xlink:href") {
      if (localReference(value) || (element === "image" && embeddedPicture(value))) kept.set(name, value.trim());
      continue;
    }
    // Plain names only: no handlers, and no attributes of whatever program drew the file.
    if (!/^[A-Za-z][\w.-]*$/.test(name) && name !== "xml:space") continue;
    if (/^on/i.test(name)) continue;
    if (name === "style" ? !safeCss(value) : !localUrlsOnly(value)) continue;
    kept.set(name, value);
  }
  return [...kept];
}

const ATTRIBUTE = /\s+([^\s=/>"'<]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
const TAG_END = /\s*(\/?)>/y;
const NAME = /[A-Za-z_][\w.:-]*/y;

/** Reads the file into a tree of the elements that may stay; null when it is not XML this understands. */
function parse(source: string): Node | null {
  let root: Node | null = null;
  // Each open element, and whether it and everything in it is being kept.
  const open: Array<{ node: Node; kept: boolean }> = [];
  let elements = 0;
  let at = 0;

  const addText = (raw: string, literal: boolean): boolean => {
    const top = open.at(-1);
    if (!top) return raw.trim() === "";
    if (!top.kept || !TEXT_ELEMENTS.has(top.node.name)) return true;
    const text = literal ? raw : decode(raw);
    if (text === null) return false;
    top.node.children.push(text);
    return true;
  };

  while (at < source.length) {
    if (source[at] !== "<") {
      const next = source.indexOf("<", at);
      const end = next === -1 ? source.length : next;
      if (!addText(source.slice(at, end), false)) return null;
      at = end;
      continue;
    }
    if (source.startsWith("<!--", at)) {
      const end = source.indexOf("-->", at + 4);
      if (end === -1) return null;
      at = end + 3;
      continue;
    }
    if (source.startsWith("<![CDATA[", at)) {
      const end = source.indexOf("]]>", at + 9);
      if (end === -1 || !addText(source.slice(at + 9, end), true)) return null;
      at = end + 3;
      continue;
    }
    if (source.startsWith("<?", at)) {
      const end = source.indexOf("?>", at + 2);
      if (end === -1) return null;
      at = end + 2;
      continue;
    }
    if (source.startsWith("<!", at)) {
      // A DOCTYPE that only names the kind of document is dropped. One that defines entities of its own is how a
      // few bytes are made to stand for gigabytes, or for a file on the machine that reads it.
      const end = source.indexOf(">", at);
      if (end === -1 || open.length > 0 || root || source.slice(at, end).includes("[")) return null;
      at = end + 1;
      continue;
    }
    if (source.startsWith("</", at)) {
      NAME.lastIndex = at + 2;
      const name = NAME.exec(source)?.[0];
      TAG_END.lastIndex = NAME.lastIndex;
      const end = name ? TAG_END.exec(source) : null;
      const top = open.pop();
      if (!end || end[1] || !top || top.node.name !== name) return null;
      at = TAG_END.lastIndex;
      continue;
    }
    NAME.lastIndex = at + 1;
    const name = NAME.exec(source)?.[0];
    if (!name) return null;
    const attributes: Array<[string, string]> = [];
    let cursor = NAME.lastIndex;
    for (;;) {
      ATTRIBUTE.lastIndex = cursor;
      const match = ATTRIBUTE.exec(source);
      if (!match) break;
      const value = decode(match[2] ?? match[3] ?? "");
      if (value === null) return null;
      attributes.push([match[1]!, value]);
      cursor = ATTRIBUTE.lastIndex;
    }
    TAG_END.lastIndex = cursor;
    const end = TAG_END.exec(source);
    if (!end) return null;
    at = TAG_END.lastIndex;

    const parent = open.at(-1);
    if (!parent && root) return null;
    if (open.length >= MAX_DEPTH || (elements += 1) > MAX_ELEMENTS) return null;
    const kept = (parent?.kept ?? true) && ELEMENTS.has(name);
    const node: Node = { name, attributes: kept ? keptAttributes(name, attributes) : [], children: [] };
    if (!parent) {
      if (name !== "svg") return null;
      root = node;
    } else if (kept) parent.node.children.push(node);
    if (!end[1]) open.push({ node, kept });
  }
  return open.length === 0 ? root : null;
}

/**
 * How many elements the file comes to when it is drawn. An element that is used twice, inside one that is used
 * twice, and so on down, is a few lines that draw without end; so is one that uses itself.
 */
function drawnSize(root: Node): number {
  const byId = new Map<string, Node>();
  const index = (node: Node) => {
    const id = node.attributes.find(([name]) => name === "id")?.[1];
    if (id !== undefined && !byId.has(id)) byId.set(id, node);
    for (const child of node.children) if (typeof child !== "string") index(child);
  };
  index(root);
  const sizes = new Map<Node, number>();
  const visiting = new Set<Node>();
  const size = (node: Node): number => {
    const known = sizes.get(node);
    if (known !== undefined) return known;
    if (visiting.has(node)) return Infinity;
    visiting.add(node);
    let total = 1;
    if (node.name === "use") {
      const target = node.attributes.find(([name]) => name === "href" || name === "xlink:href")?.[1];
      const used = target ? byId.get(target.slice(1)) : undefined;
      if (used) total += size(used);
    }
    for (const child of node.children) if (typeof child !== "string") total += size(child);
    visiting.delete(node);
    total = Math.min(total, Number.MAX_SAFE_INTEGER);
    sizes.set(node, total);
    return total;
  };
  return size(root);
}

function write(node: Node, isRoot = false): string {
  const attributes = [...(isRoot ? ([["xmlns", SVG_NS], ["xmlns:xlink", XLINK_NS]] as Array<[string, string]>) : []), ...node.attributes];
  const head = `<${node.name}${attributes.map(([name, value]) => ` ${name}="${encode(value)}"`).join("")}`;
  // A stylesheet that does anything but style is left out whole.
  const unsafe = node.name === "style" && !safeCss(node.children.filter((child) => typeof child === "string").join(""));
  const body = unsafe ? "" : node.children.map((child) => (typeof child === "string" ? encode(child) : write(child))).join("");
  return body ? `${head}>${body}</${node.name}>` : `${head}/>`;
}

/** The same picture with nothing in it but what draws; null when the text is not an SVG that can be made safe. */
export function sanitizeSvg(source: string): string | null {
  const root = parse(source.replace(/^﻿/, ""));
  if (!root || drawnSize(root) > MAX_DRAWN) return null;
  return write(root, true);
}
