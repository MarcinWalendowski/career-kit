/**
 * identity.mjs - is this board actually the company we meant?
 *
 * The warning this file exists to enforce, from a real sweep:
 *
 *   The Ashby board at slug `nudge` is a neurotech company in San Francisco
 *   hiring ultrasound and MR staff. It has nothing to do with nudge.gs.
 *   Same trap as `ditto` (an edge-sync company) versus dittoai, and `miso`
 *   (a Korean cleaning marketplace) versus the New York travel product.
 *   Always confirm the board's identity from a job description before
 *   treating it as a route.
 *
 * That was a sentence in a markdown file. Here it is a blocking check.
 *
 * The default is block. ok:false is what you get when the signals are ABSENT,
 * not only when they conflict. An unknown identity and a wrong identity cost
 * the same thing when the send goes out, and the send is the part with no undo.
 *
 * Three signals, in descending strength:
 *
 *   domain-in-copy   the posting's own text or links name a domain we already
 *                    associate with this company. Strong, and hard to fake by
 *                    accident.
 *   name-match       the board's company name matches ours. Weak on its own:
 *                    the nudge collision passes this test perfectly.
 *   product-match    what the job description says the company does overlaps
 *                    what our record says it does. This is the signal that
 *                    catches the collisions, because two companies sharing a
 *                    slug almost never share a product.
 */

import {
  THIRD_PARTY_HOSTS,
  collapse,
  extractEmails,
  extractLinks,
  normaliseDomain,
  normaliseDomains,
  stripHtml,
} from "./index.mjs";

/** Enough of a match on its own. */
const NAME_STRONG = 0.9;
/** Enough to count as a name signal when something else supports it. */
const NAME_WEAK = 0.7;
/** Fraction of our product words that must show up in the posting. */
const PRODUCT_THRESHOLD = 0.34;

export function verifyIdentity({ record, posting } = {}) {
  if (!record) {
    throw new Error("identity: verifyIdentity needs a record to check the posting against.");
  }

  const ourDomains = normaliseDomains(record.domains);
  const ourName = String(record.company ?? "");
  const ourProduct = productText(record);

  const copy = postingText(posting);
  const claimed = claimedDomains(posting, copy);
  const theirName = String(posting?.company ?? posting?.company_name ?? "");

  const signals = [];

  /* 1. domain in copy */
  const hit = ourDomains.find((d) => claimed.some((c) => sameSite(c, d)));
  signals.push({
    name: "domain-in-copy",
    value: ourDomains.length === 0 ? null : Boolean(hit),
    detail:
      ourDomains.length === 0
        ? "The record lists no domains, so there is nothing to look for."
        : hit
          ? `The posting names ${hit}, which is on the record.`
          : claimed.length
            ? `The posting names ${claimed.join(", ")}, none of which is on the record.`
            : "The posting names no company domain at all.",
  });

  /* 2. name match */
  const nameScore = theirName && ourName ? nameSimilarity(ourName, theirName) : null;
  signals.push({
    name: "name-match",
    value: nameScore === null ? null : nameScore >= NAME_WEAK,
    score: nameScore,
    detail:
      nameScore === null
        ? "One of the two names is missing, so they cannot be compared."
        : `"${ourName}" vs "${theirName}" scores ${nameScore.toFixed(2)}.` +
          (nameScore >= NAME_STRONG
            ? " A name match alone proves nothing: colliding slugs usually share a name."
            : ""),
  });

  /* 3. product match */
  const product = productOverlap(ourProduct, copy);
  signals.push({
    name: "product-match",
    value: product === null ? null : product.fraction >= PRODUCT_THRESHOLD,
    score: product?.fraction ?? null,
    detail:
      product === null
        ? "Nothing to compare: the record does not say what the company does, or the posting has no description."
        : `${product.matched.length} of ${product.total} product words from the record appear in the posting` +
          (product.matched.length ? ` (${product.matched.slice(0, 6).join(", ")}).` : "."),
  });

  /* 4. a foreign domain, recorded whether or not it changes the verdict */
  const foreign = claimed.filter((c) => !ourDomains.some((d) => sameSite(c, d)));
  signals.push({
    name: "foreign-domain",
    value: claimed.length === 0 ? null : foreign.length > 0 && !hit,
    detail: foreign.length
      ? `Domains in the posting that are not on the record: ${foreign.join(", ")}.`
      : "No unfamiliar company domain in the posting.",
  });

  return decide({ signals, hit, nameScore, product, foreign, ourDomains, theirName, ourName });
}

function decide({ signals, hit, nameScore, product, foreign, ourDomains, theirName, ourName }) {
  const nameOk = nameScore !== null && nameScore >= NAME_WEAK;
  const productOk = product !== null && product.fraction >= PRODUCT_THRESHOLD;
  const productChecked = product !== null;

  // Strongest path: the posting names a domain we already hold for them.
  if (hit) {
    return {
      ok: true,
      identity_domain: hit,
      reason: "identity-verified",
      detail: `The posting names ${hit}, which the record already holds for ${ourName}.`,
      signals,
    };
  }

  // Second path: the name matches AND the description describes the same
  // company. Either alone is not enough, and that is the whole lesson of the
  // nudge collision.
  if (nameOk && productOk) {
    return {
      ok: true,
      identity_domain: ourDomains[0] ?? null,
      reason: "identity-verified",
      detail:
        `Name and product description both match, though the posting names no domain. ` +
        `Confidence rests on the description, so a human should glance at it before sending.`,
      signals,
    };
  }

  // The collision shape: same name, different company.
  if (nameOk && productChecked && !productOk) {
    return {
      ok: false,
      identity_domain: null,
      reason: "identity-mismatch",
      detail:
        `"${theirName}" matches the name on the record, but the posting describes a different ` +
        `business. This is the ATS slug collision: two unrelated companies share a name and a ` +
        `board slug. Confirm from the job description before treating this as a route.`,
      signals,
    };
  }

  // A posting that names somebody else's domain and nothing of ours.
  if (foreign.length && ourDomains.length) {
    return {
      ok: false,
      identity_domain: null,
      reason: "identity-mismatch",
      detail:
        `The posting names ${foreign.join(", ")} and none of the record's domains ` +
        `(${ourDomains.join(", ")}).`,
      signals,
    };
  }

  // Everything else. No signal is not a pass.
  return {
    ok: false,
    identity_domain: null,
    reason: "identity-unknown",
    detail:
      "Nothing in the posting ties it to this company: no matching domain, and " +
      (nameScore === null
        ? "no company name to compare"
        : `the name scores only ${nameScore.toFixed(2)}`) +
      (productChecked ? "" : ", with no product description on the record to check against") +
      ". An unverified identity blocks, the same as a wrong one.",
    signals,
  };
}

/* ------------------------------------------------------------------ signals */

/** Everything the posting says, as one blob of text. */
function postingText(posting) {
  if (!posting) return "";
  if (typeof posting === "string") return stripHtml(posting);
  const parts = [
    posting.description,
    posting.descriptionPlain,
    posting.descriptionHtml,
    posting.content,
    posting.text,
    posting.about,
    posting.company,
    posting.company_name,
    posting.title,
    posting.role,
    posting.url,
    posting.jobUrl,
    posting.applyUrl,
    posting.absolute_url,
    posting.hostedUrl,
    posting.company_website,
  ].filter(Boolean);
  return stripHtml(parts.join(" \n "));
}

/** What our record says the company does. */
function productText(record) {
  return collapse(
    [record.about, record.description, record.what, record.notes].filter(Boolean).join(" "),
  );
}

/**
 * Domains the posting claims for itself: from an explicit field, from any link
 * that is not a board or a social network, and from any address in the copy.
 */
function claimedDomains(posting, copy) {
  const explicit = normaliseDomains(
    [posting?.company_website, posting?.website, ...(posting?.domains ?? [])].filter(Boolean),
  );
  const fromLinks = extractLinks(copy)
    .concat(rawUrls(copy))
    .filter((u) => !THIRD_PARTY_HOSTS.test(u))
    .map(normaliseDomain);
  const fromEmails = extractEmails(copy)
    .map((e) => normaliseDomain(e.split("@")[1]))
    .filter((d) => d && !isFreeMail(d));
  return [...new Set([...explicit, ...fromLinks, ...fromEmails].filter(Boolean))];
}

/** Bare URLs in prose, which extractLinks cannot see because they have no href. */
function rawUrls(text) {
  return String(text).match(/https?:\/\/[^\s"'<>)]+/gi) ?? [];
}

function isFreeMail(d) {
  return /^(gmail|googlemail|yahoo|hotmail|live|msn|outlook|icloud|protonmail|proton|pm|aol|gmx|web|mail|yandex|zoho)\./.test(
    String(d),
  );
}

/** acme.example and jobs.acme.example are the same site. */
function sameSite(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  return a.endsWith(`.${b}`) || b.endsWith(`.${a}`);
}

/* --------------------------------------------------------------- similarity */

const LEGAL_SUFFIX =
  /\b(inc|inc\.|llc|ltd|limited|corp|corporation|co|gmbh|ag|bv|b\.v\.|nv|sa|s\.a\.|ab|oy|as|aps|plc|pty|sp z o o|sp\. z o\.o\.|z o o|s r o|technologies|technology|labs|lab|software|systems|group|holdings|the)\b/g;

export function normaliseCompanyName(s) {
  return collapse(
    String(s ?? "")
      .toLowerCase()
      .replace(/[.,()]/g, " ")
      .replace(LEGAL_SUFFIX, " ")
      .replace(/[^a-z0-9 ]+/g, " "),
  );
}

/** 1.0 identical, 0.9 one contains the other, else a bigram Dice coefficient. */
export function nameSimilarity(a, b) {
  const x = normaliseCompanyName(a);
  const y = normaliseCompanyName(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return 0.9;

  const A = bigrams(x);
  const B = bigrams(y);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

function bigrams(s) {
  const t = s.replace(/\s+/g, "");
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}

const STOPWORDS = new Set(
  ("the a an and or for of to in on at with by from as is are be we our your you " +
    "that this it its their they them who what which will can may our team company " +
    "startup platform product using use used help helps building build builds new " +
    "world people work working role job position hiring join")
    .split(" ")
    .filter(Boolean),
);

/**
 * What fraction of the distinctive words in our own description of the company
 * show up in the posting. Not a semantic match and not pretending to be one: it
 * is a cheap check that catches the case that matters, which is two completely
 * different businesses wearing the same name.
 */
export function productOverlap(ours, theirs) {
  const mine = contentWords(ours);
  const hay = ` ${collapse(String(theirs ?? "")).toLowerCase()} `;
  if (mine.length === 0 || hay.trim().length === 0) return null;
  const matched = mine.filter((w) => hay.includes(` ${w} `) || hay.includes(` ${w}s `));
  return { total: mine.length, matched, fraction: matched.length / mine.length };
}

function contentWords(text) {
  const words = collapse(String(text ?? ""))
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 25);
}
