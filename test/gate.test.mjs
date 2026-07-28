/**
 * gate.test.mjs - the negative controls.
 *
 * These tests are the point of the gate, not a chore attached to it. A green
 * suite proves nothing after a removal: if you delete a guard and every test
 * still passes, the tests were only ever checking the happy path. So every one
 * of these asserts that a specific bad input is REFUSED, with a specific exit
 * code and a specific reason string. Change a reason string and a test breaks,
 * which is correct: the reason is part of the contract that the skills read.
 *
 * Exit codes under test: 0 allowed or done, 2 usage error, 3 blocked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeWorkspace, sendOnce, CHECK_OK, DEFAULT_JOB_ID, EM_DASH, GATE } from "./helpers.mjs";

const ID = DEFAULT_JOB_ID;

function ws(t, opts) {
  const w = makeWorkspace(opts);
  t.after(() => w.cleanup());
  return w;
}

/* ── 1. the lock ───────────────────────────────────────────────────────── */

test("two concurrent claims on the same id and channel: exactly one wins", async (t) => {
  const w = ws(t);

  // The Ditto case. Two actors, same target, seven minutes apart in the real
  // incident and simultaneously here. open(..., "wx") is the whole lock:
  // whichever process reaches the syscall second gets EEXIST from the kernel,
  // not a stale read of a state file.
  const results = await Promise.all([
    w.runAsync(["claim", "--id", ID, "--channel", "email", "--actor", "agent-a"]),
    w.runAsync(["claim", "--id", ID, "--channel", "email", "--actor", "agent-b"]),
  ]);

  const winners = results.filter((r) => r.code === 0);
  const losers = results.filter((r) => r.code === 3);
  assert.equal(winners.length, 1, `expected exactly one winner, got ${winners.length}`);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].json.reason, "pending-elsewhere");
  assert.ok(losers[0].json.lease.pid, "the block names the holder's pid");
  assert.ok(losers[0].json.lease.host, "the block names the holder's host");
  assert.ok(losers[0].json.lease.claimed_at, "the block names when it was claimed");

  // The lease on disk belongs to the winner, not to whoever wrote last.
  const leases = w.run(["leases"]);
  assert.equal(leases.json.count, 1);
  assert.equal(leases.json.leases[0].token, winners[0].json.token);
});

/* ── 2. freshness ──────────────────────────────────────────────────────── */

test("record with a token older than lease.seconds: stale-token", (t) => {
  // lease.seconds: 1 means the token is stale almost immediately, which is the
  // same condition as a long gap between checking and acting. That gap is the
  // entire window a duplicate is born in, so the gate measures it rather than
  // asking prose to close it.
  const w = ws(t, { rules: rulesWith({ lease: "lease: { seconds: 1 }" }) });
  const claimed = w.run(["claim", "--id", ID, "--channel", "email"]);
  assert.equal(claimed.code, 0);

  // Backdate the claim rather than sleeping: same arithmetic, no flake.
  backdateLease(w, ID, "email", 30);

  const r = w.run([
    "record", "--id", ID, "--token", claimed.json.token, "--status", "sent",
    "--sent-at", new Date().toISOString(), "--sent-at-source", "transport",
  ]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "stale-token");
  assert.match(r.stderr, /re-claim/i);
});

test("record with a token that belongs to someone else: stale-token", (t) => {
  const w = ws(t);
  const claimed = w.run(["claim", "--id", ID, "--channel", "email"]);
  const r = w.run([
    "record", "--id", ID, "--token", "0000000000000000", "--status", "sent",
    "--sent-at", new Date().toISOString(), "--sent-at-source", "transport",
  ]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "stale-token");
  assert.notEqual(claimed.json.token, "0000000000000000");
});

/* ── 3. the measurement guard ──────────────────────────────────────────── */

test("check without --sent-check BLOCKS, it does not pass", (t) => {
  const w = ws(t);
  const r = w.run([
    "check", "--id", ID, "--channel", "email",
    "--sent-check-query", "to:jobs@northwind.example",
    "--identity-domain", "northwind.example",
  ]);
  // Not knowing how many are in the Sent folder is not the same as zero being
  // in it, and treating it as zero is how a run talks itself past a floor it
  // cannot measure.
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "sent-check-missing");
  assert.equal(r.json.allowed, false);
});

test("check without --sent-check-query also blocks: a count with no query is a claim", (t) => {
  const w = ws(t);
  const r = w.run([
    "check", "--id", ID, "--channel", "email",
    "--sent-check", "0",
    "--identity-domain", "northwind.example",
  ]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "sent-check-missing");
});

test("check with a non-zero --sent-check: already-sent", (t) => {
  const w = ws(t);
  const r = w.run([
    "check", "--id", ID, "--channel", "email",
    "--sent-check", "1", "--sent-check-query", "to:jobs@northwind.example",
    "--identity-domain", "northwind.example",
  ]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "already-sent");
});

/* ── 4. identity ───────────────────────────────────────────────────────── */

test("check with an identity domain outside the record's domains[]: identity-mismatch", (t) => {
  const w = ws(t);
  // The ATS-slug problem: three board slugs in the sweep this generalises each
  // resolved to a different company than the one intended.
  const r = w.run([
    "check", "--id", ID, "--channel", "email",
    "--sent-check", "0", "--sent-check-query", "q",
    "--identity-domain", "someone-else.example",
  ]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "identity-mismatch");
  assert.deepEqual(r.json.domains, ["northwind.example"]);
});

test("check with no identity domain at all: identity-unknown", (t) => {
  const w = ws(t);
  const r = w.run(["check", "--id", ID, "--channel", "email", "--sent-check", "0", "--sent-check-query", "q"]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "identity-unknown");
});

test("a subdomain of a listed domain is accepted", (t) => {
  const w = ws(t);
  const r = w.run([
    "check", "--id", ID, "--channel", "email",
    "--sent-check", "0", "--sent-check-query", "q",
    "--identity-domain", "careers.northwind.example",
  ]);
  assert.equal(r.code, 0);
  assert.equal(r.json.allowed, true);
});

/* ── 5. duplicate record ───────────────────────────────────────────────── */

test("a second record for the same id without --force: exit 2", (t) => {
  const w = ws(t);
  const first = sendOnce(w);
  assert.equal(first.code, 0);

  const second = w.run([
    "record", "--id", ID, "--token", "whatever", "--status", "sent",
    "--sent-at", new Date().toISOString(), "--sent-at-source", "transport",
  ]);
  assert.equal(second.code, 2, second.stdout + second.stderr);
  assert.match(second.stderr, /already recorded/);
  assert.match(second.stderr, /--force/);
});

/* ── 6. the crash ──────────────────────────────────────────────────────── */

test("a lease that outlived its process blocks the next claim and never self-frees", (t) => {
  const w = ws(t);
  mkdirSync(w.leases, { recursive: true });
  const claimedAt = new Date(Date.now() - 3600_000);
  writeFileSync(
    w.lease(ID, "email"),
    JSON.stringify({
      id: ID,
      channel: "email",
      token: "deadbeefdeadbeef",
      company_id: "northwind",
      source: "ashby",
      actor: "career-apply",
      pid: 999999,
      host: "gone.local",
      claimed_at: claimedAt.toISOString(),
      expires_at: new Date(claimedAt.getTime() + 600_000).toISOString(),
    }),
  );

  const r = w.run(["claim", "--id", ID, "--channel", "email"]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "stale-lease");
  // Auto-expiry would reopen the double-send window on exactly the failure the
  // lease exists to catch, so the only exit is a human looking at the Sent
  // folder. The message has to say so, by name.
  assert.match(r.stderr, /gate resolve/);
  assert.match(r.stderr, /--outcome sent\|not-sent/);

  // And it is still there afterwards.
  assert.equal(w.run(["leases"]).json.count, 1);

  const resolved = w.run(["resolve", "--id", ID, "--channel", "email", "--outcome", "sent", "--evidence", "found it in Sent"]);
  assert.equal(resolved.code, 0);
  assert.equal(resolved.json.needs_human, true);
  assert.equal(w.readJob().status, "sent-unverified");
  assert.equal(w.run(["leases"]).json.count, 0);
});

test("resolve --outcome not-sent frees the lease and puts the record back to drafted", (t) => {
  const w = ws(t);
  w.run(["claim", "--id", ID, "--channel", "email"]);
  const r = w.run(["resolve", "--id", ID, "--channel", "email", "--outcome", "not-sent"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.needs_human, false);
  assert.equal(w.readJob().status, "drafted");
  assert.equal(w.run(["leases"]).json.count, 0);
});

/* ── 7. the clock ──────────────────────────────────────────────────────── */

test("record with a sent_at two hours in the future: clock-skew", (t) => {
  const w = ws(t);
  const claimed = w.run(["claim", "--id", ID, "--channel", "email"]);
  // The CEST-labelled-Z case: a local wall clock formatted with a Z in a UTC+2
  // zone lands exactly two hours ahead. Twenty-three records in the sweep this
  // kit generalises are this bug.
  const twoHoursAhead = new Date(Date.now() + 2 * 3600_000).toISOString();
  const r = w.run([
    "record", "--id", ID, "--token", claimed.json.token, "--status", "sent",
    "--sent-at", twoHoursAhead, "--sent-at-source", "transport",
  ]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "clock-skew");
  assert.ok(r.json.skew_seconds > 300);
});

test("record rejects a naive timestamp and a client clock as its source", (t) => {
  const w = ws(t);
  const claimed = w.run(["claim", "--id", ID, "--channel", "email"]);

  const naive = w.run([
    "record", "--id", ID, "--token", claimed.json.token, "--status", "sent",
    "--sent-at", "2026-07-28T12:00:00", "--sent-at-source", "transport",
  ]);
  assert.equal(naive.code, 2);
  assert.match(naive.stderr, /timezone/);

  const client = w.run([
    "record", "--id", ID, "--token", claimed.json.token, "--status", "sent",
    "--sent-at", new Date().toISOString(), "--sent-at-source", "client",
  ]);
  assert.equal(client.code, 2);
  assert.match(client.stderr, /transport/);
});

/* ── 8. receipts ───────────────────────────────────────────────────────── */

test("a receipt channel with no --receipt records sent-unverified and needs_human", (t) => {
  const w = ws(t, { job: { apply: { channel: "ats-ashby", target: "https://example.com/northwind/apply" } } });
  const claimed = w.run(["claim", "--id", ID, "--channel", "ats-ashby", "--route", "https://example.com/northwind/apply"]);
  assert.equal(claimed.code, 0);

  const r = w.run([
    "record", "--id", ID, "--token", claimed.json.token, "--status", "sent",
    "--sent-at", new Date().toISOString(), "--sent-at-source", "transport",
  ]);

  // It does NOT fail: the form was already submitted, and pretending otherwise
  // loses the fact. It downgrades, so a human is told to go and confirm.
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.recorded.status, "sent-unverified");
  assert.equal(r.json.needs_human, true);

  const job = w.readJob();
  assert.equal(job.status, "sent-unverified");
  assert.equal(job.needs_human, true);
  assert.equal(job.receipt, null);
});

test("a receipt that is given but empty blocks: an empty file proves nothing", (t) => {
  const w = ws(t, { job: { apply: { channel: "ats-ashby", target: "https://example.com/apply" } } });
  const empty = w.file("outputs/tmp/empty.png", "");
  const claimed = w.run(["claim", "--id", ID, "--channel", "ats-ashby", "--route", "https://example.com/apply"]);
  const r = w.run([
    "record", "--id", ID, "--token", claimed.json.token, "--status", "sent",
    "--sent-at", new Date().toISOString(), "--sent-at-source", "transport",
    "--receipt", empty,
  ]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "receipt-missing");
});

test("a real receipt is copied into the workspace and recorded as verified", (t) => {
  const w = ws(t, { job: { apply: { channel: "ats-ashby", target: "https://example.com/apply" } } });
  const receipt = w.file("outputs/tmp/confirmation.txt", "Application received. Reference 12345.\n");
  const claimed = w.run(["claim", "--id", ID, "--channel", "ats-ashby", "--route", "https://example.com/apply"]);
  const r = w.run([
    "record", "--id", ID, "--token", claimed.json.token, "--status", "sent",
    "--sent-at", new Date().toISOString(), "--sent-at-source", "transport",
    "--receipt", receipt,
  ]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.json.recorded.status, "sent");
  assert.equal(r.json.needs_human, false);
  // Copied under the workspace, because the one receipt in the sweep this
  // generalises lived in /var/folders/ and was annotated "will not survive".
  assert.match(w.readJob().receipt, /outputs\/receipts\//);
});

/* ── 9. roles ──────────────────────────────────────────────────────────── */

test("a role matching roles.deny: role-excluded", (t) => {
  const w = ws(t, { job: { role: "Machine Learning Engineer" } });
  const r = w.run(["check", "--id", ID, "--channel", "email", ...CHECK_OK]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "role-excluded");
  assert.equal(r.json.list, "deny");
  assert.equal(r.json.matched, "machine learning engineer");
});

test("a role in neither allow nor deny is still excluded when allow is non-empty", (t) => {
  const w = ws(t, { job: { role: "Technical Account Manager" } });
  const r = w.run(["check", "--id", ID, "--channel", "email", ...CHECK_OK]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "role-excluded");
  assert.equal(r.json.list, "allow");
});

test("the deny list matches on word boundaries, not substrings", (t) => {
  // "ml engineer" must not fire on a role that merely contains those letters.
  const w = ws(t, { job: { role: "Backend Engineer, HTML Engineering Tools" } });
  const r = w.run(["check", "--id", ID, "--channel", "email", ...CHECK_OK]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

test("claim enforces the role filter too, not just check", (t) => {
  // If only `check` filtered roles, an agent could skip check and claim
  // straight through. The claim is the mint; it re-runs the local invariants.
  const w = ws(t, { job: { role: "Product Designer" } });
  const r = w.run(["claim", "--id", ID, "--channel", "email"]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "role-excluded");
});

/* ── 10. mode ──────────────────────────────────────────────────────────── */

test("mode: draft plus a send channel: mode-draft", (t) => {
  const w = ws(t, { rules: rulesWith({ mode: "mode: draft" }) });
  const r = w.run(["check", "--id", ID, "--channel", "email", ...CHECK_OK]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "mode-draft");
});

test("mode: draft blocks claim as well", (t) => {
  const w = ws(t, { rules: rulesWith({ mode: "mode: draft" }) });
  const r = w.run(["claim", "--id", ID, "--channel", "email"]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "mode-draft");
});

test("mode: autopilot blocks a channel that is not opted in", (t) => {
  const w = ws(t, { rules: rulesWith({ mode: "mode: autopilot", autopilot: "autopilot_channels: [form]" }) });
  const r = w.run(["check", "--id", ID, "--channel", "email", ...CHECK_OK]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "channel-not-autopiloted");
});

test("mode: autopilot allows a channel that is opted in", (t) => {
  const w = ws(t, {
    rules: rulesWith({ mode: "mode: autopilot", autopilot: "autopilot_channels: [email]" }),
  });
  const r = w.run(["check", "--id", ID, "--channel", "email", ...CHECK_OK]);
  assert.equal(r.code, 0, r.stdout + r.stderr);
});

/* ── caps, quotas, content ─────────────────────────────────────────────── */

test("a second application to the same company: company-cap", (t) => {
  const w = ws(t, {
    jobs: [{ id: "northwind-staff-engineer", role: "Staff Engineer" }],
  });
  assert.equal(sendOnce(w).code, 0);

  const r = w.run([
    "check", "--id", "northwind-staff-engineer", "--channel", "email",
    "--sent-check", "0", "--sent-check-query", "q", "--identity-domain", "northwind.example",
  ]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "company-cap");
  // One contact per company, ever. No follow-up and no correction: a correction
  // turns one good impression into two mediocre ones.
  assert.match(r.json.detail, /one contact per company/i);
});

test("the per-day quota blocks once maxPerDay is reached", (t) => {
  const w = ws(t, {
    rules: rulesWith({ limits: "limits:\n  maxPerDay: 1\n  minGapMinutes: 0" }),
    jobs: [{ id: "eastwind-backend-engineer", company: "Eastwind", company_id: "eastwind", domains: ["eastwind.example"], role: "Backend Engineer" }],
  });
  assert.equal(sendOnce(w).code, 0);
  const r = w.run([
    "check", "--id", "eastwind-backend-engineer", "--channel", "email",
    "--sent-check", "0", "--sent-check-query", "q", "--identity-domain", "eastwind.example",
  ]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "quota");
});

test("min-gap blocks a send that follows too closely", (t) => {
  const w = ws(t, {
    rules: rulesWith({ limits: "limits:\n  maxPerDay: 8\n  minGapMinutes: 60" }),
    jobs: [{ id: "eastwind-backend-engineer", company: "Eastwind", company_id: "eastwind", domains: ["eastwind.example"], role: "Backend Engineer" }],
  });
  assert.equal(sendOnce(w).code, 0);
  const r = w.run([
    "check", "--id", "eastwind-backend-engineer", "--channel", "email",
    "--sent-check", "0", "--sent-check-query", "q", "--identity-domain", "eastwind.example",
  ]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "min-gap");
});

test("a draft containing a banned character: banned-content", (t) => {
  const w = ws(t);
  const draft = w.file("drafts/x/email.md", `Hello,\n\nI built a thing ${EM_DASH} and it worked.\n`);
  const r = w.run(["check", "--id", ID, "--channel", "email", ...CHECK_OK, "--draft", draft]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "banned-content");
  assert.equal(r.json.hits[0].kind, "character");
  assert.equal(r.json.hits[0].codepoint, "U+2014");
});

test("banned_characters written in the U+2014 spelling still matches the character", (t) => {
  // The templates document that spelling and rules.example.yaml uses it, because
  // a rules file holding a literal em dash trips its own rule. If the gate
  // compared drafts against the six-character string "U+2014" instead, the
  // guard would report clean forever while the character sailed through, which
  // is worse than not having the guard at all.
  const w = ws(t, { rules: rulesWith({ content: 'content:\n  banned_characters: ["U+2014"]' }) });
  const draft = w.file("drafts/x/email.md", `I built a thing ${EM_DASH} and it worked.\n`);
  const r = w.run(["check", "--id", ID, "--channel", "email", ...CHECK_OK, "--draft", draft]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "banned-content");
  assert.equal(r.json.hits[0].codepoint, "U+2014");

  // And a clean draft still passes, so the decoding did not turn into a
  // match-everything.
  const clean = w.file("drafts/x/clean.md", "I built a thing and it worked.\n");
  assert.equal(w.run(["check", "--id", ID, "--channel", "email", ...CHECK_OK, "--draft", clean]).code, 0);
});

test("a draft containing a banned phrase: banned-content", (t) => {
  const w = ws(t);
  const draft = w.file("drafts/x/email.md", "Hi,\n\nI hope this email finds you well.\n");
  const r = w.run(["check", "--id", ID, "--channel", "email", ...CHECK_OK, "--draft", draft]);
  assert.equal(r.code, 3);
  assert.equal(r.json.reason, "banned-content");
  assert.equal(r.json.hits[0].kind, "phrase");
});

/* ── the ledger ────────────────────────────────────────────────────────── */

test("every block is written to the ledger, not just every success", (t) => {
  const w = ws(t);
  w.run(["check", "--id", ID, "--channel", "email"]);
  w.run(["check", "--id", ID, "--channel", "email", "--sent-check", "0", "--sent-check-query", "q", "--identity-domain", "elsewhere.example"]);

  const blocks = w.readLedger().filter((e) => e.kind === "block");
  // A gate that only records what it let through cannot tell you it is working.
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.reason), ["sent-check-missing", "identity-mismatch"]);
});

test("the ledger is append-only: a torn line does not lose the rest", (t) => {
  const w = ws(t);
  assert.equal(sendOnce(w).code, 0);
  // Simulate a crash mid-append.
  writeFileSync(w.ledger, w.readLedger().map((e) => JSON.stringify(e)).join("\n") + "\n{\"kind\":\"rec", { flag: "w" });
  const status = w.run(["status"]);
  assert.equal(status.code, 0);
  assert.equal(status.json.totals.sent, 1);
  assert.match(status.stderr, /not valid JSON and was skipped/);
});

test("release needs the holder's token and a reason", (t) => {
  const w = ws(t);
  const claimed = w.run(["claim", "--id", ID, "--channel", "email"]);

  const noReason = w.run(["release", "--id", ID, "--channel", "email", "--token", claimed.json.token]);
  assert.equal(noReason.code, 2);

  const wrongToken = w.run(["release", "--id", ID, "--channel", "email", "--token", "0000", "--reason", "changed my mind"]);
  assert.equal(wrongToken.code, 3);
  assert.equal(wrongToken.json.reason, "stale-token");

  const ok = w.run(["release", "--id", ID, "--channel", "email", "--token", claimed.json.token, "--reason", "changed my mind"]);
  assert.equal(ok.code, 0);
  assert.equal(w.run(["leases"]).json.count, 0);
  assert.equal(w.readJob().status, "drafted");
  assert.ok(w.readLedger().some((e) => e.kind === "release"));
});

/* ── usage errors ──────────────────────────────────────────────────────── */

test("an unknown channel, an unknown command and a missing job record are usage errors", (t) => {
  const w = ws(t);
  assert.equal(w.run(["claim", "--id", ID, "--channel", "carrier-pigeon"]).code, 2);
  assert.equal(w.run(["frobnicate"]).code, 2);
  const missing = w.run(["check", "--id", "nobody-here", "--channel", "email", ...CHECK_OK]);
  assert.equal(missing.code, 2);
  assert.match(missing.stderr, /no job record/);
});

test("a missing workspace exits 2 and names career-setup instead of guessing", () => {
  const r = runWithoutHome(["status"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /career-setup/);
});

/* ── verify ────────────────────────────────────────────────────────────── */

test("verify traces a claim that came from the knowledge base and flags one that did not", (t) => {
  const w = ws(t);
  const artifact = w.file(
    "drafts/x/cv.md",
    "Cut median checkout latency from 900ms to 210ms over one quarter.\n" +
      "Grew revenue by 400% in six weeks at Contoso.\n",
  );
  const r = w.run(["verify", "--artifact", artifact]);
  assert.equal(r.code, 0);
  const traced = r.json.claims.find((c) => c.text.includes("checkout latency"));
  const invented = r.json.claims.find((c) => c.text.includes("400%"));
  assert.equal(traced.traced, true);
  assert.equal(invented.traced, false);
  assert.equal(r.json.untraced_count, 1);
  // It must say what it is, every time, so nobody quotes it as a proof.
  assert.match(r.stderr, /FLAGGER, not a prover/);
});

test("verify catches a number swapped inside otherwise-traceable wording", (t) => {
  const w = ws(t);
  const artifact = w.file("drafts/x/cv.md", "Cut median checkout latency from 900ms to 20ms over one quarter.\n");
  const r = w.run(["verify", "--artifact", artifact]);
  assert.equal(r.json.claims[0].traced, false);
  assert.match(r.json.claims[0].why, /number/);
});

test("verify --strict exits 3 when something is untraced", (t) => {
  const w = ws(t);
  const artifact = w.file("drafts/x/cv.md", "Grew revenue by 400% in six weeks at Contoso.\n");
  const r = w.run(["verify", "--artifact", artifact, "--strict"]);
  assert.equal(r.code, 3);
  assert.equal(r.json.untraced_count, 1);
});

/* ── helpers ───────────────────────────────────────────────────────────── */

const RULE_BLOCKS = {
  mode: "mode: review",
  autopilot: "autopilot_channels: []",
  limits: "limits:\n  maxPerDay: 8\n  minGapMinutes: 0",
  lease: "lease: { seconds: 600 }",
  content:
    'content:\n  banned_characters: ["\\u2014"]\n' +
    '  banned_phrases: ["I hope this email finds you well", "circle back", "synergies"]',
};

/** Rebuild rules.yaml with one or more blocks replaced. */
function rulesWith(overrides) {
  const b = { ...RULE_BLOCKS, ...overrides };
  return [
    b.mode,
    b.autopilot,
    "",
    b.limits,
    "",
    "company:",
    "  maxApplications: 1",
    "  cooldownDays: 365",
    "  followups_allowed: false",
    "",
    "roles:",
    "  allow: [software engineer, senior engineer, staff engineer, founding engineer,",
    "          member of technical staff, backend, platform, infrastructure, applied ai]",
    "  deny:  [machine learning engineer, ml engineer, research scientist,",
    "          design engineer, product designer, engineering manager]",
    "",
    b.content,
    "",
    b.lease,
    "clock:  { skewSeconds: 300 }",
    "receipts:",
    "  required_channels: [form, ats-ashby, ats-greenhouse, ats-lever]",
    "",
  ].join("\n");
}

function backdateLease(w, id, channel, secondsAgo) {
  const path = w.lease(id, channel);
  const lease = JSON.parse(readFileSync(path, "utf8"));
  const claimed = new Date(Date.now() - secondsAgo * 1000);
  lease.claimed_at = claimed.toISOString();
  lease.expires_at = new Date(claimed.getTime() + 600_000).toISOString();
  writeFileSync(path, JSON.stringify(lease, null, 2));
}

function runWithoutHome(argv) {
  const env = { ...process.env };
  delete env.CAREER_HOME;
  // HOME points at an empty scratch dir so the ~/career fallback cannot
  // accidentally resolve to this machine's real workspace.
  env.HOME = mkdtempSync(join(tmpdir(), "career-kit-nohome-"));
  const r = spawnSync(process.execPath, [GATE, ...argv], { env, encoding: "utf8" });
  return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}
