---
name: career-tailor
description: Turn a job description into a match report and a role-tailored application draft. Fetches the JD from a URL or takes it pasted, maps every requirement to evidence in the knowledge base with a strength rating, picks honest keywords, writes outputs/reports/<id>.md, and drafts the application in the user's own voice. Never sends anything. Use when the user shares a job posting link, pastes a JD, or says "should I apply to this", "tailor my application for this role", "how well do I match this job".
---

# Tailor an application to a job

Produces two artifacts and no side effects: a match report at
`$CAREER_HOME/outputs/reports/<id>.md`, and a draft under `$CAREER_HOME/drafts/<id>/`. Sending is
`career-apply`, and it is the only skill that can.

## 1. Get the job description

- `WebFetch` first. Public ATS pages and company sites answer directly.
- JavaScript-gated or login-gated pages: open a browser tab and read the rendered text. The body
  often needs a "show more" click.
- If it will not reveal the body, ask the user to paste it. Do not tailor against a job title.

Capture: company, exact role title, seniority, location, workplace type, comp if shown, must-haves,
nice-to-haves, the domain, and **the exact phrases the JD repeats**. Note the register too, founder
startup or enterprise, and whether it names a stack.

Check the title against `rules.yaml: roles.allow` / `roles.deny` before doing any of the work below.
A denied title stops here.

## 2. Build the requirement-to-evidence table

Read `$CAREER_HOME/knowledge-base.md`. For every requirement in the JD, one row:

| JD requirement | Evidence (which role, which bullet) | Strength |
|---|---|---|
| ... | ... | strong / partial / gap |

Rules for the strength column, and they are the whole point of the table:

- **strong** - the knowledge base states it, with an outcome or a number attached.
- **partial** - the knowledge base supports something adjacent. Say which, in the report, in the
  words the knowledge base uses (`adjacent`, `evaluated`, `contributed to`). Never round it up.
- **gap** - nothing supports it. It stays a gap. A gap is a row in the report, not a sentence
  deleted from the analysis.

**Truth over match.** Never add a skill or an experience the knowledge base does not support in
order to hit a keyword. If the JD wants something the user lacks, that is a finding, and it belongs
in the report where they can act on it. The failure mode this exists to prevent is a number or a
technology in an application that nothing behind it supports, which costs the job later and more
expensively than the gap would have cost now.

If the user asserts new evidence while you work, it goes through `career-kb` into the knowledge base
first, then into this table. Facts do not enter the pipeline sideways.

## 3. Pick the keywords

Take the JD's own repeated phrases and keep the ones that are **true** for this user, cross-checked
against the knowledge base keyword bank. Prefer the JD's verbatim wording over a synonym when it is
honestly supported: the phrasing is what a screener matches on, and matching a phrase you can back
is free.

Drop the rest. A keyword you cannot evidence is a claim, and `gate verify` will flag it.

Then pick the framing variant. The knowledge base carries two or three ways of describing how the
user works, one per audience. Choose the one matching the JD's register and record the choice in the
report. Do not write a fourth variant here; if none fits, that is a `career-kb` change.

## 4. Decide the CV, from config not from habit

```bash
grep -A1 '^cv:' "$CAREER_HOME/rules.yaml"
```

- `cv.regenerate_per_role: false` - attach the canonical file at `profile.yaml: attachments.cv`
  **as-is**. Do not trim it, do not rebuild it, do not produce a one-off. One canonical document
  means every reader sees the same one, and the role-specific work goes into the message, which is
  what a human reads first.
- `cv.regenerate_per_role: true` - render a role-tailored CV:
  ```bash
  node "$CLAUDE_PLUGIN_ROOT/engine/render.mjs" --target pdf --theme "$(cat "$CAREER_HOME/cv/theme")" --emphasis <section-ids>
  ```
  Emphasis reorders sections and drops non-CV ones. It never adds a claim and never drops a role.
  `render.mjs` runs the hidden-text lint before emitting. If it **exits 3** naming a selector, the
  theme is trying to hide text from a human while showing it to a screener. Fix the theme.
  (The JSON on stdout carries `"status": 422`; the process exit code is 3. Exit codes are taken
  mod 256, so 422 would arrive as 166.)

This is config and not a hardcoded answer because it is a real preference split. One canonical CV
per person is faster and consistent; a per-role CV wins where a screener scores the document itself.
Read the file, do not assume.

## 5. Write the report

`$CAREER_HOME/outputs/reports/<id>.md`:

- the requirement-to-evidence table;
- the chosen keywords and the framing variant, with why;
- what the message leads with;
- **honest gaps**, each with a suggested framing that does not pretend the gap away;
- the CV decision and, if regenerated, what was emphasised.

## 6. Draft the message

Read `$CAREER_HOME/voice.md` and `$CAREER_HOME/outputs/brief.md`. The brief is compiled from the
user's own profile, rules, voice and knowledge base - it is the contract, not this file.

The limits that hold regardless of voice, because they come from `rules.yaml: content`:

- `max_sections` and `max_sentences`. Long is the failure mode. A reader skims, and the CV carries
  the detail. Pick the two or three strongest true facts, say them plainly, stop.
- `banned_characters` and `banned_phrases`. The gate blocks a send on `banned-content`, so a draft
  that trips it is a draft you will rewrite anyway.
- Lead with outcomes, not with the stack. Name a technology only when it proves something
  surprising, and never more than one or two in a sentence.
- Do not oversell. Cut anything that tells the recipient what their product lacks, claims to have
  read their mind, or frames the user's work as what their customers wish they had.

Write it to `$CAREER_HOME/drafts/<id>/message.md`. Then:

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/gate.mjs" verify --artifact "$CAREER_HOME/drafts/<id>/message.md"
```

`verify` is a flagger, not a prover. It flags sentences carrying a number, a proper noun or a
first-person verb that do not trace to a knowledge-base line. It produces false positives on
paraphrase and it will miss a fabrication phrased in knowledge-base vocabulary. Read every flag,
fix what is genuinely untraced, and say in the report which flags you dismissed and why.

## 7. Hand off

Report to the user: the strongest matches, the real gaps, where the report and draft are, and which
CV will be attached. Then stop. Sending is `career-apply`, which runs the gate. This skill has no
path to an irreversible action and must not grow one.
