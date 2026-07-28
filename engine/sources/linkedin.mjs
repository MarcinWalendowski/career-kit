/**
 * LinkedIn, capture only.
 *
 * This adapter reads a payload the user's own browser produced from a results
 * page the user was already looking at. It has no endpoint, no client, and no
 * import of the network helpers in index.mjs. That is deliberate and it is
 * structural rather than a promise in a comment: there is no code path from
 * here to LinkedIn, so there is nothing to accidentally turn into a crawler.
 *
 * The framing that keeps this defensible is exactly that: user-initiated
 * capture of a page already open, no auto-scroll, no pagination, no scheduled
 * runs, nothing leaving the machine. If that stops being true the adapter is
 * removed rather than weakened.
 *
 * Payload shape, produced by the MV3 extension and posted to the local server:
 *
 *   {
 *     "source": "linkedin",
 *     "captured_at": "2026-07-28T10:00:00Z",
 *     "page_url": "https://www.linkedin.com/jobs/search/?keywords=backend",
 *     "items": [{
 *       "job_id": "3901234567",
 *       "title": "Senior Backend Engineer",
 *       "company": "Acme Robotics",
 *       "location": "Berlin, Germany",
 *       "workplace_type": "Hybrid",
 *       "url": "https://www.linkedin.com/jobs/view/3901234567/",
 *       "salary_text": "90,000 - 120,000",
 *       "easy_apply": true,
 *       "description": "..."
 *     }]
 *   }
 *
 * camelCase keys are accepted too, because the extension and this file are
 * written by different hands and a key-casing mismatch is a silly way to lose
 * a capture.
 */

import {
  applyFilters,
  channelForSource,
  collapse,
  isoOrNull,
  normaliseAll,
  normaliseDomains,
  stripHtml,
  workplaceFromText,
} from "./index.mjs";

export const id = "linkedin";
export const kind = "capture";

export function match(url) {
  if (!url) return false;
  return /^https?:\/\/([a-z]{2,3}\.)?linkedin\.com\//i.test(String(url));
}

/**
 * opts.payload is required. There is no default and no lookup: with no payload
 * this adapter has nothing to read, and the correct behaviour is to say so
 * loudly rather than to go and get one.
 */
export async function search(opts = {}, _deps = {}) {
  const payload = requirePayload(opts);
  const items = itemsOf(payload);
  const rows = items.map((item) => row(item, payload)).filter(Boolean);
  return normaliseAll(applyFilters(rows, opts).map(toRecord));
}

/**
 * Finds one posting inside an already-captured payload. Same rule: the payload
 * comes in through opts, it is never retrieved.
 */
export async function fetchOne(url, deps = {}) {
  const payload = requirePayload(deps);
  const wanted = jobIdFromUrl(url);
  for (const item of itemsOf(payload)) {
    const r = row(item, payload);
    if (!r) continue;
    if (r.source_id === wanted || String(r.url).toLowerCase() === String(url).toLowerCase()) {
      return normaliseAll([toRecord(r)])[0];
    }
  }
  return null;
}

function requirePayload(opts) {
  const payload = opts?.payload ?? opts?.capture ?? null;
  if (!payload) {
    throw new Error(
      "sources/linkedin is a capture adapter and takes no network path. " +
        "Pass the payload the extension captured as opts.payload. " +
        "There is nothing here that can go and read LinkedIn for you.",
    );
  }
  const declared = String(payload.source ?? "linkedin").toLowerCase();
  if (declared !== "linkedin") {
    throw new Error(
      `sources/linkedin: payload declares source "${payload.source}", not linkedin.`,
    );
  }
  return payload;
}

function itemsOf(payload) {
  const items = payload.items ?? payload.jobs ?? payload.results;
  if (!Array.isArray(items)) {
    throw new Error(
      "sources/linkedin: capture payload has no items[]. " +
        `Got keys: ${Object.keys(payload ?? {}).join(", ") || "(none)"}`,
    );
  }
  return items;
}

function pick(obj, ...names) {
  for (const n of names) {
    const v = obj?.[n];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function jobIdFromUrl(url) {
  const m = String(url ?? "").match(/(?:jobs\/view\/|currentJobId=)(\d+)/);
  return m ? m[1] : null;
}

function row(item, payload) {
  const company = pick(item, "company", "company_name", "companyName");
  const role = pick(item, "title", "role", "position");
  if (!company || !role) return null;

  const url = pick(item, "url", "job_url", "jobUrl", "link");
  const jobId =
    pick(item, "job_id", "jobId", "id") ?? (url ? jobIdFromUrl(url) : null) ?? null;
  if (!jobId && !url) return null;

  const location = pick(item, "location", "job_location", "jobLocation");
  const declared = pick(item, "workplace_type", "workplaceType", "workplace");
  const description = stripHtml(pick(item, "description", "snippet", "summary") ?? "");

  return {
    item,
    payload,
    company: collapse(company),
    role: collapse(role),
    source_id: String(jobId ?? url),
    url: url ?? `https://www.linkedin.com/jobs/view/${jobId}/`,
    location: location ? collapse(location) : null,
    // The badge LinkedIn renders on the card is the best answer available, and
    // it is a value the employer picked rather than something inferred here.
    workplace_type: workplaceFromText(declared, location, description.slice(0, 200)),
    text: description,
    posted_at:
      isoOrNull(pick(item, "posted_at", "postedAt", "listed_at", "listedAt")) ??
      isoOrNull(pick(payload, "captured_at", "capturedAt")),
    easy_apply: pick(item, "easy_apply", "easyApply") === true,
    salary_text: pick(item, "salary_text", "salaryText", "salary"),
    domains: normaliseDomains([pick(item, "company_website", "companyWebsite")]),
  };
}

function toRecord(r) {
  return {
    company: r.company,
    domains: r.domains,
    role: r.role,
    source: id,
    source_id: r.source_id,
    url: r.url,
    apply: {
      channel: channelForSource(id),
      target: r.url,
      // Easy Apply means the form is on LinkedIn, and that is a route we can
      // see. Anything else hands off to a destination the card does not name,
      // so the route is not actually known yet and must not score as if it is.
      route_confidence: r.easy_apply ? 0.8 : 0.4,
      identity_verified: false,
      identity_domain: null,
    },
    location: r.location,
    workplace_type: r.workplace_type,
    // LinkedIn shows a band on some cards and an estimate on others, and the
    // capture cannot tell the two apart. An estimate is not posted comp, so
    // the numbers stay out of the record and the string goes in notes.
    posted_comp: {},
    notes: r.salary_text ? `Card showed pay as: ${collapse(r.salary_text)}` : null,
    evidence: [
      {
        at: r.posted_at,
        kind: "capture",
        text:
          "Captured from a LinkedIn results page the user had open" +
          (r.payload.page_url ? ` (${r.payload.page_url})` : "") +
          (r.easy_apply
            ? ". Easy Apply, so the form is on LinkedIn."
            : ". Not Easy Apply, so the real apply route is off-site and unresolved."),
      },
    ],
  };
}
