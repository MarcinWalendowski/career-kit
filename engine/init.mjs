#!/usr/bin/env node
/**
 * init.mjs - provision a workspace in ONE call.
 *
 * This exists because provisioning used to be prose. The setup skill carried a
 * mkdir block, a `git init`, a `cp` of the workspace gitignore and a shell loop
 * that globbed the templates, and an agent retyped all four every time. Four
 * hand-run commands is four chances to run three of them.
 *
 * That glob was also wrong. It expanded `templates/<name>.example.*`, which
 * matches profile, rules and voice but NOT `knowledge-base.scaffold.md` - so
 * every workspace ever provisioned by that loop came up without a knowledge
 * base, which is the one file the whole pipeline treats as fact. The mapping
 * below is explicit for exactly that reason: a literal table cannot silently
 * match nothing.
 *
 * IDEMPOTENT, and that is the design. Re-running on a live workspace writes
 * nothing and reports what it found. There is no --force: the failure mode this
 * has to rule out is an agent "repairing" a workspace by overwriting the
 * profile a user spent an interview filling in.
 *
 * Usage
 *   init.mjs [--home <path>] [--no-git]
 *
 * Exit codes: 0 provisioned or already provisioned, 2 usage or permission error.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { paths, ensureRuntimeDirs, templates, countFillText } from "./paths.mjs";

/* ── args ──────────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i > -1 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};

const die = (msg) => {
  process.stderr.write(`init: ${msg}\n`);
  process.exit(2);
};

/* ── where ─────────────────────────────────────────────────────────────── */

/**
 * init resolves $CAREER_HOME itself rather than calling findCareerHome(),
 * because that helper exits 2 when no workspace exists - which is the exact
 * situation init is for. Same order, minus the refusal.
 */
function targetHome() {
  const explicit = opt("home");
  if (explicit) return { home: resolve(explicit), via: "--home" };
  if (process.env.CAREER_HOME) return { home: resolve(process.env.CAREER_HOME), via: "CAREER_HOME" };
  return { home: join(homedir(), "career"), via: "default" };
}

/* ── what gets copied ──────────────────────────────────────────────────── */

/**
 * Explicit source -> destination. No globbing. `knowledge-base` breaks the
 * `.example.` convention on purpose (it is a scaffold, not a filled example),
 * and a glob is what hid that.
 */
const SEEDS = [
  { from: "profile.example.yaml", to: "profile.yaml" },
  { from: "rules.example.yaml", to: "rules.yaml" },
  { from: "voice.example.md", to: "voice.md" },
  { from: "knowledge-base.scaffold.md", to: "knowledge-base.md" },
];

const countFill = (path) => {
  if (!existsSync(path)) return 0;
  return countFillText(readFileSync(path, "utf8"));
};

/**
 * A new workspace starts one rung BELOW the template's `mode: review`.
 *
 * rules.example.yaml documents that difference and the old setup skill asked an
 * agent to honour it in prose. It is done here instead, in code, because the
 * cost of the prose being skipped once is a send from a workspace whose owner
 * has not yet read a single draft. Only applied to a rules.yaml this run
 * created - an existing file's mode is the user's.
 */
function demoteToDraft(path) {
  const before = readFileSync(path, "utf8");
  const after = before.replace(/^mode:[ \t]*\w+/m, "mode: draft");
  if (after === before) return false;
  writeFileSync(path, after);
  return true;
}

/* ── run ───────────────────────────────────────────────────────────────── */

const { home, via } = targetHome();
const created = [];
const existed = [];

const fresh = !existsSync(join(home, "profile.yaml"));

try {
  mkdirSync(home, { recursive: true });
} catch (err) {
  die(`cannot create ${home}: ${err.message}`);
}

const P = paths(home);

// The runtime dirs the engine may create on demand, plus cv/, which it may not.
ensureRuntimeDirs(P);
mkdirSync(P.cv, { recursive: true });

/* .gitignore first. A workspace that gets a git repo before it gets an ignore
   file has a window in which `git add -A` stages the ledger and the drafts. */
const ignore = join(home, ".gitignore");
if (existsSync(ignore)) {
  existed.push(".gitignore");
} else {
  copyFileSync(templates("workspace.gitignore"), ignore);
  created.push(".gitignore");
}

for (const seed of SEEDS) {
  const dst = join(home, seed.to);
  if (existsSync(dst)) {
    existed.push(seed.to);
    continue;
  }
  const src = templates(seed.from);
  if (!existsSync(src)) die(`template missing: ${src}`);
  copyFileSync(src, dst);
  created.push(seed.to);
}

let demoted = false;
if (created.includes("rules.yaml")) demoted = demoteToDraft(P.rules);

/* ── git ───────────────────────────────────────────────────────────────── */

/**
 * No `git commit`. The history is the user's to start, and an initial commit
 * made by a tool is one they have to undo before they can write their own.
 */
let git;
if (flag("no-git")) {
  git = "skipped";
} else if (existsSync(join(home, ".git"))) {
  git = "already a repo";
} else {
  const r = spawnSync("git", ["-C", home, "init", "--quiet"], { encoding: "utf8" });
  git = r.error ? `unavailable (${r.error.code})` : r.status === 0 ? "initialised" : `failed (${(r.stderr || "").trim()})`;
}

/* ── report ────────────────────────────────────────────────────────────── */

const fillMarkers = {};
let fillTotal = 0;
for (const seed of SEEDS) {
  const n = countFill(join(home, seed.to));
  if (n) fillMarkers[seed.to] = n;
  fillTotal += n;
}

process.stdout.write(
  JSON.stringify(
    {
      home,
      resolved_via: via,
      fresh,
      created,
      existed,
      git,
      mode: demoted ? "draft" : null,
      fill_markers: fillMarkers,
      fill_total: fillTotal,
    },
    null,
    2,
  ) + "\n",
);

if (!fresh) {
  process.stderr.write(
    `init: ${home} already holds a workspace. Nothing was overwritten.\n`,
  );
}
