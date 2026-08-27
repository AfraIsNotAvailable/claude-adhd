#!/usr/bin/env node
/**
 * Self-test. No network, no model, no API key, about a second.
 *
 * It does not test whether Claude behaves well when it gets a check-in — that
 * is not testable here. It tests the part that has to be right for the check-in
 * to mean anything: that the clock fires when it should and not before, that
 * the fatigue reading is a comparison against how the session started rather
 * than an absolute threshold, that an ignored nudge comes back on a stretching
 * ladder instead of every cooldown, and that a break resets the reading.
 *
 * Run: npm test   (or: node test/selftest.mjs)
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULTS, MIN } from "../lib/config.mjs";
import { breakLengthFor, newBlock } from "../lib/blocks.mjs";
import { decideCheckin, markCheckinRaised, renderCheckin, renderResume } from "../lib/checkin.mjs";
import { noteCheck, noteReply, noteTurnEnd, readFatigue, resetFatigue } from "../lib/fatigue.mjs";
import { renderStatusline } from "../lib/statusline.mjs";
import { newState } from "../lib/state.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "adhd.mjs");
const cfg = { ...DEFAULTS };

let passed = 0;
const failures = [];

function check(name, condition, detail = "") {
	if (condition) {
		passed += 1;
		return;
	}
	failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

function session({ now = Date.now(), task = "learning eigenvalues" } = {}) {
	const state = newState("test", "/tmp");
	state.task = task;
	state.status = "focus";
	state.startedAt = now;
	state.block = newBlock(1, cfg, now);
	state.lastActivityAt = now;
	return state;
}

/** Feed n replies with a given latency and length, spaced a minute apart. */
function replies(state, n, { latencyMs, length, from }) {
	let t = from;
	for (let i = 0; i < n; i += 1) {
		noteTurnEnd(state, t);
		t += latencyMs;
		noteReply(state, "x".repeat(length), cfg, t);
		t += MIN;
	}
	return t;
}

// ---------------------------------------------------------------- clock

{
	const now = Date.now();
	const state = session({ now });

	check("no check-in at the start of a block", decideCheckin(state, cfg, now) === null);
	check(
		"no check-in one minute before the boundary",
		decideCheckin(state, cfg, now + (cfg.workMin - 1) * MIN) === null,
		"the clock must not round its way into an early interruption",
	);

	const boundary = now + cfg.workMin * MIN;
	const first = decideCheckin(state, cfg, boundary);
	check("clock check-in at the boundary", first?.kind === "clock");

	markCheckinRaised(state, "clock", boundary);
	check(
		"no second clock check-in during the cooldown",
		decideCheckin(state, cfg, boundary + (cfg.checkinCooldownMin - 1) * MIN) === null,
	);
	check(
		"no second clock check-in until the ladder's next rung",
		decideCheckin(state, cfg, boundary + (cfg.checkinCooldownMin + 1) * MIN) === null,
		"cooldown expiry alone must not re-nudge; the ladder is what stretches",
	);
	const second = decideCheckin(state, cfg, boundary + cfg.clockNudgeLadderMin[1] * MIN);
	check("clock check-in returns at the next rung of the ladder", second?.kind === "clock");
}

// ---------------------------------------------------------------- fatigue

{
	const now = Date.now();
	const state = session({ now });

	// Slow but steady: an absolute threshold would call this exhausted.
	let t = now + MIN;
	t = replies(state, 6, { latencyMs: 40_000, length: 200, from: t });
	check("a consistently slow answerer is not fatigued", readFatigue(state, cfg, t).score === 0, JSON.stringify(readFatigue(state, cfg, t).signals));

	// Fast then slow and terse: two signals, relative to this session's own start.
	const state2 = session({ now });
	let t2 = now + MIN;
	t2 = replies(state2, 3, { latencyMs: 5_000, length: 240, from: t2 });
	t2 = replies(state2, 3, { latencyMs: 30_000, length: 40, from: t2 });
	const reading = readFatigue(state2, cfg, t2);
	check("degrading latency and length light two signals", reading.score >= 2, JSON.stringify(reading.signals));
	check("the reading names the latency in seconds", reading.signals.some((s) => /replies are taking \d+s/.test(s)));

	const decision = decideCheckin(state2, cfg, t2);
	check("fatigue trips a check-in inside the block", decision?.kind === "fatigue", "the wall clock does not know when someone ran out early");

	const text = renderCheckin(state2, decision, cfg, t2);
	check("the check-in is marked as instrumentation", text.startsWith("[adhd check-in"), "it must not read as the user speaking");
	check("the check-in carries the anchor", text.includes('Anchor: "learning eigenvalues"'));
	check("the check-in carries the measured signals", text.includes("measured, not guessed"));

	// A reply after a long gap is a break already taken, not a slow answer.
	const state3 = session({ now });
	noteTurnEnd(state3, now);
	noteReply(state3, "back", cfg, now + (cfg.maxSampleMin + 5) * MIN);
	check("a reply after a long gap is discarded, not counted as slow", state3.samples.length === 0);
}

// ---------------------------------------------------------------- accuracy

{
	const now = Date.now();
	const state = session({ now });
	let t = replies(state, 4, { latencyMs: 8_000, length: 200, from: now + MIN });
	for (const passedCheck of [true, true, true, false, false, false]) {
		noteCheck(state, passedCheck, cfg, t);
		t += MIN;
	}
	const reading = readFatigue(state, cfg, t);
	check(
		"checks going wrong on material they were getting right is a signal",
		reading.signals.some((s) => s.includes("checks are going wrong")),
		JSON.stringify(reading.signals),
	);
}

// ---------------------------------------------------------------- breaks

{
	const now = Date.now();
	const state = session({ now });
	replies(state, 3, { latencyMs: 5_000, length: 240, from: now + MIN });
	replies(state, 3, { latencyMs: 40_000, length: 30, from: now + 10 * MIN });
	check("fatigue is readable before the break", readFatigue(state, cfg, now + 20 * MIN).score >= 2);

	resetFatigue(state);
	check(
		"a break clears the reading",
		readFatigue(state, cfg, now + 20 * MIN).score === 0,
		"latencies from before a break describe someone who has since stopped",
	);

	const breakStart = now + 20 * MIN;
	state.status = "break";
	state.block.breakStartedAt = breakStart;
	state.lastCheckinAt = breakStart;
	check("no nudge while the break is running", decideCheckin(state, cfg, breakStart + 5 * MIN) === null);
	const over = decideCheckin(state, cfg, breakStart + cfg.breakMin * MIN + cfg.checkinCooldownMin * MIN);
	check("a nudge once the break has run out", over?.kind === "break-over");
	const text = renderCheckin(state, over, cfg, breakStart + 20 * MIN);
	check("the break-over nudge names where they left off", text.includes("where they left off"));
	check("the break-over nudge does not restart the material", text.includes("Do not restart"));
}

// ---------------------------------------------------------------- long breaks

{
	check("normal blocks get the short break", breakLengthFor(1, cfg) === cfg.breakMin * MIN);
	check("every third block gets the long break", breakLengthFor(cfg.blocksBeforeLongBreak, cfg) === cfg.longBreakMin * MIN);
}

// ---------------------------------------------------------------- silence

{
	const now = Date.now();
	const idle = newState("test-idle", "/tmp");
	check("an idle session is never interrupted", decideCheckin(idle, cfg, now) === null, "this plugin loads into every session");
	check("an idle session shows nothing in the status line", renderStatusline(idle, cfg, now) === "");
	check("an idle session has nothing to restore", renderResume(idle, cfg, now) === "");

	const off = session({ now });
	off.status = "off";
	check("a session switched off is never interrupted", decideCheckin(off, cfg, now + 3 * cfg.workMin * MIN) === null);

	const disabled = session({ now });
	check(
		"the master switch silences the clock",
		decideCheckin(disabled, { ...cfg, enabled: false }, now + 3 * cfg.workMin * MIN) === null,
	);
}

// ---------------------------------------------------------------- status line

{
	const now = Date.now();
	const state = session({ now });
	const early = renderStatusline(state, cfg, now + 5 * MIN, { color: false });
	check("the status line shows the block and the time left", early === "adhd 5m · blk1 · 40m left", early);

	const late = renderStatusline(state, cfg, now + (cfg.workMin + 7) * MIN, { color: false });
	check("the status line shows how far past the block they are", late.includes("+7m over"), late);

	replies(state, 3, { latencyMs: 5_000, length: 240, from: now + MIN });
	replies(state, 3, { latencyMs: 30_000, length: 40, from: now + 5 * MIN });
	const tired = renderStatusline(state, cfg, now + 10 * MIN, { color: false });
	check("the status line carries the fatigue score", /fatigue \d\/3/.test(tired), tired);
}

// ---------------------------------------------------------------- the CLI, for real

{
	const dir = mkdtempSync(join(tmpdir(), "claude-adhd-test-"));
	const env = { ...process.env, ADHD_STATE_DIR: dir, NO_COLOR: "1" };
	const run = (args, input = "") =>
		// cwd matters: the verbs find their session through the working-directory
		// map the session-start hook wrote, exactly as `/adhd` does from Bash.
		execFileSync(process.execPath, [BIN, ...args], { env, input, encoding: "utf8", cwd: dir });

	const event = JSON.stringify({ session_id: "cli-test", cwd: dir });

	run(["hook", "session-start"], event);
	check("session-start is silent for a session that never ran /adhd", run(["hook", "session-start"], event).trim() === "");

	const started = run(["start", "reading the eigenvalue chapter"]);
	check("start reports the block length", started.includes("Focus block 1 of 45m"), started);

	run(["hook", "stop"], event);
	const submit = run(["hook", "prompt-submit"], JSON.stringify({ session_id: "cli-test", cwd: dir, prompt: "ok go on" }));
	check("a healthy prompt injects nothing", submit.trim() === "", submit);

	const status = run(["status"]);
	check("status names the task", status.includes("reading the eigenvalue chapter"), status);
	check("status admits it does not have a reading yet", status.includes("replies needed for a reading"), status);

	const line = run(["statusline"], event).trim();
	check("the status line renders from real state", line.startsWith("adhd "), line);

	run(["check", "pass", "stated the definition unprompted"]);
	run(["note", "eigenvector as the direction that survives the map"]);
	const done = run(["done"]);
	check("done prints what landed", done.includes("eigenvector as the direction that survives the map"), done);
	check("done counts the checks", done.includes("1 of 1 passed"), done);

	const log = run(["log"]);
	check("the day's log lists the session", log.includes("reading the eigenvalue chapter"), log);

	const after = run(["status"]);
	check("a finished session is finished", after.includes("No ADHD session is running"), after);

	// The whole path, with the clock wound back: a state file that says the
	// block ran out is enough to make the prompt-submit hook emit a check-in as
	// Claude Code will actually receive it.
	{
		const sessionFile = join(dir, "sessions", "cli-test.json");
		run(["start", "the eigenvalue chapter"]);
		const state = JSON.parse(readFileSync(sessionFile, "utf8"));
		const longAgo = Date.now() - (DEFAULTS.workMin + 3) * MIN;
		state.startedAt = longAgo;
		state.block.startedAt = longAgo;
		writeFileSync(sessionFile, JSON.stringify(state));

		const raw = run(["hook", "prompt-submit"], JSON.stringify({ session_id: "cli-test", cwd: dir, prompt: "keep going" }));
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch {
			parsed = null;
		}
		check("the hook emits well-formed hook output", parsed?.hookSpecificOutput?.hookEventName === "UserPromptSubmit", raw);
		const injected = parsed?.hookSpecificOutput?.additionalContext ?? "";
		check("the overdue block reaches Claude as a check-in", injected.includes("[adhd check-in"), injected);
		check("the check-in names the block", injected.includes("Focus block 1 has run"), injected);
		check("the check-in names the anchor", injected.includes("the eigenvalue chapter"), injected);

		const again = run(["hook", "prompt-submit"], JSON.stringify({ session_id: "cli-test", cwd: dir, prompt: "yes carry on" }));
		check("the very next prompt is not nagged", again.trim() === "", again);

		run(["done"]);
	}

	// A hook must never break a session, whatever it is fed.
	for (const garbage of ["", "not json", "{}", '{"session_id":null}']) {
		for (const name of ["session-start", "prompt-submit", "stop", "session-end"]) {
			try {
				run(["hook", name], garbage);
			} catch (error) {
				failures.push(`hook ${name} threw on ${JSON.stringify(garbage)}: ${error.message}`);
			}
		}
	}
	check("hooks survive malformed input", true);

	rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------- report

if (failures.length) {
	process.stderr.write(`\n${failures.length} failure${failures.length === 1 ? "" : "s"}:\n`);
	for (const failure of failures) process.stderr.write(`  ✗ ${failure}\n`);
	process.stderr.write(`\n${passed} passed, ${failures.length} failed\n`);
	process.exit(1);
}

process.stdout.write(`${passed} checks passed\n`);
