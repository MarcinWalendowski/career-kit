# Contributing

Career Kit is open source with no paid tier. Issues and pull requests are welcome.

## The rules that are not negotiable

These are not style preferences. Each one exists because something went wrong without it, and a
pull request that weakens one will be declined even if it is otherwise good.

**1. Zero runtime dependencies.**
`package.json` has an empty `dependencies` block and it stays empty. This tool reads your Sent
folder and submits forms on your behalf. Every package added is a party you have to trust with that.
It also means `career-setup` works on a fresh machine with nothing but Node.

**2. Every irreversible action goes through the gate.**
No skill, no script and no adapter may send an email, submit a form or post a message except through
`engine/gate.mjs`. Not "should go through": there must be no other path. `career-apply` cannot send
without a token and only `gate claim` mints one.

The reason is measured, not theoretical. The system this was built from enforced its safety rules as
sentences in a markdown file, and one company received two applications for the same role seven
minutes apart, with contradictory answers to the same question. That is a 3% failure rate on the
rule the file called "the single most important". Prose does not hold.

**3. Guards fail closed, and a missing input is a block.**
If the gate cannot measure something it is supposed to check, it blocks. It never passes on the
grounds that the check was unavailable. An expired lease does not silently free; it stalls and asks
a human to look at the Sent folder. Failing toward a stall is the correct direction when the action
has no undo.

**4. Every guard ships with a negative-control test.**
A green suite proves nothing after a removal. For each guard there is a test that removes the input
it depends on and asserts the block. If you add a guard, add its negative control in the same PR. If
you cannot write a test that fails when the guard is deleted, the guard is not real.

**5. `render.mjs` refuses hidden text.**
`display:none`, `visibility:hidden`, zero opacity, zero font-size, foreground equal to background,
off-screen positioning, zero-height overflow-hidden. This exists because embedding text that a human
reader cannot see, aimed at an automated screener, was requested once on a real cover letter. It was
declined as a judgement call at the time. In a product a judgement call is not enough, because a
fork can quietly drop it. It is a policy in code and it is not configurable.

**6. No personal data in this repo.**
Not in templates, not in fixtures, not in test data, not in a doc example. The examples use an
obviously fictional persona. `test/templates.test.mjs` fails on a `/Users/` path or a real name.
Your data lives in `$CAREER_HOME`, which is a separate private repo and is never read by anything
in this one at build time.

**7. No em dash.**
The character is banned in every file, including comments and UI copy. It reads as an AI tell, and
this tool writes on a human's behalf. Re-punctuate rather than reword: a comma, colon, period or a
pair of parentheses almost always does the job.

**8. Capture adapters have no network path.**
`kind: "capture"` adapters parse a payload the user's browser captured from a page they already had
open. No auto-scroll, no pagination, no scheduled runs, no crawling. That framing is the entire
defensibility of the LinkedIn source, so it is enforced structurally rather than promised in a
comment. If it stops being defensible the adapter is removed, not weakened.

## Running the tests

```
node --test test/
```

No install step, because there is nothing to install.

## Adding a job source

1. Copy the shape of an existing adapter in `engine/sources/`. Export `id`, `kind`, `match`,
   `search` and `fetchOne`, and nothing else.
2. Normalise through the shared helper in `engine/sources/index.mjs`. A field you cannot determine
   is `null`, never a guess. A guessed salary band ends up in a negotiation.
3. Record a fixture in `test/fixtures/` and add a contract test that asserts the **normalised**
   record, not the raw payload. That is what makes a board schema change fail loudly instead of
   quietly returning zero jobs.
4. A source returning zero results is reported as a source problem, never as "nothing is hiring".

## Adding a theme

Themes are plain CSS over a fixed class vocabulary, documented in
`templates/themes/default/README.md`. The A4 print rules matter: the one-page fit assertion depends
on them. If you need something visible only in print, use the `data-print-only` attribute the
renderer strips, not CSS that hides.
