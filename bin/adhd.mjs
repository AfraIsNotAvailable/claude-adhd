#!/usr/bin/env node
/**
 * claude-adhd — one entry point for everything.
 *
 * Claude Code's hooks call it with `hook <event>` and feed it the event JSON on
 * stdin. The `/adhd` command calls it with a verb through the Bash tool. The
 * status line calls it with `statusline`. There is no daemon, no port, no
 * dependency: the whole engine is this file plus lib/, and its only durable
 * state is JSON under the XDG state directory.
 *
 * The one hard rule: a hook must never break a session. Every path here is
 * wrapped so that a malformed state file, a missing directory, or a bug in the
 * fatigue maths costs the user nothing worse than a missing check-in. Failures
 * exit 0 and say nothing.
 */

import { readFileSync } from "node:fs";
import { loadConfig, MIN } from "../lib/config.mjs";
import { breakElapsed, focusElapsed, formatDuration, newBlock, sessionElapsed, startNextBlock } from "../lib/blocks.mjs";
import {
	decideCheckin,
	markCheckinRaised,
	renderBackFromBreak,
	renderBreakElapsed,
	renderCheckin,
	renderResume,
} from "../lib/checkin.mjs";
import { noteCheck, noteReply, noteTurnEnd, readFatigue, resetFatigue } from "../lib/fatigue.mjs";
import { renderStatusline } from "../lib/statusline.mjs";
import {
	appendLog,
	ensureLauncher,
	loadOrCreate,
	logPathFor,
	newState,
	prune,
	readState,
	resolveSessionId,
	writeState,
} from "../lib/state.mjs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN_DIR = dirname(fileURLToPath(import.meta.url));

const cfg = loadConfig();

function readStdin() {
	try {
		return readFileSync(0, "utf8");
	} catch {
		return "";
	}
}

function readEvent() {
	const raw = readStdin().trim();
	if (!raw) return {};
	try {
		return JSON.parse(raw);
	} catch {
		return {};
	}
}

/** UserPromptSubmit and SessionStart both take extra context this way. */
function emitContext(eventName, text) {
	if (!text) return;
	process.stdout.write(
		`${JSON.stringify({
			hookSpecificOutput: { hookEventName: eventName, additionalContext: text },
		})}\n`,
	);
}

function promptText(event) {
	const p = event.prompt;
	if (typeof p === "string") return p;
	if (Array.isArray(p)) {
		return p
			.filter((c) => c && c.type === "text" && typeof c.text === "string")
			.map((c) => c.text)
			.join(" ");
	}
	return "";
}

/**
 * A session picked up hours later is a new sitting, not a long one.
 *
 * Carrying the old block over would report six hours of focus for a laptop
 * that was shut, and carrying the old latencies over would declare exhaustion
 * on the first question after a night's sleep.
 */
function reviveIfStale(state, now = Date.now()) {
	if (state.status !== "focus" && state.status !== "break") return false;
	const idleFor = now - (state.lastActivityAt ?? state.createdAt ?? now);
	if (idleFor < cfg.staleResumeMin * MIN) return false;

	state.sittings = state.sittings ?? [];
	state.sittings.push({
		startedAt: state.startedAt,
		endedAt: state.lastActivityAt,
		blocks: state.block?.index ?? 0,
		turns: state.turns,
	});
	state.startedAt = now;
	state.status = "focus";
	state.block = newBlock(1, cfg, now);
	state.turns = 0;
	state.lastCheckinAt = 0;
	resetFatigue(state);
	state.lastActivityAt = now;
	return true;
}

function requireRunning(state) {
	if (!state || (state.status !== "focus" && state.status !== "break")) {
		out("No ADHD session is running. Start one with `/adhd <what you are working on>`.");
		return false;
	}
	return true;
}

function out(text) {
	process.stdout.write(`${text}\n`);
}

// ---------------------------------------------------------------- hooks

function hookSessionStart(event) {
	const sessionId = event.session_id ?? resolveSessionId({});
	if (!sessionId) return;
	const cwd = event.cwd ?? process.cwd();
	const state = readState(sessionId) ?? newState(sessionId, cwd);
	state.cwd = cwd;

	// A compaction wipes the anchor out of context while the session keeps
	// running, so that is exactly when it needs putting back.
	reviveIfStale(state);
	writeState(state);
	prune();
	// So `/adhd` can find the engine from the Bash tool, wherever it is installed.
	try {
		ensureLauncher(join(BIN_DIR, "adhd"));
	} catch {
		// A read-only state directory is not a reason to fail a session start.
	}

	emitContext("SessionStart", renderResume(state, cfg));
}

function hookPromptSubmit(event) {
	const sessionId = event.session_id ?? resolveSessionId({ cwd: event.cwd });
	if (!sessionId) return;
	const state = readState(sessionId);
	if (!state) return;

	if (state.status !== "focus" && state.status !== "break") {
		// Idle, off or finished: measure nothing, say nothing, cost nothing.
		return;
	}

	const now = Date.now();
	const revived = reviveIfStale(state, now);
	let context = "";

	if (revived) {
		context = renderResume(state, cfg, now);
	} else if (state.status === "break") {
		// Talking is working. A message ends the break — whether the timer ran
		// out or they came back early — so nobody has to remember `/adhd resume`.
		const breakMs = state.block?.breakMs ?? 0;
		const elapsed = breakElapsed(state, now);
		startNextBlock(state, cfg, now);
		resetFatigue(state);
		context = renderBackFromBreak(state, { early: elapsed < breakMs, elapsed, breakMs }, cfg, now);
	} else {
		noteReply(state, promptText(event), cfg, now);
		const decision = decideCheckin(state, cfg, now);
		if (decision) {
			markCheckinRaised(state, decision.kind, now);
			context = renderCheckin(state, decision, cfg, now);
		}
	}

	writeState(state);
	emitContext("UserPromptSubmit", context);
}

function hookStop(event) {
	const sessionId = event.session_id ?? resolveSessionId({});
	if (!sessionId) return;
	const state = readState(sessionId);
	if (!state || state.status !== "focus") return;
	noteTurnEnd(state);
	writeState(state);
}

function hookSessionEnd(event) {
	const sessionId = event.session_id ?? resolveSessionId({});
	if (!sessionId) return;
	const state = readState(sessionId);
	if (!state || (state.status !== "focus" && state.status !== "break")) return;

	// The record is snapshotted but the session is left open: exiting the
	// terminal is not the same as finishing, and a resume must not find a
	// closed session. `clear` and `logout` genuinely end it.
	state.lastActivityAt = Date.now();
	const reason = event.reason ?? "other";
	if (reason === "clear" || reason === "logout") {
		finish(state, `session ${reason}`);
	} else {
		writeState(state);
	}
}

function finish(state, why) {
	const now = Date.now();
	state.endedAt = now;
	state.status = "done";
	writeState(state);
	appendLog({
		at: new Date(now).toISOString(),
		sessionId: state.sessionId,
		task: state.task,
		cwd: state.cwd,
		elapsedMs: sessionElapsed(state, now),
		blocks: state.block?.index ?? 0,
		turns: state.turns,
		checks: state.checks.length,
		checksPassed: state.checks.filter((c) => c.passed).length,
		checkins: state.checkins.length,
		notes: state.notes,
		why,
	});
}

// ---------------------------------------------------------------- verbs

function cmdStart(args) {
	const task = args.join(" ").trim();
	if (!task) {
		out("Usage: adhd start <what you are working on>");
		process.exitCode = 1;
		return;
	}
	const now = Date.now();
	const state = loadOrCreate({ cwd: process.cwd() }) ?? newState(`local-${now}`, process.cwd());

	state.task = task;
	state.status = "focus";
	state.startedAt = now;
	state.endedAt = null;
	state.block = newBlock(1, cfg, now);
	state.turns = 0;
	state.lastCheckinAt = 0;
	state.checkins = [];
	state.notes = [];
	resetFatigue(state);
	state.lastActivityAt = now;
	writeState(state);

	out(
		`ADHD session started: "${task}"\n` +
			`Focus block 1 of ${cfg.workMin}m, then a ${formatDuration(state.block.breakMs)} break. ` +
			`Every ${cfg.blocksBeforeLongBreak} blocks the break is ${cfg.longBreakMin}m.\n` +
			"Latency, reply length and check accuracy are being measured from now on.",
	);
}

function cmdStatus() {
	const state = loadOrCreate({ cwd: process.cwd() });
	if (!state || (state.status !== "focus" && state.status !== "break")) {
		out("No ADHD session is running.");
		return;
	}
	const now = Date.now();
	const reading = readFatigue(state, cfg, now);
	const lines = [`Task: ${state.task ?? "(none)"}`, `Elapsed: ${formatDuration(sessionElapsed(state, now))}`];

	if (state.status === "break") {
		const elapsed = breakElapsed(state, now);
		const total = state.block.breakMs;
		lines.push(
			elapsed >= total
				? `Break: over by ${formatDuration(elapsed - total)} — \`/adhd resume\` when ready`
				: `Break: ${formatDuration(elapsed)} of ${formatDuration(total)}`,
		);
	} else {
		const left = state.block.workMs - focusElapsed(state, now);
		lines.push(
			`Block ${state.block.index}: ${formatDuration(focusElapsed(state, now))} of ${formatDuration(state.block.workMs)}` +
				(left >= 0 ? ` (${formatDuration(left)} left)` : ` (${formatDuration(-left)} over)`),
		);
	}

	lines.push(
		reading.score > 0
			? `Fatigue: ${reading.score}/3 — ${reading.signals.join("; ")}`
			: `Fatigue: 0/3 (${reading.samples} of ${cfg.fatigueMinSamples} replies needed for a reading)`,
	);
	if (state.checks.length) {
		lines.push(`Checks: ${state.checks.filter((c) => c.passed).length} of ${state.checks.length} passed`);
	}
	if (state.notes.length) lines.push(`Beats logged: ${state.notes.length}`);
	out(lines.join("\n"));
}

function cmdBreak(args) {
	const state = loadOrCreate({ cwd: process.cwd() });
	if (!requireRunning(state)) return;
	const now = Date.now();
	const minutes = Number(args[0]);
	if (Number.isFinite(minutes) && minutes > 0) state.block.breakMs = minutes * MIN;
	state.status = "break";
	state.block.breakStartedAt = now;
	state.block.breakNudges = 0;
	state.lastCheckinAt = now;
	state.lastActivityAt = now;
	writeState(state);
	out(
		`Break started: ${formatDuration(state.block.breakMs)}. Just talk again when you are back — ` +
			"the next block starts on your first message, no command needed.",
	);
}

function cmdResume() {
	const state = loadOrCreate({ cwd: process.cwd() });
	if (!state || state.status === "done" || state.status === "idle") {
		out("No ADHD session to resume. Start one with `/adhd <what you are working on>`.");
		return;
	}
	const now = Date.now();
	const block = startNextBlock(state, cfg, now);
	// A break is the whole point of the reading resetting: the latencies from
	// before it describe a person who has since stopped and come back.
	resetFatigue(state);
	writeState(state);
	out(`Focus block ${block.index} started: ${formatDuration(block.workMs)}, then ${formatDuration(block.breakMs)} off.`);
}

function cmdCheck(args) {
	const state = loadOrCreate({ cwd: process.cwd() });
	if (!requireRunning(state)) return;
	const verdict = (args[0] ?? "").toLowerCase();
	if (verdict !== "pass" && verdict !== "fail") {
		out("Usage: adhd check pass|fail [what was checked]");
		process.exitCode = 1;
		return;
	}
	noteCheck(state, verdict === "pass", cfg);
	const label = args.slice(1).join(" ").trim();
	if (label) state.notes.push({ at: Date.now(), kind: `check-${verdict}`, text: label });
	writeState(state);
	const reading = readFatigue(state, cfg);
	out(
		`Recorded: ${verdict}${label ? ` (${label})` : ""}.` +
			(reading.score >= cfg.fatigueThreshold ? ` Fatigue ${reading.score}/3: ${reading.signals.join("; ")}.` : ""),
	);
}

function cmdNote(args) {
	const state = loadOrCreate({ cwd: process.cwd() });
	if (!requireRunning(state)) return;
	const text = args.join(" ").trim();
	if (!text) {
		out("Usage: adhd note <one line about what just landed>");
		process.exitCode = 1;
		return;
	}
	state.notes.push({ at: Date.now(), kind: "beat", text });
	writeState(state);
	out(`Logged (${state.notes.length} so far).`);
}

function cmdDone() {
	const state = loadOrCreate({ cwd: process.cwd() });
	if (!requireRunning(state)) return;
	const now = Date.now();
	const elapsed = sessionElapsed(state, now);
	const beats = state.notes.filter((n) => n.kind === "beat");
	finish(state, "user ended");

	const lines = [
		`Session closed: "${state.task}"`,
		`${formatDuration(elapsed)} across ${state.block?.index ?? 1} block${(state.block?.index ?? 1) === 1 ? "" : "s"}, ${state.turns} exchanges.`,
	];
	if (state.checks.length) {
		lines.push(`Checks: ${state.checks.filter((c) => c.passed).length} of ${state.checks.length} passed.`);
	}
	if (beats.length) {
		lines.push("What landed:");
		for (const beat of beats) lines.push(`  • ${beat.text}`);
	}
	lines.push(`Logged to ${logPathFor()}`);
	out(lines.join("\n"));
}

function cmdOff() {
	const state = loadOrCreate({ cwd: process.cwd() });
	if (!state) {
		out("Nothing to switch off.");
		return;
	}
	state.status = "off";
	state.lastActivityAt = Date.now();
	writeState(state);
	out("ADHD timer off for this session. Nothing measured, nothing injected. `/adhd resume` brings it back.");
}

function cmdLog(args) {
	const day = args[0] ? new Date(args[0]) : new Date();
	const path = logPathFor(Number.isNaN(day.getTime()) ? new Date() : day);
	let raw;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		out(`No sessions logged in ${path}.`);
		return;
	}
	const entries = raw
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			try {
				return JSON.parse(line);
			} catch {
				return null;
			}
		})
		.filter(Boolean);
	if (!entries.length) {
		out(`No sessions logged in ${path}.`);
		return;
	}
	const total = entries.reduce((a, e) => a + (e.elapsedMs ?? 0), 0);
	const lines = [`${entries.length} session${entries.length === 1 ? "" : "s"}, ${formatDuration(total)} total:`];
	for (const entry of entries) {
		lines.push(`  ${entry.at.slice(11, 16)}  ${formatDuration(entry.elapsedMs)}  ${entry.task ?? "(no task)"}`);
	}
	out(lines.join("\n"));
}

function cmdConfig() {
	out(
		[
			"Effective configuration:",
			...Object.entries(cfg).map(([k, v]) => `  ${k} = ${Array.isArray(v) ? `[${v.join(", ")}]` : v}`),
			"",
			"Override with environment variables (ADHD_WORK_MIN, ADHD_BREAK_MIN, ADHD_FATIGUE_THRESHOLD, …)",
			"or a JSON file at ~/.config/claude-adhd/config.json using the same keys.",
		].join("\n"),
	);
}

function cmdStatusline() {
	const event = readEvent();
	const sessionId = event.session_id ?? resolveSessionId({ cwd: event.cwd ?? event.workspace?.current_dir });
	const state = sessionId ? readState(sessionId) : undefined;
	const line = renderStatusline(state, cfg, Date.now(), { color: !process.env.NO_COLOR });
	if (line) process.stdout.write(`${line}\n`);
}


/**
 * Block until the break is over, so Claude can background this and be woken.
 *
 * This is the one place the engine speaks first, and the only mechanism that
 * needed anything beyond the hooks: hooks fire on events, and a break ending
 * is not an event — nobody types, nobody stops. Claude runs this with the Bash
 * tool in the background and the harness re-invokes it when the process exits.
 * No daemon, no scheduler, no notification service; the wait is a sleeping
 * node process that the session owns.
 *
 * It re-reads the state each tick rather than sleeping once, so changing the
 * break length or coming back early ends the wait instead of pinging someone
 * who is already back.
 */
async function cmdAwaitBreak() {
	const initial = loadOrCreate({ cwd: process.cwd() });
	if (!initial || initial.status !== "break") {
		out("Not on a break — nothing to wait for. Do not ping them.");
		return;
	}
	const sessionId = initial.sessionId;
	// The Bash tool caps a run at ten minutes, so a long break is waited out in
	// stages: this exits early and asks to be re-armed rather than being killed
	// halfway through and never reporting.
	const CAP_MS = 9 * 60 * 1000;
	const until = Date.now() + CAP_MS;

	for (;;) {
		const state = readState(sessionId);
		if (!state || state.status !== "break") {
			out("They came back before the break ended. Do not ping them.");
			return;
		}
		const breakMs = state.block?.breakMs ?? 0;
		const remaining = breakMs - breakElapsed(state, Date.now());
		if (remaining <= 0) {
			out(renderBreakElapsed(state, breakMs));
			return;
		}
		const left = until - Date.now();
		if (left <= 0) {
			out(
				`Still ${formatDuration(remaining)} of the break left, and this wait has hit its limit. ` +
					"Say nothing to the user and start another background `await-break` to keep waiting.",
			);
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, Math.max(500, Math.min(remaining, left, 5_000))));
	}
}

const USAGE = `claude-adhd — an ADHD focus timer and check-in engine for Claude Code

  adhd start <task>      begin a focus session anchored on a task
  adhd status            elapsed time, block, fatigue reading
  adhd break [minutes]   start a break (defaults to the configured length)
  adhd resume            end the break, start the next focus block
  adhd await-break       block until the break is over (run it in the background)
  adhd check pass|fail   record the outcome of a comprehension question
  adhd note <text>       log one line about what just landed
  adhd done              close the session and print what happened
  adhd off               stop measuring for this session
  adhd log [YYYY-MM-DD]  what was worked on, and for how long
  adhd config            show effective settings
  adhd selftest          run the self-test (no network, no model, ~1s)
  adhd statusline        render the status-line segment (reads event JSON on stdin)
  adhd hook <event>      internal: called by Claude Code hooks`;

function main() {
	const [verb, ...args] = process.argv.slice(2);

	switch (verb) {
		case "hook": {
			const event = readEvent();
			const name = args[0] ?? event.hook_event_name;
			if (name === "session-start" || name === "SessionStart") hookSessionStart(event);
			else if (name === "prompt-submit" || name === "UserPromptSubmit") hookPromptSubmit(event);
			else if (name === "stop" || name === "Stop") hookStop(event);
			else if (name === "session-end" || name === "SessionEnd") hookSessionEnd(event);
			return;
		}
		case "statusline":
			return cmdStatusline();
		case "dispatch": {
			// `/adhd <anything>`: a known verb is a verb, everything else is the
			// name of the thing they are about to work on. Keeps the command file
			// from having to guess.
			const known = new Set(["status", "break", "resume", "check", "note", "done", "wrap", "off", "log", "config", "start"]);
			const [first, ...rest] = args;
			if (first && known.has(first.toLowerCase())) {
				process.argv = [process.argv[0], process.argv[1], first.toLowerCase(), ...rest];
				return main();
			}
			return cmdStart(args);
		}
		case "start":
			return cmdStart(args);
		case "status":
			return cmdStatus();
		case "break":
			return cmdBreak(args);
		case "resume":
			return cmdResume();
		case "await-break":
			return cmdAwaitBreak();
		case "check":
			return cmdCheck(args);
		case "note":
			return cmdNote(args);
		case "done":
		case "wrap":
			return cmdDone();
		case "off":
			return cmdOff();
		case "log":
			return cmdLog(args);
		case "config":
			return cmdConfig();
		case "selftest":
			// Runs in-process so the installer can check the engine works using
			// whatever node the launcher found, rather than hoping for one on PATH.
			return void import(join(BIN_DIR, "..", "test", "selftest.mjs"));
		default:
			out(USAGE);
			if (verb) process.exitCode = 1;
	}
}

function fail(error) {
	if (process.argv[2] !== "hook" && process.argv[2] !== "statusline") {
		process.stderr.write(`adhd: ${error?.message ?? error}\n`);
		process.exitCode = 1;
	}
}

try {
	const result = main();
	if (result && typeof result.then === "function") result.catch(fail);
} catch (error) {
	// A hook that throws is a hook that breaks somebody's session. The verbs
	// are allowed to complain on stderr; hooks stay silent and exit 0.
	fail(error);
}
