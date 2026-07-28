#!/usr/bin/env node
/**
 * inbox.mjs - match inbound mail to the applications that produced it.
 *
 * The piece that closes the loop. Without it a reply sits unread while the
 * pipeline tool reports nothing waiting, which is exactly what happened for
 * fifteen hours with a real reply from a real company in the inbox the whole
 * time. A pipeline that only tracks outbound is a list, not a pipeline.
 *
 * WHY THIS IS NOT A MAIL CLIENT. Fetching mail needs credentials and a provider,
 * and the kit has neither: the skill pulls messages with whatever mail tool the
 * user already has connected, and pipes them here. This file owns the part that
 * must be deterministic and testable - matching, classification and the decision
 * about what a stage should become. Splitting it that way is also what keeps the
 * dependency count at zero.
 *
 *   node engine/inbox.mjs scan --since <iso8601>       read messages on stdin
 *   node engine/inbox.mjs index                        the join keys, for the fetcher
 *   node engine/inbox.mjs classify --file <path>       same as scan, from a file
 *
 * Input is a JSON array (or {messages: [...]}) of:
 *   {id, from, to, subject, date, headers: {...}, snippet|body}
 * Header names are read case-insensitively.
 *
 * Output is JSON on stdout: every message, its match, its class, and the
 * log.mjs command that would record it. It writes nothing itself. A tool that
 * both decides and mutates is a tool you cannot dry-run, and the first thing you
 * want from an inbox sweep is to see what it thinks before it acts.
 *
 * Exit 0 done, 2 usage error.
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { findCareerHome, paths } from "./paths.mjs";

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
    if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith("--")) out[a.slice(2)] = argv[++i];
    else out[a.slice(2)] = true;
  }
  return out;
}

const die = (msg) => {
  process.stderr.write(`inbox: ${msg}\n`);
  process.exit(2);
};
const print = (o) => process.stdout.write(JSON.stringify(o, null, 2) + "\n");

/* ── the index ─────────────────────────────────────────────────────────── */

/**
 * The RFC822 Message-ID of the outbound application is the join key. domains[]
 * is kept alongside it as a weaker fallback, and is labelled as weaker
 * everywhere it is used.
 */
export function buildIndex(P) {
  const dir = P.jobs;
  if (!existsSync(dir)) return { byMessageId: new Map(), byDomain: new Map(), records: [] };

  const records = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) {
    try {
      records.push(JSON.parse(readFileSync(`${dir}/${f}`, "utf8")));
    } catch {
      // A malformed record should not blind the sweep to the other forty.
      process.stderr.write(`inbox: ${f} is not valid JSON and was skipped\n`);
    }
  }

  const byMessageId = new Map();
  const byDomain = new Map();
  for (const r of records) {
    if (r.message_id) byMessageId.set(normId(r.message_id), r);
    for (const d of r.domains || []) {
      const key = String(d).toLowerCase().replace(/^www\./, "");
      if (!byDomain.has(key)) byDomain.set(key, []);
      byDomain.get(key).push(r);
    }
  }
  return { byMessageId, byDomain, records };
}

/** Compare on the id inside the angle brackets, not on the brackets. */
const normId = (s) => String(s).trim().replace(/^<|>$/g, "").toLowerCase();

/** Both In-Reply-To and References can hold several ids. Parse all of them. */
export function idsIn(value) {
  if (!value) return [];
  return String(value)
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normId);
}

/** Header lookup is case-insensitive: providers disagree on capitalisation. */
export function header(msg, name) {
  const h = msg.headers || {};
  const want = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === want) return h[k];
  return undefined;
}

const domainOf = (addr) => {
  const m = /@([^\s>@]+)/.exec(String(addr || ""));
  return m ? m[1].toLowerCase().replace(/^www\./, "") : null;
};

/* ── matching ──────────────────────────────────────────────────────────── */

/**
 * In the skill's stated order. The two header routes are certain; the domain
 * route is probable, and probable is labelled, never promoted.
 *
 * The fourth branch is the important one: no match leaves the message alone. A
 * reply filed against the wrong company is worse than one nobody filed, and a
 * subject line that "looks close" is not evidence.
 */
export function matchMessage(msg, index) {
  for (const [headerName, how] of [["In-Reply-To", "by-in-reply-to"], ["References", "by-references"]]) {
    for (const id of idsIn(header(msg, headerName))) {
      const rec = index.byMessageId.get(id);
      if (rec) return { id: rec.id, record: rec, how, certain: true };
    }
  }

  const from = domainOf(msg.from);
  if (from) {
    // Walk up the sending domain so mail.acme.example still matches acme.example.
    const parts = from.split(".");
    for (let i = 0; i < parts.length - 1; i++) {
      const candidate = parts.slice(i).join(".");
      const hits = index.byDomain.get(candidate);
      if (!hits || hits.length === 0) continue;
      // A shared ATS domain sends on behalf of many companies. If the domain
      // points at more than one record, it has told us nothing about which.
      if (hits.length > 1) {
        return { id: null, record: null, how: "ambiguous-domain", certain: false, candidates: hits.map((r) => r.id) };
      }
      return { id: hits[0].id, record: hits[0], how: "by-domain", certain: false };
    }
  }

  return { id: null, record: null, how: "unmatched", certain: false };
}

/* ── classification ────────────────────────────────────────────────────── */

const AUTO_ACK_PHRASES = [
  "we have received your application",
  "we've received your application",
  "thanks for applying",
  "thank you for applying",
  "your application has been received",
  "application received",
  "this is an automated",
  "do not reply to this",
];

const REJECTION_PHRASES = [
  "not moving forward",
  "will not be moving forward",
  "not be progressing",
  "will not be progressing",
  "decided to proceed with other candidates",
  "moving forward with other candidates",
  "pursue other candidates",
  "not selected",
  "unfortunately",
  "we regret",
  "no longer under consideration",
];

const NOREPLY = /(^|[.\-_+])(no-?reply|do-?not-?reply|noreply|donotreply|automated|mailer-daemon)([.\-_+@]|$)/i;

/**
 * Classification, in the skill's own table.
 *
 * The tie-break is the load-bearing rule: when signals disagree, classify as
 * `reply`. The cost of treating an auto-acknowledgement as a reply is one
 * wasted glance. The cost of treating a real reply as an auto-acknowledgement
 * is the fifteen hours this module exists to prevent. The asymmetry decides it.
 */
export function classify(msg, record, { autoAckWindowMinutes = 10 } = {}) {
  const text = `${msg.subject || ""}\n${msg.snippet || msg.body || ""}`.toLowerCase();
  const from = String(msg.from || "");
  const signals = [];

  const rejection = REJECTION_PHRASES.filter((p) => text.includes(p));
  // "unfortunately" and "we regret" appear in plenty of non-rejections, so they
  // only count as rejection signals next to something structural.
  const strongRejection = rejection.some((p) => p !== "unfortunately" && p !== "we regret");
  if (rejection.length) signals.push(`rejection-phrase:${rejection[0]}`);

  const autoPhrase = AUTO_ACK_PHRASES.find((p) => text.includes(p));
  if (autoPhrase) signals.push(`auto-phrase:${autoPhrase}`);
  if (NOREPLY.test(from)) signals.push("no-reply-sender");
  if (header(msg, "Auto-Submitted") && String(header(msg, "Auto-Submitted")) !== "no") {
    signals.push("auto-submitted-header");
  }
  if (header(msg, "X-Auto-Response-Suppress")) signals.push("auto-response-suppress-header");

  let withinWindow = false;
  if (record?.sent_at && msg.date) {
    const gap = Date.parse(msg.date) - Date.parse(record.sent_at);
    withinWindow = Number.isFinite(gap) && gap >= 0 && gap <= autoAckWindowMinutes * 60_000;
    if (withinWindow) signals.push(`within-${autoAckWindowMinutes}m-of-send`);
  }

  // A rejection is still a rejection when it arrives from a no-reply address,
  // which is how most of them arrive. Check it before the auto-ack signals.
  if (strongRejection) return { class: "rejection", stage: "rejected", signals };

  const autoish = Boolean(autoPhrase) || withinWindow;
  const machineSent = NOREPLY.test(from) || signals.includes("auto-submitted-header") ||
    signals.includes("auto-response-suppress-header");
  if (autoish && machineSent) return { class: "auto-ack", stage: null, signals };

  // Only a phrase, or only a machine sender, is not enough. Falls to reply.
  return { class: "reply", stage: "replied", signals };
}

/* ── commands ──────────────────────────────────────────────────────────── */

function readMessages(args) {
  let raw;
  if (args.file && args.file !== true) {
    if (!existsSync(args.file)) die(`no such file: ${args.file}`);
    raw = readFileSync(args.file, "utf8");
  } else {
    try {
      raw = readFileSync(0, "utf8");
    } catch {
      raw = "";
    }
  }
  if (!raw.trim()) {
    die(
      "no messages on stdin.\n" +
        "  Fetch recent inbound mail with your mail tool and pipe it in as JSON:\n" +
        '  [{id, from, subject, date, headers:{"In-Reply-To":"<...>"}, snippet}]\n' +
        "  Run `inbox.mjs index` first to see which message ids to thread against.",
    );
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    die(`stdin is not valid JSON: ${err.message}`);
  }
  const list = Array.isArray(parsed) ? parsed : parsed.messages;
  if (!Array.isArray(list)) die("expected a JSON array of messages, or {messages: [...]}");
  return list;
}

/** The join keys, so the fetcher knows what to thread against. */
function cmdIndex(P) {
  const index = buildIndex(P);
  print({
    careerHome: P.home,
    records: index.records.length,
    threadable: index.byMessageId.size,
    // A sent record with no message_id can only ever be matched by domain. That
    // is worth surfacing: it is usually a form submit, and it is the reason the
    // weak route exists at all.
    unthreadable: index.records
      .filter((r) => (r.status === "sent" || r.status === "sent-unverified") && !r.message_id)
      .map((r) => ({ id: r.id, channel: r.apply?.channel ?? null, domains: r.domains || [] })),
    messageIds: [...index.byMessageId.entries()].map(([mid, r]) => ({ id: r.id, message_id: mid })),
    domains: [...index.byDomain.keys()],
  });
}

function cmdScan(P, args) {
  const since = args.since && args.since !== true ? Date.parse(args.since) : null;
  if (args.since && args.since !== true && !Number.isFinite(since)) {
    die(`--since is not a date I can parse: ${args.since}`);
  }

  const index = buildIndex(P);
  const messages = readMessages(args);
  const results = [];

  for (const msg of messages) {
    if (since && msg.date && Date.parse(msg.date) < since) continue;

    const match = matchMessage(msg, index);
    const verdict = match.record ? classify(msg, match.record) : { class: "unknown", stage: null, signals: [] };

    // `other` and unmatched mail is reported and never logged. Reporting an
    // unmatched reply is useful; filing it against a guess is not.
    const actions = [];
    if (match.id && verdict.class !== "unknown") {
      const summary = (msg.subject || "(no subject)").replace(/\s+/g, " ").slice(0, 120);
      actions.push([
        "log.mjs", "in", match.id, summary,
        "--channel", "email",
        ...(msg.headers && header(msg, "Message-ID") ? ["--message-id", String(header(msg, "Message-ID"))] : []),
      ]);
      if (verdict.stage) actions.push(["log.mjs", "stage", match.id, verdict.stage]);
      if (verdict.class === "reply") {
        // A reply with no next action is how the fifteen hours happen a second
        // time. The text is the human's to write; the reminder is not optional.
        actions.push(["log.mjs", "next", match.id, "<what has to happen>", "--due", "<YYYY-MM-DD>"]);
      }
    }

    results.push({
      message: { id: msg.id ?? null, from: msg.from ?? null, subject: msg.subject ?? null, date: msg.date ?? null },
      match: { id: match.id, how: match.how, certain: match.certain, ...(match.candidates ? { candidates: match.candidates } : {}) },
      class: verdict.class,
      stage: verdict.stage,
      signals: verdict.signals,
      actions,
    });
  }

  const by = (k, v) => results.filter((r) => r[k] === v).length;
  print({
    careerHome: P.home,
    scanned: results.length,
    matched: results.filter((r) => r.match.id).length,
    uncertain: results.filter((r) => r.match.id && !r.match.certain).length,
    unmatched: results.filter((r) => !r.match.id).length,
    replies: by("class", "reply"),
    rejections: by("class", "rejection"),
    autoAcks: by("class", "auto-ack"),
    results,
    note:
      "Nothing was written. Run the `actions` through log.mjs once you agree with the " +
      "classification. A match with certain:false was made on the sending domain alone; " +
      "confirm it before logging.",
  });
}

const COMMANDS = { index: cmdIndex, scan: cmdScan, classify: cmdScan };

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || "index";
  const run = COMMANDS[cmd];
  if (!run) die(`unknown command "${cmd}". Known: ${Object.keys(COMMANDS).join(", ")}`);
  run(paths(findCareerHome()), args);
}
