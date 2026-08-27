#!/usr/bin/env node
/**
 * Surgery on ~/.claude/settings.json, for the install modes that need it.
 *
 * Two rules, because this file is somebody's whole Claude Code configuration
 * and they did not ask for it to be rearranged:
 *
 *   1. Additive and idempotent. Existing hooks are appended to, never replaced;
 *      running the installer twice changes nothing the second time.
 *   2. Every write is preceded by a timestamped backup, and every change is
 *      exactly reversible by the matching `remove-*` verb.
 *
 * The status line is the awkward one — Claude Code allows exactly one command,
 * so installing ours means wrapping whatever was there. The wrapper records the
 * original inside itself so uninstalling can put it back.
 */

import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
const SETTINGS = join(CLAUDE_DIR, "settings.json");
const WRAPPER = join(CLAUDE_DIR, "statusline-with-adhd.sh");
/**
 * Recognising our own hooks after the fact.
 *
 * Matching on the repository path would break the moment somebody clones into
 * a directory with a different name, so the shape of the command is the marker:
 * a launcher called `adhd` invoked with `hook <one of our four events>`.
 */
const OURS = /\/adhd["']?\s+hook\s+(session-start|prompt-submit|stop|session-end)\b/;

const [verb, binPath] = process.argv.slice(2);

function readSettings() {
	if (!existsSync(SETTINGS)) return {};
	const raw = readFileSync(SETTINGS, "utf8").trim();
	if (!raw) return {};
	return JSON.parse(raw);
}

function backup() {
	if (!existsSync(SETTINGS)) return null;
	const stamp = new Date().toISOString().replace(/[:.]/g, "-");
	const path = `${SETTINGS}.adhd-backup-${stamp}`;
	copyFileSync(SETTINGS, path);
	return path;
}

function writeSettings(settings) {
	mkdirSync(dirname(SETTINGS), { recursive: true });
	writeFileSync(SETTINGS, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

const EVENTS = {
	SessionStart: "session-start",
	UserPromptSubmit: "prompt-submit",
	Stop: "stop",
	SessionEnd: "session-end",
};

function isOurs(entry) {
	return typeof entry?.command === "string" && OURS.test(entry.command);
}

function installHooks() {
	if (!binPath) throw new Error("install-hooks needs the path to bin/adhd");
	const settings = readSettings();
	settings.hooks = settings.hooks ?? {};
	let changed = false;

	for (const [event, arg] of Object.entries(EVENTS)) {
		settings.hooks[event] = settings.hooks[event] ?? [];
		const command = `"${binPath}" hook ${arg}`;
		const already = settings.hooks[event].some((group) => (group.hooks ?? []).some((h) => isOurs(h)));
		if (already) {
			// Rewrite in place so moving the checkout and re-running fixes the path.
			for (const group of settings.hooks[event]) {
				for (const hook of group.hooks ?? []) {
					if (isOurs(hook) && hook.command !== command) {
						hook.command = command;
						changed = true;
					}
				}
			}
			continue;
		}
		settings.hooks[event].push({ hooks: [{ type: "command", command, timeout: 5 }] });
		changed = true;
	}

	if (!changed) {
		process.stdout.write("hooks already installed\n");
		return;
	}
	const path = backup();
	writeSettings(settings);
	process.stdout.write(`hooks installed${path ? ` (backup: ${path})` : ""}\n`);
}

function removeHooks() {
	const settings = readSettings();
	if (!settings.hooks) {
		process.stdout.write("no hooks to remove\n");
		return;
	}
	let changed = false;
	for (const event of Object.keys(EVENTS)) {
		const groups = settings.hooks[event];
		if (!Array.isArray(groups)) continue;
		const kept = [];
		for (const group of groups) {
			const hooks = (group.hooks ?? []).filter((h) => !isOurs(h));
			if (hooks.length !== (group.hooks ?? []).length) changed = true;
			if (hooks.length) kept.push({ ...group, hooks });
		}
		if (kept.length) settings.hooks[event] = kept;
		else delete settings.hooks[event];
	}
	if (Object.keys(settings.hooks).length === 0) delete settings.hooks;

	if (!changed) {
		process.stdout.write("no hooks to remove\n");
		return;
	}
	const path = backup();
	writeSettings(settings);
	process.stdout.write(`hooks removed${path ? ` (backup: ${path})` : ""}\n`);
}

function installStatusline() {
	if (!binPath) throw new Error("install-statusline needs the path to bin/adhd");
	const settings = readSettings();
	const existing = settings.statusLine;

	if (existing?.command?.includes("statusline-with-adhd")) {
		process.stdout.write("status line already wrapped\n");
		return;
	}

	// Whatever was there keeps running and keeps its output; ours is appended.
	const inner = existing?.type === "command" && existing.command ? existing.command : "";
	const wrapper = [
		"#!/usr/bin/env bash",
		"# Written by claude-adhd's installer. Runs the status line that was already",
		"# configured, then appends the ADHD timer segment.",
		"#",
		"# Restore the original with: scripts/uninstall.sh",
		"",
		"input=$(cat)",
		"",
		`# adhd-original: ${JSON.stringify(inner)}`,
		inner ? `base=$(printf '%s' "$input" | ${inner} 2>/dev/null | head -n1)` : 'base=""',
		`adhd=$(printf '%s' "$input" | ${JSON.stringify(binPath)} statusline 2>/dev/null | head -n1)`,
		"",
		'if [ -n "$adhd" ] && [ -n "$base" ]; then',
		'\tprintf \'%s %s\\n\' "$base" "$adhd"',
		'elif [ -n "$adhd" ]; then',
		'\tprintf \'%s\\n\' "$adhd"',
		"else",
		'\tprintf \'%s\\n\' "$base"',
		"fi",
		"",
	].join("\n");

	mkdirSync(dirname(WRAPPER), { recursive: true });
	writeFileSync(WRAPPER, wrapper, "utf8");
	chmodSync(WRAPPER, 0o755);

	settings.statusLine = { type: "command", command: `bash ${WRAPPER}` };
	const path = backup();
	writeSettings(settings);
	process.stdout.write(`status line wrapped${inner ? " (the existing one still runs first)" : ""}${path ? ` (backup: ${path})` : ""}\n`);
}

function removeStatusline() {
	const settings = readSettings();
	if (!settings.statusLine?.command?.includes("statusline-with-adhd")) {
		process.stdout.write("status line was not wrapped by us\n");
		return;
	}
	let original = "";
	try {
		const line = readFileSync(WRAPPER, "utf8")
			.split("\n")
			.find((l) => l.startsWith("# adhd-original: "));
		if (line) original = JSON.parse(line.slice("# adhd-original: ".length));
	} catch {
		// The wrapper is gone; the best we can do is unset ours.
	}
	if (original) settings.statusLine = { type: "command", command: original };
	else delete settings.statusLine;

	const path = backup();
	writeSettings(settings);
	process.stdout.write(`status line restored${original ? "" : " (there was nothing to restore to)"}${path ? ` (backup: ${path})` : ""}\n`);
}

try {
	switch (verb) {
		case "install-hooks":
			installHooks();
			break;
		case "remove-hooks":
			removeHooks();
			break;
		case "install-statusline":
			installStatusline();
			break;
		case "remove-statusline":
			removeStatusline();
			break;
		default:
			process.stderr.write("usage: settings-patch.mjs install-hooks|remove-hooks|install-statusline|remove-statusline [bin-path]\n");
			process.exitCode = 1;
	}
} catch (error) {
	process.stderr.write(`settings-patch: ${error?.message ?? error}\n`);
	process.exitCode = 1;
}
