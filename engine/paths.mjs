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

import { existsSync, mkdirSync, readFileSync } from "node:fs";
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

/**
 * One definition of what a gap marker looks like, because there were two.
 *
 * `init.mjs` and `doctor.mjs` matched `/\[\[FILL\]\]/` — the bare form only —
 * while `render.mjs` matched `/\[\[FILL/`, the prefix. The shipped
 * knowledge-base scaffold uses the annotated `[[FILL: what to write here]]`
 * form throughout, so the health check saw 35 of its 61 markers and told users
 * they had a third of the homework they actually had. Two counters for one
 * concept in one product is how a number that is quoted to the user ends up
 * being the wrong one.
 *
 * The prefix form is the correct one: an annotated marker is still a gap, and
 * the annotation is the part that says what to write.
 */
export const FILL_MARKER = () => /\[\[FILL/g;

/** Count gap markers in a string. */
export function countFillText(text) {
  return (String(text).match(FILL_MARKER()) || []).length;
}

/**
 * Which shipped template each live file is copied from. Only the two that ship
 * as complete fictional documents are listed: knowledge-base.md is marker-driven
 * and rules.yaml is demoted to `mode: draft` by init, so neither can be
 * mistaken for finished.
 */
const TEMPLATE_OF = {
  "profile.yaml": "profile.example.yaml",
  "voice.md": "voice.example.md",
};

/**
 * True when `text` is still, byte for byte, the template it was copied from.
 *
 * `profile.example.yaml` and `voice.example.md` carry ZERO gap markers - they
 * ship as complete, plausible, fictional documents. So marker counting could
 * not distinguish "the user filled this in" from "the user never opened it",
 * and both scored a clean 0 on a workspace where nothing had been done. Worse,
 * a user who honestly declined voice derivation and wrote real markers scored
 * WORSE than one who left the example persona in place: the do-nothing path
 * was rewarded by the health check.
 *
 * profile.example.yaml already warned, in prose, that "if you ever see 'Ada
 * Lovelace' in a draft, the import did not finish and nothing should be sent."
 * That was a hope. This is the check.
 *
 * It compares against the TEMPLATE rather than sniffing for the persona name,
 * deliberately. Name sniffing flags any document that mentions Ada Lovelace,
 * including a genuinely completed one that happens to use the same example
 * identity - which the test suite's own "filled workspace" fixture does. An
 * exact comparison has no false positives: the moment a user changes one
 * character, the file is theirs. The tradeoff is a file edited but left with
 * example contact details still passes, so this is a floor, not a full check.
 */
export function isUneditedTemplate(file, text) {
  const template = TEMPLATE_OF[file];
  if (!template) return false;
  try {
    return String(text).trim() === readFileSync(templates(template), "utf8").trim();
  } catch {
    return false;
  }
}
