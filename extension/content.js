/**
 * content.js - reads the job results already rendered on the page.
 *
 * This file is NOT declared in manifest.json under `content_scripts`. It is
 * injected by popup.js with chrome.scripting.executeScript when you click the
 * toolbar button, and it runs exactly once per click. That is deliberate: a
 * declared content script runs on every matching page you visit, whether or not
 * you asked for anything, and the whole defensibility of reading a logged-in
 * job board rests on the capture being something a person did on purpose.
 *
 * The rules, which are constraints and not preferences:
 *
 *   - No auto-scroll. We read what is in the DOM right now. If you want more
 *     results, you scroll and click again.
 *   - No pagination. We never follow a "next" link.
 *   - No scheduled runs. There is no `alarms` permission and no timer.
 *   - Nothing leaves the machine. The only host in the manifest is 127.0.0.1.
 *
 * Every per-site parser degrades rather than throws. A board that changed its
 * markup last night should report "captured 25 cards, could not parse 25", not
 * fail with a stack trace and leave you thinking nobody is hiring.
 */

(() => {
  const ISO = new Date().toISOString();

  /* ---------------------------------------------------------------- helpers */

  const text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);

  /** Empty string is not a value. An adapter that cannot read a field returns
   *  null, never a guess and never "". */
  const clean = (s) => {
    const v = (s || "").replace(/\s+/g, " ").trim();
    return v.length ? v : null;
  };

  const abs = (href) => {
    if (!href) return null;
    try { return new URL(href, location.href).toString(); } catch { return null; }
  };

  /** Same slug rules as engine/paths.mjs, so ids generated here match ids
   *  generated there. A different slug function means a duplicate record. */
  const slug = (s) =>
    String(s || "")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 120);

  const first = (root, ...selectors) => {
    for (const sel of selectors) {
      const el = root.querySelector(sel);
      if (el && clean(el.textContent)) return el;
    }
    return null;
  };

  /* ------------------------------------------------------- the record shape */

  /**
   * The job record from the spec, with every field the page cannot tell us set
   * to null. Two fields deserve a note:
   *
   * `apply.channel` is "none", not a guess. A results card tells you a posting
   * exists; it does not tell you where the application actually goes. Resolving
   * that is `career-sources`' job, and it runs an identity check on the result.
   * Writing "linkedin" here because we happened to read LinkedIn would put an
   * unverified route into a record that later gets acted on.
   *
   * `status` is "discovered". These land in jobs/inbox/, never in jobs/.
   */
  function record({ company, role, url, source, source_id, location, workplace_type, note }) {
    const companyId = slug(company);
    const id = [companyId, slug(role)].filter(Boolean).join("-") || slug(source_id) || slug(url);
    return {
      id,
      company: company || null,
      company_id: companyId || null,
      domains: [],
      role: role || null,
      seniority: null,
      source,
      source_id: source_id || null,
      url: url || null,
      apply: {
        channel: "none",
        target: null,
        route_confidence: null,
        identity_verified: false,
        identity_domain: null,
      },
      location: location || null,
      workplace_type: workplace_type || "unknown",
      posted_comp: { currency: null, min: null, max: null, period: "year", equity: null },
      status: "discovered",
      sent_at: null,
      sent_at_source: null,
      message_id: null,
      subject: null,
      receipt: null,
      notes: "",
      evidence: [
        {
          at: ISO,
          kind: "capture",
          text: note || `Captured from a rendered ${source} results list: ${document.title}`,
        },
      ],
      incidents: [],
      escalations: [],
      discovered_at: ISO,
      updated_at: ISO,
    };
  }

  /** Split a "Remote" / "Hybrid" / "On-site" hint out of a location string. */
  function workplaceFrom(s) {
    const v = (s || "").toLowerCase();
    if (/\bremote\b|\bzdalna\b|\bzdalnie\b/.test(v)) return "remote";
    if (/\bhybrid\b|\bhybryd/.test(v)) return "hybrid";
    if (/\bon.?site\b|\bin.?office\b|\bstacjonarn/.test(v)) return "onsite";
    return "unknown";
  }

  /* ------------------------------------------------------ per-site adapters */
  /* Each adapter: { id, match(), cards(), parse(card) -> record | null }.
   * Selectors are listed most-specific first with fallbacks after, because
   * every one of these boards ships markup changes without notice. */

  const ADAPTERS = [
    {
      id: "linkedin",
      match: () => /(^|\.)linkedin\.com$/.test(location.hostname),
      cards: () =>
        pick(
          "div.job-card-container",
          "li.jobs-search-results__list-item",
          ".scaffold-layout__list-item",
          "li[data-occludable-job-id]",
          "[data-job-id]",
        ),
      parse(card) {
        const link = card.querySelector('a[href*="/jobs/view/"]') || card.querySelector("a[href]");
        const url = abs(link && link.getAttribute("href"));
        const role =
          clean(text(first(card, ".job-card-list__title", ".job-card-container__link", "a[aria-label]"))) ||
          clean(link && link.getAttribute("aria-label"));
        const company = clean(
          text(
            first(
              card,
              ".job-card-container__primary-description",
              ".artdeco-entity-lockup__subtitle",
              ".job-card-container__company-name",
            ),
          ),
        );
        const loc = clean(
          text(first(card, ".job-card-container__metadata-item", ".artdeco-entity-lockup__caption")),
        );
        if (!role && !company) return null;
        return record({
          company,
          role,
          url,
          source: "linkedin",
          source_id: card.getAttribute("data-job-id") || card.getAttribute("data-occludable-job-id") || idFromUrl(url, /\/jobs\/view\/(\d+)/),
          location: loc,
          workplace_type: workplaceFrom(loc),
          note: "Captured from a LinkedIn results list the user had open. No scrolling, no pagination.",
        });
      },
    },

    {
      id: "ycombinator",
      match: () => /(^|\.)workatastartup\.com$/.test(location.hostname),
      cards: () =>
        pick(
          "div.company-card",
          "[data-testid='job-card']",
          "div.job-list-item",
          // Fallback: the anchor shape is stable even when the wrappers move.
          ...anchorParents('a[href*="/jobs/"]'),
        ),
      parse(card) {
        const link = card.querySelector('a[href*="/jobs/"]') || card.querySelector("a[href]");
        const url = abs(link && link.getAttribute("href"));
        const role = clean(text(first(card, ".job-name", "[class*='job-title']", "a[href*='/jobs/']")));
        const company = clean(text(first(card, ".company-name", "[class*='company']", "h3", "h4")));
        const loc = clean(text(first(card, ".job-details", "[class*='location']")));
        if (!role) return null;
        return record({
          company,
          role,
          url,
          source: "yc",
          source_id: idFromUrl(url, /\/jobs\/(\d+)/),
          location: loc,
          workplace_type: workplaceFrom(loc),
          note: "Captured from a Work at a Startup results list the user had open.",
        });
      },
    },

    {
      id: "justjoin",
      match: () => /(^|\.)justjoin\.it$/.test(location.hostname),
      cards: () => pick("div[data-index]", "[data-test-id='virtuoso-item-list'] > div", ...anchorParents('a[href^="/job-offer/"], a[href^="/offers/"]')),
      parse(card) {
        const link = card.querySelector('a[href^="/job-offer/"], a[href^="/offers/"], a[href]');
        const url = abs(link && link.getAttribute("href"));
        const role = clean(text(first(card, "h3", "h2", "[class*='title']")));
        const company = clean(text(first(card, "[class*='company']", "span[title]")));
        const loc = clean(text(first(card, "[class*='location']", "span[class*='city']")));
        if (!role) return null;
        return record({
          company,
          role,
          url,
          source: "justjoin",
          source_id: url ? url.split("/").filter(Boolean).pop() : null,
          location: loc,
          workplace_type: workplaceFrom([loc, text(card)].join(" ")),
          note: "Captured from a justjoin.it results list the user had open.",
        });
      },
    },

    {
      id: "nofluffjobs",
      match: () => /(^|\.)nofluffjobs\.com$/.test(location.hostname),
      cards: () => pick("a.posting-list-item", "nfj-postings-list a[href*='/job/']", ...anchorParents("a[href*='/job/']")),
      parse(card) {
        const link = card.matches && card.matches("a[href]") ? card : card.querySelector("a[href]");
        const url = abs(link && link.getAttribute("href"));
        const role = clean(text(first(card, "[data-cy='title position on the job offer listing']", "h3", "[class*='posting-title']")));
        const company = clean(text(first(card, "[data-cy='name of the company on the job offer listing']", "[class*='company-name']")));
        const loc = clean(text(first(card, "[data-cy='location on the job offer listing']", "[class*='location']")));
        if (!role) return null;
        return record({
          company,
          role,
          url,
          source: "nofluffjobs",
          source_id: url ? url.split("/").filter(Boolean).pop() : null,
          location: loc,
          workplace_type: workplaceFrom([loc, text(card)].join(" ")),
          note: "Captured from a NoFluffJobs results list the user had open.",
        });
      },
    },

    {
      id: "pracuj",
      match: () => /(^|\.)pracuj\.pl$/.test(location.hostname),
      cards: () => pick("[data-test='default-offer']", "[data-test='section-offers'] > div", ...anchorParents("a[href*='/praca/']")),
      parse(card) {
        const link = card.querySelector("a[href*='/praca/'], a[href]");
        const url = abs(link && link.getAttribute("href"));
        const role = clean(text(first(card, "[data-test='offer-title']", "h2", "h3")));
        const company = clean(text(first(card, "[data-test='text-company-name']", "[class*='company']")));
        const loc = clean(text(first(card, "[data-test='text-region']", "[data-test='location']", "[class*='region']")));
        if (!role) return null;
        return record({
          company,
          role,
          url,
          source: "pracuj",
          source_id: idFromUrl(url, /,oferta,(\d+)/) || (url ? url.split(",").pop() : null),
          location: loc,
          workplace_type: workplaceFrom([loc, text(card)].join(" ")),
          note: "Captured from a pracuj.pl results list the user had open.",
        });
      },
    },
  ];

  /* --------------------------------------------------------- dom utilities */

  /** First selector that matches anything wins. Returns an array of elements. */
  function pick(...selectors) {
    for (const sel of selectors) {
      if (!sel) continue;
      if (typeof sel !== "string") {
        if (sel.length) return Array.from(sel);
        continue;
      }
      let found = [];
      try {
        found = Array.from(document.querySelectorAll(sel));
      } catch {
        found = [];
      }
      if (found.length) return found;
    }
    return [];
  }

  /** Last-resort card set: the closest common ancestor of each matching link.
   *  Boards rewrite their wrapper classes far more often than they change the
   *  shape of an apply URL. */
  function anchorParents(selector) {
    let anchors = [];
    try {
      anchors = Array.from(document.querySelectorAll(selector));
    } catch {
      return [];
    }
    const out = [];
    const seen = new Set();
    for (const a of anchors) {
      const card = a.closest("li, article, div") || a;
      if (seen.has(card)) continue;
      seen.add(card);
      out.push(card);
    }
    return [out];
  }

  function idFromUrl(url, re) {
    if (!url) return null;
    const m = url.match(re);
    return m ? m[1] : null;
  }

  /* ------------------------------------------------------------------- run */

  const adapter = ADAPTERS.find((a) => {
    try { return a.match(); } catch { return false; }
  });

  if (!adapter) {
    chrome.runtime.sendMessage({
      type: "career-kit/captured",
      ok: false,
      reason: "no-adapter",
      host: location.hostname,
      detail:
        "No parser for this site. Supported: LinkedIn, Work at a Startup, justjoin.it, NoFluffJobs, pracuj.pl.",
    });
    return;
  }

  let cards = [];
  try {
    cards = adapter.cards();
  } catch (err) {
    cards = [];
  }

  const jobs = [];
  const seenIds = new Set();
  let failed = 0;

  for (const card of cards) {
    let rec = null;
    try {
      rec = adapter.parse(card);
    } catch (err) {
      rec = null;
    }
    if (!rec || !rec.id) {
      failed += 1;
      continue;
    }
    // A results list often renders the same posting twice (sticky header,
    // virtualised list). Dedupe inside one capture; the workspace dedupes
    // across captures.
    if (seenIds.has(rec.id)) continue;
    seenIds.add(rec.id);
    jobs.push(rec);
  }

  chrome.runtime.sendMessage({
    type: "career-kit/captured",
    ok: true,
    source: adapter.id,
    url: location.href,
    seen: cards.length,
    parsed: jobs.length,
    failed,
    jobs,
  });
})();
