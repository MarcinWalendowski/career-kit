---
name: career
description: The one entry point. Sets up a workspace if there is none, otherwise reads the pipeline state and does what you asked for.
argument-hint: [what you want, in plain words]
---

# Career Kit

You are the single front door to Career Kit. **Route, do not reimplement.** Every
capability below already lives in a skill that owns its rules, its failure modes and
its gate calls. Your job is to work out where the user is, and hand off.

## 1. Read the state, always

```bash
node "$CLAUDE_PLUGIN_ROOT/engine/doctor.mjs" --json
```

Exit **2** no workspace, **1** usable with homework, **0** ready. Read the `next` field
before you decide anything: it is the engine's own answer to "what now", computed from
disk rather than from what you remember of this conversation.

**Correct one thing about the payload before you use it.** `mail.detected` is
config-file evidence, and `mail.authoritative` is `false` because the engine is a
zero-dependency node process that cannot see your MCP tool list. **You can.** Look at
the tools you are actually holding: if you have mail tools, you have mail, whatever
`doctor` said. Never tell a user they have no mail tool on the strength of that field
alone.

## 2. Exit 2, no workspace

Invoke the **career-setup** skill and onboard in the conversation. Do not ask the user
to go and run commands; setup is a conversation with one provisioning call in it.

Setup is the only thing that runs here. Do not offer to find roles or read a CV first:
there is nowhere to put the answer yet.

## 3. Exit 0 or 1, route on what the user said

`$ARGUMENTS` is what they want. Match it to the skill that owns it and invoke that
skill. Their descriptions carry the full trigger lists; this is the short form:

| They said something like | Skill |
|---|---|
| "find me roles", "is X hiring", "check my job inbox" | **career-sources** |
| "should I apply to this", a JD, a posting URL | **career-tailor** |
| "send it", "apply", "draft the email" | **career-apply** |
| "add this to my knowledge base", any new fact about themselves | **career-kb** |
| "any replies", "did anyone get back to me" | **career-inbox** |
| "where am I", "what do I need to do today", "weekly review" | **career-review** |
| "open the previewer", "let me see my CV" | **career-serve** |

**No arguments, or nothing that matches:** report `doctor.next` in one line, offer to do
it, and stop. Do not pick a task for them because the pipeline looked idle.

## 4. Things this command must not do

- **Never send anything itself.** Every irreversible action goes through
  `engine/gate.mjs`, and `career-apply` is the only skill with a path to one. If you
  find yourself about to call the gate from here, you have skipped a hand-off.
- **Never create a workspace as a side effect.** `career-setup` is the only skill
  allowed to, and `init.mjs` is idempotent precisely so that rule can hold.
- **Never work around a block.** Exit 3 from the gate is a stop, reported verbatim.

## 5. Granular access still exists

Each skill is directly invocable by name. If the user wants to drive the pieces
themselves, that is supported and not a fallback. Say which skill does what and get
out of the way.
