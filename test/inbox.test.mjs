/**
 * inbox.test.mjs - matching and classification.
 *
 * The two rules worth testing hardest are both asymmetric on purpose:
 * an uncertain match is labelled rather than promoted, and a tie in the
 * classifier falls to `reply`. Both exist because the cost of being wrong runs
 * in one direction only.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { buildIndex, matchMessage, classify, idsIn, header } from "../engine/inbox.mjs";
import { paths } from "../engine/paths.mjs";

const KIT = join(dirname(fileURLToPath(import.meta.url)), "..");

const REC = (over = {}) => ({
  id: "acme-founding-engineer",
  company: "Acme",
  company_id: "acme",
  domains: ["acme.example"],
  role: "Founding Engineer",
  apply: { channel: "email", target: "jobs@acme.example" },
  status: "sent",
  sent_at: "2026-07-28T09:00:00Z",
  message_id: "<out-1@mail.example>",
  ...over,
});

function ws(records) {
  const home = mkdtempSync(join(tmpdir(), "career-kit-inbox-"));
  mkdirSync(join(home, "jobs"), { recursive: true });
  for (const r of records) writeFileSync(join(home, "jobs", `${r.id}.json`), JSON.stringify(r));
  return home;
}

const index = (records) => buildIndex(paths(ws(records)));

/* ------------------------------------------------------------------ headers */

test("both threading headers can hold several ids, and brackets are not part of the id", () => {
  assert.deepEqual(idsIn("<a@x> <b@y>"), ["a@x", "b@y"]);
  assert.deepEqual(idsIn("<A@X>"), ["a@x"]);
  assert.deepEqual(idsIn(""), []);
  assert.deepEqual(idsIn(undefined), []);
});

test("header lookup ignores case, because providers disagree on it", () => {
  const msg = { headers: { "in-reply-to": "<a@x>", "MESSAGE-ID": "<b@y>" } };
  assert.equal(header(msg, "In-Reply-To"), "<a@x>");
  assert.equal(header(msg, "message-id"), "<b@y>");
  assert.equal(header(msg, "References"), undefined);
});

/* ----------------------------------------------------------------- matching */

test("In-Reply-To and References are certain matches", () => {
  const idx = index([REC()]);
  const a = matchMessage({ from: "x@whoever.example", headers: { "In-Reply-To": "<out-1@mail.example>" } }, idx);
  assert.equal(a.id, "acme-founding-engineer");
  assert.equal(a.certain, true);

  const b = matchMessage({ from: "x@whoever.example", headers: { References: "<other@z> <out-1@mail.example>" } }, idx);
  assert.equal(b.id, "acme-founding-engineer");
  assert.equal(b.how, "by-references");
});

test("a domain match is attached but labelled uncertain, never promoted", () => {
  const idx = index([REC({ message_id: null })]);
  const m = matchMessage({ from: "Hiring <talent@acme.example>", headers: {} }, idx);
  assert.equal(m.id, "acme-founding-engineer");
  assert.equal(m.how, "by-domain");
  assert.equal(m.certain, false, "a domain match must never be reported as certain");
});

test("a subdomain still matches the company", () => {
  const idx = index([REC({ message_id: null })]);
  assert.equal(matchMessage({ from: "x@mail.acme.example", headers: {} }, idx).id, "acme-founding-engineer");
});

test("a domain pointing at two records resolves to neither", () => {
  // A shared ATS domain sends on behalf of many companies. Picking one would be
  // a coin flip presented as a match.
  const idx = index([
    REC({ id: "a", message_id: null, domains: ["shared-ats.example"] }),
    REC({ id: "b", message_id: null, domains: ["shared-ats.example"] }),
  ]);
  const m = matchMessage({ from: "noreply@shared-ats.example", headers: {} }, idx);
  assert.equal(m.id, null);
  assert.equal(m.how, "ambiguous-domain");
  assert.deepEqual(m.candidates.sort(), ["a", "b"]);
});

test("a close-looking subject is not a match", () => {
  // The negative control for the whole matcher. A reply filed against the wrong
  // company is worse than one nobody filed.
  const idx = index([REC()]);
  const m = matchMessage(
    { from: "someone@unrelated.example", subject: "Re: Founding Engineer at Acme", headers: {} },
    idx,
  );
  assert.equal(m.id, null);
  assert.equal(m.how, "unmatched");
});

/* ----------------------------------------------------------- classification */

test("an ATS acknowledgement from a no-reply address is an auto-ack", () => {
  const v = classify(
    {
      from: "no-reply@acme.example",
      subject: "Application received",
      snippet: "We have received your application and will be in touch.",
      date: "2026-07-28T09:01:00Z",
    },
    REC(),
  );
  assert.equal(v.class, "auto-ack");
  assert.equal(v.stage, null, "an auto-ack must not move the stage");
});

test("a rejection is a rejection even from a no-reply address", () => {
  // Most of them arrive that way, so the auto-ack signals must not swallow it.
  const v = classify(
    {
      from: "no-reply@acme.example",
      subject: "Your application",
      snippet: "We have decided to proceed with other candidates.",
      date: "2026-08-04T09:00:00Z",
    },
    REC(),
  );
  assert.equal(v.class, "rejection");
  assert.equal(v.stage, "rejected");
});

test("a named human asking a question is a reply", () => {
  const v = classify(
    {
      from: "Dana <dana@acme.example>",
      subject: "Re: Founding Engineer",
      snippet: "Are you free Thursday for a call?",
      date: "2026-07-29T11:00:00Z",
    },
    REC(),
  );
  assert.equal(v.class, "reply");
  assert.equal(v.stage, "replied");
});

test("when the signals disagree the classifier falls to reply", () => {
  // The asymmetry that decides this: mislabelling an auto-ack as a reply costs
  // one glance, mislabelling a reply as an auto-ack cost fifteen hours.
  // Auto-ack boilerplate, but from a real person, outside the window.
  const v = classify(
    {
      from: "Dana <dana@acme.example>",
      subject: "Re: your application",
      snippet: "Thanks for applying. I read it properly, can we talk Friday?",
      date: "2026-07-30T09:00:00Z",
    },
    REC(),
  );
  assert.equal(v.class, "reply");
});

test("'unfortunately' alone does not make a rejection", () => {
  const v = classify(
    {
      from: "Dana <dana@acme.example>",
      subject: "Re: Founding Engineer",
      snippet: "Unfortunately I am travelling this week. Can we do the call on Monday?",
      date: "2026-07-30T09:00:00Z",
    },
    REC(),
  );
  assert.equal(v.class, "reply", "a soft word in a scheduling note is not a rejection");
});

/* -------------------------------------------------------------------- CLI */

function run(home, argv, stdin) {
  try {
    const stdout = execFileSync("node", [join(KIT, "engine/inbox.mjs"), ...argv], {
      env: { ...process.env, CAREER_HOME: home },
      input: stdin ?? "",
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, json: JSON.parse(stdout) };
  } catch (err) {
    return { code: err.status, stderr: err.stderr || "", stdout: err.stdout || "" };
  }
}

test("index reports what can be threaded and what can only be guessed at", () => {
  const home = ws([REC(), REC({ id: "form-co", message_id: null, apply: { channel: "form" }, domains: ["formco.example"] })]);
  const r = run(home, ["index"]);
  assert.equal(r.code, 0);
  assert.equal(r.json.threadable, 1);
  assert.deepEqual(r.json.unthreadable.map((u) => u.id), ["form-co"]);
  rmSync(home, { recursive: true, force: true });
});

test("scan writes nothing and emits the log commands instead", () => {
  const home = ws([REC()]);
  const msgs = JSON.stringify([
    {
      id: "m1",
      from: "Dana <dana@acme.example>",
      subject: "Re: Founding Engineer",
      date: "2026-07-29T11:00:00Z",
      headers: { "In-Reply-To": "<out-1@mail.example>", "Message-ID": "<in-1@acme.example>" },
      snippet: "Are you free Thursday?",
    },
    { id: "m2", from: "news@somewhere.example", subject: "Weekly digest", date: "2026-07-29T12:00:00Z", headers: {} },
  ]);
  const r = run(home, ["scan"], msgs);
  assert.equal(r.code, 0);
  assert.equal(r.json.scanned, 2);
  assert.equal(r.json.matched, 1);
  assert.equal(r.json.unmatched, 1);
  assert.equal(r.json.replies, 1);

  const verbs = r.json.results[0].actions.map((a) => a[1]);
  assert.deepEqual(verbs, ["in", "stage", "next"], "a reply must always carry a next action");
  assert.deepEqual(r.json.results[1].actions, [], "unmatched mail generates no action at all");
  rmSync(home, { recursive: true, force: true });
});

test("scan with no input fails loudly rather than reporting an empty sweep", () => {
  // "0 replies" from an empty read looks exactly like "0 replies" from a real
  // one, and the second is the answer that lets a reply sit unread.
  const home = ws([REC()]);
  const r = run(home, ["scan"], "");
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no messages on stdin/);
  rmSync(home, { recursive: true, force: true });
});

test("--since drops older mail", () => {
  const home = ws([REC()]);
  const msgs = JSON.stringify([
    { id: "old", from: "dana@acme.example", date: "2026-07-01T09:00:00Z", headers: { "In-Reply-To": "<out-1@mail.example>" } },
    { id: "new", from: "dana@acme.example", date: "2026-07-29T09:00:00Z", headers: { "In-Reply-To": "<out-1@mail.example>" } },
  ]);
  const r = run(home, ["scan", "--since", "2026-07-15T00:00:00Z"], msgs);
  assert.equal(r.json.scanned, 1);
  assert.equal(r.json.results[0].message.id, "new");
  rmSync(home, { recursive: true, force: true });
});
