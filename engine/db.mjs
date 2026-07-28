#!/usr/bin/env node
/**
 * db.mjs - build or refresh career.db from jobs/*.json.
 *
 * Idempotent. The whole design is one rule, and it is the best idea in the
 * tracker this ports:
 *
 *   MACHINE-OWNED columns are overwritten from the job records on every run.
 *   HUMAN-OWNED columns are never touched by a rebuild.
 *
 * Stage, priority, salary expectation, next action and human notes are typed by
 * a person. A rebuild that clobbered them would punish the user for adding a
 * job record, and they would stop typing them, and then the tracker is just a
 * slower way to read the jobs directory. MACHINE_COLS below is the whitelist:
 * a column not in it cannot be written by this file.
 *
 * ORPHANS. A row whose jobs/<id>.json has disappeared is flagged
 * (`orphaned = 1`) and reported, not deleted and not silently kept as if it
 * were current. A missing job file is usually an accident, and the row still
 * holds the send history that proves an application went out.
 *
 *   node engine/db.mjs rebuild     build / refresh (the verb is optional)
 *   node engine/db.mjs --show      ...and print the pipeline table
 *   node engine/db.mjs --json      machine-readable report
 *   node engine/db.mjs --prune     delete orphaned rows (destructive, opt-in)
 *
 * Exit 0 done, 2 usage or environment error.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { findCareerHome, paths, ensureRuntimeDirs } from "./paths.mjs";
import { validateJob } from "./validate.mjs";

/* ── sqlite ────────────────────────────────────────────────────────────── */

/**
 * node:sqlite is the only reason any of this needs a modern Node, and it is why
 * career.db is the one optional part of the kit: the gate, the schema and the
 * validator all work without it.
 *
 * It landed in Node 22.5 behind --experimental-sqlite and was unflagged in
 * 22.13. Rather than telling a user on 22.5 to 22.12 to remember a flag, we
 * re-exec ourselves with it once. The env var stops that from looping if the
 * flag turns out not to help.
 */
let sqlitePromise;
export function loadSqlite() {
  sqlitePromise ??= import("node:sqlite").then(
    (m) => m,
    () => null,
  );
  return sqlitePromise;
}

const FLAG = "--experimental-sqlite";

export async function requireSqlite() {
  const mod = await loadSqlite();
  if (mod) return mod;

  const [major, minor] = process.versions.node.split(".").map(Number);
  const flagMightHelp = major === 22 && minor >= 5 && minor < 13;
  if (flagMightHelp && !process.env.CAREER_KIT_SQLITE_REEXEC && process.argv[1]) {
    const child = spawnSync(
      process.execPath,
      [FLAG, "--disable-warning=ExperimentalWarning", process.argv[1], ...process.argv.slice(2)],
      { stdio: "inherit", env: { ...process.env, CAREER_KIT_SQLITE_REEXEC: "1" } },
    );
    process.exit(child.status ?? 1);
  }

  process.stderr.write(
    `career-kit: career.db needs Node 22+ with node:sqlite (this is Node ${process.versions.node}).\n` +
      "  The rest of the kit works without it: the gate, the schema and the validator have no\n" +
      "  database dependency. Only db.mjs and log.mjs do.\n" +
      (flagMightHelp ? `  On this version, try: node ${FLAG} engine/db.mjs\n` : "  Upgrade to Node 22.13 or later.\n"),
  );
  process.exit(2);
}

const SCHEMA_PATH = new URL("./schema.sql", import.meta.url);

export async function openDb(P, { schema = true } = {}) {
  const { DatabaseSync } = await requireSqlite();
  const db = new DatabaseSync(P.db);
  if (schema) db.exec(readFileSync(SCHEMA_PATH, "utf8"));
  return db;
}

/* ── the contract ──────────────────────────────────────────────────────── */

/**
 * The whitelist. Every column here is rebuilt from the job record on every run.
 * Every column NOT here belongs to a human and this file must never write it.
 */
export const MACHINE_COLS = [
  "role", "channel", "target", "send_status", "sent_at", "sent_at_source",
  "message_id", "subject", "receipt", "needs_human", "duplicate_submission",
  "notes", "source", "url", "route_confidence", "identity_domain",
  "identity_verified", "discovered_at", "location", "workplace_type",
  "comp_currency", "comp_min", "comp_max", "comp_period", "equity", "orphaned",
];

/** Kept in step with the CHECK constraint in schema.sql. */
export const STAGES = [
  "discovered", "draft", "applied", "replied", "screening", "interview", "offer",
  "rejected", "withdrawn", "closed", "no_response", "no_route",
];

const bool = (v) => (v ? 1 : 0);
const orNull = (v) => (v === undefined || v === "" ? null : v);

const SENT = new Set(["sent", "sent-unverified"]);

/**
 * The stage a row STARTS at, written once on the first insert and never again.
 *
 * Derived from what actually happened, not from a constant. The schema DEFAULT
 * is the tracker's old 'applied', which was right where every row WAS an
 * application. Here jobs/ also holds roles that were only ever discovered, and
 * the default made a pipeline of nine discovered roles report as nine
 * applications when one had gone out. A view that overstates what you did is
 * worse than no view.
 *
 * `failed` deliberately seeds "draft" rather than "no_route": a send that
 * errored is not the same as a target with no way in, and the stage column
 * should not assert a cause the record does not support. It stays actionable.
 */
const STAGE_SEED = {
  sent: "applied",
  "sent-unverified": "applied",
  skipped: "closed",
  drafted: "draft",
  claimed: "draft",
  failed: "draft",
};
const seedStage = (job) => STAGE_SEED[job.status] ?? "discovered";

function rowFor(job) {
  const comp = job.posted_comp || {};
  return {
    role: orNull(job.role),
    channel: orNull(job.apply?.channel),
    target: orNull(job.apply?.target),
    send_status: orNull(job.status),
    sent_at: orNull(job.sent_at),
    sent_at_source: orNull(job.sent_at_source),
    message_id: orNull(job.message_id),
    subject: orNull(job.subject),
    receipt: orNull(job.receipt),
    needs_human: bool(job.needs_human),
    duplicate_submission: bool(job.duplicate_submission),
    notes: orNull(job.notes),
    source: orNull(job.source),
    url: orNull(job.url),
    route_confidence: job.apply?.route_confidence ?? null,
    identity_domain: orNull(job.apply?.identity_domain),
    identity_verified: bool(job.apply?.identity_verified),
    discovered_at: orNull(job.discovered_at),
    location: orNull(job.location),
    workplace_type: orNull(job.workplace_type),
    // Posted terms come off the record the adapter wrote. A field the posting
    // did not state stays NULL, because a guess in a compensation column is
    // worse than a blank one.
    comp_currency: orNull(comp.currency),
    comp_min: comp.min ?? null,
    comp_max: comp.max ?? null,
    comp_period: comp.period ?? "year",
    equity: orNull(comp.equity),
    orphaned: 0,
  };
}

/* ── rebuild ───────────────────────────────────────────────────────────── */

export async function rebuild(P, { prune = false } = {}) {
  const fresh = !existsSync(P.db);
  const db = await openDb(P);

  const files = existsSync(P.jobs) ? readdirSync(P.jobs).filter((f) => f.endsWith(".json")).sort() : [];
  const report = {
    db: P.db,
    created: fresh,
    records: 0,
    sent: 0,
    invalid: [],
    orphans: [],
    pruned: 0,
  };

  const cols = MACHINE_COLS.join(", ");
  const marks = MACHINE_COLS.map(() => "?").join(", ");
  const upd = MACHINE_COLS.map((c) => `${c}=excluded.${c}`).join(", ");

  const upsertCompany = db.prepare(
    "INSERT INTO companies (id, name, domains, website) VALUES (?,?,?,?) " +
      "ON CONFLICT(id) DO UPDATE SET name=excluded.name, domains=excluded.domains",
  );
  // `stage` appears in the INSERT and NOT in the DO UPDATE, which is the whole
  // trick: the first rebuild seeds an honest starting stage, and every rebuild
  // after that leaves it alone because it is human-owned.
  //
  // Seeding it matters. The schema's DEFAULT is 'applied', which was right in
  // the system this came from, where every row WAS an application. Here jobs/
  // also holds roles that were merely discovered, so the default reported nine
  // applications when one had been sent. A pipeline view that overstates what
  // you did is worse than no pipeline view.
  const upsertApp = db.prepare(
    `INSERT INTO applications (id, company_id, ${cols}, stage, updated_at) ` +
      `VALUES (?, ?, ${marks}, ?, datetime('now')) ` +
      `ON CONFLICT(id) DO UPDATE SET company_id=excluded.company_id, stage=excluded.stage, ${upd}, updated_at=datetime('now')`,
  );
  // Seeding alone leaves a hole: a role discovered on Monday seeds "discovered",
  // and when it is actually sent on Tuesday the DO UPDATE above will not touch
  // the stage, so the pipeline would report "discovered" for a sent application
  // forever. That understates what you did, which is the same disease as the old
  // default overstating it.
  //
  // So the PRE-SEND seeded values, and only those, advance once on the first
  // send. Every other stage means a person typed it and it is left alone. This
  // is the same conditional-update idiom log.mjs uses to move applied ->
  // replied on an inbound message, bounded by the same rule: never overwrite a
  // stage a human chose.
  //
  // The two listed here must stay in step with the pre-send values in
  // STAGE_SEED. If a new one is added there and not here, applications sent
  // from that state silently never leave it.
  const advanceSeededStage = db.prepare(
    "UPDATE applications SET stage = 'applied' WHERE id = ? AND stage IN ('discovered', 'draft')",
  );
  const insertEvent = db.prepare(
    "INSERT OR IGNORE INTO events (application_id, ts, direction, channel, summary, message_id) VALUES (?,?,?,?,?,?)",
  );
  const insertContact = db.prepare(
    "INSERT OR IGNORE INTO contacts (company_id, email, source) VALUES (?,?,?)",
  );

  const seen = new Set();

  for (const file of files) {
    const path = join(P.jobs, file);
    let job;
    try {
      job = JSON.parse(readFileSync(path, "utf8"));
    } catch (err) {
      report.invalid.push({ file, errors: [{ path: "$", message: `unreadable JSON: ${err.message}` }] });
      continue;
    }
    if (!job || typeof job.id !== "string" || !job.id) {
      report.invalid.push({ file, errors: [{ path: "$.id", message: "missing; cannot key a row on it" }] });
      continue;
    }

    // A record that fails the schema is still ingested, and still reported. The
    // alternative silently drops it, and a tracker that quietly holds fewer
    // applications than the jobs directory is worse than one with a bad row in
    // it: nothing tells you to go and look.
    const result = validateJob(job);
    if (!result.ok) report.invalid.push({ file, id: job.id, errors: result.errors });

    seen.add(job.id);
    report.records++;
    if (SENT.has(job.status)) report.sent++;

    const companyId = job.company_id || job.id;
    const domains = Array.isArray(job.domains) ? job.domains : [];
    upsertCompany.run(companyId, job.company || companyId, domains.join(","), domains[0] ?? null);

    const row = rowFor(job);
    upsertApp.run(job.id, companyId, ...MACHINE_COLS.map((c) => row[c]), seedStage(job));
    if (SENT.has(job.status)) advanceSeededStage.run(job.id);

    // The application itself is the first outbound event.
    if ((job.status === "sent" || job.status === "sent-unverified") && job.sent_at) {
      insertEvent.run(
        job.id,
        job.sent_at,
        "out",
        job.apply?.channel ?? null,
        job.subject || "application submitted",
        job.message_id || null,
      );
    }
    if (job.apply?.channel === "email" && job.apply?.target) {
      for (const addr of String(job.apply.target).split(/[\s,;]+/).filter((t) => t.includes("@"))) {
        insertContact.run(companyId, addr.replace(/^[<(]+|[>),]+$/g, ""), "application target");
      }
    }
  }

  /* orphan reconciliation */
  const known = db.prepare("SELECT id, company_id, send_status, sent_at FROM applications").all();
  const flag = db.prepare("UPDATE applications SET orphaned = 1 WHERE id = ?");
  const unflag = db.prepare("UPDATE applications SET orphaned = 0 WHERE id = ?");
  for (const row of known) {
    if (seen.has(row.id)) {
      unflag.run(row.id);
      continue;
    }
    report.orphans.push({ id: row.id, company_id: row.company_id, send_status: row.send_status, sent_at: row.sent_at });
    flag.run(row.id);
  }
  if (prune && report.orphans.length) {
    const delEvents = db.prepare("DELETE FROM events WHERE application_id = ?");
    const delApp = db.prepare("DELETE FROM applications WHERE id = ?");
    for (const o of report.orphans) {
      delEvents.run(o.id);
      delApp.run(o.id);
      report.pruned++;
    }
  }

  return { db, report };
}

/* ── show ──────────────────────────────────────────────────────────────── */

const COLUMNS = [
  ["company", 30], ["role", 40], ["channel", 18], ["sent", 16], ["stage", 11], ["posted_comp", 16],
];

export function showPipeline(db) {
  const rows = db.prepare(`SELECT ${COLUMNS.map(([c]) => c).join(", ")} FROM v_pipeline`).all();
  const lines = [
    COLUMNS.map(([c, w]) => c.padEnd(w)).join(" | "),
    COLUMNS.map(([, w]) => "-".repeat(w)).join("-+-"),
  ];
  for (const r of rows) {
    lines.push(
      COLUMNS.map(([c, w]) => String(r[c] ?? "").replace(/\s+/g, " ").slice(0, w).padEnd(w)).join(" | "),
    );
  }
  return lines.join("\n");
}

/* ── CLI ───────────────────────────────────────────────────────────────── */

const USAGE = "usage: db.mjs [rebuild] [--show] [--json] [--prune]";

async function main(argv) {
  const known = new Set(["--show", "--json", "--prune"]);
  const bad = argv.find((a) => a.startsWith("--") && !known.has(a));
  if (bad) {
    process.stderr.write(`db: unknown flag ${bad}. ${USAGE}\n`);
    process.exit(2);
  }
  // "rebuild" is the only verb this command has, and naming it is clearer at a
  // call site than a bare `db.mjs`. It is accepted explicitly rather than
  // ignored: an unrecognised positional used to fall through silently, so
  // `db.mjs --prne` typo'd into a full no-op that reported success.
  const positional = argv.filter((a) => !a.startsWith("--"));
  const stray = positional.find((a) => a !== "rebuild");
  if (stray !== undefined) {
    process.stderr.write(`db: unknown argument "${stray}". ${USAGE}\n`);
    process.exit(2);
  }

  const P = ensureRuntimeDirs(paths(findCareerHome()));
  const { db, report } = await rebuild(P, { prune: argv.includes("--prune") });

  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify(report, null, 2) + "\n");
  } else {
    process.stdout.write(`${report.created ? "created" : "refreshed"} ${report.db}\n`);
    process.stdout.write(`${report.records} records, ${report.sent} sent\n`);
  }

  for (const bad of report.invalid) {
    process.stderr.write(
      `db: ${bad.file} does not match the job schema and was ingested anyway:\n` +
        bad.errors.map((e) => `    ${e.path} ${e.message}`).join("\n") +
        "\n    Fix it with: node engine/validate.mjs --fix\n",
    );
  }
  if (report.orphans.length) {
    process.stderr.write(
      `db: ${report.orphans.length} row(s) have no jobs/<id>.json any more and are flagged orphaned:\n` +
        report.orphans.map((o) => `    ${o.id} (${o.send_status ?? "unknown"}${o.sent_at ? `, sent ${o.sent_at}` : ""})`).join("\n") +
        "\n    They are kept, not deleted. Restore the record, or run --prune to drop them.\n",
    );
  }

  if (argv.includes("--show")) process.stdout.write("\n" + showPipeline(db) + "\n");
  db.close();
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
