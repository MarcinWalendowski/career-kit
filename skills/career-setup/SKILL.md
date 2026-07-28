---
name: career-setup
description: Provision a Career Kit workspace at $CAREER_HOME. Creates the directory, runs git init, copies the templates, imports an existing CV or LinkedIn export into a first knowledge base, derives a voice file from the user's own Sent folder with explicit consent, sets the mail account, picks the mode, and runs a health check. Use when the user says "set up career kit", "I just installed the career plugin", "create my career workspace", "onboard me for job hunting", or when any other career skill exits 2 with "no workspace found".
---

# Set up a career workspace

This is the **only** skill that may create `$CAREER_HOME`. Every other skill reads a workspace that
already exists and exits 2 if it does not. Never create one as a side effect of something else.

Work through the steps in order and confirm before writing. These files are the user's, they hold
their identity and their voice, and they are the ones an agent will read at send time.

## 1. Pick the location

```bash
echo "${CAREER_HOME:-<unset>}"
```

- `$CAREER_HOME` set: use it. Do not propose an alternative.
- Unset: default to `~/career`. Say the path and get a yes before creating anything.
- If the target already contains `profile.yaml` this is not a fresh setup. Stop, report the path,
  and offer a repair pass instead: run only the steps whose files are missing, and never overwrite.

## 2. Create the directory and a git repo

```bash
mkdir -p "$CAREER_HOME"/{cv,jobs/inbox,drafts,outputs/receipts,outputs/reports}
git -C "$CAREER_HOME" init
cp "$CLAUDE_PLUGIN_ROOT/templates/workspace.gitignore" "$CAREER_HOME/.gitignore"
```

The workspace `.gitignore` excludes the database, the ledger, leases, receipts, drafts and job
records. A user who pushes their workspace by accident pushes a skeleton, not a mailbox. Do not run
`git commit`: the history is theirs to start.

## 3. Copy the templates

```bash
for f in profile rules voice knowledge-base; do
  src=$(ls "$CLAUDE_PLUGIN_ROOT/templates/$f".example.*)
  dst="$CAREER_HOME/$(basename "$src" | sed 's/\.example//')"
  [ -e "$dst" ] || cp "$src" "$dst"
done
```

Then fill `profile.yaml` in one short interview: name, email, phone, location, links, work
authorization per region, relocation, notice period, mail account, CV path.

Say why while you ask. Every field in `profile.yaml` is an answer some application form will demand
later. Answering once, here, is what stops two agents on two different days giving one company
contradictory answers to "would you relocate". That has happened, to the same job posting, seven
minutes apart. Nothing in this file is decided at send time.

## 4. Import an existing CV or LinkedIn export

Ask for one of: a CV file (PDF, DOCX, Markdown), a LinkedIn data export, or nothing at all.

Extract what is there into `$CAREER_HOME/knowledge-base.md` and write `[[FILL]]` wherever a section
exists but the source did not supply it. An honest gap marker is worth more than a plausible
sentence, because everything downstream treats this file as fact.

Full extraction rules and the section list: `references/import.md`.

## 5. Derive `voice.md`, with consent asked before anything is read

A derived voice file is the highest-value artifact in the workspace and the one that reads private
mail to produce. **Say exactly what will be read before reading it.** Name the account, the folder,
the number of messages and the fact that nothing leaves the machine. Then wait for a yes.

Offer the decline path in the same breath, not as a fallback after a refusal: a template `voice.md`
plus a short set of questions produces a usable file with no mail access at all.

Whichever path runs, write the **Provenance** section: source, date, method, sample size, reviewer.
It is not decoration. A voice file with no provenance gets overwritten by the next agent that thinks
it knows better, and the reason a good one is valuable is that it records what it cost to learn.

Consent script, extraction method, the question set for the decline path, and the provenance block:
`references/voice-derivation.md`.

## 6. Set the mail account

Write the sending account into `profile.yaml` under `mail.account`, and confirm it is the account the
user wants recruiters to see. If their mail tool has several accounts, the default is rarely the
professional one, and an application sent from the wrong address cannot be taken back.

## 7. Set the mode, at `draft`

Write `mode: draft` into `rules.yaml`, whatever the template ships. Then tell the user the one line
that moves them up:

```yaml
mode: draft     # draft -> nothing is sent, everything is written to drafts/
                # review -> the gate allows a send after you approve the draft
                # autopilot -> also needs the channel named in autopilot_channels
```

Say the ladder plainly: `draft` writes drafts, `review` sends what the user approved, `autopilot`
sends without a per-send approval and needs a second opt-in naming the channel. A form submit has no
Sent folder and no undo, so `autopilot` on a form channel is the one setting worth reading twice.

## 8. Health check

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/gate.mjs" status
node "$CLAUDE_PLUGIN_ROOT/engine/validate.mjs" --all
node "$CLAUDE_PLUGIN_ROOT/engine/render.mjs" --target html
```

Expected on a fresh workspace: `status` reports `mode: draft`, no open leases and no blocks;
`validate --all` passes over zero job records, which is a valid pipeline; `render` writes a CV and
the hidden-text lint passes. Any non-zero exit here is a setup bug, not a user error - report the
command and its stderr rather than working around it.

## Finish

Tell the user: the workspace path, that it is a git repo they own, which files still hold `[[FILL]]`
markers, where `voice.md` came from, that the mode is `draft`, and the one line to change to reach
`review`. Point them at `career-kb` as the only place facts get edited.
