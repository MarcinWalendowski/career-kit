/**
 * db.test.mjs - the MACHINE_COLS contract, and orphan reconciliation.
 *
 * The load-bearing test here is "a rebuild does not overwrite a human column".
 * If that ever breaks, a person loses the stage they typed the moment they add
 * a job record, and after that they stop typing stages, and the tracker is a
 * slower way to read the jobs directory.
 *
 * Everything runs the engine as a subprocess. node:sqlite is behind a flag on
 * some Node 22 releases and db.mjs re-execs itself to deal with that; driving
 * it through the CLI means the tests exercise that path too.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { makeWorkspace, sendOnce, DEFAULT_JOB_ID } from "./helpers.mjs";

const ID = DEFAULT_JOB_ID;

function ws(t, opts) {
  const w = makeWorkspace(opts);
  t.after(() => w.cleanup());
  return w;
}

/** `log.mjs show <id>` prints "  key: value" per non-empty column. */
function field(showStdout, key) {
  const line = showStdout.split("\n").find((l) => l.trim().startsWith(`${key}: `));
  return line ? line.trim().slice(key.length + 2) : null;
}

test("a rebuild builds the pipeline from jobs/*.json", (t) => {
  const w = ws(t);
  const r = w.db(["--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.created, true);
  assert.equal(r.json.records, 1);
  assert.equal(r.json.invalid.length, 0);
  assert.equal(r.json.orphans.length, 0);

  const show = w.log(["show", ID]);
  assert.equal(show.code, 0, show.stderr);
  assert.equal(field(show.stdout, "role"), "Founding Software Engineer");
  assert.equal(field(show.stdout, "channel"), "email");
  // Posted comp comes off the job record now, written by the adapter that read
  // the posting. It used to come from a dict of literals in the build script,
  // one hardcoded entry per application, which no second user could ever have.
  assert.equal(field(show.stdout, "comp_min"), "180000");
  assert.equal(field(show.stdout, "comp_currency"), "USD");
  assert.equal(field(show.stdout, "equity"), "0.5%");
});

test("a rebuild NEVER overwrites a human column", (t) => {
  const w = ws(t);
  assert.equal(w.db().code, 0);

  // Human-owned: stage, priority, salary expectation, next action, notes.
  assert.equal(w.log(["stage", ID, "interview"]).code, 0);
  assert.equal(w.log(["expect", ID, "180000", "220000", "--currency", "USD", "--note", "open on equity"]).code, 0);
  assert.equal(w.log(["next", ID, "confirm the Thursday slot", "--due", "2026-08-03"]).code, 0);
  assert.equal(w.log(["note", ID, "CTO built their agent harness in-house"]).code, 0);

  const rebuilt = w.db(["--json"]);
  assert.equal(rebuilt.code, 0, rebuilt.stderr);
  assert.equal(rebuilt.json.created, false);

  const show = w.log(["show", ID]).stdout;
  assert.equal(field(show, "stage"), "interview");
  assert.equal(field(show, "expect_min"), "180000");
  assert.equal(field(show, "expect_notes"), "open on equity");
  assert.equal(field(show, "next_action"), "confirm the Thursday slot");
  assert.equal(field(show, "human_notes"), "CTO built their agent harness in-house");
});

test("a rebuild DOES refresh a machine column", (t) => {
  const w = ws(t);
  assert.equal(w.db().code, 0);
  w.writeJob({ role: "Staff Engineer", location: "Remote (EU)" });
  assert.equal(w.db().code, 0);

  const show = w.log(["show", ID]).stdout;
  assert.equal(field(show, "role"), "Staff Engineer");
  assert.equal(field(show, "location"), "Remote (EU)");
});

test("a row whose job file vanished is reported and flagged, not silently kept and not deleted", (t) => {
  const w = ws(t);
  assert.equal(w.db().code, 0);
  assert.equal(w.log(["stage", ID, "interview"]).code, 0);

  rmSync(w.job(ID));
  const r = w.db(["--json"]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.records, 0);
  assert.equal(r.json.orphans.length, 1);
  assert.equal(r.json.orphans[0].id, ID);
  assert.match(r.stderr, /orphaned/);

  // Kept: the row still holds the history, and a missing job file is usually a
  // mistake rather than a decision.
  const show = w.log(["show", ID]);
  assert.equal(show.code, 0);
  assert.equal(field(show.stdout, "orphaned"), "1");
  assert.equal(field(show.stdout, "stage"), "interview");
});

test("--prune is the opt-in that actually deletes an orphan", (t) => {
  const w = ws(t);
  assert.equal(w.db().code, 0);
  rmSync(w.job(ID));
  const r = w.db(["--json", "--prune"]);
  assert.equal(r.json.pruned, 1);
  assert.equal(w.log(["show", ID]).code, 2);
});

test("restoring the job file clears the orphan flag", (t) => {
  const w = ws(t);
  const original = readFileSync(w.job(ID), "utf8");
  assert.equal(w.db().code, 0);
  rmSync(w.job(ID));
  assert.equal(w.db(["--json"]).json.orphans.length, 1);
  writeFileSync(w.job(ID), original);
  const r = w.db(["--json"]);
  assert.equal(r.json.orphans.length, 0);
  assert.equal(field(w.log(["show", ID]).stdout, "orphaned"), null); // 0 is not printed
});

test("the send becomes the first outbound event, and a second rebuild does not duplicate it", (t) => {
  const w = ws(t);
  assert.equal(sendOnce(w, { extra: ["--subject", "Founding Software Engineer"] }).code, 0);
  assert.equal(w.db().code, 0);
  assert.equal(w.db().code, 0);

  const show = w.log(["show", ID]).stdout;
  const events = show.split("history")[1].split("\n").filter((l) => l.includes("->"));
  assert.equal(events.length, 1, "the idempotent-event index kept the rebuild from duplicating it");
  assert.equal(field(show, "send_status"), "sent");
});

test("an inbound message moves applied to replied, and shows up in todo", (t) => {
  const w = ws(t);
  assert.equal(sendOnce(w).code, 0);
  assert.equal(w.db().code, 0);

  assert.equal(w.log(["todo"]).stdout.trim(), "nothing waiting on a reply");
  assert.equal(w.log(["in", ID, "Wants a call Thursday", "--channel", "email"]).code, 0);
  assert.equal(field(w.log(["show", ID]).stdout, "stage"), "replied");
  assert.match(w.log(["todo"]).stdout, /Wants a call Thursday/);

  assert.equal(w.log(["out", ID, "Sent times for Thu and Fri"]).code, 0);
  assert.equal(w.log(["todo"]).stdout.trim(), "nothing waiting on a reply");
});

test("an inbound message does NOT rewind a stage a human already moved", (t) => {
  const w = ws(t);
  assert.equal(w.db().code, 0);
  assert.equal(w.log(["stage", ID, "offer"]).code, 0);
  assert.equal(w.log(["in", ID, "Offer letter attached"]).code, 0);
  assert.equal(field(w.log(["show", ID]).stdout, "stage"), "offer");
});

test("the seeded stage tells the truth about what was actually sent", (t) => {
  // The schema DEFAULT is 'applied', which was right where every row WAS an
  // application. Here jobs/ also holds roles that were merely discovered, so
  // taking the default would report applications that were never made.
  const w = ws(t, {
    job: { status: "discovered" },
    jobs: [
      { id: "eastwind-backend-engineer", company: "Eastwind", company_id: "eastwind", domains: ["eastwind.example"], role: "Backend Engineer", status: "sent", sent_at: "2026-07-28T09:00:00Z", sent_at_source: "transport" },
      { id: "westwind-platform-engineer", company: "Westwind", company_id: "westwind", domains: ["westwind.example"], role: "Platform Engineer", status: "skipped" },
    ],
  });
  assert.equal(w.db().code, 0);
  assert.equal(field(w.log(["show", ID]).stdout, "stage"), "discovered");
  assert.equal(field(w.log(["show", "eastwind-backend-engineer"]).stdout, "stage"), "applied");
  assert.equal(field(w.log(["show", "westwind-platform-engineer"]).stdout, "stage"), "closed");
});

test("every pre-send seeded stage advances to applied on the first send", (t) => {
  // Seeding alone would leave a sent application reporting "discovered" forever,
  // which understates what you did just as badly as the old default overstated
  // it. Every pre-send seed value has to be covered, not just one of them.
  for (const status of ["discovered", "screened", "drafted", "claimed", "failed"]) {
    const w = ws(t, { job: { status } });
    assert.equal(w.db().code, 0);
    const seeded = field(w.log(["show", ID]).stdout, "stage");
    assert.ok(["discovered", "draft"].includes(seeded), `status "${status}" seeded stage "${seeded}"`);
    assert.equal(sendOnce(w).code, 0);
    assert.equal(w.db().code, 0);
    assert.equal(
      field(w.log(["show", ID]).stdout, "stage"),
      "applied",
      `an application sent from status "${status}" was left stranded at "${seeded}"`,
    );
  }
});

test("a seeded stage advances to applied on the first send, once", (t) => {
  const w = ws(t, { job: { status: "discovered" } });
  assert.equal(w.db().code, 0);
  assert.equal(field(w.log(["show", ID]).stdout, "stage"), "discovered");

  assert.equal(sendOnce(w).code, 0);
  assert.equal(w.db().code, 0);
  assert.equal(field(w.log(["show", ID]).stdout, "stage"), "applied");

  // And it does not keep advancing over a human's later edit.
  assert.equal(w.log(["stage", ID, "interview"]).code, 0);
  assert.equal(w.db().code, 0);
  assert.equal(field(w.log(["show", ID]).stdout, "stage"), "interview");
});

test("a stage a human typed is never advanced by a send", (t) => {
  const w = ws(t, { job: { status: "discovered" } });
  assert.equal(w.db().code, 0);
  assert.equal(w.log(["stage", ID, "screening"]).code, 0);
  assert.equal(sendOnce(w).code, 0);
  assert.equal(w.db().code, 0);
  assert.equal(field(w.log(["show", ID]).stdout, "stage"), "screening");
});

test("db.mjs accepts the rebuild verb and rejects anything else positional", (t) => {
  const w = ws(t);
  assert.equal(w.db(["rebuild"]).code, 0);
  assert.equal(w.db(["rebuild", "--json"]).json.records, 1);
  const stray = w.db(["rebiuld"]);
  assert.equal(stray.code, 2, "a typo'd verb must not fall through as a silent no-op");
  assert.match(stray.stderr, /unknown argument/);
});

test("every stage db.mjs knows about is accepted by the CHECK constraint in schema.sql", (t) => {
  // The two lists used to disagree: eleven values in one file, nine in another,
  // and the nine were not a subset. This test is the thing that notices.
  const w = ws(t);
  assert.equal(w.db().code, 0);
  const stages = ["draft", "applied", "replied", "screening", "interview", "offer",
    "rejected", "withdrawn", "closed", "no_response", "no_route"];
  for (const stage of stages) {
    const r = w.log(["stage", ID, stage]);
    assert.equal(r.code, 0, `stage "${stage}" was rejected: ${r.stderr}`);
    assert.equal(field(w.log(["show", ID]).stdout, "stage"), stage);
  }
  const bogus = w.log(["stage", ID, "ghosted"]);
  assert.equal(bogus.code, 2);
  assert.match(bogus.stderr, /unknown stage/);
});

test("a record that fails the schema is ingested AND reported, never silently dropped", (t) => {
  const w = ws(t);
  const rec = JSON.parse(readFileSync(w.job(ID), "utf8"));
  rec.apply.channel = "linkedin (preferred, draft) + ashby form staged + email draft";
  writeFileSync(w.job(ID), JSON.stringify(rec, null, 2));

  const r = w.db(["--json"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.records, 1, "still ingested: a tracker quietly holding fewer rows than jobs/ is worse");
  assert.equal(r.json.invalid.length, 1);
  assert.match(r.stderr, /does not match the job schema/);
  assert.match(r.stderr, /validate\.mjs --fix/);
});

test("log rejects a naive --ts and an inverted salary range", (t) => {
  const w = ws(t);
  assert.equal(w.db().code, 0);
  const naive = w.log(["in", ID, "hello", "--ts", "2026-07-28T12:00:00"]);
  assert.equal(naive.code, 2);
  assert.match(naive.stderr, /timezone/);
  assert.equal(w.log(["expect", ID, "220000", "180000"]).code, 2);
});

test("log names the known ids when asked about one that does not exist", (t) => {
  const w = ws(t);
  assert.equal(w.db().code, 0);
  const r = w.log(["stage", "not-a-real-id", "interview"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, new RegExp(ID));
});
