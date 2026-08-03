# Career Kit OS

A job search that runs as a pipeline instead of a to-do list.

Career Kit is a Claude Code plugin. It keeps one knowledge base as the source of
truth for every career artifact you have, tailors an application per role,
enforces the rules you set in code rather than in prose, pulls postings from ten
sources, puts the whole pipeline on one filterable page, and gives you a local
previewer to edit the result in.

It is open source, MIT, with no paid tier and no hosted anything.

---

## Install

```
/plugin marketplace add MarcinWalendowski/career-kit
/plugin install career-kit@career-kit
```

Then, in Claude Code, one command for everything:

```
/career
```

That is the whole interface. With no workspace it onboards you in the
conversation: it asks for your CV, fills the gaps it could not read from it,
and provisions everything in one call. With a workspace it reads the pipeline
and does what you asked for. There is nothing else to run and no order to learn.

Node 20 or later, and nothing else: the engine has **zero runtime
dependencies**. That is a constraint, not a boast. It is what lets setup work on
a fresh machine, and it keeps a supply chain out of a tool that reads your Sent
folder and submits forms under your name.

**A mail tool is optional.** A new workspace starts in `draft` mode, which never
touches a mailbox. Everything is written, nothing is sent. Mail becomes
load-bearing only when you move to `review`. If you want it, one line adds a
local IMAP/SMTP server with no browser and no OAuth:

```
claude mcp add email-local -- npx -y email-local-mcp
```

On macOS you can install it with Homebrew instead, if you would rather have a
real binary than an `npx` fetch:

```
brew install marcinwalendowski/tap/email-local-mcp
claude mcp add email-local -- email-local-mcp
```

---

## Three layers, and your data is not in this repo

| Layer | Where it lives | What is in it |
|---|---|---|
| **Plugin** | this repo, public | 9 skills, the node engine, the board, the previewer, the extension, templates |
| **Workspace** | `$CAREER_HOME`, default `~/career`, private, its own git repo | your profile, rules, voice, knowledge base, CV, job records, drafts, receipts |
| **Live data** | wherever your existing files already are | untouched. Nothing moves out from under work in flight |

**Your data never enters this repo.** Not by convention, by construction: the
engine resolves `$CAREER_HOME` in exactly one place, this repo's `.gitignore`
excludes the workspace filenames outright, and the workspace ships with its own
`.gitignore` so that if you ever push your private workspace by accident, what
goes public is a skeleton and not other people's phone numbers.

The workspace is separate for a second reason. Under plugin distribution the
plugin lives in `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`,
which is installer-owned and replaced on every version bump. State kept beside
the code is destroyed by an update.

---

## Quickstart

```
/career                             # onboards you, then runs everything after that
```

Then just say what you want, in the same command:

```
/career find me founding engineer roles, remote
/career should I apply to this?  <paste a job posting>
/career show me the board
/career where am I
```

You start in `draft` mode: everything is written, nothing is sent. Read a few
drafts you actually agree with before you change one line.

---

## The gate

Every irreversible action goes through `engine/gate.mjs`. Exit 0 allowed, exit 3
blocked, exit 2 usage error. The skills have no other route to a send.

1. **`review` is the default mode**, because a form submit has no Sent folder,
   no receipt by default and no undo. The first bad run is not a bug report, it
   is your reputation.
2. **Autopilot needs two edits, not one:** `mode: autopilot` in `rules.yaml`
   *and* the channel named in `autopilot_channels: [email]`. Email and an ATS
   form have different blast radii, so you can trust one without the other.
3. **`claim` writes the intent before the action**, with an atomic exclusive
   create. A second agent claiming the same target gets `EEXIST` and blocks.
4. **A claim token expires** (default 10 minutes), so "re-check immediately
   before acting" is enforced by the clock instead of asked for in prose.
5. **A crash stalls the next attempt, on purpose.** An expired lease does not
   self-heal; it blocks and demands `gate resolve --outcome sent|not-sent`,
   which makes somebody go look at the Sent folder.

Dedupe takes the Sent-folder result as a required argument, so omitting it
blocks rather than passes. Blocks are written to the ledger too: a gate that
only records successes cannot tell you it is working.

---

## Ten job sources

**Tier 1, public JSON, no auth, no browser:**

1. Greenhouse
2. Lever
3. Ashby
4. SmartRecruiters
5. Recruitee
6. Workable
7. Hacker News "Who is hiring", via the Algolia API. The best source for
   founding-engineer roles that never reach an ATS
8. Remote aggregators: RemoteOK, Remotive, Arbeitnow, Himalayas

**Tier 2, user-initiated capture through the Chrome extension:**

9. **LinkedIn.** The extension reads the results list you are already looking
   at. No auto-scroll, no pagination, no scheduled runs, nothing leaves the
   machine. That framing is what keeps it defensible, and if it ever stops being
   defensible the adapter is removed rather than weakened.
10. YC Work at a Startup, justjoin.it, NoFluffJobs, pracuj.pl. Login-gated or
    without a documented public API, so they go through the same path.

Deferred, with reasons: Workday (per-tenant POST, worth an adapter later),
Indeed (partner-only since the API shutdown), Wellfound (no API).

Route resolution does not stop at the posting. It walks the company homepage,
`/careers`, `/jobs`, an ATS link scan, board-slug probing and the sitemap, and
ends with a confidence score. A low score plus a company-identity mismatch is a
block, not a warning: shared ATS slugs genuinely do resolve to a different
company than the one you meant.

---

## The board

One page, every role in the pipeline, sorted by what needs a person first.
`career-board` writes `outputs/board.html`: filter by state, source, workplace or
text, sort by what is posted, and record a shortlist or a skip on each row as you
read. Nothing on it sends anything.

**A row's status is derived from the record of what happened, never from the
browser.** That sounds obvious and it is the bug this page was rebuilt to fix. A
board that only knew what the reader had clicked showed an already-submitted
application as untouched work, with a live apply button on it. So the states come
from the job records, the open leases and `career.db`, in that order of
authority, and a stage you typed yourself outranks anything the page can derive.

**Coverage is a property of the company, not of the row.** A company had one
application parked at a question only its owner could answer, and the same
company's second posting, scraped from a different board, rendered as fresh work.
Applying to it would have spent that company's single application on a duplicate.
Every row therefore carries what its siblings are doing: *company applied*,
*company parked*, *company drafted*. The first two turn the shortlist button off
and say why; the third is a warning, because choosing between two roles at one
employer is a normal thing to be doing.

Skipped rows stay on the page, struck through. A row that disappears when you
reject it reads as new on the next pass, and you judge it again.

The page cannot write to your workspace, so verdicts live in the browser until
you export them:

```
engine/board.mjs                                   write outputs/board.html
engine/board.mjs apply --verdicts <file> --dry-run  what it would change
engine/board.mjs apply --verdicts <file>            move records: discovered, screened, skipped
```

`apply` moves records between those three statuses and no further. Drafting,
claiming and sending belong to the gate, and a button in a browser is not a gate.
It re-checks the company rule on the way in, because an exported file can be
edited by hand, and it names every row it refuses rather than dropping it
silently.

When it cannot read something it says so on the page: no `career.db` means the
stages shown are machine status only, and an unreadable job record is reported by
name rather than quietly missing from the counts.

## The previewer

A local web app on `127.0.0.1`, started with `career-serve`. Knowledge-base
source beside the rendered CV, click a bullet to edit it in place, per-section
notes, an audience switch, PDF export.

The difference from a static preview is that **it writes back to disk**. You and
Claude edit the same files, and version history is git commits in your workspace
rather than a browser's local storage.

Loopback is not authentication, so: bound to `127.0.0.1` only, a per-boot token
required on every `/api/*` call, the `Host` header checked against DNS
rebinding, and `/api/ingest` restricted to the extension's origin.

Generated artifacts are linted before they are written. The renderer refuses to
emit hidden text: `display:none`, `visibility:hidden`, zero opacity, zero
font-size, off-screen positioning, and foreground equal to background. That is a
policy in code rather than a judgement call, because the request to hide
keyword-stuffed text from a human reader and show it to an automated screener
will be made again, to an agent that does not remember declining it the first
time. To make something print-only or screen-only, use the `data-print-only` and
`data-screen-only` attributes, which the renderer strips from the DOM. Absent
text is honest; invisible text is not.

---

## Limitations

Read these before you install.

- **It needs Claude Code.** The skills are Claude Code skills. The engine is a
  plain node CLI you can drive yourself, and the previewer stands alone, but the
  product as described assumes Claude Code. That narrows the audience to
  developers and we know it.
- **The honesty floor is a flagger, not a prover.** `gate verify` flags claims
  in a tailored artifact that do not trace back to a knowledge-base line, by
  token overlap. It produces false positives on paraphrase and it will miss a
  fabrication phrased in your own vocabulary. It is a review aid. It is not a
  guarantee that your CV is true.
- **Adapters break when boards change their schema.** Contract tests against
  recorded fixtures make that fail loudly instead of silently returning zero
  jobs, but a broken adapter is a matter of when.
- **The board does not rank roles.** It has no fit score, because scoring one
  needs your knowledge base read against a full job description, which is
  `career-tailor`'s job and costs a model call per posting. The board sorts by
  what needs a person and by what the posting states; it will not tell you which
  of two roles you are a better match for.
- **PDF export needs headless Chrome** on the machine. HTML and Markdown export
  do not.
- **It sends mail as you, from your account.** Caps are on by default and the
  first-run mode is `draft`, but a bug here costs you a first impression you
  cannot get back.
- **Voice derivation reads your Sent folder.** With explicit consent, locally,
  and the derived file is yours to edit. `career-setup` states what it will read
  before it reads it.
- **Form autopilot is the highest-liability surface here.** It ships off. The
  lease, the freshness token, the receipt requirement, the identity guard and
  the daily cap all exist because it has no undo.

No benchmarks, no multipliers, no user counts. It is a personal system that
worked well enough to be worth handing to someone else.

---

## Granular commands

`/career` routes to nine skills. Each one is directly invocable by name if you
would rather drive the pieces yourself. That is supported, not a fallback.

| Skill | What it does |
|---|---|
| `career-setup` | Provisions `$CAREER_HOME`, imports an existing CV or LinkedIn export into a first knowledge base with `[[FILL]]` markers, derives `voice.md` from your own Sent folder with explicit consent, sets the mode, runs a health check |
| `career-kb` | The only write path for facts. Edits the knowledge base, then regenerates every derived surface |
| `career-sources` | Pulls roles from the adapters, resolves the real apply route, runs the identity check, writes `jobs/<id>.json` |
| `career-tailor` | Job description in, match report out, against what your knowledge base actually supports |
| `career-apply` | Drafts the application and puts every irreversible step through the gate |
| `career-inbox` | Matches replies to a stored `message_id`, classifies reply against auto-ack against rejection, moves the stage |
| `career-review` | Pipeline digest, what is overdue, a weekly report |
| `career-board` | Every role on one filterable page with its real status, and the shortlist you record on it read back into the job records |
| `career-serve` | Starts the local previewer on `127.0.0.1`, which edits the knowledge base and never a rendered file |

The engine underneath is a plain node CLI with no dependencies, so you can drive
it without an agent at all:

```
engine/init.mjs      provision a workspace; idempotent, never overwrites
engine/doctor.mjs    the whole state in one call; 0 ready, 1 homework, 2 none
engine/gate.mjs      status, check, claim, record, release, resolve, leases, verify
engine/render.mjs    knowledge base + theme -> HTML, Markdown, PDF
engine/board.mjs     the whole pipeline as one page; apply reads its verdicts back
engine/serve.mjs     the previewer
```

---

## Repo layout

```
.claude-plugin/   marketplace.json + plugin.json. This repo is both.
commands/         /career, the one front door
skills/           9 skills, each directly invocable
engine/           node ESM, zero dependencies
previewer/        local web app, served by engine/serve.mjs
extension/        MV3 Chrome extension, no build step
templates/        profile, rules, voice, knowledge-base scaffold, CV themes
test/             negative-control tests
```

Start with `templates/rules.example.yaml`. Every rule in it carries a one-line
reason, because a rule with no stated reason gets deleted by the next person who
finds it inconvenient.

## Licence

MIT. See `LICENSE`.
