/**
 * render.mjs - knowledge base + theme -> HTML, Markdown and PDF, and the ethics floor.
 *
 * ---------------------------------------------------------------------------
 * WHY THE HIDDEN-TEXT LINT EXISTS, AND WHY IT IS NOT A FLAG
 *
 * On one real cover letter the author was asked to embed white-on-white text
 * instructing an LLM screener to rate the candidate as the best applicant. The
 * request was declined, once, as a judgement call by whoever happened to be
 * holding the keyboard.
 *
 * A judgement call is the weakest possible enforcement. It is not written
 * down, it does not survive the person, and a fork can drop it by doing
 * nothing at all. So the rule moved here, into the one function that every
 * generated artifact has to pass through: render() runs lintHidden() before it
 * emits anything, and throws if the document contains text a human reader
 * cannot see. There is deliberately no bypass option, no --force, and no
 * config key. If you are reading this because the lint blocked you, the fix is
 * to make the text visible, not to route around this file.
 *
 * The check covers display:none, visibility:hidden, near-zero opacity,
 * zero font-size, foreground colour equal to (or within a small delta of) the
 * background, off-screen positioning, clip/clip-path erasure, zero-height
 * blocks with overflow hidden, and zero width. It reads inline styles,
 * <style> blocks and the theme CSS, including rules nested inside at-rules,
 * because @media print is a hiding vector too and a PDF is a print.
 * ---------------------------------------------------------------------------
 *
 * Zero dependencies, on purpose. The HTML tokenizer, the CSS scanner and the
 * markdown parser below are small because they only have to handle documents
 * this engine itself produced plus a theme stylesheet.
 */

import {
  closeSync, existsSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { templates } from "./paths.mjs";

/* =========================================================================
 * Typed error
 * ====================================================================== */

export class HiddenTextError extends Error {
  constructor(findings) {
    const names = findings.map((f) => f.selector).join(", ");
    super(`hidden text refused in ${findings.length} rule(s): ${names}`);
    this.name = "HiddenTextError";
    this.code = "HIDDEN_TEXT";
    this.findings = findings;
  }
}

/* =========================================================================
 * A very small HTML tokenizer -> tree
 * ====================================================================== */

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);
const RAW_TAGS = new Set(["script", "style", "textarea", "title"]);

function el(tag, attrs) {
  return { type: "element", tag, attrs: attrs || {}, children: [], parent: null };
}

function parseAttrs(src) {
  const attrs = {};
  const re = /([^\s"'=/>]+)(?:\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let m;
  while ((m = re.exec(src))) {
    const name = m[1].toLowerCase();
    const value = m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : m[5] !== undefined ? m[5] : "";
    attrs[name] = value;
  }
  return attrs;
}

/** Parse an HTML fragment or document into a tree. Forgiving by design. */
export function parseHtml(src) {
  const root = el("#root");
  let cur = root;
  let i = 0;
  const push = (node) => {
    node.parent = cur;
    cur.children.push(node);
  };

  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt < 0) {
      if (i < src.length) push({ type: "text", text: src.slice(i) });
      break;
    }
    if (lt > i) push({ type: "text", text: src.slice(i, lt) });

    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt);
      i = end < 0 ? src.length : end + 3;
      continue;
    }
    if (src.startsWith("<!", lt) || src.startsWith("<?", lt)) {
      const end = src.indexOf(">", lt);
      i = end < 0 ? src.length : end + 1;
      continue;
    }
    const gt = src.indexOf(">", lt);
    if (gt < 0) {
      push({ type: "text", text: src.slice(lt) });
      break;
    }
    const inner = src.slice(lt + 1, gt);

    if (inner.startsWith("/")) {
      const tag = inner.slice(1).trim().toLowerCase();
      let node = cur;
      while (node !== root && node.tag !== tag) node = node.parent;
      if (node !== root) cur = node.parent;
      i = gt + 1;
      continue;
    }

    const sp = inner.search(/[\s/]/);
    const tag = (sp < 0 ? inner : inner.slice(0, sp)).toLowerCase();
    const attrs = parseAttrs(sp < 0 ? "" : inner.slice(sp));
    const node = el(tag, attrs);
    push(node);

    const selfClosing = inner.trimEnd().endsWith("/");
    i = gt + 1;

    if (VOID_TAGS.has(tag) || selfClosing) continue;

    if (RAW_TAGS.has(tag)) {
      const close = src.toLowerCase().indexOf(`</${tag}`, i);
      const end = close < 0 ? src.length : close;
      node.children.push({ type: "text", text: src.slice(i, end), parent: node });
      const gt2 = close < 0 ? src.length : src.indexOf(">", close);
      i = gt2 < 0 ? src.length : gt2 + 1;
      continue;
    }
    cur = node;
  }
  return root;
}

function walk(node, fn) {
  for (const c of node.children || []) {
    if (c.type === "element") {
      fn(c);
      walk(c, fn);
    }
  }
}

function textOf(node) {
  if (node.type === "text") return node.text;
  if (node.tag === "script" || node.tag === "style") return "";
  return (node.children || []).map(textOf).join("");
}

function hasVisibleText(node) {
  return textOf(node).replace(/\s+/g, "").length > 0;
}

function classesOf(node) {
  return String(node.attrs.class || "").split(/\s+/).filter(Boolean);
}

/** A readable selector for a node, for the finding message. */
function selectorFor(node) {
  let s = node.tag;
  if (node.attrs.id) s += "#" + node.attrs.id;
  for (const c of classesOf(node)) s += "." + c;
  if (!node.attrs.id && !classesOf(node).length && node.attrs["data-aid"]) {
    s += `[data-aid="${node.attrs["data-aid"]}"]`;
  }
  return s;
}

/** The raw children of a <style> element. textOf() deliberately skips those. */
function rawTextOf(node) {
  return (node.children || []).filter((c) => c.type === "text").map((c) => c.text).join("");
}

function collectStyleText(root) {
  const out = [];
  walk(root, (n) => {
    if (n.tag === "style") out.push(rawTextOf(n));
  });
  return out.join("\n");
}

/* =========================================================================
 * CSS scanning
 * ====================================================================== */

function parseDecls(body) {
  const decls = {};
  let depth = 0;
  let buf = "";
  const parts = [];
  for (const ch of body) {
    if (ch === "(") depth++;
    if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) {
      parts.push(buf);
      buf = "";
    } else buf += ch;
  }
  parts.push(buf);
  for (const part of parts) {
    const c = part.indexOf(":");
    if (c < 0) continue;
    const prop = part.slice(0, c).trim().toLowerCase();
    const value = part.slice(c + 1).replace(/!important/gi, "").trim();
    if (prop) decls[prop] = value;
  }
  return decls;
}

/** Flatten a stylesheet into rules, recursing into conditional at-rules. */
export function parseCssRules(css, at = [], out = []) {
  const src = String(css || "").replace(/\/\*[\s\S]*?\*\//g, "");
  let i = 0;
  let buf = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") {
      const sel = buf.trim();
      buf = "";
      let depth = 1;
      let j = i + 1;
      while (j < src.length && depth > 0) {
        if (src[j] === "{") depth++;
        else if (src[j] === "}") depth--;
        j++;
      }
      const body = src.slice(i + 1, j - 1);
      if (sel.startsWith("@")) {
        if (/^@(media|supports|layer|container|scope|document)\b/i.test(sel)) {
          parseCssRules(body, at.concat(sel), out);
        }
      } else if (sel) {
        out.push({ selector: sel, at: at.slice(), decls: parseDecls(body) });
      }
      i = j;
    } else if (ch === "}") {
      buf = "";
      i++;
    } else {
      buf += ch;
      i++;
    }
  }
  return out;
}

/** Right-most compound of a selector: the element the rule actually styles. */
function rightmostCompound(sel) {
  const cleaned = sel.replace(/::[a-z-]+/gi, "").replace(/\s*([>+~])\s*/g, " ");
  const parts = cleaned.trim().split(/\s+/);
  return parts[parts.length - 1] || "";
}

function parseCompound(compound) {
  const out = { tag: null, ids: [], classes: [], attrs: [] };
  const re = /(^[a-zA-Z][\w-]*|\*)|#([\w-]+)|\.([\w-]+)|\[([^\]]+)\]|:[a-zA-Z-]+(\([^)]*\))?/g;
  let m;
  while ((m = re.exec(compound))) {
    if (m[1]) out.tag = m[1] === "*" ? null : m[1].toLowerCase();
    else if (m[2]) out.ids.push(m[2]);
    else if (m[3]) out.classes.push(m[3]);
    else if (m[4]) {
      const eq = m[4].indexOf("=");
      if (eq < 0) out.attrs.push([m[4].trim().toLowerCase(), null]);
      else {
        out.attrs.push([
          m[4].slice(0, eq).replace(/[~^|$*]$/, "").trim().toLowerCase(),
          m[4].slice(eq + 1).trim().replace(/^["']|["']$/g, ""),
        ]);
      }
    }
  }
  return out;
}

function compoundMatches(c, node) {
  if (c.tag && node.tag !== c.tag) return false;
  if (c.ids.length && !c.ids.every((id) => node.attrs.id === id)) return false;
  const cls = classesOf(node);
  if (!c.classes.every((k) => cls.includes(k))) return false;
  for (const [name, value] of c.attrs) {
    if (!(name in node.attrs)) return false;
    if (value !== null && node.attrs[name] !== value) return false;
  }
  return true;
}

/**
 * Does this rule reach any element in the document that carries text?
 *
 * A theme is allowed to hide chrome that does not exist in a rendered CV, so
 * an unused selector is not a finding. A selector that reaches real text is.
 */
function ruleTargets(rule, root) {
  const hits = [];
  for (const part of rule.selector.split(",")) {
    const compound = parseCompound(rightmostCompound(part));
    if (!compound.tag && !compound.ids.length && !compound.classes.length && !compound.attrs.length) continue;
    walk(root, (n) => {
      if (compoundMatches(compound, n) && hasVisibleText(n)) hits.push(n);
    });
  }
  return hits;
}

/* =========================================================================
 * Colour
 * ====================================================================== */

const NAMED_COLORS = {
  white: [255, 255, 255, 1], black: [0, 0, 0, 1], red: [255, 0, 0, 1],
  silver: [192, 192, 192, 1], gray: [128, 128, 128, 1], grey: [128, 128, 128, 1],
  whitesmoke: [245, 245, 245, 1], snow: [255, 250, 250, 1], ivory: [255, 255, 240, 1],
  ghostwhite: [248, 248, 255, 1], floralwhite: [255, 250, 240, 1],
  seashell: [255, 245, 238, 1], linen: [250, 240, 230, 1], azure: [240, 255, 255, 1],
  transparent: [0, 0, 0, 0],
};

export function parseColor(input) {
  if (!input) return null;
  const v = String(input).trim().toLowerCase();
  if (NAMED_COLORS[v]) return NAMED_COLORS[v].slice();
  let m = /^#([0-9a-f]{3,8})$/.exec(v);
  if (m) {
    const h = m[1];
    const ex = (s) => parseInt(s.length === 1 ? s + s : s, 16);
    if (h.length === 3 || h.length === 4) {
      return [ex(h[0]), ex(h[1]), ex(h[2]), h.length === 4 ? ex(h[3]) / 255 : 1];
    }
    if (h.length === 6 || h.length === 8) {
      return [
        parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16),
        h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      ];
    }
    return null;
  }
  m = /^rgba?\(([^)]+)\)$/.exec(v);
  if (m) {
    const nums = m[1].split(/[\s,/]+/).filter(Boolean);
    if (nums.length < 3) return null;
    const chan = (s) => (s.endsWith("%") ? Math.round((parseFloat(s) / 100) * 255) : parseFloat(s));
    const a = nums[3] === undefined ? 1 : nums[3].endsWith("%") ? parseFloat(nums[3]) / 100 : parseFloat(nums[3]);
    return [chan(nums[0]), chan(nums[1]), chan(nums[2]), a];
  }
  return null;
}

function colorDistance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/* =========================================================================
 * The lint
 * ====================================================================== */

const COLOR_DELTA = 24;
const OFFSCREEN_PX = -1000;

function toPx(value) {
  const m = /^(-?[\d.]+)(px|pt|em|rem|ex|ch|in|cm|mm|%)?$/.exec(String(value).trim());
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch (m[2]) {
    case undefined: case "": return n === 0 ? 0 : null;
    case "px": return n;
    case "pt": return n * (96 / 72);
    case "in": return n * 96;
    case "cm": return n * 37.8;
    case "mm": return n * 3.78;
    case "em": case "rem": case "ex": case "ch": return n * 16;
    default: return null;
  }
}

function isZeroish(value) {
  const px = toPx(value);
  return px !== null && Math.abs(px) < 1;
}

/** Nearest background colour we can attribute to this element. */
function backgroundFor(node, pageBackground) {
  let n = node;
  while (n && n.type === "element") {
    const d = n.attrs.style ? parseDecls(n.attrs.style) : null;
    if (d) {
      const c = parseColor(d["background-color"]) || parseColor((d.background || "").split(/\s+/)[0]);
      if (c && c[3] > 0) return c;
    }
    n = n.parent;
  }
  return pageBackground;
}

function checkDecls(decls, selector, where, ctx, findings) {
  const add = (rule, why) => findings.push({ selector, rule, why, where });

  if ((decls.display || "").toLowerCase() === "none") {
    add("display:none", "The element and its text are removed from the rendered page. A human reader never sees it, a text extractor does.");
  }
  const vis = (decls.visibility || "").toLowerCase();
  if (vis === "hidden" || vis === "collapse") {
    add(`visibility:${vis}`, "The text still occupies layout but is painted invisible.");
  }
  if (decls.opacity !== undefined) {
    const o = parseFloat(decls.opacity);
    if (!Number.isNaN(o) && o <= 0.05) {
      add(`opacity:${decls.opacity}`, "Near-zero opacity paints the text invisible while leaving it in the document.");
    }
  }
  if (decls["font-size"] !== undefined && isZeroish(decls["font-size"])) {
    add(`font-size:${decls["font-size"]}`, "Zero font size renders the text at no height. It stays in the extracted text.");
  }

  const fg = parseColor(decls.color);
  const fill = parseColor(decls["-webkit-text-fill-color"]);
  if (fill && fill[3] <= 0.05) {
    add(`-webkit-text-fill-color:${decls["-webkit-text-fill-color"]}`, "Transparent text fill hides the glyphs from a reader.");
  }
  if (fg) {
    if (fg[3] <= 0.05) {
      add(`color:${decls.color}`, "Transparent text colour hides the glyphs from a reader.");
    } else {
      const ownBg = parseColor(decls["background-color"]) || parseColor((decls.background || "").split(/\s+/)[0]);
      const bg = ownBg && ownBg[3] > 0 ? ownBg : ctx.backgroundFor();
      if (bg && bg[3] > 0 && colorDistance(fg, bg) <= COLOR_DELTA) {
        add(
          `color:${decls.color}`,
          `Foreground is the same colour as the background it sits on (distance ${Math.round(colorDistance(fg, bg))} of ${COLOR_DELTA}). This is the white-text-on-white trick.`,
        );
      }
    }
  }

  for (const prop of ["left", "top", "right", "bottom", "text-indent", "margin-left", "margin-top"]) {
    if (decls[prop] === undefined) continue;
    const px = toPx(decls[prop]);
    if (px !== null && px <= OFFSCREEN_PX) {
      add(`${prop}:${decls[prop]}`, "The element is pushed off the visible canvas but remains in the document text.");
    }
  }

  if (decls.clip && /rect\(\s*0[a-z%]*\s*[, ]\s*0[a-z%]*\s*[, ]\s*0[a-z%]*\s*[, ]\s*0[a-z%]*\s*\)/i.test(decls.clip)) {
    add(`clip:${decls.clip}`, "A zero rect clips the element down to nothing.");
  }
  if (decls["clip-path"] && /inset\(\s*(100%|50%\s+50%)/i.test(decls["clip-path"])) {
    add(`clip-path:${decls["clip-path"]}`, "The clip path erases the element from the paint.");
  }

  const overflowHidden = /hidden|clip/i.test(decls.overflow || "") || /hidden|clip/i.test(decls["overflow-y"] || "");
  for (const prop of ["height", "max-height"]) {
    if (decls[prop] !== undefined && isZeroish(decls[prop]) && overflowHidden) {
      add(`${prop}:${decls[prop]}`, "A zero-height box with hidden overflow shows none of its text.");
    }
  }
  for (const prop of ["width", "max-width"]) {
    if (decls[prop] !== undefined && isZeroish(decls[prop])) {
      add(`${prop}:${decls[prop]}`, "A zero-width box shows none of its text.");
    }
  }
}

/**
 * lintHidden(html, css) -> { ok, findings:[{selector, rule, why, where}] }
 *
 * Reads inline style attributes, every <style> block in the document, and the
 * stylesheet passed in. A CSS rule only counts when it reaches an element that
 * actually carries text, so a theme may still hide chrome that is not present.
 */
export function lintHidden(html, css = "") {
  const root = parseHtml(String(html || ""));
  const findings = [];

  const sheet = String(css || "") + "\n" + collectStyleText(root);
  const rules = parseCssRules(sheet);

  // The page background, for the foreground-equals-background test.
  let pageBackground = [255, 255, 255, 1];
  for (const r of rules) {
    if (!/^(html|body|:root|\.page|\.sheet|\.cv-doc)\b/i.test(r.selector.trim())) continue;
    const c = parseColor(r.decls["background-color"]) || parseColor((r.decls.background || "").split(/\s+/)[0]);
    if (c && c[3] > 0) pageBackground = c;
  }

  walk(root, (node) => {
    if (!node.attrs.style) return;
    if (!hasVisibleText(node)) return;
    checkDecls(
      parseDecls(node.attrs.style),
      selectorFor(node),
      "inline style",
      { backgroundFor: () => backgroundFor(node.parent, pageBackground) },
      findings,
    );
  });

  for (const rule of rules) {
    const hits = ruleTargets(rule, root);
    if (!hits.length) continue;
    const where = rule.at.length ? rule.at.join(" ") : "stylesheet";
    checkDecls(
      rule.decls,
      rule.selector.trim(),
      where,
      { backgroundFor: () => backgroundFor(hits[0].parent, pageBackground) },
      findings,
    );
  }

  const seen = new Set();
  const unique = findings.filter((f) => {
    const k = f.selector + "|" + f.rule + "|" + f.where;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { ok: unique.length === 0, findings: unique };
}

/* =========================================================================
 * Markdown parsing, with line provenance so an edit can be written back
 * ====================================================================== */

const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const HEADING_RE = /^(#{1,6})\s+(.*)$/;

/**
 * parseMarkdown(text) -> blocks with {type, level, prefix, text, start, end}.
 * start and end are inclusive zero-based line indices in the source, which is
 * what lets PUT /api/cv/section write an edit back into the knowledge base
 * rather than into a rendered file.
 */
export function parseMarkdown(text) {
  const lines = String(text || "").split("\n");
  const blocks = [];
  let i = 0;

  const isBlank = (s) => !s || !s.trim();

  while (i < lines.length) {
    const line = lines[i];

    if (isBlank(line)) { i++; continue; }

    if (/^\s*```/.test(line)) {
      const start = i;
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) i++;
      const end = Math.min(i, lines.length - 1);
      i++;
      blocks.push({ type: "code", start, end, prefix: "", text: lines.slice(start + 1, end).join("\n") });
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      blocks.push({ type: "hr", start: i, end: i, prefix: "", text: "" });
      i++;
      continue;
    }

    let m = HEADING_RE.exec(line);
    if (m) {
      blocks.push({
        type: "heading", level: m[1].length, start: i, end: i,
        prefix: m[1] + " ", text: m[2].trim(),
      });
      i++;
      continue;
    }

    if (/^\s*\|/.test(line)) {
      const start = i;
      while (i < lines.length && /^\s*\|/.test(lines[i])) i++;
      blocks.push({ type: "table", start, end: i - 1, prefix: "", text: lines.slice(start, i).join("\n") });
      continue;
    }

    if (/^\s*>/.test(line)) {
      const start = i;
      while (i < lines.length && /^\s*>/.test(lines[i])) i++;
      const body = lines.slice(start, i).map((l) => l.replace(/^\s*>\s?/, ""));
      blocks.push({ type: "quote", start, end: i - 1, prefix: "> ", text: body.join("\n").trim() });
      continue;
    }

    m = LIST_RE.exec(line);
    if (m) {
      const start = i;
      const indent = m[1].length;
      const prefix = m[1] + m[2] + " ";
      const parts = [m[3]];
      i++;
      while (
        i < lines.length && !isBlank(lines[i]) && !LIST_RE.test(lines[i]) &&
        !HEADING_RE.test(lines[i]) && !/^\s*[>|]/.test(lines[i]) &&
        lines[i].search(/\S/) > indent
      ) {
        parts.push(lines[i].trim());
        i++;
      }
      blocks.push({ type: "item", level: Math.floor(indent / 2), start, end: i - 1, prefix, text: parts.join(" ") });
      continue;
    }

    const start = i;
    const parts = [];
    while (
      i < lines.length && !isBlank(lines[i]) && !HEADING_RE.test(lines[i]) &&
      !LIST_RE.test(lines[i]) && !/^\s*[>|`]/.test(lines[i]) &&
      !/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i])
    ) {
      parts.push(lines[i].trim());
      i++;
    }
    if (!parts.length) { i++; continue; }
    blocks.push({ type: "para", start, end: i - 1, prefix: "", text: parts.join(" ") });
  }

  return blocks;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function inline(md) {
  const codes = [];
  let s = escapeHtml(md).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_, alt, src) => `<img src="${src}" alt="${alt}">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, t, href) => `<a href="${href}">${t}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/(^|[\s(])_([^_]+)_/g, "$1<em>$2</em>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[Number(n)]}</code>`);
  return s;
}

function attr(s) {
  return escapeHtml(s).replace(/'/g, "&#39;");
}

/**
 * documentFromMarkdown(kbText) -> { html, anchors, title }
 *
 * Sections come from level-2 headings and carry data-anno-section. Level-3
 * headings open a group carrying data-anno-item. Those two attributes are the
 * whole contract with the previewer's default crumbFor(): the annotation
 * engine never learns a single class name from this renderer.
 */
export function documentFromMarkdown(kbText) {
  const blocks = parseMarkdown(kbText);
  const anchors = [];
  const out = [];
  let title = "";
  let sectionIdx = -1;
  let itemIdx = 0;
  let section = "";
  let group = "";
  let openSection = false;
  let openGroup = false;
  let listOpen = false;

  const closeList = () => {
    if (listOpen) { out.push("</ul>"); listOpen = false; }
  };
  const closeGroup = () => {
    closeList();
    if (openGroup) { out.push("</div>"); openGroup = false; }
    group = "";
  };
  const closeSection = () => {
    closeGroup();
    if (openSection) { out.push("</section>"); openSection = false; }
  };

  const anchor = (block, kind) => {
    const aid = `s${Math.max(sectionIdx, 0)}-${itemIdx++}`;
    anchors.push({
      aid, kind, section, group,
      text: block.text, start: block.start, end: block.end, prefix: block.prefix,
    });
    return aid;
  };

  for (const b of blocks) {
    if (b.type === "heading" && b.level === 1) {
      closeSection();
      title = b.text;
      out.push(`<h1 class="cv-title">${inline(b.text)}</h1>`);
      continue;
    }
    if (b.type === "heading" && b.level === 2) {
      closeSection();
      sectionIdx++;
      itemIdx = 0;
      section = b.text.replace(/^\d+[.)]\s*/, "");
      out.push(`<section class="cv-section" data-anno-section="${attr(section)}">`);
      out.push(`<h2 class="cv-eyebrow">${inline(section)}</h2>`);
      openSection = true;
      continue;
    }
    if (b.type === "heading" && b.level >= 3) {
      closeGroup();
      group = b.text;
      out.push(`<div class="cv-group" data-anno-item="${attr(group)}">`);
      openGroup = true;
      const aid = anchor(b, "heading");
      out.push(`<h3 class="cv-subhead" data-aid="${aid}">${inline(b.text)}</h3>`);
      continue;
    }
    if (b.type === "hr") { closeList(); out.push("<hr>"); continue; }
    if (b.type === "code") {
      closeList();
      out.push(`<pre class="cv-code"><code>${escapeHtml(b.text)}</code></pre>`);
      continue;
    }
    if (b.type === "table") {
      closeList();
      out.push(renderTable(b.text));
      continue;
    }
    if (b.type === "quote") {
      closeList();
      const aid = anchor(b, "quote");
      out.push(`<blockquote class="cv-quote" data-aid="${aid}">${inline(b.text)}</blockquote>`);
      continue;
    }
    if (b.type === "item") {
      if (!listOpen) { out.push('<ul class="cv-list">'); listOpen = true; }
      const aid = anchor(b, "item");
      out.push(`<li data-aid="${aid}">${inline(b.text)}</li>`);
      continue;
    }
    closeList();
    const aid = anchor(b, "para");
    out.push(`<p data-aid="${aid}">${inline(b.text)}</p>`);
  }
  closeSection();

  return { html: out.join("\n"), anchors, title };
}

function renderTable(src) {
  const rows = src.split("\n").map((l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
  const body = rows.filter((r) => !r.every((c) => /^:?-{2,}:?$/.test(c)));
  if (!body.length) return "";
  const [head, ...rest] = body;
  const th = head.map((c) => `<th>${inline(c)}</th>`).join("");
  const tr = rest.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("\n");
  return `<table class="cv-table"><thead><tr>${th}</tr></thead><tbody>\n${tr}\n</tbody></table>`;
}

/**
 * Write an edited anchor back into the knowledge base source, preserving the
 * markdown marker the block started with.
 */
export function applyAnchorEdit(kbText, anchors, aid, newText) {
  const a = anchors.find((x) => x.aid === aid);
  if (!a) return null;
  const lines = String(kbText).split("\n");
  const parts = String(newText).replace(/\r/g, "").split("\n");
  const pad = a.prefix.replace(/\S/g, " ");
  const replacement = parts.map((p, idx) => (idx === 0 ? a.prefix + p : (a.kind === "quote" ? a.prefix : pad) + p));
  lines.splice(a.start, a.end - a.start + 1, ...replacement);
  return lines.join("\n");
}

/** Rebuild markdown from the parsed blocks, so `target: "md"` is a render. */
export function markdownFrom(kbText) {
  const blocks = parseMarkdown(kbText);
  const out = [];
  for (const b of blocks) {
    if (b.type === "hr") out.push("---");
    else if (b.type === "code") out.push("```\n" + b.text + "\n```");
    else if (b.type === "table") out.push(b.text);
    else if (b.type === "quote") out.push(b.text.split("\n").map((l) => "> " + l).join("\n"));
    else out.push(b.prefix + b.text);
    out.push("");
  }
  return out.join("\n").trim() + "\n";
}

/* =========================================================================
 * Themes
 * ====================================================================== */

const BASE_CSS = `
.cv-doc{max-width:703px;margin:0 auto;padding:28px 30px;
  font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
  color:#1b1d23;background:#fff}
.cv-doc h1.cv-title{font-size:24px;line-height:1.15;margin:0 0 10px;letter-spacing:-.01em}
.cv-doc .cv-section{margin:0 0 16px}
.cv-doc h2.cv-eyebrow{font-size:10.5px;letter-spacing:.09em;text-transform:uppercase;
  color:#6c6f7a;margin:16px 0 7px;border-bottom:1px solid #e6e6ec;padding-bottom:4px}
.cv-doc h3.cv-subhead{font-size:13.5px;margin:10px 0 3px}
.cv-doc p{margin:0 0 7px}
.cv-doc ul.cv-list{margin:0 0 8px;padding-left:17px}
.cv-doc li{margin:0 0 4px}
.cv-doc blockquote.cv-quote{margin:0 0 8px;padding-left:11px;border-left:2px solid #d9d9e2;color:#43464f}
.cv-doc table.cv-table{border-collapse:collapse;width:100%;margin:0 0 9px;font-size:12px}
.cv-doc table.cv-table th{text-align:left;color:#6c6f7a;font-size:10.5px;text-transform:uppercase;
  letter-spacing:.05em;padding:3px 8px 3px 0;border-bottom:1px solid #e6e6ec}
.cv-doc table.cv-table td{padding:3px 8px 3px 0;border-bottom:1px solid #f0f0f4;vertical-align:top}
.cv-doc pre.cv-code{background:#f5f5f9;border-radius:6px;padding:9px 11px;overflow:auto;font-size:11.5px}
.cv-doc hr{border:0;border-top:1px solid #e6e6ec;margin:13px 0}
.cv-doc a{color:#3b3ba8;text-decoration:none}
`;

/**
 * A theme resolves from the workspace first and the plugin second.
 *
 * Same reason paths.mjs keeps state out of the plugin directory: the plugin
 * lives in an installer-owned cache that a version bump replaces, so a theme
 * the user wrote has to live in $CAREER_HOME/cv/themes/<name>/theme.css to
 * survive an update.
 */
export function themeCss(theme = "default", home = null) {
  const name = String(theme).replace(/[^\w.-]/g, "");
  const candidates = [];
  if (home) candidates.push(join(home, "cv", "themes", name, "theme.css"));
  candidates.push(templates(join("themes", name, "theme.css")));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }
  return "";
}

/* =========================================================================
 * Chrome
 * ====================================================================== */

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

/** $CHROME_PATH, then the macOS app, then the three command names, in order. */
export function findChrome() {
  const fromEnv = process.env.CHROME_PATH;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  for (const c of CHROME_CANDIDATES) if (existsSync(c)) return c;
  for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
    const r = spawnSync("command", ["-v", name], { shell: true, encoding: "utf8" });
    const found = (r.stdout || "").trim().split("\n")[0];
    if (r.status === 0 && found) return found;
  }
  return null;
}

const CHROME_FLAGS = [
  "--headless", "--disable-gpu", "--no-sandbox", "--no-first-run",
  "--no-default-browser-check", "--disable-background-networking",
  "--disable-sync", "--disable-default-apps", "--disable-extensions",
  "--disable-component-update", "--disable-breakpad",
];

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run Chrome for a file it writes, then stop waiting the moment the file has
 * settled.
 *
 * Headless Chrome writes the PDF in about a second and then does not exit, so
 * waiting for the process is waiting for a timeout. Watching the artifact
 * instead turns a twenty second export into a one second one, and the kill is
 * unconditional so no browser is left running either way.
 */
function runChromeToFile(chrome, args, outPath, timeout = 25000) {
  const profile = mkdtempSync(join(tmpdir(), "career-chrome-"));
  const child = spawn(chrome, [...CHROME_FLAGS, `--user-data-dir=${profile}`, ...args], {
    stdio: "ignore",
    detached: false,
  });
  const deadline = Date.now() + timeout;
  let lastSize = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    if (existsSync(outPath)) {
      const size = statSync(outPath).size;
      if (size > 0 && size === lastSize) {
        stable++;
        if (stable >= 2) break;
      } else stable = 0;
      lastSize = size;
    }
    sleepSync(150);
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  const ok = existsSync(outPath) && statSync(outPath).size > 0;
  return { ok, bytes: ok ? statSync(outPath).size : 0 };
}

/**
 * Run Chrome and read what it printed, on the same watch-then-kill basis.
 *
 * Chrome's stdout goes straight to a file rather than a pipe, because the
 * polling loop below never yields to the event loop and a piped stream would
 * therefore never deliver a single chunk.
 */
function runChromeCapture(chrome, args, stopAt, timeout = 20000) {
  const dir = mkdtempSync(join(tmpdir(), "career-chrome-"));
  const profile = join(dir, "profile");
  const outFile = join(dir, "stdout.txt");
  const fd = openSync(outFile, "w");
  const child = spawn(chrome, [...CHROME_FLAGS, `--user-data-dir=${profile}`, ...args], {
    stdio: ["ignore", fd, "ignore"],
  });
  const deadline = Date.now() + timeout;
  let text = "";
  while (Date.now() < deadline) {
    text = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
    if (stopAt.test(text)) break;
    sleepSync(120);
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
  try {
    closeSync(fd);
  } catch {
    /* already closed */
  }
  return { stdout: text };
}

/* =========================================================================
 * render()
 * ====================================================================== */

function fullDocument({ title, body, css }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${escapeHtml(title || "CV")}</title>
<style>${css}</style>
</head>
<body>
<article class="cv-doc">
${body}
</article>
</body>
</html>`;
}

/**
 * render(kbText, {theme, target}) -> {target, html, css, md, anchors, title, pdfPath, warnings}
 *
 * The lint runs before anything is emitted and there is no way to turn it off.
 * A PDF needs Chrome; when Chrome is missing the HTML still comes back and the
 * caller is told plainly, because losing the whole render over a missing
 * browser helps nobody.
 */
export function render(kbText, opts = {}) {
  const target = opts.target || "html";
  const theme = opts.theme || "default";
  const doc = documentFromMarkdown(kbText);
  const css = BASE_CSS + "\n" + (opts.themeCss !== undefined ? opts.themeCss : themeCss(theme, opts.home));
  const html = fullDocument({ title: doc.title, body: doc.html, css });

  const lint = lintHidden(html, css);
  if (!lint.ok) throw new HiddenTextError(lint.findings);

  const result = {
    target, theme, title: doc.title,
    html, css, anchors: doc.anchors,
    md: null, pdfPath: null, warnings: [],
  };

  if (target === "md") {
    result.md = markdownFrom(kbText);
    return result;
  }
  if (target !== "pdf") return result;

  const chrome = findChrome();
  if (!chrome) {
    result.warnings.push(
      "PDF export needs Google Chrome or Chromium. Set CHROME_PATH to the browser binary, or install Chrome. The HTML render succeeded and is returned unchanged.",
    );
    return result;
  }

  const dir = opts.outDir || mkdtempSync(join(tmpdir(), "career-render-"));
  const src = join(dir, "cv.html");
  const out = opts.out || join(dir, "cv.pdf");
  writeFileSync(src, html, "utf8");
  const r = runChromeToFile(chrome, ["--no-pdf-header-footer", `--print-to-pdf=${out}`, `file://${src}`], out);
  if (!r.ok) {
    result.warnings.push(`Chrome ran but produced no PDF at ${out}. The HTML render succeeded and is returned unchanged.`);
    return result;
  }
  result.pdfPath = out;
  result.pdfBytes = r.bytes;
  result.chrome = chrome;
  return result;
}

/* =========================================================================
 * One-page A4 fit
 * ====================================================================== */

const FIT_WIDTH = 703;
const FIT_MAX_HEIGHT = 1047;

function splitDocument(html) {
  const root = parseHtml(html);
  const styles = [];
  walk(root, (n) => {
    if (n.tag === "style") styles.push(rawTextOf(n));
  });
  const bodyMatch = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html);
  let body = bodyMatch ? bodyMatch[1] : html;
  body = body.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<script[\s\S]*?<\/script>/gi, "");
  return { styles, body };
}

/** Inline the contents of @media print so print rules apply on screen. */
function flattenPrint(css) {
  let out = css;
  const re = /@media[^{]*print[^{]*\{/gi;
  let m;
  while ((m = re.exec(css))) {
    let depth = 1;
    let i = m.index + m[0].length;
    while (i < css.length && depth > 0) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") depth--;
      i++;
    }
    out += "\n" + css.slice(m.index + m[0].length, i - 1);
  }
  return out;
}

/**
 * fitsOnePage(html) -> {checked, fits, height, limit}
 *
 * The A4 assertion carried over from the tailor-cv skill: lay the document out
 * in a 703px container with print rules flattened and require height <= 1047px.
 * Without Chrome this returns {checked:false}. It never returns a pass it did
 * not measure, because a false pass here ships a two-page CV.
 */
export function fitsOnePage(html, opts = {}) {
  const chrome = findChrome();
  if (!chrome) {
    return { checked: false, reason: "No Chrome or Chromium found. Set CHROME_PATH to measure page fit.", limit: FIT_MAX_HEIGHT };
  }
  const { styles, body } = splitDocument(String(html || ""));
  const css = flattenPrint([opts.css || "", ...styles].join("\n"));
  const harness = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#fff}
#career-fit{width:${FIT_WIDTH}px}
#career-fit .cv-doc{max-width:none;width:${FIT_WIDTH}px;margin:0;box-shadow:none}
${css}
</style></head><body><div id="career-fit">${body}</div>
<script>
(function(){
  var n=document.getElementById("career-fit");
  var h=Math.ceil(Math.max(n.scrollHeight,n.getBoundingClientRect().height));
  document.documentElement.setAttribute("data-fit-height",String(h));
})();
</script></body></html>`;

  const dir = mkdtempSync(join(tmpdir(), "career-fit-"));
  const file = join(dir, "fit.html");
  writeFileSync(file, harness, "utf8");
  const r = runChromeCapture(chrome, ["--dump-dom", `file://${file}`], /data-fit-height="\d+"/, 15000);
  const m = /data-fit-height="(\d+)"/.exec(r.stdout || "");
  if (!m) {
    return { checked: false, reason: "Chrome ran but did not report a height.", limit: FIT_MAX_HEIGHT };
  }
  const height = Number(m[1]);
  return { checked: true, fits: height <= FIT_MAX_HEIGHT, height, limit: FIT_MAX_HEIGHT, width: FIT_WIDTH };
}

export default { render, lintHidden, fitsOnePage, HiddenTextError };
