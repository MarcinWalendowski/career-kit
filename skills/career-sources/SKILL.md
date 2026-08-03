---
name: career-sources
description: Find open roles and turn them into job records. Pulls postings from the job-board adapters, resolves the real apply route for a company, verifies the posting actually belongs to that company, and writes jobs/<id>.json. Also triages whatever the browser extension captured into jobs/inbox/. Use when the user says "find me roles", "is this company hiring", "how do I apply to X", "pull the latest jobs", "check my job inbox", or hands over a list of companies to research.
---

# Find roles, resolve routes, write job records

Output of this skill is one validated `$CAREER_HOME/jobs/<id>.json` per target. Nothing here sends
anything. Drafting is `career-tailor`, sending is `career-apply` through the gate.

## 1. Pull

Public JSON adapters, no auth, no browser:

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/sources/greenhouse.mjs" search --board <token>
node "$CLAUDE_PLUGIN_ROOT/engine/sources/lever.mjs"      search --company <slug>
node "$CLAUDE_PLUGIN_ROOT/engine/sources/ashby.mjs"      search --slug <slug>
node "$CLAUDE_PLUGIN_ROOT/engine/sources/hn.mjs"         search --query "<terms>"
```

Same shape for `smartrecruiters`, `recruitee`, `workable`, `remote-aggregators`. Every adapter
returns records already normalised to the job-record schema, and returns `null` for a field it could
not determine. **A `null` is never filled in with a guess downstream.**

**Zero results is a report, not an answer.** An adapter returning nothing means the board changed
its schema, the slug is wrong, or nobody is hiring, and those are three different situations. Say
which one you checked. Never let "the adapter returned zero" become "they are not hiring".

## 2. Screen against the role rules, before spending any research

Read `rules.yaml: roles.allow` and `roles.deny`. A denied title is dropped here, at the cheapest
point, and the reason goes in the record.

The match is on contiguous phrases with word boundaries, so `founding engineer` does not match
"Founding Software Engineer". A title that plainly belongs and does not match is a missing variant
in `roles.allow`, not a target to drop. Say so rather than silently skipping the company.

Two failure modes worth naming:

- **Do not fall back to an excluded req.** When a company posts one allowed role and three denied
  ones, take the allowed one or take none. A denied req filters on a skill set the user's knowledge
  base does not carry, so the application is dead on arrival and it spends a first impression at a
  company where the allowed req would have landed.
- **Check what the apply link actually submits, not the page you read.** A careers page can describe
  one role while its apply button carries a query fragment naming another (`...#role=<other-role>`).
  Copy-paste slips like that are common. Strip or correct the fragment, or use a different route.

## 3. Resolve the apply route

Run the ladder in order and stop at the first route that survives step 4:

1. Homepage, then `/careers`, `/jobs`, `/about`, `/join`.
2. Scan those pages for links to an ATS: Ashby, Greenhouse, Lever, Workable, SmartRecruiters,
   Recruitee, Rippling, Workday, Typeform, or a Notion board.
3. Scan for a published email address and for hiring language.
4. Probe the ATS board slug directly. A site can be a JavaScript shell while its board is live and
   public, and probing the slug is how those get found at all.
5. Sweep `/sitemap.xml` and `/robots.txt` for a careers URL the navigation does not link.

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/sources/resolve-route.mjs" --domain <domain>
```

It returns a route plus `route_confidence`. A low score is not a warning to be noted and passed;
combined with a failed identity check in step 4 it is a block.

**"Not visibly recruiting" is a statement about what is public.** A company with no careers page, no
ATS board and no hiring language anywhere reachable gets recorded as not visibly recruiting, with
the ladder steps that were run. It is not proof there is no opening, and it is not a reason to guess
at an address.

## 4. Verify identity from the posting itself

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/sources/identity.mjs" --route <url> --domains <d1,d2>
```

**An ATS slug can belong to a different company than the one you meant.** A one-word product name is
rarely unique, and short slugs get taken by whoever registered first. In a single directory sweep,
three separate slugs each resolved to an unrelated company: an edge-sync vendor sitting on the slug
of an AI product with the same name, a hardware firm on the slug of a consumer app, a marketplace on
the slug of a travel startup. Applying through one of those sends a stranger a résumé for a job that
does not exist.

So the identity check reads the fetched job description and confirms the company it describes
matches the target's `domains[]`. Confirm from the JD body, not from the slug and not from the page
title. On a mismatch, write `identity_verified: false` with what you saw and **do not record the
route**. The gate blocks on `identity-mismatch` anyway, but a bad route in a record is a trap for
the next run.

## 5. Write the record

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/validate.mjs" --job "$CAREER_HOME/jobs/<id>.json"
```

`id` is `<company>-<role-slug>` with a `-2`, `-3` suffix if that id is taken. It is deliberately not
the company id: re-applying to a company next year is normal, and the one-application-per-company
rule is enforced by the gate from `rules.yaml`, not by a schema that cannot express an exception.

Field discipline, all of it learned from a schema that drifted across four files:

- `apply.channel` takes exactly one enum value. Free text goes in `notes`. A channel field holding
  `"linkedin (preferred, draft) + form staged + email draft"` is a field that no query can read.
- `notes` is a sentence. Evidence goes in `evidence[]`, contradictions in `incidents[]`, refusals in
  `escalations[]`, each with `at` and `kind`. A four-thousand character `notes` blob is a symptom of
  the array being missing, not of a thorough researcher.
- `posted_comp` comes from the adapter that read the posting. Never from memory.
- Timestamps are UTC and actually UTC. A local wall-clock time stamped `Z` in a UTC+2 zone lands two
  hours in the future, and the gate rejects it as clock skew.

## 6. Triage `jobs/inbox/`

The browser extension writes captures to `$CAREER_HOME/jobs/inbox/` and never to `jobs/`. Triage is
this skill's job:

- Read each capture. Screen it against `roles.allow` / `roles.deny`.
- Resolve the route and run the identity check, exactly as for an adapter record. A capture arrives
  with a page URL, which is not an apply route and is not identity-verified.
- Promote survivors to `$CAREER_HOME/jobs/<id>.json` and validate. Delete or archive the rest with a
  one-line reason.
- Deduplicate against existing records by company plus role, not by URL. The same req appears under
  several URLs across boards.

## Finish

Report: how many records written, how many blocked and why (denied role, identity mismatch, no
route), which companies are not visibly recruiting and what was checked, and any adapter that
returned zero where it should not have.

Then offer the board. A pull of any size ends with more rows than a chat window can show, and
**career-board** is where the user reads through them and marks a shortlist:

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/board.mjs"
```

Offer it, do not run it as a matter of course after every pull. A board rebuilt on nothing is a page
the user has already read.
