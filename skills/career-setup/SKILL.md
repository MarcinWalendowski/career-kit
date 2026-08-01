---
name: career-setup
description: Provision a Career Kit workspace and onboard the user in one pass. Runs the single provisioning command, imports an existing CV or LinkedIn export into a first knowledge base, fills the profile from what the import could not answer, derives a voice file from the user's own Sent folder with explicit consent, sets the mode, and runs one health check. Use when the user says "set up career kit", "I just installed the career plugin", "create my career workspace", "onboard me for job hunting", or when any other career skill exits 2 with "no workspace found".
---

# Set up a career workspace

This is the **only** skill that may create `$CAREER_HOME`. Every other skill reads a
workspace that already exists and exits 2 if it does not. Never create one as a side
effect of something else.

**Setup is a conversation with two engine calls in it.** One at the start to provision,
one at the end to check. Everything between them is talking. Do not hand the user a
list of commands to run: if you are about to write "now run X", you are doing the part
that is supposed to be yours.

## 1. Provision, in one call

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/init.mjs"
```

Creates the directory tree, runs `git init`, writes the workspace `.gitignore`, copies
the four templates, and sets `mode: draft`. Prints JSON: `home`, `fresh`, `created[]`,
`existed[]`, `git`, `fill_markers`.

It is **idempotent and never overwrites**, so there is no "is this a fresh setup"
branch to reason about and no repair mode to invoke. `fresh: false` with an empty
`created[]` means the workspace was already there and nothing was touched. Say so and
move to step 2 rather than starting over.

Pass `--home <path>` only if the user names a location. Otherwise `$CAREER_HOME`, then
`~/career`. If `$CAREER_HOME` is unset **and** `~/career` already holds unrelated
files, say the path you are about to use and get a yes first.

The workspace `.gitignore` excludes the database, the ledger, leases, receipts, drafts
and job records, so a user who pushes their workspace by accident pushes a skeleton and
not a mailbox. `init` does not commit: the history is theirs to start.

## 2. Ask for the CV first

**This is the step that makes the rest short, so do it before any interview.** Ask for
one of: a CV file (PDF, DOCX, Markdown), a LinkedIn data export, or nothing at all.

A CV answers most of `profile.yaml` and all of `knowledge-base.md` in one pass. Asking
the identity questions first means asking for things the file you are about to read
already contains, which is how a five-minute setup becomes a twenty-minute one.

Extract into `$CAREER_HOME/knowledge-base.md` and write `[[FILL]]` wherever a section
exists but the source did not supply it. An honest gap marker is worth more than a
plausible sentence, because everything downstream treats this file as fact.

Full extraction rules and the section list: `references/import.md`.

## 3. Fill the gaps, in one interview

Now fill `profile.yaml`, but **only what the import could not answer.** Read what you
extracted, then ask for what is genuinely missing. In practice that is the set no CV
carries:

- work authorization per region, and whether sponsorship is needed
- relocation: the yes/no a radio button gets, and the sentence a free-text box gets
- notice period
- the sending account, and the display name a recipient sees
- anything still marked `[[FILL]]` that a form will demand

Say why while you ask. Every field here is an answer some application form will demand
later, and answering once, now, is what stops two agents on two different days giving
one company contradictory answers to "would you relocate". That has happened, to the
same job posting, seven minutes apart. **Nothing in this file is decided at send time.**

Then read `rules.yaml: roles.allow` and `roles.deny` with the user and adjust them to
their field. **The filter matches contiguous phrases on word boundaries**
(`gate.mjs`: `` new RegExp(`\\b${phrase}\\b`, "i") ``), so `founding engineer` does not
match "Founding Software Engineer".

**Do not trust the shipped list to cover a field it was not written for.** Measured
against the real matcher, the stock `roles.allow` blocks all six of these:

    Site Reliability Engineer     DevOps Engineer
    Principal Engineer            Cloud Engineer
    Distributed Systems Engineer  Systems Engineer

Every one is a title a backend or platform search hits constantly, and each surfaces
later as a `role-excluded` block at the point where the user least expects one. Note
also that "Founding Software Engineer" passes only because the unrelated
`software engineer` entry happens to catch it, not because the list carries both the
short and long forms. It does not. Do not reason from the list's apparent coverage.

So **check the titles the user actually expects**, rather than reading the list and
assuming. Take three or four real postings they would want, and confirm each one
matches an `allow` entry on a word boundary. Add every real-world variant you find
missing. A keyword that "looks close" is not a match.

## 4. Derive `voice.md`, with consent asked before anything is read

**This stop is deliberate. Do not fold it into the flow above.**

A derived voice file is the highest-value artifact in the workspace and the one that
reads private mail to produce. **Say exactly what will be read before reading it.** Name
the account, the folder, the number of messages, and the fact that nothing leaves the
machine. Then wait for a yes.

Offer the decline path in the same breath, not as a fallback after a refusal: a
template `voice.md` plus a short set of questions produces a usable file with no mail
access at all.

Whichever path runs, write the **Provenance** section: source, date, method, sample
size, reviewer. It is not decoration. A voice file with no provenance gets overwritten
by the next agent that thinks it knows better, and the reason a good one is valuable is
that it records what it cost to learn.

Consent script, extraction method, the question set for the decline path, and the
provenance block: `references/voice-derivation.md`.

## 5. Mail is optional. Say so plainly

**Career Kit works with no mail tool at all.** A new workspace is in `draft` mode, and
draft mode never touches a mailbox: everything is written to `drafts/` and the gate
blocks every send channel. Do not present mail as a prerequisite, and do not leave
onboarding half-finished because it is missing.

Check what you are actually holding: your own MCP tool list, not `doctor`'s
`mail.detected`, which is config-file evidence and says so.

- **You have mail tools:** name the account you will send from, confirm it is the one
  the user wants recruiters to see, and write it to `profile.yaml: mail.account`. If
  their mail tool has several accounts, the default is rarely the professional one, and
  an application sent from the wrong address cannot be taken back.
- **You do not:** say the true thing (nothing is blocked in draft mode) and offer the
  one-liner for a local IMAP/SMTP server, which needs no browser and no OAuth:

  ```
  claude mcp add email-local -- npx -y email-local-mcp
  ```

  On macOS, offer the Homebrew form instead if the user has `brew` and would rather
  install a binary than fetch through `npx`:

  ```
  brew install marcinwalendowski/tap/email-local-mcp
  claude mcp add email-local -- email-local-mcp
  ```

  Offer one, not both. Two install paths for an optional component is the kind of
  choice that turns a thirty-second step into a decision, which is the opposite of
  what this setup is for.

  Then move on whether they take it or not. It is genuinely additive: it becomes
  load-bearing at `mode: review`, when `career-apply` needs a real Sent-folder count
  before it will allow a send, and when `career-inbox` starts matching replies.

## 6. Confirm the mode, at `draft`

`init` already wrote `mode: draft`. Your job is not to set it. It is to make sure the
user knows the ladder they are on:

```yaml
mode: draft     # draft -> nothing is sent, everything is written to drafts/
                # review -> the gate allows a send after you approve the draft
                # autopilot -> also needs the channel named in autopilot_channels
```

Say it plainly: `draft` writes drafts, `review` sends what the user approved,
`autopilot` sends without a per-send approval and needs a second opt-in naming the
channel. A form submit has no Sent folder and no undo, so `autopilot` on a form channel
is the one setting worth reading twice.

Tell them to read a few drafts they actually agree with before changing that line.

## 7. Health check, in one call

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/doctor.mjs" --json
```

Exit **0** ready, **1** usable with homework, **2** no workspace. On a workspace that
was just set up, **exit 1 is the expected result**, the knowledge-base scaffold ships
with `[[FILL]]` markers and those are homework, not a fault. Exit 2 here is a setup
bug: report the command and its output rather than working around it.

Read `next` and pass it on. That field is the engine's own answer to "what now", and it
is computed from disk.

## Finish

Tell the user, in a few sentences: the workspace path and that it is a git repo they
own; which files still hold `[[FILL]]` markers; where `voice.md` came from; that the
mode is `draft` and the one line that moves them to `review`; and whether a mail tool
is wired or not.

Then point them at the two things they will use next: **`career-kb`** is the only place
facts get edited, and **`/career`** is the one command for everything else.
