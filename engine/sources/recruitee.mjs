/**
 * Recruitee job boards.
 *
 *   list: https://{company}.recruitee.com/api/offers/
 *   one:  https://{company}.recruitee.com/api/offers/{slug}
 *
 * Per-company subdomain, so the board slug is also the hostname. The payload
 * carries the description and requirements as HTML and a `remote` boolean.
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

export const id = "recruitee";
export const kind = "public-json";

export function match(url) {
  if (!url) return false;
  return /^https?:\/\/[a-z0-9-]+\.recruitee\.com\//i.test(String(url));
}

export async function search(opts = {}, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const boards = boardEntries(opts.boards);
  if (boards.length === 0) {
    throw new Error(
      'sources/recruitee: search needs opts.boards, e.g. ["acme"] or ' +
        '[{ slug: "acme", company: "Acme", domains: ["acme.example"] }].',
    );
  }

  const rows = [];
  for (const board of boards) {
    const payload = await fetchJson(`https://${host(board.slug)}/api/offers/`);
    for (const offer of listOf(payload, board.slug)) rows.push(row(offer, board));
  }

  return normaliseAll(applyFilters(rows, opts).map(toRecord));
}

export async function fetchOne(url, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const ref = parseUrl(url);
  if (!ref || !ref.slug) return null;
  const payload = await fetchJson(
    `https://${host(ref.company)}/api/offers/${encodeURIComponent(ref.slug)}`,
  );
  const offer = payload?.offer ?? payload;
  if (!offer || !offer.id) return null;
  const board = boardEntries([{ slug: ref.company, ...(deps.board ?? {}) }])[0];
  return normaliseAll([toRecord(row(offer, board))])[0];
}

function host(slug) {
  return `${String(slug).replace(/[^a-z0-9-]/gi, "").toLowerCase()}.recruitee.com`;
}

/** {company}.recruitee.com/o/{slug} is the public posting URL. */
function parseUrl(url) {
  const m = String(url ?? "").match(
    /^https?:\/\/([a-z0-9-]+)\.recruitee\.com\/(?:o|api\/offers)\/([^/?#]+)/i,
  );
  return m ? { company: m[1], slug: m[2] } : null;
}

function listOf(payload, slug) {
  if (Array.isArray(payload?.offers)) return payload.offers;
  throw new Error(
    `sources/recruitee: board ${slug} returned no offers[]. ` +
      `Got keys: ${Object.keys(payload ?? {}).join(", ") || "(none)"}`,
  );
}

function row(offer, board) {
  const location = place(offer);
  const text = stripHtml([offer.description, offer.requirements].filter(Boolean).join(" "));
  return {
    offer,
    board,
    text,
    location,
    role: offer.title ?? offer.position,
    company: board.company ?? offer.company_name ?? titleiseSlug(board.slug),
    posted_at: offer.published_at ?? offer.created_at ?? null,
    workplace_type:
      offer.remote === true
        ? "remote"
        : workplaceFromText(location, offer.title, text.slice(0, 400)),
  };
}

function place(offer) {
  if (offer.location) return collapse(offer.location);
  const bits = [offer.city, offer.state_code ?? offer.state, offer.country].filter(Boolean);
  return bits.length ? collapse(bits.join(", ")) : null;
}

function toRecord({ offer, board, location, role, company, workplace_type }) {
  const target =
    offer.careers_apply_url ?? offer.careers_url ?? offer.url ?? publicUrl(offer, board);
  return {
    company,
    company_id: board.company_id ?? undefined,
    domains: board.domains,
    role,
    source: id,
    source_id: String(offer.id),
    url: offer.careers_url ?? publicUrl(offer, board),
    apply: {
      channel: channelForSource(id),
      target,
      route_confidence: 0.95,
      identity_verified: false,
      identity_domain: null,
    },
    location,
    workplace_type,
    posted_comp: comp(offer),
    notes: note(offer),
  };
}

function publicUrl(offer, board) {
  return `https://${host(board.slug)}/o/${offer.slug ?? offer.id}`;
}

/**
 * Recruitee exposes a band only when the board turns it on, and the field names
 * differ between accounts. Two named fields, no inference from prose.
 */
function comp(offer) {
  const min = numOrNull(offer.salary?.min ?? offer.min_salary);
  const max = numOrNull(offer.salary?.max ?? offer.max_salary);
  if (min === null && max === null) return {};
  return {
    currency: offer.salary?.currency ?? offer.currency ?? null,
    min,
    max,
    period: period(offer.salary?.period ?? offer.salary_period),
    equity: null,
  };
}

function period(p) {
  const t = String(p ?? "").toLowerCase();
  if (t.includes("year") || t.includes("annual")) return "year";
  if (t.includes("month")) return "month";
  if (t.includes("week")) return "week";
  if (t.includes("day")) return "day";
  if (t.includes("hour")) return "hour";
  return null;
}

function note(offer) {
  const bits = [offer.department, offer.employment_type_code, offer.experience_code].filter(
    Boolean,
  );
  return bits.length ? collapse(bits.join(" | ")) : null;
}
