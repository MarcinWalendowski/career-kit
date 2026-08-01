#!/usr/bin/env node
/**
 * doctor.mjs - the whole state of the world, in one call.
 *
 * Setup used to end with three separate commands (gate status, validate --all,
 * render --target html) and every other skill re-derived "am I ready" its own
 * way. This is the one probe they all share, and it answers the only question
 * that actually matters at the end of onboarding: what is the next thing to do.
 *
 * ON MAIL, AND WHAT THIS COMMAND IS NOT ALLOWED TO CLAIM
 * -----------------------------------------------------
 * The engine is a plain node process with zero dependencies. It cannot see the
 * agent's live MCP tool list; it can only read config on disk. So a negative
 * here means "no mail server is configured in the files I can read", never "you
 * have no mail tool" - the agent asking may well be holding one this process
 * cannot observe. `mail.authoritative` is false for exactly that reason, and
 * the caller is told to trust its own tool list over this field.
 *
 * Reporting a capability you cannot actually query is how a consent surface
 * ends up describing access it never verified.
 *
 * Usage
 *   doctor.mjs [--json]
 *
 * Exit codes: 0 ready, 1 usable but degraded, 2 no workspace.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { paths, PLUGIN_ROOT } from "./paths.mjs";
import { findChrome } from "./render.mjs";

const argv = process.argv.slice(2);
const asJson = argv.includes("--json") || !process.stdout.isTTY;

/* ── workspace ─────────────────────────────────────────────────────────── */

/**
 * Same order as paths.mjs findCareerHome(), but it reports the miss instead of
 * exiting on it. doctor's job is to describe a broken workspace, so it cannot
 * use the helper that refuses to run without one.
 */
function locate() {
  if (process.env.CAREER_HOME) {
    const home = resolve(process.env.CAREER_HOME);
    return { home, via: "CAREER_HOME", exists: existsSync(join(home, "profile.yaml")) };
  }
  const home = join(homedir(), "career");
  return { home, via: "default ~/career", exists: existsSync(join(home, "profile.yaml")) };
}

const FILES = ["profile.yaml", "rules.yaml", "voice.md", "knowledge-base.md"];
const FILL = /\[\[FILL\]\]/g;

/* ── mail ──────────────────────────────────────────────────────────────── */

/**
 * Anything whose server name or spawn command reads like mail. Deliberately a
 * loose pattern over a vendor list: this kit does not require one mail tool,
 * and hard-coding a preferred vendor's name is how "detected" quietly becomes
 * "detected the one we shipped".
 */
const MAILISH = /mail|imap|smtp|inbox|email/i;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function mailProbe() {
  const found = [];
  const sources = [];

  const claudeJson = readJson(join(homedir(), ".claude.json"));
  if (claudeJson) {
    sources.push("~/.claude.json");
    const scopes = [claudeJson.mcpServers, claudeJson.projects?.[process.cwd()]?.mcpServers];
    for (const scope of scopes) {
      for (const [name, cfg] of Object.entries(scope || {})) {
        const hay = `${name} ${cfg?.command || ""} ${(cfg?.args || []).join(" ")} ${cfg?.url || ""}`;
        if (MAILISH.test(hay)) found.push(name);
      }
    }
  }

  const projectMcp = readJson(join(process.cwd(), ".mcp.json"));
  if (projectMcp) {
    sources.push("./.mcp.json");
    for (const name of Object.keys(projectMcp.mcpServers || {})) {
      if (MAILISH.test(name)) found.push(name);
    }
  }

  return {
    detected: found.length > 0,
    servers: [...new Set(found)],
    looked_in: sources,
    authoritative: false,
    note: "Config-file evidence only. Your own MCP tool list is the real answer; trust it over this.",
  };
}

/* ── gate ──────────────────────────────────────────────────────────────── */

function gateStatus(home) {
  const r = spawnSync(process.execPath, [join(PLUGIN_ROOT, "engine", "gate.mjs"), "status"], {
    env: { ...process.env, CAREER_HOME: home },
    encoding: "utf8",
  });
  try {
    return JSON.parse(r.stdout);
  } catch {
    return null;
  }
}

/* ── run ───────────────────────────────────────────────────────────────── */

const loc = locate();
const nodeMajor = Number(process.versions.node.split(".")[0]);

const report = {
  node: { version: process.versions.node, ok: nodeMajor >= 20 },
  workspace: { home: loc.home, resolved_via: loc.via, exists: loc.exists },
  files: {},
  fill_total: 0,
  mode: null,
  gate: null,
  mail: mailProbe(),
  pdf: null,
  next: null,
};

const chrome = findChrome();
report.pdf = {
  available: Boolean(chrome),
  chrome: chrome || null,
  note: chrome ? null : "HTML and Markdown export still work; only --target pdf needs Chrome.",
};

if (!loc.exists) {
  report.next = "No workspace yet. Run the career-setup skill (or engine/init.mjs) to provision one.";
  emit(report, 2);
}

const P = paths(loc.home);
for (const name of FILES) {
  const path = join(loc.home, name);
  const present = existsSync(path);
  const fill = present ? (readFileSync(path, "utf8").match(FILL) || []).length : 0;
  report.files[name] = { present, fill };
  report.fill_total += fill;
}

const status = gateStatus(loc.home);
if (status) {
  report.mode = status.mode;
  report.gate = {
    quota: status.quota,
    openLeases: status.openLeases,
    expiredLeases: status.openLeases.filter((l) => l.expired).length,
    totals: status.totals,
    recentBlocks: status.recentBlocks,
  };
}

report.jobs = existsSync(P.jobs)
  ? readdirSync(P.jobs).filter((f) => f.endsWith(".json")).length
  : 0;

/* ── the one next action ───────────────────────────────────────────────── */

/**
 * Ordered by what actually blocks progress. An expired lease outranks an
 * unfilled file because a stalled lease means a send may have happened that
 * nothing recorded, and that is the failure the gate exists to surface.
 */
function nextAction(r) {
  if (!r.node.ok) return `Node ${r.node.version} is too old; the engine needs 20 or later.`;
  if (r.gate?.expiredLeases) {
    return `${r.gate.expiredLeases} expired lease(s). Somebody checks the Sent folder, then: gate resolve --outcome sent|not-sent`;
  }
  const missing = FILES.filter((f) => !r.files[f].present);
  if (missing.length) return `Missing ${missing.join(", ")}. Re-run engine/init.mjs; it will not touch what exists.`;
  if (r.files["knowledge-base.md"].fill) {
    return `knowledge-base.md still has ${r.files["knowledge-base.md"].fill} [[FILL]] marker(s). Fill them with career-kb before tailoring anything.`;
  }
  if (r.files["profile.yaml"].fill) {
    return `profile.yaml still has ${r.files["profile.yaml"].fill} [[FILL]] marker(s). Every one is an answer some form will demand.`;
  }
  if (!r.jobs) return "No job records yet. Run career-sources to find roles.";
  if (r.mode === "draft") return "Ready. Mode is draft, so everything is written and nothing is sent. Read a few drafts you agree with, then set mode: review in rules.yaml.";
  return "Ready. Run career-review to see what is waiting on you.";
}

report.next = nextAction(report);

/**
 * Degraded is not broken. A workspace with no mail tool and no Chrome is a
 * perfectly good draft-mode workspace, so it exits 1 rather than 2 and the
 * wording has to keep that distinction visible to whoever reads it.
 */
const degraded =
  !report.node.ok ||
  report.fill_total > 0 ||
  Object.values(report.files).some((f) => !f.present) ||
  (report.gate?.expiredLeases ?? 0) > 0;

emit(report, degraded ? 1 : 0);

function emit(r, code) {
  if (asJson) {
    process.stdout.write(JSON.stringify(r, null, 2) + "\n");
  } else {
    const lines = [
      `workspace  ${r.workspace.exists ? r.workspace.home : "none"}  (${r.workspace.resolved_via})`,
      `node       ${r.node.version}${r.node.ok ? "" : "  TOO OLD"}`,
      `mode       ${r.mode ?? "-"}`,
      `jobs       ${r.jobs ?? 0}`,
      `fill       ${r.fill_total} [[FILL]] marker(s)`,
      `mail       ${r.mail.detected ? r.mail.servers.join(", ") : "none in config (your tool list is authoritative)"}`,
      `pdf        ${r.pdf.available ? r.pdf.chrome : "no Chrome; HTML and Markdown still work"}`,
      ``,
      `next       ${r.next}`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
  }
  process.exit(code);
}
