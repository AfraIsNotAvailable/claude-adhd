#!/usr/bin/env bash
# Remove claude-adhd, whichever way it was installed.
#
#   scripts/uninstall.sh              undo both install modes, leave the logs
#   scripts/uninstall.sh --purge      also delete the state directory and its logs
#
# Safe to run when only one mode was used, or when nothing was installed at
# all: every step reports what it found and moves on.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
STATE_DIR="${ADHD_STATE_DIR:-${XDG_STATE_HOME:-${HOME}/.local/state}/claude-adhd}"
PURGE="no"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--purge) PURGE="yes" ;;
		-h | --help)
			sed -n '2,9p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
			exit 0
			;;
		*)
			echo "unknown option: $1" >&2
			exit 1
			;;
	esac
	shift
done

say() { printf '  %s\n' "$*"; }
step() { printf '\n\033[1m%s\033[0m\n' "$*"; }

step "Plugin"
if command -v claude >/dev/null 2>&1; then
	claude plugin uninstall adhd@claude-adhd 2>&1 | sed 's/^/  /' || say "not installed as a plugin"
	claude plugin marketplace remove claude-adhd 2>&1 | sed 's/^/  /' || say "marketplace not registered"
else
	say "the 'claude' CLI is not on PATH — skipping"
fi

step "Symlinks"
for dest in "${CLAUDE_DIR}/skills/adhd-session" "${CLAUDE_DIR}/commands/adhd.md"; do
	if [[ -L "${dest}" ]]; then
		target="$(readlink -f "${dest}" || true)"
		case "${target}" in
			"${ROOT}"/*)
				rm -f "${dest}"
				say "removed: ${dest}"
				;;
			*) say "left alone (points elsewhere): ${dest}" ;;
		esac
	else
		say "not linked: ${dest}"
	fi
done

step "settings.json"
node "${ROOT}/scripts/settings-patch.mjs" remove-hooks | sed 's/^/  /'
node "${ROOT}/scripts/settings-patch.mjs" remove-statusline | sed 's/^/  /'
rm -f "${CLAUDE_DIR}/statusline-with-adhd.sh"

step "State"
if [[ "${PURGE}" == "yes" ]]; then
	rm -rf "${STATE_DIR}"
	say "deleted: ${STATE_DIR}"
else
	say "kept: ${STATE_DIR} (session logs live here; --purge deletes them)"
fi

step "Done"
say "Restart Claude Code for the change to take effect."
printf '\n'
