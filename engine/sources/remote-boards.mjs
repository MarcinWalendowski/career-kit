/**
 * The four public remote-job aggregators, behind one adapter.
 *
 *   remoteok   https://remoteok.com/api
 *   remotive   https://remotive.com/api/remote-jobs
 *   arbeitnow  https://www.arbeitnow.com/api/job-board-api
 *   himalayas  https://himalayas.app/jobs/api
 *
 * `opts.boards` selects a subset, e.g. { boards: ["remoteok", "himalayas"] }.
 * Default is all four.
 *
 * Each record's `source` is the specific board it came from, not
 * "remote-boards". Per-source rate limits in rules.yaml are the reason: one
 * bucket for four boards would quietly multiply a cap by four.
 *
 * Two things are true of every aggregator here and are reflected in the
 * confidence they get. The listing is a copy, so it can be stale or edited. The
 * apply link is frequently a redirect through the aggregator rather than the
 * employer's own form. Neither is a reason not to read them; both are a reason
 * they never score like a board API.
 */

import {
  applyFilters,
  channelForUrl,
  collapse,
  companyDomainFromLinks,
  fetchJson as defaultFetchJson,
  normaliseAll,
  numOrNull,
  seniorityFromTitle,
  stripHtml,
  workplaceFromText,
} from "./index.mjs";

export const id = "remote-boards";
export const kind = "public-json";

export const BOARDS = {
  remoteok: {
    url: "https://remoteok.com/api",
    host: /^https?:\/\/(www\.)?remoteok\.(com|io)\//i,
    list: (p) => arrayOf(p, "remoteok").filter((j) => j && (j.id || j.slug) && j.position),
    row: remoteok,
  },
  remotive: {
    url: "https://remotive.com/api/remote-jobs",
    host: /^https?:\/\/(www\.)?remotive\.com\//i,
    list: (p) => keyedOf(p, "jobs", "remotive"),
    row: remotive,
  },
  arbeitnow: {
    url: "https://www.arbeitnow.com/api/job-board-api",
    host: /^https?:\/\/(www\.)?arbeitnow\.com\//i,
    list: (p) => keyedOf(p, "data", "arbeitnow"),
    row: arbeitnow,
  },
  himalayas: {
    url: "https://himalayas.app/jobs/api",
    host: /^https?:\/\/(www\.)?himalayas\.app\//i,
    list: (p) => keyedOf(p, "jobs", "himalayas"),
    row: himalayas,
  },
};

export function match(url) {
  if (!url) return false;
  return Object.values(BOARDS).some((b) => b.host.test(String(url)));
}

export async function search(opts = {}, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const wanted = selected(opts.boards);

  const rows = [];
  for (const name of wanted) {
    const board = BOARDS[name];
    const payload = await fetchJson(board.url);
    for (const job of board.list(payload)) {
      const r = board.row(job);
      if (r) rows.push(r);
    }
  }

  return normaliseAll(applyFilters(rows, opts).map(toRecord));
}

export async function fetchOne(url, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const name = Object.keys(BOARDS).find((k) => BOARDS[k].host.test(String(url ?? "")));
  if (!name) return null;

  // None of the four publishes a per-posting endpoint, so the whole board is
  // pulled and the row is picked out of it. One request either way.
  const board = BOARDS[name];
  const payload = await fetchJson(board.url);
  const target = String(url).replace(/[/?#].*$/, "").toLowerCase();
  for (const job of board.list(payload)) {
    const r = board.row(job);
    if (!r) continue;
    const candidate = String(r.url ?? "").toLowerCase();
    if (candidate === String(url).toLowerCase() || candidate.startsWith(target)) {
      return normaliseAll([toRecord(r)])[0];
    }
  }
  return null;
}

function selected(boards) {
  const names = boards
    ? (Array.isArray(boards) ? boards : [boards]).map((b) =>
        String(typeof b === "string" ? b : b.slug ?? b.id ?? "").toLowerCase(),
      )
    : Object.keys(BOARDS);
  const unknown = names.filter((n) => !BOARDS[n]);
  if (unknown.length) {
    throw new Error(
      `sources/remote-boards: unknown board(s) ${unknown.join(", ")}. ` +
        `Known: ${Object.keys(BOARDS).join(", ")}.`,
    );
  }
  return names;
}

/* ------------------------------------------------------- per-board readers */

function arrayOf(payload, name) {
  if (!Array.isArray(payload)) {
    throw new Error(
      `sources/remote-boards: ${name} returned ${
        payload === null ? "null" : typeof payload
      }, expected an array.`,
    );
  }
  return payload;
}

function keyedOf(payload, key, name) {
  if (!Array.isArray(payload?.[key])) {
    throw new Error(
      `sources/remote-boards: ${name} returned no ${key}[]. ` +
        `Got keys: ${Object.keys(payload ?? {}).join(", ") || "(none)"}`,
    );
  }
  return payload[key];
}

/** RemoteOK. Element 0 of the array is a legal notice object, not a job. */
function remoteok(job) {
  if (!job.company || !job.position) return null;
  const text = stripHtml(job.description);
  return {
    source: "remoteok",
    source_id: String(job.id ?? job.slug),
    company: job.company,
    role: job.position,
    url: job.url ?? `https://remoteok.com/remote-jobs/${job.slug ?? job.id}`,
    target: job.apply_url ?? job.url ?? null,
    location: collapse(job.location ?? "") || null,
    // A board that only lists remote roles is telling us the workplace type.
    workplace_type: "remote",
    posted_at: job.date ?? (job.epoch ? new Date(job.epoch * 1000).toISOString() : null),
    text,
    comp: band(job.salary_min, job.salary_max, "USD"),
    notes: tags(job.tags),
  };
}

function remotive(job) {
  if (!job.company_name || !job.title) return null;
  const text = stripHtml(job.description);
  return {
    source: "remotive",
    source_id: String(job.id),
    company: job.company_name,
    role: job.title,
    url: job.url ?? null,
    target: job.url ?? null,
    location: collapse(job.candidate_required_location ?? "") || null,
    workplace_type: "remote",
    posted_at: job.publication_date ?? null,
    text,
    // `salary` is free text on this board ("$50,000 - $70,000", "Up to 120k",
    // sometimes ""). Parsed when it is unambiguous, null when it is not.
    comp: parseSalaryText(job.salary),
    notes: [job.category, job.job_type].filter(Boolean).join(" | ") || null,
  };
}

function arbeitnow(job) {
  if (!job.company_name || !job.title) return null;
  const text = stripHtml(job.description);
  return {
    source: "arbeitnow",
    source_id: String(job.slug),
    company: job.company_name,
    role: job.title,
    url: job.url ?? `https://www.arbeitnow.com/jobs/companies/${job.slug}`,
    target: job.url ?? null,
    location: collapse(job.location ?? "") || null,
    workplace_type:
      job.remote === true ? "remote" : workplaceFromText(job.location, text.slice(0, 300)),
    posted_at: job.created_at ? new Date(Number(job.created_at) * 1000).toISOString() : null,
    text,
    // No salary fields in this API at all.
    comp: {},
    notes: tags([...(job.tags ?? []), ...(job.job_types ?? [])]),
  };
}

function himalayas(job) {
  if (!job.companyName || !job.title) return null;
  const text = stripHtml(job.description ?? job.excerpt);
  return {
    source: "himalayas",
    source_id: String(job.guid ?? job.applicationLink ?? job.title),
    company: job.companyName,
    role: job.title,
    url: job.applicationLink ?? null,
    target: job.applicationLink ?? null,
    location: Array.isArray(job.locationRestrictions) && job.locationRestrictions.length
      ? collapse(job.locationRestrictions.join(", "))
      : null,
    workplace_type: "remote",
    posted_at: job.pubDate ? new Date(Number(job.pubDate) * 1000).toISOString() : null,
    text,
    comp: band(job.minSalary, job.maxSalary, "USD"),
    seniority: himalayasSeniority(job.seniority) ?? seniorityFromTitle(job.title),
    notes: tags(job.categories),
  };
}

function himalayasSeniority(list) {
  const first = String(Array.isArray(list) ? list[0] ?? "" : list ?? "").toLowerCase();
  if (/entry|junior/.test(first)) return "junior";
  if (/^mid/.test(first)) return "mid";
  if (/senior/.test(first)) return "senior";
  if (/staff/.test(first)) return "staff";
  if (/principal|lead/.test(first)) return "principal";
  if (/intern/.test(first)) return "intern";
  if (/exec|director|vp|head/.test(first)) return "executive";
  return null;
}

/* ------------------------------------------------------------------ helpers */

/** A numeric band, or {} when the board reports 0 or nothing. Zero is not a salary. */
function band(min, max, currency) {
  const lo = numOrNull(min);
  const hi = numOrNull(max);
  if (!lo && !hi) return {};
  return { currency, min: lo || null, max: hi || null, period: "year", equity: null };
}

const SALARY_TEXT = new RegExp(
  "([$\\u20ac\\u00a3])?\\s*(\\d{1,3}(?:[.,]\\d{3})*|\\d{2,3})\\s*(k)?" +
    "\\s*(?:[-\\u2013\\u2014]|to)\\s*" +
    "([$\\u20ac\\u00a3])?\\s*(\\d{1,3}(?:[.,]\\d{3})*|\\d{2,3})\\s*(k)?",
  "i",
);

function parseSalaryText(s) {
  if (!s) return {};
  const m = SALARY_TEXT.exec(String(s));
  if (!m) return {};
  const [, sym1, n1, k1, sym2, n2, k2] = m;
  const min = amount(n1, k1);
  const max = amount(n2, k2);
  if (min === null || max === null || max < min) return {};
  const currency = symbol(sym1) ?? symbol(sym2) ?? (/usd/i.test(s) ? "USD" : null);
  // Two bare two-digit numbers are an hours range or a percentage, not pay.
  if (!currency && min < 1000) return {};
  return { currency, min, max, period: "year", equity: null };
}

function amount(n, k) {
  if (!n) return null;
  const raw = Number(String(n).replace(/[.,]/g, ""));
  if (!Number.isFinite(raw)) return null;
  return k ? raw * 1000 : raw;
}

function symbol(s) {
  if (s === "$") return "USD";
  if (s === "€") return "EUR";
  if (s === "£") return "GBP";
  return null;
}

function tags(list) {
  if (!Array.isArray(list) || list.length === 0) return null;
  return collapse(list.filter(Boolean).slice(0, 8).join(", ")) || null;
}

/* ------------------------------------------------------------------- record */

function toRecord(r) {
  const target = r.target ?? r.url;
  const ats = channelForUrl(target);
  const domain = companyDomainFromLinks([target, r.url]);
  return {
    company: r.company,
    domains: domain ? [domain] : [],
    role: r.role,
    seniority: r.seniority !== undefined ? r.seniority : undefined,
    source: r.source,
    source_id: r.source_id,
    url: r.url ?? target,
    apply: {
      channel: ats ?? "form",
      target,
      // An aggregator's copy of a posting, reached through the aggregator's own
      // link. Good enough to open, not good enough to submit against blind.
      route_confidence: ats ? 0.7 : 0.6,
      identity_verified: false,
      identity_domain: null,
    },
    location: r.location,
    workplace_type: r.workplace_type,
    posted_comp: r.comp,
    notes: r.notes,
    evidence: [
      {
        at: r.posted_at,
        kind: "route",
        text:
          `Listed on ${r.source}, an aggregator. The posting is a copy: confirm it is still open ` +
          "on the employer's own site before applying.",
      },
    ],
  };
}
