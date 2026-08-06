#!/usr/bin/env bash
# Pack and globally install the fork.
#
# The pack set is computed, not hardcoded: every package under packages/ that
# differs from upstream (merge-base of HEAD and origin/main), plus uncommitted
# working-tree changes, plus packages/coding-agent (the app) unconditionally.
#
# Why: fork packages are version-masked — they keep upstream version numbers,
# so bun's global install of the coding-agent tarball resolves @oh-my-pi/*
# deps from npm (upstream), silently satisfying them with code that lacks
# fork-only APIs. Past casualties:
#  - pi-ai: boot failure — coding-agent statically imports the fork-only
#    sanitizeUpstreamProvider.
#  - pi-tui: resume of large sessions crashed — TranscriptContainer calls
#    super.insertChildAt, which only exists in the fork's Container.
#
# After installing, every installed copy of a fork package (top-level and
# nested under the agent — bun chooses hoisting per package) is force-replaced
# from the fork tarball and verified to byte-match it, so a stale upstream
# copy fails the install loudly instead of crashing at runtime.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
GLOBAL_ROOT="$HOME/.bun/install/global/node_modules"
GLOBAL_PKG="$GLOBAL_ROOT/@oh-my-pi/pi-coding-agent"
APP_DIR="packages/coding-agent"

BASE="$(git -C "$REPO" merge-base HEAD origin/main)"

# Committed fork changes + uncommitted working-tree changes → package dirs.
PKG_DIRS=()
while IFS= read -r dir; do
	PKG_DIRS+=("$dir")
done < <({
	git -C "$REPO" diff --name-only "$BASE"..HEAD -- packages/
	git -C "$REPO" status --porcelain -- packages/ | cut -c4-
} | cut -d/ -f1-2 | sort -u)

# The app is always packed (it provides the omp binary) and installed last,
# so its dependency resolution runs before we replace anything.
case " ${PKG_DIRS[*]-} " in
*" $APP_DIR "*) ;;
*) PKG_DIRS+=("$APP_DIR") ;;
esac

if {
	git -C "$REPO" diff --name-only "$BASE"..HEAD -- crates/
	git -C "$REPO" status --porcelain -- crates/
} | grep -q .; then
	echo "WARNING: fork modifies crates/ — bun pm pack does not rebuild native" >&2
	echo "         binaries; run the cargo build before installing." >&2
fi

echo "== pack set (diff vs upstream at ${BASE:0:9}) =="
printf '  %s\n' "${PKG_DIRS[@]}"

tgz_of() { ls "$REPO"/"$1"/*.tgz | head -1; }
pkg_name() { grep '"name"' "$REPO/$1/package.json" | head -1 | cut -d'"' -f4; }

echo "== packing =="
for dir in "${PKG_DIRS[@]}"; do
	echo "  $dir"
	rm -f "$REPO"/"$dir"/*.tgz
	(cd "$REPO/$dir" && bun pm pack >/dev/null)
done

echo "== installing =="
bun remove -g @oh-my-pi/pi-coding-agent 2>/dev/null || true
for dir in "${PKG_DIRS[@]}"; do
	[ "$dir" = "$APP_DIR" ] && continue
	bun install -g "$(tgz_of "$dir")"
done
bun install -g "$(tgz_of "$APP_DIR")"

# Overwrite every location the agent can resolve a fork package from — bun
# chooses hoisting (top-level vs nested) per package and we must not depend
# on its choice.
replace_fork_copy() {
	local dir="$1" pkg tgz tmp dest replaced=0
	pkg="$(pkg_name "$dir")"
	tgz="$(tgz_of "$dir")"
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
		echo "  note: $pkg is not installed under the agent (not a dependency?) — packed only"
	fi
}

echo "== replacing installed copies with fork builds =="
for dir in "${PKG_DIRS[@]}"; do
	[ "$dir" = "$APP_DIR" ] && continue
	replace_fork_copy "$dir"
done

# Every installed copy of a fork package must byte-match the fork tarball:
# a stale upstream copy under the same version number is the failure mode
# this script exists to prevent.
verify_fork_copy() {
	local dir="$1" pkg tgz tmp dest
	pkg="$(pkg_name "$dir")"
	tgz="$(tgz_of "$dir")"
	tmp="$(mktemp -d)"
	tar xzf "$tgz" -C "$tmp"
	for dest in "$GLOBAL_PKG/node_modules/$pkg" "$GLOBAL_ROOT/$pkg"; do
		[ -d "$dest" ] || continue
		if ! diff -r --exclude=node_modules -q "$tmp/package" "$dest" >/dev/null; then
			rm -rf "$tmp"
			echo "FATAL: installed $pkg at $dest diverges from the fork build" >&2
			exit 1
		fi
	done
	rm -rf "$tmp"
}

echo "== verifying =="
for dir in "${PKG_DIRS[@]}"; do
	[ "$dir" = "$APP_DIR" ] && continue
	verify_fork_copy "$dir"
done
omp --version
omp --smoke-test

for dir in "${PKG_DIRS[@]}"; do
	rm -f "$REPO"/"$dir"/*.tgz
done
echo "done: $(omp --version)"
