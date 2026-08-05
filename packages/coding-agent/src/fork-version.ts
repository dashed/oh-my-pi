/**
 * Fork commit hash baked into the package at pack time by
 * scripts/stamp-fork-commit.ts (wired into `prepack` via scripts/bundle-dist.ts).
 *
 * The published package runs without a VCS, so the hash can only be known at
 * pack time. Empty for dev checkouts and trees packed outside jj/git, which
 * keeps the version display identical to upstream. Do not edit by hand —
 * `bun run stamp:fork-commit:reset` regenerates this placeholder.
 */
export const FORK_COMMIT: string = "762ced0";
