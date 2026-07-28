/**
 * Workable job boards.
 *
 *   list: https://apply.workable.com/api/v1/widget/accounts/{slug}
 *   one:  https://apply.workable.com/api/v1/widget/accounts/{slug}?job={shortcode}
 *
 * The widget endpoint that powers the embedded careers iframe. It returns the
 * account name, which is the one place in the tier where the board tells us the
 * company's own name rather than making us title-case a slug.
 */

import {
  applyFilters,
  boardEntries,
  channelForSource,
  collapse,
  fetchJson as defaultFetchJson,
  normaliseAll,
  stripHtml,
  titleiseSlug,
  workplaceFromText,
} from "./index.mjs";

export const id = "workable";
export const kind = "public-json";

const API = "https://apply.workable.com/api/v1/widget/accounts";

export function match(url) {
  if (!url) return false;
  return /^https?:\/\/(apply\.workable\.com|[a-z0-9-]+\.workable\.com)\//i.test(String(url));
}

export async function search(opts = {}, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const boards = boardEntries(opts.boards);
  if (boards.length === 0) {
    throw new Error(
      'sources/workable: search needs opts.boards, e.g. ["acme"] or ' +
        '[{ slug: "acme", company: "Acme", domains: ["acme.example"] }].',
    );
  }

  const rows = [];
  for (const board of boards) {
    const payload = await fetchJson(`${API}/${encodeURIComponent(board.slug)}`);
    for (const job of listOf(payload, board.slug)) rows.push(row(job, board, payload));
  }

  return normaliseAll(applyFilters(rows, opts).map(toRecord));
}

export async function fetchOne(url, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const ref = parseUrl(url);
  if (!ref) return null;
  const payload = await fetchJson(
    `${API}/${encodeURIComponent(ref.slug)}${
      ref.shortcode ? `?job=${encodeURIComponent(ref.shortcode)}` : ""
    }`,
  );
  const jobs = listOf(payload, ref.slug);
  const job = ref.shortcode
    ? jobs.find((j) => j.shortcode === ref.shortcode || j.code === ref.shortcode)
    : null;
  if (!job) return null;
  const board = boardEntries([{ slug: ref.slug, ...(deps.board ?? {}) }])[0];
  return normaliseAll([toRecord(row(job, board, payload))])[0];
}

/** apply.workable.com/{slug}/j/{shortcode}/ and {slug}.workable.com/j/{shortcode} */
function parseUrl(url) {
  const s = String(url ?? "");
  const apply = s.match(/^https?:\/\/apply\.workable\.com\/([^/?#]+)(?:\/j\/([^/?#]+))?/i);
  if (apply) return { slug: apply[1], shortcode: apply[2] ?? null };
  const sub = s.match(/^https?:\/\/([a-z0-9-]+)\.workable\.com\/(?:j|jobs)\/([^/?#]+)/i);
  return sub ? { slug: sub[1], shortcode: sub[2] } : null;
}

function listOf(payload, slug) {
  if (Array.isArray(payload?.jobs)) return payload.jobs;
  throw new Error(
    `sources/workable: account ${slug} returned no jobs[]. ` +
      `Got keys: ${Object.keys(payload ?? {}).join(", ") || "(none)"}`,
  );
}

function row(job, board, payload) {
  const location = place(job);
  const text = stripHtml(job.description ?? job.requirements);
  return {
    job,
    board,
    text,
    location,
    role: job.title,
    company: board.company ?? payload?.name ?? titleiseSlug(board.slug),
    posted_at: job.published_on ?? job.created_at ?? null,
    workplace_type:
      job.telecommuting === true
        ? "remote"
        : workplaceFromText(location, job.title, text.slice(0, 400)),
  };
}

function place(job) {
  const loc = job.location ?? {};
  const bits = [
    job.city ?? loc.city,
    job.state ?? loc.region,
    job.country ?? loc.country,
  ].filter(Boolean);
  return bits.length ? collapse([...new Set(bits)].join(", ")) : null;
}

function toRecord({ job, board, location, role, company, workplace_type }) {
  const target = job.application_url ?? job.shortlink ?? job.url ?? null;
  return {
    company,
    company_id: board.company_id ?? undefined,
    domains: board.domains,
    role,
    source: id,
    source_id: String(job.shortcode ?? job.code ?? job.id),
    url: job.url ?? job.shortlink ?? target,
    apply: {
      channel: channelForSource(id),
      target,
      route_confidence: 0.95,
      identity_verified: false,
      identity_domain: null,
    },
    location,
    workplace_type,
    // The widget carries no compensation fields at all. Not "sometimes empty":
    // absent from the schema, so there is nothing to read and nothing to guess.
    posted_comp: {},
    notes: note(job),
  };
}

function note(job) {
  const bits = [job.department, job.employment_type, job.experience].filter(Boolean);
  return bits.length ? collapse(bits.join(" | ")) : null;
}
