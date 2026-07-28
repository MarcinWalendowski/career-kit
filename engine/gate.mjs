#!/usr/bin/env node
/**
 * gate.mjs - the single choke point for every irreversible action in the kit.
 *
 * A skill must NEVER decide from memory whether an application already went
 * out. It asks this script, it claims through this script, and it records
 * through this script. Disk is the source of truth.
 *
 * WHY THIS EXISTS, in one incident. On 2026-07-27 one company received two
 * applications for the same req seven minutes apart, because an agent read its
 * dedupe state at task start rather than immediately before the send, and a
 * second actor was already mid-flight on the same URL. The two submissions
 * gave contradictory answers to the same relocation question. No correction
 * was sent, because the one-contact-per-company rule forbids one. That is one
 * duplicate in thirty-four applications: a 3% failure rate on the rule the
 * prose contract called the most important one it had.
 *
 * Every guard below is that class of failure turned into an exit code.
 *
 *   claim   writes the intent BEFORE the action, with open(..., "wx"). Atomic
 *           on POSIX and on APFS. A second claimant gets EEXIST, not a race.
 *   record  refuses a token older than rules.lease.seconds, which structurally
 *           enforces "re-read state in the same breath as acting" instead of
 *           asking for it in prose.
 *   check   takes the Sent-folder count as a REQUIRED argument. A missing
 *           count blocks. An unknown number is never a pass.
 *   resolve is the only way out of an expired lease. Expiry does not
 *           self-heal: somebody goes and looks at the Sent folder. Failing
 *           toward a stall is the correct direction when the alternative is
 *           reopening the double-send window.
 *
 * Commands
 *   status                                     mode, quota use, open leases, recent blocks
 *   check   --id --channel --sent-check <n> --sent-check-query <q> --identity-domain <d>
 *                                              [--draft <path>]  may we act? 0 = yes, 3 = no
 *   claim   --id --channel [--route --identity-domain --actor]   mints a token
 *   record  --id --token --status --sent-at --sent-at-source transport [--receipt]
 *   release --id --channel --token --reason    clean abandon
 *   resolve --id --channel --outcome sent|not-sent [--evidence]
 *   leases                                     every open lease, with age
 *   verify  --artifact <path> [--strict]       flag claims that no KB line supports
 *
 * Exit codes: 0 allowed or done, 2 usage error, 3 blocked.
 * JSON on stdout. Human notes on stderr.
 */

import {
  readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync,
  unlinkSync, mkdirSync, copyFileSync, statSync,
} from "node:fs";
import { basename, join } from "node:path";
import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import { findCareerHome, paths, ensureRuntimeDirs, slug } from "./paths.mjs";
import { readYaml, CHANNELS, SEND_CHANNELS } from "./validate.mjs";

/* ── args ──────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > -1) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) {
      out[a.slice(2)] = argv[++i];
    } else {
      out[a.slice(2)] = true;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0] || "status";

const die = (msg) => {
  process.stderr.write(`gate: ${msg}\n`);
  process.exit(2);
};

const print = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");
const note = (s) => process.stderr.write(`gate: ${s}\n`);

/* ── workspace ─────────────────────────────────────────────────────────── */

const P = ensureRuntimeDirs(paths(findCareerHome()));

const DEFAULT_RULES = {
  mode: "review",
  autopilot_channels: [],
  limits: { maxPerDay: 8, minGapMinutes: 4, perSourcePerDay: {} },
  company: { maxApplications: 1, cooldownDays: 365, followups_allowed: false },
  roles: { allow: [], deny: [] },
  content: { banned_characters: [], banned_phrases: [], max_sections: 2, max_sentences: 8 },
  cv: { regenerate_per_role: false },
  lease: { seconds: 600 },
  clock: { skewSeconds: 300 },
  receipts: { required_channels: [] },
};

/**
 * Read-only commands tolerate a missing rules.yaml so a half-provisioned
 * workspace can still be inspected. Anything that can lead to a send does not:
 * defaulting `mode` to "review" for a user who never wrote the file would let
 * the kit send on behalf of someone who never chose a mode.
 */
function loadRules({ required }) {
  const raw = readYaml(P.rules, { required, fallback: null });
  if (raw === null) {
    note(`no rules.yaml in ${P.home}; using built-in defaults for this read-only command`);
    return DEFAULT_RULES;
  }
  const merged = { ...DEFAULT_RULES, ...raw };
  for (const key of ["limits", "company", "roles", "content", "cv", "lease", "clock", "receipts"]) {
    merged[key] = { ...DEFAULT_RULES[key], ...(raw[key] || {}) };
  }
  if (!["draft", "review", "autopilot"].includes(merged.mode)) {
    die(`rules.yaml: mode must be draft | review | autopilot (got ${JSON.stringify(merged.mode)})`);
  }
  return merged;
}

/* ── ledger ────────────────────────────────────────────────────────────── */

const MINUTE = 60_000;
const DAY = 86_400_000;
const nowMs = () => Date.now();
const nowIso = () => new Date().toISOString();
const ts = (e) => Date.parse(e.at);

/**
 * .ledger.jsonl is append-only, one object per line, opened O_APPEND. The
 * whole-file-rewrite ledger this pattern came from races two agents: both read,
 * both write, one entry disappears, and the disappeared entry is exactly the
 * "already sent" record that would have blocked the duplicate. An append below
 * PIPE_BUF does not race.
 */
function appendLedger(entry) {
  appendFileSync(P.ledger, JSON.stringify({ at: nowIso(), ...entry }) + "\n");
}

function loadLedger() {
  if (!existsSync(P.ledger)) return [];
  const out = [];
  const lines = readFileSync(P.ledger, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (!line.trim()) return;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A crash mid-append can leave one torn line. Losing that line is
      // survivable; refusing to read the other 400 is not.
      note(`.ledger.jsonl:${i + 1} is not valid JSON and was skipped`);
    }
  });
  return out;
}

const SENT_STATUSES = new Set(["sent", "sent-unverified"]);
const sends = (ledger) => ledger.filter((e) => e.kind === "record" && SENT_STATUSES.has(e.status));
const since = (entries, ms) => entries.filter((e) => ts(e) >= nowMs() - ms);

/* ── job records ───────────────────────────────────────────────────────── */

function loadJob(id, { required = true } = {}) {
  const path = P.job(id);
  if (!existsSync(path)) {
    if (!required) return null;
    die(
      `no job record at ${path}.\n` +
        "  Every gated action needs one: it holds the domains the identity guard checks\n" +
        "  and the role the filter reads. Run career-sources, or write the record first.",
    );
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    die(`${path} is not valid JSON: ${err.message}`);
  }
}

function saveJob(job) {
  job.updated_at = nowIso();
  writeFileSync(P.job(job.id), JSON.stringify(job, null, 2) + "\n");
}

/* ── leases ────────────────────────────────────────────────────────────── */

function readLease(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function openLeases() {
  if (!existsSync(P.leases)) return [];
  return readdirSync(P.leases)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: join(P.leases, f), lease: readLease(join(P.leases, f)) }))
    .filter((x) => x.lease)
    .map(({ file, lease }) => ({
      ...lease,
      file,
      age_seconds: Math.round((nowMs() - Date.parse(lease.claimed_at)) / 1000),
      expired: Date.parse(lease.expires_at) < nowMs(),
    }));
}

/** record takes --id and --token but not necessarily --channel: find the lease by id. */
function findLease(id, channel) {
  if (channel) {
    const file = P.lease(id, channel);
    const lease = existsSync(file) ? readLease(file) : null;
    return lease ? { ...lease, file } : null;
  }
  const prefix = `${slug(id)}.`;
  const matches = existsSync(P.leases)
    ? readdirSync(P.leases).filter((f) => f.startsWith(prefix) && f.endsWith(".json"))
    : [];
  if (matches.length > 1) {
    die(
      `${matches.length} open leases for "${id}" (${matches.join(", ")}). Pass --channel to say which one.`,
    );
  }
  if (!matches.length) return null;
  const file = join(P.leases, matches[0]);
  const lease = readLease(file);
  return lease ? { ...lease, file } : null;
}

/* ── block ─────────────────────────────────────────────────────────────── */

/**
 * Every block is written to the ledger, not just every success. A gate that
 * only records what it let through cannot tell you it is working, and cannot
 * be audited after the fact for the one it should have stopped.
 */
function block(reason, detail, extra = {}) {
  appendLedger({
    kind: "block",
    reason,
    detail,
    id: args.id ?? null,
    channel: args.channel ?? null,
    command: cmd,
  });
  note(detail);
  print({ allowed: false, blocked: reason, reason, detail, id: args.id ?? null, channel: args.channel ?? null, ...extra });
  process.exit(3);
}

/* ── shared validation ─────────────────────────────────────────────────── */

function requireChannel(channel) {
  if (!channel || channel === true) die(`--channel is required (${CHANNELS.join(" | ")})`);
  if (!CHANNELS.includes(channel)) {
    die(`unknown channel "${channel}". Known: ${CHANNELS.join(", ")}`);
  }
  return channel;
}

function requireId(id) {
  if (!id || id === true) die("--id is required (the job record id)");
  return String(id);
}

/** Word-boundary phrase match, so "ml engineer" does not fire on "html engineering". */
const phraseHit = (haystack, phrase) =>
  new RegExp(`\\b${String(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(haystack);

/**
 * The role filter, from rules.yaml. `deny` wins over `allow`, and a non-empty
 * `allow` that matches nothing is also a block. A dead-on-arrival application
 * to a role the user does not want spends a first impression that a company
 * only gives once.
 */
function roleCheck(job, rules) {
  const role = String(job.role || "");
  const denied = (rules.roles.deny || []).find((d) => phraseHit(role, d));
  if (denied) {
    block("role-excluded", `"${role}" matches roles.deny entry "${denied}" in rules.yaml`, {
      role,
      matched: denied,
      list: "deny",
    });
  }
  const allow = rules.roles.allow || [];
  if (allow.length && !allow.some((a) => phraseHit(role, a))) {
    block(
      "role-excluded",
      `"${role}" matches nothing in roles.allow. Add it to rules.yaml if you want this kind of role.`,
      { role, list: "allow" },
    );
  }
}

/**
 * Mode, from rules.yaml. `draft` blocks every send channel outright.
 * `autopilot` blocks channels the user did not name in autopilot_channels,
 * rather than quietly downgrading them to review: under autopilot nobody is
 * watching, so an un-opted-in channel must stop rather than proceed unattended.
 */
function modeCheck(channel, rules) {
  if (!SEND_CHANNELS.includes(channel)) return;
  if (rules.mode === "draft") {
    block(
      "mode-draft",
      `rules.yaml has mode: draft, so nothing sends. Drafts are fine; ${channel} is not.`,
      { mode: rules.mode, channel },
    );
  }
  if (rules.mode === "autopilot" && !(rules.autopilot_channels || []).includes(channel)) {
    block(
      "channel-not-autopiloted",
      `mode is autopilot but "${channel}" is not in autopilot_channels. Opt in per channel, explicitly.`,
      { mode: rules.mode, channel, autopilot_channels: rules.autopilot_channels },
    );
  }
}

/**
 * The identity guard. An ATS board slug is not proof of who owns it: in the
 * sweep this generalises, three slugs each resolved to a different company than
 * the one intended. That was a warning in a markdown file. Here it stops.
 */
function identityCheck(job, rules, domain) {
  if (!domain || domain === true) {
    block(
      "identity-unknown",
      "--identity-domain is required. Fetch the posting, read whose company it actually is, and pass it. " +
        "An unverified identity is not a verified one.",
      { domains: job.domains || [] },
    );
  }
  const want = (job.domains || []).map((d) => String(d).toLowerCase().replace(/^www\./, ""));
  const got = String(domain).toLowerCase().replace(/^https?:\/\//, "").split("/")[0].replace(/^www\./, "");

  // An empty domains[] is a DIFFERENT failure from a conflicting one, and saying
  // "different company" here sends the reader hunting for a collision that does
  // not exist. It is the normal state of a freshly ingested record: an ATS board
  // payload states the board slug and the role, never the company's own domain.
  // Route resolution is what fills domains[] in, so name that as the fix. Both
  // cases still block, because an identity nobody established is not one that
  // was checked.
  if (want.length === 0) {
    block(
      "identity-unknown",
      `the record has no domains[] to check "${got}" against. An ATS board payload does not carry ` +
        "the company's own domain, so a freshly ingested record has none. Run route resolution " +
        "(career-sources) to populate domains[] from the posting itself, then re-check.",
      { identity_domain: got, domains: [] },
    );
  }

  const ok = want.some((d) => got === d || got.endsWith(`.${d}`));
  if (!ok) {
    block(
      "identity-mismatch",
      `route resolves to "${got}" but the record's domains are [${want.join(", ")}]. ` +
        "Different company. Do not send.",
      { identity_domain: got, domains: want },
    );
  }
  return got;
}

/** Rate limits and the one-contact-per-company rule, all from rules.yaml. */
function limitCheck(job, rules, ledger) {
  const all = sends(ledger);

  const forCompany = all.filter((e) => e.company_id === job.company_id);
  if (forCompany.length >= rules.company.maxApplications) {
    const last = forCompany[forCompany.length - 1];
    block(
      "company-cap",
      `${forCompany.length} application(s) already recorded for "${job.company_id}", ` +
        `cap is ${rules.company.maxApplications}. The last one went out ${last.at}. ` +
        "There is no follow-up and no correction: one contact per company, ever.",
      { company_id: job.company_id, previous: last, cap: rules.company.maxApplications },
    );
  }
  // Reachable only when maxApplications > 1. With the shipped cap of 1 the
  // company-cap block above always fires first, which is intended.
  const cooldownMs = (rules.company.cooldownDays || 0) * DAY;
  const recent = forCompany.filter((e) => nowMs() - ts(e) < cooldownMs);
  if (cooldownMs && recent.length) {
    const last = recent[recent.length - 1];
    block(
      "cooldown",
      `applied to "${job.company_id}" on ${last.at}, inside the ${rules.company.cooldownDays}-day cooldown`,
      { company_id: job.company_id, previous: last, cooldownDays: rules.company.cooldownDays },
    );
  }

  const today = since(all, DAY);
  if (today.length >= rules.limits.maxPerDay) {
    block(
      "quota",
      `${today.length}/${rules.limits.maxPerDay} applications in the last 24h`,
      {
        used: today.length,
        limit: rules.limits.maxPerDay,
        nextAllowedAt: new Date(ts(today[0]) + DAY).toISOString(),
      },
    );
  }

  const perSource = rules.limits.perSourcePerDay || {};
  const sourceCap = perSource[job.source];
  if (sourceCap !== undefined) {
    const fromSource = since(all.filter((e) => e.source === job.source), DAY);
    if (fromSource.length >= sourceCap) {
      block("quota", `${fromSource.length}/${sourceCap} from source "${job.source}" in the last 24h`, {
        scope: "source",
        source: job.source,
        used: fromSource.length,
        limit: sourceCap,
      });
    }
  }

  const last = all[all.length - 1];
  if (last && rules.limits.minGapMinutes) {
    const nextAt = ts(last) + rules.limits.minGapMinutes * MINUTE;
    if (nowMs() < nextAt) {
      block(
        "min-gap",
        `last application was ${Math.round((nowMs() - ts(last)) / MINUTE)}m ago, ` +
          `minimum gap is ${rules.limits.minGapMinutes}m`,
        { nextAllowedAt: new Date(nextAt).toISOString() },
      );
    }
  }

  return { used: today.length, limit: rules.limits.maxPerDay, remaining: Math.max(0, rules.limits.maxPerDay - today.length) };
}

/** A pending lease held by anyone, including us, means someone is mid-flight. */
function leaseCheck(id, channel) {
  const lease = findLease(id, channel);
  if (!lease) return null;
  if (Date.parse(lease.expires_at) < nowMs()) {
    block(
      "stale-lease",
      `a lease on ${id}/${lease.channel} expired at ${lease.expires_at} and was never recorded. ` +
        "It does NOT free itself. Go look at the Sent folder, then run:\n" +
        `  gate resolve --id ${id} --channel ${lease.channel} --outcome sent|not-sent`,
      { lease },
    );
  }
  block(
    "pending-elsewhere",
    `${id}/${lease.channel} is already claimed by pid ${lease.pid} on ${lease.host} at ${lease.claimed_at}` +
      (lease.actor ? ` (actor: ${lease.actor})` : ""),
    { lease: { pid: lease.pid, host: lease.host, claimed_at: lease.claimed_at, expires_at: lease.expires_at, actor: lease.actor } },
  );
  return null;
}

/* ── check ─────────────────────────────────────────────────────────────── */

function cmdCheck() {
  const id = requireId(args.id);
  const channel = requireChannel(args.channel);
  const rules = loadRules({ required: true });
  const job = loadJob(id);
  const ledger = loadLedger();

  // The measurement guards come FIRST, on purpose. Everything below them is a
  // policy question; these two are "do we even know what we are looking at".
  //
  // A missing --sent-check is a BLOCK, not a pass. This mirrors the reaction
  // floor in the skill gate this file is modelled on, which was written after a
  // run talked itself past a threshold it had no number for. An unknown count
  // is never evidence of zero.
  if (args["sent-check"] === undefined) {
    block(
      "sent-check-missing",
      "--sent-check is required: the number of messages your Sent folder already holds for this target. " +
        "Search it now, in the same breath as this check, and pass the count. Not knowing is not zero.",
    );
  }
  if (!args["sent-check-query"] || args["sent-check-query"] === true) {
    block(
      "sent-check-missing",
      "--sent-check-query is required: the exact query you ran. A count with no query behind it " +
        "cannot be reproduced, and an unreproducible dedupe check is a claim, not a check.",
    );
  }
  const sentCheck = Number(args["sent-check"]);
  if (!Number.isFinite(sentCheck) || sentCheck < 0) {
    die(`--sent-check must be a non-negative number (got "${args["sent-check"]}")`);
  }
  if (sentCheck > 0) {
    block(
      "already-sent",
      `the Sent folder already holds ${sentCheck} message(s) matching ${JSON.stringify(args["sent-check-query"])}`,
      { sent_check: sentCheck, sent_check_query: args["sent-check-query"] },
    );
  }

  const identityDomain = identityCheck(job, rules, args["identity-domain"]);

  // Ground truth is two sources that must agree: the Sent folder above, and the
  // ledger here. Either one saying "already" is enough to stop.
  const prior = sends(ledger).find((e) => e.id === id);
  if (prior) {
    block("already-sent", `the ledger already records a send for "${id}" at ${prior.at}`, { previous: prior });
  }

  roleCheck(job, rules);
  modeCheck(channel, rules);
  leaseCheck(id, channel);
  const quota = limitCheck(job, rules, ledger);

  const banned = args.draft ? scanDraft(String(args.draft), rules) : [];
  if (banned.length) {
    block("banned-content", `the draft contains ${banned.length} banned item(s) from rules.yaml content`, {
      hits: banned,
    });
  }

  print({
    allowed: true,
    id,
    channel,
    mode: rules.mode,
    identity_domain: identityDomain,
    sent_check: sentCheck,
    sent_check_query: args["sent-check-query"],
    ...quota,
    note:
      rules.mode === "review"
        ? "mode is review: a human sees the draft before it goes out."
        : undefined,
  });
}

/**
 * Banned characters and phrases, scanned in the draft rather than trusted to a
 * model that was told about them. The em dash is on the list because it reads
 * as an AI tell; the phrases are there because they read as a template.
 */
/**
 * A banned character may be written either as itself or in the `U+2014`
 * spelling, and both mean the character.
 *
 * The shipped rules.example.yaml has to use an escape or the spelling, because
 * a rules file containing a literal em dash trips its own rule and the
 * repo-wide grep that enforces it. The failure this decoding prevents is the
 * quiet one: a user copies the documented `U+2014` form, the gate compares
 * drafts against the six-character string "U+2014", nothing ever matches, and
 * the guard reports clean forever while the character sails through.
 */
function bannedCharacters(rules) {
  return (rules.content.banned_characters || []).map((raw) => {
    const s = String(raw);
    const m = /^U\+([0-9a-fA-F]{4,6})$/.exec(s.trim());
    if (!m) return s;
    const code = parseInt(m[1], 16);
    if (code > 0x10ffff) die(`rules.yaml: "${s}" is not a valid code point`);
    return String.fromCodePoint(code);
  });
}

function scanDraft(path, rules) {
  if (!existsSync(path)) die(`--draft ${path} does not exist`);
  const text = readFileSync(path, "utf8");
  const hits = [];
  for (const ch of bannedCharacters(rules)) {
    let idx = text.indexOf(ch);
    while (idx > -1) {
      hits.push({ kind: "character", value: ch, codepoint: `U+${ch.codePointAt(0).toString(16).toUpperCase()}`, at: idx, context: context(text, idx) });
      idx = text.indexOf(ch, idx + 1);
      if (hits.length > 40) break;
    }
  }
  for (const phrase of rules.content.banned_phrases || []) {
    const re = new RegExp(String(phrase).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
    for (const m of text.matchAll(re)) {
      hits.push({ kind: "phrase", value: phrase, at: m.index, context: context(text, m.index) });
    }
  }
  return hits;
}

const context = (text, at) => text.slice(Math.max(0, at - 30), at + 30).replace(/\s+/g, " ").trim();

/* ── claim ─────────────────────────────────────────────────────────────── */

/**
 * claim re-runs the LOCAL invariants (lease, mode, role, caps, gap) but not the
 * Sent-folder check, which needs a live transport query and belongs to `check`.
 * That split is deliberate and it is the reason `check` exists as a separate
 * command: claim is cheap and can be re-run, check costs a mailbox search.
 */
function cmdClaim() {
  const id = requireId(args.id);
  const channel = requireChannel(args.channel);
  const rules = loadRules({ required: true });
  const job = loadJob(id);
  const ledger = loadLedger();

  const needsRoute = channel === "form" || channel.startsWith("ats-");
  if (needsRoute && (!args.route || args.route === true)) {
    die(`--route <url> is required for channel "${channel}" (the exact form URL that will be submitted)`);
  }

  const prior = sends(ledger).find((e) => e.id === id);
  if (prior) block("already-sent", `the ledger already records a send for "${id}" at ${prior.at}`, { previous: prior });

  roleCheck(job, rules);
  modeCheck(channel, rules);
  limitCheck(job, rules, ledger);

  const token = randomBytes(8).toString("hex");
  const claimedAt = new Date();
  const expiresAt = new Date(claimedAt.getTime() + rules.lease.seconds * 1000);
  const lease = {
    id,
    channel,
    token,
    route: args.route && args.route !== true ? args.route : job.apply?.target ?? null,
    identity_domain: args["identity-domain"] && args["identity-domain"] !== true ? args["identity-domain"] : null,
    company_id: job.company_id,
    source: job.source,
    mode: rules.mode,
    actor: args.actor && args.actor !== true ? args.actor : "unknown",
    pid: process.pid,
    host: hostname(),
    claimed_at: claimedAt.toISOString(),
    expires_at: expiresAt.toISOString(),
  };

  const file = P.lease(id, channel);
  try {
    // "wx" is the whole lock. Two processes racing here, one syscall each, and
    // the kernel picks exactly one winner. Nothing above this line is a lock:
    // an existsSync followed by a write is a race with a window in it.
    writeFileSync(file, JSON.stringify(lease, null, 2) + "\n", { flag: "wx" });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    const held = readLease(file);
    if (!held) {
      die(`${file} exists but is unreadable. Inspect it by hand; the gate will not guess.`);
    }
    if (Date.parse(held.expires_at) < nowMs()) {
      block(
        "stale-lease",
        `a lease on ${id}/${channel} was claimed at ${held.claimed_at} and expired at ${held.expires_at} ` +
          "without ever being recorded. Something crashed between the send and the record, so nobody " +
          "knows whether it went out. An expired lease NEVER frees itself. Look at the Sent folder, then:\n" +
          `  gate resolve --id ${id} --channel ${channel} --outcome sent|not-sent`,
        { lease: held, expired_seconds_ago: Math.round((nowMs() - Date.parse(held.expires_at)) / 1000) },
      );
    }
    block(
      "pending-elsewhere",
      `${id}/${channel} is already claimed by pid ${held.pid} on ${held.host} at ${held.claimed_at}` +
        (held.actor ? ` (actor: ${held.actor})` : "") +
        ". Another process is mid-flight on your target. Pick a different one.",
      { lease: { pid: held.pid, host: held.host, claimed_at: held.claimed_at, expires_at: held.expires_at, actor: held.actor } },
    );
  }

  appendLedger({ kind: "claim", id, channel, token, company_id: job.company_id, source: job.source, actor: lease.actor, pid: lease.pid, host: lease.host });
  if (job.status !== "claimed") {
    job.status = "claimed";
    saveJob(job);
  }

  note(`claimed ${id}/${channel}. The token expires in ${rules.lease.seconds}s: act now, record immediately after.`);
  print({ claimed: true, id, channel, token, claimed_at: lease.claimed_at, expires_at: lease.expires_at, lease_seconds: rules.lease.seconds });
}

/* ── record ────────────────────────────────────────────────────────────── */

const RECORD_STATUSES = ["sent", "sent-unverified", "skipped", "failed"];

function cmdRecord() {
  const id = requireId(args.id);
  const rules = loadRules({ required: true });
  const ledger = loadLedger();
  const force = Boolean(args.force);

  if (!args.token || args.token === true) {
    if (!force) die("--token is required. Only `gate claim` mints one, and only a fresh one records.");
  }

  const status = args.status === true || !args.status ? null : String(args.status);
  if (!status) die(`--status is required (${RECORD_STATUSES.join(" | ")})`);
  if (!RECORD_STATUSES.includes(status)) die(`--status must be ${RECORD_STATUSES.join(" | ")} (got "${status}")`);

  const channelArg = args.channel && args.channel !== true ? requireChannel(args.channel) : null;
  const lease = findLease(id, channelArg);

  if (!lease && !force) {
    const prior = ledger.find((e) => e.kind === "record" && e.id === id);
    if (prior) {
      // The lease was consumed by the first record. A second record for the
      // same id is either a double-send being written down twice, or a mistake.
      // Both need a human to say which.
      die(
        `"${id}" was already recorded at ${prior.at} (status ${prior.status}) and there is no open lease.\n` +
          "  Pass --force only if that earlier entry is wrong.",
      );
    }
    die(
      `nothing claimed for "${id}". Run \`gate claim --id ${id} --channel <ch>\` BEFORE the send,\n` +
        "  not after: the claim is the intent record that stops a second agent starting the same send.",
    );
  }

  const channel = lease?.channel ?? channelArg;
  if (!channel) die("--channel is required with --force when there is no lease to read it from");

  if (lease) {
    if (args.token !== lease.token && !force) {
      // Reusing the stale-token reason rather than inventing one: from the
      // caller's side both mean "the token you hold does not authorise this
      // record", and one reason with a precise detail beats two near-duplicates.
      block(
        "stale-token",
        `the token does not match the open lease on ${id}/${channel}. ` +
          "Another process claimed this target; do not record its send as yours.",
        { channel },
      );
    }
    const ageSeconds = (nowMs() - Date.parse(lease.claimed_at)) / 1000;
    if (ageSeconds > rules.lease.seconds && !force) {
      block(
        "stale-token",
        `the token is ${Math.round(ageSeconds)}s old and rules.lease.seconds is ${rules.lease.seconds}. ` +
          "The gap between checking and acting is the entire window a duplicate is born in, so the gate " +
          "measures it. Re-check, re-claim, then act.",
        { channel, age_seconds: Math.round(ageSeconds), lease_seconds: rules.lease.seconds },
      );
    }
  }

  const job = loadJob(id);

  /* timestamps */
  let sentAt = null;
  if (status === "sent" || status === "sent-unverified") {
    const source = args["sent-at-source"];
    if (!source || source === true) {
      die('--sent-at-source is required and must be "transport" (the SMTP response or the ATS confirmation, not your clock)');
    }
    if (source !== "transport") {
      die(
        `--sent-at-source must be "transport" (got "${source}").\n` +
          "  A client clock is not a source. Read the timestamp off whatever actually accepted the message.",
      );
    }
    const raw = args["sent-at"];
    if (!raw || raw === true) die("--sent-at is required: the transport's own timestamp, ISO 8601 with a Z or an offset");
    if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(String(raw))) {
      die(
        `--sent-at "${raw}" has no timezone. A timestamp with no zone is a number that looks like one.\n` +
          "  Use an ISO 8601 instant: 2026-07-28T12:00:00Z or 2026-07-28T14:00:00+02:00.",
      );
    }
    const parsed = Date.parse(String(raw));
    if (!Number.isFinite(parsed)) die(`--sent-at "${raw}" does not parse as a date`);

    const skewMs = rules.clock.skewSeconds * 1000;
    if (parsed - nowMs() > skewMs) {
      // The CEST-labelled-Z case. A local wall clock stamped `Z` in a UTC+2
      // zone lands two hours in the future, and every "was this before that?"
      // question downstream then answers wrong. Twenty-three records in the
      // sweep this kit generalises are exactly this bug.
      block(
        "clock-skew",
        `--sent-at ${raw} is ${Math.round((parsed - nowMs()) / 1000)}s in the future and ` +
          `rules.clock.skewSeconds is ${rules.clock.skewSeconds}. ` +
          "A local wall-clock time labelled Z in a UTC+n zone looks exactly like this. " +
          "Read the transport's own timestamp instead of formatting your own.",
        { sent_at: raw, skew_seconds: Math.round((parsed - nowMs()) / 1000), allowed_skew_seconds: rules.clock.skewSeconds },
      );
    }
    if (nowMs() - parsed > DAY) {
      note(`--sent-at ${raw} is more than 24h in the past. Recorded as given, but check it is the right one.`);
    }
    sentAt = new Date(parsed).toISOString();
  }

  /* receipts */
  let receiptPath = null;
  let needsHuman = false;
  const receiptRequired = (rules.receipts.required_channels || []).includes(channel);
  const given = args.receipt && args.receipt !== true ? String(args.receipt) : null;

  if (given) {
    if (!existsSync(given)) block("receipt-missing", `--receipt ${given} does not exist`, { receipt: given });
    if (statSync(given).size === 0) {
      block("receipt-missing", `--receipt ${given} is empty. An empty file is not proof of anything.`, { receipt: given });
    }
    const dir = P.receipt(id);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${Date.now()}-${basename(given)}`);
    copyFileSync(given, dest);
    receiptPath = dest;
  } else if (receiptRequired && (status === "sent" || status === "sent-unverified")) {
    // A form submit leaves nothing behind. The one receipt in the sweep this
    // generalises was a screenshot under /var/folders/ annotated "will not
    // survive". Missing proof does not fail the record, because the send
    // already happened and pretending otherwise loses the fact; it downgrades
    // the record so a human is told to go and confirm it.
    needsHuman = true;
    note(
      `no --receipt for a ${channel} send. Recording as "sent-unverified" with needs_human: true. ` +
        "A form submit leaves no Sent folder: without a receipt nothing here proves it happened.",
    );
  }

  const finalStatus = needsHuman && status === "sent" ? "sent-unverified" : status;

  /* write */
  const entry = {
    kind: "record",
    id,
    channel,
    status: finalStatus,
    company_id: job.company_id,
    source: job.source,
    sent_at: sentAt,
    sent_at_source: sentAt ? "transport" : null,
    message_id: args["message-id"] && args["message-id"] !== true ? args["message-id"] : null,
    subject: args.subject && args.subject !== true ? args.subject : null,
    receipt: receiptPath,
    needs_human: needsHuman,
    ...(force ? { forced: true } : {}),
  };
  appendLedger(entry);

  if (lease) unlinkSync(lease.file);

  job.status = finalStatus;
  job.sent_at = sentAt;
  job.sent_at_source = sentAt ? "transport" : null;
  job.message_id = entry.message_id;
  job.subject = entry.subject;
  job.receipt = receiptPath;
  job.needs_human = needsHuman;
  if (lease?.identity_domain) {
    job.apply = { ...(job.apply || {}), identity_domain: lease.identity_domain, identity_verified: true };
  }
  saveJob(job);

  const after = since(sends(loadLedger()), DAY);
  print({
    recorded: entry,
    lease_released: Boolean(lease),
    needs_human: needsHuman,
    used: after.length,
    limit: rules.limits.maxPerDay,
    remaining: Math.max(0, rules.limits.maxPerDay - after.length),
  });
}

/* ── release ───────────────────────────────────────────────────────────── */

function cmdRelease() {
  const id = requireId(args.id);
  const channel = requireChannel(args.channel);
  if (!args.reason || args.reason === true) {
    die("--reason is required. An abandoned claim with no reason is indistinguishable from a crash.");
  }
  const lease = findLease(id, channel);
  if (!lease) die(`no open lease for ${id}/${channel}`);
  if (args.token !== lease.token) {
    block("stale-token", `the token does not match the lease on ${id}/${channel}. Only the holder may release it.`, { channel });
  }
  unlinkSync(lease.file);
  appendLedger({ kind: "release", id, channel, reason: String(args.reason), company_id: lease.company_id ?? null });
  const job = loadJob(id, { required: false });
  if (job && job.status === "claimed") {
    job.status = "drafted";
    saveJob(job);
  }
  print({ released: true, id, channel, reason: String(args.reason) });
}

/* ── resolve ───────────────────────────────────────────────────────────── */

/**
 * The only exit from a stale lease, and it exists so that a human (or an agent
 * acting deliberately) has to go and look. Auto-expiry would reopen the
 * double-send window on exactly the failure this whole file exists to catch.
 */
function cmdResolve() {
  const id = requireId(args.id);
  const channel = requireChannel(args.channel);
  const outcome = args.outcome;
  if (outcome !== "sent" && outcome !== "not-sent") {
    die("--outcome must be sent | not-sent. Look at the Sent folder (or the ATS confirmation) and say which.");
  }
  const lease = findLease(id, channel);
  if (!lease) die(`no lease for ${id}/${channel}. Nothing to resolve.`);
  const job = loadJob(id);
  const evidence = args.evidence && args.evidence !== true ? String(args.evidence) : null;

  unlinkSync(lease.file);

  if (outcome === "sent") {
    // No transport timestamp exists for a send nobody watched complete. The
    // claim time is the honest lower bound, and needs_human stays true so the
    // review surface keeps asking.
    appendLedger({
      kind: "resolve",
      id,
      channel,
      outcome,
      company_id: job.company_id,
      source: job.source,
      evidence,
      needs_human: true,
    });
    appendLedger({
      kind: "record",
      id,
      channel,
      status: "sent-unverified",
      company_id: job.company_id,
      source: job.source,
      sent_at: lease.claimed_at,
      sent_at_source: null,
      receipt: null,
      needs_human: true,
      resolved_from: "stale-lease",
    });
    job.status = "sent-unverified";
    job.sent_at = lease.claimed_at;
    job.sent_at_source = null;
    job.needs_human = true;
    job.evidence = [
      ...(job.evidence || []),
      {
        at: nowIso(),
        kind: "resolution",
        text:
          `Stale lease resolved as sent. sent_at is the claim time (${lease.claimed_at}), not a transport ` +
          `timestamp, because nothing observed the send complete.` + (evidence ? ` Evidence: ${evidence}` : ""),
      },
    ];
    saveJob(job);
    print({ resolved: true, id, channel, outcome, needs_human: true, sent_at: lease.claimed_at });
    return;
  }

  appendLedger({ kind: "resolve", id, channel, outcome, company_id: job.company_id, evidence, needs_human: false });
  job.status = "drafted";
  job.evidence = [
    ...(job.evidence || []),
    { at: nowIso(), kind: "resolution", text: `Stale lease resolved as not-sent.${evidence ? ` Evidence: ${evidence}` : ""}` },
  ];
  saveJob(job);
  print({ resolved: true, id, channel, outcome, needs_human: false });
}

/* ── leases / status ───────────────────────────────────────────────────── */

function cmdLeases() {
  const leases = openLeases().sort((a, b) => a.claimed_at.localeCompare(b.claimed_at));
  for (const l of leases.filter((l) => l.expired)) {
    note(`EXPIRED ${l.id}/${l.channel} claimed ${l.claimed_at}. Resolve it: gate resolve --id ${l.id} --channel ${l.channel} --outcome sent|not-sent`);
  }
  print({ count: leases.length, expired: leases.filter((l) => l.expired).length, leases });
}

function cmdStatus() {
  const rules = loadRules({ required: false });
  const ledger = loadLedger();
  const all = sends(ledger);
  const today = since(all, DAY);
  const last = all[all.length - 1];

  const byChannel = {};
  for (const channel of CHANNELS) {
    const used = today.filter((e) => e.channel === channel).length;
    if (used) byChannel[channel] = used;
  }

  print({
    at: nowIso(),
    careerHome: P.home,
    mode: rules.mode,
    autopilot_channels: rules.autopilot_channels,
    quota: {
      used: today.length,
      limit: rules.limits.maxPerDay,
      remaining: Math.max(0, rules.limits.maxPerDay - today.length),
      windowHours: 24,
      byChannel,
    },
    minGapMinutes: rules.limits.minGapMinutes,
    lastSentAt: last ? last.at : null,
    nextAllowedAt:
      last && rules.limits.minGapMinutes
        ? new Date(ts(last) + rules.limits.minGapMinutes * MINUTE).toISOString()
        : null,
    totals: {
      sent: all.length,
      needs_human: all.filter((e) => e.needs_human).length,
      blocks: ledger.filter((e) => e.kind === "block").length,
    },
    openLeases: openLeases().map((l) => ({ id: l.id, channel: l.channel, age_seconds: l.age_seconds, expired: l.expired, actor: l.actor })),
    recentBlocks: ledger
      .filter((e) => e.kind === "block")
      .slice(-8)
      .map((e) => ({ at: e.at, reason: e.reason, id: e.id, channel: e.channel })),
  });
}

/* ── verify ────────────────────────────────────────────────────────────── */

/**
 * THE HONESTY FLOOR IS A FLAGGER, NOT A PROVER. Read this before trusting it.
 *
 * It splits an artifact into sentences, keeps the ones that carry a number, a
 * proper noun or a first-person verb, and matches each against the lines of
 * knowledge-base.md by normalised token overlap plus exact number matching.
 *
 * What that means in practice:
 *   - It FALSE-POSITIVES on paraphrase. A true claim written in words the KB
 *     does not use is reported as untraced. That is noise, not a finding.
 *   - It MISSES fabrication phrased in KB vocabulary. A sentence that borrows
 *     the KB's own words and inverts their meaning scores high and passes.
 *   - Token overlap is not entailment. It cannot tell "reduced latency 40%"
 *     from "increased latency 40%".
 *
 * It ships anyway because the failure it does catch is the one that costs a
 * job: a number in a CV that nothing in the knowledge base supports. Use it as
 * a review aid. Never quote it as a guarantee.
 */
const STOPWORDS = new Set(
  ("a an and are as at be been but by for from had has have he her his i in into is it its me my of on or our she that the their them then there these they this to was we were what when where which who will with you your".split(" ")),
);

const tokens = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[^a-z0-9%.\s-]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^[-.]+|[-.]+$/g, ""))
    .filter((t) => t && !STOPWORDS.has(t));

const numbers = (s) => (String(s).match(/\d[\d,._]*%?/g) || []).map((n) => n.replace(/[,_]/g, "").replace(/\.$/, ""));

function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit++;
  return hit / (A.size + B.size - hit);
}

/** A sentence is a "claim" if it asserts something checkable. */
function isClaim(sentence) {
  if (tokens(sentence).length < 4) return false;
  if (/\d/.test(sentence)) return true;
  if (/\b(I|my|we|our)\b\s+\w*\s*\b(built|led|shipped|wrote|ran|designed|founded|scaled|cut|grew|own|owned|run|made|delivered|migrated|reduced|increased)\b/i.test(sentence)) return true;
  const proper = sentence.match(/\b[A-Z][a-zA-Z0-9.+-]{2,}\b/g) || [];
  return proper.filter((w) => !/^(The|This|That|These|Those|There|They|When|Where|What|With|From|And|But|For|Not|One|Two)$/.test(w)).length > 0;
}

function sentences(text) {
  return text
    .replace(/<[^>]+>/g, " ")
    .replace(/^[\s>*+-]*[-*+]\s+/gm, "")
    .replace(/^#{1,6}\s+/gm, "")
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function cmdVerify() {
  const path = args.artifact;
  if (!path || path === true) die("--artifact <path> is required");
  if (!existsSync(path)) die(`--artifact ${path} does not exist`);
  if (!existsSync(P.kb)) die(`no knowledge base at ${P.kb}. There is nothing to trace claims against.`);

  const kbLines = readFileSync(P.kb, "utf8")
    .split("\n")
    .map((l) => l.replace(/^[\s>*+-]*[-*+]\s+/, "").replace(/^#{1,6}\s+/, "").trim())
    .filter((l) => tokens(l).length >= 3)
    .map((text) => ({ text, tok: tokens(text), num: numbers(text) }));

  const claims = [];
  for (const sentence of sentences(readFileSync(path, "utf8"))) {
    if (!isClaim(sentence)) continue;
    const tok = tokens(sentence);
    const num = numbers(sentence);
    let best = { score: 0, line: null };
    for (const line of kbLines) {
      const score = jaccard(tok, line.tok);
      if (score > best.score) best = { score, line };
    }
    // Every number in the claim must appear in the matched line. A high
    // overlap on the words with a different number is precisely the failure
    // worth catching, and it is the one token overlap alone would wave through.
    const numbersTraced = best.line ? num.every((n) => best.line.num.includes(n)) : num.length === 0;
    const traced = best.score >= 0.5 && numbersTraced;
    claims.push({
      text: sentence,
      traced,
      kb_line: traced ? best.line.text : null,
      score: Number(best.score.toFixed(2)),
      ...(best.line && best.score >= 0.5 && !numbersTraced
        ? { why: `closest KB line matches the wording but not the number(s): ${num.filter((n) => !best.line.num.includes(n)).join(", ")}` }
        : {}),
    });
  }

  const untraced = claims.filter((c) => !c.traced).length;
  const strict = Boolean(args.strict);
  note(
    `${claims.length} claim(s) examined, ${untraced} untraced. This is a FLAGGER, not a prover: ` +
      "it false-positives on paraphrase and misses fabrication phrased in the knowledge base's own words.",
  );
  print({ artifact: String(path), claims, untraced_count: untraced, strict, flagger_not_prover: true });
  if (strict && untraced > 0) {
    appendLedger({ kind: "block", reason: "untraced-claims", detail: `${untraced} untraced claim(s) in ${path}`, command: cmd });
    process.exit(3);
  }
  process.exit(0);
}

/* ── dispatch ──────────────────────────────────────────────────────────── */

const COMMANDS = {
  status: cmdStatus,
  check: cmdCheck,
  claim: cmdClaim,
  record: cmdRecord,
  release: cmdRelease,
  resolve: cmdResolve,
  leases: cmdLeases,
  verify: cmdVerify,
};

const run = COMMANDS[cmd];
if (!run) die(`unknown command "${cmd}". Known: ${Object.keys(COMMANDS).join(", ")}`);
run();
