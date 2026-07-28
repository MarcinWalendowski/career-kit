/**
 * validate.test.mjs - the enums, and the YAML parser's refusal to guess.
 *
 * Two negative controls carry this file:
 *
 *   1. A sentence can never land in `channel` again. The record that motivated
 *      the schema held "linkedin (preferred, draft) + ashby form staged + email
 *      draft" in a column documented as an enum, and nothing rejected it.
 *   2. The YAML parser THROWS on syntax it does not support. A config parser
 *      that returns undefined for a construct it never learned turns
 *      "mode: autopilot" into an undefined mode, and an undefined mode is not
 *      a safe mode.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { parseYaml, validateJob, fixJob, isIsoInstant, CHANNELS } from "../engine/validate.mjs";
import { makeWorkspace, jobRecord, DEFAULT_JOB_ID } from "./helpers.mjs";

const ID = DEFAULT_JOB_ID;

function ws(t, opts) {
  const w = makeWorkspace(opts);
  t.after(() => w.cleanup());
  return w;
}

const errorAt = (result, path) => result.errors.find((e) => e.path === path);

/* ── the job schema ────────────────────────────────────────────────────── */

test("the default record is valid", () => {
  const r = validateJob(jobRecord());
  assert.equal(r.ok, true, JSON.stringify(r.errors, null, 2));
});

test("free text in channel is rejected", () => {
  const rec = jobRecord();
  rec.apply.channel = "linkedin (preferred, draft) + ashby form staged + email draft";
  const r = validateJob(rec);
  assert.equal(r.ok, false);
  const err = errorAt(r, "$.apply.channel");
  assert.ok(err, "the error names the offending path");
  assert.match(err.message, /is not one of/);
  assert.ok(CHANNELS.every((c) => err.message.includes(c)));
});

test("--fix moves that free text to notes and drops the channel to none", (t) => {
  const w = ws(t);
  const rec = JSON.parse(readFileSync(w.job(ID), "utf8"));
  rec.apply.channel = "linkedin (preferred, draft) + ashby form staged + email draft";
  writeFileSync(w.job(ID), JSON.stringify(rec, null, 2));

  assert.equal(w.validate().code, 3, "an invalid record is a non-zero exit");

  const fixed = w.validate(["--fix"]);
  assert.equal(fixed.code, 0, fixed.stderr);
  const after = w.readJob();
  // "none" rather than a guessed channel: nothing downstream may act on a route
  // that was never actually decided.
  assert.equal(after.apply.channel, "none");
  assert.match(after.notes, /channel was recorded as free text/);
  assert.match(after.notes, /ashby form staged/);
});

test("--fix normalises a legacy channel spelling instead of discarding it", () => {
  const rec = jobRecord();
  rec.apply.channel = "ashby";
  const { obj, fixes } = fixJob(rec);
  assert.equal(obj.apply.channel, "ats-ashby");
  assert.ok(fixes.some((f) => f.includes("ats-ashby")));
  assert.equal(validateJob(obj).ok, true);
});

test("the enums that matter are enforced, not commented", () => {
  for (const [path, mutate] of [
    ["$.status", (r) => (r.status = "in progress")],
    ["$.workplace_type", (r) => (r.workplace_type = "wfh")],
    ["$.sent_at_source", (r) => (r.sent_at_source = "client")],
  ]) {
    const rec = jobRecord();
    mutate(rec);
    const r = validateJob(rec);
    assert.equal(r.ok, false, `${path} accepted a value outside its enum`);
    assert.ok(errorAt(r, path), `expected an error at ${path}`);
  }
});

test("a timestamp with no zone is rejected", () => {
  const rec = jobRecord({ sent_at: "2026-07-27T23:43:05" });
  const r = validateJob(rec);
  assert.equal(r.ok, false);
  assert.match(errorAt(r, "$.sent_at").message, /ISO 8601 instant/);

  assert.equal(isIsoInstant("2026-07-27T23:43:05Z"), true);
  assert.equal(isIsoInstant("2026-07-28T01:43:05+02:00"), true);
  assert.equal(isIsoInstant("2026-07-27T23:43:05"), false);
  assert.equal(isIsoInstant("yesterday"), false);
});

test("an unknown top-level field is rejected, so descriptive text cannot hide in one", () => {
  const rec = jobRecord();
  rec.relocation_answer = "yes, willing to relocate";
  const r = validateJob(rec);
  assert.equal(r.ok, false);
  assert.match(errorAt(r, "$.relocation_answer").message, /notes/);
});

test("a missing required field is named by path", () => {
  const rec = jobRecord();
  delete rec.domains;
  delete rec.apply.channel;
  const r = validateJob(rec);
  assert.equal(r.ok, false);
  assert.ok(errorAt(r, "$.domains"));
  assert.ok(errorAt(r, "$.apply.channel"));
});

test("evidence, incidents and escalations are dated entries, not a prose blob", () => {
  // The record that motivated the split held 4,000 characters in one `notes`
  // string: a correction, three rewrite histories, a declined request and an
  // operational warning, with no way to tell where one ended.
  const ok = jobRecord({
    evidence: [{ at: "2026-07-28T09:00:00Z", kind: "route", text: "Board found by probing the slug." }],
    escalations: [{ at: "2026-07-28T12:00:00Z", kind: "declined", text: "Declined a request to embed hidden text." }],
  });
  assert.equal(validateJob(ok).ok, true);

  const bad = jobRecord({ evidence: ["found the board by probing the slug"] });
  assert.equal(validateJob(bad).ok, false);

  const undated = jobRecord({ incidents: [{ kind: "contradiction", text: "JD and form disagree" }] });
  assert.equal(validateJob(undated).ok, false);
});

test("route_confidence is a probability, not an arbitrary number", () => {
  const rec = jobRecord({ apply: { route_confidence: 90 } });
  assert.equal(validateJob(rec).ok, false);
  assert.equal(validateJob(jobRecord({ apply: { route_confidence: 0.9 } })).ok, true);
});

/* ── YAML: what it supports ────────────────────────────────────────────── */

test("it parses the shipped rules.yaml shape, including a flow sequence that wraps", () => {
  const parsed = parseYaml(
    [
      "mode: review                    # draft | review | autopilot",
      "autopilot_channels: []",
      "",
      "limits:",
      "  maxPerDay: 8",
      "  perSourcePerDay: { linkedin: 5, hn: 10 }",
      "",
      "roles:",
      "  allow: [software engineer, senior engineer, staff engineer,",
      "          founding engineer, applied ai]",
      "",
      "company:",
      "  followups_allowed: false",
      "lease:  { seconds: 600 }",
    ].join("\n"),
    { name: "rules.yaml" },
  );
  assert.equal(parsed.mode, "review");
  assert.deepEqual(parsed.autopilot_channels, []);
  assert.equal(parsed.limits.maxPerDay, 8);
  assert.deepEqual(parsed.limits.perSourcePerDay, { linkedin: 5, hn: 10 });
  assert.equal(parsed.roles.allow.length, 5);
  assert.equal(parsed.roles.allow[4], "applied ai");
  assert.equal(parsed.company.followups_allowed, false);
  assert.equal(parsed.lease.seconds, 600);
});

test("it parses the shipped profile.yaml shape, block and flow lists of maps", () => {
  const parsed = parseYaml(
    [
      'phone: "+44 20 7946 0000"',
      "location: { city: London, country: United Kingdom }",
      "work_authorization:",
      "  - { region: UK, status: citizen }",
      "  - region: US",
      "    status: visa-required",
      "    sponsorship_needed: true",
      'relocation: { willing: false, notes: "Not relocating in 2026." }',
      "empty_value:",
    ].join("\n"),
    { name: "profile.yaml" },
  );
  assert.equal(parsed.phone, "+44 20 7946 0000", "a leading + does not make it a number");
  assert.deepEqual(parsed.location, { city: "London", country: "United Kingdom" });
  assert.deepEqual(parsed.work_authorization[0], { region: "UK", status: "citizen" });
  assert.deepEqual(parsed.work_authorization[1], { region: "US", status: "visa-required", sponsorship_needed: true });
  assert.equal(parsed.relocation.willing, false);
  assert.equal(parsed.empty_value, null);
});

test("an apostrophe inside a word is not a quote, and a # inside a quoted string is not a comment", () => {
  const parsed = parseYaml(['a: don\'t guess # trailing comment', 'b: "value # not a comment"'].join("\n"));
  assert.equal(parsed.a, "don't guess");
  assert.equal(parsed.b, "value # not a comment");
});

test("yes and no stay strings", () => {
  // YAML 1.1 made them booleans, which is how the country code NO became false
  // in a thousand config files. If you mean a boolean, write true or false.
  const parsed = parseYaml("region: NO\nsponsor: no\nreal: false");
  assert.equal(parsed.region, "NO");
  assert.equal(parsed.sponsor, "no");
  assert.equal(parsed.real, false);
});

/* ── YAML: what it refuses ─────────────────────────────────────────────── */

test("it throws on syntax it does not support rather than returning undefined", () => {
  const cases = [
    ["a tab in the indentation", "limits:\n\tmaxPerDay: 8\n", /tab/i],
    ["a block scalar", "notes: |\n  two lines\n  of prose\n", /block scalar/i],
    ["a folded scalar", "notes: >\n  wrapped\n", /block scalar/i],
    ["an anchor", "base: &b { a: 1 }\n", /anchor/i],
    ["an alias", "mode: review\nother: *b\n", /anchor|alias/i],
    ["a merge key", "limits:\n  <<: *base\n  maxPerDay: 8\n", /merge/i],
    ["a tag", "when: !!timestamp 2026-07-28\n", /tag/i],
    ["a duplicate key", "mode: draft\nmode: autopilot\n", /duplicate key/i],
    ["an unterminated quote", 'notes: "oops\n', /unterminated/i],
    ["a second document", "mode: review\n---\nmode: autopilot\n", /multi-document/i],
    ["a line with no colon", "mode: review\njust some prose\n", /key: value/i],
    ["an unclosed flow collection", "roles:\n  allow: [a, b\n", /never closed/i],
    ["a list item where a key belongs", "limits:\n  maxPerDay: 8\n  - oops\n", /list item/i],
  ];
  for (const [label, text, pattern] of cases) {
    assert.throws(
      () => parseYaml(text, { name: "rules.yaml" }),
      (err) => pattern.test(err.message) && /rules\.yaml:\d+/.test(err.message),
      `${label}: expected a throw naming the file and line, matching ${pattern}`,
    );
  }
});

test("a duplicate key throws instead of letting the last one win", () => {
  // Real YAML silently keeps the last. Two `mode:` keys in rules.yaml is never
  // intentional and always dangerous.
  assert.throws(() => parseYaml("mode: draft\nmode: autopilot\n"), /duplicate key "mode"/);
});

test("the gate refuses to run on a rules.yaml it cannot parse", (t) => {
  const w = ws(t, { rules: "mode: review\nlimits:\n\tmaxPerDay: 8\n" });
  const r = w.run(["check", "--id", ID, "--channel", "email", "--sent-check", "0", "--sent-check-query", "q", "--identity-domain", "northwind.example"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /tab/i);
});

test("the gate refuses a mode it does not recognise", (t) => {
  const w = ws(t, { rules: "mode: yolo\n" });
  const r = w.run(["claim", "--id", ID, "--channel", "email"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /draft \| review \| autopilot/);
});

/* ── the CLI ───────────────────────────────────────────────────────────── */

test("the CLI reports every record and exits 3 while any stays invalid", (t) => {
  const w = ws(t, { jobs: [{ id: "eastwind-backend-engineer", company: "Eastwind", company_id: "eastwind", domains: ["eastwind.example"], role: "Backend Engineer" }] });
  const rec = w.readJob("eastwind-backend-engineer");
  rec.status = "in progress";
  writeFileSync(w.job("eastwind-backend-engineer"), JSON.stringify(rec, null, 2));

  const r = w.validate();
  assert.equal(r.code, 3);
  assert.equal(r.json.checked, 2);
  assert.equal(r.json.valid, 1);
  assert.equal(r.json.invalid, 1);
  assert.match(r.stderr, /--fix/);

  assert.equal(w.validate(["--fix"]).code, 0);
  assert.equal(w.readJob("eastwind-backend-engineer").status, "discovered");
});

test("the CLI rejects an unknown flag rather than ignoring it", (t) => {
  const w = ws(t);
  const r = w.validate(["--repair"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /unknown flag/);
});

test("--all, --id and --job all select records, and --job takes a path", (t) => {
  const w = ws(t, { jobs: [{ id: "eastwind-backend-engineer", company: "Eastwind", company_id: "eastwind", domains: ["eastwind.example"], role: "Backend Engineer" }] });

  assert.equal(w.validate(["--all"]).json.checked, 2);
  assert.equal(w.validate([]).json.checked, 2, "no argument means the same as --all");
  assert.equal(w.validate(["--id", "eastwind-backend-engineer"]).json.checked, 1);

  // --job takes a PATH so a capture can be validated during triage, while it is
  // still in jobs/inbox/ and not yet a record.
  const inboxPath = w.file(
    "jobs/inbox/captured.json",
    JSON.stringify({ ...jobRecord({ id: "captured-role" }), status: "nonsense" }, null, 2),
  );
  const one = w.validate(["--job", inboxPath]);
  assert.equal(one.code, 3);
  assert.equal(one.json.checked, 1);
  assert.equal(one.json.records[0].id, "captured");

  assert.equal(w.validate(["--job", inboxPath, "--fix"]).code, 0);
  assert.equal(JSON.parse(readFileSync(inboxPath, "utf8")).status, "discovered");
});

test("the CLI refuses ambiguous or empty selectors instead of guessing", (t) => {
  const w = ws(t);
  assert.equal(w.validate(["--id", ID, "--job", "/tmp/x.json"]).code, 2);
  assert.equal(w.validate(["--job"]).code, 2, "a flag with no value is a usage error");
  assert.equal(w.validate(["--job", "/tmp/does-not-exist-career-kit.json"]).code, 2);
  const missing = w.validate(["--id", "no-such-record"]);
  assert.equal(missing.code, 2, "an id that matches nothing must not report a clean zero-record pass");
});
