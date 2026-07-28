/**
 * Hacker News "Ask HN: Who is hiring?", via the public Algolia HN API.
 *
 *   thread:   https://hn.algolia.com/api/v1/search?query=Ask HN: Who is hiring&tags=story,author_whoishiring
 *   comments: https://hn.algolia.com/api/v1/search_by_date?tags=comment,story_{id}
 *
 * One top-level comment is one posting. This is the best source in the whole
 * set for founding-engineer roles at companies that have no ATS at all, and it
 * is also the messiest, because the format is a convention rather than a
 * schema. The convention is roughly:
 *
 *   Company | Role | Location | REMOTE | Full-time | $120k - $180k | url
 *
 * with the fields in any order, any subset, and sometimes no pipes at all.
 *
 * So the parse is deliberately tolerant: it classifies each segment by what it
 * looks like rather than by its position, and a comment it cannot pull a
 * company and a role out of is dropped rather than turned into a record with a
 * guessed company. Dropping is the honest failure here. A wrong company name on
 * an application is not a small error.
 */

import {
  applyFilters,
  channelForUrl,
  collapse,
  companyDomainFromLinks,
  decodeEntities,
  extractEmails,
  extractLinks,
  fetchJson as defaultFetchJson,
  normaliseAll,
  normaliseDomain,
  seniorityFromTitle,
  stripHtml,
  workplaceFromText,
} from "./index.mjs";

export const id = "hn";
export const kind = "public-json";

const ALGOLIA = "https://hn.algolia.com/api/v1";
const PAGE = 500;
const MAX_PAGES = 10; // 5000 comments. The biggest threads run to about 800.

export function match(url) {
  if (!url) return false;
  return /^https?:\/\/news\.ycombinator\.com\/item\?id=\d+/i.test(String(url));
}

/**
 * opts.storyId pins a specific monthly thread. opts.threads (default 1) says
 * how many of the most recent threads to read when no id is given.
 */
export async function search(opts = {}, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;

  const storyIds = opts.storyId
    ? [String(opts.storyId)]
    : (await recentThreads(fetchJson, opts.threads ?? 1)).map((s) => s.id);

  if (storyIds.length === 0) {
    throw new Error(
      "sources/hn: no 'Who is hiring' thread found. The Algolia index or the " +
        "whoishiring account changed shape; this is not the same as a quiet month.",
    );
  }

  const rows = [];
  for (const storyId of storyIds) {
    for (const comment of await topLevelComments(storyId, fetchJson)) {
      const parsed = parseComment(comment);
      if (parsed) rows.push(parsed);
    }
  }

  return normaliseAll(applyFilters(rows, opts).map(toRecord));
}

export async function fetchOne(url, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const m = String(url ?? "").match(/id=(\d+)/);
  if (!m) return null;
  const item = await fetchJson(`${ALGOLIA}/items/${m[1]}`);
  if (!item || !item.id) return null;
  const parsed = parseComment({
    objectID: String(item.id),
    comment_text: item.text ?? "",
    author: item.author ?? null,
    created_at: item.created_at ?? null,
  });
  return parsed ? normaliseAll([toRecord(parsed)])[0] : null;
}

/* ------------------------------------------------------------------ fetching */

async function recentThreads(fetchJson, count) {
  const payload = await fetchJson(
    `${ALGOLIA}/search?query=${encodeURIComponent("Ask HN: Who is hiring")}` +
      "&tags=story,author_whoishiring&hitsPerPage=20",
  );
  if (!Array.isArray(payload?.hits)) {
    throw new Error(
      "sources/hn: thread search returned no hits[]. " +
        `Got keys: ${Object.keys(payload ?? {}).join(", ") || "(none)"}`,
    );
  }
  return payload.hits
    // "Who wants to be hired?" and the freelancer thread share the account.
    .filter((h) => /who is hiring/i.test(String(h.title ?? "")))
    .map((h) => ({
      id: String(h.objectID),
      title: h.title,
      created_at: h.created_at ?? null,
    }))
    .sort((a, b) => Date.parse(b.created_at ?? 0) - Date.parse(a.created_at ?? 0))
    .slice(0, Math.max(1, Number(count) || 1));
}

async function topLevelComments(storyId, fetchJson) {
  const out = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const payload = await fetchJson(
      `${ALGOLIA}/search_by_date?tags=comment,story_${encodeURIComponent(storyId)}` +
        `&hitsPerPage=${PAGE}&page=${page}`,
    );
    if (!Array.isArray(payload?.hits)) {
      throw new Error(
        `sources/hn: comment search for story ${storyId} returned no hits[]. ` +
          `Got keys: ${Object.keys(payload ?? {}).join(", ") || "(none)"}`,
      );
    }
    // A reply to a posting is not a posting. Top level means the parent is the
    // thread itself.
    out.push(
      ...payload.hits.filter(
        (h) => String(h.parent_id ?? "") === String(h.story_id ?? storyId),
      ),
    );
    const pages = Number(payload.nbPages ?? 1);
    if (payload.hits.length < PAGE || page + 1 >= pages) break;
  }
  return out;
}

/* -------------------------------------------------------------------- parse */

const ROLE_WORDS =
  /\b(engineer|engineering|developer|dev|programmer|architect|sre|devops|scientist|researcher|designer|manager|lead|founding|cto|analyst|hacker|full[- ]?stack|frontend|front[- ]end|backend|back[- ]end|infrastructure|platform|security|data|mobile|ios|android|qa|intern)\b/i;

const TYPE_WORDS =
  /^\s*(full[- ]?time|part[- ]?time|contract|contractor|freelance|internship|intern|permanent|fte|w2|c2c)\s*$/i;

const PLACE_HINT =
  /\b(remote|onsite|on[- ]site|hybrid|anywhere|usa?|uk|eu|emea|apac|worldwide|global|[a-z]+,\s*[a-z]{2,})\b/i;

const COMP_RE = new RegExp(
  // "$120k - $180k", "120K-180K USD", "EUR 80.000 - 110.000", "£90,000"
  "(?:(usd|eur|gbp|pln|chf|cad|aud)\\s*)?" +
    "([$\\u20ac\\u00a3])?\\s*(\\d{2,3}(?:[.,]\\d{3})?)\\s*(k\\b)?" +
    "\\s*(?:[-\\u2013\\u2014]|to)\\s*" +
    "(?:(usd|eur|gbp|pln|chf|cad|aud)\\s*)?" +
    "([$\\u20ac\\u00a3])?\\s*(\\d{2,3}(?:[.,]\\d{3})?)\\s*(k\\b)?" +
    "\\s*(usd|eur|gbp|pln|chf|cad|aud)?",
  "i",
);

export function parseComment(hit) {
  const html = String(hit?.comment_text ?? "");
  if (!html) return null;

  const text = stripHtml(html);
  if (!text) return null;

  // Paragraph one. Algolia leaves the first paragraph unwrapped and starts
  // every later one with <p>, so splitting on the tag is a reliable cut for
  // this payload shape and nothing structural is read back out.
  const header = stripHtml(html.split(/<\s*p\s*>/i)[0]);
  const segments = header.split("|").map((s) => collapse(s)).filter(Boolean);

  const parsed =
    segments.length > 1 ? fromSegments(segments) : fromProse(header, text);
  if (!parsed || !parsed.company || !parsed.role) return null;

  const links = extractLinks(html);
  const emails = extractEmails(text);

  return {
    ...parsed,
    hit,
    text,
    links,
    emails,
    posted_at: hit.created_at ?? null,
    workplace_type: workplaceFromText(parsed.location, header, text.slice(0, 300)),
    posted_comp: comp(header) ?? comp(text) ?? {},
  };
}

/** The pipe-delimited convention, classified by shape rather than by position. */
function fromSegments(segments) {
  const company = cleanCompany(segments[0]);
  const rest = segments.slice(1);

  const roleIdx = rest.findIndex((s) => ROLE_WORDS.test(s) && !TYPE_WORDS.test(s));
  const role = roleIdx >= 0 ? cleanRole(rest[roleIdx]) : null;

  const location =
    rest.find(
      (s, i) =>
        i !== roleIdx &&
        !TYPE_WORDS.test(s) &&
        !COMP_RE.test(s) &&
        !/^https?:\/\//i.test(s) &&
        PLACE_HINT.test(s),
    ) ?? null;

  return { company, role, location };
}

/**
 * No pipes. Pull the company out of an "X is hiring" opener and the role out of
 * the first line carrying a role word. Anything less certain than that returns
 * null and the comment is dropped.
 */
function fromProse(header, text) {
  const hiring = header.match(
    /^(.{2,60}?)\s+(?:is|are|is currently|we are|we're)?\s*(?:hiring|looking for|seeking)/i,
  );
  const yc = header.match(/^(.{2,60}?)\s*\((?:YC\s*[SWF]\d{2})\)/i);
  const company = cleanCompany(yc?.[1] ?? hiring?.[1] ?? "");
  if (!company) return null;

  // "hiring a Senior Infrastructure Engineer to own ..." gives up the title if
  // you stop at the preposition that follows it.
  const phrase = text.match(
    /\b(?:hiring|looking for|seeking|need)\s+(?:an?\s+|our\s+|some\s+)?([A-Za-z][A-Za-z0-9/&+.\- ]{2,60}?)(?=\s+(?:to|who|that|with|in|at|for|based|on)\b|[.,;:!?]|$)/i,
  );
  const candidate = phrase && ROLE_WORDS.test(phrase[1]) ? phrase[1] : null;

  const line = text
    .split(/[\n.]/)
    .map((s) => collapse(s))
    .find((s) => s && ROLE_WORDS.test(s) && s.length < 120);

  const role = candidate ?? line ?? null;
  return { company, role: role ? cleanRole(role) : null, location: null };
}

function cleanCompany(s) {
  const t = collapse(decodeEntities(String(s ?? "")))
    .replace(/\((?:YC\s*[SWF]?\d{2}[^)]*)\)/gi, "")
    .replace(/^[\s>*_-]+|[\s*_:-]+$/g, "")
    .replace(/\s+(is|are)\s+hiring.*$/i, "")
    .replace(/^https?:\/\/\S+\s*/i, "");
  if (!t || t.length > 70) return null;
  // A first segment that is only a location or only a role is a comment that
  // does not follow the convention at all.
  if (TYPE_WORDS.test(t)) return null;
  return t;
}

function cleanRole(s) {
  const t = collapse(String(s ?? ""))
    .replace(/^(we(?:'re| are)?\s+(?:hiring|looking for|seeking)\s*(?:an?\s+)?)/i, "")
    .replace(/[.;,]+$/, "");
  return t && t.length <= 120 ? t : null;
}

function comp(text) {
  const m = COMP_RE.exec(String(text));
  if (!m) return null;
  const [, cur1, sym1, n1, k1, cur2, sym2, n2, k2, curTail] = m;
  const currency =
    code(cur1) ?? symbol(sym1) ?? code(cur2) ?? symbol(sym2) ?? code(curTail) ?? null;
  const min = amount(n1, k1);
  const max = amount(n2, k2);
  if (min === null || max === null || max < min) return null;
  // A "80 - 110" with no currency and no k is a headcount or a date range.
  if (!currency && !k1 && !k2 && min < 1000) return null;
  return { currency, min, max, period: "year", equity: null };
}

function amount(n, k) {
  if (!n) return null;
  const raw = Number(String(n).replace(/[.,]/g, ""));
  if (!Number.isFinite(raw)) return null;
  return k ? raw * 1000 : raw;
}

function code(c) {
  return c ? String(c).toUpperCase() : null;
}

function symbol(s) {
  if (s === "$") return "USD";
  if (s === "€") return "EUR";
  if (s === "£") return "GBP";
  return null;
}

/* ------------------------------------------------------------------- record */

function toRecord(p) {
  const permalink = `https://news.ycombinator.com/item?id=${p.hit.objectID}`;
  const route = pickRoute(p);
  return {
    company: p.company,
    domains: route.domain ? [route.domain] : [],
    role: p.role,
    seniority: seniorityFromTitle(p.role),
    source: id,
    source_id: String(p.hit.objectID),
    url: permalink,
    apply: {
      channel: route.channel,
      target: route.target,
      route_confidence: route.confidence,
      identity_verified: false,
      identity_domain: null,
    },
    location: p.location,
    workplace_type: p.workplace_type,
    posted_comp: p.posted_comp,
    notes: p.hit.author ? `Posted by HN user ${p.hit.author}.` : null,
    evidence: [
      {
        at: p.posted_at,
        kind: "route",
        text: route.why,
      },
    ],
  };
}

/**
 * An ATS link beats a company page beats an email beats nothing. Confidence
 * stays below the ATS adapters throughout, because here the link was typed by a
 * person claiming to work somewhere, not published by the company's own board.
 */
function pickRoute(p) {
  const links = p.links.filter((u) => !/news\.ycombinator\.com/i.test(u));
  const ats = links.find((u) => channelForUrl(u));
  if (ats) {
    return {
      channel: channelForUrl(ats),
      target: ats,
      confidence: 0.8,
      domain: companyDomainFromLinks(links),
      why: `Apply link posted in the HN comment points at an ATS board: ${ats}`,
    };
  }
  if (p.emails.length) {
    return {
      channel: "email",
      target: `mailto:${p.emails[0]}`,
      confidence: 0.65,
      domain: normaliseDomain(p.emails[0].split("@")[1]),
      why: `Address published in the HN comment: ${p.emails[0]}`,
    };
  }
  if (links.length) {
    return {
      channel: "form",
      target: links[0],
      confidence: 0.55,
      domain: companyDomainFromLinks(links),
      why: `Link posted in the HN comment, destination not an ATS: ${links[0]}`,
    };
  }
  return {
    channel: "none",
    target: null,
    confidence: 0,
    domain: null,
    why: "Comment names no link and no address. The route has to be resolved from the company site.",
  };
}
