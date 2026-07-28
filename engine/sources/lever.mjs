/**
 * Lever job boards.
 *
 *   list: https://api.lever.co/v0/postings/{company}?mode=json
 *   one:  https://api.lever.co/v0/postings/{company}/{id}?mode=json
 *
 * Lever is the friendliest of the six: it publishes `workplaceType` and a
 * structured `salaryRange`, so two fields that every other adapter has to infer
 * or leave null are simply read off the payload here.
 */

import {
  applyFilters,
  boardEntries,
  channelForSource,
  collapse,
  fetchJson as defaultFetchJson,
  normaliseAll,
  numOrNull,
  stripHtml,
  titleiseSlug,
  workplaceFromText,
} from "./index.mjs";

export const id = "lever";
export const kind = "public-json";

const API = "https://api.lever.co/v0/postings";

export function match(url) {
  if (!url) return false;
  return /^https?:\/\/(jobs|api)\.(eu\.)?lever\.co\//i.test(String(url));
}

export async function search(opts = {}, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const boards = boardEntries(opts.boards);
  if (boards.length === 0) {
    throw new Error(
      'sources/lever: search needs opts.boards, e.g. ["acme"] or ' +
        '[{ slug: "acme", company: "Acme", domains: ["acme.example"] }].',
    );
  }

  const rows = [];
  for (const board of boards) {
    const payload = await fetchJson(
      `${API}/${encodeURIComponent(board.slug)}?mode=json`,
    );
    for (const posting of listOf(payload, board.slug)) rows.push(row(posting, board));
  }

  return normaliseAll(applyFilters(rows, opts).map(toRecord));
}

export async function fetchOne(url, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const ref = parseUrl(url);
  if (!ref) return null;
  const payload = await fetchJson(
    `${API}/${encodeURIComponent(ref.company)}/${encodeURIComponent(ref.postingId)}?mode=json`,
  );
  const posting = Array.isArray(payload) ? payload[0] : payload;
  if (!posting || !posting.id) return null;
  const board = boardEntries([{ slug: ref.company, ...(deps.board ?? {}) }])[0];
  return normaliseAll([toRecord(row(posting, board))])[0];
}

function parseUrl(url) {
  const m = String(url ?? "").match(
    /^https?:\/\/(?:jobs|api)\.(?:eu\.)?lever\.co\/(?:v0\/postings\/)?([^/?#]+)(?:\/([0-9a-f-]{16,}))?/i,
  );
  if (!m) return null;
  return { company: m[1], postingId: m[2] ?? null };
}

function listOf(payload, slug) {
  if (Array.isArray(payload)) return payload;
  throw new Error(
    `sources/lever: expected an array of postings for ${slug}, got ` +
      `${payload === null ? "null" : typeof payload}.`,
  );
}

function row(posting, board) {
  const cats = posting.categories ?? {};
  const location =
    cats.location ??
    (Array.isArray(cats.allLocations) ? cats.allLocations.join(", ") : null) ??
    null;
  return {
    posting,
    board,
    text: stripHtml(posting.descriptionPlain ?? posting.description),
    location,
    role: posting.text,
    company: board.company ?? titleiseSlug(board.slug),
    posted_at: posting.createdAt ?? null,
    workplace_type: workplace(posting, location),
  };
}

/**
 * Lever's own `workplaceType` when it is set. It is authoritative: the company
 * picked it from a dropdown, which beats anything a regex reads off prose.
 */
function workplace(posting, location) {
  const declared = String(posting.workplaceType ?? "").toLowerCase();
  if (declared === "remote") return "remote";
  if (declared === "hybrid") return "hybrid";
  if (declared === "on-site" || declared === "onsite") return "onsite";
  return workplaceFromText(location, posting.text);
}

function toRecord({ posting, board, location, role, company, workplace_type }) {
  const target = posting.applyUrl ?? posting.hostedUrl ?? null;
  return {
    company,
    company_id: board.company_id ?? undefined,
    domains: board.domains,
    role,
    source: id,
    source_id: String(posting.id),
    url: posting.hostedUrl ?? target,
    apply: {
      channel: channelForSource(id),
      target,
      route_confidence: 0.95,
      identity_verified: false,
      identity_domain: null,
    },
    location,
    workplace_type,
    posted_comp: comp(posting),
    notes: note(posting),
  };
}

function comp(posting) {
  const r = posting.salaryRange;
  if (!r) return {};
  return {
    currency: r.currency ?? null,
    min: numOrNull(r.min),
    max: numOrNull(r.max),
    period: period(r.interval ?? posting.salaryDescription),
    equity: null,
  };
}

/** Lever intervals look like "per-year-salary" or "per-hour-wage". */
function period(interval) {
  const t = String(interval ?? "").toLowerCase();
  if (t.includes("year") || t.includes("annual")) return "year";
  if (t.includes("month")) return "month";
  if (t.includes("week")) return "week";
  if (t.includes("day")) return "day";
  if (t.includes("hour")) return "hour";
  return null;
}

function note(posting) {
  const cats = posting.categories ?? {};
  const bits = [cats.team, cats.department, cats.commitment].filter(Boolean);
  return bits.length ? collapse(bits.join(" | ")) : null;
}
