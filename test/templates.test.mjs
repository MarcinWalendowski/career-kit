/**
 * templates.test.mjs - the de-personalisation gate.
 *
 * These are not tests that the templates are good. They are tests that the
 * templates are SAFE to publish, which is a different and much more mechanical
 * question. P0 of this project is "extract and de-personalise", and the way a
 * de-personalisation pass fails is that one file keeps one name.
 *
 * Every assertion below corresponds to a way that has actually happened
 * somewhere, or to a rule the product itself enforces on the user and therefore
 * has to obey in its own files.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const ROOT = resolve(new URL("..", import.meta.url).pathname);
const TEMPLATES = join(ROOT, "templates");
const EXTENSION = join(ROOT, "extension");
const README = join(ROOT, "README.md");

const EM_DASH = String.fromCharCode(0x2014);

/* ------------------------------------------------------------------ walk */

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const templateFiles = walk(TEMPLATES);
const extensionFiles = walk(EXTENSION);
const publicFiles = [...templateFiles, ...extensionFiles, README];
const read = (p) => readFileSync(p, "utf8");
const rel = (p) => relative(ROOT, p);

/* --------------------------------------------------- a minimal YAML reader */
/* Deliberately inline and deliberately small. The engine ships with zero
 * dependencies, so a test that pulls in a YAML library to check a zero-
 * dependency template would be testing something the product does not do. This
 * reader handles exactly what the templates use: nested maps, block lists,
 * inline maps and lists, quoted scalars with \uXXXX escapes, and comments. */

function parseYaml(src) {
  const lines = [];
  for (const raw of src.split("\n")) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue;
    lines.push({ indent: raw.match(/^ */)[0].length, text: stripComment(raw.trim()) });
  }
  const [value] = parseBlock(lines, 0, 0);
  return value;
}

/** Strip a trailing comment, but not a # inside quotes. */
function stripComment(s) {
  let quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i).trim();
  }
  return s.trim();
}

function parseBlock(lines, i, indent) {
  if (i >= lines.length) return [null, i];
  const isList = lines[i].text.startsWith("- ") || lines[i].text === "-";

  if (isList) {
    const arr = [];
    while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith("-")) {
      const item = lines[i].text.replace(/^-\s*/, "");
      i++;
      if (item) arr.push(scalar(item));
      else {
        const [v, ni] = parseBlock(lines, i, lines[i] ? lines[i].indent : indent + 2);
        arr.push(v);
        i = ni;
      }
    }
    return [arr, i];
  }

  const obj = {};
  while (i < lines.length && lines[i].indent === indent) {
    const m = lines[i].text.match(/^([^:]+):\s*(.*)$/);
    assert.ok(m, `not a key/value line: ${lines[i].text}`);
    const key = m[1].trim();
    const rest = m[2].trim();
    i++;
    if (rest) obj[key] = scalar(rest);
    else if (i < lines.length && lines[i].indent > indent) {
      const [v, ni] = parseBlock(lines, i, lines[i].indent);
      obj[key] = v;
      i = ni;
    } else obj[key] = null;
  }
  return [obj, i];
}

function scalar(s) {
  s = s.trim();
  if (s.startsWith("{") && s.endsWith("}")) {
    const obj = {};
    for (const part of splitTop(s.slice(1, -1))) {
      const m = part.match(/^([^:]+):\s*(.*)$/);
      if (m) obj[m[1].trim()] = scalar(m[2]);
    }
    return obj;
  }
  if (s.startsWith("[") && s.endsWith("]")) {
    const inner = s.slice(1, -1).trim();
    return inner ? splitTop(inner).map(scalar) : [];
  }
  if (s.startsWith('"') && s.endsWith('"') && s.length > 1) return unescape(s.slice(1, -1));
  if (s.startsWith("'") && s.endsWith("'") && s.length > 1) return s.slice(1, -1);
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
  return s;
}

function unescape(s) {
  return s.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\n/g, "\n")
    .replace(/\\"/g, '"');
}

/** Split on commas at brace depth zero, ignoring commas inside quotes. */
function splitTop(s) {
  const parts = [];
  let depth = 0, quote = null, buf = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      buf += c;
      if (c === "\\") { buf += s[++i] ?? ""; }
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; buf += c; continue; }
    if (c === "{" || c === "[") depth++;
    if (c === "}" || c === "]") depth--;
    if (c === "," && depth === 0) { parts.push(buf.trim()); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim()) parts.push(buf.trim());
  return parts;
}

/* ------------------------------------------------------------------ tests */

test("profile.example.yaml parses and answers every question a form asks", () => {
  const p = parseYaml(read(join(TEMPLATES, "profile.example.yaml")));

  for (const key of ["name", "email", "phone", "location", "links", "work_authorization",
                     "relocation", "notice_period", "mail", "attachments"]) {
    assert.ok(key in p, `profile.example.yaml is missing ${key}`);
  }

  // The two fields that exist because two actors once answered the same form
  // question differently. They must be readable values, not prose to interpret.
  assert.equal(typeof p.relocation.willing, "boolean",
    "relocation.willing must be a boolean a form can read, not a sentence to interpret");
  assert.ok(Array.isArray(p.work_authorization) && p.work_authorization.length > 0);
  for (const entry of p.work_authorization) {
    assert.ok(entry.region && entry.status, "each work_authorization entry needs region and status");
  }

  assert.equal(p.location.city, "London");
  assert.equal(p.email, "ada@example.com");
});

test("rules.example.yaml parses, ships mode: review, and carries the doctrine", () => {
  const src = read(join(TEMPLATES, "rules.example.yaml"));
  const r = parseYaml(src);

  assert.equal(r.mode, "review", "the template documents the intended steady state");
  assert.deepEqual(r.autopilot_channels, [], "autopilot is opt-in per channel");

  assert.equal(r.company.maxApplications, 1, "one application per company");
  assert.equal(r.company.followups_allowed, false, "no follow-up, no correction, ever");
  assert.equal(r.cv.regenerate_per_role, false);

  assert.ok(r.limits.maxPerDay > 0 && r.limits.minGapMinutes > 0);
  assert.ok(Array.isArray(r.roles.allow) && r.roles.allow.length > 0);
  assert.ok(Array.isArray(r.roles.deny), "deny ships empty; the entries are a commented starter list");
  assert.ok(r.lease.seconds > 0 && r.clock.skewSeconds > 0);
  assert.ok(r.receipts.required_channels.includes("form"));

  // The em dash is banned, and the file bans it without containing it: the
  // value is written as a \u escape. Otherwise the rule would trip its own test.
  assert.deepEqual(r.content.banned_characters, [EM_DASH]);
  assert.ok(!src.includes(EM_DASH), "the ban must be written as an escape, not as the glyph");

  assert.ok(r.content.max_sections > 0 && r.content.max_sentences > 0);
  assert.ok(r.content.banned_phrases.includes("circle back"));

  // Every rule carries a stated reason. A rule with no WHY gets deleted by the
  // next person who finds it inconvenient.
  const whys = src.split("\n").filter((l) => /^\s*#\s*(WHY|NOTE:)/.test(l)).length;
  assert.ok(whys >= 10, `expected a reason next to each rule, found ${whys} WHY comments`);
});

test("voice.example.md has all six sections, Provenance included", () => {
  const v = read(join(TEMPLATES, "voice.example.md"));
  for (const h of ["## Register", "## Hard limits", "## Openings", "## Closings",
                   "## Negative rules", "## Provenance"]) {
    assert.ok(v.includes(h), `voice.example.md is missing ${h}`);
  }
  for (const field of ["Derived from:", "On:", "By:", "Reviewed by:"]) {
    assert.ok(v.includes(field), `Provenance is missing "${field}"`);
  }
});

test("knowledge-base.scaffold.md carries the heading scheme and the three markers", () => {
  const kb = read(join(TEMPLATES, "knowledge-base.scaffold.md"));
  for (const h of ["## 1. Identity and Contact", "## 2. Positioning and Headlines",
                   "## 3. Company and Product Context", "## 4. Experience",
                   "## 5. Prior Roles", "## 6. Education",
                   "## 7. Skills and Tags Matrix", "### 7.1 Trending keyword bank",
                   "## 8. Reusable Achievement Bullets", "## 9. Open Items to Confirm"]) {
    assert.ok(kb.includes(h), `scaffold is missing heading: ${h}`);
  }
  for (const marker of ["[[FILL", "confirm", "(internal)", "(public)"]) {
    assert.ok(kb.includes(marker), `scaffold is missing the ${marker} convention`);
  }
  assert.ok(kb.includes('"How I work" - framing variants'),
    "the framing variants must live in the knowledge base and be rendered, never pasted into a template");
});

test("workspace.gitignore excludes everything that could leak somebody else's data", () => {
  const gi = read(join(TEMPLATES, "workspace.gitignore"));
  for (const pattern of ["career.db", "career.db-wal", "career.db-shm", ".ledger.jsonl",
                         ".leases/", ".previewer-token", "outputs/receipts/", "drafts/", "jobs/"]) {
    const line = gi.split("\n").find((l) => l.trim() === pattern);
    assert.ok(line, `workspace.gitignore does not ignore ${pattern}`);
  }
  // Each ignore line is explained. An unexplained ignore gets removed by the
  // first person who wonders why their job records are not in git.
  const comments = gi.split("\n").filter((l) => l.trim().startsWith("#")).length;
  assert.ok(comments >= 20, `expected a reason per entry, found ${comments} comment lines`);
});

/* --------------------------------------------------------- the PII gate */

test("no template or extension file contains personal data", () => {
  // "/Users/" catches an absolute path from the machine this was extracted on,
  // which is how a de-personalisation pass usually leaks: not a name, a path.
  const banned = [/marcin/i, /walendowski/i, /\/Users\//];
  for (const file of [...templateFiles, ...extensionFiles]) {
    const body = read(file);
    for (const re of banned) {
      assert.ok(!re.test(body), `${rel(file)} contains ${re}`);
    }
  }
});

test("README.md carries the owner handle only inside the repo path", () => {
  // The README must name the repo or nobody can install it, and the repo path
  // contains the owner's GitHub handle. That is the ONE allowed occurrence:
  // a public repo address, not personal data. Everything else is banned.
  const body = read(README);
  assert.ok(!/\/Users\//.test(body), "README must not contain a machine-local path");

  const hits = body.match(/Marcin\w*/gi) || [];
  for (const hit of hits) {
    const at = body.indexOf(hit);
    const context = body.slice(Math.max(0, at - 30), at + hit.length + 20);
    assert.match(context, /(marketplace add|github\.com\/)\s*MarcinWalendowski\/career-kit/,
      `README mentions "${hit}" outside the repo path: ...${context}...`);
  }
});

test("no public file contains an em dash", () => {
  // The product bans this character for the user. A template that contains one
  // is the tool failing its own rule in the first file the user opens.
  for (const file of publicFiles) {
    const body = read(file);
    const at = body.indexOf(EM_DASH);
    assert.equal(at, -1,
      at === -1 ? "" : `${rel(file)} contains an em dash at offset ${at}: ${JSON.stringify(body.slice(at - 40, at + 40))}`);
  }
});

/* ------------------------------------------------------------- the themes */

const THEMES = {
  default: join(TEMPLATES, "themes", "default", "theme.css"),
  compact: join(TEMPLATES, "themes", "compact", "theme.css"),
};

/** Pull selectors out of CSS. Matches innermost blocks only, so the rules
 *  inside @media are collected and the at-rule itself is skipped. */
function selectors(css) {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const set = new Set();
  for (const m of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    for (const part of m[1].split(",")) {
      const sel = part.trim();
      if (!sel || sel.startsWith("@")) continue;
      set.add(sel);
    }
  }
  return set;
}

/** The rules the renderer's hidden-text lint refuses. A theme that needs one of
 *  these for an honest reason still fails, because a lint cannot tell an honest
 *  hide from a dishonest one. The supported alternative is data-print-only /
 *  data-screen-only, which the renderer strips from the DOM. */
const HIDDEN_TEXT = [
  [/display\s*:\s*none/i, "display:none"],
  [/visibility\s*:\s*hidden/i, "visibility:hidden"],
  [/opacity\s*:\s*0(\.0+)?\s*(!important)?\s*[;}]/i, "opacity:0"],
  [/font-size\s*:\s*0(px|em|rem|%)?\s*(!important)?\s*[;}]/i, "font-size:0"],
  [/-\d{4,}px/, "off-screen positioning"],
  [/clip\s*:\s*rect\(\s*0[\s,]/i, "clip:rect(0,0,0,0)"],
];

for (const [name, path] of Object.entries(THEMES)) {
  test(`${name} theme hides no text`, () => {
    const css = read(path).replace(/\/\*[\s\S]*?\*\//g, "");
    for (const [re, label] of HIDDEN_TEXT) {
      const m = css.match(re);
      assert.equal(m, null, `${name}/theme.css uses ${label}: ${m && m[0]}`);
    }
  });
}

test("the default theme keeps the A4 print geometry the fit assertion depends on", () => {
  const css = read(THEMES.default);
  assert.match(css, /@page\s*\{\s*size:\s*A4;\s*margin:\s*10mm 12mm\s*\}/,
    "the one-page fit assertion depends on this exact page box");
  assert.match(css, /@media print/);
  assert.match(css, /page-break-inside:\s*avoid/,
    "a role that splits across the fold is the usual reason a fitting CV looks like it does not");
  // The seven custom properties.
  for (const v of ["--ink", "--muted", "--accent", "--accent-soft", "--rule", "--bg", "--maxw"]) {
    assert.ok(css.includes(`${v}:`), `default theme is missing ${v}`);
  }
});

test("the theme seam is real: compact covers the whole default class vocabulary", () => {
  // This is what makes "themes" a seam rather than a claim. A second theme that
  // skipped half the vocabulary would render with browser defaults in the gaps
  // and nobody would notice until a PDF went out.
  const a = selectors(read(THEMES.default));
  const b = selectors(read(THEMES.compact));
  const missing = [...a].filter((s) => !b.has(s));
  assert.deepEqual(missing, [], `compact theme does not style: ${missing.join(", ")}`);
  assert.ok(a.size >= 30, `expected a real vocabulary, found ${a.size} selectors`);

  // ...and it is a different theme, not a copy.
  assert.notEqual(read(THEMES.default), read(THEMES.compact));
});

/* ---------------------------------------------------------- the extension */

test("the extension can only talk to the local machine, and only when clicked", () => {
  const manifest = JSON.parse(read(join(EXTENSION, "manifest.json")));

  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"],
    "the local server is the only host the extension may reach");
  assert.ok(Array.isArray(manifest.permissions), "permissions must be declared explicitly");
  assert.ok(!manifest.permissions.includes("alarms"), "no scheduled runs, ever");
  assert.ok(!manifest.permissions.includes("tabs"), "activeTab only: access is granted by your click");
  assert.ok(!manifest.content_scripts,
    "content.js is injected on click, so it never runs on a page you merely visited");
  assert.ok(manifest.action && manifest.action.default_popup, "capture starts from the toolbar action");

  const content = read(join(EXTENSION, "content.js"));
  assert.ok(!/scrollTo|scrollIntoView|scrollBy/.test(content), "no auto-scroll");
  assert.ok(!/setInterval|setTimeout\s*\(\s*[^,]*,\s*\d{4,}/.test(content), "no timers");
  assert.match(content, /"discovered"/, "captured records are discoveries, not candidates to send");
  assert.match(content, /channel:\s*"none"/, "a results card does not prove where the application goes");
});
