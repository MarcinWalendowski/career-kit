---
name: career-serve
description: Start the local previewer, a web app on 127.0.0.1 that shows the knowledge base beside the rendered CV and writes edits back to disk. Use when the user says "open the previewer", "let me see my CV", "start the editor", "I want to edit this visually", or wants to review and tweak a rendered CV or brief by hand rather than through chat.
---

# Start the previewer

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/serve.mjs"
```

It binds `127.0.0.1` on port 7749, walking forward up to 20 ports if that one is
taken, and prints the URL and a token. Give the user the URL. Leave the process
running: it serves until stopped, so start it in the background rather than
waiting on it.

Options: `--port <n>` to pin one (`--port 0` picks any free port and does not
walk), `--home <path>` to serve a workspace other than `$CAREER_HOME`. The
`CAREER_PORT` environment variable does the same as `--port`.

## What it is for

The knowledge-base source sits beside the rendered CV. Click a bullet to edit it
in place, keep per-section notes, switch audience, export a PDF.

The part that matters is that **it writes back to disk**, to the knowledge base
and never to a rendered file. You and the user edit the same files, and version
history is git commits in the workspace. The loop it replaces ran through the
clipboard, which is how a fact ends up living in a rendered artifact and drifting
from the source it was copied out of.

## Guardrails

- **Loopback is not authentication.** Every page in the user's browser can reach
  a local server. So: bound to `127.0.0.1`, a per-boot token required on every
  `/api/*` call, the `Host` header checked against DNS rebinding. The token is at
  `$CAREER_HOME/.previewer-token`, mode 0600. Do not print it anywhere it would
  be stored, and do not disable these to make something work.
- **A write can 409.** The knowledge base is edited by both sides, so a stale
  `etag` is refused rather than silently overwritten. If you get one, re-read the
  file before writing again. Never retry a 409 by dropping the etag.
- **A render can exit 3 / return 422.** That is the hidden-text lint refusing to
  emit a document that hides text from a human while showing it to a screener.
  Fix the theme. It is not a flag to pass.
- If the user asks for a fact to change, that is `career-kb`, not a hand-edit of
  a rendered file. The previewer edits the knowledge base for exactly this
  reason.

## Finish

Tell the user the URL, that edits land in `knowledge-base.md` in their workspace,
and that the process keeps running until they stop it.
