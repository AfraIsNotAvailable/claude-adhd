#!/usr/bin/env bash
# One-liner installer.
#
#   curl -fsSL https://raw.githubusercontent.com/AfraIsNotAvailable/claude-adhd/main/install.sh | bash
#
# Clones (or updates) a checkout under ~/.local/share and hands over to
# scripts/install.sh, which does the real work. Arguments pass straight
# through, so this works too:
#
#   curl -fsSL .../install.sh | bash -s -- --skill --no-statusline
#
# The checkout is kept rather than thrown away because the plugin is installed
# *from* it: scripts/uninstall.sh lives there, and `git pull` there is how you
# update.

set -euo pipefail

REPO="${CLAUDE_ADHD_REPO:-https://github.com/AfraIsNotAvailable/claude-adhd.git}"
BRANCH="${CLAUDE_ADHD_BRANCH:-main}"
DEST="${CLAUDE_ADHD_DIR:-${XDG_DATA_HOME:-${HOME}/.local/share}/claude-adhd}"

step() { printf '\n\033[1m%s\033[0m\n' "$*"; }
say() { printf '  %s\n' "$*"; }
die() {
	printf '\n\033[31m%s\033[0m\n\n' "$*" >&2
	exit 1
}

command -v git >/dev/null 2>&1 || die "git is required."

step "Fetching claude-adhd"

if [[ -d "${DEST}/.git" ]]; then
	say "updating ${DEST}"
	git -C "${DEST}" fetch --quiet origin "${BRANCH}"
	git -C "${DEST}" checkout --quiet "${BRANCH}"
	# Hard reset: this is a managed checkout, not somewhere to keep edits.
	# Clone it yourself if you want to hack on it.
	git -C "${DEST}" reset --hard --quiet "origin/${BRANCH}"
else
	[[ -e "${DEST}" ]] && die "${DEST} exists and is not a git checkout. Move it and re-run."
	mkdir -p "$(dirname "${DEST}")"
	say "cloning into ${DEST}"
	git clone --quiet --depth 1 --branch "${BRANCH}" "${REPO}" "${DEST}"
fi

say "version $(git -C "${DEST}" rev-parse --short HEAD)"

chmod +x "${DEST}/bin/adhd" "${DEST}/scripts/install.sh" "${DEST}/scripts/uninstall.sh" 2>/dev/null || true

# Piped into bash, stdin is the script itself, so the installer's prompt would
# read the rest of this file. Hand it the terminal when there is one.
if [[ -r /dev/tty && -t 1 ]]; then
	exec "${DEST}/scripts/install.sh" "$@" </dev/tty
else
	exec "${DEST}/scripts/install.sh" "$@"
fi
