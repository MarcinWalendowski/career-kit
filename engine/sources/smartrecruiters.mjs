/**
 * SmartRecruiters job boards.
 *
 *   list: https://api.smartrecruiters.com/v1/companies/{id}/postings?offset=&limit=100
 *   one:  https://api.smartrecruiters.com/v1/companies/{id}/postings/{postingId}
 *
 * The only paginated source in the tier. The list endpoint reports totalFound
 * and takes offset/limit; we follow to exhaustion behind a hard page cap, so a
 * board that reports a wrong total cannot spin this into an infinite loop.
 *
 * The list rows carry no description. Location, department and type are enough
 * for triage; a query that needs the body should call fetchOne on the shortlist.
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

export const id = "smartrecruiters";
export const kind = "public-json";

const API = "https://api.smartrecruiters.com/v1/companies";
const PAGE = 100;
const MAX_PAGES = 20; // 2000 postings. Past that, the query is the problem.

export function match(url) {
  if (!url) return false;
  return /^https?:\/\/(jobs|careers|api)\.smartrecruiters\.com\//i.test(String(url));
}

export async function search(opts = {}, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const boards = boardEntries(opts.boards);
  if (boards.length === 0) {
    throw new Error(
      'sources/smartrecruiters: search needs opts.boards, e.g. ["AcmeInc"] or ' +
        '[{ slug: "AcmeInc", company: "Acme", domains: ["acme.example"] }].',
    );
  }

  const rows = [];
  for (const board of boards) {
    for (const posting of await allPostings(board.slug, fetchJson)) {
      rows.push(row(posting, board));
    }
  }

  return normaliseAll(applyFilters(rows, opts).map(toRecord));
}

async function allPostings(slug, fetchJson) {
  const out = [];
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const payload = await fetchJson(
      `${API}/${encodeURIComponent(slug)}/postings?offset=${offset}&limit=${PAGE}`,
    );
    const content = listOf(payload, slug);
    out.push(...content);

    const total = numOrNull(payload.totalFound);
    offset += content.length || PAGE;
    // Stop on a short page, on reaching the reported total, or on a page that
    // returned nothing. Any one of the three is enough; needing all three is
    // how a paginator hangs on a board that lies about its own count.
    if (content.length < PAGE) break;
    if (total !== null && offset >= total) break;
    if (content.length === 0) break;
  }
  return out;
}

export async function fetchOne(url, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const ref = parseUrl(url);
  if (!ref || !ref.postingId) return null;
  const posting = await fetchJson(
    `${API}/${encodeURIComponent(ref.company)}/postings/${encodeURIComponent(ref.postingId)}`,
  );
  if (!posting || !posting.id) return null;
  const board = boardEntries([{ slug: ref.company, ...(deps.board ?? {}) }])[0];
  return normaliseAll([toRecord(row(posting, board))])[0];
}

/** jobs.smartrecruiters.com/{company}/{postingId}-{slug} */
function parseUrl(url) {
  const m = String(url ?? "").match(
    /^https?:\/\/(?:jobs|careers)\.smartrecruiters\.com\/([^/?#]+)\/(\d+)/i,
  );
  if (m) return { company: m[1], postingId: m[2] };
  const api = String(url ?? "").match(
    /^https?:\/\/api\.smartrecruiters\.com\/v1\/companies\/([^/?#]+)\/postings\/([^/?#]+)/i,
  );
  return api ? { company: api[1], postingId: api[2] } : null;
}

function listOf(payload, slug) {
  if (Array.isArray(payload?.content)) return payload.content;
  throw new Error(
    `sources/smartrecruiters: board ${slug} returned no content[]. ` +
      `Got keys: ${Object.keys(payload ?? {}).join(", ") || "(none)"}`,
  );
}

function row(posting, board) {
  const location = place(posting.location);
  const description = sections(posting);
  return {
    posting,
    board,
    text: description,
    location,
    role: posting.name,
    company: board.company ?? posting.company?.name ?? titleiseSlug(board.slug),
    posted_at: posting.releasedDate ?? posting.createdOn ?? null,
    workplace_type:
      posting.location?.remote === true
        ? "remote"
        : workplaceFromText(location, posting.name, description.slice(0, 400)),
  };
}

function place(loc) {
  if (!loc) return null;
  const bits = [loc.city, loc.region, loc.country].filter(Boolean);
  return bits.length ? collapse(bits.join(", ")) : null;
}

/** Only the detail endpoint carries jobAd.sections; the list rows do not. */
function sections(posting) {
  const s = posting.jobAd?.sections;
  if (!s) return "";
  return stripHtml(
    [s.companyDescription?.text, s.jobDescription?.text, s.qualifications?.text]
      .filter(Boolean)
      .join(" "),
  );
}

function toRecord({ posting, board, location, role, company, workplace_type }) {
  // The public apply page. The API `ref` is an api.smartrecruiters.com URL and
  // is not something a human can apply through, so it never becomes the target.
  const url = `https://jobs.smartrecruiters.com/${encodeURIComponent(
    posting.company?.identifier ?? board.slug,
  )}/${encodeURIComponent(posting.id)}`;
  return {
    company,
    company_id: board.company_id ?? undefined,
    domains: board.domains,
    role,
    source: id,
    source_id: String(posting.id),
    url,
    apply: {
      channel: channelForSource(id),
      target: url,
      route_confidence: 0.95,
      identity_verified: false,
      identity_domain: null,
    },
    location,
    workplace_type,
    posted_comp: {},
    notes: note(posting),
  };
}

function note(posting) {
  const bits = [
    posting.department?.label,
    posting.function?.label,
    posting.typeOfEmployment?.label,
    posting.experienceLevel?.label,
  ].filter(Boolean);
  return bits.length ? collapse(bits.join(" | ")) : null;
}
