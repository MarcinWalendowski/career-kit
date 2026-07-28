#!/usr/bin/env node
/**
 * validate.mjs - the job-record schema, plus the strict YAML subset that
 * `profile.yaml` and `rules.yaml` are written in.
 *
 * Two jobs, one file, because both exist for the same reason: a field whose
 * shape is only described in a comment drifts.
 *
 *   1. `validateJob(obj)` enforces the job-record enums instead of commenting
 *      them. The motivating record held
 *        "linkedin (preferred, draft) + ashby form staged + email draft"
 *      in a `channel` column whose schema comment read
 *        "email | ashby | form | imessage | none".
 *      Nothing rejected it, so every consumer downstream had to guess. Free
 *      text belongs in `notes`; `channel` is an enum and now says so in code.
 *
 *   2. `parseYaml(text)` is a deliberately small parser. It supports nested
 *      maps, block and flow sequences, flow maps, quoted and unquoted scalars,
 *      comments, booleans, numbers and nulls. Everything else THROWS. A config
 *      parser that quietly returns `undefined` for syntax it does not
 *      understand turns "mode: autopilot" into "mode: undefined", and an
 *      undefined mode is not a safe mode. Loud beats lenient here.
 *
 * Zero dependencies is a hard constraint of the kit, which is why there is no
 * ajv and no js-yaml. See README.
 *
 * CLI:
 *   node engine/validate.mjs               validate every jobs/*.json
 *   node engine/validate.mjs --all         the same thing, said out loud
 *   node engine/validate.mjs --id <id>     one record, by id
 *   node engine/validate.mjs --job <path>  one record, by path (jobs/inbox/ included)
 *   node engine/validate.mjs --fix         also repair what can be repaired safely
 *
 * Exit 0 clean, 2 usage error, 3 invalid records remain.
 */

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { findCareerHome, paths } from "./paths.mjs";

/* ── the schema ────────────────────────────────────────────────────────── */

export const JOB_SCHEMA = JSON.parse(
  readFileSync(new URL("./job.schema.json", import.meta.url), "utf8"),
);

/** Enums, read off the schema so there is exactly one copy of each list. */
export const CHANNELS = JOB_SCHEMA.properties.apply.properties.channel.enum;
export const STATUSES = JOB_SCHEMA.properties.status.enum;
export const WORKPLACE_TYPES = JOB_SCHEMA.properties.workplace_type.enum;

/**
 * Every channel except "none" puts something in front of a human at a company,
 * and none of them have an undo. `mode: draft` blocks all of them.
 */
export const SEND_CHANNELS = CHANNELS.filter((c) => c !== "none");

/* ── a very small JSON Schema validator ────────────────────────────────── */

const SUPPORTED = new Set([
  "$schema", "$id", "$ref", "$defs", "title", "description", "examples", "default",
  "type", "enum", "const", "required", "properties", "additionalProperties",
  "items", "minItems", "maxItems", "minimum", "maximum", "pattern", "format",
]);

function typeOf(v) {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  return typeof v;
}

function deref(schema, root) {
  if (!schema || !schema.$ref) return schema;
  const ref = schema.$ref;
  if (!ref.startsWith("#/")) throw new Error(`validate.mjs: only local $ref is supported, got ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split("/")) {
    node = node?.[part];
    if (!node) throw new Error(`validate.mjs: $ref ${ref} does not resolve`);
  }
  return node;
}

/**
 * An unknown keyword throws rather than being ignored. A schema that silently
 * drops "enum" because the validator never learned the word is worse than no
 * schema, because it reports "valid".
 */
function assertSupported(schema, path) {
  for (const k of Object.keys(schema)) {
    if (!SUPPORTED.has(k)) {
      throw new Error(`validate.mjs: unsupported schema keyword "${k}" at ${path}`);
    }
  }
}

function check(value, schema, path, root, errors) {
  schema = deref(schema, root);
  assertSupported(schema, path);

  if (schema.type !== undefined) {
    const want = Array.isArray(schema.type) ? schema.type : [schema.type];
    const got = typeOf(value);
    const ok = want.some(
      (t) => t === got || (t === "number" && got === "number") ||
        (t === "integer" && got === "number" && Number.isInteger(value)),
    );
    if (!ok) {
      errors.push({ path, message: `expected ${want.join(" | ")}, got ${got}` });
      return;
    }
  }

  if (schema.enum !== undefined && !schema.enum.some((e) => e === value)) {
    const shown = typeof value === "string" && value.length > 60 ? `${value.slice(0, 60)}...` : value;
    errors.push({
      path,
      message: `${JSON.stringify(shown)} is not one of: ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`,
    });
    return;
  }

  if (schema.const !== undefined && value !== schema.const) {
    errors.push({ path, message: `must be ${JSON.stringify(schema.const)}` });
  }

  if (value === null || value === undefined) return;

  if (typeof value === "string") {
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `does not match ${schema.pattern}` });
    }
    if (schema.format === "date-time" && !isIsoInstant(value)) {
      errors.push({ path, message: `"${value}" is not an ISO 8601 instant with a Z or an offset` });
    }
  }

  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push({ path, message: `must be >= ${schema.minimum}` });
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push({ path, message: `must be <= ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push({ path, message: `needs at least ${schema.minItems} item(s)` });
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push({ path, message: `allows at most ${schema.maxItems} item(s)` });
    }
    if (schema.items) {
      value.forEach((v, i) => check(v, schema.items, `${path}[${i}]`, root, errors));
    }
    return;
  }

  if (typeOf(value) === "object") {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push({ path: `${path}.${key}`, message: "is required" });
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (key in value) check(value[key], sub, `${path}.${key}`, root, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(schema.properties || {})[key]) {
          errors.push({ path: `${path}.${key}`, message: "is not a known field (descriptive text goes in notes)" });
        }
      }
    } else if (typeOf(schema.additionalProperties) === "object") {
      for (const key of Object.keys(value)) {
        if (!(schema.properties || {})[key]) {
          check(value[key], schema.additionalProperties, `${path}.${key}`, root, errors);
        }
      }
    }
  }
}

/**
 * A timestamp with no zone is not a timestamp, it is a number that looks like
 * one. Twenty-three records in the sweep this kit generalises held CEST
 * wall-clock labelled `Z`, which put every one of them two hours in the future
 * and made "was this sent before that?" unanswerable. The `Z`-or-offset
 * requirement is the cheap half of the fix; the gate's clock-skew check is the
 * other half.
 */
export function isIsoInstant(s) {
  if (typeof s !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) return false;
  return Number.isFinite(Date.parse(s));
}

/** `{ok, errors:[{path, message}]}`. Never throws on bad data, only on a bad schema. */
export function validateJob(obj) {
  const errors = [];
  if (typeOf(obj) !== "object") {
    return { ok: false, errors: [{ path: "$", message: `expected an object, got ${typeOf(obj)}` }] };
  }
  check(obj, JOB_SCHEMA, "$", JOB_SCHEMA, errors);
  return { ok: errors.length === 0, errors };
}

/* ── YAML, the small strict subset ─────────────────────────────────────── */

class YamlError extends Error {}

/**
 * Comments are stripped before anything else, but a `#` inside a quoted scalar
 * is not a comment, and an apostrophe inside an unquoted word is not a quote.
 * A quote only opens a scalar when it sits where a value may start.
 */
function stripComment(line, name, no) {
  let out = "";
  let quote = null;
  let prev = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      out += c;
      if (quote === '"' && c === "\\") {
        out += line[++i] ?? "";
        continue;
      }
      if (c === quote) quote = null;
      continue;
    }
    if ((c === '"' || c === "'") && (prev === "" || " ,[{:-".includes(prev))) {
      quote = c;
      out += c;
      prev = c;
      continue;
    }
    if (c === "#" && (prev === "" || prev === " ")) break;
    out += c;
    prev = c;
  }
  if (quote) throw new YamlError(`${name}:${no}: unterminated ${quote === '"' ? "double" : "single"} quote`);
  return out.replace(/\s+$/, "");
}

/** Count flow-collection depth outside quotes, so a multi-line [ ... ] can be joined. */
function flowDelta(s) {
  let depth = 0;
  let quote = null;
  let prev = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (quote === '"' && c === "\\") { i++; continue; }
      if (c === quote) quote = null;
      continue;
    }
    if ((c === '"' || c === "'") && (prev === "" || " ,[{:-".includes(prev))) { quote = c; prev = c; continue; }
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    prev = c;
  }
  return depth;
}

const UNSUPPORTED = [
  [/^\s*<<\s*:/, "merge keys (<<) are not supported"],
  [/(^|\s)[&*][A-Za-z0-9_-]+(\s|$)/, "anchors and aliases (& and *) are not supported"],
  [/:\s*[|>][+-]?\s*$/, "block scalars (| and >) are not supported; quote the value on one line"],
  [/^\s*[|>][+-]?\s*$/, "block scalars (| and >) are not supported; quote the value on one line"],
  [/(^|\s)!!?[A-Za-z]/, "tags (!! and !) are not supported"],
  [/^\s*\?\s/, "explicit complex keys (?) are not supported"],
];

function scan(text, name) {
  const lines = [];
  let sawContent = false;
  let pending = null;

  text.split(/\r?\n/).forEach((raw, idx) => {
    const no = idx + 1;
    if (/^[ ]*\t/.test(raw)) {
      throw new YamlError(`${name}:${no}: tab in the indentation. YAML forbids it; use spaces.`);
    }
    const stripped = stripComment(raw, name, no);
    if (!stripped.trim()) return;

    for (const [re, why] of UNSUPPORTED) {
      if (re.test(stripped)) throw new YamlError(`${name}:${no}: ${why}\n  ${raw.trim()}`);
    }

    const indent = stripped.match(/^ */)[0].length;
    const content = stripped.slice(indent);

    if (content === "---") {
      if (sawContent) throw new YamlError(`${name}:${no}: multi-document YAML is not supported`);
      return;
    }
    if (content === "...") throw new YamlError(`${name}:${no}: document end markers are not supported`);

    if (pending) {
      pending.content += " " + content;
      pending.depth += flowDelta(content);
      if (pending.depth === 0) {
        lines.push(pending);
        pending = null;
      } else if (pending.depth < 0) {
        throw new YamlError(`${name}:${no}: unbalanced ] or } in a flow collection`);
      }
      return;
    }

    sawContent = true;
    const depth = flowDelta(content);
    if (depth > 0) {
      // A flow sequence may wrap, and the shipped rules.yaml wraps its role
      // allowlist across three lines. Join until it closes.
      pending = { indent, content, no, depth };
      return;
    }
    if (depth < 0) throw new YamlError(`${name}:${no}: unbalanced ] or } in a flow collection`);
    lines.push({ indent, content, no });
  });

  if (pending) throw new YamlError(`${name}:${pending.no}: flow collection is never closed`);
  return lines;
}

/** Find the `key:` separator: the first colon at flow depth zero followed by space or EOL. */
function splitKey(content, name, no) {
  let i = 0;
  if (content[0] === '"' || content[0] === "'") {
    const q = content[0];
    i = 1;
    while (i < content.length && content[i] !== q) {
      if (q === '"' && content[i] === "\\") i++;
      i++;
    }
    if (i >= content.length) throw new YamlError(`${name}:${no}: unterminated quoted key`);
    i++;
    if (content[i] !== ":") return null;
    return [parseScalar(content.slice(0, i), name, no), content.slice(i + 1).trim()];
  }
  let depth = 0;
  for (; i < content.length; i++) {
    const c = content[i];
    if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    else if (c === ":" && depth === 0 && (i + 1 >= content.length || content[i + 1] === " ")) {
      return [content.slice(0, i).trim(), content.slice(i + 1).trim()];
    }
  }
  return null;
}

function parseScalar(s, name, no) {
  const t = s.trim();
  if (t === "" || t === "~" || t === "null" || t === "Null" || t === "NULL") return null;
  if (t === "true" || t === "True" || t === "TRUE") return true;
  if (t === "false" || t === "False" || t === "FALSE") return false;
  // yes/no/on/off are NOT booleans here. YAML 1.1 said they were, which is how
  // the country code NO became `false` in a thousand config files. If you mean
  // a boolean, write true or false.
  if (t[0] === '"' || t[0] === "'") return parseQuoted(t, name, no);
  if (t[0] === "[" || t[0] === "{") {
    const [v, rest] = parseFlow(t, name, no);
    if (rest.trim()) throw new YamlError(`${name}:${no}: trailing text after a flow collection: ${rest.trim()}`);
    return v;
  }
  if (/^-?\d+$/.test(t) && !/^-?0\d/.test(t)) return Number(t);
  if (/^-?(\d+\.\d*|\.\d+|\d+)([eE][+-]?\d+)?$/.test(t) && /[.eE]/.test(t)) return Number(t);
  return t;
}

function parseQuoted(t, name, no) {
  const q = t[0];
  let out = "";
  let i = 1;
  for (; i < t.length; i++) {
    const c = t[i];
    if (q === '"' && c === "\\") {
      const e = t[++i];
      if (e === "n") out += "\n";
      else if (e === "t") out += "\t";
      else if (e === "r") out += "\r";
      else if (e === "u") { out += String.fromCharCode(parseInt(t.slice(i + 1, i + 5), 16)); i += 4; }
      else out += e;
      continue;
    }
    if (c === q) {
      if (q === "'" && t[i + 1] === "'") { out += "'"; i++; continue; }
      break;
    }
    out += c;
  }
  const rest = t.slice(i + 1).trim();
  if (rest) throw new YamlError(`${name}:${no}: trailing text after a quoted scalar: ${rest}`);
  return out;
}

/** Flow collections: [a, b] and {a: b, c: d}, nestable, returns [value, rest]. */
function parseFlow(s, name, no) {
  const open = s[0];
  const close = open === "[" ? "]" : "}";
  let i = 1;
  const items = [];
  for (;;) {
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) throw new YamlError(`${name}:${no}: flow collection is never closed`);
    if (s[i] === close) { i++; break; }
    let j = i;
    let depth = 0;
    let quote = null;
    for (; j < s.length; j++) {
      const c = s[j];
      if (quote) {
        if (quote === '"' && c === "\\") j++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === "[" || c === "{") depth++;
      else if (c === "]" || c === "}") { if (depth === 0) break; depth--; }
      else if (c === "," && depth === 0) break;
    }
    const raw = s.slice(i, j).trim();
    if (raw) {
      const kv = open === "{" ? splitKey(raw, name, no) : null;
      if (open === "{") {
        if (!kv) throw new YamlError(`${name}:${no}: flow map entry "${raw}" is missing its "key: value" colon`);
        items.push([kv[0], parseScalar(kv[1], name, no)]);
      } else {
        items.push(parseScalar(raw, name, no));
      }
    }
    i = j;
    if (s[i] === ",") i++;
  }
  const value = open === "[" ? items : Object.fromEntries(items);
  return [value, s.slice(i)];
}

function parseMap(state, indent, name) {
  const map = {};
  while (state.peek() && state.peek().indent >= indent) {
    const line = state.peek();
    if (line.indent > indent) {
      throw new YamlError(`${name}:${line.no}: unexpected indentation (expected ${indent} spaces, got ${line.indent})`);
    }
    if (/^-(\s|$)/.test(line.content)) {
      throw new YamlError(`${name}:${line.no}: a list item where a "key: value" was expected`);
    }
    const kv = splitKey(line.content, name, line.no);
    if (!kv) throw new YamlError(`${name}:${line.no}: expected "key: value"\n  ${line.content}`);
    const [key, rest] = kv;
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      // Real YAML lets the last one win, silently. Two `mode:` keys in
      // rules.yaml is never intentional and always dangerous.
      throw new YamlError(`${name}:${line.no}: duplicate key "${key}"`);
    }
    state.next();
    if (rest === "") {
      const next = state.peek();
      map[key] = next && next.indent > indent ? parseBlockNamed(state, next.indent, name) : null;
    } else {
      map[key] = parseScalar(rest, name, line.no);
    }
  }
  return map;
}

function parseSeq(state, indent, name) {
  const arr = [];
  while (state.peek() && state.peek().indent === indent && /^-(\s|$)/.test(state.peek().content)) {
    const line = state.next();
    const m = line.content.match(/^-(\s+)/);
    const rest = m ? line.content.slice(1 + m[1].length) : "";
    if (rest === "") {
      const next = state.peek();
      arr.push(next && next.indent > indent ? parseBlockNamed(state, next.indent, name) : null);
      continue;
    }
    const kv = splitKey(rest, name, line.no);
    if (kv) {
      // "- key: value" starts a mapping whose remaining keys are indented to
      // the column the key actually sits in, not to a guessed offset.
      const virtual = line.indent + 1 + m[1].length;
      state.inject({ indent: virtual, content: rest, no: line.no });
      arr.push(parseMap(state, virtual, name));
      continue;
    }
    arr.push(parseScalar(rest, name, line.no));
  }
  const next = state.peek();
  if (next && next.indent > indent) {
    throw new YamlError(`${name}:${next.no}: unexpected indentation inside a list`);
  }
  return arr;
}

function parseBlockNamed(state, indent, name) {
  const line = state.peek();
  if (!line || line.indent < indent) return null;
  return /^-(\s|$)/.test(line.content) ? parseSeq(state, line.indent, name) : parseMap(state, line.indent, name);
}

/**
 * Parse the workspace YAML subset. Throws a YamlError naming the file and line
 * for anything it does not support.
 */
export function parseYaml(text, { name = "yaml" } = {}) {
  const lines = scan(String(text), name);
  if (!lines.length) return {};
  const state = {
    lines,
    i: 0,
    peek() { return this.lines[this.i] || null; },
    next() { return this.lines[this.i++]; },
    inject(line) { this.lines.splice(this.i, 0, line); },
  };
  const value = parseBlockNamed(state, lines[0].indent, name);
  if (state.peek()) {
    throw new YamlError(`${name}:${state.peek().no}: unexpected content after the document`);
  }
  return value;
}

export function readYaml(path, { required = true, fallback = {} } = {}) {
  if (!existsSync(path)) {
    if (required) {
      process.stderr.write(`career-kit: ${path} is missing. Run the career-setup skill.\n`);
      process.exit(2);
    }
    return fallback;
  }
  try {
    return parseYaml(readFileSync(path, "utf8"), { name: path.split("/").pop() });
  } catch (err) {
    process.stderr.write(`career-kit: ${err.message}\n`);
    process.exit(2);
  }
}

/* ── repair ────────────────────────────────────────────────────────────── */

/**
 * Legacy channel spellings seen in the wild, mapped onto the enum. `ashby`
 * predates the `ats-` prefix; the value was a bare board name back when the
 * column was free text.
 */
const CHANNEL_ALIASES = {
  ashby: "ats-ashby",
  greenhouse: "ats-greenhouse",
  lever: "ats-lever",
  workable: "ats-workable",
  smartrecruiters: "ats-smartrecruiters",
  recruitee: "ats-recruitee",
  workday: "ats-workday",
  mail: "email",
  "": "none",
};

const STATUS_ALIASES = { unknown: "discovered", draft: "drafted", new: "discovered", pending: "drafted" };

/**
 * Conservative repair. It normalises shape and moves free text out of enum
 * columns into `notes`; it never invents a company, a role or a timestamp.
 * Returns `{obj, fixes:[]}`.
 */
export function fixJob(input) {
  const obj = JSON.parse(JSON.stringify(input));
  const fixes = [];
  const note = (t) => {
    obj.notes = [obj.notes, t].filter(Boolean).join("\n");
  };

  if (typeof obj.domains === "string") {
    obj.domains = obj.domains.split(/[,\s]+/).filter(Boolean);
    fixes.push("domains: split a comma string into an array");
  }
  if (!Array.isArray(obj.domains)) obj.domains = [];

  obj.apply = obj.apply && typeof obj.apply === "object" ? obj.apply : {};
  if (typeof obj.channel === "string" && obj.apply.channel === undefined) {
    obj.apply.channel = obj.channel;
    delete obj.channel;
    fixes.push("channel: moved to apply.channel");
  }
  if (typeof obj.target === "string" && obj.apply.target === undefined) {
    obj.apply.target = obj.target;
    delete obj.target;
    fixes.push("target: moved to apply.target");
  }

  let ch = String(obj.apply.channel ?? "").trim().toLowerCase();
  if (CHANNEL_ALIASES[ch]) {
    fixes.push(`apply.channel: "${ch}" -> "${CHANNEL_ALIASES[ch]}"`);
    ch = CHANNEL_ALIASES[ch];
  }
  if (!CHANNELS.includes(ch)) {
    // This is the espa.json repair. A sentence describing a plan is not a
    // channel; it goes to notes and the channel drops to "none" so nothing
    // downstream can act on a route that was never decided.
    note(`channel was recorded as free text: ${JSON.stringify(obj.apply.channel)}`);
    fixes.push(`apply.channel: free text moved to notes, channel set to "none"`);
    ch = "none";
  }
  obj.apply.channel = ch;

  if (typeof obj.status === "string") {
    const s = obj.status.trim().toLowerCase();
    if (STATUS_ALIASES[s]) {
      fixes.push(`status: "${obj.status}" -> "${STATUS_ALIASES[s]}"`);
      obj.status = STATUS_ALIASES[s];
    } else if (STATUSES.includes(s) && s !== obj.status) {
      obj.status = s;
      fixes.push("status: lowercased");
    }
  }
  if (!STATUSES.includes(obj.status)) {
    note(`status was recorded as ${JSON.stringify(obj.status)}`);
    obj.status = "discovered";
    fixes.push('status: unrecognised value moved to notes, set to "discovered"');
  }

  if (obj.workplace_type !== undefined && !WORKPLACE_TYPES.includes(obj.workplace_type)) {
    note(`workplace_type was recorded as ${JSON.stringify(obj.workplace_type)}`);
    obj.workplace_type = "unknown";
    fixes.push('workplace_type: unrecognised value moved to notes, set to "unknown"');
  }

  if (obj.sent_at_source !== undefined && obj.sent_at_source !== null && obj.sent_at_source !== "transport") {
    // A client clock is not a source. Dropping it to null makes the record say
    // "we do not know when this went out", which is the truth.
    note(`sent_at_source was recorded as ${JSON.stringify(obj.sent_at_source)}`);
    obj.sent_at_source = null;
    fixes.push("sent_at_source: only \"transport\" is a source, set to null");
  }

  for (const [key, val] of Object.entries({
    seniority: null, source_id: null, url: null, location: null,
    sent_at: null, sent_at_source: null, message_id: null, subject: null,
    receipt: null, notes: null, needs_human: false, workplace_type: "unknown",
  })) {
    if (obj[key] === undefined) obj[key] = val;
  }
  for (const key of ["evidence", "incidents", "escalations"]) {
    if (obj[key] === undefined) obj[key] = [];
  }
  if (obj.posted_comp === undefined) {
    obj.posted_comp = { currency: null, min: null, max: null, period: "year", equity: null };
  }
  if (!obj.updated_at) {
    obj.updated_at = new Date().toISOString();
    fixes.push("updated_at: stamped");
  }
  return { obj, fixes };
}

/* ── CLI ───────────────────────────────────────────────────────────────── */

const USAGE = "usage: validate.mjs [--all] [--id <id>] [--job <path>] [--fix]";

function main(argv) {
  const KNOWN = new Set(["--all", "--fix", "--id", "--job"]);
  const flag = (name) => {
    const i = argv.indexOf(name);
    if (i === -1) return null;
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      process.stderr.write(`validate: ${name} needs a value. ${USAGE}\n`);
      process.exit(2);
    }
    return value;
  };

  const unknown = argv.find((a) => a.startsWith("--") && !KNOWN.has(a));
  if (unknown) {
    process.stderr.write(`validate: unknown flag ${unknown}. ${USAGE}\n`);
    process.exit(2);
  }
  const fix = argv.includes("--fix");
  const only = flag("--id");
  const one = flag("--job");
  if (only && one) {
    process.stderr.write(`validate: --id and --job select the same thing two different ways. Pick one. ${USAGE}\n`);
    process.exit(2);
  }

  const P = paths(findCareerHome());

  // --job takes a PATH, not an id, so a record can be checked before it is a
  // record: the extension drops captures into jobs/inbox/, and those have to be
  // validated during triage while they still live outside jobs/.
  const targets = one
    ? [{ id: basename(one).replace(/\.json$/, ""), path: one }]
    : (existsSync(P.jobs) ? readdirSync(P.jobs) : [])
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => ({ id: f.replace(/\.json$/, ""), path: join(P.jobs, f) }))
        .filter((t) => !only || t.id === only);

  if (one && !existsSync(one)) {
    process.stderr.write(`validate: --job ${one} does not exist\n`);
    process.exit(2);
  }
  if (only && !targets.length) {
    process.stderr.write(`validate: no job record with id "${only}" in ${P.jobs}\n`);
    process.exit(2);
  }

  const report = { checked: 0, valid: 0, invalid: 0, fixed: 0, records: [] };

  for (const { id, path } of targets) {
    report.checked++;

    let obj;
    try {
      obj = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      report.invalid++;
      report.records.push({ id, ok: false, errors: [{ path: "$", message: `unreadable JSON: ${err.message}` }] });
      continue;
    }

    let result = validateJob(obj);
    let fixes = [];
    if (!result.ok && fix) {
      const repaired = fixJob(obj);
      const after = validateJob(repaired.obj);
      if (repaired.fixes.length) {
        writeFileSync(path, JSON.stringify(repaired.obj, null, 2) + "\n");
        fixes = repaired.fixes;
        report.fixed++;
        result = after;
      }
    }
    if (result.ok) report.valid++;
    else report.invalid++;
    report.records.push({ id, ok: result.ok, errors: result.errors, ...(fixes.length ? { fixes } : {}) });
  }

  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  if (report.invalid) {
    process.stderr.write(
      `validate: ${report.invalid} record(s) still invalid` +
        (fix ? ".\n" : ". Re-run with --fix to repair what can be repaired safely.\n"),
    );
    process.exit(3);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
