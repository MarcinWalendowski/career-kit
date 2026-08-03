#!/usr/bin/env node
/**
 * board.mjs - every role in jobs/ on one filterable page.
 *
 * `career-review` answers "what needs me today" in prose. This answers "what is
 * in the pipeline" as a table you can sort, filter and triage in a browser. Same
 * data, different question, and the second one does not fit in a chat window at
 * three hundred rows.
 *
 *   node engine/board.mjs                    write outputs/board.html
 *   node engine/board.mjs --json             the same numbers, machine readable
 *   node engine/board.mjs apply --verdicts <file>   read the board's export back in
 *
 * Exit 0 done, 2 usage or environment error.
 *
 * THE ONE RULE THIS FILE EXISTS TO ENFORCE. A row's status is derived from the
 * record of what happened, never from the browser. A board that only knew what
 * the reader clicked showed an already-submitted application as untouched work,
 * with a live apply button on it. The states below come from jobs/<id>.json, the
 * open leases and career.db, in that order of authority.
 *
 * AND ITS COROLLARY: coverage is a property of the COMPANY, not of the row. The
 * bug that motivated it: a company had one application parked mid-form, and the
 * same company's second posting, scraped from a different board, rendered as
 * fresh work. Applying to it would have spent the company's single application
 * on a duplicate. Every row therefore carries its siblings' state as well as its
 * own, and the shortlist button is off for a company that is already spoken for.
 *
 * WHAT THIS FILE MAY WRITE. outputs/board.html, and on `apply`, the `status`
 * field of records sitting at discovered / screened / skipped. It cannot move a
 * record past that: drafting, claiming and sending belong to the gate, and a
 * button in a browser is not a gate.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { findCareerHome, paths, ensureRuntimeDirs } from "./paths.mjs";
import { loadSqlite } from "./db.mjs";

/* ── the state vocabulary ──────────────────────────────────────────────── */

const SENT = new Set(["sent", "sent-unverified"]);

/**
 * Every state a row can be in, in the order a human should look at them.
 *
 * The order is the default sort, and it is deliberately "what needs me" first
 * rather than "newest" or "best paid". A board sorted by compensation buries the
 * one application that stalled halfway through a form, which is the only row on
 * the page that loses something by being ignored.
 */
export const STATES = [
  ["needs-you", "needs you", "A send that failed, or a lease that expired mid-flight. Nothing else on this page can rot."],
  ["unproven", "sent, unproven", "It went out on a channel with no receipt, so nothing here proves it arrived."],
  ["in-flight", "in flight", "Claimed right now, or a lease still inside its window."],
  ["drafted", "drafted", "Written, not sent. The gate has not been called."],
  ["shortlist", "shortlisted", "Screened in by a human, waiting for a draft."],
  ["new", "new", "Discovered by a source adapter and not yet judged."],
  ["applied", "applied", "Sent, with a receipt or a transport timestamp behind it."],
  ["skipped", "skipped", "Screened out by a human. Kept visible on purpose."],
];

const STATE_ORDER = new Map(STATES.map(([id], i) => [id, i]));

/**
 * The stages a person types into career.db. They outrank anything this file can
 * derive: "rejected" is a fact about the world, and a row that still reads
 * "applied" because the job record has not changed is a board lying by omission.
 */
const HUMAN_STAGES = new Set([
  "replied", "screening", "interview", "offer", "rejected", "withdrawn", "closed", "no_response", "no_route",
]);

/** What the board may move a record between. Everything else belongs to the gate. */
const BOARD_WRITABLE = new Set(["discovered", "screened", "skipped"]);

/* ── reading ───────────────────────────────────────────────────────────── */

function readJobs(P) {
  if (!existsSync(P.jobs)) return { jobs: [], unreadable: [] };
  const jobs = [];
  const unreadable = [];
  for (const file of readdirSync(P.jobs).filter((f) => f.endsWith(".json")).sort()) {
    try {
      const job = JSON.parse(readFileSync(join(P.jobs, file), "utf8"));
      if (job && typeof job.id === "string" && job.id) jobs.push(job);
      else unreadable.push({ file, why: "no id; nothing to key a row on" });
    } catch (err) {
      unreadable.push({ file, why: err.message });
    }
  }
  return { jobs, unreadable };
}

/**
 * Open leases, keyed by job id.
 *
 * Expiry is read off the lease's own `expires_at` rather than recomputed from
 * rules.yaml. The lease was written with the window that applied when it was
 * claimed; re-deriving it against today's rules would call a lease live because
 * somebody lengthened the window this morning.
 */
function readLeases(P, now) {
  const byId = new Map();
  if (!existsSync(P.leases)) return byId;
  for (const file of readdirSync(P.leases).filter((f) => f.endsWith(".json"))) {
    let lease;
    try {
      lease = JSON.parse(readFileSync(join(P.leases, file), "utf8"));
    } catch {
      continue;
    }
    if (!lease?.id) continue;
    const expired = Date.parse(lease.expires_at) < now;
    const prev = byId.get(lease.id);
    // An expired lease beats a live one on the same id: it is the one that needs
    // a human, and the row can only show one lease.
    if (!prev || (expired && !prev.expired)) byId.set(lease.id, { ...lease, expired });
  }
  return byId;
}

/**
 * The human-owned columns, if career.db can be opened at all.
 *
 * career.db is the optional part of the kit: it needs node:sqlite, and the gate,
 * the validator and the renderer all work without it. So this returns a verdict
 * about ITSELF alongside the rows, and the page prints that verdict. A board
 * that silently fell back to machine status would show "applied" for a role the
 * user typed "rejected" against and give no hint that it had not looked.
 */
export async function readHumanState(P) {
  const none = (why) => ({ read: false, why, rows: new Map() });
  if (!existsSync(P.db)) {
    return none("no career.db in this workspace yet. Build it with: engine/db.mjs rebuild");
  }
  const mod = await loadSqlite();
  if (!mod) {
    return none(`node:sqlite is not available on Node ${process.versions.node}, so career.db was not opened`);
  }
  try {
    const db = new mod.DatabaseSync(P.db, { readOnly: true });
    const rows = db
      .prepare("SELECT id, stage, priority, next_action, next_action_due, human_notes FROM applications")
      .all();
    db.close();
    return { read: true, why: null, rows: new Map(rows.map((r) => [r.id, r])) };
  } catch (err) {
    return none(`career.db could not be read: ${err.message}`);
  }
}

/* ── state derivation ──────────────────────────────────────────────────── */

/** What this record, on its own, is doing. */
function ownState(job, lease) {
  if (SENT.has(job.status)) return job.needs_human ? "unproven" : "applied";
  if (job.status === "failed") return "needs-you";
  if (lease?.expired) return "needs-you";
  if (lease || job.status === "claimed") return "in-flight";
  if (job.status === "drafted") return "drafted";
  if (job.status === "skipped") return "skipped";
  if (job.status === "screened") return "shortlist";
  return "new";
}

/** A company is spoken for once an application is out, or on its way out. */
const SPOKEN_FOR = new Set(["applied", "unproven", "in-flight"]);

/**
 * Why this row may not be shortlisted, or null if it may. ONE definition, read
 * by the page to grey the button out and by `apply` to refuse the same row from
 * a hand-edited file. Two implementations of this rule drifted within an hour of
 * being written: the browser refused a company with a parked application and the
 * importer did not.
 *
 * A drafted sibling is deliberately not a block. Nothing has gone out, and the
 * user may well be deciding between two roles at one company. It is surfaced on
 * the row instead, as a warning, which is what the private version of this board
 * did with a queue holding two roles at one employer.
 */
function shortlistBlock(r) {
  if (r.locked) return r.locked;
  if (r.company_state === "applied") return `Another posting at ${r.company} already has an application out.`;
  if (r.company_state === "parked") {
    return `Another posting at ${r.company} is parked mid-application. Finish that one before starting a second.`;
  }
  return null;
}

/**
 * Why neither verdict may be recorded on this row: the record has moved past the
 * three statuses the board owns. Separate from the company rule because it
 * disables BOTH buttons, where a company already spoken for still leaves "skip"
 * meaningful.
 *
 * This exists because the page offered a shortlist button on a failed send that
 * `apply` then refused. A control that is live in the browser and rejected by
 * the importer teaches the user to distrust the importer.
 */
function lockReason(r) {
  if (r.state === "applied" || r.state === "unproven") {
    return "This one was already sent. One application per company, no follow-ups.";
  }
  if (r.state === "in-flight") return "A lease is open on this right now.";
  // An expired lease outranks both verdicts. Nobody knows whether this went out,
  // and "skip" on a row in that state buries the only row on the page that
  // cannot be left alone. Resolving it is the work; judging it is not.
  if (r.state === "needs-you" && r.lease?.expired) {
    return "A lease on this expired and was never recorded. Resolve it with `gate resolve` before judging the row.";
  }
  if (!BOARD_WRITABLE.has(r.status)) {
    return `This record is at "${r.status}". The board only moves records between discovered, screened and skipped.`;
  }
  return null;
}

export function buildRows({ jobs, leases, human, now }) {
  const rows = jobs.map((job) => {
    const lease = leases.get(job.id) ?? null;
    const state = ownState(job, lease);
    const h = human.rows.get(job.id) ?? null;
    const comp = job.posted_comp || {};
    return {
      id: job.id,
      company: job.company || job.company_id || job.id,
      company_id: job.company_id || job.id,
      role: job.role || "",
      url: job.url || null,
      source: job.source || "unknown",
      channel: job.apply?.channel ?? null,
      target: job.apply?.target ?? null,
      route_confidence: job.apply?.route_confidence ?? null,
      identity_verified: !!job.apply?.identity_verified,
      location: job.location || "",
      workplace: job.workplace_type || "unknown",
      comp: comp.min || comp.max
        ? {
            currency: comp.currency || "",
            min: comp.min ?? null,
            max: comp.max ?? null,
            period: comp.period || "year",
            // Sorted on the posted number. Currencies are NOT converted: this
            // engine has no network and no rate table, and a made-up conversion
            // in a compensation column is worse than an unsorted one.
            mid: ((comp.min ?? comp.max) + (comp.max ?? comp.min)) / 2,
          }
        : null,
      equity: comp.equity || null,
      status: job.status,
      state,
      stage: h && HUMAN_STAGES.has(h.stage) ? h.stage : null,
      priority: h?.priority ?? null,
      next_action: h?.next_action ?? null,
      next_action_due: h?.next_action_due ?? null,
      sent_at: job.sent_at ? String(job.sent_at).slice(0, 10) : null,
      discovered_at: job.discovered_at ? String(job.discovered_at).slice(0, 10) : null,
      receipt: job.receipt || null,
      needs_human: !!job.needs_human,
      lease: lease ? { channel: lease.channel, expired: lease.expired, claimed_at: lease.claimed_at } : null,
      notes: job.notes || null,
      // filled in by the company pass below
      company_state: null,
      locked: null,
      shortlist_block: null,
      siblings: 0,
    };
  });

  /* The company pass. This is the half a per-row loop cannot see. */
  const byCompany = new Map();
  for (const r of rows) {
    if (!byCompany.has(r.company_id)) byCompany.set(r.company_id, []);
    byCompany.get(r.company_id).push(r);
  }
  for (const [, group] of byCompany) {
    for (const r of group) {
      const others = group.filter((o) => o.id !== r.id);
      r.siblings = others.length;
      // Reported in the order that matters to the reader: an application already
      // out is the one that makes a second send a duplicate. A parked one is the
      // one people re-apply to by accident, because it looks like nothing
      // happened.
      if (others.some((o) => SPOKEN_FOR.has(o.state))) r.company_state = "applied";
      else if (others.some((o) => o.state === "needs-you")) r.company_state = "parked";
      else if (others.some((o) => o.state === "drafted")) r.company_state = "drafted";
      r.locked = lockReason(r);
      r.shortlist_block = shortlistBlock(r);
    }
  }

  rows.sort(
    (a, b) =>
      (STATE_ORDER.get(a.state) ?? 99) - (STATE_ORDER.get(b.state) ?? 99) ||
      a.company.localeCompare(b.company) ||
      a.role.localeCompare(b.role),
  );

  const counts = Object.fromEntries(STATES.map(([id]) => [id, 0]));
  for (const r of rows) counts[r.state]++;

  return {
    rows,
    counts,
    companies: byCompany.size,
    // "Spoken for" is the number that answers "how many companies can I still
    // write to", which is the question the one-per-company rule actually poses.
    companies_spoken_for: [...byCompany.values()].filter((g) => g.some((r) => SPOKEN_FOR.has(r.state))).length,
    generated_at: new Date(now).toISOString(),
    human_state: { read: human.read, why: human.why },
  };
}

export async function collect(P, { now = Date.now() } = {}) {
  const { jobs, unreadable } = readJobs(P);
  const human = await readHumanState(P);
  const built = buildRows({ jobs, leases: readLeases(P, now), human, now });
  return { ...built, unreadable };
}

/* ── the page ──────────────────────────────────────────────────────────── */

/**
 * Embedding JSON in a script tag has exactly one escape that matters: a "<"
 * inside a string can close the tag early. Job data is scraped off the open web,
 * so assume every field is hostile. Everything else on the page is written with
 * textContent, never innerHTML, for the same reason.
 */
const jsonScript = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

const CSS = `
:root{color-scheme:light dark;
 --ground:#eceef3;--page:#fff;--ink:#1c1e26;--muted:#586072;--faint:#8a90a0;--line:#e7e9ef;
 --accent:#4a2fe0;--accent-weak:#f0ecff;--good:#0f7b4f;--good-weak:#e6f6ee;
 --warn:#b8460b;--warn-weak:#fff2e8;--stop:#b42318;--stop-weak:#fdeceb;
 --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,Roboto,Helvetica,Arial,sans-serif;
 --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace}
@media (prefers-color-scheme:dark){:root{
 --ground:#0c0e12;--page:#16181e;--ink:#e8eaf1;--muted:#99a0b0;--faint:#6b7284;--line:#262a33;
 --accent:#a596ff;--accent-weak:#221d3a;--good:#4ade80;--good-weak:#132a1e;
 --warn:#f0975a;--warn-weak:#2a1b11;--stop:#f87171;--stop-weak:#2d1618}}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font:14px/1.5 var(--sans)}
.wrap{max-width:1400px;margin:0 auto;padding:28px 20px 80px}
h1{margin:0 0 4px;font-size:22px;letter-spacing:-.01em}
.sub{margin:0 0 18px;color:var(--muted);max-width:70ch}
.note{margin:0 0 18px;padding:10px 12px;border-radius:8px;background:var(--warn-weak);
 color:var(--warn);border:1px solid var(--line);max-width:90ch}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:0 0 18px}
.card{background:var(--page);border:1px solid var(--line);border-radius:10px;padding:10px 14px;min-width:120px}
.card b{display:block;font-size:20px;letter-spacing:-.02em}
.card span{color:var(--muted);font-size:12px}
.bar{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 14px}
input,select,button{font:inherit;color:inherit}
input[type=search],select{background:var(--page);border:1px solid var(--line);border-radius:8px;padding:7px 10px}
input[type=search]{min-width:240px;flex:1}
.chip{background:var(--page);border:1px solid var(--line);border-radius:999px;padding:5px 11px;cursor:pointer}
.chip[aria-pressed=true]{background:var(--accent-weak);border-color:var(--accent);color:var(--accent)}
.scroll{overflow-x:auto;background:var(--page);border:1px solid var(--line);border-radius:12px}
table{border-collapse:collapse;width:100%;min-width:980px}
th{position:sticky;top:0;background:var(--page);text-align:left;font-size:12px;color:var(--muted);
 font-weight:600;padding:10px 12px;border-bottom:1px solid var(--line);white-space:nowrap;cursor:pointer}
td{padding:10px 12px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
tr.skipped td{opacity:.55}
tr.skipped .role{text-decoration:line-through}
.co{font-weight:600}
.role{display:block}
.role a{color:inherit}
.meta{display:block;color:var(--faint);font-size:12px}
.tag{display:inline-block;border-radius:999px;padding:2px 9px;font-size:12px;white-space:nowrap;
 background:var(--accent-weak);color:var(--accent)}
.tag.good{background:var(--good-weak);color:var(--good)}
.tag.warn{background:var(--warn-weak);color:var(--warn)}
.tag.stop{background:var(--stop-weak);color:var(--stop)}
.tag.flat{background:transparent;color:var(--muted);border:1px solid var(--line)}
.co-state{display:block;margin-top:4px;font-size:12px;color:var(--warn)}
.num{font-variant-numeric:tabular-nums;white-space:nowrap}
.act{display:flex;gap:6px}
.btn{background:var(--page);border:1px solid var(--line);border-radius:7px;padding:4px 9px;cursor:pointer;font-size:12px}
.btn:hover:not(:disabled){border-color:var(--accent);color:var(--accent)}
.btn:disabled{opacity:.45;cursor:not-allowed}
.btn.on{background:var(--accent-weak);border-color:var(--accent);color:var(--accent)}
.empty{padding:40px;text-align:center;color:var(--muted)}
footer{margin-top:22px;color:var(--faint);font-size:12px;max-width:90ch}
`;

/**
 * The page script. Rows are built in the browser from the embedded JSON so that
 * filtering does not need a server, and every cell is written with textContent.
 *
 * Filtering hides rows with the `hidden` attribute. That is display:none, which
 * the CV renderer's lint refuses, and it is fine here for the reason the lint
 * exists: that rule is about text hidden from a human reader while an automated
 * screener still sees it, in a document you send to someone. This page is never
 * sent to anyone. It is a local view of your own pipeline.
 */
const JS = String.raw`
const DATA = JSON.parse(document.getElementById("rows").textContent);
const STATE_LABEL = Object.fromEntries(DATA.states.map(s => [s[0], s[1]]));
const KEY = "career-kit.board.verdicts.v1";
const load = () => { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } };
let verdicts = load();
const save = () => localStorage.setItem(KEY, JSON.stringify(verdicts));

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = String(text);
  return n;
};

const money = (c) => {
  if (!c) return "";
  const k = (n) => (n >= 10000 ? Math.round(n / 1000) + "k" : String(n));
  const range = c.min && c.max && c.min !== c.max ? k(c.min) + "-" + k(c.max) : k(c.min || c.max);
  return [c.currency, range, "/" + c.period].filter(Boolean).join(" ");
};

/* Whether a row may be shortlisted is decided in engine/board.mjs and shipped on
   the row as shortlist_block, so this page and the importer that reads the export
   back in cannot disagree. The reason is spelled out on the disabled button,
   because a dead control with no explanation reads as a bug and gets clicked
   again. */

const F ={ q: "", states: new Set(), source: "", workplace: "", paid: false };

function passes(r) {
  if (F.states.size && !F.states.has(r.state)) return false;
  if (F.source && r.source !== F.source) return false;
  if (F.workplace && r.workplace !== F.workplace) return false;
  if (F.paid && !r.comp) return false;
  if (F.q) {
    const hay = (r.company + " " + r.role + " " + r.location + " " + r.source + " " + (r.notes || "")).toLowerCase();
    if (!F.q.split(/\s+/).every(t => hay.includes(t))) return false;
  }
  return true;
}

let sortKey = null, sortDir = 1;
function sorted(rows) {
  if (!sortKey) return rows;
  const val = (r) => {
    if (sortKey === "comp") return r.comp ? r.comp.mid : -1;
    if (sortKey === "company") return r.company.toLowerCase();
    if (sortKey === "role") return r.role.toLowerCase();
    if (sortKey === "source") return r.source;
    if (sortKey === "when") return r.sent_at || r.discovered_at || "";
    return "";
  };
  return rows.slice().sort((a, b) => { const x = val(a), y = val(b); return (x > y ? 1 : x < y ? -1 : 0) * sortDir; });
}

function verdictOf(id) { return verdicts[id] || null; }

function row(r) {
  const tr = el("tr", r.state === "skipped" || verdictOf(r.id) === "skip" ? "skipped" : "");

  const c1 = el("td");
  c1.append(el("span", "co", r.company));
  const role = el("span", "role");
  if (r.url) { const a = el("a", null, r.role); a.href = r.url; a.target = "_blank"; a.rel = "noreferrer noopener"; role.append(a); }
  else role.append(document.createTextNode(r.role));
  c1.append(role);
  if (r.siblings) c1.append(el("span", "meta", r.siblings + " more at this company"));
  tr.append(c1);

  const c2 = el("td", "num", money(r.comp));
  if (r.equity) c2.append(el("span", "meta", r.equity));
  tr.append(c2);

  const c3 = el("td");
  c3.append(document.createTextNode(r.location || ""));
  c3.append(el("span", "meta", r.workplace));
  tr.append(c3);

  const c4 = el("td");
  c4.append(document.createTextNode(r.source));
  if (r.route_confidence !== null) {
    c4.append(el("span", "meta", "route " + Math.round(r.route_confidence * 100) + "%" + (r.identity_verified ? ", identity ok" : ", identity unverified")));
  }
  tr.append(c4);

  const c5 = el("td", "num", r.sent_at || r.discovered_at || "");
  tr.append(c5);

  const c6 = el("td");
  const cls = { "needs-you": "tag stop", unproven: "tag warn", "in-flight": "tag warn", applied: "tag good", skipped: "tag flat", new: "tag flat" }[r.state] || "tag";
  c6.append(el("span", cls, STATE_LABEL[r.state]));
  if (r.stage) c6.append(el("span", "tag flat", r.stage));
  if (r.company_state) {
    const word = { applied: "company applied", parked: "company parked", drafted: "company drafted" }[r.company_state];
    c6.append(el("span", "co-state", word));
  }
  if (r.state === "needs-you") {
    c6.append(el("span", "meta", r.lease && r.lease.expired ? "lease expired, check the Sent folder" : "send failed"));
  }
  if (r.state === "unproven") c6.append(el("span", "meta", "no receipt"));
  tr.append(c6);

  const c7 = el("td");
  const acts = el("div", "act");
  const v = verdictOf(r.id);
  const block = r.shortlist_block;
  const star = el("button", "btn" + (v === "shortlist" ? " on" : ""), v === "shortlist" ? "shortlisted" : "shortlist");
  if (block) { star.disabled = true; star.title = block; }
  else star.onclick = () => { if (v === "shortlist") delete verdicts[r.id]; else verdicts[r.id] = "shortlist"; save(); draw(); };
  const skip = el("button", "btn" + (v === "skip" ? " on" : ""), v === "skip" ? "skipped" : "skip");
  if (r.locked) { skip.disabled = true; skip.title = r.locked; }
  else skip.onclick = () => { if (v === "skip") delete verdicts[r.id]; else verdicts[r.id] = "skip"; save(); draw(); };
  acts.append(star, skip);
  c7.append(acts);
  tr.append(c7);

  return tr;
}

function draw() {
  const shown = sorted(DATA.rows.filter(passes));
  const body = document.getElementById("body");
  body.textContent = "";
  for (const r of shown) body.append(row(r));
  document.getElementById("shown").textContent = shown.length + " of " + DATA.rows.length + " roles";
  const n = Object.values(verdicts).filter(v => v === "shortlist").length;
  const s = Object.values(verdicts).filter(v => v === "skip").length;
  document.getElementById("verdicts").textContent = n + " shortlisted, " + s + " skipped in this browser";
  document.getElementById("export").disabled = n + s === 0;
  document.getElementById("empty").hidden = shown.length > 0;
}

function exportVerdicts() {
  /* No timestamp from this clock. A browser clock has already labelled a whole
     sweep of local times as UTC in this project; engine/board.mjs stamps the
     evidence line when it reads this file back. */
  const payload = { version: 1, shortlist: [], skip: [] };
  for (const [id, v] of Object.entries(verdicts)) if (payload[v]) payload[v].push(id);
  const blob = new Blob([JSON.stringify(payload, null, 2) + "\n"], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "board-verdicts.json";
  a.click();
  URL.revokeObjectURL(a.href);
}

function boot() {
  const chips = document.getElementById("chips");
  for (const [id, label] of DATA.states) {
    const n = DATA.counts[id] || 0;
    if (!n) continue;
    const b = el("button", "chip", label + " " + n);
    b.setAttribute("aria-pressed", "false");
    b.onclick = () => {
      if (F.states.has(id)) F.states.delete(id); else F.states.add(id);
      b.setAttribute("aria-pressed", String(F.states.has(id)));
      draw();
    };
    chips.append(b);
  }
  for (const [sel, key, all] of [["#source", "source", "every source"], ["#workplace", "workplace", "anywhere"]]) {
    const node = document.querySelector(sel);
    const values = [...new Set(DATA.rows.map(r => r[key]))].filter(Boolean).sort();
    node.append(el("option", null, all));
    for (const v of values) node.append(el("option", null, v));
    node.onchange = () => { F[key] = node.selectedIndex === 0 ? "" : node.value; draw(); };
  }
  document.getElementById("q").oninput = (e) => { F.q = e.target.value.trim().toLowerCase(); draw(); };
  document.getElementById("paid").onclick = (e) => {
    F.paid = !F.paid;
    e.target.setAttribute("aria-pressed", String(F.paid));
    draw();
  };
  document.querySelectorAll("th[data-sort]").forEach(th => {
    th.onclick = () => {
      const k = th.dataset.sort;
      sortDir = sortKey === k ? -sortDir : (k === "comp" ? -1 : 1);
      sortKey = k;
      draw();
    };
  });
  document.getElementById("export").onclick = exportVerdicts;
  document.getElementById("clear").onclick = () => { verdicts = {}; save(); draw(); };
  draw();
}
boot();
`;

export function renderPage(data) {
  const c = data.counts;
  const cards = [
    [data.rows.length, "roles"],
    [data.companies, "companies"],
    [data.companies_spoken_for, "companies spoken for"],
    [c["needs-you"] + c.unproven, "need you"],
    [c.applied + c.unproven, "applied"],
    [c.drafted + c.shortlist, "ready to work"],
  ];

  const stale = data.human_state.read
    ? ""
    : `<p class="note"><b>Stages are machine status only.</b> ${escapeHtml(data.human_state.why)}. ` +
      `Anything a person typed into career.db (rejected, interview, on hold) is not on this page.</p>`;

  const unreadable = data.unreadable.length
    ? `<p class="note"><b>${data.unreadable.length} job record(s) could not be read</b> and are missing from every ` +
      `count below: ${escapeHtml(data.unreadable.map((u) => `${u.file} (${u.why})`).join("; "))}</p>`
    : "";

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job board</title>
<style>${CSS}</style>
</head><body><div class="wrap">
<h1>Job board</h1>
<p class="sub">Everything in <code>jobs/</code>, sorted by what needs a person first. Status comes from the
job records, the open leases and career.db, never from this browser. Shortlist and skip are verdicts you
record while reading; neither sends anything.</p>
${stale}${unreadable}
<div class="cards">${cards.map(([n, l]) => `<div class="card"><b>${n}</b><span>${l}</span></div>`).join("")}</div>
<div class="bar">
  <input type="search" id="q" placeholder="company, role, location, source" aria-label="Search">
  <select id="source" aria-label="Source"></select>
  <select id="workplace" aria-label="Workplace"></select>
  <button class="chip" id="paid" aria-pressed="false">has a posted number</button>
</div>
<div class="bar" id="chips"></div>
<div class="bar">
  <span class="meta" id="shown"></span><span class="meta" id="verdicts"></span>
  <button class="btn" id="export">export verdicts</button>
  <button class="btn" id="clear">clear</button>
</div>
<div class="scroll"><table>
<thead><tr>
  <th data-sort="company">Company and role</th>
  <th data-sort="comp">Posted</th>
  <th>Where</th>
  <th data-sort="source">Source</th>
  <th data-sort="when">Date</th>
  <th>State</th>
  <th>Verdict</th>
</tr></thead>
<tbody id="body"></tbody>
</table>
<p class="empty" id="empty" hidden>Nothing matches those filters.</p>
</div>
<footer>
Generated ${escapeHtml(data.generated_at)} by engine/board.mjs. Verdicts live in this browser until you
export them; <code>engine/board.mjs apply --verdicts board-verdicts.json</code> writes them back into the job
records. Compensation is shown exactly as posted and is not converted between currencies, so sorting by it
compares numbers that may be in different money.
</footer>
</div>
<script type="application/json" id="rows">${jsonScript({ rows: data.rows, counts: data.counts, states: STATES.map(([id, label]) => [id, label]) })}</script>
<noscript><p class="note">This page needs JavaScript to draw the table. The same numbers without it:
<code>engine/board.mjs --json</code></p></noscript>
<script>${JS}</script>
</body></html>
`;
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

/* ── apply: the export, read back in ───────────────────────────────────── */

/**
 * Move records between discovered / screened / skipped, and nothing else.
 *
 * Three refusals, all reported rather than silently skipped, because a verdict
 * file that quietly did less than it said is how a person ends up believing a
 * role was screened out:
 *
 *   1. An id with no job record. Usually a stale export from before a rename.
 *   2. A record past the board's authority: drafted, claimed, sent, failed.
 *      The gate owns those, and a browser button is not a gate.
 *   3. A shortlist at a company that is already spoken for. The gate would block
 *      the send anyway; blocking it here means the shortlist never pretends the
 *      work is still available.
 *
 * Rule 3 asks buildRows() for the company's state rather than working it out
 * again here, and that is the point. The first version of this function had its
 * own loop, which counted an application already sent but not one parked
 * mid-form, so the browser greyed the button out and the importer accepted the
 * same row from a hand-edited file. An exported file CAN be edited by hand,
 * which is exactly why the rule is re-checked here; re-checking it with a second
 * implementation gives you two rules that drift.
 */
export function applyVerdicts(P, verdicts, { now = Date.now(), dryRun = false } = {}) {
  const { jobs } = readJobs(P);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const { rows } = buildRows({
    jobs,
    leases: readLeases(P, now),
    human: { read: false, why: "not needed to judge a verdict", rows: new Map() },
    now,
  });
  const stateOf = new Map(rows.map((r) => [r.id, r]));

  const report = { changed: [], unchanged: [], refused: [] };
  const at = new Date(now).toISOString();

  for (const [want, ids] of [["screened", verdicts.shortlist ?? []], ["skipped", verdicts.skip ?? []]]) {
    for (const id of ids) {
      const job = byId.get(id);
      if (!job) {
        report.refused.push({ id, why: "no jobs/<id>.json with that id" });
        continue;
      }
      if (!BOARD_WRITABLE.has(job.status)) {
        report.refused.push({ id, why: `status is "${job.status}"; the board may only move discovered / screened / skipped` });
        continue;
      }
      const block = stateOf.get(id)?.shortlist_block;
      if (want === "screened" && block) {
        report.refused.push({ id, why: block });
        continue;
      }
      if (job.status === want) {
        report.unchanged.push({ id, status: want });
        continue;
      }
      report.changed.push({ id, from: job.status, to: want });
      if (dryRun) continue;
      job.status = want;
      job.updated_at = at;
      job.evidence = Array.isArray(job.evidence) ? job.evidence : [];
      job.evidence.push({ at, kind: "board-verdict", text: want === "screened" ? "shortlisted on the board" : "screened out on the board" });
      writeFileSync(P.job(id), JSON.stringify(job, null, 2) + "\n");
    }
  }
  return report;
}

/* ── CLI ───────────────────────────────────────────────────────────────── */

const USAGE =
  "usage: board.mjs [--json] [--out <path>]\n" +
  "       board.mjs apply --verdicts <file> [--dry-run] [--json]";

function fail(msg) {
  process.stderr.write(`board: ${msg}\n${USAGE}\n`);
  process.exit(2);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const key = a.slice(2);
    if (["json", "dry-run"].includes(key)) args[key] = true;
    else if (["out", "verdicts"].includes(key)) args[key] = argv[++i];
    else fail(`unknown flag ${a}`);
    if (args[key] === undefined) fail(`${a} needs a value`);
  }
  return args;
}

async function main(argv) {
  const args = parseArgs(argv);
  const verb = args._[0] ?? "render";
  if (!["render", "apply"].includes(verb)) fail(`unknown argument "${args._[0]}"`);
  if (args._.length > 1) fail(`unexpected argument "${args._[1]}"`);

  const P = ensureRuntimeDirs(paths(findCareerHome()));

  if (verb === "apply") {
    if (!args.verdicts) fail("apply needs --verdicts <file>");
    let verdicts;
    try {
      verdicts = JSON.parse(readFileSync(args.verdicts, "utf8"));
    } catch (err) {
      fail(`could not read ${args.verdicts}: ${err.message}`);
    }
    const report = applyVerdicts(P, verdicts, { dryRun: !!args["dry-run"] });
    if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
    else {
      const verb2 = args["dry-run"] ? "would change" : "changed";
      process.stdout.write(`${verb2} ${report.changed.length}, already right ${report.unchanged.length}\n`);
      for (const c of report.changed) process.stdout.write(`  ${c.id}: ${c.from} -> ${c.to}\n`);
    }
    for (const r of report.refused) process.stderr.write(`board: refused ${r.id}: ${r.why}\n`);
    process.exit(0);
  }

  const data = await collect(P);
  const out = args.out || join(P.outputs, "board.html");
  mkdirSync(join(out, ".."), { recursive: true });
  writeFileSync(out, renderPage(data));

  if (args.json) {
    process.stdout.write(JSON.stringify({ out, ...data, rows: undefined, row_count: data.rows.length }, null, 2) + "\n");
  } else {
    process.stdout.write(`${out}\n${data.rows.length} roles at ${data.companies} companies\n`);
    const c = data.counts;
    process.stdout.write(
      `${c["needs-you"] + c.unproven} need you, ${c.applied + c.unproven} applied, ${c.drafted} drafted, ${c.new} new\n`,
    );
    if (!data.human_state.read) process.stderr.write(`board: ${data.human_state.why}\n`);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
