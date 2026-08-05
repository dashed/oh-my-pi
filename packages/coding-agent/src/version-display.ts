import { VERSION } from "@oh-my-pi/pi-utils/dirs";
import { FORK_COMMIT } from "./fork-version";

/**
 * User-facing version rendering. Builds packed from a VCS checkout append the
 * pack-time commit hash ("17.2.9 (a1c8388)") so bug reports can name the exact
 * commit; without a stamped hash the plain upstream version is rendered.
 */
export function formatDisplayVersion(version: string, forkCommit: string): string {
	return forkCommit ? `${version} (${forkCommit})` : version;
}

/** Display version for this build: VERSION plus the pack-time fork commit hash when stamped. */
export const DISPLAY_VERSION: string = formatDisplayVersion(VERSION, FORK_COMMIT);
