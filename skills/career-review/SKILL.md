---
name: career-review
description: Read the state of the job-search pipeline and say what needs a human. Produces a digest, a todo list of applications waiting on a reply, and a weekly report, and surfaces the things that fail quietly - unverified sends, stalled leases, untraced claims in drafts, and next actions that went stale. Use when the user says "where am I", "what's my pipeline", "what do I need to do today", "weekly review", "any applications stuck", or asks how the search is going.
---

# Review the pipeline

Read-only. This skill writes nothing except a report the user asked for, and it never touches the
gate beyond `status`, `leases` and `verify`.

## 1. Rebuild and read

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/db.mjs" rebuild
node "$CLAUDE_PLUGIN_ROOT/engine/log.mjs" show
node "$CLAUDE_PLUGIN_ROOT/engine/log.mjs" todo
node "$CLAUDE_PLUGIN_ROOT/engine/gate.mjs" status
node "$CLAUDE_PLUGIN_ROOT/engine/gate.mjs" leases
```

`rebuild` refreshes machine-owned columns from `jobs/*.json` and **never** touches the human-owned
ones: stage, priority, salary expectation, next action, notes. Those were typed by a person and a
rebuild that overwrote them would quietly delete the only judgement in the database.

It also reports orphans: a database row whose `jobs/<id>.json` has disappeared. Report them, never
silently keep or drop them. An orphan is usually a rename, occasionally a deletion someone regrets.

## 2. Surface the four things that fail quietly

Everything below is invisible on a happy-path dashboard, which is why it gets its own pass.

**`sent-unverified` and `needs_human: true`.** A send that went out on a receipt-required channel
with no durable receipt. Nobody knows whether it landed. List each one with its target and date and
say plainly that the only fix is a human checking the Sent folder or the company's confirmation
mail. These do not age out.

**Open leases.** `gate leases` prints every lease with its age. A lease older than
`rules.yaml: lease.seconds` means a run crashed between acting and recording. It does **not**
self-heal, by design: auto-expiry would reopen the double-send window on exactly the failure it
exists to catch. **Somebody has to go and look at the Sent folder**, then:

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/gate.mjs" resolve --id "$ID" --channel "$CH" \
  --outcome sent --evidence "<what you saw in the Sent folder>"
```

`--outcome sent` records it with `needs_human`, `--outcome not-sent` clears the lease. Name the
person who has to look; a stalled lease reported without an owner stays stalled.

**Untraced claims.** For any draft not yet sent:

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/gate.mjs" verify --artifact "$CAREER_HOME/drafts/<id>/message.md"
```

Report `untraced_count` and the flagged sentences. It is a flagger, not a prover: false positives on
paraphrase are expected, and a fabrication phrased in knowledge-base vocabulary slips through. Show
the flags, do not silently clear them, and do not present a clean run as proof of accuracy.

**Stale next actions.** Anything with a due date in the past, and anything at stage `replied` with
no next action at all. The second group is the dangerous one: it looks fine in every column.

## 3. Blocks are signal

`gate status` includes recent blocks from the ledger. Read them as a pattern, not as noise. Repeated
`quota` or `min-gap` blocks mean the caps are set below the way the user actually works. Repeated
`identity-mismatch` means route resolution is picking up the wrong boards. Repeated
`sent-check-missing` means an agent is skipping the Sent-folder query.

A gate that only recorded successes could not tell you any of this, which is why blocks are logged.

## 4. The digest

Lead with what needs a human today, then the numbers. In this order:

1. **Needs you now** - replies waiting on an answer, overdue next actions, stalled leases.
2. **Needs checking** - `sent-unverified` records, untraced claims in unsent drafts, orphan rows.
3. **In flight** - counts by stage, and what moved since the last review.
4. **Ready to go** - drafted, gate-clear, waiting on a send.
5. **Capacity** - today's quota use against `rules.yaml: limits`, and when the next slot opens.

## Weekly report

Same sections plus: applications sent this week by channel and source, stage transitions, reply rate
and rejection rate over the applications old enough to have answered, and which sources produced the
targets that actually replied. That last number is the one worth acting on: it says where the next
week's effort goes.

Keep it to something readable in a minute. A weekly report nobody finishes is a weekly report that
changes nothing.

## Guardrails

- Report a stalled lease as stalled. Do not release one to make the digest look clean.
- Never edit a human-owned column to reconcile it with a machine one. If they disagree, say so.
- A count is not a conclusion. Zero replies after five applications is not a signal, and saying so
  is more useful than a trend line drawn through it.
