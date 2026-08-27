/**
 * The passive surface: one segment for the Claude Code status line.
 *
 * Silent unless a session is running. It is the only place the reading is
 * visible without Claude saying anything, which matters — being told "you are
 * slowing down" by a machine that is right about it is useful, and a glanceable
 * number is how you find out without being interrupted.
 */

import { breakElapsed, focusElapsed, formatDuration, sessionElapsed } from "./blocks.mjs";
import { readFatigue } from "./fatigue.mjs";

const ESC = "\u001b";
const DIM = `${ESC}[2m`;
const AMBER = `${ESC}[33m`;
const RED = `${ESC}[31m`;
const RESET = `${ESC}[0m`;

function paint(text, color, enabled) {
	return enabled ? `${color}${text}${RESET}` : text;
}

export function renderStatusline(state, cfg, now = Date.now(), { color = true } = {}) {
	if (!state) return "";
	if (state.status !== "focus" && state.status !== "break") return "";

	const reading = readFatigue(state, cfg, now);
	const parts = [];

	if (state.status === "break") {
		const elapsed = breakElapsed(state, now);
		const total = state.block?.breakMs ?? 0;
		if (elapsed >= total) {
			parts.push(paint(`adhd break over +${formatDuration(elapsed - total)}`, AMBER, color));
		} else {
			parts.push(paint(`adhd break ${formatDuration(elapsed)}/${formatDuration(total)}`, DIM, color));
		}
	} else {
		const elapsed = focusElapsed(state, now);
		const total = state.block?.workMs ?? 0;
		const left = total - elapsed;
		parts.push(paint(`adhd ${formatDuration(sessionElapsed(state, now))}`, DIM, color));
		parts.push(paint(`blk${state.block?.index ?? 1}`, DIM, color));
		parts.push(
			left >= 0 ? paint(`${formatDuration(left)} left`, DIM, color) : paint(`+${formatDuration(-left)} over`, AMBER, color),
		);
	}

	if (reading.score > 0) {
		const label = `fatigue ${reading.score}/3`;
		parts.push(paint(label, reading.score >= cfg.fatigueThreshold ? RED : AMBER, color));
	}

	return parts.join(paint(" · ", DIM, color));
}
