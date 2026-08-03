/**
 * helpers.mjs - a scratch workspace per test, and a way to run the engine
 * against it.
 *
 * Every test gets its own $CAREER_HOME under os.tmpdir(). Tests that share a
 * workspace share a ledger, and a shared ledger makes a quota test pass or fail
 * depending on which test ran first. That is the same class of bug the gate
 * exists to stop, so the test suite does not get to have it either.
 *
 * The persona is fictional and every value here is synthetic. Nothing in this
 * repo is anyone's real data.
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const ENGINE = join(HERE, "..", "engine");
export const GATE = join(ENGINE, "gate.mjs");
export const DB = join(ENGINE, "db.mjs");
export const LOG = join(ENGINE, "log.mjs");
export const VALIDATE = join(ENGINE, "validate.mjs");
export const INIT = join(ENGINE, "init.mjs");
export const DOCTOR = join(ENGINE, "doctor.mjs");
export const BOARD = join(ENGINE, "board.mjs");

/**
 * An empty scratch directory that is NOT a workspace, for the two commands that
 * have to work before one exists. makeWorkspace() cannot serve here: it writes
 * profile.yaml, which is the very marker init and doctor are deciding on.
 */
export function makeEmptyDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "career-kit-empty-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * The banned character, written as an escape so this file does not itself
 * contain the thing the product forbids. Tests need it to feed a bad draft in.
 */
export const EM_DASH = "\u2014";

export const DEFAULT_JOB_ID = "northwind-founding-software-engineer";

const PROFILE = `name: Ada Lovelace
preferred_name: Ada
email: ada@example.com
phone: "+44 20 7946 0000"
location: { city: London, region: England, country: United Kingdom, timezone: Europe/London }
links:
  linkedin: https://example.com/in/ada
  github:   https://example.com/ada
work_authorization:
  - { region: UK, status: citizen }
  - { region: US, status: visa-required, sponsorship_needed: true }
relocation: { willing: false, notes: "Open to travel for onsites." }
notice_period: "4 weeks"
mail: { account: ada@example.com, from_name: Ada Lovelace }
`;

/**
 * minGapMinutes is 0 on purpose: a real workspace wants a gap, but a test that
 * depends on wall-clock spacing is a flake generator. The gap has its own test.
 */
const RULES = `mode: review
autopilot_channels: []

limits:
  maxPerDay: 8
  minGapMinutes: 0
  perSourcePerDay: { linkedin: 5 }

company:
  maxApplications: 1
  cooldownDays: 365
  followups_allowed: false

roles:
  allow: [software engineer, senior engineer, staff engineer, founding engineer,
          member of technical staff, backend, platform, infrastructure, applied ai]
  deny:  [machine learning engineer, ml engineer, research scientist,
          design engineer, product designer, engineering manager]

content:
  banned_characters: ["\\u2014"]
  banned_phrases: ["I hope this email finds you well", "circle back", "synergies"]
  max_sections: 2
  max_sentences: 8

cv:
  regenerate_per_role: false

lease:  { seconds: 600 }
clock:  { skewSeconds: 300 }
receipts:
  required_channels: [form, ats-ashby, ats-greenhouse, ats-lever]
`;

const VOICE = `# Voice

## Register
Plain sentences of fifteen to twenty words. One idea per sentence.

## Hard limits
Two sections. Eight sentences.

## Negative rules
Never the em dash. It reads as a machine wrote it.

## Provenance
Template, unedited. Derived from nothing yet.
`;

const KB = `# Knowledge base

- Built a payments ingestion service that handled 40k events per minute at peak.
- Cut median checkout latency from 900ms to 210ms over one quarter.
- Led a team of 4 engineers through a migration off a single Postgres instance.
- Wrote the on-call runbook that took mean time to recovery from 45 minutes to 12.
- Shipped an internal agent harness used by 30 engineers.
`;

export function jobRecord(overrides = {}) {
  const base = {
    id: DEFAULT_JOB_ID,
    company: "Northwind",
    company_id: "northwind",
    domains: ["northwind.example"],
    role: "Founding Software Engineer",
    seniority: "senior",
    source: "ashby",
    source_id: "00000000-0000-0000-0000-000000000000",
    url: "https://jobs.example/northwind/founding-software-engineer",
    apply: {
      channel: "email",
      target: "jobs@northwind.example",
      route_confidence: 0.9,
      identity_verified: true,
      identity_domain: "northwind.example",
    },
    location: "Remote",
    workplace_type: "remote",
    posted_comp: { currency: "USD", min: 180000, max: 220000, period: "year", equity: "0.5%" },
    status: "drafted",
    sent_at: null,
    sent_at_source: null,
    message_id: null,
    subject: null,
    receipt: null,
    needs_human: false,
    notes: null,
    evidence: [],
    incidents: [],
    escalations: [],
    discovered_at: "2026-07-28T08:00:00Z",
    updated_at: "2026-07-28T08:00:00Z",
  };
  const { apply, ...rest } = overrides;
  return { ...base, ...rest, apply: { ...base.apply, ...(apply || {}) } };
}

/**
 * @param {object} opts
 * @param {string} [opts.rules]  full rules.yaml text
 * @param {object} [opts.job]    overrides merged into the default job record
 * @param {object[]} [opts.jobs] extra job records
 */
export function makeWorkspace(opts = {}) {
  const home = mkdtempSync(join(tmpdir(), "career-kit-test-"));
  writeFileSync(join(home, "profile.yaml"), PROFILE);
  writeFileSync(join(home, "rules.yaml"), opts.rules ?? RULES);
  writeFileSync(join(home, "voice.md"), VOICE);
  writeFileSync(join(home, "knowledge-base.md"), KB);
  mkdirSync(join(home, "jobs"), { recursive: true });

  const ws = {
    home,
    job: (id = DEFAULT_JOB_ID) => join(home, "jobs", `${id}.json`),
    ledger: join(home, ".ledger.jsonl"),
    leases: join(home, ".leases"),
    lease: (id, channel) => join(home, ".leases", `${id}.${channel}.json`),
    writeJob: (overrides) => {
      const rec = jobRecord(overrides);
      writeFileSync(join(home, "jobs", `${rec.id}.json`), JSON.stringify(rec, null, 2) + "\n");
      return rec;
    },
    readJob: (id = DEFAULT_JOB_ID) => JSON.parse(readFileSync(join(home, "jobs", `${id}.json`), "utf8")),
    readLedger: () => {
      const path = join(home, ".ledger.jsonl");
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
    },
    file: (rel, text) => {
      const path = join(home, rel);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return path;
    },
    run: (argv) => runSync(home, GATE, argv),
    db: (argv = []) => runSync(home, DB, argv),
    log: (argv) => runSync(home, LOG, argv),
    validate: (argv = []) => runSync(home, VALIDATE, argv),
    init: (argv = ["--no-git"]) => runSync(home, INIT, argv),
    doctor: (argv = ["--json"]) => runSync(home, DOCTOR, argv),
    board: (argv = ["--json"]) => runSync(home, BOARD, argv),
    runAsync: (argv) => runAsync(home, GATE, argv),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };

  ws.writeJob(opts.job ?? {});
  for (const extra of opts.jobs ?? []) ws.writeJob(extra);
  return ws;
}

function shape(code, stdout, stderr) {
  let json = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    /* not every command prints JSON; --show prints a table */
  }
  return { code, stdout, stderr, json };
}

export function runSync(home, script, argv) {
  const r = spawnSync(process.execPath, [script, ...argv.map(String)], {
    env: { ...process.env, CAREER_HOME: home, NO_COLOR: "1" },
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  return shape(r.status, r.stdout ?? "", r.stderr ?? "");
}

/** Never rejects: a non-zero exit is the result, not an exception. */
export function runAsync(home, script, argv) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, ...argv.map(String)],
      { env: { ...process.env, CAREER_HOME: home, NO_COLOR: "1" } },
      (err, stdout, stderr) => resolve(shape(err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr)),
    );
  });
}

/** claim + record in one go, for tests whose subject is what happens afterwards. */
export function sendOnce(ws, { channel = "email", sentAt = new Date().toISOString(), extra = [] } = {}) {
  const claimed = ws.run(["claim", "--id", DEFAULT_JOB_ID, "--channel", channel, "--route", "https://example.com/apply"]);
  if (claimed.code !== 0) throw new Error(`claim failed: ${claimed.stderr}`);
  return ws.run([
    "record", "--id", DEFAULT_JOB_ID, "--token", claimed.json.token,
    "--status", "sent", "--sent-at", sentAt, "--sent-at-source", "transport",
    ...extra,
  ]);
}

/** The arguments `check` needs to get past the measurement guards. */
export const CHECK_OK = [
  "--sent-check", "0",
  "--sent-check-query", 'to:jobs@northwind.example',
  "--identity-domain", "northwind.example",
];
