/**
 * paths.mjs - the ONE place $CAREER_HOME is resolved.
 *
 * Every other module imports from here and never resolves a workspace path
 * itself. That is not tidiness: under plugin distribution the plugin lives in
 * ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/, which is
 * installer-owned and replaced on every version bump. Anything that writes
 * state beside the code loses that state on the next update.
 *
 * Resolution order:
 *   1. $CAREER_HOME
 *   2. ~/career, if it exists AND contains profile.yaml
 *   3. nothing. Exit 2 with the career-setup instruction.
 *
 * Step 3 never guesses and never creates implicitly. A tool that silently
 * provisions an empty workspace when the real one failed to resolve will
 * happily report "no applications sent yet" about a pipeline of 34.
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export const PLUGIN_ROOT = resolve(new URL("..", import.meta.url).pathname);

/** Files that mark a directory as a real workspace rather than an empty dir. */
const MARKER = "profile.yaml";

export function findCareerHome({ required = true } = {}) {
  const fromEnv = process.env.CAREER_HOME;
  if (fromEnv) return resolve(fromEnv);

  const fallback = join(homedir(), "career");
  if (existsSync(join(fallback, MARKER))) return fallback;

  if (!required) return null;
  process.stderr.write(
    "career-kit: no workspace found.\n" +
      `  Looked at: $CAREER_HOME (unset) and ${fallback} (no ${MARKER}).\n` +
      "  Run the career-setup skill to provision one, or set CAREER_HOME.\n",
  );
  process.exit(2);
}

/**
 * Every path in the workspace, in one object, so a rename is one edit here and
 * not a grep across the engine.
 */
export function paths(home = findCareerHome()) {
  const p = (...s) => join(home, ...s);
  return {
    home,
    profile: p("profile.yaml"),
    rules: p("rules.yaml"),
    voice: p("voice.md"),
    kb: p("knowledge-base.md"),
    cv: p("cv"),
    cvBase: p("cv", "base.md"),
    cvTheme: p("cv", "theme"),
    jobs: p("jobs"),
    jobsInbox: p("jobs", "inbox"),
    job: (id) => p("jobs", `${id}.json`),
    drafts: p("drafts"),
    draft: (id) => p("drafts", id),
    outputs: p("outputs"),
    brief: p("outputs", "brief.md"),
    receipts: p("outputs", "receipts"),
    receipt: (id) => p("outputs", "receipts", id),
    reports: p("outputs", "reports"),
    db: p("career.db"),
    ledger: p(".ledger.jsonl"),
    leases: p(".leases"),
    lease: (id, channel) => p(".leases", `${slug(id)}.${slug(channel)}.json`),
    previewerToken: p(".previewer-token"),
  };
}

/** A lease filename must never escape .leases/ via an id containing a slash. */
export function slug(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120);
}

/** Directories the engine may create on demand. The workspace root may not. */
export function ensureRuntimeDirs(P) {
  for (const d of [P.jobs, P.jobsInbox, P.drafts, P.outputs, P.receipts, P.reports, P.leases]) {
    mkdirSync(d, { recursive: true });
  }
  return P;
}

/** Template files shipped with the plugin. */
export function templates(name) {
  return join(PLUGIN_ROOT, "templates", name);
}
