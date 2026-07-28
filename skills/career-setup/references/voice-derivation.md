# Deriving `voice.md`

The file that tells every later skill how the user writes. Two paths produce it: reading their own
sent mail, or answering questions. Both end in the same shape, and both write Provenance.

## Consent comes before the first read

Say all of this, in one message, before touching a mailbox. Then wait for an explicit yes.

> To write your voice file I would read the last N messages you sent from `<account>`, from your
> Sent folder only. I read the bodies to learn sentence length, openings, sign-offs and the phrases
> you avoid. Nothing is uploaded and nothing is stored except the summary in
> `$CAREER_HOME/voice.md`, which you can edit or delete. I will not read your inbox, and I will not
> read any account you do not name here.
>
> If you would rather not, say so and I will build the same file from about eight questions instead.
> That version is a little thinner and works fine.

Rules that hold whatever they answer:

- Do not read until the yes arrives. Silence is not consent, and neither is "sure, whatever".
- Read Sent only. An inbox is other people's writing.
- One account, the one they named. Not "all accounts" because a tool makes it easy.
- Do not quote a third party into `voice.md`. Their correspondents did not consent to anything.
- Sample size is a number they agreed to. If you need more, ask again.

## The derived path

1. Pull the sample from Sent, newest first, and drop anything that is a forward, a one-word
   acknowledgement, or automated.
2. Measure rather than impress: mean sentence length, sentences per paragraph, paragraphs per
   message, and the length band from shortest to longest real message.
3. Collect the repeated forms, verbatim: openings for a cold first contact, openings for a reply,
   the second line that connects (how they got here, what they read, who introduced them), the
   closing ask, the sign-off.
4. Collect the negative rules from evidence, not from taste. A phrase that appears zero times in
   the whole sample but appears in every generic template is a negative rule. So is any character or
   habit the user has told you to drop.
5. Note the register: contractions or not, first person active or passive, whether they undersell,
   whether they admit gaps, whether concrete nouns or adjectives carry the weight.
6. Write the file. Show it to the user and ask them to correct it. They will, and the correction is
   the most valuable line in the file.

**Reply length and cold-outreach length are different numbers.** Measure both. A file that gives one
length rule produces padded replies, which reads worse than anything else on this list.

## The decline path: eight questions

Ask these, accept short answers, and write the same file with `method: interview`.

1. Paste one email you were happy with. Any kind.
2. How do you open a first contact with a stranger? And a reply to someone you know?
3. What goes in your second line, before you talk about yourself?
4. How do you sign off?
5. What phrase makes you close an email you are reading?
6. Do you undersell or sell hard? Give an example of each in your words.
7. How long is a reply for you: one line, or a paragraph?
8. Anything you never write. Words, punctuation, formatting.

## The file

```markdown
# Voice

## Register
Plain sentences of about N words, one idea per sentence, ordinary words. Say what a thing is before
what it is made of. Contractions throughout. Active first person.

## Hard limits
Max <n> sections. Max <n> sentences. Length band <low> to <high> words for cold outreach,
<low> to <high> words for a reply.

## Openings
First contact: "<verbatim form>"
Reply: "<verbatim form>"
Connective second line: <what goes there, with an example>

## Closings
The ask: "<verbatim form>"
Sign-off: "<verbatim form>"

## Negative rules
Never <X>. <date> - <what it cost to learn>.
Never <Y>. <date> - <what it cost to learn>.

## Provenance
Derived from <source>, on <date>, by <method>, over <n> samples. Reviewed by <who>, <date>.
```

Each negative rule carries a date and a cost. "Never open with a pleasantry" is advice. "Never open
with a pleasantry - three batches were rejected as too generative before the register landed, and
each rejection burned a first contact" is a rule that survives the next agent.

## After writing

- `voice.md` is the user's file. Say so. Tell them editing it changes the compiled brief that
  `career-apply` renders on every run, so a correction here propagates without touching a skill.
- If the sample was thin (under a couple of dozen usable messages), say that in Provenance rather
  than in a caveat the user will not reread. A thin sample is not a failure, an unlabelled thin
  sample is.
