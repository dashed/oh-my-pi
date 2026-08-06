#!/usr/bin/env bash
# Pack and globally install the fork: packages/ai + packages/tui + packages/coding-agent.
#
# Why the copy steps: bun's global install of the coding-agent tarball resolves
# @oh-my-pi/* deps from npm (upstream) — pi-ai lands in the package's nested
# node_modules, pi-tui at the top level. The fork's changes to those packages
# live only in this repo and are version-masked (same version as upstream), so
# we overwrite the installed copies after every install. Without this:
#  - pi-ai: the app fails to boot — coding-agent statically imports the
#    fork-only sanitizeUpstreamProvider.
#  - pi-tui: resume of large sessions crashes — the lazy transcript backfill
#    calls TranscriptContainer.insertChildAt → super.insertChildAt, which only
#    exists in the fork's Container (packages/tui/src/tui.ts).
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GLOBAL_ROOT="$HOME/.bun/install/global/node_modules"
GLOBAL_PKG="$GLOBAL_ROOT/@oh-my-pi/pi-coding-agent"

echo "== packing pi-ai =="
(cd "$REPO/packages/ai" && bun pm pack)
echo "== packing pi-tui =="
(cd "$REPO/packages/tui" && bun pm pack)
echo "== packing coding-agent =="
(cd "$REPO/packages/coding-agent" && bun pm pack)

AI_TGZ=$(ls "$REPO"/packages/ai/oh-my-pi-pi-ai-*.tgz | head -1)
TUI_TGZ=$(ls "$REPO"/packages/tui/oh-my-pi-pi-tui-*.tgz | head -1)
AGENT_TGZ=$(ls "$REPO"/packages/coding-agent/oh-my-pi-pi-coding-agent-*.tgz | head -1)

echo "== installing =="
bun remove -g @oh-my-pi/pi-coding-agent 2>/dev/null || true
bun install -g "$AI_TGZ"
bun install -g "$TUI_TGZ"
bun install -g "$AGENT_TGZ"

# Overwrite every location the agent can resolve the package from — bun chooses
# hoisting (top-level vs nested) and we must not depend on its choice.
install_fork_copy() {
	local tgz="$1" pkg="$2"
	local tmp dest replaced=0
	tmp="$(mktemp -d)"
	tar xzf "$tgz" -C "$tmp"
	for dest in "$GLOBAL_PKG/node_modules/$pkg" "$GLOBAL_ROOT/$pkg"; do
		if [ -d "$dest" ]; then
			rm -rf "$dest"
			cp -R "$tmp/package" "$dest"
			replaced=1
		fi
	done
	rm -rf "$tmp"
	if [ "$replaced" -eq 0 ]; then
		echo "warning: no installed copy of $pkg found to replace" >&2
	fi
}

echo "== replacing installed copies with fork builds =="
install_fork_copy "$AI_TGZ" "@oh-my-pi/pi-ai"
install_fork_copy "$TUI_TGZ" "@oh-my-pi/pi-tui"

echo "== verifying =="
# Fork APIs are consumed across package boundaries under the same version
# numbers as upstream; probe the installed files so a stale upstream copy
# fails the install loudly here instead of crashing at runtime.
if ! grep -rq "sanitizeUpstreamProvider" "$GLOBAL_PKG/node_modules/@oh-my-pi/pi-ai/src/" 2>/dev/null; then
	echo "FATAL: installed pi-ai lacks fork API (sanitizeUpstreamProvider)" >&2
	exit 1
fi
if ! grep -q "insertChildAt" "$GLOBAL_ROOT/@oh-my-pi/pi-tui/src/tui.ts" 2>/dev/null; then
	echo "FATAL: installed pi-tui lacks fork API (insertChildAt)" >&2
	exit 1
fi
omp --version
omp --smoke-test

rm -f "$AI_TGZ" "$TUI_TGZ" "$AGENT_TGZ"
echo "done: $(omp --version)"
