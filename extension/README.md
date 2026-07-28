# Career Kit Capture (Chrome extension)

Reads the job results **already rendered on your screen** and writes them into
your local Career Kit workspace at `jobs/inbox/`. It is the Tier 2 job source:
the boards that have no public API and that you can only see while logged in.

Nothing else. No account, no sync, no server but your own.

---

## The no-crawling rule

This is a design constraint, not a preference, and not a setting.

- **No auto-scroll.** The parser reads the DOM as it is when you click. If you
  want more results, scroll and click again.
- **No pagination.** It never follows a next link or a "load more" button.
- **No scheduled runs.** There is no `alarms` permission, no timer, and no
  navigation listener. Read `background.js`: the service worker wakes on a
  message and goes back to sleep.
- **No declared content script.** `content.js` is not in `manifest.json` under
  `content_scripts`. It is injected with `chrome.scripting.executeScript` when
  you click the toolbar button, so it runs once per click and never on a page
  you merely visited.
- **Nothing leaves the machine.** The only entry in `host_permissions` is
  `http://127.0.0.1/*`. There is no analytics, no error reporting and no remote
  config. The extension holds one credential, your own previewer's token, and
  the page never sees it.

The framing is the point. Reading a page a person already has open, at the
moment they ask, is a different act from a crawler with an account. If that
framing ever stops being defensible for a given board, the adapter is removed,
not weakened.

---

## Install (unpacked)

The extension is not in the Chrome Web Store. Load it from the repo:

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose this `extension/` directory.
4. Pin **Career Kit Capture** to the toolbar so the button is one click away.

Then wire it to your workspace:

1. Start the previewer: `career-serve` (or `npm run serve` from the repo).
2. It prints a token once at boot and writes it to
   `$CAREER_HOME/.previewer-token`.
3. Click the extension button, paste the token, set the port if you changed it
   from `8899`, and press **Check the local server**. It should report your
   workspace path.

The token is stored in `chrome.storage.local`. It rotates on every previewer
boot, so if capture starts failing with "the server rejected the token", copy it
again.

---

## Use

1. Search on a supported board and let the results render.
2. Click the extension button.
3. Click **Capture jobs on this page**.

You get a line like `Wrote 23 to jobs/inbox/. 2 cards could not be parsed.`
Then run `career-sources` to triage the inbox: it resolves the real apply route,
runs the identity check, and only then promotes a record from `jobs/inbox/` to
`jobs/`. The extension never writes to `jobs/`.

### Supported sites

| Site | Notes |
|---|---|
| LinkedIn | Job search results list |
| Work at a Startup (YC) | Company and job lists |
| justjoin.it | Offer list |
| NoFluffJobs | Posting list |
| pracuj.pl | Offer list |

---

## What a captured record looks like

The job-record shape from the spec, with everything the page cannot tell us set
to `null`. Two fields are worth understanding:

- **`apply.channel` is `"none"`.** A results card proves a posting exists. It
  does not tell you where the application actually goes. Writing `"linkedin"`
  because we read LinkedIn would put an unverified route into a record that gets
  acted on later. `career-sources` resolves the route and runs an identity check
  against the company's domains, and that check can block.
- **`status` is `"discovered"`.** Nothing captured here is a candidate to send
  to until a human or `career-sources` has looked at it.

An adapter that cannot determine a field returns `null`, never a guess.

---

## When a board changes its markup

It will. Every parser lists its selectors most-specific first and falls back to
the shape of the apply URL, which changes far less often than a wrapper class.
When all of them miss, the capture reports `captured N cards, could not parse M`
and writes nothing.

That wording is deliberate. A parser that silently returns zero results looks
exactly like a day when nobody is hiring, and you would not find out for a week.

To fix a broken parser, edit the matching adapter in `content.js`. Each one is a
small object with `match()`, `cards()` and `parse(card)`. Reload the extension
from `chrome://extensions` after editing; there is no build step.
