/**
 * resolve-route.mjs - given a company domain, find the way in.
 *
 * This is the algorithm from the second imessage.store sweep, written down as a
 * scored pipeline instead of a paragraph. It runs in this order, and the order
 * is the point:
 *
 *   1. the homepage
 *   2. /careers, /jobs, /about, /join
 *   3. scan everything fetched so far for links to a known ATS or hiring board
 *   4. scan for published addresses and hiring language
 *   5. probe ATS board slugs directly, because a site can be a JavaScript shell
 *      while its board is live and public. That is exactly how a real board was
 *      found behind a site that rendered nothing at all
 *   6. sweep /sitemap.xml and /robots.txt for a careers URL the navigation
 *      never links
 *
 * Each stage contributes candidates with a confidence in [0,1] and a line of
 * reasoning in evidence[]. The best candidate wins.
 *
 * A company with nothing reachable returns channel "none". That result means
 * exactly one thing, and the wording is kept because it is the honest framing:
 * it is a statement about what is publicly visible, not proof they have no
 * openings.
 *
 * Note on the probe stage: a board found by guessing a slug is NOT evidence
 * that the board belongs to this company. The Ashby slug `nudge` is a neurotech
 * company in San Francisco, and it is not nudge.gs. So a probe hit is capped
 * well below a linked board and is labelled as identity-unverified, which is
 * what makes identity.mjs a blocking check rather than a formality.
 */

import {
  channelForUrl,
  collapse,
  extractEmails,
  extractLinks,
  fetchText as defaultFetchText,
  normaliseDomain,
  stripHtml,
} from "./index.mjs";

/** Paths tried after the homepage, in the order the original sweep used them. */
const CAREER_PATHS = ["/careers", "/jobs", "/about", "/join"];

/**
 * Boards worth recognising in a link. The six with adapters get their real
 * channel from channelForUrl; the rest are still routes, just manual ones.
 */
const BOARD_PATTERNS = [
  { name: "ashby", re: /https?:\/\/jobs\.ashbyhq\.com\/[^\s"'<>)]+/gi },
  { name: "greenhouse", re: /https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/[^\s"'<>)]+/gi },
  { name: "lever", re: /https?:\/\/jobs\.(?:eu\.)?lever\.co\/[^\s"'<>)]+/gi },
  { name: "workable", re: /https?:\/\/apply\.workable\.com\/[^\s"'<>)]+/gi },
  { name: "recruitee", re: /https?:\/\/[a-z0-9-]+\.recruitee\.com\/[^\s"'<>)]*/gi },
  {
    name: "smartrecruiters",
    re: /https?:\/\/(?:jobs|careers)\.smartrecruiters\.com\/[^\s"'<>)]+/gi,
  },
  { name: "workday", re: /https?:\/\/[a-z0-9-]+\.(?:myworkdayjobs|wd\d)\.com\/[^\s"'<>)]+/gi },
  { name: "gem", re: /https?:\/\/jobs\.gem\.com\/[^\s"'<>)]+/gi },
  { name: "rippling", re: /https?:\/\/(?:ats\.rippling\.com|[a-z0-9-]+\.rippling-ats\.com)\/[^\s"'<>)]*/gi },
  { name: "wellfound", re: /https?:\/\/(?:wellfound\.com|angel\.co)\/(?:company|jobs)\/[^\s"'<>)]+/gi },
  {
    name: "work-at-a-startup",
    re: /https?:\/\/(?:www\.)?workatastartup\.com\/(?:companies|jobs)\/[^\s"'<>)]+/gi,
  },
  { name: "typeform", re: /https?:\/\/[a-z0-9-]+\.typeform\.com\/to\/[^\s"'<>)]+/gi },
  { name: "notion", re: /https?:\/\/(?:[a-z0-9-]+\.)?notion\.(?:so|site)\/[^\s"'<>)]+/gi },
];

const HIRING_PHRASE =
  /\b(we(?:'re| are| re)? hiring|join (?:our|the) team|open (?:roles|positions|jobs)|current openings|job openings|now hiring|work with us|apply now|see our roles|view (?:all )?(?:roles|openings))\b/i;

/** An address whose local part is itself a hiring route. */
const HIRING_MAILBOX = /^(careers?|jobs?|hiring|recruit(ing|ment)?|talent|apply|hr|work)@/i;

/** Slug-probe endpoints. Each returns JSON that names its own list key. */
const PROBES = [
  {
    name: "ashby",
    api: (s) => `https://api.ashbyhq.com/posting-api/job-board/${s}`,
    key: "jobs",
    board: (s) => `https://jobs.ashbyhq.com/${s}`,
  },
  {
    name: "greenhouse",
    api: (s) => `https://boards-api.greenhouse.io/v1/boards/${s}/jobs`,
    key: "jobs",
    board: (s) => `https://boards.greenhouse.io/${s}`,
  },
  {
    name: "lever",
    api: (s) => `https://api.lever.co/v0/postings/${s}?mode=json`,
    key: null, // a bare array
    board: (s) => `https://jobs.lever.co/${s}`,
  },
  {
    name: "recruitee",
    api: (s) => `https://${s}.recruitee.com/api/offers/`,
    key: "offers",
    board: (s) => `https://${s}.recruitee.com/`,
  },
  {
    name: "workable",
    api: (s) => `https://apply.workable.com/api/v1/widget/accounts/${s}`,
    key: "jobs",
    board: (s) => `https://apply.workable.com/${s}/`,
  },
];

const MAX_PROBE_SLUGS = 3;
/** Stop early once a candidate this good is in hand. Nothing beats a linked board. */
const GOOD_ENOUGH = 0.85;

export async function resolveRoute(domain, opts = {}) {
  const fetchText = opts.fetchText ?? defaultFetchText;
  const probe = opts.probe !== false;

  const host = normaliseDomain(domain);
  if (!host) {
    throw new Error(
      `resolve-route: ${JSON.stringify(domain)} is not a domain. ` +
        'Pass something like "acme.example".',
    );
  }

  const evidence = [];
  const candidates = [];
  const pages = [];
  const at = () => new Date().toISOString();
  const note = (text) => evidence.push({ at: at(), kind: "route", text });

  /* 1 + 2: the homepage, then the four paths the sweep used. */
  for (const path of ["/", ...CAREER_PATHS]) {
    const res = await fetchText(`https://${host}${path}`);
    if (res?.ok && res.text) {
      pages.push({ path, url: res.url ?? `https://${host}${path}`, html: res.text });
      note(`Fetched https://${host}${path} (HTTP ${res.status}).`);
    } else {
      note(
        `https://${host}${path} did not answer with a page ` +
          `(HTTP ${res?.status ?? 0}${res?.error ? `, ${res.error}` : ""}).`,
      );
    }
  }

  if (pages.length === 0) {
    note(
      `Nothing under https://${host} answered. The site may be down, may block ` +
        "automated requests, or may not exist.",
    );
  }

  /* 3: board links anywhere in what we fetched. */
  for (const page of pages) {
    const isCareers = /career|job|join/i.test(page.path);
    for (const found of boardLinks(page.html)) {
      candidates.push({
        url: found.url,
        source: found.name,
        channel: channelForUrl(found.url) ?? "form",
        // A board the company links to from its own careers page is the
        // strongest signal available short of applying.
        confidence: isCareers ? 0.9 : 0.85,
        why:
          `${found.name} board linked from ${page.url}` +
          (isCareers ? ", which is the company's own careers page." : "."),
      });
    }
  }
  pushBest(candidates, evidence, at);

  if (best(candidates)?.confidence >= GOOD_ENOUGH) {
    return result(candidates, evidence, host);
  }

  /* 4: a careers page with hiring language, and published addresses. */
  for (const page of pages) {
    const text = stripHtml(page.html);
    const hiring = HIRING_PHRASE.test(text);
    if (/career|job|join/i.test(page.path)) {
      candidates.push({
        url: page.url,
        source: "careers-page",
        channel: "form",
        confidence: hiring ? 0.6 : 0.45,
        why: hiring
          ? `${page.url} renders hiring language but links no ATS board. Apply route is the page itself.`
          : `${page.url} exists but shows no hiring language and no board. It may be a shell.`,
      });
    }
    for (const email of extractEmails(page.html).filter((e) => onDomain(e, host))) {
      const mailbox = HIRING_MAILBOX.test(email);
      candidates.push({
        url: `mailto:${email}`,
        source: "published-email",
        channel: "email",
        confidence: mailbox ? 0.6 : hiring ? 0.45 : 0.3,
        why: mailbox
          ? `${email} is published on ${page.url} and is a hiring mailbox.`
          : hiring
            ? `${email} is published on ${page.url}, next to hiring language. Generic mailbox.`
            : `${email} is published on ${page.url}. Generic mailbox, no hiring language nearby.`,
      });
    }
  }
  pushBest(candidates, evidence, at);

  if (best(candidates)?.confidence >= GOOD_ENOUGH) {
    return result(candidates, evidence, host);
  }

  /* 5: probe board slugs directly. A JavaScript shell hides a live board. */
  if (probe) {
    const slugs = slugCandidates(host);
    note(`Probing ATS slugs directly: ${slugs.join(", ")}.`);
    for (const slug of slugs) {
      for (const p of PROBES) {
        const hit = await probeBoard(p, slug, fetchText);
        if (!hit) continue;
        candidates.push({
          url: p.board(slug),
          source: `${p.name}-probe`,
          channel: channelForUrl(p.board(slug)) ?? "form",
          // Deliberately below every linked route. Nothing here ties this board
          // to this company: the slug was guessed from the domain and slugs
          // collide across unrelated companies.
          confidence: 0.45,
          identity_unverified: true,
          why:
            `Probing found a live ${p.name} board at slug "${slug}" with ${hit} open ` +
            `posting(s), but nothing on ${host} links to it. The slug was guessed from the ` +
            "domain and ATS slugs collide across unrelated companies, so the board's " +
            "identity must be confirmed from a job description before this is treated as a route.",
        });
      }
    }
    pushBest(candidates, evidence, at);
  }

  /* 6: sitemap and robots, for a careers URL the navigation never links. */
  for (const url of await sitemapUrls(host, fetchText, note)) {
    candidates.push({
      url,
      source: "sitemap",
      channel: channelForUrl(url) ?? "form",
      confidence: 0.4,
      why: `${url} appears in the sitemap or robots.txt but is not linked from the pages fetched.`,
    });
  }
  pushBest(candidates, evidence, at);

  return result(candidates, evidence, host);
}

/* ------------------------------------------------------------------ stages */

/**
 * Board links out of a page. Two passes on purpose: href attributes catch the
 * normal case, and a raw scan of the document catches a URL sitting in inline
 * JSON or a data attribute, which is common on sites that render client-side.
 *
 * Regex is the right tool for this and not a shortcut: these are fixed,
 * well-known URL shapes, and nothing structural is read back out of the page.
 */
function boardLinks(html) {
  const out = new Map();
  const haystacks = [html, extractLinks(html).join("\n")];
  for (const { name, re } of BOARD_PATTERNS) {
    for (const hay of haystacks) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(hay))) {
        const url = m[0].replace(/[.,;)]+$/, "").replace(/&amp;/g, "&");
        if (!out.has(url)) out.set(url, { url, name });
      }
    }
  }
  return [...out.values()];
}

/**
 * Slug guesses from a domain: the first label, the domain with the dots taken
 * out, and the first label without hyphens. Enough to find a board that follows
 * the usual convention, few enough not to turn this into a scanner.
 */
export function slugCandidates(host) {
  const label = host.split(".")[0];
  const all = [label, host.replace(/\./g, ""), label.replace(/-/g, "")];
  return [...new Set(all.filter((s) => s && s.length >= 2))].slice(0, MAX_PROBE_SLUGS);
}

/** How many open postings the probed board has, or null when it is not a board. */
async function probeBoard(p, slug, fetchText) {
  const res = await fetchText(p.api(slug), { retries: 0 });
  if (!res?.ok || !res.text) return null;
  let payload;
  try {
    payload = JSON.parse(res.text);
  } catch {
    return null;
  }
  const list = p.key ? payload?.[p.key] : payload;
  if (!Array.isArray(list) || list.length === 0) return null;
  return list.length;
}

async function sitemapUrls(host, fetchText, note) {
  const found = new Set();
  const seen = new Set();
  const queue = [`https://${host}/sitemap.xml`];

  const robots = await fetchText(`https://${host}/robots.txt`, { retries: 0 });
  if (robots?.ok && robots.text) {
    // robots.txt is a line format, not markup. Reading Sitemap: lines out of it
    // is what the format is for.
    for (const line of robots.text.split(/\r?\n/)) {
      const m = line.match(/^\s*sitemap:\s*(\S+)/i);
      if (m) queue.push(m[1]);
    }
    note(`Read https://${host}/robots.txt (${queue.length - 1} sitemap reference(s)).`);
  }

  while (queue.length && seen.size < 3) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const res = await fetchText(url, { retries: 0 });
    if (!res?.ok || !res.text) continue;

    // <loc> in a sitemap is a fixed shape defined by the sitemap protocol.
    const locs = [...res.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
    for (const loc of locs) {
      if (/sitemap.*\.xml$/i.test(loc) && seen.size < 3) {
        queue.push(loc);
        continue;
      }
      if (/(career|jobs?|join-?us|hiring|vacanc|work-with-us|opportunit)/i.test(loc)) {
        found.add(loc);
      }
    }
    if (locs.length) note(`Swept ${url} (${locs.length} URLs, ${found.size} careers-shaped).`);
  }
  return [...found].slice(0, 5);
}

/* ------------------------------------------------------------------ scoring */

function onDomain(email, host) {
  const d = email.split("@")[1] ?? "";
  return d === host || d.endsWith(`.${host}`) || host.endsWith(`.${d}`);
}

function best(candidates) {
  return [...candidates].sort((a, b) => b.confidence - a.confidence)[0] ?? null;
}

/** Record each stage's best find, so evidence[] reads as a trail and not a dump. */
function pushBest(candidates, evidence, at) {
  const top = best(candidates);
  if (!top || top.logged) return;
  top.logged = true;
  evidence.push({ at: at(), kind: "route", text: top.why });
}

function result(candidates, evidence, host) {
  const ranked = [...candidates]
    .sort((a, b) => b.confidence - a.confidence)
    .map(({ logged, ...c }) => c);
  const top = ranked[0];

  if (!top) {
    evidence.push({
      at: new Date().toISOString(),
      kind: "route",
      text:
        `No careers page, no ATS board and no hiring language was reachable on ${host}. ` +
        "That is a statement about what is publicly visible, not proof they have no openings.",
    });
    return {
      channel: "none",
      target: null,
      route_confidence: 0,
      evidence,
      candidates: ranked,
    };
  }

  return {
    channel: top.channel,
    target: top.url,
    route_confidence: top.confidence,
    evidence,
    candidates: ranked,
  };
}

/* --------------------------------------------------------------- utilities */

/** Exported for callers that want the phrase test on their own text. */
export function looksLikeHiring(text) {
  return HIRING_PHRASE.test(collapse(String(text ?? "")));
}
