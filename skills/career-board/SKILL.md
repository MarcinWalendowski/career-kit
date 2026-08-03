---
name: career-board
description: Build the job board, a single filterable HTML page of every role in the pipeline with its real status, and read the reader's shortlist and skip verdicts back into the job records. Use when the user says "show me the board", "open the job board", "what have I got", "let me go through the list", "triage these roles", "which ones have I already applied to", or has more roles than fit in a chat window.
---

# The board

One page, every role in `jobs/`, sorted by what needs a person first. `career-review` answers "what
needs me today" in prose; this answers "what is in the pipeline" as a table somebody can sit and read
through. At three hundred rows the prose version stops being usable and this one starts.

It writes `outputs/board.html` and nothing else. Shortlist and skip are verdicts recorded while
reading. **Neither sends anything**, and there is no path from this skill to the gate.

## 1. Build it

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/board.mjs"
```

Prints the path and the headline counts. `--json` gives the same numbers machine readable, `--out`
puts the page somewhere else. Tell the user the path and let them open it; do not try to open a
browser for them.

Run `engine/db.mjs rebuild` first when the workspace has a `career.db`. The board reads the
human-owned stage out of it (rejected, interview, on hold), and a stale database shows an old stage
next to fresh machine status.

## 2. Read what it says about itself

Two lines of the output are about the board's own coverage, and both matter more than the counts:

**`board: no career.db ...` or `node:sqlite is not available ...`** means the human-owned column was
not read. The page prints the same warning at the top. Repeat it to the user rather than presenting
the stages as complete: a row will read "applied" for a role they typed "rejected" against.

**`N job record(s) could not be read`** means those rows are in no count on the page. Name the files.
A board that quietly holds fewer roles than the jobs directory is worse than one with a bad row in
it, because nothing tells you to go and look.

## 3. What the states mean

Derived from `jobs/<id>.json`, the open leases and `career.db`, in that order of authority. Never
from the browser: a board that only knew what the reader had clicked once showed an
already-submitted application as untouched work, with a live apply button on it.

| State | Means |
|---|---|
| **needs you** | A send that failed, or a lease that expired mid-flight. The only rows that rot. |
| **sent, unproven** | Out on a receipt-required channel with no receipt. Somebody has to check the Sent folder. |
| **in flight** | Claimed right now, inside its lease window. |
| **drafted** | Written, not sent. The gate has not been called. |
| **shortlisted** | Screened in by a human, waiting for a draft. |
| **new** | Discovered by an adapter, not yet judged. |
| **applied** | Sent, with a transport timestamp or a receipt behind it. |
| **skipped** | Screened out. Kept visible on purpose: a row that disappears reads as new next time. |

A human-typed stage from `career.db` outranks all of them and is shown next to the state.

## 4. Coverage is a property of the company

Every row also carries what its *siblings* are doing, and this is the part worth explaining to the
user when they ask why a button is dead:

- **company applied** or **company parked**: another posting at that company already has an
  application out, or has one abandoned mid-form. The shortlist button is off, with the reason on
  the tooltip.
- **company drafted**: a warning only. Nothing has gone out, and choosing between two roles at one
  employer is a normal thing to be doing.

This exists because of a real duplicate near-miss. A company had one application parked at a question
only the owner could answer, and the same company's second posting, scraped from a different board,
rendered as fresh work. Applying to it would have spent that company's single application on a
duplicate. Enforcement of the actual limit still lives in `rules.yaml: company.maxApplications` and
the gate; the board's job is to stop the row from *looking* available.

## 5. Read the verdicts back

The reader's shortlist and skip live in their browser until they press **export verdicts**, which
downloads `board-verdicts.json`. Then:

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/board.mjs" apply --verdicts ~/Downloads/board-verdicts.json --dry-run
node "$CLAUDE_PLUGIN_ROOT/engine/board.mjs" apply --verdicts ~/Downloads/board-verdicts.json
```

Always dry-run first and show the user what would change. `apply` moves records between
`discovered`, `screened` and `skipped` and stamps a dated `board-verdict` line into the record's
evidence. It cannot move a record any further than that: drafting, claiming and sending belong to the
gate, and a button in a browser is not a gate.

**Report every refusal.** They are printed on stderr, one per line, and each one is a fact the user
wants:

- an id with no job record, usually a stale export from before a rename;
- a record already past the board's three statuses;
- a shortlist at a company that is already spoken for.

Do not re-run with different arguments to make a refusal go away, and do not edit the verdict file to
get a row through. The importer re-checks the company rule precisely because an exported file can be
edited by hand.

## 6. Hand off

The board ends at a shortlist. What happens next is somebody else's skill:

- a shortlisted role the user wants to pursue goes to **career-tailor** for a match report;
- **career-apply** owns every step after that, and is the only skill with a route to a send;
- **career-sources** refills the board;
- **career-review** is the prose companion when the question is "what needs me today" rather than
  "what have I got".

## Guardrails

- Never present the board as complete when the run said it could not read `career.db` or a job record.
- Never describe a shortlist as an application. Nothing on this page has been sent.
- Never work around a refusal from `apply`. Report it and let the user decide.
- A count is not a conclusion. Two hundred new rows is a scraping result, not progress.
