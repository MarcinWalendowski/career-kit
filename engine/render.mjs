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
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_ROOT, slug, templates } from "./paths.mjs";

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
const LABEL_RE = /^\s*\*\*[^*\n]{1,28}:?\*\*:?\s/;

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
      // A bolded label on its own line starts a new block even without a blank
      // line before it. The knowledge base writes "**Dates:**" and
      // "**Context:**" as adjacent lines meaning two fields, and folding them
      // into one paragraph loses the second one.
      if (i > start && LABEL_RE.test(lines[i])) break;
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

/* -------------------------------------------------------------------------
 * Knowledge base to CV
 *
 * Two contracts meet here and both have to hold.
 *
 * The theme contract (templates/themes/default/README.md) fixes the class
 * vocabulary a stylesheet may rely on: .page, header, h1, .title, .contact,
 * .sep, section, h2, .summary, .job, .job-head, .role, .co, .dates, .ctx,
 * ul, li, .earlier, .edu-item, .skills. A theme that styles all of it must get
 * a document that emits all of it, or half the stylesheet is dead code.
 *
 * The previewer contract fixes data-aid on every editable block, plus
 * data-anno-section and data-anno-item for breadcrumbs. Those are attributes,
 * not classes, so the two contracts sit on the same elements without either
 * one having to know about the other.
 *
 * Section meaning is read from headings and from two labels the knowledge base
 * scaffold already uses, "Dates:" and "Context:". Nothing here guesses which
 * line is a job title from prose: a section that matches none of the patterns
 * renders as plain headed prose rather than being forced into a shape.
 * ---------------------------------------------------------------------- */

const SECTION_KINDS = [
  ["identity", /identity|contact details/i],
  ["summary", /summary|positioning|headline|about|profile|who i am/i],
  ["experience", /experience|current role/i],
  ["earlier", /prior roles?|earlier|previous roles?/i],
  ["education", /education|training|degree/i],
  ["skills", /skills|stack|tooling|technolog/i],
];

function classify(heading) {
  const text = heading.replace(/^\d+[.)]\s*/, "");
  for (const [kind, re] of SECTION_KINDS) if (re.test(text)) return kind;
  return "other";
}

/** "4. Experience - Founding Engineer at Acme" -> label, role, company. */
function splitSectionHeading(raw) {
  const text = raw.replace(/^\d+[a-z]?[.)]\s*/, "").trim();
  const dash = text.search(/\s[-:]\s/);
  if (dash < 0) return { label: text, role: "", company: "" };
  const label = text.slice(0, dash).trim();
  const tail = text.slice(dash + 3).trim();
  const at = tail.search(/\sat\s|,\s/);
  if (at < 0) return { label, role: tail, company: "" };
  return { label, role: tail.slice(0, at).trim(), company: tail.slice(at).replace(/^(\sat\s|,\s)/, "").trim() };
}

/** "**Dates:** 2024 to 2026" -> {label:"dates", value:"2024 to 2026"} */
function labelledLine(text) {
  const m = /^\**\s*(dates?|context|location)\s*:?\**\s*:?\s*(.*)$/i.exec(text.trim());
  if (!m) return null;
  return { label: m[1].toLowerCase().replace(/s$/, ""), value: m[2].trim() };
}

function tableFields(src) {
  const fields = {};
  for (const line of src.split("\n")) {
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
    if (cells.length < 2) continue;
    if (/^:?-{2,}:?$/.test(cells[0])) continue;
    fields[cells[0].toLowerCase().replace(/[^a-z]/g, "")] = cells[1];
  }
  return fields;
}

/**
 * documentFromMarkdown(kbText) -> { html, parts, anchors, title, fills }
 *
 * `parts` are the shell's slots. `html` is the same content assembled into a
 * .page, so the previewer pane and the exported artifact are the same document
 * with the same anchors rather than two renderings that can disagree.
 */
export function documentFromMarkdown(kbText) {
  const blocks = parseMarkdown(kbText);
  const anchors = [];
  const parts = {
    name: "", headline: "", contact: "",
    summary: [], experience: [], earlier: [], education: [], skills: [], other: [],
  };
  let title = "";
  let sectionIdx = -1;
  let itemIdx = 0;
  let sectionName = "";
  let group = "";
  let kind = "preamble";
  let fields = {};
  const preamble = [];

  const anchor = (block, aidKind) => {
    // The header block gets its own prefix. Folding it into section 0 collided
    // two different knowledge-base lines onto one anchor id, and an anchor id
    // is what decides which line a write-back overwrites.
    const aid = `${sectionIdx < 0 ? "h" : "s" + sectionIdx}-${itemIdx++}`;
    anchors.push({
      aid, kind: aidKind, section: sectionName, group,
      text: block.text, start: block.start, end: block.end, prefix: block.prefix,
    });
    return aid;
  };

  // Group the flat block list into sections first, so a section can be
  // rendered knowing what kind it is before its first block is emitted.
  const sections = [];
  let current = null;
  for (const b of blocks) {
    if (b.type === "heading" && b.level === 1) {
      title = b.text;
      continue;
    }
    if (b.type === "heading" && b.level === 2) {
      current = { heading: b.text, blocks: [] };
      sections.push(current);
      continue;
    }
    if (!current) preamble.push(b);
    else current.blocks.push(b);
  }

  // Preamble: the lines under the title, before any section.
  sectionIdx = -1;
  for (const b of preamble) {
    if (b.type !== "para" && b.type !== "quote") continue;
    const aid = anchor(b, b.type);
    if (!parts.headline) parts.headline = `<span data-aid="${aid}">${inline(b.text)}</span>`;
    else if (!parts.contact) parts.contact = contactLine(b.text, aid);
  }

  sections.forEach((sec, index) => {
    sectionIdx = index;
    itemIdx = 0;
    group = "";
    const { label, role, company } = splitSectionHeading(sec.heading);
    sectionName = label;
    kind = classify(sec.heading);
    const body = [];
    let listOpen = false;
    let groupOpen = false;
    const closeList = () => {
      if (listOpen) { body.push("</ul>"); listOpen = false; }
    };
    const closeGroup = () => {
      closeList();
      if (groupOpen) { body.push("</div>"); groupOpen = false; }
    };

    let dates = "";
    let ctx = "";

    for (const b of sec.blocks) {
      if (b.type === "table") {
        closeList();
        if (kind === "identity") Object.assign(fields, tableFields(b.text));
        else body.push(renderTable(b.text));
        continue;
      }
      if (b.type === "hr") continue;
      if (b.type === "code") {
        closeList();
        body.push(`<pre class="code"><code>${escapeHtml(b.text)}</code></pre>`);
        continue;
      }
      if (b.type === "heading") {
        closeGroup();
        group = b.heading || b.text;
        const aid = anchor(b, "heading");
        if (kind === "education") {
          body.push(`<div class="edu-item" data-anno-item="${attr(b.text)}" data-aid="${aid}">${inline(b.text)}`);
          groupOpen = true;
          continue;
        }
        body.push(`<div class="group" data-anno-item="${attr(b.text)}">`);
        body.push(`<h3 data-aid="${aid}">${inline(b.text)}</h3>`);
        groupOpen = true;
        continue;
      }
      if (b.type === "item") {
        if (kind === "skills") {
          const aid = anchor(b, "item");
          body.push(`<p data-aid="${aid}">${inline(b.text)}</p>`);
          continue;
        }
        if (kind === "earlier") {
          const aid = anchor(b, "item");
          body.push(`<div class="job earlier" data-aid="${aid}">${inline(b.text)}</div>`);
          continue;
        }
        if (kind === "education") {
          const aid = anchor(b, "item");
          body.push(`<div class="edu-item" data-aid="${aid}">${inline(b.text)}</div>`);
          continue;
        }
        if (!listOpen) { body.push("<ul>"); listOpen = true; }
        const aid = anchor(b, "item");
        body.push(`<li data-aid="${aid}">${inline(b.text)}</li>`);
        continue;
      }

      closeList();
      const labelled = labelledLine(b.text);
      if (labelled && kind === "experience" && labelled.label === "date" && !dates) {
        dates = `<div class="dates" data-aid="${anchor(b, "para")}">${inline(labelled.value)}</div>`;
        continue;
      }
      if (labelled && kind === "experience" && labelled.label === "context" && !ctx) {
        ctx = `<div class="ctx" data-aid="${anchor(b, "para")}">${inline(labelled.value)}</div>`;
        continue;
      }
      const aid = anchor(b, b.type === "quote" ? "quote" : "para");
      if (kind === "education" && groupOpen) {
        body.push(`<div class="sub" data-aid="${aid}">${inline(b.text)}</div>`);
        continue;
      }
      if (kind === "earlier") {
        body.push(`<div class="job earlier" data-aid="${aid}">${inline(b.text)}</div>`);
        continue;
      }
      body.push(`<p data-aid="${aid}">${inline(b.text)}</p>`);
    }
    closeGroup();

    const inner = body.join("\n");
    if (kind === "identity") {
      parts.name = parts.name || fields.name || "";
      if (!parts.headline && fields.currenttitle) parts.headline = inline(fields.currenttitle);
      parts.contact = parts.contact || contactFromFields(fields);
      return;
    }
    if (kind === "summary") {
      if (!parts.headline && sec.blocks.length) parts.headline = parts.headline || "";
      parts.summary.push(inner);
      return;
    }
    if (kind === "experience") {
      const head = role
        ? `<div class="job-head"><div class="role">${inline(role)}${company ? ` <span class="co">${inline(company)}</span>` : ""}</div>${dates}</div>`
        : dates
          ? `<div class="job-head">${dates}</div>`
          : "";
      parts.experience.push(
        `<div class="job" data-anno-section="${attr(label)}">\n${head}\n${ctx}\n${inner}\n</div>`,
      );
      return;
    }
    if (kind === "earlier") { parts.earlier.push(inner); return; }
    if (kind === "education") { parts.education.push(inner); return; }
    if (kind === "skills") { parts.skills.push(inner); return; }
    parts.other.push(`<section data-anno-section="${attr(label)}"><h2>${inline(label)}</h2>\n${inner}\n</section>`);
  });

  parts.name = parts.name || title || "";
  const fills = (kbText.match(/\[\[FILL/g) || []).length;

  return {
    html: assemblePage(parts),
    parts,
    anchors,
    title: parts.name || title,
    fills,
  };
}

/**
 * Emphasis puts named sections first and drops the ones that are not CV
 * content. It reorders and it trims; it never rewrites a line and never adds
 * one, so a tailored CV still says only what the knowledge base says.
 */
function applyEmphasis(doc, emphasis) {
  const wanted = emphasis.map((e) => slug(e));
  const rank = (html) => {
    const m = /data-anno-section="([^"]*)"/.exec(html);
    const idx = m ? wanted.indexOf(slug(m[1])) : -1;
    return idx < 0 ? wanted.length : idx;
  };
  doc.parts.experience = doc.parts.experience
    .map((html, i) => ({ html, i, r: rank(html) }))
    .sort((a, b) => a.r - b.r || a.i - b.i)
    .map((x) => x.html);
  doc.parts.other = [];
  doc.html = assemblePage(doc.parts);
}

/** Contact items separated by the glyph the theme styles as .sep. */
function contactLine(text, aid) {
  const items = text.split(/\s*[·|]\s*/).filter(Boolean);
  const joined = items.map((i) => inline(i)).join(' <span class="sep">·</span> ');
  return aid ? `<span data-aid="${aid}">${joined}</span>` : joined;
}

function contactFromFields(fields) {
  const order = ["email", "phone", "location", "linkedin", "github", "portfoliosite", "site"];
  const items = order.map((k) => fields[k]).filter(Boolean);
  return items.length ? items.map((i) => inline(i)).join(' <span class="sep">·</span> ') : "";
}

const SLOT_SECTIONS = [
  ["summary", "Summary", "summary"],
  ["experience", "Experience", ""],
  ["earlier", "Earlier", ""],
  ["education", "Education", ""],
  ["skills", "Skills", "skills"],
];

/** The same content the shell gets, assembled into a standalone .page. */
function assemblePage(parts) {
  const out = ['<div class="page">'];
  out.push("<header data-anno-section=\"Identity\">");
  if (parts.name) out.push(`<h1>${inline(parts.name)}</h1>`);
  if (parts.headline) out.push(`<div class="title">${parts.headline}</div>`);
  if (parts.contact) out.push(`<div class="contact">${parts.contact}</div>`);
  out.push("</header>");
  for (const [key, heading, cls] of SLOT_SECTIONS) {
    const body = parts[key].join("\n");
    if (!body.trim()) continue;
    out.push(`<section${cls ? ` class="${cls}"` : ""} data-anno-section="${attr(heading)}">`);
    out.push(`<h2>${heading}</h2>`);
    out.push(body);
    out.push("</section>");
  }
  out.push(parts.other.join("\n"));
  out.push("</div>");
  return out.filter(Boolean).join("\n");
}

/**
 * Fill a theme's cv.html. Slots are {{name}}; an unknown slot resolves to an
 * empty string rather than being left on the page, because "{{footer}}" in an
 * exported CV is worse than no footer.
 */
export function fillShell(shell, slots) {
  return String(shell).replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, key) => {
    const value = slots[key.toLowerCase()];
    return value === undefined || value === null ? "" : String(value);
  });
}

/**
 * Remove every node carrying an attribute, before the lint sees the document.
 *
 * This is the supported alternative to hiding: data-screen-only comes out of
 * the print and PDF targets, data-print-only comes out of the screen target,
 * and in both cases the text is absent from the file rather than present and
 * invisible. A reader who opens the file sees what a human sees.
 */
export function removeNodesWithAttr(html, attrName) {
  const src = String(html);
  const open = new RegExp(`<([a-z][\\w-]*)([^>]*\\s${attrName}(?:\\s*=\\s*(?:"[^"]*"|'[^']*'|[^\\s>]*))?)([^>]*)>`, "i");
  let out = src;
  for (let guard = 0; guard < 200; guard++) {
    const m = open.exec(out);
    if (!m) break;
    const tag = m[1].toLowerCase();
    const start = m.index;
    if (VOID_TAGS.has(tag)) {
      out = out.slice(0, start) + out.slice(start + m[0].length);
      continue;
    }
    let depth = 1;
    let i = start + m[0].length;
    const scan = new RegExp(`<(/?)${tag}\\b[^>]*>`, "gi");
    scan.lastIndex = i;
    let hit;
    let end = out.length;
    while ((hit = scan.exec(out))) {
      depth += hit[1] ? -1 : 1;
      if (depth === 0) {
        end = hit.index + hit[0].length;
        break;
      }
    }
    out = out.slice(0, start) + out.slice(end);
  }
  return out;
}

/**
 * Prefix every selector in a stylesheet, so a theme can be shown inside the
 * previewer without its `html, body` and bare `li` rules reaching the app
 * around it. Only the previewer needs this; an exported artifact gets the
 * stylesheet untouched.
 */
export function scopeCss(css, prefix) {
  const rules = parseCssRules(css);
  const byAt = new Map();
  for (const rule of rules) {
    const key = rule.at.join("|");
    if (!byAt.has(key)) byAt.set(key, { at: rule.at, rules: [] });
    byAt.get(key).rules.push(rule);
  }
  const out = [];
  for (const { at, rules: group } of byAt.values()) {
    if (at.some((a) => /print/i.test(a))) continue;
    const body = group
      .map((rule) => {
        const selector = rule.selector
          .split(",")
          .map((part) => {
            const s = part.trim();
            if (!s) return "";
            if (/^(html|body|:root)\b/i.test(s)) return `${prefix}${s.replace(/^(html|body|:root)/i, "")}`.trim() || prefix;
            return `${prefix} ${s}`;
          })
          .filter(Boolean)
          .join(", ");
        const decls = Object.entries(rule.decls).map(([k, v]) => `${k}:${v}`).join(";");
        return `${selector}{${decls}}`;
      })
      .join("\n");
    out.push(at.length ? `${at.join(" ")}{${body}}` : body);
  }
  return out.join("\n");
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

/**
 * A theme may ship its own HTML shell. Missing, it falls back to the default
 * theme's shell, and only if that is missing too does the renderer emit its
 * own plain document. The last case exists so the engine still works in a
 * checkout with no templates directory.
 */
export function themeShell(theme = "default", home = null) {
  const name = String(theme).replace(/[^\w.-]/g, "");
  const candidates = [];
  if (home) candidates.push(join(home, "cv", "themes", name, "cv.html"));
  candidates.push(templates(join("themes", name, "cv.html")));
  candidates.push(templates(join("themes", "default", "cv.html")));
  for (const file of candidates) {
    if (!existsSync(file)) continue;
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  }
  return null;
}

/** Pull the .page element out of a rendered document, for the preview pane. */
export function extractPage(html) {
  const src = String(html);
  const open = /<div\b[^>]*class\s*=\s*["'][^"']*\bpage\b[^"']*["'][^>]*>/i.exec(src);
  if (!open) return null;
  const start = open.index;
  let depth = 1;
  const scan = /<(\/?)div\b[^>]*>/gi;
  scan.lastIndex = start + open[0].length;
  let hit;
  while ((hit = scan.exec(src))) {
    depth += hit[1] ? -1 : 1;
    if (depth === 0) return src.slice(start, hit.index + hit[0].length);
  }
  return src.slice(start);
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
  if (opts.emphasis && opts.emphasis.length) applyEmphasis(doc, opts.emphasis);
  const themed = opts.themeCss !== undefined ? opts.themeCss : themeCss(theme, opts.home);
  const shell = opts.shell !== undefined ? opts.shell : themeShell(theme, opts.home);
  const css = shell && themed ? themed : BASE_CSS + "\n" + (themed || "");

  let html = shell
    ? fillShell(shell, {
        lang: opts.lang || "en",
        doc_title: doc.title || "CV",
        theme_css: css,
        name: inline(doc.parts.name),
        headline: doc.parts.headline,
        contact_line: doc.parts.contact,
        summary: doc.parts.summary.join("\n"),
        experience: doc.parts.experience.join("\n"),
        earlier: doc.parts.earlier.join("\n"),
        education: doc.parts.education.join("\n"),
        skills: doc.parts.skills.join("\n"),
        footer: opts.footer || "",
      })
    : fullDocument({ title: doc.title, body: doc.html, css });

  // The node removal happens before the lint, not after, so that what the lint
  // reads is exactly the bytes the artifact will contain.
  html = target === "html"
    ? removeNodesWithAttr(html, "data-print-only")
    : removeNodesWithAttr(html, "data-screen-only");

  const lint = lintHidden(html, css);
  if (!lint.ok) throw new HiddenTextError(lint.findings);

  const result = {
    target, theme, title: doc.title,
    html, css, anchors: doc.anchors,
    page: extractPage(html) || doc.html,
    fills: doc.fills,
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

/* =========================================================================
 * The brief
 *
 * outputs/brief.md replaces a 214 line prose contract that hardcoded one
 * person. The structure is a template shipped with the career-apply skill; all
 * of the content comes from the workspace, so a user who edits voice.md sees
 * the brief change on the next render.
 *
 * An unresolved placeholder renders as a [[FILL]] marker naming the file that
 * was supposed to supply it. It never renders as an empty string, because a
 * brief with a silent hole reads as a complete brief.
 * ====================================================================== */

const SOURCE_FILES = {
  profile: "profile.yaml",
  rules: "rules.yaml",
  voice: "voice.md",
  kb: "knowledge-base.md",
};

function lookup(ctx, path) {
  const parts = String(path).trim().split(".");
  let node = ctx;
  for (const part of parts) {
    if (node === null || node === undefined || typeof node !== "object") return undefined;
    node = node[part];
  }
  return node;
}

function fillMarker(path) {
  const root = String(path).split(".")[0];
  const file = SOURCE_FILES[root] || "the workspace";
  return `[[FILL]] ${path} is missing from ${file}`;
}

/** The body under a heading in a markdown file, as markdown. */
export function sectionBody(mdText, heading) {
  const blocks = parseMarkdown(mdText || "");
  const want = String(heading).trim().toLowerCase();
  let collecting = false;
  let level = 0;
  const out = [];
  for (const b of blocks) {
    if (b.type === "heading") {
      const label = b.text.replace(/^\d+[a-z]?[.)]\s*/, "").trim().toLowerCase();
      if (collecting && b.level <= level) break;
      if (!collecting && (label === want || label.startsWith(want))) {
        collecting = true;
        level = b.level;
        continue;
      }
    }
    if (!collecting) continue;
    if (b.type === "heading") out.push("#".repeat(b.level) + " " + b.text);
    else if (b.type === "item") out.push(b.prefix + b.text);
    else if (b.type === "quote") out.push("> " + b.text);
    else if (b.type === "table" || b.type === "code") out.push(b.text);
    else out.push(b.text);
  }
  return out.join("\n").trim();
}

function findBlock(tpl, from) {
  const open = /\{\{#(each|if|unless)\s+([^}]+?)\s*\}\}/g;
  open.lastIndex = from;
  const m = open.exec(tpl);
  if (!m) return null;
  const kind = m[1];
  const path = m[2];
  const bodyStart = m.index + m[0].length;
  const scan = new RegExp(`\\{\\{#${kind}\\s+[^}]+?\\s*\\}\\}|\\{\\{/${kind}\\}\\}`, "g");
  scan.lastIndex = bodyStart;
  let depth = 1;
  let hit;
  while ((hit = scan.exec(tpl))) {
    depth += hit[0].startsWith("{{/") ? -1 : 1;
    if (depth === 0) {
      return { kind, path, start: m.index, bodyStart, bodyEnd: hit.index, end: hit.index + hit[0].length };
    }
  }
  return null;
}

/** A small block-and-placeholder template renderer. No dependency, no eval. */
export function renderTemplate(tpl, ctx) {
  let out = String(tpl).replace(/^\s*<!--[\s\S]*?-->\s*/, "");
  for (let guard = 0; guard < 500; guard++) {
    const block = findBlock(out, 0);
    if (!block) break;
    const body = out.slice(block.bodyStart, block.bodyEnd);
    const value = lookup(ctx, block.path);
    let replacement = "";
    if (block.kind === "each") {
      const list = Array.isArray(value) ? value : [];
      replacement = list
        .map((item) => renderTemplate(body, { ...ctx, ".": item, __item: item }))
        .join("");
    } else if (block.kind === "if") {
      replacement = truthy(value) ? renderTemplate(body, ctx) : "";
    } else {
      replacement = truthy(value) ? "" : renderTemplate(body, ctx);
    }
    out = out.slice(0, block.start) + replacement + out.slice(block.end);
  }

  return out.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_, raw) => {
    const key = raw.trim();
    if (key === ".") {
      const item = ctx["."];
      return item === undefined ? "" : String(item);
    }
    const named = /^(voice|kb):(.+)$/.exec(key);
    if (named) {
      const text = named[1] === "voice" ? ctx.__voice : ctx.__kb;
      const body = sectionBody(text, named[2]);
      return body || `[[FILL]] the "${named[2].trim()}" section is missing from ${SOURCE_FILES[named[1]]}`;
    }
    const item = ctx["."];
    if (item && typeof item === "object" && key in item) {
      const v = item[key];
      return v === undefined || v === null ? "" : String(v);
    }
    const value = lookup(ctx, key);
    if (value === undefined || value === null || value === "") return fillMarker(key);
    if (Array.isArray(value)) return value.join(", ");
    if (typeof value === "object") return JSON.stringify(value);
    return String(value);
  });
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  if (v && typeof v === "object") return Object.keys(v).length > 0;
  return Boolean(v);
}

/**
 * Read the workspace YAML through validate.mjs rather than parsing it here.
 *
 * The import is dynamic and guarded: a second YAML parser in this file would
 * be a second answer to the same question, which is the duplication this whole
 * product exists to remove. readYaml owns the missing-file behaviour too, so a
 * brief asked for without a profile exits 2 with the career-setup message,
 * the same way the gate does.
 */
async function readWorkspaceYaml(file, required) {
  try {
    const { readYaml } = await import("./validate.mjs");
    return readYaml(file, { required, fallback: null });
  } catch {
    return existsSync(file) ? null : null;
  }
}

export async function renderBrief(P, opts = {}) {
  const templatePath = opts.template ||
    join(PLUGIN_ROOT, "skills", "career-apply", "references", "brief-template.md");
  if (!existsSync(templatePath)) {
    throw Object.assign(new Error(`brief template not found at ${templatePath}`), { code: "NO_TEMPLATE" });
  }
  const required = opts.required !== false;
  const profile = await readWorkspaceYaml(P.profile, required);
  const rules = await readWorkspaceYaml(P.rules, required);
  const mode = (rules && rules.mode) || "";
  const ctx = {
    profile: profile || {},
    rules: rules || {},
    now: new Date().toISOString(),
    careerHome: P.home,
    modeIsDraft: mode === "draft",
    modeIsReview: mode === "review",
    modeIsAutopilot: mode === "autopilot",
    __voice: existsSync(P.voice) ? readFileSync(P.voice, "utf8") : "",
    __kb: existsSync(P.kb) ? readFileSync(P.kb, "utf8") : "",
  };
  const text = renderTemplate(readFileSync(templatePath, "utf8"), ctx);
  return { text, fills: (text.match(/\[\[FILL/g) || []).length };
}

/* =========================================================================
 * CLI
 *
 * Four skills invoke this file as a command. A module that is only a library
 * exits 0 and writes nothing when it is run, which is indistinguishable from
 * success, so the command surface is part of the module.
 * ====================================================================== */

function parseArgv(argv) {
  const out = { target: "html" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const take = () => argv[++i];
    if (a === "--target") out.target = take();
    else if (a === "--theme") out.theme = take();
    else if (a === "--emphasis") out.emphasis = String(take() || "").split(/[,\s]+/).filter(Boolean);
    else if (a === "--out") out.out = take();
    else if (a === "--home") out.home = take();
    else if (a === "--help" || a === "-h") out.help = true;
    else if (a.startsWith("--")) out.unknown = a;
  }
  return out;
}

const USAGE = `career-kit render

  node engine/render.mjs --target html|md|pdf|brief [options]

  --target html    outputs/cv.html
  --target md      outputs/cv.md
  --target pdf     outputs/cv.pdf, needs Chrome or CHROME_PATH
  --target brief   outputs/brief.md, compiled from profile, rules, voice and the knowledge base
  --theme <name>   theme directory name, default: the name in cv/theme, else "default"
  --emphasis a,b   put the named sections first. It reorders and drops non-CV sections.
                   It never adds a claim and never rewrites a line.
  --out <path>     write somewhere other than the default
  --home <dir>     workspace, default $CAREER_HOME

Exit codes: 0 written, 2 usage, 3 refused by the hidden-text lint (the HTTP 422 case).
`;

async function main(argv) {
  const args = parseArgv(argv);
  if (args.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!["html", "md", "pdf", "brief"].includes(args.target)) {
    process.stderr.write(`unknown --target ${args.target}\n\n${USAGE}`);
    return 2;
  }
  if (args.unknown) {
    process.stderr.write(`unknown option ${args.unknown}\n\n${USAGE}`);
    return 2;
  }

  const { ensureRuntimeDirs, findCareerHome, paths } = await import("./paths.mjs");
  const P = ensureRuntimeDirs(paths(args.home ? resolve(args.home) : findCareerHome()));

  if (args.target === "brief") {
    const out = args.out || P.brief;
    const brief = await renderBrief(P);
    writeFileSync(out, brief.text, "utf8");
    process.stdout.write(JSON.stringify({ ok: true, target: "brief", path: out, fills: brief.fills }) + "\n");
    if (brief.fills) {
      process.stderr.write(`${brief.fills} unresolved placeholder(s) in the brief. Each one names the file that supplies it.\n`);
    }
    return 0;
  }

  const theme = args.theme || (existsSync(P.cvTheme) ? readFileSync(P.cvTheme, "utf8").trim() : "") || "default";
  const kb = existsSync(P.kb) ? readFileSync(P.kb, "utf8") : "";
  if (!kb.trim()) {
    process.stderr.write(`knowledge base is empty at ${P.kb}. Run career-setup or career-kb first.\n`);
    return 2;
  }

  const defaults = { html: "cv.html", md: "cv.md", pdf: "cv.pdf" };
  const out = args.out || join(P.outputs, defaults[args.target]);

  try {
    const result = render(kb, {
      theme, target: args.target, home: P.home, emphasis: args.emphasis,
      outDir: P.outputs, out: args.target === "pdf" ? out : undefined,
    });
    if (args.target === "md") writeFileSync(out, result.md, "utf8");
    else if (args.target === "html") writeFileSync(out, result.html, "utf8");
    process.stdout.write(JSON.stringify({
      ok: true, target: args.target, theme,
      path: args.target === "pdf" ? result.pdfPath : out,
      fills: result.fills, anchors: result.anchors.length, warnings: result.warnings,
    }) + "\n");
    for (const w of result.warnings) process.stderr.write(w + "\n");
    if (result.fills) {
      process.stderr.write(`${result.fills} [[FILL]] marker(s) are still in the knowledge base. They render as written; fill them before sending.\n`);
    }
    return 0;
  } catch (e) {
    if (!(e instanceof HiddenTextError)) throw e;
    process.stdout.write(JSON.stringify({
      ok: false, status: 422, error: "hidden-text", findings: e.findings,
    }) + "\n");
    process.stderr.write(
      "Refused: the document would contain text a human reader cannot see.\n" +
        e.findings.map((f) => `  ${f.selector} sets ${f.rule} in ${f.where}. ${f.why}`).join("\n") +
        "\nMake it visible or delete it. This check has no override.\n",
    );
    return 3;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = await main(process.argv.slice(2));
}

export default { render, lintHidden, fitsOnePage, renderBrief, HiddenTextError };
