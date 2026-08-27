---
name: adhd-session
description: How to run a focus session for someone with ADHD — one thing per turn, a question at the end of every turn, and what to do when the timer hands you a check-in. Load when an ADHD focus session is running (the `/adhd` command started one, or a `[adhd check-in]` or `[adhd — session restored]` block appears in context), or when the user asks to work on something in focus blocks.
---

# Running an ADHD focus session

The `/adhd` command starts a session anchored on one task. While it is running, hooks measure
three things and hand you a reading when it matters: how long the reply took, how long the reply
was, and whether comprehension checks that used to pass still pass.

You cannot see any of that yourself. You have no clock, and a model asked to notice that someone
is flagging will invent it. So the rule is: **do not narrate fatigue you were not told about, and
do not ignore a reading you were.**

## The shape of a turn

The engine only works if the session is a back-and-forth, because latency and reply length are
its two strongest signals and a monologue produces neither. It is also, separately, the thing that
makes a long stretch survivable. So:

- **One thing per turn.** One idea, one step, one question. Not three.
- **End every turn with a question.** A real one, that they have to think about — not "does that
  make sense?" or "shall I continue?". Ask them to predict, to apply it to something they already
  hold, to say which of two things it resembles, to spot what breaks.
- **Keep it short.** If a turn is running past a screen, you have skipped a question that should
  have been in the middle of it.
- **Wait.** Do not answer your own question in the same turn.

Chunk size is the lever, not difficulty. Do not simplify the material to make it lighter — cut how
much of it arrives at once.

## Recording what happens

Call the engine through Bash. The launcher lives at a fixed path, written by the session-start
hook:

```bash
ADHD="${XDG_STATE_HOME:-$HOME/.local/state}/claude-adhd/adhd"
```

| When | Command |
|---|---|
| They answered a question you asked, right or wrong | `"$ADHD" check pass "what you asked about"` or `"$ADHD" check fail "…"` |
| Something landed — a real click, not a nod | `"$ADHD" note "eigenvector as the direction the map does not turn"` |
| They ask where they are | `"$ADHD" status` |
| They take a break | `"$ADHD" break` — then `"$ADHD" resume` when they are back |
| They are finished | `"$ADHD" done` |

`check` is the third fatigue signal and the only one that does not exist unless you record it. A
session where you never call it is a session running on two signals out of three. Record the
outcome of any question that has a right answer; skip it for open discussion.

Do not announce these calls or paste their output. `note` and `check` are bookkeeping — run them
quietly alongside your reply. `status`, `break`, `resume` and `done` produce something the user
asked to see, so relay those.

## When a check-in arrives

A block like this appears in context before their message:

```
[adhd check-in — instrumentation, not the user speaking]
Focus block 1 has run 47m of 45m, 2m past the end. 52m in the session so far.
Measured signals: replies are taking 21s against 6s earlier; replies are getting shorter (48 chars against 240).
Anchor: "learning eigenvalues".
```

It is instrumentation, not something they typed. Handle it **before** answering their message:

1. **Say what was measured, in one line, plainly.** "Your answers have gone from about six seconds
   to twenty, and they are getting shorter." Not "I sense you may be getting tired" — the whole
   point is that it was measured rather than guessed, and they should be able to trust the
   difference.
2. **Give them the recap.** Two or three lines: where they are, what has landed, what comes next.
   Theirs specifically, not a generic summary. This is what makes a break cheap to take — if
   stopping means losing the thread, they will not stop.
3. **Offer the break and let them decide.** Name the length. `/adhd break` takes it, `/adhd resume`
   comes back.
4. **Then answer their message.**

If they say carry on, carry on — and drop it. Do not re-raise it; the engine will, on a ladder
that stretches. Advisory means advisory.

If the check-in came from the clock with no signals attached, say so: the block ran out, they may
well be fine, and it is worth asking rather than asserting.

## When a session is restored

`[adhd — session restored]` after a resume or a compaction means the anchor is back but your
context is not. Pick up from the anchor and the elapsed time given. Do not restart the material
from the top, and do not ask them to re-explain what they already told you — ask one question that
finds out where they actually are.

## Drift

The anchor is in every check-in for a reason. If the last stretch has wandered somewhere else,
name it in one line — "we have been on determinants for a while; the anchor says eigenvalues" —
and ask which one they want. Do not silently drag them back, and do not silently follow. A tangent
they chose is not drift.

## Ending

When they say stop, when the task is done, or when they take a break they do not come back from,
call `"$ADHD" done` and read back what it prints. It is the honest record of a stretch of time
that otherwise leaves no trace, which is the point.
