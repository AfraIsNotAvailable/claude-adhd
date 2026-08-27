/**
 * The clock half of the timer: focus blocks and breaks.
 *
 * Deliberately dumb. A block starts, a block ends, a break starts, a break
 * ends. The interesting judgement lives in checkin.mjs, which decides whether
 * a boundary is worth interrupting for.
 */

import { MIN } from "./config.mjs";

export function newBlock(index, cfg, now = Date.now()) {
	return {
		index,
		startedAt: now,
		workMs: cfg.workMin * MIN,
		breakStartedAt: null,
		breakMs: breakLengthFor(index, cfg),
		clockNudges: 0,
		breakNudges: 0,
	};
}

/** Every Nth break is a long one — the point of the count is that it is not all the same. */
export function breakLengthFor(index, cfg) {
	const long = cfg.blocksBeforeLongBreak > 0 && index % cfg.blocksBeforeLongBreak === 0;
	return (long ? cfg.longBreakMin : cfg.breakMin) * MIN;
}

export function focusElapsed(state, now = Date.now()) {
	if (!state.block) return 0;
	return now - state.block.startedAt;
}

export function breakElapsed(state, now = Date.now()) {
	if (!state.block?.breakStartedAt) return 0;
	return now - state.block.breakStartedAt;
}

/** Total wall clock since `/adhd <task>`, breaks included. Time blindness needs the honest number. */
export function sessionElapsed(state, now = Date.now()) {
	if (!state.startedAt) return 0;
	return (state.endedAt ?? now) - state.startedAt;
}

export function overdueBy(state, now = Date.now()) {
	if (!state.block || state.status !== "focus") return -Infinity;
	return focusElapsed(state, now) - state.block.workMs;
}

export function formatDuration(ms) {
	const totalMin = Math.max(0, Math.round(ms / MIN));
	if (totalMin < 60) return `${totalMin}m`;
	const h = Math.floor(totalMin / 60);
	const m = totalMin % 60;
	return m ? `${h}h${String(m).padStart(2, "0")}` : `${h}h`;
}
