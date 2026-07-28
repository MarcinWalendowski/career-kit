#!/usr/bin/env node
/**
 * log.mjs - log activity against an application without writing SQL by hand.
 *
 * This is the HUMAN-OWNED half of career.db. Everything it writes (stage,
 * salary expectation, next action, human notes, and the event history) is a
 * column db.mjs is forbidden to touch on a rebuild. That split is the whole
 * reason a person is willing to type into this thing.
 *
 *   # they wrote back
 *   log.mjs in northwind "Wants a call Thursday" --channel email
 *
 *   # we answered
 *   log.mjs out northwind "Sent times for Thu/Fri" --channel email
 *
 *   # move it along, set a number, leave yourself a note
 *   log.mjs stage northwind interview
 *   log.mjs expect northwind 180000 220000 --currency USD --note "open on equity split"
 *   log.mjs next northwind "confirm the Thursday slot" --due 2026-07-30
 *   log.mjs note northwind "CTO built their agent harness in-house"
 *
 *   # read
 *   log.mjs show                 whole pipeline
 *   log.mjs show northwind       one application, with its full history
 *   log.mjs todo                 they replied and we have not answered
 *
 * Timestamps default to now, UTC. Pass --ts to backdate, and pass an instant
 * with a Z or an offset when you do: a naive local time here sorts wrong
 * against transport-stamped sends and makes "who spoke last" answer wrong.
 *
 * Exit 0 done, 2 usage error.
 */

import { pathToFileURL } from "node:url";
import { findCareerHome, paths, ensureRuntimeDirs } from "./paths.mjs";
import { openDb, STAGES } from "./db.mjs";
import { isIsoInstant } from "./validate.mjs";

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

const die = (msg) => {
  process.stderr.write(`log: ${msg}\n`);
  process.exit(2);
};

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
const out = (s) => process.stdout.write(s + "\n");

function require_(db, id) {
  const row = db.prepare("SELECT 1 FROM applications WHERE id = ?").get(id);
  if (row) return;
  const ids = db.prepare("SELECT id FROM applications ORDER BY id").all().map((r) => r.id);
  die(
    `no application "${id}".\n  known ids:\n    ` +
      (ids.length ? ids.join("\n    ") : "(none: run `node engine/db.mjs` to build from jobs/*.json)"),
  );
}

function stamp(args) {
  if (!args.ts || args.ts === true) return nowIso();
  if (!isIsoInstant(String(args.ts))) {
    die(`--ts "${args.ts}" needs a timezone (...Z or ...+02:00). A naive local time sorts wrong against sends.`);
  }
  return String(args.ts);
}

const COMMANDS = {
  in: logMessage,
  out: logMessage,
  stage: setStage,
  expect: setExpectation,
  next: setNext,
  note: addNote,
  show: show,
  todo: todo,
};

function logMessage(db, args, cmd) {
  const [id, summary] = args._;
  if (!id || !summary) die(`usage: log.mjs ${cmd} <id> "<summary>" [--channel email] [--message-id X] [--body T] [--ts ISO]`);
  require_(db, id);
  db.prepare(
    "INSERT INTO events (application_id, ts, direction, channel, summary, message_id, body) VALUES (?,?,?,?,?,?,?)",
  ).run(
    id,
    stamp(args),
    cmd,
    args.channel && args.channel !== true ? String(args.channel) : "email",
    String(summary),
    args["message-id"] && args["message-id"] !== true ? String(args["message-id"]) : null,
    args.body && args.body !== true ? String(args.body) : null,
  );
  // An inbound message on an application still sitting at "applied" moves it to
  // "replied" by itself. Any other stage is a human's decision and stands.
  if (cmd === "in") {
    db.prepare("UPDATE applications SET stage='replied' WHERE id=? AND stage='applied'").run(id);
  }
  out(`logged ${cmd} for ${id}`);
}

function setStage(db, args) {
  const [id, stage] = args._;
  if (!id || !stage) die(`usage: log.mjs stage <id> <${STAGES.join("|")}>`);
  if (!STAGES.includes(stage)) die(`unknown stage "${stage}". Known: ${STAGES.join(", ")}`);
  require_(db, id);
  db.prepare("UPDATE applications SET stage=?, updated_at=datetime('now') WHERE id=?").run(stage, id);
  out(`${id} -> ${stage}`);
}

function setExpectation(db, args) {
  const [id, low, high] = args._;
  if (!id || low === undefined || high === undefined) {
    die('usage: log.mjs expect <id> <low> <high> [--currency USD] [--note "..."]');
  }
  const lo = Number(low);
  const hi = Number(high);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) die("low and high must be numbers");
  if (lo > hi) die(`low (${lo}) is above high (${hi})`);
  require_(db, id);
  const currency = args.currency && args.currency !== true ? String(args.currency) : "USD";
  db.prepare(
    "UPDATE applications SET expect_currency=?, expect_min=?, expect_max=?," +
      " expect_notes=COALESCE(?, expect_notes), updated_at=datetime('now') WHERE id=?",
  ).run(currency, lo, hi, args.note && args.note !== true ? String(args.note) : null, id);
  out(`${id} expectation ${currency} ${lo}-${hi}`);
}

function setNext(db, args) {
  const [id, action] = args._;
  if (!id || !action) die('usage: log.mjs next <id> "<action>" [--due YYYY-MM-DD]');
  require_(db, id);
  const due = args.due && args.due !== true ? String(args.due) : null;
  if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) die(`--due "${due}" must be YYYY-MM-DD`);
  db.prepare("UPDATE applications SET next_action=?, next_action_due=?, updated_at=datetime('now') WHERE id=?")
    .run(String(action), due, id);
  out(`${id} next: ${action}`);
}

function addNote(db, args) {
  const [id, text] = args._;
  if (!id || !text) die('usage: log.mjs note <id> "<text>"');
  require_(db, id);
  db.prepare(
    "UPDATE applications SET human_notes=TRIM(COALESCE(human_notes || char(10), '') || ?)," +
      " updated_at=datetime('now') WHERE id=?",
  ).run(String(text), id);
  out(`noted on ${id}`);
}

const PIPELINE = [["company", 30], ["role", 40], ["stage", 11], ["sent", 16], ["posted_comp", 15], ["replies", 7]];

function show(db, args) {
  const [id] = args._;
  if (id) {
    require_(db, id);
    const row = db.prepare("SELECT * FROM applications WHERE id=?").get(id);
    for (const [k, v] of Object.entries(row)) {
      if (v === null || v === "" || v === 0) continue;
      out(`${k.padStart(22)}: ${String(v).replace(/\s+/g, " ").slice(0, 160)}`);
    }
    out("\n  history");
    const events = db
      .prepare("SELECT ts, direction, channel, summary FROM events WHERE application_id=? ORDER BY ts")
      .all(id);
    if (!events.length) out("  (nothing logged yet)");
    for (const e of events) {
      out(`  ${e.ts}  ${e.direction === "in" ? "<-" : "->"} ${String(e.channel ?? "").padEnd(10)} ${String(e.summary ?? "").slice(0, 110)}`);
    }
    return;
  }
  const rows = db.prepare(`SELECT ${PIPELINE.map(([c]) => c).join(", ")} FROM v_pipeline`).all();
  out(PIPELINE.map(([c, w]) => c.padEnd(w)).join(" | "));
  out(PIPELINE.map(([, w]) => "-".repeat(w)).join("-+-"));
  for (const r of rows) {
    out(PIPELINE.map(([c, w]) => String(r[c] ?? "").replace(/\s+/g, " ").slice(0, w).padEnd(w)).join(" | "));
  }
  if (!rows.length) out("(no applications yet: run `node engine/db.mjs` to build from jobs/*.json)");
}

function todo(db) {
  const rows = db.prepare("SELECT company, role, their_last_message, what_they_said FROM v_needs_reply").all();
  if (!rows.length) {
    out("nothing waiting on a reply");
    return;
  }
  for (const r of rows) {
    out(`\n${r.company} - ${r.role}\n  ${r.their_last_message}\n  ${r.what_they_said ?? ""}`);
  }
}

async function main(argv) {
  const cmd = argv[0];
  if (!cmd || cmd.startsWith("--")) die(`usage: log.mjs <${Object.keys(COMMANDS).join("|")}> ...`);
  const run = COMMANDS[cmd];
  if (!run) die(`unknown command "${cmd}". Known: ${Object.keys(COMMANDS).join(", ")}`);

  const args = parseArgs(argv.slice(1));
  const P = ensureRuntimeDirs(paths(findCareerHome()));
  const db = await openDb(P);
  db.exec("PRAGMA foreign_keys = ON");
  run(db, args, cmd);
  db.close();
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
