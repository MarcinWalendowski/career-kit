/**
 * sources/index.mjs - the adapter registry, the one normaliser all eleven
 * adapters agree on, and the shared HTTP helpers.
 *
 * Three rules hold this file together.
 *
 * 1. ONE normaliser. Every adapter returns a record shaped by normalise() here,
 *    so a caller never has to ask which source a record came from before it can
 *    read it. An adapter that wants a new field changes this file, in the open.
 *
 * 2. A field the adapter cannot determine is null. Never a guess. A guessed
 *    salary band or a guessed location is worse than a missing one, because a
 *    missing one is visibly missing and a guessed one is quietly wrong.
 *
 * 3. HTTP is injectable. Every adapter takes `deps` as its second argument and
 *    calls `deps.fetchJson ?? fetchJson`. That is what lets the contract tests
 *    run against recorded fixtures with no network, which is in turn what makes
 *    "a board changed its schema" fail loudly instead of returning zero jobs.
 *
 * Zero runtime dependencies. Node 20+, global fetch, nothing from npm.
 */

import { slug } from "../paths.mjs";

import * as greenhouse from "./greenhouse.mjs";
import * as lever from "./lever.mjs";
import * as ashby from "./ashby.mjs";
import * as smartrecruiters from "./smartrecruiters.mjs";
import * as recruitee from "./recruitee.mjs";
import * as workable from "./workable.mjs";
import * as hn from "./hn-whoishiring.mjs";
import * as remoteBoards from "./remote-boards.mjs";
import * as linkedin from "./linkedin.mjs";
import * as capture from "./capture.mjs";

/* ------------------------------------------------------------------ registry */

/**
 * The registry is built lazily, inside a function, and never at module scope.
 *
 * index.mjs and every adapter import each other (adapters need normalise, the
 * registry needs the adapters). ESM handles that cycle only as long as nothing
 * reads an adapter's exported bindings while a module is still evaluating.
 * Touching `greenhouse.id` at the top level of this file would do exactly that
 * whenever a test imports an adapter directly. Reading it inside a function
 * that runs later is safe.
 */
let REGISTRY = null;

export function adapters() {
  if (!REGISTRY) {
    REGISTRY = [
      greenhouse,
      lever,
      ashby,
      smartrecruiters,
      recruitee,
      workable,
      hn,
      remoteBoards,
      linkedin,
      capture,
    ];
  }
  return REGISTRY;
}

export function adapter(id) {
  return adapters().find((a) => a.id === id) ?? null;
}

/**
 * Two adapters cover several sources each, and a record's `source` names the
 * board it actually came from rather than the file that read it. Per-source
 * rate limits are the reason: bucketing four aggregators as one source would
 * make a cap of 10 mean 40.
 */
const SUB_SOURCES = {
  remoteok: "remote-boards",
  remotive: "remote-boards",
  arbeitnow: "remote-boards",
  himalayas: "remote-boards",
  "yc-work-at-a-startup": "capture",
  justjoin: "capture",
  nofluffjobs: "capture",
  pracuj: "capture",
};

export function adapterForSource(source) {
  return adapter(SUB_SOURCES[source] ?? source);
}

/** Which adapter, if any, claims this URL. */
export function adapterForUrl(url) {
  if (!url) return null;
  for (const a of adapters()) {
    try {
      if (a.match(url)) return a;
    } catch {
      // A match() that throws on a malformed URL is not a reason to abort the
      // scan over the other adapters.
    }
  }
  return null;
}

/**
 * The apply channel a source implies. Kept here rather than exported from each
 * adapter so that resolve-route.mjs and the HN parser can label a bare URL.
 */
const CHANNEL_BY_SOURCE = {
  greenhouse: "ats-greenhouse",
  lever: "ats-lever",
  ashby: "ats-ashby",
  smartrecruiters: "ats-smartrecruiters",
  recruitee: "ats-recruitee",
  workable: "ats-workable",
  workday: "ats-workday",
  linkedin: "linkedin",
};

export function channelForSource(sourceId) {
  return CHANNEL_BY_SOURCE[sourceId] ?? null;
}

/** The channel implied by a URL, or null when no adapter recognises it. */
export function channelForUrl(url) {
  const a = adapterForUrl(url);
  if (!a) return null;
  return channelForSource(a.id);
}

/* ------------------------------------------------------------------- schema */

export const CHANNELS = new Set([
  "email",
  "form",
  "ats-ashby",
  "ats-greenhouse",
  "ats-lever",
  "ats-workable",
  "ats-smartrecruiters",
  "ats-recruitee",
  "ats-workday",
  "linkedin",
  "imessage",
  "referral",
  "none",
]);

export const WORKPLACE_TYPES = new Set(["onsite", "hybrid", "remote", "unknown"]);

export const COMP_PERIODS = new Set(["year", "month", "week", "day", "hour"]);

/** Not enforced anywhere else, so it is written down here. null is always allowed. */
export const SENIORITIES = new Set([
  "intern",
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
  "founding",
  "executive",
]);

/* --------------------------------------------------------------- normaliser */

/**
 * Turn an adapter's per-board shape into the job record in SPEC-001.
 *
 * Required: company, role, source, source_id, url. Those five are what makes a
 * record addressable at all, so a payload missing one is a schema change and
 * throws rather than producing a record with a null company.
 */
export function normalise(input) {
  const source = req(input, "source");
  const company = collapse(req(input, "company"));
  const role = collapse(req(input, "role"));
  const source_id = String(req(input, "source_id"));
  const url = req(input, "url");

  const company_id = slug(input.company_id ?? company);

  const channel = input.apply?.channel ?? "none";
  if (!CHANNELS.has(channel)) {
    throw new Error(`sources/${source}: unknown apply.channel ${JSON.stringify(channel)}`);
  }

  const workplace_type = input.workplace_type ?? "unknown";
  if (!WORKPLACE_TYPES.has(workplace_type)) {
    throw new Error(
      `sources/${source}: unknown workplace_type ${JSON.stringify(workplace_type)}`,
    );
  }

  const seniority = input.seniority === undefined ? seniorityFromTitle(role) : input.seniority;
  if (seniority !== null && !SENIORITIES.has(seniority)) {
    throw new Error(`sources/${source}: unknown seniority ${JSON.stringify(seniority)}`);
  }

  const comp = input.posted_comp ?? {};
  const period = comp.period ?? null;
  if (period !== null && !COMP_PERIODS.has(period)) {
    throw new Error(`sources/${source}: unknown posted_comp.period ${JSON.stringify(period)}`);
  }

  const at = isoOrNull(input.discovered_at) ?? new Date().toISOString();

  return {
    id: input.id ? slug(input.id) : `${company_id}-${slug(role)}`,
    company,
    company_id,
    domains: normaliseDomains(input.domains),
    role,
    seniority: seniority ?? null,
    source,
    source_id,
    url,
    apply: {
      channel,
      target: input.apply?.target ?? null,
      route_confidence: numOrNull(input.apply?.route_confidence),
      // Default false, never null: an unverified identity is a block, and a
      // block needs a definite answer. identity.mjs is what flips this true.
      identity_verified: input.apply?.identity_verified === true,
      identity_domain: input.apply?.identity_domain ?? null,
    },
    location: emptyToNull(input.location),
    workplace_type,
    posted_comp: {
      currency: emptyToNull(comp.currency),
      min: numOrNull(comp.min),
      max: numOrNull(comp.max),
      period,
      equity: comp.equity ?? null,
    },
    status: "discovered",
    sent_at: null,
    sent_at_source: null,
    message_id: null,
    subject: null,
    receipt: null,
    notes: emptyToNull(input.notes),
    evidence: Array.isArray(input.evidence) ? input.evidence.map(entry) : [],
    incidents: [],
    escalations: [],
    discovered_at: at,
    updated_at: at,
  };
}

/**
 * Normalise a batch and make the ids unique within it.
 *
 * Two openings with the same title at the same company are common (different
 * offices, different teams) and would otherwise collide on
 * `<company>-<role-slug>`. The spec allows the `-<n>` suffix for exactly this.
 * Uniqueness across batches is the workspace writer's problem, not ours.
 */
export function normaliseAll(inputs) {
  const seen = new Map();
  const out = [];
  for (const input of inputs) {
    const rec = normalise(input);
    const n = (seen.get(rec.id) ?? 0) + 1;
    seen.set(rec.id, n);
    if (n > 1) rec.id = `${rec.id}-${n}`;
    out.push(rec);
  }
  return out;
}

function entry(e) {
  return {
    at: isoOrNull(e?.at) ?? new Date().toISOString(),
    kind: e?.kind ?? "note",
    text: String(e?.text ?? ""),
  };
}

function req(input, key) {
  const v = input?.[key];
  if (v === undefined || v === null || v === "") {
    throw new Error(
      `sources/${input?.source ?? "?"}: required field ${key} missing from the payload. ` +
        "The board's schema changed, or this adapter is pointed at the wrong endpoint.",
    );
  }
  return v;
}

/* ------------------------------------------------------------------ helpers */

export function collapse(s) {
  return String(s).replace(/\s+/g, " ").trim();
}

export function emptyToNull(s) {
  if (s === undefined || s === null) return null;
  const t = typeof s === "string" ? collapse(s) : s;
  return t === "" ? null : t;
}

export function numOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

export function isoOrNull(v) {
  if (v === undefined || v === null || v === "") return null;
  const d = v instanceof Date ? v : new Date(typeof v === "number" && v < 1e12 ? v * 1000 : v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** Milliseconds for an opts.since that may be an ISO string, a Date or epoch. */
export function sinceMs(since) {
  if (since === undefined || since === null || since === "") return null;
  const iso = isoOrNull(since);
  return iso ? Date.parse(iso) : null;
}

/** Strip scheme, www and path so "https://www.Example.com/x" becomes "example.com". */
export function normaliseDomain(d) {
  if (!d) return null;
  const s = String(d)
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    .replace(/:\d+$/, "");
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : null;
}

export function normaliseDomains(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(normaliseDomain).filter(Boolean))];
}

/**
 * Seniority from the title, by keyword, or null. This is parsing and not
 * guessing: the words are in the title or the answer is null.
 */
export function seniorityFromTitle(title) {
  const t = String(title).toLowerCase();
  // "Member of Technical Staff" is not a staff-level title. Checked first
  // because \bstaff\b matches it and would silently promote every MTS req.
  if (/\bmember of (the )?technical staff\b/.test(t) || /\bmts\b/.test(t)) return null;
  if (/\bintern(ship)?\b/.test(t)) return "intern";
  if (/\b(principal|distinguished|fellow)\b/.test(t)) return "principal";
  if (/\b(head of|vp|vice president|chief|cto|director)\b/.test(t)) return "executive";
  if (/\bstaff\b/.test(t)) return "staff";
  if (/\bfounding\b/.test(t)) return "founding";
  if (/\b(senior|sr\.?)\b/.test(t)) return "senior";
  if (/\b(junior|jr\.?|new ?grad|graduate|entry[- ]level)\b/.test(t)) return "junior";
  if (/\b(mid|mid[- ]level|intermediate)\b/.test(t)) return "mid";
  return null;
}

/** onsite | hybrid | remote | unknown from free text. Unknown is a real answer. */
export function workplaceFromText(...parts) {
  const t = parts.filter(Boolean).join(" ").toLowerCase();
  if (!t) return "unknown";
  if (/\bhybrid\b/.test(t)) return "hybrid";
  if (/\b(remote|work from home|wfh|distributed|anywhere)\b/.test(t)) return "remote";
  if (/\b(on[- ]?site|in[- ]?office|in[- ]person)\b/.test(t)) return "onsite";
  return "unknown";
}

/** A whitespace-separated query where every term must appear somewhere. */
export function matchesQuery(query, ...parts) {
  if (!query) return true;
  const hay = parts.filter(Boolean).join(" ").toLowerCase();
  return String(query)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term));
}

export function matchesLocation(wanted, ...parts) {
  if (!wanted) return true;
  const hay = parts.filter(Boolean).join(" ").toLowerCase();
  return hay.includes(String(wanted).toLowerCase());
}

/**
 * Apply the opts every adapter honours, in one place: query, location, remote,
 * since. `since` filters on the posting date the board reported; the date is
 * not carried into the record because the record schema has no field for it.
 */
export function applyFilters(rows, opts = {}) {
  const cutoff = sinceMs(opts.since);
  return rows.filter((r) => {
    if (!matchesQuery(opts.query, r.role, r.company, r.text)) return false;
    if (!matchesLocation(opts.location, r.location, r.text)) return false;
    if (opts.remote === true && r.workplace_type !== "remote") return false;
    if (cutoff !== null) {
      const at = r.posted_at ? Date.parse(r.posted_at) : NaN;
      if (Number.isFinite(at) && at < cutoff) return false;
    }
    return true;
  });
}

/* --------------------------------------------------------------------- HTML */

const NAMED_ENTITIES = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  hellip: "...",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
};

export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => NAMED_ENTITIES[n.toLowerCase()] ?? m);
}

function safeCodePoint(n) {
  try {
    return String.fromCodePoint(n);
  } catch {
    return "";
  }
}

/**
 * Tags to text. This is not an HTML parser and does not pretend to be one: it
 * takes board-authored description HTML (a known shape: paragraphs, lists,
 * links) down to something a query can be run against. Nothing structural is
 * read back out of the result, so a malformed document costs us nothing worse
 * than an ugly string.
 */
export function stripHtml(html) {
  if (!html) return "";
  let s = String(html);
  // Greenhouse returns the description with its markup entity-encoded, so the
  // tags have to be decoded before they can be stripped. Decoding after would
  // leave "<p>" sitting in the text as visible characters.
  if (/&lt;\/?[a-z]/i.test(s)) s = decodeEntities(s);
  s = s
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<[^>]*>/g, " ");
  return collapse(decodeEntities(s).replace(/\n{2,}/g, "\n"));
}

/**
 * Every href in a fragment. Regex is acceptable here for the same reason: we
 * are extracting links from a known attribute shape, not parsing a document.
 */
export function extractLinks(html) {
  if (!html) return [];
  const out = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(String(html)))) {
    const href = decodeEntities(m[1]).trim();
    if (/^https?:\/\//i.test(href)) out.push(href);
  }
  return [...new Set(out)];
}

/**
 * Hosts that belong to a board, an aggregator or a social network rather than
 * to the employer. A link to one of these says nothing about who the company
 * is, so it must never become the domain an identity check trusts.
 */
export const THIRD_PARTY_HOSTS =
  /(greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|recruitee\.com|smartrecruiters\.com|myworkdayjobs\.com|workday(jobs)?\.com|jobvite\.com|breezy\.hr|teamtailor\.com|personio\.de|notion\.(so|site)|typeform\.com|docs\.google\.com|forms\.gle|linkedin\.com|angel\.co|wellfound\.com|ycombinator\.com|remoteok\.com|remotive\.com|arbeitnow\.com|himalayas\.app|indeed\.com|glassdoor\.com|github\.com|gitlab\.com|twitter\.com|x\.com|facebook\.com|bit\.ly|tinyurl\.com|gem\.com|rippling\.com|justjoin\.it|nofluffjobs\.com|pracuj\.pl)/i;

/** The first link that is plausibly the employer's own host, or null. */
export function companyDomainFromLinks(links) {
  for (const u of links ?? []) {
    if (!u || THIRD_PARTY_HOSTS.test(u)) continue;
    const d = normaliseDomain(u);
    if (d) return d;
  }
  return null;
}

/** Published email addresses in a blob of text or HTML. */
export function extractEmails(text) {
  if (!text) return [];
  const found = decodeEntities(String(text)).match(
    /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  );
  if (!found) return [];
  return [...new Set(found.map((e) => e.toLowerCase()))].filter(
    // Board boilerplate and image filenames that happen to look like addresses.
    (e) => !/(sentry|example\.com|@2x\.|\.png$|\.jpg$|\.svg$)/.test(e),
  );
}

/* --------------------------------------------------------------------- HTTP */

export const USER_AGENT =
  "career-kit/0.1 (open-source job search assistant; +https://github.com/career-kit/career-kit)";

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_RETRIES = 2;

/**
 * One GET, with a timeout, a small retry budget and a User-Agent that says who
 * we are. Returns a result object and only throws on a programming error, so
 * callers that need to score a miss (resolve-route) can read the status.
 */
export async function httpGet(url, opts = {}) {
  const {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    retries = DEFAULT_RETRIES,
    accept = "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
    headers = {},
    maxBytes = 4_000_000,
  } = opts;

  if (typeof globalThis.fetch !== "function") {
    throw new Error("career-kit: global fetch is missing. Node 20 or newer is required.");
  }

  let last = { ok: false, status: 0, url, text: "", error: "not attempted" };

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(300 * 2 ** (attempt - 1));
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        redirect: "follow",
        signal: ac.signal,
        headers: { "user-agent": USER_AGENT, accept, ...headers },
      });
      const raw = await res.text();
      const text = raw.length > maxBytes ? raw.slice(0, maxBytes) : raw;
      last = { ok: res.ok, status: res.status, url: res.url || url, text };
      // 429 and 5xx are worth another attempt. A 404 is an answer.
      if (res.ok || (res.status !== 429 && res.status < 500)) return last;
    } catch (e) {
      last = { ok: false, status: 0, url, text: "", error: String(e?.message ?? e) };
    } finally {
      clearTimeout(timer);
    }
  }
  return last;
}

/**
 * GET and parse JSON. Throws on anything that is not a 2xx with a JSON body,
 * because for an adapter that IS the schema-change alarm.
 */
export async function fetchJson(url, opts = {}) {
  const res = await httpGet(url, { accept: "application/json", ...opts });
  if (!res.ok) {
    const err = new Error(
      `career-kit: GET ${url} failed (HTTP ${res.status}${res.error ? `, ${res.error}` : ""})`,
    );
    err.status = res.status;
    err.url = url;
    throw err;
  }
  try {
    return JSON.parse(res.text);
  } catch (e) {
    throw new Error(
      `career-kit: GET ${url} returned ${res.text.length} bytes that are not JSON (${e.message}). ` +
        "The endpoint moved, or a proxy answered instead of the board.",
    );
  }
}

/** GET as text. Never throws: a dead host is a result, not an exception. */
export async function fetchText(url, opts = {}) {
  return httpGet(url, opts);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/* ------------------------------------------------------------------ opts io */

/**
 * `boards` accepts a bare slug or an object carrying what the slug cannot tell
 * us: the real company name and its domains.
 *
 * This matters more than it looks. A board token is not an identity. The Ashby
 * slug `nudge` belongs to a neurotech company and not to nudge.gs, and no
 * amount of reading the board tells you which one you meant. A caller that
 * knows passes domains; a caller that does not gets domains: [] and an
 * identity check that blocks.
 */
export function boardEntries(boards) {
  if (!boards) return [];
  const list = Array.isArray(boards) ? boards : [boards];
  return list
    .map((b) => (typeof b === "string" ? { slug: b } : { ...b }))
    .map((b) => ({
      slug: String(b.slug ?? b.token ?? b.id ?? b.company_id ?? "").trim(),
      company: b.company ?? null,
      company_id: b.company_id ?? null,
      domains: normaliseDomains(b.domains),
    }))
    .filter((b) => b.slug !== "");
}

/** A readable fallback company name when the board only gives us a slug. */
export function titleiseSlug(s) {
  return collapse(
    String(s)
      .replace(/[-_.]+/g, " ")
      .replace(/\b([a-z])/g, (m) => m.toUpperCase()),
  );
}
