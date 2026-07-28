---
name: career-kb
description: Edit the career knowledge base and regenerate every surface derived from it - CV, brief, reports, previewer. The only write path for facts about the user. Use when the user says "add this to my knowledge base", "update my CV with X", "I also built Y", "fix that date on my resume", "my title was actually Z", or asserts any new fact about their own experience in chat.
---

# Edit the knowledge base, then regenerate everything

`$CAREER_HOME/knowledge-base.md` is the single source of truth for every factual claim this pipeline
makes. **This skill is the only path that writes a fact.** Nothing else edits a CV, a brief or a
report by hand.

## Why this is a skill and not an editor tip

One fact used to require edits in up to eight files: the knowledge base, three CV variants in two
formats each, a hub page, and a LinkedIn summary. The changelog that recorded those fan-outs is the
tell - a fan-out only needs an audit trail because nobody trusts it happened everywhere.

It did not. Three "How I work" framing variants were copied verbatim out of the knowledge base into
an HTML file as JavaScript string literals. From that moment the page and the knowledge base were
two sources of truth wearing one name, and only one of them got corrected.

So: **edit one file, then re-render.** A derived file you can hand-edit is a derived file that will
drift.

## Flow

### 1. Locate the fact

Read `$CAREER_HOME/knowledge-base.md` and find where the fact belongs. Sections: identity,
experience, products and deep dives, skills matrix, achievement bank, keyword bank, framing
variants, gaps. If it belongs in two places, it belongs in one and is referenced from the other.

If a user asserts a fact in chat - a new role, a corrected number, a product that shipped - it goes
here **first**, before it is used in any draft. A fact used before it is written is a fact that
exists only in a transcript.

### 2. Write it

- Numbers carry their source. A number nobody can trace gets flagged by `gate verify` later, and
  the flag is only useful if the fix is available in the same file.
- Strength language is load-bearing: `daily`, `used in production`, `adjacent`, `evaluated`. A
  tailoring skill reads these and will not upgrade one to hit a keyword.
- Clear `[[FILL]]` when the user supplies the missing piece. Leave it when they do not.
- Corrections replace the old text and say what changed and when. Appending a correction below a
  wrong line leaves the wrong line readable as current.

### 3. Fan out by regenerating

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/render.mjs" --target md
node "$CLAUDE_PLUGIN_ROOT/engine/render.mjs" --target html
node "$CLAUDE_PLUGIN_ROOT/engine/render.mjs" --target pdf     # if the workspace keeps a generated CV
node "$CLAUDE_PLUGIN_ROOT/engine/render.mjs" --target brief   # outputs/brief.md, read at every send
```

`render.mjs` runs the hidden-text lint before it emits. If it exits 422 naming a selector, the
template is trying to hide text from a human reader while showing it to a screener. Fix the
template. Do not pass the lint a flag.

### 4. Check what already quoted the old fact

A correction is only finished when the artifacts that carried the old version are re-checked:

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/gate.mjs" verify --artifact "$CAREER_HOME/outputs/reports/<id>.md"
```

Anything already sent is history and stays as it is. There is no correction send, ever. Report the
discrepancy to the user and let them decide what, if anything, happens next.

## Guardrails

- **Never hand-edit a derived file.** If a rendered CV is wrong, the knowledge base is wrong or the
  theme is wrong. Fixing the output fixes it once and hides the cause.
- **Never write a fact the user did not state.** Not a rounded number, not a title upgraded to its
  common form, not a technology implied by another one.
- **Never delete a gap to make a section look stronger.** The gaps section is what makes the rest
  credible.
- If the previewer is running, changes land in the same file it has open. Tell the user to reload
  rather than letting an optimistic-concurrency 409 surprise them mid-edit.

## Finish

Say what changed, which surfaces were regenerated, how many `[[FILL]]` markers remain, and whether
any already-written report now contradicts the knowledge base.
