/**
 * board.test.mjs - the scout board.
 *
 * Two of these are the reason the file exists, and both are negative controls
 * rather than happy paths:
 *
 *   1. A posting at a company that already has an application out must not be
 *      offered as fresh work. That is a bug with a cost: applying to it spends
 *      the company's single application on a duplicate. The control is the
 *      matching case where the same two postings sit at DIFFERENT companies and
 *      must NOT be blocked, because a function that blocks everything passes the
 *      first assertion and is useless.
 *
 *   2. The page and the importer must refuse the same rows. They are two
 *      surfaces over one rule, they were written separately, and they disagreed
 *      within an hour: the browser greyed out a company with a parked
 *      application and `apply` accepted the same row from a hand-edited file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeWorkspace, DEFAULT_JOB_ID, EM_DASH } from "./helpers.mjs";
import { paths } from "../engine/paths.mjs";
import { collect, applyVerdicts } from "../engine/board.mjs";

const P = (ws) => paths(ws.home);
const rowOf = (data, id) => data.rows.find((r) => r.id === id);

/** The board's embedded row data, read back out of the generated page. */
function embedded(html) {
  const m = html.match(/<script type="application\/json" id="rows">([\s\S]*?)<\/script>/);
  assert.ok(m, "the page carries no embedded row data");
  return JSON.parse(m[1]);
}

function writeLease(ws, { id = DEFAULT_JOB_ID, channel = "email", expiresAt }) {
  mkdirSync(ws.leases, { recursive: true });
  writeFileSync(
    ws.lease(id, channel),
    JSON.stringify({ id, channel, token: "abc", claimed_at: "2026-08-01T10:00:00Z", expires_at: expiresAt }) + "\n",
  );
}

/* ─────────────────────────────────────────────────────────── the page ── */

test("render writes the page and counts what is actually in jobs/", async (t) => {
  const ws = makeWorkspace({
    job: { status: "sent", sent_at: "2026-08-01T10:00:00Z" },
    jobs: [{ id: "acme-staff", company: "Acme", company_id: "acme", role: "Staff Engineer", status: "discovered" }],
  });
  t.after(ws.cleanup);

  const r = ws.board([]);
  assert.equal(r.code, 0, r.stderr);

  const out = join(ws.home, "outputs", "board.html");
  assert.ok(existsSync(out), "board.html was not written");
  const html = readFileSync(out, "utf8");
  const data = embedded(html);

  assert.equal(data.rows.length, 2);
  assert.equal(data.counts.applied, 1);
  assert.equal(data.counts.new, 1);
});

test("a company already spoken for does not offer its other postings as fresh work", async (t) => {
  const ws = makeWorkspace({
    job: { status: "sent", sent_at: "2026-08-01T10:00:00Z" },
    jobs: [{ id: "northwind-second", role: "Senior Frontend Engineer", status: "discovered" }],
  });
  t.after(ws.cleanup);

  const data = await collect(P(ws));
  const sibling = rowOf(data, "northwind-second");

  assert.equal(sibling.state, "new", "the sibling has its own state and keeps it");
  assert.equal(sibling.company_state, "applied", "...and carries what the company did");
  assert.match(sibling.shortlist_block, /already has an application out/);
  assert.equal(data.companies_spoken_for, 1);
});

test("...and the control: the same two postings at different companies are both open", async (t) => {
  // Without this, a shortlist_block that returned a string unconditionally would
  // pass the test above. The only difference from it is company_id.
  const ws = makeWorkspace({
    job: { status: "sent", sent_at: "2026-08-01T10:00:00Z" },
    jobs: [{ id: "acme-second", company: "Acme", company_id: "acme", role: "Senior Frontend Engineer", status: "discovered" }],
  });
  t.after(ws.cleanup);

  const data = await collect(P(ws));
  const other = rowOf(data, "acme-second");

  assert.equal(other.company_state, null);
  assert.equal(other.shortlist_block, null, "a different company is not blocked by this one");
  assert.equal(data.companies_spoken_for, 1, "one of two companies is spoken for");
});

test("a posting parked mid-application blocks its siblings too, not just a sent one", async (t) => {
  // The case that actually happened: an application filled in as far as it could
  // go and abandoned at a question only the owner could answer. Nothing was
  // sent, so a rule keyed on "sent" reads the company as untouched.
  const ws = makeWorkspace({
    job: { status: "failed" },
    jobs: [{ id: "northwind-second", role: "Senior Frontend Engineer", status: "discovered" }],
  });
  t.after(ws.cleanup);

  const data = await collect(P(ws));
  assert.equal(rowOf(data, DEFAULT_JOB_ID).state, "needs-you");
  assert.equal(rowOf(data, "northwind-second").company_state, "parked");
  assert.match(rowOf(data, "northwind-second").shortlist_block, /parked mid-application/);
});

test("a drafted sibling warns and does not block: nothing has gone out yet", async (t) => {
  const ws = makeWorkspace({
    job: { status: "drafted" },
    jobs: [{ id: "northwind-second", role: "Senior Frontend Engineer", status: "discovered" }],
  });
  t.after(ws.cleanup);

  const data = await collect(P(ws));
  const sibling = rowOf(data, "northwind-second");
  assert.equal(sibling.company_state, "drafted", "the reader is told");
  assert.equal(sibling.shortlist_block, null, "and is not stopped, because no application exists");
});

test("lease expiry is read off the lease, not recomputed from today's rules", async (t) => {
  const ws = makeWorkspace({ job: { status: "discovered" } });
  t.after(ws.cleanup);

  writeLease(ws, { expiresAt: "2026-08-01T10:10:00Z" });
  let data = await collect(P(ws), { now: Date.parse("2026-08-01T10:05:00Z") });
  assert.equal(rowOf(data, DEFAULT_JOB_ID).state, "in-flight");

  data = await collect(P(ws), { now: Date.parse("2026-08-01T11:00:00Z") });
  const row = rowOf(data, DEFAULT_JOB_ID);
  assert.equal(row.state, "needs-you", "an expired lease is somebody's job, not a tidy-up");
  assert.match(row.locked, /gate resolve/,
    "skipping a row in this state buries the only row on the page that cannot be left alone");
});

test("a sent record with no receipt reads as unproven, and still covers its company", async (t) => {
  const ws = makeWorkspace({
    job: { status: "sent-unverified", sent_at: "2026-08-01T10:00:00Z", needs_human: true },
    jobs: [{ id: "northwind-second", role: "Senior Frontend Engineer", status: "discovered" }],
  });
  t.after(ws.cleanup);

  const data = await collect(P(ws));
  assert.equal(rowOf(data, DEFAULT_JOB_ID).state, "unproven");
  // It went out. Whether anyone can prove it is a separate problem from whether
  // the company may be written to again.
  assert.equal(rowOf(data, "northwind-second").company_state, "applied");
});

/* ──────────────────────────────────────────────── the page's own honesty ── */

test("with no career.db the page says the stages are machine status only", async (t) => {
  const ws = makeWorkspace();
  t.after(ws.cleanup);

  const data = await collect(P(ws));
  assert.equal(data.human_state.read, false);
  assert.match(data.human_state.why, /career\.db/);

  ws.board([]);
  const html = readFileSync(join(ws.home, "outputs", "board.html"), "utf8");
  assert.match(html, /Stages are machine status only/,
    "a board that cannot read the human column must say so, not quietly show the machine one");
});

test("a company name cannot break out of the embedded JSON", async (t) => {
  // Job data is scraped off the open web. Assume every field is hostile.
  const PAYLOAD = 'Acme </script><script>window.pwned=1</script>';
  const ws = makeWorkspace({ job: { company: PAYLOAD, company_id: "acme" } });
  t.after(ws.cleanup);

  ws.board([]);
  const html = readFileSync(join(ws.home, "outputs", "board.html"), "utf8");

  assert.ok(!/<script>window\.pwned/.test(html), "the payload reached the page as live markup");
  // The real control, and the reason the assertion above is not enough on its
  // own: the payload's own "</script>" would close the data block early, so a
  // missing escape truncates the JSON and this parse throws. Asserting that the
  // string is absent would fail for the escaped-and-safe case too, since the
  // characters are still there, just inert.
  assert.equal(embedded(html).rows[0].company, PAYLOAD, "...and it is still readable as data");
});

test("the generated page contains no em dash", async (t) => {
  const ws = makeWorkspace();
  t.after(ws.cleanup);
  ws.board([]);
  const html = readFileSync(join(ws.home, "outputs", "board.html"), "utf8");
  assert.equal(html.indexOf(EM_DASH), -1, "the product bans this character for the user");
});

/* ────────────────────────────────────────────────────────── the importer ── */

test("apply moves a record between the three statuses it owns, and stamps why", async (t) => {
  const ws = makeWorkspace({
    job: { status: "discovered" },
    jobs: [{ id: "acme-staff", company: "Acme", company_id: "acme", role: "Staff Engineer", status: "discovered" }],
  });
  t.after(ws.cleanup);

  const report = applyVerdicts(P(ws), { shortlist: [DEFAULT_JOB_ID], skip: ["acme-staff"] }, { now: Date.parse("2026-08-03T12:00:00Z") });

  assert.equal(report.changed.length, 2);
  assert.equal(report.refused.length, 0);
  assert.equal(ws.readJob(DEFAULT_JOB_ID).status, "screened");
  assert.equal(ws.readJob("acme-staff").status, "skipped");

  const [entry] = ws.readJob(DEFAULT_JOB_ID).evidence;
  assert.equal(entry.kind, "board-verdict");
  assert.equal(entry.at, "2026-08-03T12:00:00.000Z", "the engine stamps this, never the browser clock");
});

test("apply refuses what it cannot own, and names each refusal", async (t) => {
  const ws = makeWorkspace({
    job: { status: "sent", sent_at: "2026-08-01T10:00:00Z" },
    jobs: [{ id: "acme-staff", company: "Acme", company_id: "acme", role: "Staff Engineer", status: "drafted" }],
  });
  t.after(ws.cleanup);

  const report = applyVerdicts(P(ws), { shortlist: ["ghost"], skip: [DEFAULT_JOB_ID, "acme-staff"] });

  assert.equal(report.changed.length, 0);
  assert.equal(report.refused.length, 3);
  const why = Object.fromEntries(report.refused.map((r) => [r.id, r.why]));
  assert.match(why.ghost, /no jobs\/<id>\.json/);
  assert.match(why[DEFAULT_JOB_ID], /"sent"/);
  assert.match(why["acme-staff"], /"drafted"/);
  // Reported, not dropped. A verdict file that quietly did less than it said is
  // how somebody comes to believe a role was screened out.
  assert.equal(ws.readJob("acme-staff").status, "drafted");
});

test("apply --dry-run changes nothing on disk", async (t) => {
  const ws = makeWorkspace({ job: { status: "discovered" } });
  t.after(ws.cleanup);

  const before = readFileSync(ws.job(), "utf8");
  const report = applyVerdicts(P(ws), { shortlist: [DEFAULT_JOB_ID] }, { dryRun: true });

  assert.equal(report.changed.length, 1, "it still reports what it would do");
  assert.equal(readFileSync(ws.job(), "utf8"), before);
});

test("the page and the importer refuse exactly the same rows", async (t) => {
  // The drift test. Every row the page would grey out, `apply` must refuse, and
  // every row it leaves live, `apply` must accept. This is the assertion that
  // makes one rule out of two surfaces.
  const ws = makeWorkspace({
    job: { status: "sent", sent_at: "2026-08-01T10:00:00Z" },        // sent
    jobs: [
      { id: "northwind-second", role: "Senior Frontend Engineer", status: "discovered" },  // covered
      { id: "acme-parked", company: "Acme", company_id: "acme", role: "Platform Engineer", status: "failed" },
      { id: "acme-staff", company: "Acme", company_id: "acme", role: "Staff Engineer", status: "discovered" },
      { id: "bravo-one", company: "Bravo", company_id: "bravo", role: "Product Engineer", status: "discovered" },
    ],
  });
  t.after(ws.cleanup);

  const data = await collect(P(ws));
  const blocked = data.rows.filter((r) => r.shortlist_block).map((r) => r.id).sort();
  const open = data.rows.filter((r) => !r.shortlist_block).map((r) => r.id).sort();

  assert.deepEqual(blocked, ["acme-parked", "acme-staff", DEFAULT_JOB_ID, "northwind-second"].sort());
  assert.deepEqual(open, ["bravo-one"]);

  const report = applyVerdicts(P(ws), { shortlist: [...blocked, ...open] }, { dryRun: true });
  assert.deepEqual(report.refused.map((r) => r.id).sort(), blocked);
  assert.deepEqual(report.changed.map((r) => r.id), open);
});

/* ─────────────────────────────────────────────────────────────── the CLI ── */

test("the CLI reports the same numbers the page draws", async (t) => {
  const ws = makeWorkspace({
    job: { status: "sent", sent_at: "2026-08-01T10:00:00Z" },
    jobs: [{ id: "acme-staff", company: "Acme", company_id: "acme", role: "Staff Engineer", status: "discovered" }],
  });
  t.after(ws.cleanup);

  const r = ws.board(["--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.row_count, 2);
  assert.equal(r.json.counts.applied, 1);
  assert.equal(r.json.human_state.read, false);

  const html = readFileSync(r.json.out, "utf8");
  assert.equal(embedded(html).rows.length, r.json.row_count);
});

test("an unreadable job record is reported on the page, not dropped from it", async (t) => {
  const ws = makeWorkspace();
  t.after(ws.cleanup);
  writeFileSync(join(ws.home, "jobs", "broken.json"), "{ not json");

  const r = ws.board(["--json"]);
  assert.equal(r.json.unreadable.length, 1);
  assert.equal(r.json.unreadable[0].file, "broken.json");

  const html = readFileSync(r.json.out, "utf8");
  assert.match(html, /could not be read/, "a silently missing row is a board that undercounts");
});

test("an unknown flag is a usage error, not a silent no-op", async (t) => {
  const ws = makeWorkspace();
  t.after(ws.cleanup);
  const r = ws.board(["--jsno"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown flag/);
});
