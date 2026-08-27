/**
 * Configuration: defaults, a JSON file, and environment overrides.
 *
 * Precedence: env > ~/.config/claude-adhd/config.json > defaults.
 *
 * Everything here is a number of minutes or a ratio, because everything the
 * engine decides is either "how long has this gone on" or "how much worse is
 * this than it was". Nothing here is a model, a key, or a network call.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CONFIG_PATH =
	process.env.ADHD_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "claude-adhd", "config.json");

export const DEFAULTS = {
	/** Focus block length. The clock half of the timer. */
	workMin: 45,
	/** Break after a normal block. */
	breakMin: 10,
	/** After this many blocks the break gets longer. */
	blocksBeforeLongBreak: 3,
	longBreakMin: 25,

	/** Never raise two check-ins closer together than this. */
	checkinCooldownMin: 8,
	/** A clock check-in that was not acted on repeats on this ladder, in minutes past the boundary. */
	clockNudgeLadderMin: [0, 15, 30, 60],
	/** Once a break is over, remind this often until they resume. */
	breakOverRepeatMin: 5,

	/** Fatigue: only the last N replies matter — it is a trend, not a history. */
	fatigueWindow: 6,
	/** Below this many replies there is no trend, only noise. */
	fatigueMinSamples: 4,
	/** Late replies this much slower than early ones count as a signal. */
	latencyRatio: 1.6,
	/** Late replies this much shorter than early ones count as a signal. */
	lengthRatio: 0.55,
	/** Comprehension checks dropping by this much counts as a signal. */
	accuracyDrop: 0.3,
	/** How many of the three signals must be lit before a fatigue check-in. */
	fatigueThreshold: 2,
	/** A reply after this long is a break already taken, not a slow answer. Discarded. */
	maxSampleMin: 45,

	/** A session resumed after this long starts its fatigue window fresh. */
	staleResumeMin: 45,

	/** Master switch. `adhd off` writes this to the session, not to config. */
	enabled: true,
};

const NUMERIC = new Set(
	Object.entries(DEFAULTS)
		.filter(([, v]) => typeof v === "number")
		.map(([k]) => k),
);

/** ADHD_WORK_MIN -> workMin */
function envKey(key) {
	return `ADHD_${key.replace(/([A-Z])/g, "_$1").toUpperCase()}`;
}

let cached;

export function loadConfig() {
	if (cached) return cached;
	const config = { ...DEFAULTS };

	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
		for (const [key, value] of Object.entries(raw)) {
			if (key in DEFAULTS) config[key] = value;
		}
	} catch {
		// No config file is the normal case. A malformed one is not worth
		// failing a hook over — a broken hook would break the whole session.
	}

	for (const key of Object.keys(DEFAULTS)) {
		const raw = process.env[envKey(key)];
		if (raw === undefined || raw === "") continue;
		if (NUMERIC.has(key)) {
			const n = Number(raw);
			if (Number.isFinite(n)) config[key] = n;
		} else if (typeof DEFAULTS[key] === "boolean") {
			config[key] = raw !== "0" && raw.toLowerCase() !== "false";
		}
	}

	cached = config;
	return config;
}

export const MIN = 60_000;
