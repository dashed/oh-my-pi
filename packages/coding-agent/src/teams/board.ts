/**
 * TeamBoard — file-backed shared task board for a session's agent team.
 *
 * Storage layout: `~/.omp/teams/<rootSessionId>/tasks/<taskId>.json`, one
 * JSON document per task. Every descendant of the root session resolves the
 * same directory via {@link resolveTeamId}, which walks the AgentRef
 * `parentId` chain in the process-global AgentRegistry (registered with
 * `parentId: options.parentAgentId` in sdk.ts) up to the root agent and
 * reads its live session's id.
 *
 * Concurrency: each read-modify-write runs under a per-task O_EXCL lock file
 * (`<task>.json.lock`, node `open(flag: "wx")`) with bounded backoff retry;
 * a lock whose mtime is older than {@link LOCK_STALE_MS} is broken, so a
 * crashed holder cannot wedge the board. Task files are written atomically
 * (temp file + rename), so readers never observe a partial document, and
 * corrupt files are skipped with a warning instead of failing the board.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getConfigRootDir, isEexist, isRecord, logger, sanitizeText, Snowflake } from "@oh-my-pi/pi-utils";
import type { AgentRegistry } from "../registry/agent-registry";

// =============================================================================
// Types
// =============================================================================

export type TeamTaskStatus = "pending" | "claimed" | "done";

export interface TeamTask {
	id: string;
	title: string;
	description?: string;
	status: TeamTaskStatus;
	claimedBy?: string;
	claimedAt?: number;
	blockedBy: string[];
	result?: string;
	createdBy: string;
	createdAt: number;
	completedAt?: number;
}

export type TeamBoardErrorCode = "invalid_input" | "not_found" | "already_claimed" | "blocked" | "invalid_state" | "io";

export interface TeamBoardFailure {
	ok: false;
	code: TeamBoardErrorCode;
	message: string;
	/** Current on-disk state when the failure is about one task. */
	task?: TeamTask;
	/** Unfinished prerequisite task ids for `blocked` failures. */
	pendingBlockers?: string[];
}

export interface TeamBoardSuccess {
	ok: true;
	task: TeamTask;
	/** Dependent task ids whose `blockedBy` was cleared by a completion. */
	unblocked?: string[];
}

export type TeamBoardOutcome = TeamBoardSuccess | TeamBoardFailure;

/** Minimal session surface needed to resolve the shared team board. */
export interface TeamLineageSource {
	getAgentId?: () => string | null;
	agentRegistry?: AgentRegistry;
	getSessionId?: () => string | null;
}

// =============================================================================
// Validation
// =============================================================================

/** Task ids are Snowflakes; the charset check also keeps them path-safe. */
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function isValidTaskId(id: string): boolean {
	return TASK_ID_RE.test(id);
}

/** Whether an unknown value is a persisted team task (`blockedBy` may be absent on disk). */
export function isTeamTask(value: unknown): value is TeamTask {
	if (!isRecord(value)) return false;
	if (typeof value.id !== "string" || !isValidTaskId(value.id)) return false;
	if (typeof value.title !== "string") return false;
	if (value.status !== "pending" && value.status !== "claimed" && value.status !== "done") return false;
	if (
		value.blockedBy !== undefined &&
		(!Array.isArray(value.blockedBy) || !value.blockedBy.every(id => typeof id === "string"))
	) {
		return false;
	}
	if (typeof value.createdBy !== "string") return false;
	if (typeof value.createdAt !== "number" || !Number.isFinite(value.createdAt)) return false;
	return true;
}

function failure(code: TeamBoardErrorCode, message: string, extra?: Partial<TeamBoardFailure>): TeamBoardFailure {
	return { ok: false, code, message, ...extra };
}

// =============================================================================
// Team id + board dir resolution
// =============================================================================

/**
 * Resolve the team id shared by every agent in the session tree: the ROOT
 * (main) session's id. Walks the caller's AgentRef parent chain
 * (`registry.get(id).parentId`) to the root agent and reads its live
 * session's id; falls back to the caller's own session id when the registry
 * walk cannot reach a live root (e.g. the main session before registration,
 * or tests with a bare session).
 */
export function resolveTeamId(session: TeamLineageSource): string | null {
	const registry = session.agentRegistry;
	const agentId = session.getAgentId?.() ?? null;
	if (registry && agentId) {
		const visited = new Set<string>([agentId]);
		let ref = registry.get(agentId);
		while (ref?.parentId !== undefined && !visited.has(ref.parentId)) {
			visited.add(ref.parentId);
			const parent = registry.get(ref.parentId);
			if (!parent) break;
			ref = parent;
		}
		const rootSessionId = ref?.session?.sessionManager.getSessionId();
		if (rootSessionId) return rootSessionId;
	}
	return session.getSessionId?.() ?? null;
}

/** Board directory for a team id: `~/.omp/teams/<teamId>/tasks/`. */
export function resolveTeamBoardDir(teamId: string): string {
	const safeTeamId = teamId.replace(/[^A-Za-z0-9._-]/g, "_");
	return path.join(getConfigRootDir(), "teams", safeTeamId, "tasks");
}

// =============================================================================
// Locking
// =============================================================================

/** Lock files older than this are presumed abandoned by a crashed holder. */
export const LOCK_STALE_MS = 60_000;

const LOCK_MAX_ATTEMPTS = 30;
const LOCK_BASE_DELAY_MS = 15;
const LOCK_MAX_DELAY_MS = 200;

function lockDelayMs(attempt: number): number {
	const exp = Math.min(LOCK_BASE_DELAY_MS * 2 ** Math.min(attempt, 3), LOCK_MAX_DELAY_MS);
	return exp + Math.floor(Math.random() * LOCK_BASE_DELAY_MS);
}

/**
 * Run `fn` holding the per-task O_EXCL lock for `taskFilePath`.
 * The lock file carries a unique ownership token (pid + timestamp + random
 * id); it is removed on release ONLY when the on-disk content still matches
 * our token, so a stalled holder whose lock was broken and re-acquired by a
 * peer can never unlink the peer's live lock. Contention retries with short
 * backoff; a stale lock (mtime > {@link LOCK_STALE_MS}) is broken once (after
 * re-verifying it is still the same file we observed, so a racing breaker
 * cannot trick us into deleting its fresh lock) and acquisition retried.
 */
export async function withTaskLock<T>(taskFilePath: string, fn: () => Promise<T>): Promise<T> {
	const lockPath = `${taskFilePath}.lock`;
	const token = `${process.pid} ${Date.now()} ${Bun.randomUUIDv7()}`;
	let brokeStale = false;
	let handle: fs.FileHandle | null = null;
	for (let attempt = 0; attempt < LOCK_MAX_ATTEMPTS; attempt++) {
		try {
			handle = await fs.open(lockPath, "wx");
			await handle.writeFile(token);
			break;
		} catch (error) {
			if (!isEexist(error)) throw error;
			if (!brokeStale) {
				const stat = await fs.stat(lockPath).catch(() => null);
				if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
					logger.warn("team board: breaking stale task lock", { lockPath });
					// TOCTOU guard: a contender may have broken the stale lock and
					// re-created it as its own fresh lock between our stat and rm.
					// Delete only when the file identity is unchanged.
					const verify = await fs.stat(lockPath).catch(() => null);
					if (verify && verify.ino === stat.ino && verify.mtimeMs === stat.mtimeMs) {
						await fs.rm(lockPath, { force: true }).catch(() => {});
					}
					brokeStale = true;
					continue;
				}
			}
			if (attempt + 1 >= LOCK_MAX_ATTEMPTS) {
				throw new Error(`Timed out acquiring team task lock ${lockPath}`);
			}
			await Bun.sleep(lockDelayMs(attempt));
		}
	}
	if (!handle) throw new Error(`Timed out acquiring team task lock ${lockPath}`);
	try {
		return await fn();
	} finally {
		await handle.close().catch(() => {});
		const stillOurs = await fs.readFile(lockPath, "utf8").then(content => content === token, () => false);
		if (stillOurs) await fs.rm(lockPath, { force: true }).catch(() => {});
	}
}

// =============================================================================
// Atomic persistence
// =============================================================================

/** Board state is private work metadata (mirrors security/store.ts). */
const BOARD_DIR_MODE = 0o700;
const TASK_FILE_MODE = 0o600;

async function ensureBoardDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true, mode: BOARD_DIR_MODE });
	// Defensive: recursive mkdir applies the mode only to leaf dirs it creates.
	if (process.platform !== "win32") await fs.chmod(dir, BOARD_DIR_MODE).catch(() => {});
}

async function writeTaskAtomic(filePath: string, task: TeamTask): Promise<void> {
	const tempPath = `${filePath}.${process.pid}.${Snowflake.next()}.tmp`;
	try {
		await fs.writeFile(tempPath, `${JSON.stringify(task, null, 2)}\n`, { encoding: "utf-8", mode: TASK_FILE_MODE });
		if (process.platform !== "win32") await fs.chmod(tempPath, TASK_FILE_MODE).catch(() => {});
		await fs.rename(tempPath, filePath);
	} catch (error) {
		await fs.rm(tempPath, { force: true }).catch(() => {});
		throw error;
	}
}

/**
 * On-disk text is untrusted: any same-user process can write the board dir,
 * bypassing the team tool's input cleaning, and the raw strings flow into
 * `team list` results and hub broadcasts. Cap sizes mirror the tool's
 * create/complete caps (title 200, free text 4000).
 */
function cleanStoredText(value: string, max: number): string {
	return sanitizeText(value).trim().slice(0, max);
}

/** Read one task file; missing or corrupt files yield `null` (corrupt logs a warning). */
async function readTaskFile(filePath: string): Promise<TeamTask | null> {
	let raw: string;
	try {
		raw = await Bun.file(filePath).text();
	} catch {
		return null;
	}
	try {
		const value: unknown = JSON.parse(raw);
		if (!isTeamTask(value)) {
			logger.warn("team board: skipping invalid task file", { filePath });
			return null;
		}
		return {
			...value,
			title: cleanStoredText(value.title, 200),
			description: value.description === undefined ? undefined : cleanStoredText(value.description, 4000),
			claimedBy: value.claimedBy === undefined ? undefined : cleanStoredText(value.claimedBy, 200),
			result: value.result === undefined ? undefined : cleanStoredText(value.result, 4000),
			blockedBy: value.blockedBy ?? [],
		};
	} catch {
		logger.warn("team board: skipping corrupt task file", { filePath });
		return null;
	}
}

// =============================================================================
// TeamBoard
// =============================================================================

export interface CreateTaskInput {
	title: string;
	description?: string;
	blockedBy?: string[];
	createdBy: string;
}

export class TeamBoard {
	constructor(readonly dir: string) {}

	#taskPath(taskId: string): string {
		return path.join(this.dir, `${taskId}.json`);
	}

	/** All tasks on the board, optionally filtered by status; corrupt files are skipped. */
	async list(filter?: { status?: TeamTaskStatus }): Promise<TeamTask[]> {
		let entries: string[];
		try {
			entries = await fs.readdir(this.dir);
		} catch {
			return [];
		}
		const tasks: TeamTask[] = [];
		for (const entry of entries) {
			if (!entry.endsWith(".json")) continue;
			const task = await readTaskFile(path.join(this.dir, entry));
			if (!task) continue;
			if (filter?.status && task.status !== filter.status) continue;
			tasks.push(task);
		}
		tasks.sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
		return tasks;
	}

	async create(input: CreateTaskInput): Promise<TeamBoardOutcome> {
		const title = input.title.trim();
		if (title.length === 0) {
			return failure("invalid_input", "Task title must be a non-empty string.");
		}
		const blockedBy = input.blockedBy ?? [];
		for (const depId of blockedBy) {
			if (!isValidTaskId(depId)) {
				return failure("invalid_input", `Invalid blockedBy task id "${depId}".`);
			}
		}
		if (new Set(blockedBy).size !== blockedBy.length) {
			return failure("invalid_input", "blockedBy contains duplicate task ids.");
		}
		await ensureBoardDir(this.dir);
		for (const depId of blockedBy) {
			if (!(await readTaskFile(this.#taskPath(depId)))) {
				return failure("invalid_input", `blockedBy task "${depId}" does not exist on the board.`);
			}
		}
		const task: TeamTask = {
			id: Snowflake.next(),
			title,
			status: "pending",
			blockedBy: [...blockedBy],
			createdBy: input.createdBy,
			createdAt: Date.now(),
		};
		if (input.description !== undefined && input.description.length > 0) task.description = input.description;
		try {
			await writeTaskAtomic(this.#taskPath(task.id), task);
		} catch (error) {
			return failure("io", `Failed to persist task: ${error instanceof Error ? error.message : String(error)}`);
		}
		return { ok: true, task };
	}

	/**
	 * Claim a pending task for `actor`. Exactly one concurrent claimer wins;
	 * losers get `already_claimed`. A task whose `blockedBy` prerequisites are
	 * not all done cannot be claimed (`blocked`).
	 */
	async claim(taskId: string, actor: string): Promise<TeamBoardOutcome> {
		if (!isValidTaskId(taskId)) return failure("invalid_input", `Invalid task id "${taskId}".`);
		await ensureBoardDir(this.dir);
		const filePath = this.#taskPath(taskId);
		try {
			return await withTaskLock(filePath, async () => {
				const task = await readTaskFile(filePath);
				if (!task) return failure("not_found", `Task "${taskId}" not found on the team board.`);
				if (task.status === "claimed") {
					return failure(
						"already_claimed",
						`Task "${taskId}" is already claimed by ${task.claimedBy ?? "another agent"}.`,
						{ task },
					);
				}
				if (task.status === "done") {
					return failure("invalid_state", `Task "${taskId}" is already done.`, { task });
				}
				const pendingBlockers: string[] = [];
				for (const depId of task.blockedBy) {
					const dep = await readTaskFile(this.#taskPath(depId));
					if (dep?.status !== "done") pendingBlockers.push(depId);
				}
				if (pendingBlockers.length > 0) {
					return failure(
						"blocked",
						`Task "${taskId}" is blocked by unfinished task(s): ${pendingBlockers.join(", ")}.`,
						{ task, pendingBlockers },
					);
				}
				task.status = "claimed";
				task.claimedBy = actor;
				task.claimedAt = Date.now();
				await writeTaskAtomic(filePath, task);
				return { ok: true, task };
			});
		} catch (error) {
			return failure("io", error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * Mark a claimed task done, then clear its id from every dependent's
	 * `blockedBy` (each under its own lock) so they become claimable.
	 */
	async complete(taskId: string, result?: string): Promise<TeamBoardOutcome> {
		if (!isValidTaskId(taskId)) return failure("invalid_input", `Invalid task id "${taskId}".`);
		await ensureBoardDir(this.dir);
		const filePath = this.#taskPath(taskId);
		let outcome: TeamBoardOutcome;
		try {
			outcome = await withTaskLock(filePath, async () => {
				const task = await readTaskFile(filePath);
				if (!task) return failure("not_found", `Task "${taskId}" not found on the team board.`);
				if (task.status !== "claimed") {
					return failure(
						"invalid_state",
						`Task "${taskId}" is ${task.status}; only a claimed task can be completed.`,
						{ task },
					);
				}
				task.status = "done";
				task.completedAt = Date.now();
				if (result !== undefined && result.length > 0) task.result = result;
				await writeTaskAtomic(filePath, task);
				return { ok: true, task } satisfies TeamBoardOutcome;
			});
		} catch (error) {
			return failure("io", error instanceof Error ? error.message : String(error));
		}
		if (!outcome.ok) return outcome;
		const unblocked: string[] = [];
		for (const dependent of await this.list()) {
			if (!dependent.blockedBy.includes(taskId)) continue;
			const depPath = this.#taskPath(dependent.id);
			try {
				await withTaskLock(depPath, async () => {
					const fresh = await readTaskFile(depPath);
					if (!fresh?.blockedBy.includes(taskId)) return;
					fresh.blockedBy = fresh.blockedBy.filter(id => id !== taskId);
					await writeTaskAtomic(depPath, fresh);
					unblocked.push(fresh.id);
				});
			} catch (error) {
				logger.warn("team board: failed to unblock dependent task", {
					taskId: dependent.id,
					completedTaskId: taskId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return { ok: true, task: outcome.task, unblocked };
	}

	/** Return a claimed task to pending so another agent can claim it. */
	async release(taskId: string): Promise<TeamBoardOutcome> {
		if (!isValidTaskId(taskId)) return failure("invalid_input", `Invalid task id "${taskId}".`);
		await ensureBoardDir(this.dir);
		const filePath = this.#taskPath(taskId);
		try {
			return await withTaskLock(filePath, async () => {
				const task = await readTaskFile(filePath);
				if (!task) return failure("not_found", `Task "${taskId}" not found on the team board.`);
				if (task.status !== "claimed") {
					return failure("invalid_state", `Task "${taskId}" is ${task.status}; not currently claimed.`, {
						task,
					});
				}
				task.status = "pending";
				delete task.claimedBy;
				delete task.claimedAt;
				await writeTaskAtomic(filePath, task);
				return { ok: true, task };
			});
		} catch (error) {
			return failure("io", error instanceof Error ? error.message : String(error));
		}
	}
}
