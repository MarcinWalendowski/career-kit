---
name: career-inbox
description: Match inbound mail to the applications that produced it, classify each message as a human reply, an auto-acknowledgement or a rejection, log the event and move the pipeline stage. Threads by In-Reply-To and References against the stored message_id, not by guessing from the subject. Use when the user says "check for replies", "did anyone get back to me", "scan my inbox", "any news on my applications", or on a routine sweep of the pipeline.
---

# Match inbound mail to applications

The piece that closes the loop. Without it a reply sits unread while the pipeline tool reports
nothing waiting - which is exactly what happened for fifteen hours, with a real reply from a real
company in the inbox the whole time. A pipeline that only tracks outbound is a list, not a pipeline.

**This skill never sends anything.** It reads, classifies, logs and stages. Drafting and sending a
reply is a separate, gated decision (see the last section).

## 1. Build the index

Read every `$CAREER_HOME/jobs/*.json` with a non-null `message_id`. That RFC822 Message-ID is the
join key. Keep the company `domains[]` alongside it as a weaker fallback.

## 2. Fetch and match

Pull recent inbound mail on `profile.yaml: mail.account`. For each message, in this order:

1. **`In-Reply-To` contains a stored `message_id`.** Certain match. Take it.
2. **`References` contains a stored `message_id`.** Certain match, one hop further down a thread
   that has picked up other participants. Take it.
3. **Sender domain matches a record's `domains[]`.** Probable match, and probable is not certain.
   Attach it, mark the match as `by-domain`, and say so in the log entry. A shared ATS domain sends
   mail on behalf of many companies, so this route mislabels.
4. **No match.** Leave it alone. Do not attach a message to an application because the subject line
   looked close. An unmatched reply reported as unmatched is useful; a reply filed against the wrong
   company is worse than one nobody filed.

Header names are case-insensitive and both headers can hold several angle-bracketed ids. Parse all
of them, compare on the id inside the brackets.

## 3. Classify

| Class | Signals | Stage |
|---|---|---|
| `auto-ack` | Arrives within minutes of the send, `no-reply` / `donotreply` sender, ATS boilerplate ("we have received your application"), `Auto-Submitted` or `X-Auto-Response-Suppress` header, no named human | stage unchanged |
| `rejection` | "not moving forward", "decided to proceed with other candidates", "will not be progressing", often from `no-reply` and often days later | `rejected` |
| `reply` | A named human, a question, a request for times, an interview link, anything that expects an answer | `replied` |
| `other` | Newsletters, job alerts, anything not about this application | ignore, do not log |

When the signals disagree, classify as `reply`. The cost of treating an auto-acknowledgement as a
reply is one wasted glance. The cost of treating a real reply as an auto-acknowledgement is the
fifteen hours above.

An auto-acknowledgement is still worth logging: it is the only independent evidence that a send
landed at all, and it is what promotes a `sent-unverified` record on a form channel.

## 4. Log the event and move the stage

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/inbox.mjs" scan --since "<iso8601>"
node "$CLAUDE_PLUGIN_ROOT/engine/log.mjs" in "$ID" "<one-line summary>" \
  --channel email --message-id "<inbound message-id>"
node "$CLAUDE_PLUGIN_ROOT/engine/log.mjs" stage "$ID" replied
node "$CLAUDE_PLUGIN_ROOT/engine/log.mjs" next "$ID" "<what has to happen>" --due <YYYY-MM-DD>
```

The summary is one line a human can scan. The full body already exists in the mailbox; do not copy
it into the log. Set a next action on every `reply`, with a due date. A reply with no next action is
how the fifteen hours happen a second time.

Stage and next action are human-owned columns. `db.mjs rebuild` never overwrites them, which is why
they are written through `log.mjs` and not into the job record.

## 5. Report

Say, per application: what arrived, how it was classified, what the stage is now, and what the next
action is. Then say plainly what needs an answer today. That sentence is the entire point of the
skill.

## Replying

A reply to a live thread is an outbound message, so it goes through the gate like any other:

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/gate.mjs" claim --id "$ID" --channel email
# send
node "$CLAUDE_PLUGIN_ROOT/engine/gate.mjs" record --id "$ID" --token "$TOKEN" --status sent \
  --sent-at "<transport timestamp>" --sent-at-source transport --message-id "<id>"
```

Draft it into `$CAREER_HOME/drafts/<id>/reply-<n>.md` in the voice from `voice.md`, where replies are
their own length band and are much shorter than a cold message. Do not pad a reply into a pitch.

Two things this skill must never do on its own: send an unprompted follow-up when nobody replied
(`rules.yaml: company.followups_allowed` is the setting, and it is off by default), and send a
correction to a message already delivered. Both are the user's call, and the gate blocks them.
