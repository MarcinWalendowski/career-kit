/**
 * fill-accounting.test.mjs - the health check must not lie about how much is left.
 *
 * Two defects found by a sandbox dry run of career-setup, both of which made
 * `doctor` report a workspace as more finished than it was. That is the worst
 * direction for this particular number to be wrong in: the whole point of
 * `[[FILL]]` is that an honest gap marker beats a plausible sentence, and the
 * skill's Finish step reads doctor's count out loud to the user.
 *
 *   1. TWO COUNTERS. init.mjs and doctor.mjs matched `/\[\[FILL\]\]/` (bare
 *      only) while render.mjs matched `/\[\[FILL/` (prefix). The shipped
 *      scaffold uses the annotated `[[FILL: ...]]` form throughout, so the
 *      health check saw 35 of its 61 markers.
 *   2. NO MARKERS AT ALL in profile.example.yaml and voice.example.md - they
 *      ship as complete fictional documents. Marker counting therefore could
 *      not distinguish "filled in" from "never opened", and both scored a
 *      clean 0 on a workspace where nothing had been done. A user who honestly
 *      declined voice derivation and wrote real markers scored WORSE than one
 *      who left Ada Lovelace in place, so the do-nothing path was rewarded.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { countFillText, isUneditedTemplate, templates } from "../engine/paths.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const ENGINE = (n) => join(ROOT, "engine", n);

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "ck-fill-"));
  test.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "career");
}

function doctor(home) {
  try {
    return JSON.parse(execFileSync("node", [ENGINE("doctor.mjs"), "--json"], {
      env: { ...process.env, CAREER_HOME: home },
      encoding: "utf8",
    }));
  } catch (e) {
    // doctor exits 1 when degraded, which is the normal case here.
    return JSON.parse(e.stdout);
  }
}

test("an annotated [[FILL: ...]] marker counts as a gap", () => {
  assert.equal(countFillText("[[FILL]]"), 1);
  assert.equal(countFillText("[[FILL: say what goes here]]"), 1);
  assert.equal(countFillText("[[FILL]] and [[FILL: more]]"), 2);
  assert.equal(countFillText("nothing here"), 0);
});

test("the shipped scaffold's markers are counted in full, not a third of them", () => {
  const text = readFileSync(templates("knowledge-base.scaffold.md"), "utf8");
  const bareOnly = (text.match(/\[\[FILL\]\]/g) || []).length;
  const real = countFillText(text);
  // The regression this guards: the annotated form outnumbers the bare form in
  // the shipped scaffold, so a bare-only counter is not slightly wrong, it is
  // wrong by most of the file.
  assert.ok(real > bareOnly, `scaffold should hold annotated markers (real=${real}, bare=${bareOnly})`);
  assert.ok(real >= 60, `expected the scaffold's real marker count, got ${real}`);
});

test("every engine that counts markers agrees with every other one", () => {
  // The defect was two definitions, so assert there is now one. A grep is the
  // right instrument: a second literal regex reappearing is exactly the
  // regression, and it would not show up in behaviour until a template changed.
  for (const file of ["init.mjs", "doctor.mjs", "render.mjs"]) {
    const src = readFileSync(ENGINE(file), "utf8");
    const inline = src.match(/match\(\s*\/\\\[\\\[FILL/g) || [];
    assert.equal(
      inline.length,
      0,
      `${file} counts [[FILL]] with its own inline regex; use countFillText from paths.mjs`,
    );
  }
});

test("NEGATIVE: an untouched profile.yaml and voice.md are not 'done'", () => {
  const home = scratch();
  execFileSync("node", [ENGINE("init.mjs"), "--home", home], { encoding: "utf8" });

  const r = doctor(home);
  assert.equal(r.files["profile.yaml"].untouched, true, "shipped persona must be detected");
  assert.equal(r.files["voice.md"].untouched, true);
  assert.equal(r.files["rules.yaml"].untouched, false, "rules has no persona to carry");

  // The point of the whole fix: `next` must name it, and the run must not
  // read as ready.
  assert.match(r.next, /Ada Lovelace/, `next should name the persona, got: ${r.next}`);
});

test("NEGATIVE: the do-nothing path must not outscore an honest decline", () => {
  const home = scratch();
  execFileSync("node", [ENGINE("init.mjs"), "--home", home], { encoding: "utf8" });

  const untouched = doctor(home);

  // Now write what a user who DECLINED voice derivation honestly produces: no
  // persona, explicit gap markers.
  writeFileSync(
    join(home, "voice.md"),
    "# Voice\n\n## Openings\n[[FILL: how you open a first email]]\n\n## Provenance\n" +
      "**Derived from:** nothing. No sample was read.\n",
    "utf8",
  );
  const honest = doctor(home);

  assert.equal(honest.files["voice.md"].untouched, false, "the persona is gone");
  assert.ok(honest.files["voice.md"].fill > 0, "honest gaps are counted");
  // Before the fix, `untouched` scored fill 0 and `honest` scored fill 12, so
  // doing nothing looked strictly better. Now the untouched one is flagged.
  assert.equal(untouched.files["voice.md"].untouched, true);
  assert.ok(
    !honest.files["voice.md"].untouched && untouched.files["voice.md"].untouched,
    "the untouched template must be the one flagged, not the honest one",
  );
});

test("untouched detection compares against the template, and has no false positives", () => {
  const pristineProfile = readFileSync(templates("profile.example.yaml"), "utf8");
  assert.equal(isUneditedTemplate("profile.yaml", pristineProfile), true);

  // One character changed and the file is the user's. This is what stops the
  // check firing on a genuinely completed document that happens to reuse the
  // example identity - which the suite's own "filled workspace" fixture does.
  assert.equal(isUneditedTemplate("profile.yaml", pristineProfile + "\n# mine\n"), false);
  assert.equal(isUneditedTemplate("profile.yaml", "name: Ada Lovelace"), false);

  assert.equal(
    isUneditedTemplate("voice.md", readFileSync(templates("voice.example.md"), "utf8")),
    true,
  );
  // knowledge-base.md is marker-driven; it must never be flagged this way.
  assert.equal(isUneditedTemplate("knowledge-base.md", "anything"), false);
});
