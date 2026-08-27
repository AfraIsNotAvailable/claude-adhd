# claude-adhd

An ADHD focus timer and check-in engine for [Claude Code](https://claude.com/claude-code).

`/adhd <what you are working on>` anchors a session to one task, runs it as focus blocks, and
measures three things while it runs: how long your replies take, how long they are, and whether
comprehension checks that used to pass still pass. When the clock runs out or the signals degrade,
Claude gets a briefing and raises it with you — with a recap of where you are, so stopping is
cheap.

It is a port of the fatigue half of [pi-learn](https://github.com/AfraIsNotAvailable/pi-learn),
cut down to the timer and the check-in and made task-agnostic. None of the teaching engine came
with it.

> **Status: personal, unfinished.** It works end to end and the self-test covers the gates, but
> the defaults are one person's opinions and there is no UI for changing them.

## The design rule

**Fatigue is measured, never guessed.**

A model has no clock. Asked to notice that you are flagging, it will invent it — and a machine
that tells you "you seem tired" on a hunch teaches you to ignore it, which then costs you the one
time it was right. So the hooks measure, and Claude is only ever told what was actually observed:

```
[adhd check-in — instrumentation, not the user speaking]
Focus block 1 has run 47m of 45m, 2m past the end. 52m in the session so far.
Measured signals: replies are taking 21s against 6s earlier; replies are getting shorter (48 chars against 240).
Anchor: "learning eigenvalues".
```

Everything is relative to how *this* session started, not to an absolute threshold — one person's
thirty-second answer is another's five.

**And it is advisory.** Nothing blocks a prompt, nothing refuses, nothing auto-starts. An ignored
nudge comes back on a ladder that stretches (at the boundary, then +15m, +30m, +60m) rather than
every eight minutes, because a reminder on a fixed interval stops being information.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/AfraIsNotAvailable/claude-adhd/main/install.sh | bash
```

Clones into `~/.local/share/claude-adhd`, runs the self-test, registers the checkout as a local
marketplace, and installs the plugin from it — hooks, the `/adhd` skill
together. Restart Claude Code afterwards.

Arguments pass through: `... | bash -s -- --skill --no-statusline`.

### From the marketplace

If you would rather add the marketplace and pick plugins yourself:

```
/plugin marketplace add AfraIsNotAvailable/claude-plugins
/plugin install adhd@afra
```

or from a shell:

```bash
claude plugin marketplace add AfraIsNotAvailable/claude-plugins
claude plugin install adhd@afra
```

This route does not run `scripts/install.sh`, so the status-line segment is not wired up — add it
by hand if you want it (see [Status line](#status-line)).

### From a clone

```bash
git clone https://github.com/AfraIsNotAvailable/claude-adhd
cd claude-adhd
scripts/install.sh
```

`scripts/install.sh --skill` instead symlinks `skills/adhd` into `~/.claude/` and writes the four hooks into `~/.claude/settings.json` directly, for people who do
not want a marketplace entry. It backs the file up first, only ever appends to hook arrays that
already exist, and is idempotent.

### Status line

`scripts/install.sh` offers to add the timer to your status line. That wraps whatever status-line
command you already have — yours still runs, ours is appended:

```
…/agents/claude-adhd  main  Opus 5  adhd 32m · blk1 · 13m left · fatigue 2/3
```

Wire it up later, or on its own, with `scripts/install.sh --statusline`. The uninstaller puts the
original back.

### Updating

```bash
cd ~/.local/share/claude-adhd && git pull
```

The plugin is installed *from* that checkout, so pulling updates it in place.

### Uninstalling

```bash
~/.local/share/claude-adhd/scripts/uninstall.sh            # keep the session logs
~/.local/share/claude-adhd/scripts/uninstall.sh --purge    # and delete them
```

### Requirements

| Requirement | Why |
|---|---|
| Claude Code ≥ 2.1 | the hook events and `hookSpecificOutput` used here |
| Node ≥ 20 | the engine. No dependencies, nothing to `npm install` |
| Linux | the paths are XDG; it will probably work on macOS but is not tested there |
| bash | the launcher and the install scripts |

No API key, no network, no daemon, no background process. The whole engine is `bin/adhd.mjs` plus
`lib/`, and its only durable state is JSON under `~/.local/state/claude-adhd/`.

## Using it

```
/adhd <what you are working on>    start a session anchored on that task
/adhd status                       elapsed, block, fatigue reading
/adhd break [minutes]              take a break; Claude arms a timer and calls you back
/adhd resume                       start the next block now, without a break
/adhd done                         close it and print what actually happened
/adhd off                          stop measuring for this session
/adhd log [YYYY-MM-DD]             what you worked on, and for how long
/adhd config                       show the effective settings
```

It works best on something interactive — learning a concept, working through a chapter, thinking
a design out loud — and it works best when Claude keeps asking you questions. That is not
decoration: latency and reply length are two of the three signals, and a monologue produces
neither. The `adhd` skill tells Claude to run the session that way, one idea per turn, ending
every turn with a real question.

### What Claude does with it

The `adhd` skill is both the entry point and the operating protocol. In short:

- one idea per turn, never three
- a real question at the end of every turn — one you have to think about, not "make sense?"
- chunk size is the lever, never difficulty
- the outcome of any question with a right answer is recorded (`adhd check pass|fail`), because
  that is the third signal and it does not exist unless Claude writes it down
- a check-in is handled *before* answering you: what was measured, a two-or-three-line recap of
  where you are, then the offer

The recap matters more than the offer. If stopping means losing the thread, you will not stop.

## What is measured

| Signal | How | Fires when |
|---|---|---|
| Latency | `Stop` hook marks when Claude finished; `UserPromptSubmit` marks when you replied | the recent half of the window averages 1.6× the earlier half |
| Reply length | characters in your message | the recent half averages below 55% of the earlier half |
| Check accuracy | `adhd check pass\|fail`, called by Claude | you were passing ≥60% and have dropped by more than 30 points |
| The clock | focus block elapsed vs. its length | the block runs out |

Two of the three signals lit is a fatigue check-in. The clock fires on its own, and says so when
no signals are attached — the block ran out, you may well be fine, and that is worth asking rather
than asserting.

A reply after more than 45 minutes is discarded rather than counted as a slow one: that is a break
you already took. A session picked up more than 45 minutes later starts a fresh sitting — same
anchor, new block, cleared window — because the latencies from before a night's sleep would
declare exhaustion on your first question.

Taking a break clears the reading, for the same reason.

## Breaks

`/adhd break 2` starts a two-minute break, and Claude backgrounds `adhd await-break` — a process
that sleeps until the break is up and then exits, which is what wakes Claude to ask if you are
ready. That is the only place the engine speaks first, and it is the only thing here that needed a
mechanism beyond the hooks: hooks fire on events, and a break ending is not an event.

No daemon, no scheduler, no notification service — the wait is a sleeping node process the session
owns, and it dies with the session. Long breaks are waited out in stages, because the Bash tool
caps a single run at ten minutes.

**You never need `/adhd resume`.** Any message during a break ends it and starts the next focus
block; Claude is told you are back, and whether you came back early. `resume` exists only for
skipping a break you did not want.

While a break runs, the status line shows `adhd break 1m/2m`, then `adhd break over +3m` if you
wander off and the ping went unanswered.

## Configuration

Environment variables, or `~/.config/claude-adhd/config.json` with the same keys in camelCase.

| Variable | Default | Effect |
|---|---|---|
| `ADHD_WORK_MIN` | `45` | focus block length |
| `ADHD_BREAK_MIN` | `10` | break after a normal block |
| `ADHD_BLOCKS_BEFORE_LONG_BREAK` | `3` | how often the break gets longer |
| `ADHD_LONG_BREAK_MIN` | `25` | the long one |
| `ADHD_CHECKIN_COOLDOWN_MIN` | `8` | never two check-ins closer than this |
| `ADHD_FATIGUE_THRESHOLD` | `2` | signals lit before a fatigue check-in (`3` for quieter, `1` for twitchier) |
| `ADHD_LATENCY_RATIO` | `1.6` | how much slower counts as slowing down |
| `ADHD_LENGTH_RATIO` | `0.55` | how much shorter counts as shortening |
| `ADHD_STALE_RESUME_MIN` | `45` | idle gap after which a session is a new sitting |
| `ADHD_ENABLED` | `1` | master switch |
| `ADHD_STATE_DIR` | `~/.local/state/claude-adhd` | where state and logs live |
| `ADHD_NODE` | — | node to use, if the launcher cannot find one |

`/adhd config` prints what is actually in effect.

## What it does not do

- **No desktop notifications.** The check-in reaches you through Claude and the status line, and
  nowhere else. pi-learn's `notify-send` review timer did not come across.
- **No blocking.** It will not gate a prompt, refuse a tool, or make you type an override.
- **No teaching.** pi-learn's phases, hint ladder, quiz tool, concept graph and Obsidian notes all
  stayed there.
- **Nothing auto-starts.** A session begins when you run `/adhd` and never otherwise.
- **It never reads your code or your conversation.** Only the length of your messages and the gap
  before them. The session log holds the task name, the timings, and whatever Claude wrote down
  with `adhd note`.

## Development

```bash
node test/selftest.mjs     # or: npm test
```

No network, no model, no key, about a second. It does not test whether Claude handles a check-in
well — that is not testable here. It tests the part that has to be right for the check-in to mean
anything: that the clock fires at the boundary and not before, that a consistently slow answerer
is not reported as fatigued, that an ignored nudge returns on the ladder rather than on the
cooldown, that a break clears the reading, that an idle session is never interrupted, and that the
hooks survive being fed garbage.

```
bin/adhd          launcher — finds a node, stays silent if there is none
bin/adhd.mjs      every verb and every hook
lib/config.mjs    defaults, config file, environment
lib/state.mjs     per-session JSON, the cwd map, the log
lib/fatigue.mjs   the three signals
lib/blocks.mjs    focus blocks and breaks
lib/checkin.mjs   when to interrupt, and what to say
lib/statusline.mjs the passive surface
skills/adhd/      the /adhd entry point and how Claude runs the session
```

## License

MIT
