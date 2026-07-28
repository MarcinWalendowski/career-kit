# Career Knowledge Base

> **Purpose.** Single source of truth for everything career-facing: CV, LinkedIn,
> profiles, cover letters and per-job tailored applications. Everything else is
> *derived* from this file. Edit facts here first, then regenerate the downstream
> artifacts with `career-kb`.
>
> "Single source of truth" is a claim this file has to earn. It stops being true
> the moment a fact is pasted into a rendered artifact and edited there. If you
> find yourself editing a bullet in an HTML file, that bullet belongs here and
> the HTML belongs in a renderer.
>
> **Conventions.** Three markers, used throughout. Each is explained again where
> it first appears.
>
> - `[[FILL: ...]]` - a fact the setup import could not resolve. It must be
>   filled by a human before anything derived from it is sent. A `[[FILL]]` that
>   reaches a draft is a bug, and the renderer flags it.
> - `⚠️ confirm` - inferred from a repo, a public page or an old CV, and not yet
>   verified by you. Safe to keep here, never safe to claim in an artifact until
>   the marker is removed.
> - `(internal)` - material that must **never** reach an artifact. Activity
>   counts, private context, anything from a source you cannot cite in public.
>   Useful for deciding what to lead with; not a claim you can make.
> - `(public)` - sourced from something a reader can check for themselves.
>   Safe to quote.

---

## 1. Identity and Contact

Facts a form asks for. Keep this consistent with `profile.yaml`; that file is
what a form actually reads, this one is the human-readable record.

| Field | Value |
|---|---|
| Name | `[[FILL]]` |
| Current title | `[[FILL]]` |
| Email | `[[FILL]]` |
| Location | `[[FILL: city, country, and whether you work remote]]` |
| Phone | `[[FILL]]` |
| LinkedIn | `[[FILL]]` |
| GitHub | `[[FILL, if any]]` |
| Portfolio / site | `[[FILL, if any]]` |
| Work authorization | `[[FILL: e.g. EU citizen; US status]]` |
| Languages | `[[FILL: e.g. Polish (native), English (fluent)]]` |

> `[[FILL: ...]]` is a gap, not a placeholder to be guessed. If the import could
> not find your phone number, the correct action is to ask, not to infer one
> from a document that might be five years out of date.

---

## 2. Positioning and Headlines

### Who I am in one line

`[[FILL: one sentence. What you are, not what you use.]]`

### Canonical bio

The version that goes in a LinkedIn "About", a personal site, and the top of a
CV. Write it in your own words, then keep it here and render it everywhere else.

`[[FILL]]`

### Headline options

Two or three, so tailoring picks rather than invents.

- `[[FILL]]`
- `[[FILL]]`

### Elevator pitch (30s)

`[[FILL]]`

### "How I work" - framing variants (audience switch)

<!--
  These variants MUST live here and be rendered. Never copy-paste them into a
  template, a rendered CV, or an HTML file's JS string literals.

  This is not a style note. Verbatim duplication of exactly this content into a
  rendered page as JS strings is one of the three findings this whole product is
  a response to: the same three paragraphs existed in a knowledge base and in an
  HTML editor at the same time, and there was no mechanism to keep them equal.
  One fact ended up needing edits in eight files, and the changelog entries
  recording those fan-outs were the tell.

  The previewer's audience toggle reads these sections. The renderer selects one
  per job. Neither copies.
-->

Same true workflow, framed for different readers. Keep all variants in sync when
the underlying story changes; if that becomes work, they have drifted into
separate claims and one of them is now false.

- **Blended (default):** `[[FILL]]`
- **Enterprise framing:** `[[FILL: process, reviewability, traceability]]`
- **Startup framing:** `[[FILL: velocity, ownership, breadth]]`

---

## 3. Company and Product Context

Background a reader does not have. What the companies you worked at actually
were, who funded them, what market they were in. This is the section that makes
a bullet legible to someone who has never heard of your employer.

`[[FILL]]`

---

## 4. Experience - `[[FILL: role]]` at `[[FILL: company]]`

One top-level section per role, most recent first. Sub-sections per product or
per deep-dive, so a tailored application can pull the one that matches without
dragging in the rest.

**Dates:** `[[FILL]]`
**Context:** `[[FILL: one line a stranger needs to read the bullets below]]`

### 4a. `[[FILL: product or workstream]]`

What it was, what you did, what happened as a result. Prefer outcomes. Note
ownership honestly: "I contributed to" when that is the truth is worth more than
"I built" for everything, because it is what makes the rest credible.

`[[FILL]]`

### 4b. `[[FILL: second product or workstream]]`

`[[FILL]]`

### 4c. Signature stories (interview-ready)

Two or three, each with a situation, what you did, and how it ended. These are
for interviews and for the one paragraph in a cover letter that has to carry
weight.

`[[FILL]]`

### 4d. Impact metrics (lead with these)

Numbers, each with its source marked.

- `[[FILL: e.g. "cut CI time 80% and around $20k/month"]]` (public)
- `[[FILL]]` ⚠️ confirm
- `[[FILL: e.g. commits, PRs, repos]]` (internal) - supporting colour only,
  never the lead. Activity counts measure activity, not outcomes, and a reader
  who notices that will discount everything around them.

> `⚠️ confirm` means you have not verified this yet. Verify or delete before it
> is claimed. The honesty floor (`gate verify`) flags numbers that do not trace
> back to a line in this file, but it is a flagger and not a prover: it will
> miss a wrong number that is written here confidently.

---

## 5. Prior Roles

Shorter entries, one per role, oldest last. A line of context, then one or two
bullets. Depth belongs in section 4 for the roles that matter now.

### `[[FILL: company]]` - `[[FILL: title]]`

**Dates:** `[[FILL]]`
`[[FILL: one line of context]]`

- `[[FILL]]`

---

## 6. Education

| Institution | Programme | Dates | Notes |
|---|---|---|---|
| `[[FILL]]` | `[[FILL]]` | `[[FILL]]` | `[[FILL]]` |

Certifications, courses and anything an ATS will look for go here too.

---

## 7. Skills and Tags Matrix (for ATS and per-role tailoring)

A matrix, not a list. Group by area so that a tailored CV can pull one row and
leave the rest, and so an ATS keyword scan has something to match.

| Area | Skills | Depth | Evidence |
|---|---|---|---|
| Languages | `[[FILL]]` | primary / working / familiar | section 4a |
| Backend / platform | `[[FILL]]` | | |
| Infrastructure | `[[FILL]]` | | |
| Data | `[[FILL]]` | | |
| Frontend / mobile | `[[FILL]]` | | |
| AI / agents | `[[FILL]]` | | |
| Practices | `[[FILL: testing, CI, on-call, code review]]` | | |

**Depth is a claim.** "Familiar" is a fine answer and it is the one that stops an
interview going somewhere you cannot follow. **Evidence** points at the section
of this file that backs the row up; a row with no evidence is a row you cannot
defend.

### 7.1 Trending keyword bank

Terms currently in postings in your field, kept separately from the matrix above
so the two never blur. These are for **mirroring language you already match**,
not for claiming skills you do not have. A keyword you cannot back from section
4 does not belong in an artifact, whatever the posting says.

`[[FILL: a dozen terms, reviewed every few months]]`

---

## 8. Reusable Achievement Bullets (quantified)

Pre-written, quantified, ready to drop into a tailored CV or email. Write them
once here, in final form, so tailoring becomes selection instead of composition.

Each bullet: what changed, by how much, and your part in it. Mark the source.

- `[[FILL]]` (public)
- `[[FILL]]` (public)
- `[[FILL]]` ⚠️ confirm
- `[[FILL]]` (internal) - do not ship

---

## 9. Open Items to Confirm

The working list. Every `[[FILL]]` and every `⚠️ confirm` above should have a
line here until it is resolved, because a marker buried in section 4 is a marker
nobody sees.

1. `[[FILL]]` remaining contact fields.
2. `⚠️ confirm` dates and titles against your own records, not a scraped
   profile.
3. Decide the narrative lead: which single story opens a tailored application.
4. `(internal)` audit: check nothing marked internal has reached an artifact.
