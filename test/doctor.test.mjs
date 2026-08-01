/**
 * doctor.test.mjs - the readiness probe, and the claim it is not allowed to make.
 *
 * The load-bearing test in this file is the last one. doctor cannot see the
 * agent's live MCP tool list - it is a zero-dependency node process reading
 * config files - so a mail verdict of "none" is evidence of absence in the
 * files it can read, and nothing more. If `authoritative` ever silently flips
 * to true, or the caveat is dropped from the payload, a skill downstream will
 * start telling users they have no mail tool while holding one.
 *
 * The exit-code split matters too, and is easy to get backwards: 1 is a
 * workspace that works and has homework, 2 is no workspace at all. A doctor
 * that returns 2 for an unfilled profile turns "you have three [[FILL]]
 * markers" into "you are not set up", and the fix for those is not the same.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { makeEmptyDir, makeWorkspace, runSync, INIT, DOCTOR, DEFAULT_JOB_ID } from "./helpers.mjs";

const doctor = (home) => runSync(home, DOCTOR, ["--json"]);

function provisioned(t) {
  const home = makeEmptyDir(t);
  runSync(home, INIT, ["--no-git"]);
  return home;
}

/* ── exit codes ────────────────────────────────────────────────────────── */

test("no workspace exits 2 and says how to get one", (t) => {
  const home = join(makeEmptyDir(t), "nothing-here");
  const r = doctor(home);

  assert.equal(r.code, 2);
  assert.equal(r.json.workspace.exists, false);
  assert.match(r.json.next, /career-setup|init/);
});

test("a workspace with homework exits 1, not 2", (t) => {
  const home = provisioned(t);
  const r = doctor(home);

  assert.equal(r.code, 1, "degraded, because the scaffold still has [[FILL]] markers");
  assert.equal(r.json.workspace.exists, true, "but it IS a workspace");
  assert.ok(r.json.fill_total > 0);
});

test("a filled workspace exits 0", (t) => {
  const w = makeWorkspace();
  t.after(() => w.cleanup());
  const r = w.doctor();

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.fill_total, 0);
  assert.match(r.json.next, /Ready/);
});

/* ── what it reports ───────────────────────────────────────────────────── */

test("the fill count tracks the file, not a constant", (t) => {
  const home = provisioned(t);
  const before = doctor(home).json.files["knowledge-base.md"].fill;
  assert.ok(before > 0);

  const kb = join(home, "knowledge-base.md");
  writeFileSync(kb, readFileSync(kb, "utf8").replace(/\[\[FILL\]\]/, "a real fact"));

  assert.equal(doctor(home).json.files["knowledge-base.md"].fill, before - 1);
});

test("a missing file is reported as missing, and named in the next action", (t) => {
  const home = provisioned(t);
  rmSync(join(home, "voice.md"));

  const r = doctor(home);
  assert.equal(r.code, 1);
  assert.equal(r.json.files["voice.md"].present, false);
  assert.match(r.json.next, /voice\.md/);
});

test("the mode comes from rules.yaml", (t) => {
  const home = provisioned(t);
  assert.equal(doctor(home).json.mode, "draft");

  writeFileSync(join(home, "rules.yaml"), "mode: review\n");
  assert.equal(doctor(home).json.mode, "review");
});

test("it reports how the workspace resolved, not just where", (t) => {
  const home = provisioned(t);
  const r = doctor(home);
  assert.equal(r.json.workspace.home, home);
  assert.equal(r.json.workspace.resolved_via, "CAREER_HOME");
});

test("job records are counted", (t) => {
  const w = makeWorkspace();
  t.after(() => w.cleanup());
  assert.equal(w.doctor().json.jobs, 1);

  w.writeJob({ id: "acme-platform-engineer", company: "Acme", company_id: "acme" });
  assert.equal(w.doctor().json.jobs, 2);
});

/* ── an expired lease outranks everything else ─────────────────────────── */

test("an expired lease is the next action, ahead of unfilled files", (t) => {
  // review, not draft: draft blocks the claim outright, so there would be no
  // lease to expire. lease.seconds 0 makes the one we do take expire instantly.
  const w = makeWorkspace({ rules: "mode: review\nlease: { seconds: 0 }\n" });
  t.after(() => w.cleanup());

  const claimed = w.run(["claim", "--id", DEFAULT_JOB_ID, "--channel", "email"]);
  assert.equal(claimed.code, 0, claimed.stderr);

  const r = w.doctor();
  assert.equal(r.code, 1);
  assert.equal(r.json.gate.expiredLeases, 1);
  assert.match(r.json.next, /resolve --outcome/, "it names the only command that clears one");
});

/* ── the claim doctor may not make ─────────────────────────────────────── */

test("the mail verdict never claims to be authoritative", (t) => {
  const w = makeWorkspace();
  t.after(() => w.cleanup());
  const mail = w.doctor().json.mail;

  assert.equal(mail.authoritative, false, "this process cannot see the agent's MCP tool list");
  assert.ok(mail.note, "and it carries the caveat in the payload, not only in the docs");
  assert.match(mail.note, /tool list/i);
  assert.ok(Array.isArray(mail.looked_in), "it says where it looked, so 'none' is falsifiable");
  assert.ok(Array.isArray(mail.servers));
});

test("no mail tool is degraded at worst, never a setup failure", (t) => {
  const w = makeWorkspace();
  t.after(() => w.cleanup());

  // A workspace whose mail probe finds nothing must still reach exit 0. Draft
  // mode never touches a mailbox and the gate blocks every send anyway, so
  // "no mail tool" is a fact about the machine, not a broken workspace.
  const r = runSync(w.home, DOCTOR, ["--json"]);
  if (r.json.mail.detected) return; // this machine has one; the invariant is untestable here
  assert.equal(r.code, 0, "no mail is not a failure");
  assert.doesNotMatch(r.json.next, /mail/i, "and it is not what the user is told to do next");
});

/* ── PDF ───────────────────────────────────────────────────────────────── */

test("a missing Chrome is reported without calling the workspace broken", (t) => {
  const w = makeWorkspace();
  t.after(() => w.cleanup());

  const r = runSync(w.home, DOCTOR, ["--json"]);
  assert.equal(typeof r.json.pdf.available, "boolean");
  if (!r.json.pdf.available) {
    assert.match(r.json.pdf.note, /HTML and Markdown/, "it says what still works");
    assert.equal(r.code, 0, "no Chrome does not degrade the workspace");
  }
});
