#!/usr/bin/env bash
# Install claude-adhd, either as a plugin or as a plain skill.
#
#   scripts/install.sh                 plugin mode (recommended)
#   scripts/install.sh --skill         skill mode: symlinks + hooks in settings.json
#   scripts/install.sh --no-statusline skip the status-line segment
#   scripts/install.sh --statusline    wire the status line without asking
#
# Plugin mode registers this directory as a local marketplace and installs the
# plugin from it, so the hooks, the `/adhd` skill all
# arrive together and `claude plugin uninstall` takes them all away again.
#
# Skill mode exists for people who do not want a marketplace entry: it symlinks
# the skill and the command into ~/.claude and writes the four hooks into
# settings.json directly, with a backup. Everything it touches is reversible
# with scripts/uninstall.sh.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-${HOME}/.claude}"
MODE="plugin"
STATUSLINE="ask"

while [[ $# -gt 0 ]]; do
	case "$1" in
		--plugin) MODE="plugin" ;;
		--skill | --skills) MODE="skill" ;;
		--statusline) STATUSLINE="yes" ;;
		--no-statusline) STATUSLINE="no" ;;
		-h | --help)
			sed -n '2,17p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
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

# ------------------------------------------------------------------ checks

step "Checking"

chmod +x "${ROOT}/bin/adhd" "${ROOT}/bin/adhd.mjs" "${ROOT}/scripts/uninstall.sh" 2>/dev/null || true

if ! "${ROOT}/bin/adhd" config >/dev/null 2>&1; then
	echo "No usable node interpreter found. Install Node 20+ or set ADHD_NODE=/path/to/node." >&2
	exit 1
fi
say "engine: runs"

# Installing something that does not work is worse than not installing it,
# and the self-test costs a second.
if ! "${ROOT}/bin/adhd" selftest >/dev/null 2>&1; then
	echo "The self-test failed. Refusing to install something that does not work." >&2
	echo "Run '${ROOT}/bin/adhd selftest' to see why." >&2
	exit 1
fi
say "self-test: passed"

# ------------------------------------------------------------------ install

if [[ "${MODE}" == "plugin" ]]; then
	step "Installing as a plugin"
	if ! command -v claude >/dev/null 2>&1; then
		echo "The 'claude' CLI is not on PATH, so plugin mode cannot run." >&2
		echo "Use skill mode instead:  scripts/install.sh --skill" >&2
		exit 1
	fi
	claude plugin marketplace add "${ROOT}" 2>&1 | sed 's/^/  /' || say "marketplace already registered"
	claude plugin install adhd@claude-adhd 2>&1 | sed 's/^/  /'
	say "installed: adhd@claude-adhd"
else
	step "Installing as a skill"
	mkdir -p "${CLAUDE_DIR}/skills"

	for pair in "skills/adhd:${CLAUDE_DIR}/skills/adhd"; do
		src="${ROOT}/${pair%%:*}"
		dest="${pair#*:}"
		if [[ -e "${dest}" && ! -L "${dest}" ]]; then
			echo "Refusing to replace ${dest}, which is not a symlink. Move it and re-run." >&2
			exit 1
		fi
		ln -sfn "${src}" "${dest}"
		say "linked: ${dest}"
	done

	node "${ROOT}/scripts/settings-patch.mjs" install-hooks "${ROOT}/bin/adhd" | sed 's/^/  /'
fi

# ------------------------------------------------------------------ status line

if [[ "${STATUSLINE}" == "ask" ]]; then
	if [[ -t 0 ]]; then
		printf '\n'
		read -r -p "Add the timer to the status line? It wraps your current one, and uninstall puts it back. [Y/n] " reply
		case "${reply}" in
			[nN]*) STATUSLINE="no" ;;
			*) STATUSLINE="yes" ;;
		esac
	else
		STATUSLINE="no"
		say "not a terminal: skipping the status line (re-run with --statusline to add it)"
	fi
fi

if [[ "${STATUSLINE}" == "yes" ]]; then
	step "Wiring the status line"
	node "${ROOT}/scripts/settings-patch.mjs" install-statusline "${ROOT}/bin/adhd" | sed 's/^/  /'
fi

# ------------------------------------------------------------------ done

step "Done"
say "Restart Claude Code, then:  /adhd <what you are working on>"
say "Uninstall with:             ${ROOT}/scripts/uninstall.sh"
printf '\n'
