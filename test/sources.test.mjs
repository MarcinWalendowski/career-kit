/**
 * Contract tests for the source adapters.
 *
 * Every test runs against a recorded fixture and nothing here touches the
 * network. That is the point rather than a convenience: an adapter that
 * silently returns zero jobs after a board changes its payload looks exactly
 * like a quiet week, and a job search cannot tell the difference. So each
 * adapter asserts the NORMALISED record, not the raw payload, and a renamed
 * field fails here loudly instead of failing silently in production.
 *
 *   node --test test/sources.test.mjs
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as sources from "../engine/sources/index.mjs";
import * as greenhouse from "../engine/sources/greenhouse.mjs";
import * as lever from "../engine/sources/lever.mjs";
import * as ashby from "../engine/sources/ashby.mjs";
import * as smartrecruiters from "../engine/sources/smartrecruiters.mjs";
import * as recruitee from "../engine/sources/recruitee.mjs";
import * as workable from "../engine/sources/workable.mjs";
import * as hn from "../engine/sources/hn-whoishiring.mjs";
import * as remoteBoards from "../engine/sources/remote-boards.mjs";
import * as linkedin from "../engine/sources/linkedin.mjs";
import * as capture from "../engine/sources/capture.mjs";
import { resolveRoute } from "../engine/sources/resolve-route.mjs";
import { verifyIdentity } from "../engine/sources/identity.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCES_DIR = join(HERE, "..", "engine", "sources");

function fixture(name) {
  return JSON.parse(readFileSync(join(HERE, "fixtures", name), "utf8"));
}

function source(name) {
  return readFileSync(join(SOURCES_DIR, name), "utf8");
}

/**
 * A fetchJson stand-in that serves recorded fixtures by URL substring and
 * refuses everything else. An adapter that reaches for an endpoint the test did
 * not record fails rather than hitting the internet.
 */
function stubJson(routes) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    for (const [needle, payload] of Object.entries(routes)) {
      if (String(url).includes(needle)) {
        return typeof payload === "function" ? payload(url) : payload;
      }
    }
    throw new Error(`test stub: no fixture recorded for ${url}`);
  };
  fn.calls = calls;
  return fn;
}

/** A fetchText stand-in over a { url: {ok,status,text} } map. Misses are 404s. */
function stubText(map) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const hit = map[url];
    if (hit) return { url, ...hit };
    return { ok: false, status: 404, url, text: "" };
  };
  fn.calls = calls;
  return fn;
}

/* ------------------------------------------------------------ the contract */

const RECORD_KEYS = [
  "id",
  "company",
  "company_id",
  "domains",
  "role",
  "seniority",
  "source",
  "source_id",
  "url",
  "apply",
  "location",
  "workplace_type",
  "posted_comp",
  "status",
  "sent_at",
  "sent_at_source",
  "message_id",
  "subject",
  "receipt",
  "notes",
  "evidence",
  "incidents",
  "escalations",
  "discovered_at",
  "updated_at",
].sort();

const APPLY_KEYS = [
  "channel",
  "target",
  "route_confidence",
  "identity_verified",
  "identity_domain",
].sort();

const COMP_KEYS = ["currency", "min", "max", "period", "equity"].sort();

/** Every adapter's output goes through this, so all eleven really do agree. */
function assertRecordShape(rec, label) {
  assert.deepEqual(Object.keys(rec).sort(), RECORD_KEYS, `${label}: record key set`);
  assert.deepEqual(Object.keys(rec.apply).sort(), APPLY_KEYS, `${label}: apply key set`);
  assert.deepEqual(Object.keys(rec.posted_comp).sort(), COMP_KEYS, `${label}: comp key set`);

  assert.equal(typeof rec.id, "string");
  assert.ok(rec.id.length > 0, `${label}: id is not empty`);
  assert.ok(rec.company && typeof rec.company === "string", `${label}: company`);
  assert.ok(rec.role && typeof rec.role === "string", `${label}: role`);
  assert.ok(rec.url && typeof rec.url === "string", `${label}: url`);
  assert.equal(rec.status, "discovered", `${label}: adapters only ever discover`);

  assert.ok(sources.CHANNELS.has(rec.apply.channel), `${label}: channel enum`);
  assert.ok(sources.WORKPLACE_TYPES.has(rec.workplace_type), `${label}: workplace enum`);
  assert.ok(
    rec.seniority === null || sources.SENIORITIES.has(rec.seniority),
    `${label}: seniority enum`,
  );
  assert.ok(
    rec.posted_comp.period === null || sources.COMP_PERIODS.has(rec.posted_comp.period),
    `${label}: comp period enum`,
  );

  // No adapter may claim a verified identity. Only identity.mjs can do that,
  // and it is a separate step on purpose.
  assert.equal(rec.apply.identity_verified, false, `${label}: identity is not self-certified`);
  assert.equal(rec.apply.identity_domain, null, `${label}: identity domain unset`);

  // Pipeline state belongs to the gate, never to a discovery adapter.
  for (const k of ["sent_at", "sent_at_source", "message_id", "subject", "receipt"]) {
    assert.equal(rec[k], null, `${label}: ${k} must be untouched by an adapter`);
  }

  for (const k of ["domains", "evidence", "incidents", "escalations"]) {
    assert.ok(Array.isArray(rec[k]), `${label}: ${k} is an array`);
  }
  assert.deepEqual(rec.incidents, [], `${label}: no incidents at discovery`);
  assert.deepEqual(rec.escalations, [], `${label}: no escalations at discovery`);
  for (const e of rec.evidence) {
    assert.equal(typeof e.at, "string");
    assert.equal(typeof e.kind, "string");
    assert.equal(typeof e.text, "string");
  }

  assert.ok(!Number.isNaN(Date.parse(rec.discovered_at)), `${label}: discovered_at is a date`);
  const conf = rec.apply.route_confidence;
  assert.ok(conf === null || (conf >= 0 && conf <= 1), `${label}: confidence in [0,1]`);
}

/* -------------------------------------------------------------- greenhouse */

test("greenhouse: normalises a board into records", async () => {
  const fetchJson = stubJson({ "boards-api.greenhouse.io": fixture("greenhouse.json") });
  const jobs = await greenhouse.search(
    {
      boards: [{ slug: "acmerobotics", company: "Acme Robotics", domains: ["acme.example"] }],
    },
    { fetchJson },
  );

  assert.equal(jobs.length, 3);
  for (const j of jobs) assertRecordShape(j, "greenhouse");
  assert.ok(fetchJson.calls[0].includes("content=true"), "descriptions are requested");

  const [backend, mts, designer] = jobs;

  assert.equal(backend.id, "acme-robotics-senior-backend-engineer");
  assert.equal(backend.company, "Acme Robotics");
  assert.equal(backend.company_id, "acme-robotics");
  assert.deepEqual(backend.domains, ["acme.example"]);
  assert.equal(backend.role, "Senior Backend Engineer");
  assert.equal(backend.seniority, "senior");
  assert.equal(backend.source, "greenhouse");
  assert.equal(backend.source_id, "4001");
  assert.equal(backend.url, "https://boards.greenhouse.io/acmerobotics/jobs/4001");
  assert.equal(backend.apply.channel, "ats-greenhouse");
  assert.equal(backend.apply.target, "https://boards.greenhouse.io/acmerobotics/jobs/4001");
  assert.equal(backend.apply.route_confidence, 0.95);
  assert.equal(backend.location, "Berlin, Germany");
  assert.equal(backend.workplace_type, "hybrid", "read out of the description, not guessed");
  assert.deepEqual(backend.posted_comp, {
    currency: "EUR",
    min: 90000,
    max: 120000,
    period: "year",
    equity: null,
  });
  assert.equal(backend.notes, "Department: Engineering");

  // "Member of Technical Staff" contains the word Staff and is not a staff-level title.
  assert.equal(mts.seniority, null);
  assert.equal(mts.workplace_type, "remote");
  assert.deepEqual(mts.posted_comp, {
    currency: null,
    min: null,
    max: null,
    period: null,
    equity: null,
  });

  assert.equal(designer.workplace_type, "onsite");
});

test("greenhouse: opts.query filters on the description, not just the title", async () => {
  const fetchJson = stubJson({ "boards-api.greenhouse.io": fixture("greenhouse.json") });
  const jobs = await greenhouse.search(
    { boards: ["acmerobotics"], query: "fleet scheduling" },
    { fetchJson },
  );
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].source_id, "4001");
});

test("greenhouse: a renamed list key fails loudly instead of returning nothing", async () => {
  const broken = { ...fixture("greenhouse.json"), jobs: undefined, postings: [] };
  const fetchJson = stubJson({ "boards-api.greenhouse.io": broken });
  await assert.rejects(
    () => greenhouse.search({ boards: ["acmerobotics"] }, { fetchJson }),
    /no jobs\[\]/,
    "a board schema change must throw, not report zero openings",
  );
});

test("greenhouse: fetchOne parses a posting URL", async () => {
  const one = fixture("greenhouse.json").jobs[0];
  const fetchJson = stubJson({ "/jobs/4001": one });
  const rec = await greenhouse.fetchOne(
    "https://boards.greenhouse.io/acmerobotics/jobs/4001",
    { fetchJson },
  );
  assert.equal(rec.source_id, "4001");
  assertRecordShape(rec, "greenhouse.fetchOne");
  assert.equal(await greenhouse.fetchOne("https://example.com/jobs/1", { fetchJson }), null);
});

/* ------------------------------------------------------------------- lever */

test("lever: normalises a board into records", async () => {
  const fetchJson = stubJson({ "api.lever.co": fixture("lever.json") });
  const jobs = await lever.search(
    { boards: [{ slug: "northwind", company: "Northwind Labs", domains: ["northwind.example"] }] },
    { fetchJson },
  );

  assert.equal(jobs.length, 2);
  for (const j of jobs) assertRecordShape(j, "lever");

  const [founding, staff] = jobs;
  assert.equal(founding.id, "northwind-labs-founding-software-engineer");
  assert.equal(founding.role, "Founding Software Engineer");
  assert.equal(founding.seniority, "founding");
  assert.equal(founding.source_id, "8f21b0c4-1d3e-4a55-9b77-2c0e5a4d9f10");
  assert.equal(founding.apply.channel, "ats-lever");
  assert.match(founding.apply.target, /\/apply$/);
  assert.equal(founding.location, "San Francisco, CA");
  assert.equal(founding.workplace_type, "hybrid", "Lever declares workplaceType itself");
  assert.deepEqual(founding.posted_comp, {
    currency: "USD",
    min: 180000,
    max: 240000,
    period: "year",
    equity: null,
  });
  assert.equal(founding.notes, "Core | Engineering | Full-time");

  assert.equal(staff.seniority, "staff");
  assert.equal(staff.workplace_type, "remote");
  assert.equal(staff.posted_comp.min, null, "no salaryRange means null, not zero");
});

/* ------------------------------------------------------------------- ashby */

test("ashby: normalises a board, drops unlisted roles, keeps equity as published", async () => {
  const fetchJson = stubJson({ "api.ashbyhq.com": fixture("ashby.json") });
  const jobs = await ashby.search(
    { boards: [{ slug: "tidepool", company: "Tidepool Analytics", domains: ["tidepool.example"] }] },
    { fetchJson },
  );

  assert.equal(jobs.length, 2, "isListed: false is not a posting");
  for (const j of jobs) assertRecordShape(j, "ashby");
  assert.ok(fetchJson.calls[0].includes("includeCompensation=true"));

  const [founding, infra] = jobs;
  assert.equal(founding.role, "Founding Engineer");
  assert.equal(founding.seniority, "founding");
  assert.equal(founding.apply.channel, "ats-ashby");
  assert.match(founding.apply.target, /\/application$/);
  assert.deepEqual(founding.posted_comp, {
    currency: "USD",
    min: 170000,
    max: 210000,
    period: "year",
    equity: "0.5% - 1.0%",
  });
  assert.equal(founding.workplace_type, "unknown", "an office address is not a workplace type");

  assert.equal(infra.workplace_type, "remote");
  assert.equal(infra.posted_comp.currency, null);
});

/* --------------------------------------------------------- smartrecruiters */

test("smartrecruiters: normalises postings and builds the public apply URL", async () => {
  const fetchJson = stubJson({ "api.smartrecruiters.com": fixture("smartrecruiters.json") });
  const jobs = await smartrecruiters.search(
    { boards: [{ slug: "UmbraSystems", company: "Umbra Systems", domains: ["umbra.example"] }] },
    { fetchJson },
  );

  assert.equal(jobs.length, 2);
  for (const j of jobs) assertRecordShape(j, "smartrecruiters");

  const [payments, sre] = jobs;
  assert.equal(payments.role, "Backend Engineer, Payments");
  assert.equal(payments.source_id, "744000012345678");
  assert.equal(
    payments.url,
    "https://jobs.smartrecruiters.com/UmbraSystems/744000012345678",
    "the API ref is not something a human can apply through",
  );
  assert.equal(payments.apply.channel, "ats-smartrecruiters");
  assert.equal(payments.location, "Warsaw, Mazowieckie, pl");
  assert.equal(payments.workplace_type, "unknown");
  assert.equal(payments.posted_comp.min, null, "the list endpoint carries no pay data");

  assert.equal(sre.workplace_type, "remote");
});

test("smartrecruiters: follows pagination to exhaustion", async () => {
  const posting = (i) => ({
    id: `7440000${String(i).padStart(6, "0")}`,
    name: `Engineer ${i}`,
    company: { identifier: "UmbraSystems", name: "Umbra Systems" },
    location: { city: "Warsaw", country: "pl", remote: false },
    releasedDate: "2026-07-15T08:00:00.000Z",
  });
  const page = (offset, n) => ({
    offset,
    limit: 100,
    totalFound: 105,
    content: Array.from({ length: n }, (_, i) => posting(offset + i)),
  });
  const fetchJson = stubJson({
    "offset=0": page(0, 100),
    "offset=100": page(100, 5),
  });

  const jobs = await smartrecruiters.search({ boards: ["UmbraSystems"] }, { fetchJson });
  assert.equal(jobs.length, 105);
  assert.equal(fetchJson.calls.length, 2);
  assert.ok(fetchJson.calls[1].includes("offset=100"));
  // Same title on the same board twice would collide on the generated id.
  assert.equal(new Set(jobs.map((j) => j.id)).size, 105, "ids are unique within a batch");
});

/* --------------------------------------------------------------- recruitee */

test("recruitee: normalises offers", async () => {
  const fetchJson = stubJson({ "recruitee.com/api/offers": fixture("recruitee.json") });
  const jobs = await recruitee.search(
    {
      boards: [
        { slug: "kestrelhealth", company: "Kestrel Health", domains: ["kestrelhealth.example"] },
      ],
    },
    { fetchJson },
  );

  assert.equal(jobs.length, 2);
  for (const j of jobs) assertRecordShape(j, "recruitee");

  const [platform, frontend] = jobs;
  assert.equal(platform.source_id, "1580123");
  assert.equal(platform.apply.channel, "ats-recruitee");
  assert.match(platform.apply.target, /\/c\/new$/);
  assert.equal(platform.location, "Amsterdam");
  assert.deepEqual(platform.posted_comp, {
    currency: "EUR",
    min: 70000,
    max: 90000,
    period: "year",
    equity: null,
  });
  assert.equal(frontend.workplace_type, "remote");
  assert.equal(frontend.posted_comp.max, null);
});

/* ---------------------------------------------------------------- workable */

test("workable: normalises the widget payload and takes the company name from it", async () => {
  const fetchJson = stubJson({ "apply.workable.com": fixture("workable.json") });
  const jobs = await workable.search({ boards: ["fernwood"] }, { fetchJson });

  assert.equal(jobs.length, 2);
  for (const j of jobs) assertRecordShape(j, "workable");

  const [fullstack, data] = jobs;
  assert.equal(fullstack.company, "Fernwood Instruments", "the account name, not the slug");
  assert.deepEqual(fullstack.domains, [], "a slug tells us nothing about a domain");
  assert.equal(fullstack.source_id, "A1B2C3D4E5");
  assert.equal(fullstack.apply.channel, "ats-workable");
  assert.match(fullstack.apply.target, /\/apply$/);
  assert.equal(fullstack.location, "Bristol, England, United Kingdom");
  assert.equal(fullstack.posted_comp.min, null, "the widget has no pay fields at all");

  assert.equal(data.workplace_type, "remote");
  assert.equal(data.seniority, "senior");
});

/* --------------------------------------------------------------------- HN */

test("hn: finds the monthly thread and parses top-level comments only", async () => {
  const fetchJson = stubJson({
    "/search?query=": fixture("hn-story.json"),
    "/search_by_date?tags=comment": fixture("hn-comments.json"),
  });

  const jobs = await hn.search({}, { fetchJson });
  for (const j of jobs) assertRecordShape(j, "hn");

  assert.ok(
    fetchJson.calls[1].includes("story_41000001"),
    "the newest 'Who is hiring' thread wins, not 'Who wants to be hired'",
  );
  assert.equal(jobs.length, 3, "one aside is unparseable and one hit is a reply, not a posting");
  assert.ok(
    !jobs.some((j) => j.company === "Umbra Systems"),
    "a reply to a posting is not a posting",
  );

  const [acme, northwind, tidepool] = jobs;

  assert.equal(acme.company, "Acme Robotics");
  assert.equal(acme.role, "Senior Backend Engineer");
  assert.equal(acme.location, "Berlin, Germany");
  assert.equal(acme.workplace_type, "onsite");
  assert.equal(acme.source, "hn");
  assert.equal(acme.source_id, "41000101");
  assert.equal(acme.url, "https://news.ycombinator.com/item?id=41000101");
  assert.equal(acme.apply.channel, "ats-greenhouse", "the posted link is recognised as a board");
  assert.equal(acme.apply.target, "https://boards.greenhouse.io/acmerobotics/jobs/4001");
  assert.equal(acme.apply.route_confidence, 0.8);
  assert.deepEqual(acme.domains, [], "a board host is not the company's domain");
  assert.deepEqual(acme.posted_comp, {
    currency: "EUR",
    min: 90000,
    max: 120000,
    period: "year",
    equity: null,
  });
  assert.equal(acme.evidence.length, 1);
  assert.equal(acme.evidence[0].kind, "route");

  assert.equal(northwind.company, "Northwind Labs");
  assert.equal(northwind.role, "Founding Engineer");
  assert.equal(northwind.seniority, "founding");
  assert.equal(northwind.apply.channel, "email");
  assert.equal(northwind.apply.target, "mailto:careers@northwind.example");
  assert.deepEqual(northwind.domains, ["northwind.example"]);
  assert.equal(northwind.workplace_type, "remote");
  assert.equal(northwind.posted_comp.min, null);

  // No pipes at all. The tolerant path has to survive prose.
  assert.equal(tidepool.company, "Tidepool Analytics");
  assert.equal(tidepool.role, "Senior Infrastructure Engineer");
  assert.equal(tidepool.apply.channel, "form");
  assert.equal(tidepool.apply.target, "https://tidepool.example/careers");
  assert.deepEqual(tidepool.domains, ["tidepool.example"]);
});

test("hn: an empty thread search is a schema alarm, not a quiet month", async () => {
  const fetchJson = stubJson({ "/search?query=": { hits: [] } });
  await assert.rejects(() => hn.search({}, { fetchJson }), /no 'Who is hiring' thread/);
});

/* ---------------------------------------------------------- remote boards */

test("remote-boards: one adapter, four boards, per-board provenance", async () => {
  const fetchJson = stubJson({
    "remoteok.com/api": fixture("remoteok.json"),
    "remotive.com/api": fixture("remotive.json"),
    "arbeitnow.com/api": fixture("arbeitnow.json"),
    "himalayas.app/jobs/api": fixture("himalayas.json"),
  });

  const jobs = await remoteBoards.search({}, { fetchJson });
  for (const j of jobs) assertRecordShape(j, "remote-boards");
  assert.equal(jobs.length, 8, "two per board, and the RemoteOK legal notice is not a job");
  assert.deepEqual(
    [...new Set(jobs.map((j) => j.source))],
    ["remoteok", "remotive", "arbeitnow", "himalayas"],
    "source names the board, so per-source caps mean what they say",
  );

  const harbourline = jobs.find((j) => j.company === "Harbourline");
  assert.equal(harbourline.workplace_type, "remote");
  assert.equal(harbourline.apply.channel, "form");
  assert.equal(harbourline.apply.route_confidence, 0.6);
  assert.deepEqual(harbourline.domains, ["harbourline.example"]);
  assert.deepEqual(harbourline.posted_comp, {
    currency: "USD",
    min: 110000,
    max: 150000,
    period: "year",
    equity: null,
  });
  assert.equal(harbourline.evidence[0].kind, "route");
  assert.match(harbourline.evidence[0].text, /aggregator/);

  const mossbank = jobs.find((j) => j.company === "Mossbank");
  assert.equal(mossbank.posted_comp.min, null, "a salary of 0 is not a salary");
  assert.equal(mossbank.apply.channel, "ats-greenhouse");
  assert.equal(mossbank.apply.route_confidence, 0.7);

  const quill = jobs.find((j) => j.company === "Quillfeather");
  assert.deepEqual(quill.posted_comp, {
    currency: "USD",
    min: 180000,
    max: 220000,
    period: "year",
    equity: null,
  });
  const ridgeway = jobs.find((j) => j.company === "Ridgeway Data");
  assert.equal(ridgeway.posted_comp.min, null, "an empty salary string parses to nothing");

  const lindenrock = jobs.find((j) => j.company === "Lindenrock");
  assert.equal(lindenrock.workplace_type, "hybrid");

  const saltmarsh = jobs.find((j) => j.company === "Saltmarsh");
  assert.equal(saltmarsh.seniority, "senior");
  assert.equal(saltmarsh.location, "United States, Canada");
  const petrichor = jobs.find((j) => j.company === "Petrichor");
  assert.equal(petrichor.seniority, "founding");
  assert.equal(petrichor.apply.channel, "ats-ashby");
});

test("remote-boards: opts.boards selects a subset and rejects an unknown name", async () => {
  const fetchJson = stubJson({ "himalayas.app": fixture("himalayas.json") });
  const jobs = await remoteBoards.search({ boards: ["himalayas"] }, { fetchJson });
  assert.equal(jobs.length, 2);
  assert.equal(fetchJson.calls.length, 1);

  await assert.rejects(
    () => remoteBoards.search({ boards: ["indeed"] }, { fetchJson }),
    /unknown board/,
  );
});

/* ------------------------------------------------------- capture adapters */

test("linkedin: parses a capture and never has a network path", async () => {
  const payload = fixture("linkedin-capture.json");
  const jobs = await linkedin.search({ payload });
  for (const j of jobs) assertRecordShape(j, "linkedin");

  assert.equal(jobs.length, 2);
  const [brackenridge, wrenfield] = jobs;

  assert.equal(brackenridge.company, "Brackenridge");
  assert.equal(brackenridge.source, "linkedin");
  assert.equal(brackenridge.source_id, "3901234567");
  assert.equal(brackenridge.apply.channel, "linkedin");
  assert.equal(brackenridge.apply.route_confidence, 0.8, "Easy Apply is a route we can see");
  assert.equal(brackenridge.workplace_type, "hybrid");
  assert.equal(brackenridge.posted_comp.min, null, "an estimated band is not posted comp");
  assert.match(brackenridge.notes, /90,000 - 120,000/);
  assert.equal(brackenridge.evidence[0].kind, "capture");

  // camelCase keys from a different extension build must still land.
  assert.equal(wrenfield.company, "Wrenfield");
  assert.equal(wrenfield.role, "Staff Engineer, Infrastructure");
  assert.equal(wrenfield.seniority, "staff");
  assert.equal(wrenfield.workplace_type, "remote");
  assert.equal(
    wrenfield.apply.route_confidence,
    0.4,
    "not Easy Apply means the real route is off-site and unresolved",
  );
});

test("linkedin: search with no payload throws instead of fetching", async () => {
  await assert.rejects(() => linkedin.search({}), /capture adapter and takes no network path/);
  await assert.rejects(() => linkedin.search(), /capture adapter and takes no network path/);
  await assert.rejects(
    () => linkedin.fetchOne("https://www.linkedin.com/jobs/view/3901234567/"),
    /capture adapter and takes no network path/,
  );
});

test("capture adapters have no network path in the source, not just a promise", () => {
  for (const file of ["linkedin.mjs", "capture.mjs"]) {
    const src = source(file);
    assert.ok(!/\bfetch\s*\(/.test(src), `${file} calls fetch`);
    assert.ok(!/fetchJson|fetchText|httpGet/.test(src), `${file} imports a network helper`);
    assert.ok(!/node:https?|XMLHttpRequest|undici/.test(src), `${file} reaches for a client`);
    assert.match(src, /export const kind = "capture"/, `${file} declares its kind`);
  }
});

test("capture: parses a justjoin.it capture and keeps an unstated pay period null", async () => {
  const payload = fixture("capture-justjoin.json");
  const jobs = await capture.search({ payload });
  for (const j of jobs) assertRecordShape(j, "capture");

  assert.equal(jobs.length, 2);
  const [backend, platform] = jobs;

  assert.equal(backend.company, "Wiatrak");
  assert.equal(backend.source, "justjoin");
  assert.equal(backend.apply.channel, "form");
  assert.equal(backend.workplace_type, "hybrid");
  assert.deepEqual(backend.posted_comp, {
    currency: "PLN",
    min: 18000,
    max: 25000,
    period: "month",
    equity: null,
  });
  assert.deepEqual(backend.domains, [], "the board's own host is not the employer's domain");

  // "22 000 - 28 000 PLN" does not say per what. Polish boards quote monthly far
  // more often than annually, and assuming either way is a factor of twelve.
  assert.equal(platform.posted_comp.period, null);
  assert.match(platform.notes, /period not stated/i);
});

test("capture: no payload throws, and an unknown source is refused", async () => {
  await assert.rejects(() => capture.search({}), /capture adapter and takes no network path/);
  await assert.rejects(
    () => capture.search({ payload: { source: "indeed", items: [] } }),
    /unknown payload source/,
  );
});

/* ------------------------------------------------------------ route resolver */

test("resolve-route: nothing reachable returns channel none, with the honest framing", async () => {
  const map = fixture("route-nothing-reachable.json");
  const fetchText = stubText(map);

  const route = await resolveRoute("ghostworks.example", { fetchText });

  assert.equal(route.channel, "none");
  assert.equal(route.target, null);
  assert.equal(route.route_confidence, 0);
  assert.deepEqual(route.candidates, []);
  assert.ok(route.evidence.length > 0, "a block must say what was looked at");

  const trail = route.evidence.map((e) => e.text).join("\n");
  assert.match(trail, /\/careers/, "the careers path was tried");
  assert.match(trail, /Probing ATS slugs/, "the slug probe ran");
  assert.match(
    trail,
    /statement about what is publicly visible, not proof they have no openings/,
    "the verdict is stated honestly",
  );

  // The probe stage really did try the boards rather than the sentence being decorative.
  assert.ok(fetchText.calls.some((u) => u.includes("api.ashbyhq.com/posting-api")));
  assert.ok(fetchText.calls.some((u) => u.includes("boards-api.greenhouse.io")));
  assert.ok(fetchText.calls.some((u) => u.includes("robots.txt")));
});

test("resolve-route: a board linked from the careers page wins and stops the search", async () => {
  const fetchText = stubText(fixture("route-linked-board.json"));
  const route = await resolveRoute("harbourline.example", { fetchText });

  assert.equal(route.channel, "ats-ashby");
  assert.equal(route.target, "https://jobs.ashbyhq.com/harbourline");
  assert.equal(route.route_confidence, 0.9);
  assert.match(route.evidence.at(-1).text, /careers page/);
  assert.ok(
    !fetchText.calls.some((u) => u.includes("api.ashbyhq.com/posting-api")),
    "no need to probe once the company has told us where its board is",
  );
});

test("resolve-route: a probed board scores low and is labelled identity-unverified", async () => {
  // The site is a shell, but the Ashby slug guessed from the domain is live.
  // This is the shape that found a real board behind a JavaScript-only site,
  // and it is also the shape of the nudge collision.
  const fetchText = async (url) => {
    if (url === "https://shellco.example/") {
      return { ok: true, status: 200, url, text: "<html><div id=root></div></html>" };
    }
    if (url.includes("api.ashbyhq.com/posting-api/job-board/shellco")) {
      return {
        ok: true,
        status: 200,
        url,
        text: JSON.stringify({ jobs: [{ id: "x", title: "Founding Engineer" }] }),
      };
    }
    return { ok: false, status: 404, url, text: "" };
  };

  const route = await resolveRoute("shellco.example", { fetchText });
  assert.equal(route.channel, "ats-ashby");
  assert.equal(route.target, "https://jobs.ashbyhq.com/shellco");
  assert.equal(route.route_confidence, 0.45, "a guessed slug is never a confident route");

  const why = route.candidates[0].why;
  assert.match(why, /slug was guessed/);
  assert.match(why, /collide across unrelated companies/);
  assert.equal(route.candidates[0].identity_unverified, true);
});

test("resolve-route: refuses something that is not a domain", async () => {
  await assert.rejects(
    () => resolveRoute("not a domain", { fetchText: stubText({}) }),
    /is not a domain/,
  );
});

/* --------------------------------------------------------- identity guard */

test("identity: the same-name collision is a block", () => {
  const { record, posting } = fixture("identity-cases.json").collision_same_name;
  const out = verifyIdentity({ record, posting });

  assert.equal(out.ok, false);
  assert.equal(out.reason, "identity-mismatch");
  assert.equal(out.identity_domain, null);

  const name = out.signals.find((s) => s.name === "name-match");
  const product = out.signals.find((s) => s.name === "product-match");
  assert.equal(name.value, true, "the name matches perfectly, which is the trap");
  assert.equal(product.value, false, "the product does not, which is the tell");
  assert.match(out.detail, /slug collision/);
});

test("identity: no signal at all is a block, not a pass", () => {
  const { record, posting } = fixture("identity-cases.json").no_signal_at_all;
  const out = verifyIdentity({ record, posting });

  assert.equal(out.ok, false);
  assert.equal(out.reason, "identity-unknown");
  assert.equal(out.identity_domain, null);
  assert.match(out.detail, /unverified identity blocks/);
  for (const s of out.signals) {
    assert.ok(s.value !== true, "nothing may be reported as a positive signal here");
  }
});

test("identity: a domain in the posting copy verifies", () => {
  const { record, posting } = fixture("identity-cases.json").verified_by_domain;
  const out = verifyIdentity({ record, posting });

  assert.equal(out.ok, true);
  assert.equal(out.reason, "identity-verified");
  assert.equal(out.identity_domain, "tidepool.example");
  assert.equal(out.signals.find((s) => s.name === "domain-in-copy").value, true);
});

test("identity: name plus product description verifies when no domain is named", () => {
  const { record, posting } = fixture("identity-cases.json").verified_by_name_and_product;
  const out = verifyIdentity({ record, posting });

  assert.equal(out.ok, true);
  assert.equal(out.identity_domain, "northwind.example");
  assert.equal(out.signals.find((s) => s.name === "domain-in-copy").value, false);
  assert.equal(out.signals.find((s) => s.name === "product-match").value, true);
});

test("identity: a posting naming somebody else's domain is a block", () => {
  const { record, posting } = fixture("identity-cases.json").foreign_domain;
  const out = verifyIdentity({ record, posting });

  assert.equal(out.ok, false);
  assert.equal(out.reason, "identity-mismatch");
  assert.match(out.detail, /umbra\.example/);
  assert.equal(out.signals.find((s) => s.name === "foreign-domain").value, true);
});

test("identity: an adapter record straight out of a board is not verified", async () => {
  // The default has to be block. A record that has never been checked must not
  // look checked, or the guard is decorative.
  const fetchJson = stubJson({ "api.ashbyhq.com": fixture("ashby.json") });
  const [job] = await ashby.search({ boards: ["tidepool"] }, { fetchJson });

  assert.equal(job.apply.identity_verified, false);
  const out = verifyIdentity({ record: job, posting: { description: "" } });
  assert.equal(out.ok, false);
});

/* ------------------------------------------------------ registry and shape */

test("registry: every adapter exports the contract", () => {
  const all = sources.adapters();
  assert.equal(all.length, 10, "ten adapters cover the ten sources in the spec");

  for (const a of all) {
    assert.equal(typeof a.id, "string", "id");
    assert.ok(["public-json", "capture"].includes(a.kind), `${a.id}: kind`);
    assert.equal(typeof a.match, "function", `${a.id}: match`);
    assert.equal(typeof a.search, "function", `${a.id}: search`);
    assert.equal(typeof a.fetchOne, "function", `${a.id}: fetchOne`);
    assert.equal(a.match(""), false, `${a.id}: match of nothing is false`);
    assert.equal(a.match(null), false, `${a.id}: match of null is false`);
  }
  assert.equal(new Set(all.map((a) => a.id)).size, all.length, "ids are unique");
});

test("registry: URLs route to the adapter that owns them", () => {
  const cases = [
    ["https://boards.greenhouse.io/acmerobotics/jobs/4001", "greenhouse", "ats-greenhouse"],
    ["https://jobs.lever.co/northwind/8f21b0c4", "lever", "ats-lever"],
    ["https://jobs.ashbyhq.com/tidepool/4bb75392", "ashby", "ats-ashby"],
    ["https://jobs.smartrecruiters.com/UmbraSystems/744000012345678", "smartrecruiters", "ats-smartrecruiters"],
    ["https://kestrelhealth.recruitee.com/o/platform-engineer", "recruitee", "ats-recruitee"],
    ["https://apply.workable.com/fernwood/j/A1B2C3D4E5", "workable", "ats-workable"],
    ["https://news.ycombinator.com/item?id=41000101", "hn", null],
    ["https://remoteok.com/remote-jobs/1099001", "remote-boards", null],
    ["https://www.linkedin.com/jobs/view/3901234567/", "linkedin", "linkedin"],
    ["https://justjoin.it/offers/wiatrak-backend-engineer", "capture", null],
  ];
  for (const [url, id, channel] of cases) {
    assert.equal(sources.adapterForUrl(url)?.id, id, url);
    assert.equal(sources.channelForUrl(url), channel, url);
  }
  assert.equal(sources.adapterForUrl("https://example.com/careers"), null);

  // A record's source resolves back to the file that produced it, including
  // the sources that live behind a shared adapter.
  assert.equal(sources.adapterForSource("remoteok")?.id, "remote-boards");
  assert.equal(sources.adapterForSource("justjoin")?.id, "capture");
  assert.equal(sources.adapterForSource("ashby")?.id, "ashby");
});

test("normalise: enforces the enums and refuses to invent a company", () => {
  const base = {
    company: "Acme Robotics",
    role: "Backend Engineer",
    source: "test",
    source_id: "1",
    url: "https://acme.example/jobs/1",
  };

  assert.throws(() => sources.normalise({ ...base, company: null }), /company missing/);
  assert.throws(() => sources.normalise({ ...base, role: undefined }), /role missing/);
  assert.throws(
    () => sources.normalise({ ...base, apply: { channel: "carrier-pigeon" } }),
    /unknown apply\.channel/,
  );
  assert.throws(
    () => sources.normalise({ ...base, workplace_type: "office-ish" }),
    /unknown workplace_type/,
  );
  assert.throws(
    () => sources.normalise({ ...base, posted_comp: { period: "fortnight" } }),
    /unknown posted_comp\.period/,
  );

  const rec = sources.normalise(base);
  assertRecordShape(rec, "normalise");
  assert.equal(rec.workplace_type, "unknown", "unknown is a real answer, not a null");
  assert.equal(rec.apply.channel, "none");
  assert.equal(rec.seniority, null);
  assert.deepEqual(rec.domains, []);
});

test("normalise: ids stay unique inside a batch", () => {
  const one = {
    company: "Acme Robotics",
    role: "Backend Engineer",
    source: "test",
    source_id: "1",
    url: "https://acme.example/jobs/1",
  };
  const ids = sources
    .normaliseAll([one, { ...one, source_id: "2" }, { ...one, source_id: "3" }])
    .map((r) => r.id);
  assert.deepEqual(ids, [
    "acme-robotics-backend-engineer",
    "acme-robotics-backend-engineer-2",
    "acme-robotics-backend-engineer-3",
  ]);
});

/* -------------------------------------------------------- the shared fetch */

/**
 * The one piece every adapter depends on in production and no fixture touches.
 * globalThis.fetch is replaced for the duration, so this still reaches nothing.
 */
test("http: retries a 500, sends a descriptive agent, and fails loudly on non-JSON", async () => {
  const original = globalThis.fetch;
  try {
    let calls = 0;
    let sentAgent = null;
    globalThis.fetch = async (_url, init) => {
      calls++;
      sentAgent = init.headers["user-agent"];
      if (calls === 1) return new Response("upstream hiccup", { status: 500 });
      return new Response(JSON.stringify({ jobs: [] }), { status: 200 });
    };

    const payload = await sources.fetchJson("https://boards-api.greenhouse.io/v1/boards/x/jobs");
    assert.deepEqual(payload, { jobs: [] });
    assert.equal(calls, 2, "a 500 is worth one more try");
    assert.match(sentAgent, /career-kit/, "boards deserve to know who is calling");

    calls = 0;
    globalThis.fetch = async () => {
      calls++;
      return new Response("<html>Not Found</html>", { status: 404 });
    };
    await assert.rejects(
      () => sources.fetchJson("https://boards-api.greenhouse.io/v1/boards/x/jobs"),
      /HTTP 404/,
    );
    assert.equal(calls, 1, "a 404 is an answer, not a flake");

    // A proxy or a captive portal answering with HTML is the failure that
    // otherwise shows up as "this company has no openings".
    globalThis.fetch = async () => new Response("<html>hello</html>", { status: 200 });
    await assert.rejects(
      () => sources.fetchJson("https://boards-api.greenhouse.io/v1/boards/x/jobs"),
      /not JSON/,
    );

    // fetchText is the resolver's tool and must report a miss rather than throw.
    globalThis.fetch = async () => new Response("", { status: 404 });
    const res = await sources.fetchText("https://ghostworks.example/careers", { retries: 0 });
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
  } finally {
    globalThis.fetch = original;
  }
});

test("no source file carries an em dash", () => {
  const EM_DASH = String.fromCharCode(0x2014);
  const files = [
    "index.mjs",
    "greenhouse.mjs",
    "lever.mjs",
    "ashby.mjs",
    "smartrecruiters.mjs",
    "recruitee.mjs",
    "workable.mjs",
    "hn-whoishiring.mjs",
    "remote-boards.mjs",
    "linkedin.mjs",
    "capture.mjs",
    "resolve-route.mjs",
    "identity.mjs",
  ];
  for (const f of files) {
    // Built from a code point so this test file does not contain the character
    // it is banning.
    assert.ok(!source(f).includes(EM_DASH), `${f} contains an em dash`);
  }
});
