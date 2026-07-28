/**
 * Greenhouse job boards.
 *
 *   list: https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true
 *   one:  https://boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}?questions=false
 *
 * Public, unauthenticated, and stable for years. `content=true` returns the job
 * description as HTML-escaped HTML in `content`, which is what makes a query
 * filter worth running here rather than on the title alone.
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

export const id = "greenhouse";
export const kind = "public-json";

const API = "https://boards-api.greenhouse.io/v1/boards";

export function match(url) {
  if (!url) return false;
  return /^https?:\/\/(boards|job-boards|boards-api)\.greenhouse\.io\//i.test(String(url));
}

export async function search(opts = {}, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const boards = boardEntries(opts.boards);
  if (boards.length === 0) {
    throw new Error(
      "sources/greenhouse: search needs opts.boards, e.g. " +
        '["acme"] or [{ slug: "acme", company: "Acme", domains: ["acme.example"] }]. ' +
        "Greenhouse has no cross-board search endpoint.",
    );
  }

  const rows = [];
  for (const board of boards) {
    const payload = await fetchJson(
      `${API}/${encodeURIComponent(board.slug)}/jobs?content=true`,
    );
    for (const job of listOf(payload)) rows.push(row(job, board));
  }

  return normaliseAll(applyFilters(rows, opts).map(toRecord));
}

export async function fetchOne(url, deps = {}) {
  const fetchJson = deps.fetchJson ?? defaultFetchJson;
  const ref = parseUrl(url);
  if (!ref) return null;
  const payload = await fetchJson(
    `${API}/${encodeURIComponent(ref.token)}/jobs/${encodeURIComponent(ref.jobId)}`,
  );
  if (!payload || !payload.id) return null;
  const board = boardEntries([{ slug: ref.token, ...(deps.board ?? {}) }])[0];
  return normaliseAll([toRecord(row(payload, board))])[0];
}

/** boards.greenhouse.io/{token}/jobs/{id} and the job-boards.greenhouse.io shape. */
function parseUrl(url) {
  const m = String(url ?? "").match(
    /^https?:\/\/(?:boards|job-boards|boards-api)\.greenhouse\.io\/(?:v1\/boards\/)?([^/?#]+)\/jobs\/(\d+)/i,
  );
  return m ? { token: m[1], jobId: m[2] } : null;
}

function listOf(payload) {
  if (Array.isArray(payload?.jobs)) return payload.jobs;
  throw new Error(
    "sources/greenhouse: response has no jobs[]. " +
      `Got keys: ${Object.keys(payload ?? {}).join(", ") || "(none)"}`,
  );
}

/** The board's own shape, plus the fields the filters need. */
function row(job, board) {
  const text = stripHtml(job.content);
  const location = job.location?.name ?? job.offices?.[0]?.name ?? null;
  return {
    job,
    board,
    text,
    location,
    role: job.title,
    company: board.company ?? job.company_name ?? titleiseSlug(board.slug),
    posted_at: job.updated_at ?? job.first_published ?? null,
    workplace_type: workplaceFromText(location, job.title, firstLines(text)),
  };
}

/**
 * Only the opening of a description is read for workplace type. Further down,
 * a "we are a remote-first company" boilerplate paragraph sits under half the
 * onsite reqs in existence and would flip every one of them to remote.
 */
function firstLines(text) {
  return String(text).slice(0, 400);
}

function toRecord({ job, board, text, location, role, company, workplace_type }) {
  const url = job.absolute_url ?? null;
  return {
    company,
    company_id: board.company_id ?? undefined,
    domains: board.domains,
    role,
    source: id,
    source_id: String(job.id),
    url,
    apply: {
      channel: channelForSource(id),
      target: url,
      // The board itself published this link, so the route is as good as a
      // route gets. Whether the board belongs to the company we meant is a
      // different question, and identity.mjs answers that one.
      route_confidence: 0.95,
      identity_verified: false,
      identity_domain: null,
    },
    location,
    workplace_type,
    posted_comp: comp(job),
    notes: note(job),
  };
}

/**
 * Greenhouse exposes a band only when the board has pay transparency turned on,
 * and the field has appeared under two names. Absent means null, not zero.
 */
function comp(job) {
  const range = job.pay_input_ranges?.[0] ?? job.pay_range ?? null;
  if (!range) return {};
  return {
    currency: range.currency_type ?? range.currency ?? null,
    min: range.min_cents != null ? range.min_cents / 100 : range.min_value ?? null,
    max: range.max_cents != null ? range.max_cents / 100 : range.max_value ?? null,
    period: "year",
    equity: null,
  };
}

function note(job) {
  const dept = job.departments?.map((d) => d.name).filter(Boolean).join(", ");
  return dept ? collapse(`Department: ${dept}`) : null;
}
