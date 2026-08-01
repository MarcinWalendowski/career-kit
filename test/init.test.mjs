/**
 * init.test.mjs - provisioning, and the two things it must never do.
 *
 * The negative controls here are the point of the file:
 *
 *   1. init NEVER overwrites. Setup is the one skill that runs against a
 *      directory a user has already put their identity into, and the "repair a
 *      half-provisioned workspace" path is exactly where an agent reaches for a
 *      fresh copy of profile.yaml. Re-running must be provably inert.
 *   2. knowledge-base.md IS created. The shell loop this command replaced
 *      globbed `templates/<name>.example.*`, and the knowledge base ships as
 *      `knowledge-base.scaffold.md` - so the glob matched nothing and every
 *      workspace it provisioned came up without the one file the pipeline
 *      treats as fact. A test that only counted "some files appeared" would
 *      have passed against that bug.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { makeEmptyDir, makeWorkspace, runSync, INIT } from "./helpers.mjs";

const init = (home, argv = ["--no-git"]) => runSync(home, INIT, argv);

/* ── a fresh workspace ─────────────────────────────────────────────────── */

test("one call provisions a complete workspace", (t) => {
  const home = makeEmptyDir(t);
  const r = init(home);

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.fresh, true);

  for (const f of ["profile.yaml", "rules.yaml", "voice.md", "knowledge-base.md", ".gitignore"]) {
    assert.ok(existsSync(join(home, f)), `${f} exists on disk`);
    assert.ok(r.json.created.includes(f), `${f} is reported as created`);
  }
  for (const d of ["cv", "jobs", "jobs/inbox", "drafts", "outputs/receipts", "outputs/reports"]) {
    assert.ok(existsSync(join(home, d)), `${d}/ exists`);
  }
});

test("the knowledge base is created despite not matching the .example. convention", (t) => {
  const home = makeEmptyDir(t);
  init(home);
  const kb = readFileSync(join(home, "knowledge-base.md"), "utf8");
  assert.ok(kb.length > 0, "the scaffold was copied, not an empty file");
  assert.match(kb, /\[\[FILL\]\]/, "the scaffold still carries its gap markers");
});

test("a new workspace starts in draft, one rung below the template", (t) => {
  const home = makeEmptyDir(t);
  const r = init(home);
  assert.equal(r.json.mode, "draft");
  assert.match(readFileSync(join(home, "rules.yaml"), "utf8"), /^mode: draft$/m);
});

test("the fill count reports what is actually in the files", (t) => {
  const home = makeEmptyDir(t);
  const r = init(home);
  // Ground truth is `[[FILL`, the PREFIX. This test used to compute it with
  // `\[\[FILL\]\]` — the bare form only — which is the same defect it was
  // meant to catch, so it compared a wrong count against a wrong count and
  // passed. The shipped scaffold uses the annotated `[[FILL: ...]]` form
  // throughout, so bare-only saw 35 of its 61 markers.
  const text = readFileSync(join(home, "knowledge-base.md"), "utf8");
  const onDisk = (text.match(/\[\[FILL/g) || []).length;
  assert.ok(onDisk > (text.match(/\[\[FILL\]\]/g) || []).length, "scaffold must hold annotated markers");
  assert.equal(r.json.fill_markers["knowledge-base.md"], onDisk);
  assert.equal(r.json.fill_total, onDisk);
});

/* ── the negative control ──────────────────────────────────────────────── */

test("re-running overwrites nothing", (t) => {
  const home = makeEmptyDir(t);
  init(home);

  const edits = {
    "profile.yaml": "name: Somebody Real\nemail: real@example.com\n",
    "rules.yaml": "mode: autopilot\nautopilot_channels: [email]\n",
    "voice.md": "# Voice\nMine, hand written.\n",
    "knowledge-base.md": "# Knowledge base\n- One true fact.\n",
    ".gitignore": "# mine\n",
  };
  for (const [name, text] of Object.entries(edits)) writeFileSync(join(home, name), text);

  const again = init(home);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.json.fresh, false);
  assert.deepEqual(again.json.created, [], "a second run creates nothing");

  for (const [name, text] of Object.entries(edits)) {
    assert.equal(readFileSync(join(home, name), "utf8"), text, `${name} is byte-identical`);
  }
});

test("a user's mode is never demoted by a re-run", (t) => {
  const home = makeEmptyDir(t);
  init(home);
  writeFileSync(join(home, "rules.yaml"), "mode: review\n");

  const again = init(home);
  assert.equal(again.json.mode, null, "no demotion is reported");
  assert.match(readFileSync(join(home, "rules.yaml"), "utf8"), /^mode: review$/m);
});

test("init on a populated workspace leaves job records and the ledger alone", (t) => {
  const w = makeWorkspace();
  t.after(() => w.cleanup());

  const job = readFileSync(w.job(), "utf8");
  const r = w.init();

  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.fresh, false);
  assert.equal(readFileSync(w.job(), "utf8"), job, "the job record is untouched");
  assert.ok(!r.json.created.includes("profile.yaml"));
});

/* ── where it provisions ───────────────────────────────────────────────── */

test("--home wins over $CAREER_HOME, and says so", (t) => {
  const env = makeEmptyDir(t);
  const explicit = makeEmptyDir(t);

  const r = runSync(env, INIT, ["--home", explicit, "--no-git"]);
  assert.equal(r.json.home, explicit);
  assert.equal(r.json.resolved_via, "--home");
  assert.ok(existsSync(join(explicit, "profile.yaml")));
  assert.ok(!existsSync(join(env, "profile.yaml")), "the env path was not provisioned");
});

test("--no-git leaves no repo behind", (t) => {
  const home = makeEmptyDir(t);
  const r = init(home);
  assert.equal(r.json.git, "skipped");
  assert.ok(!existsSync(join(home, ".git")));
});

test("git init runs, and never commits", (t) => {
  const home = makeEmptyDir(t);
  const r = init(home, []);
  if (r.json.git.startsWith("unavailable")) return; // no git on this machine
  assert.equal(r.json.git, "initialised");
  assert.ok(existsSync(join(home, ".git")));

  // The history is the user's to start: an initial commit made by a tool is one
  // they have to undo before they can write their own. An unborn branch has no
  // ref file for HEAD to resolve to, which is what "no commit happened" looks
  // like on disk.
  const head = readFileSync(join(home, ".git", "HEAD"), "utf8").trim();
  const ref = head.replace(/^ref:\s*/, "");
  assert.match(head, /^ref: /);
  assert.ok(!existsSync(join(home, ".git", ref)), "the branch is unborn, so nothing was committed");
});

/* ── the gitignore lands before the repo can stage anything ────────────── */

test("the workspace gitignore excludes the private surfaces", (t) => {
  const home = makeEmptyDir(t);
  init(home);
  const ignored = readFileSync(join(home, ".gitignore"), "utf8");
  for (const pattern of ["drafts", "jobs", "outputs", "career.db", ".ledger.jsonl", ".leases"]) {
    assert.match(ignored, new RegExp(pattern.replace(/[.]/g, "\\.")), `${pattern} is ignored`);
  }
});
