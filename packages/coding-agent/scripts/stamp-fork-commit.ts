#!/usr/bin/env bun

/**
 * Stamps the short fork commit hash into `src/fork-version.ts` at pack time.
 *
 * The published package runs without a VCS (the npm tarball has no `.jj`/`.git`),
 * so the hash must be baked in before packing. Wired into `prepack` via
 * `scripts/bundle-dist.ts`, which stamps before bundling so both `dist/cli.js`
 * and the stamped source ship in the tarball.
 *
 * Hash resolution order:
 *   1. `git rev-parse --short HEAD` — in the colocated jj+git fork, git HEAD
 *      tracks the working copy's parent (`@-`), which for a parked tree is the
 *      branch tip: a real, pushed commit that exists on GitHub.
 *   2. `jj log -r @-` — non-colocated jj repos; `@-` avoids naming the empty
 *      working-copy placeholder (a local, unpushed commit).
 *   3. `""` — no VCS (e.g. packing from an unpacked tarball); the version
 *      display stays identical to upstream.
 *
 * `--reset` rewrites the committed empty placeholder (byte-identical to the
 * checked-in file) after a local pack dirtied the working copy.
 */

import * as path from "node:path";

const packageDir = path.join(import.meta.dir, "..");
const targetPath = path.join(packageDir, "src", "fork-version.ts");

const HASH_LENGTH = 7;
const HASH_PATTERN = /^[0-9a-f]{4,40}$/u;

/** Run a VCS query and return its trimmed stdout, or "" when the binary or repo is missing. */
async function tryReadCommand(command: string[], cwd: string): Promise<string> {
	let output: string;
	let exitCode: number;
	try {
		const proc = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "ignore" });
		[output, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	} catch {
		return "";
	}
	const trimmed = output.trim();
	if (exitCode !== 0 || !HASH_PATTERN.test(trimmed)) return "";
	return trimmed;
}

/** Resolve the short commit id of the tree being packed: git HEAD (branch tip in colocated jj+git), jj parent fallback, "" without a VCS. */
export async function resolveForkCommit(cwd: string = packageDir): Promise<string> {
	const git = await tryReadCommand(["git", "rev-parse", `--short=${HASH_LENGTH}`, "HEAD"], cwd);
	if (git) return git;
	return tryReadCommand(["jj", "log", "-r", "@-", "--no-graph", "-T", `commit_id.short(${HASH_LENGTH})`], cwd);
}

/** Render the stamped module. Deterministic, so `--reset` restores the committed placeholder byte-for-byte. */
export function renderForkVersionModule(forkCommit: string): string {
	return `/**
 * Fork commit hash baked into the package at pack time by
 * scripts/stamp-fork-commit.ts (wired into \`prepack\` via scripts/bundle-dist.ts).
 *
 * The published package runs without a VCS, so the hash can only be known at
 * pack time. Empty for dev checkouts and trees packed outside jj/git, which
 * keeps the version display identical to upstream. Do not edit by hand —
 * \`bun run stamp:fork-commit:reset\` regenerates this placeholder.
 */
export const FORK_COMMIT: string = ${JSON.stringify(forkCommit)};
`;
}

/** Resolve the hash and write the stamped module; returns the hash written (possibly ""). */
export async function stampForkCommit(): Promise<string> {
	const forkCommit = await resolveForkCommit();
	await Bun.write(targetPath, renderForkVersionModule(forkCommit));
	return forkCommit;
}

async function main(): Promise<void> {
	if (process.argv.includes("--reset")) {
		await Bun.write(targetPath, renderForkVersionModule(""));
		process.stdout.write("Reset src/fork-version.ts to the empty placeholder\n");
		return;
	}
	const forkCommit = await stampForkCommit();
	process.stdout.write(
		forkCommit
			? `Stamped fork commit ${forkCommit} into src/fork-version.ts\n`
			: "No jj/git commit found; stamped empty placeholder (plain version display)\n",
	);
}

if (import.meta.main) await main();
