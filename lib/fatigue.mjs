/**
 * Fatigue as a measurement, ported from pi-learn's `fatigue.ts`.
 *
 * The reasoning it was built on holds here unchanged: an agent asked to watch
 * for fatigue has no clock and cannot see reply latency, so a model told to
 * "notice when they are flagging" will invent it, which is worse than not
 * watching at all. So the hooks measure it and hand the reading over at the
 * one moment it can change what the agent does next.
 *
 * Three signals, all relative to how *this* session started, because one
 * person's thirty-second answer is another's five:
 *
 *   1. latency  — the gap between Claude finishing a turn and the reply landing
 *   2. length   — characters in the reply
 *   3. accuracy — comprehension checks that used to pass and now do not
 *
 * The first two come free from the Stop and UserPromptSubmit hooks. The third
 * only exists if Claude is asking questions and recording the outcome, which
 * is why the skill tells it to.
 */

import { MIN } from "./config.mjs";

export function noteTurnEnd(state, now = Date.now()) {
	state.turnEndedAt = now;
	state.lastActivityAt = now;
}

export function noteReply(state, text, cfg, now = Date.now()) {
	state.turns += 1;
	state.lastActivityAt = now;
	const endedAt = state.turnEndedAt;
	state.turnEndedAt = null;
	if (!endedAt) return;

	const latencyMs = now - endedAt;
	// A reply after an hour is a break already taken, not a slow answer; it
	// would swamp the mean and declare exhaustion on a rested person.
	if (latencyMs > cfg.maxSampleMin * MIN) return;

	state.samples.push({ latencyMs, length: String(text ?? "").trim().length, at: now });
	trim(state.samples, cfg.fatigueWindow * 2);
}

export function noteCheck(state, passed, cfg, now = Date.now()) {
	state.checks.push({ passed: !!passed, at: now });
	trim(state.checks, cfg.fatigueWindow * 2);
}

export function resetFatigue(state) {
	state.samples = [];
	state.checks = [];
	state.turnEndedAt = null;
}

function trim(list, max) {
	if (list.length > max) list.splice(0, list.length - max);
}

function mean(values) {
	return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

/**
 * Compare the recent half of the window against the earlier half.
 *
 * @returns {{score:number, signals:string[], minutes:number, samples:number}}
 */
export function readFatigue(state, cfg, now = Date.now()) {
	const window = state.samples.slice(-cfg.fatigueWindow);
	const minutes = window.length ? Math.round((now - window[0].at) / MIN) : 0;
	if (window.length < cfg.fatigueMinSamples) {
		return { score: 0, signals: [], minutes, samples: window.length };
	}

	const half = Math.floor(window.length / 2);
	const early = window.slice(0, half);
	const late = window.slice(half);
	const signals = [];

	const earlyLatency = mean(early.map((s) => s.latencyMs));
	const lateLatency = mean(late.map((s) => s.latencyMs));
	if (earlyLatency > 0 && lateLatency > earlyLatency * cfg.latencyRatio) {
		signals.push(`replies are taking ${Math.round(lateLatency / 1000)}s against ${Math.round(earlyLatency / 1000)}s earlier`);
	}

	const earlyLength = mean(early.map((s) => s.length));
	const lateLength = mean(late.map((s) => s.length));
	if (earlyLength > 0 && lateLength < earlyLength * cfg.lengthRatio) {
		signals.push(`replies are getting shorter (${Math.round(lateLength)} chars against ${Math.round(earlyLength)})`);
	}

	const checks = state.checks.slice(-cfg.fatigueWindow);
	if (checks.length >= cfg.fatigueMinSamples) {
		const cHalf = Math.floor(checks.length / 2);
		const earlyRate = mean(checks.slice(0, cHalf).map((c) => (c.passed ? 1 : 0)));
		const lateRate = mean(checks.slice(cHalf).map((c) => (c.passed ? 1 : 0)));
		if (earlyRate >= 0.6 && lateRate < earlyRate - cfg.accuracyDrop) {
			signals.push(`checks are going wrong on material they were getting right (${Math.round(lateRate * 100)}% now)`);
		}
	}

	return { score: signals.length, signals, minutes, samples: window.length };
}
