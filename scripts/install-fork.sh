#!/usr/bin/env bash
# Pack and globally install the fork: packages/ai + packages/coding-agent.
#
# Why the nested-copy step: bun's global install of the coding-agent tarball
# pulls @oh-my-pi/pi-ai from npm (upstream) into the package's nested
# node_modules, shadowing any top-level install. The fork's pi-ai changes
# (responses stream retry, routing passthrough, sanitizeUpstreamProvider) live
# only in our packages/ai, so we replace the nested copy after every install.
# Without this the app fails to boot: coding-agent imports sanitizeUpstreamProvider
# statically from pi-ai.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GLOBAL_PKG="$HOME/.bun/install/global/node_modules/@oh-my-pi/pi-coding-agent"
NESTED_PIAI="$GLOBAL_PKG/node_modules/@oh-my-pi/pi-ai"

echo "== packing pi-ai =="
(cd "$REPO/packages/ai" && bun pm pack)
echo "== packing coding-agent =="
(cd "$REPO/packages/coding-agent" && bun pm pack)

AI_TGZ=$(ls "$REPO"/packages/ai/oh-my-pi-pi-ai-*.tgz | head -1)
AGENT_TGZ=$(ls "$REPO"/packages/coding-agent/oh-my-pi-pi-coding-agent-*.tgz | head -1)

echo "== installing =="
bun remove -g @oh-my-pi/pi-coding-agent 2>/dev/null || true
bun install -g "$AI_TGZ"
bun install -g "$AGENT_TGZ"

echo "== replacing nested pi-ai with the fork copy =="
TMP="$(mktemp -d)"
tar xzf "$AI_TGZ" -C "$TMP"
rm -rf "$NESTED_PIAI"
mv "$TMP/package" "$NESTED_PIAI"
rm -rf "$TMP"

echo "== verifying =="
omp --version
omp --smoke-test

rm -f "$AI_TGZ" "$AGENT_TGZ"
echo "done: $(omp --version)"
