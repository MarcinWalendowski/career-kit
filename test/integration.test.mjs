/**
 * integration.test.mjs - the seams between modules, not the modules.
 *
 * Everything here was found by provisioning a synthetic persona from templates
 * alone and running the loop end to end. Unit tests passed on all three; the
 * defects only appeared when the pieces were wired together, which is the whole
 * argument for keeping this file separate from the per-module suites.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Provision exactly the way a new user does: copy the shipped templates and
 * change nothing else. If a test here needs a plugin file edited to pass, the
 * de-personalisation seam is missing and that is the finding.
 */
function workspace({ mode = "review", job } = {}) {
  const home = mkdtempSync(join(tmpdir(), "career-kit-int-"));
  for (const [from, to] of [
    ["templates/profile.example.yaml", "profile.yaml"],
    ["templates/rules.example.yaml", "rules.yaml"],
    ["templates/voice.example.md", "voice.md"],
    ["templates/knowledge-base.scaffold.md", "knowledge-base.md"],
  ]) {
    cpSync(join(KIT, from), join(home, to));
  }
  const rules = join(home, "rules.yaml");
  writeFileSync(rules, readFileSync(rules, "utf8").replace(/^mode: \w+/m, `mode: ${mode}`));
  mkdirSync(join(home, "jobs"), { recursive: true });
  if (job) writeFileSync(join(home, "jobs", `${job.id}.json`), JSON.stringify(job, null, 2));
  return home;
}

const JOB = (over = {}) => ({
  id: "acme-founding-engineer",
  company: "Acme",
  company_id: "acme",
  domains: ["acme.example"],
  role: "Founding Engineer",
  seniority: "senior",
  source: "ashby",
  source_id: "abc",
  url: "https://jobs.ashbyhq.com/acme/abc",
  apply: {
    channel: "email",
    target: "jobs@acme.example",
    route_confidence: 0.9,
    identity_verified: true,
    identity_domain: "acme.example",
  },
  location: null,
  workplace_type: "unknown",
  posted_comp: { currency: null, min: null, max: null, period: "year", equity: null },
  status: "discovered",
  sent_at: null,
  sent_at_source: null,
  message_id: null,
  subject: null,
  receipt: null,
  notes: "",
  evidence: [],
  incidents: [],
  escalations: [],
  discovered_at: "2026-07-28T08:00:00Z",
  updated_at: "2026-07-28T08:00:00Z",
  ...over,
});

function gate(home, argv) {
  try {
    const stdout = execFileSync("node", [join(KIT, "engine/gate.mjs"), ...argv], {
      env: { ...process.env, CAREER_HOME: home },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, json: safe(stdout) };
  } catch (err) {
    const stdout = err.stdout || "";
    return { code: err.status, stdout, stderr: err.stderr || "", json: safe(stdout) };
  }
}
const safe = (s) => {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/* ------------------------------------------------------------------ identity */

test("an empty domains[] blocks as identity-unknown, not as a mismatch", () => {
  // A freshly ingested ATS record has no domains[]: a Greenhouse or Ashby board
  // payload states the slug and the role, never the company's own domain. The
  // guard blocked, which is right, but it said "Different company. Do not send.",
  // which sends the reader hunting for a slug collision that does not exist.
  // Both cases block; only one of them is a collision.
  const home = workspace({ job: JOB({ domains: [] }) });
  const r = gate(home, [
    "check", "--id", "acme-founding-engineer", "--channel", "email",
    "--sent-check", "0", "--sent-check-query", "to:acme.example",
    "--identity-domain", "acme.example",
  ]);
  assert.equal(r.code, 3);
  assert.equal(r.json.blocked, "identity-unknown");
  assert.match(r.json.detail, /no domains\[\]/);
  assert.match(r.json.detail, /route resolution/, "must name the fix, not just the failure");
  rmSync(home, { recursive: true, force: true });
});

test("a genuine slug collision still blocks as identity-mismatch", () => {
  // The negative control for the change above: widening the empty case must not
  // have swallowed the case the guard was built for. Three ATS slugs in the
  // source sweep each resolved to a different company than intended.
  const home = workspace({ job: JOB({ domains: ["acme.example"] }) });
  const r = gate(home, [
    "check", "--id", "acme-founding-engineer", "--channel", "email",
    "--sent-check", "0", "--sent-check-query", "x",
    "--identity-domain", "someone-else.example",
  ]);
  assert.equal(r.code, 3);
  assert.equal(r.json.blocked, "identity-mismatch");
  rmSync(home, { recursive: true, force: true });
});

/* --------------------------------------------------------------------- stage */

test("db seeds stage from what happened, and a rebuild never touches it again", async () => {
  const { loadSqlite, openDb, rebuild } = await import(join(KIT, "engine/db.mjs"));
  if (!(await loadSqlite())) return; // node:sqlite unavailable; db.test.mjs reports that properly

  const { paths, ensureRuntimeDirs } = await import(join(KIT, "engine/paths.mjs"));
  const home = workspace();
  const P = ensureRuntimeDirs(paths(home));
  writeFileSync(P.job("a"), JSON.stringify(JOB({ id: "a", status: "discovered" })));
  writeFileSync(
    P.job("b"),
    JSON.stringify(JOB({
      id: "b", status: "sent", sent_at: "2026-07-28T09:00:00Z", sent_at_source: "transport",
    })),
  );

  await rebuild(P);
  const db = await openDb(P);
  const stageOf = (d, id) => d.prepare("SELECT stage FROM applications WHERE id=?").get(id).stage;

  // A discovered role is not an application. Seeding everything at the schema
  // default reported nine applications where one had been sent.
  assert.equal(stageOf(db, "a"), "discovered");
  assert.equal(stageOf(db, "b"), "applied");

  // stage is human-owned from here. The rebuild is an upsert whose UPDATE clause
  // must not list it.
  db.prepare("UPDATE applications SET stage='interview' WHERE id=?").run("b");
  db.close();
  await rebuild(P);
  const db2 = await openDb(P);
  assert.equal(
    stageOf(db2, "b"),
    "interview",
    "a rebuild overwrote a human-owned column",
  );
  db2.close();
  rmSync(home, { recursive: true, force: true });
});

/* ------------------------------------------------------- provisioning is real */

test("a workspace provisions from shipped templates alone", () => {
  // The P0 gate in the spec: if a synthetic persona needs a plugin file edited,
  // the seam is missing. This asserts the weaker, testable half - that the
  // templates alone produce a workspace the gate will read.
  const home = workspace({ job: JOB() });
  const r = gate(home, ["status"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.mode, "review");
  assert.equal(r.json.careerHome, home);
  assert.equal(r.json.quota.used, 0);
  rmSync(home, { recursive: true, force: true });
});

/* ------------------------------------------------ the banned-character chain */

test("the shipped em dash rule survives all three hops from template to block", () => {
  // Three files have to agree and each one looks fine alone:
  //
  //   1. rules.example.yaml declares the em dash as "\u2014", so the template
  //      that bans the character does not itself contain it. That escape is the
  //      subtle part and it is easy to "tidy" into a literal.
  //   2. the hand-rolled YAML reader has to DECODE that escape. If it ever
  //      stops, banned_characters holds the six-character string "\u2014",
  //      which matches nothing, and the rule silently stops working.
  //   3. the gate has to block a draft containing one.
  //
  // Nothing else catches hop 2. A parser that returns the literal escape is
  // still a working parser by every other test in the suite.
  const EM = String.fromCharCode(0x2014);

  const raw = readFileSync(join(KIT, "templates/rules.example.yaml"), "utf8");
  assert.ok(!raw.includes(EM), "the template that bans the character must not contain it");
  assert.match(raw, /banned_characters:\s*\[\s*"\\u2014"\s*\]/);

  const home = workspace({ job: JOB() });
  const draft = join(home, "draft.md");

  writeFileSync(draft, `Hi team,\n\nI built a thing ${EM} a real one.\n\nBest,\nAda\n`);
  const blocked = gate(home, [
    "check", "--id", "acme-founding-engineer", "--channel", "email",
    "--sent-check", "0", "--sent-check-query", "x",
    "--identity-domain", "acme.example", "--draft", draft,
  ]);
  assert.equal(blocked.code, 3);
  assert.equal(blocked.json.blocked, "banned-content");

  // The negative control. A rule that blocks everything is not a working rule.
  writeFileSync(draft, "Hi team,\n\nI built a thing, a real one.\n\nBest,\nAda\n");
  const allowed = gate(home, [
    "check", "--id", "acme-founding-engineer", "--channel", "email",
    "--sent-check", "0", "--sent-check-query", "x",
    "--identity-domain", "acme.example", "--draft", draft,
  ]);
  assert.equal(allowed.code, 0);
  assert.equal(allowed.json.allowed, true);

  rmSync(home, { recursive: true, force: true });
});

/* ------------------------------------------- the skills call a real engine */

test("every engine command a skill emits actually exists", () => {
  // The generic guard for a class of bug, not one instance of it. render.mjs was
  // once a library with no CLI at all while four skills invoked it as a command
  // six times. Node imported the module, defined some functions and exited 0, so
  // every one of those calls looked like a success and wrote nothing. engine/
  // inbox.mjs did not exist at all while career-inbox called it.
  //
  // Both are the same failure: a skill and a module that were written separately
  // and never run against each other. Asserting the file exists and the verb is
  // recognised is cheap and catches it at the seam.
  const skills = readdirSync(join(KIT, "skills"));
  const seen = new Set();
  const missing = [];

  for (const skill of skills) {
    for (const file of ["SKILL.md", "references"]) {
      const base = join(KIT, "skills", skill, file);
      const docs = file === "SKILL.md"
        ? [base]
        : (existsSync(base) ? readdirSync(base).map((f) => join(base, f)) : []);
      for (const doc of docs) {
        if (!existsSync(doc) || !doc.endsWith(".md")) continue;
        const src = readFileSync(doc, "utf8");
        const re = /engine\/([a-z-]+\.mjs)"?\s*\\?\s*\n?\s*([a-z-]+)?/g;
        let m;
        while ((m = re.exec(src))) {
          const [, mod, verb] = m;
          const key = `${mod} ${verb || ""}`.trim();
          if (seen.has(key)) continue;
          seen.add(key);
          if (!existsSync(join(KIT, "engine", mod))) {
            missing.push(`${skill}: engine/${mod} does not exist`);
            continue;
          }
          const src2 = readFileSync(join(KIT, "engine", mod), "utf8");
          // A module invoked as a command has to BE one. A bare library exits 0
          // and writes nothing, which is indistinguishable from success.
          const isCli = /process\.argv/.test(src2);
          if (!isCli) missing.push(`${skill}: engine/${mod} is invoked as a command but has no CLI`);
        }
      }
    }
  }

  assert.deepEqual(missing, [], `skills call engine code that cannot answer:\n  ${missing.join("\n  ")}`);
  assert.ok(seen.size >= 6, `expected to find engine invocations in the skills, found ${seen.size}`);
});

/* ------------------------------------ adapters must satisfy the job schema */

test("every adapter emits records the validator accepts", async () => {
  // The unowned contract between two suites that each pass. sources.test.mjs
  // asserts the normalised shape against its own expectations; validate.test.mjs
  // asserts the schema against hand-written records. Neither runs adapter output
  // through the validator, so an adapter is free to drift out of the enum and
  // nothing notices until career-sources writes a record that the very next step
  // rejects.
  //
  // Drift of exactly this kind is in the spec's problem statement: status,
  // channel and stage had drifted across four files in the system this ports,
  // and one channel column held a free-text sentence.
  const { validateJob } = await import(join(KIT, "engine/validate.mjs"));
  const fx = (n) => JSON.parse(readFileSync(join(KIT, "test/fixtures", n), "utf8"));

  const CASES = [
    ["greenhouse.mjs", "greenhouse.json"],
    ["lever.mjs", "lever.json"],
    ["ashby.mjs", "ashby.json"],
    ["smartrecruiters.mjs", "smartrecruiters.json"],
    ["recruitee.mjs", "recruitee.json"],
    ["workable.mjs", "workable.json"],
  ];

  let checked = 0;
  for (const [mod, file] of CASES) {
    const a = await import(join(KIT, "engine/sources", mod));
    const payload = fx(file);
    const jobs = await a.search({ boards: ["acme"] }, {
      fetchJson: async () => payload,
      fetchText: async () => JSON.stringify(payload),
    });
    assert.ok(jobs.length > 0, `${a.id} returned nothing from its own fixture`);
    for (const job of jobs) {
      const { ok, errors } = validateJob(job);
      assert.ok(ok, `${a.id} emitted a record the validator rejects:\n  ${(errors || []).join("\n  ")}`);
      checked++;
    }
  }
  assert.ok(checked >= 10, `expected to validate a real batch, only saw ${checked}`);
});

/* --------------------------------------------------- the extension can connect */

test("the extension and the server agree on the default port", () => {
  // They did not. The server defaulted to 7749 and the extension to 8899, so on
  // a default install the capture POST could never connect, and neither side
  // could report why: the server logs nothing for a connection it never
  // receives, and the extension sees a bare network failure.
  //
  // Unit tests could not catch it. Each side was internally consistent and each
  // suite passed. Only wiring them together shows it, which is what this file
  // is for.
  const portOf = (file, name) => {
    const src = readFileSync(join(KIT, file), "utf8");
    const m = new RegExp(`const ${name} = (\\d+)`).exec(src);
    assert.ok(m, `${file} no longer declares ${name}; this test cannot check the agreement`);
    return Number(m[1]);
  };

  const server = portOf("engine/serve.mjs", "DEFAULT_PORT");
  assert.equal(portOf("extension/background.js", "DEFAULT_PORT"), server);
  assert.equal(portOf("extension/popup.js", "DEFAULT_PORT"), server);

  // The number a user actually sees prefilled in the popup has to match too. It
  // is the one copy that is not a constant, so it is the one most likely to rot.
  const html = readFileSync(join(KIT, "extension/popup.html"), "utf8");
  const shown = /id="port"[^>]*value="(\d+)"/.exec(html);
  assert.ok(shown, "popup.html no longer prefills a port");
  assert.equal(Number(shown[1]), server);
});

test("the extension can reach only the local machine", () => {
  // The defensibility of the LinkedIn source rests on this being structural.
  const manifest = JSON.parse(readFileSync(join(KIT, "extension/manifest.json"), "utf8"));
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1/*"]);
  assert.ok(!manifest.permissions.includes("alarms"), "an alarm would make it a crawler");
  assert.ok(!manifest.content_scripts, "a declared content script would run without a click");
});

test("the shipped rules block a denied role and a draft-mode send", () => {
  // Doctrine that used to live in a memory file outside the repo now ships as
  // data and is enforced. Both of these come from templates/rules.example.yaml
  // with no edits.
  const denied = workspace({ job: JOB({ role: "Product Designer" }) });
  const r1 = gate(denied, [
    "check", "--id", "acme-founding-engineer", "--channel", "email",
    "--sent-check", "0", "--sent-check-query", "x", "--identity-domain", "acme.example",
  ]);
  assert.equal(r1.code, 3);
  assert.equal(r1.json.blocked, "role-excluded");
  rmSync(denied, { recursive: true, force: true });

  const draft = workspace({ mode: "draft", job: JOB() });
  const r2 = gate(draft, [
    "check", "--id", "acme-founding-engineer", "--channel", "email",
    "--sent-check", "0", "--sent-check-query", "x", "--identity-domain", "acme.example",
  ]);
  assert.equal(r2.code, 3);
  assert.equal(r2.json.blocked, "mode-draft");
  rmSync(draft, { recursive: true, force: true });
});
