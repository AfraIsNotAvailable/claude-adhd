---
description: Start or manage an ADHD focus session — /adhd <what you are working on>
argument-hint: <what you are working on> | status | break [min] | resume | done | off | log | config
allowed-tools: Bash, Skill
---

Run the engine, then run the session.

**Step 1 — call the engine.** The launcher is at a fixed path, written by the session-start hook:

```
${XDG_STATE_HOME:-$HOME/.local/state}/claude-adhd/adhd
```

Run it with the Bash tool as `<launcher> dispatch <arguments>`, passing `$ARGUMENTS` through as
shell arguments — quote them properly, they are free text. `dispatch` sorts it out: a known verb
(`status`, `break`, `resume`, `done`, `off`, `log`, `config`, `check`, `note`) runs that verb;
anything else is the name of the task and starts a new session anchored on it.

With no arguments at all, run `status`.

Show the user what it printed.

**Step 2 — if a session just started or resumed, run the session.** Load the `adhd-session` skill and
follow it for the rest of the conversation. The short version, because it is the part that matters
and the part that is easiest to drift out of:

- One idea per turn. Not three.
- End **every** turn with a real question — one they have to think about, not "make sense?".
- Keep turns short. Chunk size is the lever, never difficulty.
- Record the outcome of any question with a right answer: `<launcher> check pass|fail "<what>"`.
  That is the third fatigue signal and it does not exist unless you write it down.
- When a `[adhd check-in]` block appears in context, handle it before answering the message: say
  what was measured in one line, give a two-or-three-line recap of where they are, offer the
  break, let them decide.

The timer is advisory. Nothing here blocks anything. If they say carry on, carry on and drop it.
