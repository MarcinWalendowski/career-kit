/**
 * The login-gated and undocumented boards, capture only:
 *
 *   yc-work-at-a-startup   workatastartup.com   (login required to see roles)
 *   justjoin               justjoin.it          (no documented public API)
 *   nofluffjobs            nofluffjobs.com      (no documented public API)
 *   pracuj                 pracuj.pl            (no documented public API)
 *
 * Same rule as the LinkedIn adapter and for the same reason: no endpoint, no
 * client, no import of the network helpers. Only third-party scrapers exist for
 * the Polish boards, and shipping one of those inside a tool that later submits
 * forms on the user's behalf is not a trade worth making. So these read a
 * payload the user's own browser produced from a page the user had open.
 *
 * If any of the four turns out to publish a genuinely public JSON endpoint,
 * that board moves out of this file into its own public-json adapter. The
 * capture path is the honest default, not a permanent verdict.
 *
 * Payload shape:
 *
 *   {
 *     "source": "justjoin",
 *     "captured_at": "2026-07-28T10:00:00Z",
 *     "page_url": "https://justjoin.it/all-locations/backend",
 *     "items": [{
 *       "id": "acme-backend-engineer",
 *       "title": "Backend Engineer",
 *       "company": "Acme sp. z o.o.",
 *       "location": "Warsaw",
 *       "workplace_type": "Hybrid",
 *       "salary_text": "18 000 - 25 000 PLN/mth net (B2B)",
 *       "url": "https://justjoin.it/offers/acme-backend-engineer",
 *       "description": "..."
 *     }]
 *   }
 */

import {
  applyFilters,
  channelForUrl,
  collapse,
  companyDomainFromLinks,
  isoOrNull,
  normaliseAll,
  normaliseDomains,
  stripHtml,
  workplaceFromText,
} from "./index.mjs";

export const id = "capture";
export const kind = "capture";

/**
 * Per-site facts that the payload cannot carry: where the apply form lives, and
 * how confident a captured card lets us be about the route.
 */
export const SITES = {
  "yc-work-at-a-startup": {
    aliases: ["yc", "ycombinator", "workatastartup", "work-at-a-startup", "waas"],
    host: /^https?:\/\/(www\.)?workatastartup\.com\//i,
    // Applying happens on the platform, behind the same login that hid the
    // listing. The route is known; reaching it needs the user's session.
    confidence: 0.7,
    note: "Applying goes through the Work at a Startup platform and needs the user's YC login.",
  },
  justjoin: {
    aliases: ["justjoin.it", "just-join", "jji"],
    host: /^https?:\/\/(www\.)?justjoin\.it\//i,
    confidence: 0.6,
    note: "justjoin.it offers usually apply on-site; some hand off to the employer's own form.",
  },
  nofluffjobs: {
    aliases: ["nofluff", "nofluffjobs.com", "nfj"],
    host: /^https?:\/\/(www\.)?nofluffjobs\.com\//i,
    confidence: 0.6,
    note: "NoFluffJobs offers usually apply on-site; some hand off to the employer's own form.",
  },
  pracuj: {
    aliases: ["pracuj.pl", "pracujpl"],
    host: /^https?:\/\/([a-z0-9-]+\.)?pracuj\.pl\//i,
    confidence: 0.6,
    note: "pracuj.pl offers apply through the board's own form.",
  },
};

export function match(url) {
  if (!url) return false;
  return Object.values(SITES).some((s) => s.host.test(String(url)));
}

export async function search(opts = {}, _deps = {}) {
  const { payload, site } = requirePayload(opts);
  const rows = itemsOf(payload)
    .map((item) => row(item, payload, site))
    .filter(Boolean);
  return normaliseAll(applyFilters(rows, opts).map(toRecord));
}

export async function fetchOne(url, deps = {}) {
  const { payload, site } = requirePayload(deps);
  for (const item of itemsOf(payload)) {
    const r = row(item, payload, site);
    if (r && String(r.url).toLowerCase() === String(url).toLowerCase()) {
      return normaliseAll([toRecord(r)])[0];
    }
  }
  return null;
}

function requirePayload(opts) {
  const payload = opts?.payload ?? opts?.capture ?? null;
  if (!payload) {
    throw new Error(
      "sources/capture is a capture adapter and takes no network path. " +
        "Pass the payload the extension captured as opts.payload. " +
        `Known sources: ${Object.keys(SITES).join(", ")}.`,
    );
  }
  const name = siteName(payload.source ?? opts.source);
  if (!name) {
    throw new Error(
      `sources/capture: unknown payload source ${JSON.stringify(payload.source ?? null)}. ` +
        `Known: ${Object.keys(SITES).join(", ")}.`,
    );
  }
  return { payload, site: name };
}

function siteName(raw) {
  const s = String(raw ?? "").toLowerCase().trim();
  if (!s) return null;
  if (SITES[s]) return s;
  for (const [name, cfg] of Object.entries(SITES)) {
    if (cfg.aliases.includes(s)) return name;
  }
  return null;
}

function itemsOf(payload) {
  const items = payload.items ?? payload.jobs ?? payload.offers ?? payload.results;
  if (!Array.isArray(items)) {
    throw new Error(
      "sources/capture: payload has no items[]. " +
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

function row(item, payload, site) {
  const company = pick(item, "company", "company_name", "companyName", "employer");
  const role = pick(item, "title", "role", "position");
  const url = pick(item, "url", "link", "offer_url", "offerUrl");
  if (!company || !role || !url) return null;

  const location = pick(item, "location", "city", "place");
  const description = stripHtml(pick(item, "description", "snippet", "summary") ?? "");
  const declared = pick(item, "workplace_type", "workplaceType", "workplace");

  return {
    site,
    payload,
    company: collapse(company),
    role: collapse(role),
    source_id: String(pick(item, "id", "offer_id", "slug") ?? url),
    url: String(url),
    location: location ? collapse(location) : null,
    workplace_type: workplaceFromText(declared, location, description.slice(0, 200)),
    text: description,
    posted_at:
      isoOrNull(pick(item, "posted_at", "postedAt", "published_at", "publishedAt")) ??
      isoOrNull(pick(payload, "captured_at", "capturedAt")),
    comp: parseSalaryText(pick(item, "salary_text", "salaryText", "salary")),
    salary_text: pick(item, "salary_text", "salaryText", "salary"),
    equity_text: pick(item, "equity_text", "equityText", "equity"),
    domains: normaliseDomains([pick(item, "company_website", "companyWebsite")]),
  };
}

function toRecord(r) {
  const cfg = SITES[r.site];
  const ats = channelForUrl(r.url);
  const domains = r.domains.length
    ? r.domains
    : [companyDomainFromLinks([r.url])].filter(Boolean);

  return {
    company: r.company,
    domains,
    role: r.role,
    source: r.site,
    source_id: r.source_id,
    url: r.url,
    apply: {
      channel: ats ?? "form",
      target: r.url,
      route_confidence: cfg.confidence,
      identity_verified: false,
      identity_domain: null,
    },
    location: r.location,
    workplace_type: r.workplace_type,
    posted_comp: r.equity_text
      ? { ...r.comp, equity: collapse(r.equity_text) }
      : r.comp,
    notes: notes(r),
    evidence: [
      {
        at: r.posted_at,
        kind: "capture",
        text:
          `Captured from ${r.site}` +
          (r.payload.page_url ? ` (${r.payload.page_url})` : "") +
          `. ${cfg.note}`,
      },
    ],
  };
}

function notes(r) {
  const bits = [];
  if (r.salary_text) bits.push(`Listed pay: ${collapse(r.salary_text)}`);
  if (r.salary_text && r.comp.min != null && r.comp.period === null) {
    // Polish boards quote monthly far more often than annually, and a monthly
    // figure read as annual is off by a factor of twelve. Where the text does
    // not say, the period stays null and a human is told why.
    bits.push("Pay period not stated in the capture, so it is left unset.");
  }
  return bits.length ? bits.join(" ") : null;
}

/* ------------------------------------------------------------------ salary */

const SALARY_TEXT = new RegExp(
  "([$\\u20ac\\u00a3])?\\s*(\\d{1,3}(?:[\\s.,]\\d{3})*|\\d{2,3})\\s*(k)?" +
    "\\s*(?:[-\\u2013\\u2014]|to)\\s*" +
    "([$\\u20ac\\u00a3])?\\s*(\\d{1,3}(?:[\\s.,]\\d{3})*|\\d{2,3})\\s*(k)?" +
    "\\s*(pln|usd|eur|gbp|z\\u0142)?",
  "i",
);

function parseSalaryText(s) {
  if (!s) return {};
  const text = String(s);
  const m = SALARY_TEXT.exec(text);
  if (!m) return {};
  const [, sym1, n1, k1, sym2, n2, k2, tail] = m;
  const min = amount(n1, k1);
  const max = amount(n2, k2);
  if (min === null || max === null || max < min) return {};
  const currency = code(tail) ?? symbol(sym1) ?? symbol(sym2) ?? null;
  if (!currency && min < 1000) return {};
  return { currency, min, max, period: period(text), equity: null };
}

/** Only what the text actually says. A missing period stays null. */
function period(text) {
  const t = String(text).toLowerCase();
  if (/(\/\s*mth|\/\s*mo\b|per month|monthly|miesi)/.test(t)) return "month";
  if (/(\/\s*yr|\/\s*year|per year|annual|rocznie|p\.a\.)/.test(t)) return "year";
  if (/(\/\s*h\b|per hour|hourly|godz)/.test(t)) return "hour";
  if (/(\/\s*day|per day|daily|dzie)/.test(t)) return "day";
  return null;
}

function amount(n, k) {
  if (!n) return null;
  const raw = Number(String(n).replace(/[\s.,]/g, ""));
  if (!Number.isFinite(raw)) return null;
  return k ? raw * 1000 : raw;
}

function code(c) {
  if (!c) return null;
  const t = String(c).toLowerCase();
  if (t === "zł") return "PLN";
  return t.toUpperCase();
}

function symbol(s) {
  if (s === "$") return "USD";
  if (s === "€") return "EUR";
  if (s === "£") return "GBP";
  return null;
}
