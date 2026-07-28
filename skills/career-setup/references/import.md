# Importing a CV or LinkedIn export into a first knowledge base

The knowledge base is the single source of truth for every factual claim the pipeline will ever
make. This import is the moment it either gets seeded honestly or gets seeded with plausible filler
that nobody can trace six weeks later.

## The one rule

**Extract, never infer.** If the source says "led the payments team", the knowledge base says "led
the payments team". It does not say "led a team of engineers on a high-scale payments platform"
because that sounded better. Anything you would have to guess gets `[[FILL]]`.

`[[FILL]]` is a feature. `career-kb` surfaces the markers, the previewer highlights them, and the
user fills them in the browser. A gap that is visible costs one minute. A gap that got papered over
costs a job when someone asks about a number in an interview.

## Sections to produce

```markdown
# Knowledge base

## 1. Identity and headline
Name, one-line self-description in their words, the title they use for themselves.

## 2. Experience
Per role: company, title, dates, location, remote or onsite, one line on what the company does,
then bullets. Each bullet is one shipped thing with its outcome.

## 3. Products and deep dives
Per product: what it IS in one plain sentence, then what it is made of. Users, scale, links.

## 4. Skills and tags matrix
Grouped, with a strength per group: daily / used in production / adjacent / evaluated.
The last two categories are what keep a later application honest.

## 5. Achievement bank
Every defensible number, with the role it belongs to and the source of the number.

## 6. Keyword bank
Phrases from the user's real domain that a job description is likely to repeat, marked true or
aspirational. Only the true ones may enter an application.

## 7. Framing variants
Two or three ways of describing how the user works, one per audience (enterprise, startup,
research). A later skill picks one. It never invents a fourth.

## 8. Gaps
What they do not have and would rather say plainly than dodge. This section is why the confident
parts of an application land.
```

## From a CV

Read the whole document before writing anything. A CV is already compressed, so the import is mostly
transcription plus splitting a dense bullet into the fact and the outcome.

Keep the numbers exactly as written and record where each came from. A number whose source is "the
CV said so" is fine. A number nobody can source is a liability, and `gate verify` will flag every
sentence carrying it later.

The CV file itself is separate from this import. Copy it to `$CAREER_HOME/cv/` and point
`profile.yaml: attachments.cv` at it. Whether it is ever regenerated per role is a `rules.yaml`
setting, not a decision made here.

## From a LinkedIn export

The export is a zip of CSVs. `Positions.csv` gives roles and dates, `Profile.csv` the headline and
summary, `Skills.csv` a list, `Projects.csv` and `Recommendations.csv` occasionally the only place
an outcome is written down.

`Skills.csv` is an endorsement list, not a competence claim. Import it into section 4 marked
`unverified` and ask the user to sort it into the strength groups. Importing it as fact is how a
tool starts claiming a language its user last touched a decade ago.

## Finishing

Report back: how many roles were imported, how many `[[FILL]]` markers remain and which sections
they sit in, and which numbers have no source. Then hand off to `career-kb`, which is the only write
path for facts from here on. Any correction the user offers in chat goes into the knowledge base
first and fans out from there, never into a downstream file directly.
