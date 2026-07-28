---
name: career-apply
description: Send or draft a job application through the gate. Compiles the brief from the workspace, runs the dedupe and identity checks, claims a lease so no second agent can act on the same target, performs the send or the form submit, and records the result. The only skill with a path to an irreversible action. Use when the user says "send it", "apply to this one", "submit the application", "draft the email for X", or approves a draft that career-tailor produced.
---

# Apply, through the gate

Every irreversible action in this product goes through `engine/gate.mjs`. There is no other path. If
the gate blocks, the answer is to stop and report, never to work around it.

Exit codes, everywhere: **0** allowed, **2** usage error, **3** blocked. JSON on stdout, notes on
stderr.

## 0. Compile the brief

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/render.mjs" --target brief
```

Writes `$CAREER_HOME/outputs/brief.md` from `profile.yaml` + `rules.yaml` + `voice.md` +
`knowledge-base.md`, using `references/brief-template.md` as the skeleton. **Read it before writing
a word.** It is the contract for this send, and it is generated, so a user who edits `voice.md` or
`rules.yaml` sees the brief change without anyone editing a skill.

## 1. Check

The dedupe check has two sources and they must agree: the ledger is the index, the Sent folder is
ground truth. Query the mail account for the company domain **and any alternate brand domain**,
count the results, then pass the count and the exact query you ran.

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/gate.mjs" check \
  --id "$ID" --channel "$CHANNEL" \
  --sent-check "$COUNT" \
  --sent-check-query "in:anywhere to:$DOMAIN" \
  --identity-domain "$DOMAIN" \
  --draft "$CAREER_HOME/drafts/$ID/message.md"; echo "exit=$?"
```

`--sent-check` is required, and omitting it blocks with `sent-check-missing` rather than passing. An
unknown count is a block, not a pass. **Never pass a number you did not measure**, and never pass
`0` because a search errored. If the mailbox is unreachable, that is a stop.

`--draft` is how `content.banned_characters` and `banned_phrases` get enforced. **Without it the
content rules do not run at all** and `banned-content` can never fire. Pass the draft whenever one
exists on disk, which after `career-tailor` it does. If you are checking before a draft exists,
check again with `--draft` once it does, and before you claim.

## 2. Claim, immediately before acting

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/gate.mjs" claim \
  --id "$ID" --channel "$CHANNEL" --route "$ROUTE"; echo "exit=$?"
```

Returns `{token, expires_at}` on exit 0.

**Claim immediately before the action, not at the top of the task.** Do the research, write the
draft, get the approval, and only then claim. The gap between the check and the act is the entire
window in which a duplicate is born, which is why `record` rejects a token older than
`rules.yaml: lease.seconds` and blocks with `stale-token`. The freshness rule is measured, not
requested.

If the token expires because a step took longer than expected: release it, redo the check, claim
again. Do not act on an expired token and do not ask for a longer lease.

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/gate.mjs" release --id "$ID" --channel "$CHANNEL" \
  --token "$TOKEN" --reason "draft needed another pass"
```

## 3. Act

Only after `claim` exits 0, and only in the channel that was claimed.

**Email.** Send from `profile.yaml: mail.account`, passed explicitly. It is usually not the mail
tool's default account, and an application sent from the wrong address cannot be taken back. Attach
the CV that `career-tailor` decided on, with a filename a human would want in their downloads
folder. Keep the message inside `rules.yaml: content` limits.

**Form or ATS.** Open the claimed `--route` in a **new** tab. A tab already parked on your target is
a stop signal, not a tab to reuse (see below). Fill every field from the sources named in step 4,
upload the CV, submit, then capture a receipt.

Never trigger a JavaScript `alert` or `confirm` dialog; it wedges the browser tooling mid-submit,
which is the worst possible moment.

If a required field cannot be answered honestly, do not answer it creatively. Release the lease,
record `status: failed` with what blocked you, and report.

## 4. Every identity answer is read, never decided

Work authorization, relocation, visa sponsorship, notice period, salary expectation, start date:
**read from `profile.yaml`.** Do not reason about them, do not soften them to fit the posting, do
not decide "willing to relocate" because the role is onsite.

This is not tidiness. One company received two applications for the same role seven minutes apart
with contradictory answers to the same relocation question, because two agents each decided in the
moment. Neither was wrong on its own reasoning. Two agents reading the same file cannot disagree.

If `profile.yaml` has no answer for a field the form requires, stop and ask the user. Then the answer
goes into `profile.yaml`, not just into this form.

## 5. Record, before you report

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/gate.mjs" record \
  --id "$ID" --token "$TOKEN" --status sent \
  --sent-at "$TRANSPORT_TIMESTAMP" --sent-at-source transport \
  --message-id "$MESSAGE_ID" --subject "$SUBJECT" \
  --receipt "$RECEIPT_PATH"; echo "exit=$?"
```

- **Write the record first, report second.** A send that is not recorded is a future double-send,
  and the moment after a successful send is exactly when a process is most likely to be interrupted.
- `--sent-at` comes from the transport: the mail server's timestamp, the confirmation page. Never a
  local clock. `--sent-at-source client` is rejected, and a timestamp more than
  `rules.yaml: clock.skewSeconds` in the future blocks with `clock-skew`. That catches the common
  case of a local wall-clock time labelled `Z` in a zone that is not UTC.
- `--receipt` is required for every channel in `rules.yaml: receipts.required_channels`. Without one
  the record lands as `sent-unverified` with `needs_human: true` and shows up in `career-review`
  until a human confirms it.
- **A screenshot in a temp directory is not a receipt.** Write it to a real path first; the gate
  copies it into `outputs/receipts/<id>/`. A path under a system temp directory is reaped, and the
  only proof a form submit ever happened goes with it.
- A second `record` for the same id exits **2**. That is a usage error saying the flow already
  recorded this send, and it wants a look at the ledger, not a `--force` flag.

## Blocks: what each one means and what to do

Exit 3 is a stop. **Never retry a blocked command with different arguments to get a pass.**

| Reason | What it means | Do |
|---|---|---|
| `pending-elsewhere` | Another process holds a lease on this exact target right now, with its pid, host and time | **Stop and ask.** Another actor is mid-flight on your target. This is not a routing detail |
| `stale-lease` | A previous run crashed between acting and recording | Somebody looks at the Sent folder, then `gate resolve --outcome sent\|not-sent`. It never self-heals |
| `stale-token` | The claim is older than `lease.seconds` | Release, re-check, re-claim. Do not act on it |
| `sent-check-missing` | `--sent-check` was omitted | Run the Sent-folder query, pass the real count |
| `already-sent` | The ledger or the Sent folder already has this company | Stop. There is no correction send and no follow-up, ever |
| `company-cap` / `cooldown` | `rules.yaml: company` limits | Stop. Report the cap and the date it lifts |
| `identity-mismatch` / `identity-unknown` | The posting does not belong to the company in the record | Stop. Re-run `career-sources`, the route is wrong |
| `role-excluded` | The title is in `roles.deny` | Stop. Do not substitute a different req at the same company |
| `mode-draft` | The workspace is in `draft` mode | Correct behaviour. Leave the draft, tell the user the one line in `rules.yaml` |
| `channel-not-autopiloted` | `mode: autopilot` but this channel is not in `autopilot_channels` | Fall back to review: show the draft, get a yes |
| `quota` / `min-gap` | Daily cap or spacing | Stop for now, say when the next slot opens |
| `receipt-missing` | A receipt channel with no `--receipt` | Capture one, or accept `sent-unverified` deliberately |
| `banned-content` | The draft trips `content.banned_characters` or `banned_phrases` | Rewrite the draft, not the rule |

A blocked run still ends in a report to the user: which target, which reason, what the gate said.
Blocks are written to the ledger too, because a gate that only records successes cannot tell you it
is working.

## The one-contact rule

One application per company, ever, unless `rules.yaml` says otherwise. **No follow-up email, no
correction email, no second send.** If the first send was wrong (wrong role, wrong name, a typo),
record what happened in the job record's `incidents[]` and report it. A correction reads as noise
from someone who does not check their work, and it turns one good impression into two mediocre ones.
Whether anything else goes out is the user's call, not the pipeline's.

## Finish

Report: company, role, channel, route, status, transport timestamp, subject or confirmation id,
receipt path, and the exact body that was sent. If the gate blocked, report the reason verbatim.
