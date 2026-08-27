/**
 * Session state on disk.
 *
 * One JSON file per Claude Code session, under the XDG state directory. Hooks
 * know the session id because Claude Code hands it to them on stdin; the
 * `/adhd` command runs through the Bash tool, which does not reliably get one,
 * so a second map from working directory to session id lets the command find
 * the session the hooks are feeding.
 *
 * Every write is atomic (temp file + rename), because a hook that is killed
 * mid-write must not leave a truncated file that breaks the next hook.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const STATE_ROOT =
	process.env.ADHD_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "claude-adhd");

const SESSIONS_DIR = join(STATE_ROOT, "sessions");
const CWD_MAP_DIR = join(STATE_ROOT, "by-cwd");
const LOG_DIR = join(STATE_ROOT, "log");

function ensureDirs() {
	for (const dir of [STATE_ROOT, SESSIONS_DIR, CWD_MAP_DIR, LOG_DIR]) {
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	}
}

function safeName(id) {
	return String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 128) || "unknown";
}

function cwdKey(cwd) {
	return createHash("sha1").update(String(cwd)).digest("hex").slice(0, 16);
}

function sessionPath(sessionId) {
	return join(SESSIONS_DIR, `${safeName(sessionId)}.json`);
}

function writeJson(path, value) {
	ensureDirs();
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, "\t")}\n`, "utf8");
	renameSync(tmp, path);
}

function readJson(path) {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

/**
 * A fresh session record. `status: "idle"` means the plugin is loaded but the
 * learner never ran `/adhd` — nothing is measured and nothing is injected,
 * which is what a plugin that loads globally owes every unrelated session.
 */
export function newState(sessionId, cwd) {
	return {
		version: 1,
		sessionId,
		cwd,
		task: null,
		status: "idle",
		createdAt: Date.now(),
		startedAt: null,
		endedAt: null,
		block: null,
		turnEndedAt: null,
		lastActivityAt: Date.now(),
		lastCheckinAt: 0,
		samples: [],
		checks: [],
		notes: [],
		checkins: [],
		turns: 0,
	};
}

export function readState(sessionId) {
	if (!sessionId) return undefined;
	return readJson(sessionPath(sessionId));
}

export function writeState(state) {
	if (!state?.sessionId) return;
	writeJson(sessionPath(state.sessionId), state);
	if (state.cwd) {
		writeJson(join(CWD_MAP_DIR, `${cwdKey(state.cwd)}.json`), {
			cwd: state.cwd,
			sessionId: state.sessionId,
			at: Date.now(),
		});
	}
}

/**
 * Find the session this shell belongs to.
 *
 * Prefers an explicit id (hooks always have one), then the environment, then
 * the working-directory map. Two Claude Code sessions in the same directory
 * share the last-written map entry; the newer one wins, which is the right
 * guess and is documented rather than solved.
 */
export function resolveSessionId({ sessionId, cwd } = {}) {
	if (sessionId) return sessionId;
	const fromEnv = process.env.CLAUDE_SESSION_ID;
	if (fromEnv) return fromEnv;
	const dir = cwd ?? process.cwd();
	const mapped = readJson(join(CWD_MAP_DIR, `${cwdKey(dir)}.json`));
	if (mapped?.sessionId) return mapped.sessionId;

	// Last resort: the most recently touched session that is actually running.
	// Better than silently starting a second, invisible timer.
	try {
		const files = readdirSync(SESSIONS_DIR)
			.filter((f) => f.endsWith(".json"))
			.map((f) => ({ f, m: statSync(join(SESSIONS_DIR, f)).mtimeMs }))
			.sort((a, b) => b.m - a.m);
		for (const { f } of files) {
			const state = readJson(join(SESSIONS_DIR, f));
			if (state && state.status !== "done") return state.sessionId;
		}
	} catch {
		// No sessions directory yet.
	}
	return undefined;
}

/** Read the session for this context, creating an idle one if there is none. */
export function loadOrCreate({ sessionId, cwd }) {
	const id = resolveSessionId({ sessionId, cwd });
	if (!id) return undefined;
	return readState(id) ?? newState(id, cwd ?? process.cwd());
}

export function appendLog(entry) {
	ensureDirs();
	const day = new Date().toISOString().slice(0, 10);
	appendFileSync(join(LOG_DIR, `${day}.jsonl`), `${JSON.stringify(entry)}\n`, "utf8");
}

export function logPathFor(date = new Date()) {
	return join(LOG_DIR, `${date.toISOString().slice(0, 10)}.jsonl`);
}

/** Drop session files older than a fortnight so the state directory stays small. */
export function prune(maxAgeMs = 14 * 24 * 60 * 60 * 1000) {
	const cutoff = Date.now() - maxAgeMs;
	for (const dir of [SESSIONS_DIR, CWD_MAP_DIR]) {
		let files;
		try {
			files = readdirSync(dir);
		} catch {
			continue;
		}
		for (const file of files) {
			const path = join(dir, file);
			try {
				if (statSync(path).mtimeMs < cutoff) rmSync(path, { force: true });
			} catch {
				// Racing another hook that already removed it.
			}
		}
	}
}

/**
 * A stable path to the launcher, rewritten on every session start.
 *
 * The `/adhd` command runs through the Bash tool, which does not get the
 * plugin root in its environment, and the plugin may live in a marketplace
 * clone, a hand-installed copy, or a working tree. Rather than guess, the
 * hooks — which do know where they were run from — leave a one-line shim at a
 * fixed location that the command can always call. Self-healing: move the
 * plugin, start a session, and the shim points at the new copy.
 */
export function ensureLauncher(targetPath) {
	ensureDirs();
	const shim = join(STATE_ROOT, "adhd");
	const body = `#!/usr/bin/env bash\n# Written by claude-adhd on session start. Do not edit.\nexec ${JSON.stringify(targetPath)} "$@"\n`;
	try {
		if (readFileSync(shim, "utf8") === body) return shim;
	} catch {
		// Missing or unreadable: write it.
	}
	writeFileSync(shim, body, { encoding: "utf8", mode: 0o755 });
	return shim;
}
