/**
 * When to interrupt, and what to say when interrupting.
 *
 * Two things can trip a check-in — the clock running past a focus block, and
 * the measured signals degrading — and they are reported differently, because
 * "you have been at this 47 minutes" and "your answers have gone from 6
 * seconds to 21" are different pieces of news and only the second one is a
 * surprise.
 *
 * Everything here is advisory. Nothing blocks a prompt, nothing refuses.
 * The only pressure is that an ignored nudge comes back, on a ladder that
 * stretches rather than repeating every eight minutes, because a reminder that
 * arrives at a fixed interval stops being information and becomes noise.
 */

import { breakElapsed, focusElapsed, formatDuration, overdueBy, sessionElapsed } from "./blocks.mjs";
import { MIN } from "./config.mjs";
import { readFatigue } from "./fatigue.mjs";

/**
 * @returns {{kind:string, reading:object}|null}
 */
export function decideCheckin(state, cfg, now = Date.now()) {
	if (!state || !cfg.enabled) return null;
	// Nothing to check in about during a break. Coming back is handled by
	// resuming, not by nudging — see `renderBackFromBreak`.
	if (state.status !== "focus") return null;

	const sinceLast = now - (state.lastCheckinAt || 0);
	if (sinceLast < cfg.checkinCooldownMin * MIN) return null;

	const reading = readFatigue(state, cfg, now);
	const over = overdueBy(state, now);

	if (over >= 0) {
		const ladder = cfg.clockNudgeLadderMin;
		const step = ladder[Math.min(state.block.clockNudges, ladder.length - 1)] * MIN;
		if (over >= step) return { kind: "clock", reading };
	}

	// Fatigue fires inside a block too — the whole point of measuring is that
	// the wall clock does not know when someone ran out early.
	if (reading.score >= cfg.fatigueThreshold && sinceLast >= 2 * cfg.checkinCooldownMin * MIN) {
		return { kind: "fatigue", reading };
	}

	return null;
}

/** Record that a check-in was raised, so the ladder advances and the cooldown starts. */
export function markCheckinRaised(state, kind, now = Date.now()) {
	state.lastCheckinAt = now;
	state.checkins.push({ at: now, kind });
	if (kind === "clock" && state.block) state.block.clockNudges += 1;
}

const RECAP =
	"Give a short recap of where they are and what comes next — two or three lines, about their session, " +
	"not a generic summary — then offer the break and let them decide.";

/**
 * The text injected into Claude's context on the next prompt.
 *
 * Written as a briefing, not a script: it says what was measured and what to
 * do about it, and leaves the wording to Claude. It is prefixed so it reads as
 * instrumentation rather than as something the person typed.
 */
export function renderCheckin(state, decision, cfg, now = Date.now()) {
	const { kind, reading } = decision;
	const lines = [];
	const anchor = state.task ? `Anchor: "${state.task}".` : "";

	if (kind === "clock") {
		const over = overdueBy(state, now);
		const late = over > 60_000 ? `, ${formatDuration(over)} past the end` : "";
		lines.push(
			`Focus block ${state.block.index} has run ${formatDuration(focusElapsed(state, now))} of ${formatDuration(state.block.workMs)}${late}. ` +
				`${formatDuration(sessionElapsed(state, now))} in the session so far.`,
		);
		if (reading.score > 0) {
			lines.push(`Measured signals: ${reading.signals.join("; ")}.`);
		} else {
			lines.push("No fatigue signals — they may well be fine. This is the clock, not a diagnosis.");
		}
		lines.push(
			`${RECAP} A break here is ${formatDuration(state.block.breakMs)}; they take it with \`/adhd break\`; talking again is what ends it.`,
		);
	} else if (kind === "fatigue") {
		lines.push(
			`Fatigue signals after ${formatDuration(sessionElapsed(state, now))} (measured, not guessed): ${reading.signals.join("; ")}.`,
		);
		lines.push(
			`Say plainly what you are seeing — they should know the reading is real and not a hunch. ${RECAP} ` +
				"Do not push through it silently.",
		);
	}

	if (anchor) lines.push(anchor);

	return `[adhd check-in — instrumentation, not the user speaking]\n${lines.join("\n")}`;
}

/**
 * What Claude is told when a message arrives during a break.
 *
 * Talking is working, so the message itself ends the break — there is nothing
 * to ask permission for and nothing to nudge about. This only supplies the
 * context that a break just ended, since Claude would otherwise carry on as
 * though no time had passed.
 */
export function renderBackFromBreak(state, { early, elapsed, breakMs }, cfg, now = Date.now()) {
	const lines = [];
	if (early) {
		lines.push(
			`They came back ${formatDuration(elapsed)} into a ${formatDuration(breakMs)} break — ${formatDuration(breakMs - elapsed)} early. ` +
				"Focus block " +
				`${state.block?.index ?? 1} has started. Mention the time they have left in one clause and let it go; do not talk them into resting.`,
		);
	} else {
		const over = elapsed - breakMs;
		lines.push(
			`The ${formatDuration(breakMs)} break is done${over > 60_000 ? ` (they were away ${formatDuration(elapsed)})` : ""}. ` +
				`Focus block ${state.block?.index ?? 1} has started.`,
		);
	}
	lines.push(
		"Open with one line naming where they left off and the first concrete thing to do, then ask if they want to pick it back up. " +
			"Do not restart the material from the top and do not ask them to re-explain what they already told you.",
	);
	if (state.task) lines.push(`Anchor: "${state.task}".`);
	return `[adhd — back from a break]\n${lines.join("\n")}`;
}

/**
 * The line Claude reads when the backgrounded break timer finishes.
 *
 * The user is not at the keyboard and has sent nothing; this is the one place
 * the engine speaks first, and only because they asked it to by starting a
 * timed break.
 */
export function renderBreakElapsed(state, breakMs) {
	const lines = [
		`The ${formatDuration(breakMs)} break they asked for is up. They have not said anything — this is the timer, not them.`,
		"Say the break is over in one line, name where they left off and the first concrete thing to do, and ask if they are ready. " +
			"Then stop and wait. Do not resume teaching until they answer.",
	];
	if (state.task) lines.push(`Anchor: "${state.task}".`);
	return `[adhd — break timer finished]\n${lines.join("\n")}`;
}

/**
 * The line that restores the session after a resume or a compaction.
 *
 * Cheap and rare: it only fires when a session with a live anchor comes back,
 * which is exactly when Claude has forgotten what it was for.
 */
export function renderResume(state, cfg, now = Date.now()) {
	if (!state?.task || (state.status !== "focus" && state.status !== "break")) return "";
	const where =
		state.status === "break"
			? `on a ${formatDuration(state.block?.breakMs ?? 0)} break, ${formatDuration(breakElapsed(state, now))} in`
			: `in focus block ${state.block?.index ?? 1}, ${formatDuration(focusElapsed(state, now))} of ${formatDuration(state.block?.workMs ?? 0)}`;
	return (
		`[adhd — session restored]\nAnchor: "${state.task}". ${formatDuration(sessionElapsed(state, now))} elapsed, ${where}. ` +
		"Keep running the session the way the adhd skill describes: one thing at a time, end each turn with a question."
	);
}
