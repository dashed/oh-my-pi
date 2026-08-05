/**
 * TeamObserver — deterministic, zero-LLM team health monitor.
 *
 * Process-level (no AgentRef, no session, no parentId): keyed on the
 * process-global AgentRegistry, so it sees every agent regardless of spawner,
 * is not gated on any lead turn, and cannot be killed or parked by the lead.
 *
 * Feeds:
 * - AgentRegistry.onChange (status transitions, orphan/dead-owner signals).
 * - The shared SessionObserverRegistry (already feed-normalized on the
 *   task lifecycle/progress channels) — consumed, never double-subscribed.
 * - TeamBoard.list polled at observer.boardPollMs (no board event feed
 *   exists; polling is robust against missed broadcasts).
 *
 * Pathologies (thresholds from the observer.* settings namespace):
 * - P1 stuck-running: running with no activity past stuckThresholdMs; ignored
 *   while progress.retryState is set (intentional provider retry sleep).
 * - P2 error-loop: ≥ errorLoopMaxFailures terminal failures in
 *   errorLoopWindowMs for the same agent id.
 * - P3 parked-with-claimable-work: claimable pending board task while a
 *   worker has been parked past stallIdleMs.
 * - P4 board deadlock: blockedBy cycle, or a task claimed by an absent or
 *   aborted agent (read-only; the fix is manual `team release`).
 * - P5 cost/token runaway: per-run cost > maxCostPerRunUsd or tokens >
 *   maxTokensPerRun (the executor's existing guard is request-based).
 * - P6 all-idle-with-pending: claimable work, no running sub, every live sub
 *   idle/parked past stallIdleMs. Never flags Main-idle-with-no-pending.
 * - P7 orphaned agents: parentId set but absent from the registry (grace
 *   10s from registration).
 *
 * Action ladder ONLY — L1 dim status notice (dedup per pathology+agent per
 * window, ProviderHealthNotifier pattern) → L2 IrcBus.send DM nudge (gated by
 * observer.nudgeEnabled) → L3 TERMINAL.sendNotification to the user with the
 * exact manual fix. The observer NEVER parks, aborts, releases, or mutates
 * the board — kill/release authority stays with the user (hub `x`,
 * `team release`). Test-enforced invariant.
 */

import { TERMINAL, type TerminalNotification } from "@oh-my-pi/pi-tui";
import { formatDuration, logger, sanitizeText } from "@oh-my-pi/pi-utils";
import { settings } from "../config/settings";
import { IrcBus } from "../irc/bus";
import type { ObservableSession, SessionObserverRegistry } from "../modes/session-observer-registry";
import { type AgentRef, AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import { resolveTeamBoardDir, TeamBoard, type TeamTask } from "../teams/board";

// =============================================================================
// Types
// =============================================================================

export type TeamObserverPathology =
	| "stuck"
	| "error-loop"
	| "parked-stall"
	| "board-deadlock"
	| "cost-runaway"
	| "token-runaway"
	| "all-idle"
	| "orphan";

export interface TeamObserverConfig {
	enabled: boolean;
	boardPollMs: number;
	stuckThresholdMs: number;
	stallIdleMs: number;
	errorLoopMaxFailures: number;
	errorLoopWindowMs: number;
	maxCostPerRunUsd: number;
	maxTokensPerRun: number;
	nudgeEnabled: boolean;
}

/** Timer handle abstraction so tests can inject manual clocks (`.unref()` keeps real timers off the event-loop refcount). */
export interface ObserverTimerHandle {
	unref?(): void;
}

/** Minimal nudge channel; the default is the process-global IrcBus. */
export interface TeamObserverIrc {
	send(msg: { from: string; to: string; body: string; replyTo?: string }): Promise<unknown>;
}

export interface TeamObserverDeps {
	/** Injectable for tests; defaults to the process-global registry. */
	registry?: AgentRegistry;
	/** Shared, already feed-normalized observer registry (consumed, NOT re-subscribed to the event bus). */
	observers: SessionObserverRegistry;
	/** Board directory, or a lazy resolver; defaults to the Main (root) session's team board. */
	boardDir?: string | (() => string | undefined);
	/** Injectable for tests; defaults to the process-global bus. */
	irc?: TeamObserverIrc;
	/** L1 sink; defaults to a logger line. InteractiveMode passes a dim ctx.showStatus. */
	showStatus?: (message: string) => void;
	/** L3 sink; defaults to TERMINAL.sendNotification. */
	sendNotification?: (notification: TerminalNotification) => void;
	/** Clock; defaults to Date.now. */
	now?: () => number;
	setIntervalFn?: (cb: () => void, ms: number) => ObserverTimerHandle;
	clearIntervalFn?: (handle: ObserverTimerHandle) => void;
	setTimeoutFn?: (cb: () => void, ms: number) => ObserverTimerHandle;
	clearTimeoutFn?: (handle: ObserverTimerHandle) => void;
	/** Config reader; defaults to the observer.* settings namespace. */
	getConfig?: () => TeamObserverConfig;
}

/** Read-only snapshot of one active flag, for the Agent Hub observer line. */
export interface TeamObserverFlag {
	key: string;
	pathology: TeamObserverPathology;
	/** Agent id, task id, or board scope the flag is about. */
	subjectId: string;
	/** One-line human summary, e.g. "stuck — no progress for 4m". */
	summary: string;
	/** Exact manual fix, e.g. "team release <id>". */
	fix: string;
	firstSeenAt: number;
}

interface Detection {
	key: string;
	pathology: TeamObserverPathology;
	subjectId: string;
	summary: string;
	fix: string;
	/** L2 nudge recipient (agent id), when the ladder has a nudge step. */
	nudgeTarget?: string;
	nudgeBody?: string;
}

interface ActiveFlag extends Detection {
	firstSeenAt: number;
	lastNoticedAt: number;
	noticeCount: number;
	escalated: boolean;
	/** Consecutive scans where the pathology was absent (flap dampening). */
	missedScans: number;
}

// =============================================================================
// Constants
// =============================================================================

/** Sender id for L2 nudges; deliberately not a registered agent. */
const OBSERVER_SENDER_ID = "Observer";
/** L1 re-notice cadence per flag while a pathology persists (also the P4 re-flag window). */
const NOTICE_WINDOW_MS = 300_000;
/**
 * Consecutive absent scans a flag survives before its ladder state resets.
 * Without the grace, a flapping pathology (parked↔idle oscillation, retry
 * toggles) re-fires the L1 notice and re-sends the L2 DM on every flap.
 */
const FLAP_GRACE_SCANS = 2;
/** P7 grace: a freshly registered sub's parent may register moments later. */
const ORPHAN_GRACE_MS = 10_000;
/** Debounce for event-driven scans (progress itself is not a trigger). */
const EVENT_SCAN_DEBOUNCE_MS = 250;
/** Cap of flag lines surfaced via getActiveFlags consumers. */
const MAX_TRACKED_FLAGS = 100;

/**
 * Ladder policy per pathology: on which notice count the L2 nudge fires
 * (once per flag instance) and on which the L3 user escalation fires.
 * L1 notices fire every NOTICE_WINDOW_MS while the pathology persists.
 */
const LADDER: Record<TeamObserverPathology, { nudgeAtNotice?: number; escalateAtNotice?: number }> = {
	stuck: { nudgeAtNotice: 2, escalateAtNotice: 3 },
	"error-loop": { escalateAtNotice: 1 },
	"parked-stall": { nudgeAtNotice: 1, escalateAtNotice: 2 },
	"board-deadlock": { escalateAtNotice: 1 },
	"cost-runaway": { escalateAtNotice: 1 },
	"token-runaway": { escalateAtNotice: 1 },
	"all-idle": { nudgeAtNotice: 1, escalateAtNotice: 2 },
	// Low severity: notice-only, never escalates to an OS notification.
	orphan: {},
};

function configFromSettings(): TeamObserverConfig {
	return {
		enabled: settings.get("observer.enabled"),
		boardPollMs: settings.get("observer.boardPollMs"),
		stuckThresholdMs: settings.get("observer.stuckThresholdMs"),
		stallIdleMs: settings.get("observer.stallIdleMs"),
		errorLoopMaxFailures: settings.get("observer.errorLoopMaxFailures"),
		errorLoopWindowMs: settings.get("observer.errorLoopWindowMs"),
		maxCostPerRunUsd: settings.get("observer.maxCostPerRunUsd"),
		maxTokensPerRun: settings.get("observer.maxTokensPerRun"),
		nudgeEnabled: settings.get("observer.nudgeEnabled"),
	};
}

// =============================================================================
// Active observer accessor (Agent Hub reads flags without a wiring plumbing)
// =============================================================================

let activeTeamObserver: TeamObserver | undefined;

/** Register the live observer (InteractiveMode on start/stop). Test-only code should not need this. */
export function setActiveTeamObserver(observer: TeamObserver | undefined): void {
	activeTeamObserver = observer;
}

/** The live observer, when InteractiveMode has started one. */
export function getActiveTeamObserver(): TeamObserver | undefined {
	return activeTeamObserver;
}

// =============================================================================
// TeamObserver
// =============================================================================

export class TeamObserver {
	readonly #registry: AgentRegistry;
	readonly #observers: SessionObserverRegistry;
	readonly #boardDir: string | (() => string | undefined) | undefined;
	readonly #irc: TeamObserverIrc;
	readonly #showStatus: (message: string) => void;
	readonly #sendNotification: (notification: TerminalNotification) => void;
	readonly #now: () => number;
	readonly #setInterval: (cb: () => void, ms: number) => ObserverTimerHandle;
	readonly #clearInterval: (handle: ObserverTimerHandle) => void;
	readonly #setTimeout: (cb: () => void, ms: number) => ObserverTimerHandle;
	readonly #clearTimeout: (handle: ObserverTimerHandle) => void;
	readonly #getConfig: () => TeamObserverConfig;

	#started = false;
	#disposed = false;
	#pollTimer: ObserverTimerHandle | undefined;
	#eventScanTimer: ObserverTimerHandle | undefined;
	#unsubscribers: Array<() => void> = [];
	#scanInFlight = false;
	#scanQueued = false;

	readonly #flags = new Map<string, ActiveFlag>();
	readonly #nudgedKeys = new Set<string>();
	/** Failure timestamps per agent id, fed by observer-registry lifecycle transitions. */
	readonly #failureTimestamps = new Map<string, number[]>();
	/** Last observed status per session id, so one terminal failure records exactly once. */
	readonly #lastObservedStatus = new Map<string, ObservableSession["status"]>();

	constructor(deps: TeamObserverDeps) {
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#observers = deps.observers;
		this.#boardDir = deps.boardDir;
		this.#irc = deps.irc ?? IrcBus.global();
		this.#showStatus = deps.showStatus ?? (message => logger.info(`team-observer: ${message}`));
		this.#sendNotification = deps.sendNotification ?? (notification => TERMINAL.sendNotification(notification));
		this.#now = deps.now ?? Date.now;
		this.#setInterval = deps.setIntervalFn ?? ((cb, ms) => setInterval(cb, ms));
		this.#clearInterval = deps.clearIntervalFn ?? (handle => clearInterval(handle as NodeJS.Timeout));
		this.#setTimeout = deps.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
		this.#clearTimeout = deps.clearTimeoutFn ?? (handle => clearTimeout(handle as NodeJS.Timeout));
		this.#getConfig = deps.getConfig ?? configFromSettings;
	}

	/** Arm subscriptions + the board poll interval and run a first scan. */
	start(): void {
		if (this.#started || this.#disposed) return;
		this.#started = true;
		const config = this.#getConfig();

		this.#unsubscribers.push(
			this.#registry.onChange(() => {
				this.#scheduleEventScan();
			}),
		);
		this.#unsubscribers.push(
			this.#observers.onChange(kind => {
				if (kind === "reset") {
					this.#failureTimestamps.clear();
					this.#lastObservedStatus.clear();
					return;
				}
				if (kind === "lifecycle") {
					this.#trackFailures();
					this.#scheduleEventScan();
				}
			}),
		);

		const pollMs = Math.max(250, config.boardPollMs);
		this.#pollTimer = this.#setInterval(() => {
			this.#pumpScan();
		}, pollMs);
		this.#pollTimer.unref?.();
	}

	/** Clear every timer and unsubscribe every feed. Idempotent. */
	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		if (this.#pollTimer) {
			this.#clearInterval(this.#pollTimer);
			this.#pollTimer = undefined;
		}
		if (this.#eventScanTimer) {
			this.#clearTimeout(this.#eventScanTimer);
			this.#eventScanTimer = undefined;
		}
	}

	/** Active flags, oldest first (Agent Hub observer line). */
	getActiveFlags(): TeamObserverFlag[] {
		return [...this.#flags.values()]
			.sort((a, b) => a.firstSeenAt - b.firstSeenAt || (a.key < b.key ? -1 : 1))
			.map(flag => ({
				key: flag.key,
				pathology: flag.pathology,
				subjectId: flag.subjectId,
				summary: flag.summary,
				fix: flag.fix,
				firstSeenAt: flag.firstSeenAt,
			}));
	}

	// ========================================================================
	// Scheduling
	// ========================================================================

	#scheduleEventScan(): void {
		if (this.#disposed || this.#eventScanTimer) return;
		this.#eventScanTimer = this.#setTimeout(() => {
			this.#eventScanTimer = undefined;
			this.#pumpScan();
		}, EVENT_SCAN_DEBOUNCE_MS);
		this.#eventScanTimer.unref?.();
	}

	/** Reentrancy-guarded scan pump: an event during an async scan queues exactly one follow-up. */
	#pumpScan(): void {
		if (this.#disposed) return;
		if (this.#scanInFlight) {
			this.#scanQueued = true;
			return;
		}
		this.#scanInFlight = true;
		void this.#scan()
			.catch(error => {
				logger.warn("team-observer: scan failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			})
			.finally(() => {
				this.#scanInFlight = false;
				if (this.#scanQueued && !this.#disposed) {
					this.#scanQueued = false;
					this.#pumpScan();
				}
			});
	}

	// ========================================================================
	// Failure tracking (P2 feed)
	// ========================================================================

	#trackFailures(): void {
		const now = this.#now();
		for (const session of this.#observers.getSessions()) {
			const previous = this.#lastObservedStatus.get(session.id);
			this.#lastObservedStatus.set(session.id, session.status);
			if (session.status === "failed" && previous !== "failed") {
				const list = this.#failureTimestamps.get(session.id) ?? [];
				list.push(now);
				this.#failureTimestamps.set(session.id, list);
			}
		}
	}

	// ========================================================================
	// Scan
	// ========================================================================

	async #scan(): Promise<void> {
		if (this.#disposed) return;
		await this.scanForTest();
	}

	/**
	 * @internal Test seam: one full scan cycle, awaited. Production drives
	 * scans through the interval/event pump; tests call this directly so fake
	 * clocks stay deterministic without flushing real fs through the pump.
	 */
	async scanForTest(): Promise<void> {
		const config = this.#getConfig();
		if (!config.enabled) {
			this.#flags.clear();
			this.#nudgedKeys.clear();
			return;
		}
		const now = this.#now();
		const refs = this.#registry.list();
		const tasks = await this.#listTasks();
		if (this.#disposed) return;

		const detections: Detection[] = [];
		this.#detectStuck(refs, now, config, detections);
		this.#detectErrorLoops(refs, now, config, detections);
		this.#detectParkedStall(refs, tasks, now, config, detections);
		this.#detectBoardDeadlock(tasks, detections);
		this.#detectRunaway(refs, config, detections);
		this.#detectAllIdle(refs, tasks, now, config, detections);
		this.#detectOrphans(refs, now, detections);
		this.#applyDetections(detections, now, config);
	}

	async #listTasks(): Promise<TeamTask[]> {
		const dir = this.#resolveBoardDir();
		if (!dir) return [];
		try {
			return await new TeamBoard(dir).list();
		} catch (error) {
			logger.warn("team-observer: board list failed", {
				dir,
				error: error instanceof Error ? error.message : String(error),
			});
			return [];
		}
	}

	#resolveBoardDir(): string | undefined {
		if (typeof this.#boardDir === "function") return this.#boardDir();
		if (typeof this.#boardDir === "string") return this.#boardDir;
		// Main is the root of the agent tree (one per generation), so its live
		// session id is the team id — the same value resolveTeamId walks to.
		const sessionId = this.#registry.get(MAIN_AGENT_ID)?.session?.sessionManager.getSessionId();
		return sessionId ? resolveTeamBoardDir(sessionId) : undefined;
	}

	// ========================================================================
	// Detectors
	// ========================================================================

	/** P1: running with no activity past stuckThresholdMs (retryState sleep excluded). */
	#detectStuck(refs: AgentRef[], now: number, config: TeamObserverConfig, out: Detection[]): void {
		for (const ref of refs) {
			if (ref.id === MAIN_AGENT_ID || ref.kind === "advisor" || ref.status !== "running") continue;
			const observed = this.#observers.getSession(ref.id);
			if (observed?.progress?.retryState) continue;
			const lastProgress = Math.max(ref.lastActivity, observed?.lastUpdate ?? 0);
			const silentMs = now - lastProgress;
			if (silentMs < config.stuckThresholdMs) continue;
			const summary = `stuck — no progress for ${formatDuration(silentMs)}`;
			out.push({
				key: `stuck:${ref.id}`,
				pathology: "stuck",
				subjectId: ref.id,
				summary,
				fix: `kill ${ref.id} via Agent Hub (x), or DM it via irc`,
				nudgeTarget: ref.id,
				nudgeBody: `[team-observer] You appear stuck (${summary}). Resume work, or yield your task so a peer can pick it up.`,
			});
		}
	}

	/** P2: ≥ maxFailures terminal failures inside the window for one agent id. */
	#detectErrorLoops(refs: AgentRef[], now: number, config: TeamObserverConfig, out: Detection[]): void {
		const cutoff = now - config.errorLoopWindowMs;
		const names = new Map(refs.map(ref => [ref.id, ref.displayName]));
		for (const [id, timestamps] of this.#failureTimestamps) {
			const fresh = timestamps.filter(ts => ts >= cutoff);
			if (fresh.length === 0) {
				this.#failureTimestamps.delete(id);
				continue;
			}
			if (fresh.length !== timestamps.length) this.#failureTimestamps.set(id, fresh);
			if (fresh.length < config.errorLoopMaxFailures) continue;
			if (this.#registry.get(id)?.kind === "advisor") continue;
			const name = names.get(id) ?? id;
			out.push({
				key: `error-loop:${id}`,
				pathology: "error-loop",
				subjectId: id,
				summary: `error loop — ${fresh.length} failures in ${formatDuration(config.errorLoopWindowMs)}`,
				fix: `inspect history://${id}; kill ${name} if it keeps churning`,
			});
		}
	}

	/** P3: claimable pending work while a worker has been parked past stallIdleMs. */
	#detectParkedStall(
		refs: AgentRef[],
		tasks: TeamTask[],
		now: number,
		config: TeamObserverConfig,
		out: Detection[],
	): void {
		const claimable = claimableTasks(tasks);
		if (claimable.length === 0) return;
		if (refs.some(ref => ref.kind === "sub" && ref.status === "running")) return;
		const task = claimable[0]!;
		for (const ref of refs) {
			if (ref.kind !== "sub" || ref.status !== "parked") continue;
			const idleMs = now - ref.lastActivity;
			if (idleMs < config.stallIdleMs) continue;
			out.push({
				key: `parked-stall:${ref.id}`,
				pathology: "parked-stall",
				subjectId: ref.id,
				summary: `parked ${formatDuration(idleMs)} with claimable work on the board`,
				fix: `DM ${ref.id} to revive it, or claim "${task.title}" (${task.id}) yourself`,
				nudgeTarget: ref.id,
				nudgeBody: `[team-observer] Claimable work is waiting on the team board: "${task.title}" (${task.id}). Run \`team list\` and claim it.`,
			});
		}
	}

	/** P4: blockedBy cycle, or a task claimed by an absent/aborted agent. Read-only. */
	#detectBoardDeadlock(tasks: TeamTask[], out: Detection[]): void {
		const cycle = findBlockedByCycle(tasks);
		if (cycle && cycle.length > 0) {
			const ids = [...cycle].sort();
			out.push({
				key: `board-deadlock:cycle:${ids.join(",")}`,
				pathology: "board-deadlock",
				subjectId: ids[0]!,
				summary: `board deadlock — blockedBy cycle ${cycle.join(" → ")}`,
				fix: `break the cycle manually: team release ${ids[0]} (or complete one of ${ids.join(", ")})`,
			});
		}
		for (const task of tasks) {
			if (task.status !== "claimed" || !task.claimedBy || task.claimedBy === MAIN_AGENT_ID) continue;
			const owner = this.#registry.get(task.claimedBy);
			if (owner && owner.status !== "aborted") continue;
			out.push({
				key: `board-deadlock:owner:${task.id}`,
				pathology: "board-deadlock",
				subjectId: task.id,
				summary: `board deadlock — "${task.title}" (${task.id}) claimed by ${owner ? "aborted" : "gone"} agent ${task.claimedBy}`,
				fix: `team release ${task.id}`,
			});
		}
	}

	/** P5: per-run cost or token budget overrun (the executor's guard is request-based). */
	#detectRunaway(refs: AgentRef[], config: TeamObserverConfig, out: Detection[]): void {
		for (const ref of refs) {
			if (ref.kind !== "sub" || ref.status !== "running") continue;
			const observed = this.#observers.getSession(ref.id);
			const progress = observed?.progress;
			if (observed?.status !== "active" || !progress) continue;
			if (progress.cost > config.maxCostPerRunUsd) {
				out.push({
					key: `cost-runaway:${ref.id}`,
					pathology: "cost-runaway",
					subjectId: ref.id,
					summary: `cost runaway — $${progress.cost.toFixed(2)} spent > $${config.maxCostPerRunUsd} budget`,
					fix: `kill ${ref.id} via Agent Hub (x) to stop the spend`,
				});
			}
			if (progress.tokens > config.maxTokensPerRun) {
				out.push({
					key: `token-runaway:${ref.id}`,
					pathology: "token-runaway",
					subjectId: ref.id,
					summary: `token runaway — ${progress.tokens.toLocaleString()} tokens > ${config.maxTokensPerRun.toLocaleString()} budget`,
					fix: `kill ${ref.id} via Agent Hub (x) to stop the burn`,
				});
			}
		}
	}

	/** P6: claimable work, no running sub, every live sub idle/parked past stallIdleMs. Never Main-idle-no-pending. */
	#detectAllIdle(
		refs: AgentRef[],
		tasks: TeamTask[],
		now: number,
		config: TeamObserverConfig,
		out: Detection[],
	): void {
		const claimable = claimableTasks(tasks);
		if (claimable.length === 0) return;
		const subs = refs.filter(ref => ref.kind === "sub" && ref.status !== "aborted");
		if (subs.length === 0) return;
		if (subs.some(ref => ref.status === "running")) return;
		if (subs.some(ref => now - ref.lastActivity < config.stallIdleMs)) return;
		const task = claimable[0]!;
		// Nudge the most recently active worker: prefer a live idle one (cheap
		// wake) over parked (revival). When NO idle worker exists the target is
		// parked, and P3 already DM'd every parked worker individually this same
		// scan — the board-level flag then carries no nudge of its own instead
		// of double-DMing the same worker with a near-identical body.
		const target = [...subs].sort(
			(a, b) => (a.status === "idle" ? 0 : 1) - (b.status === "idle" ? 0 : 1) || b.lastActivity - a.lastActivity,
		)[0]!;
		const ownedByParkedStall = target.status === "parked";
		out.push({
			key: "all-idle:board",
			pathology: "all-idle",
			subjectId: "board",
			summary: `team stalled — ${claimable.length} claimable task${claimable.length === 1 ? "" : "s"}, all ${subs.length} workers idle/parked`,
			fix: `DM ${target.id} or claim "${task.title}" (${task.id}) yourself`,
			nudgeTarget: ownedByParkedStall ? undefined : target.id,
			nudgeBody: ownedByParkedStall
				? undefined
				: `[team-observer] The team is stalled: ${claimable.length} claimable task${claimable.length === 1 ? "" : "s"} (e.g. "${task.title}" ${task.id}) and every worker is idle/parked. Run \`team list\` and claim one.`,
		});
	}

	/** P7: parentId set but absent from the registry, past the registration grace. */
	#detectOrphans(refs: AgentRef[], now: number, out: Detection[]): void {
		for (const ref of refs) {
			if (ref.kind !== "sub" || !ref.parentId) continue;
			if (now - ref.createdAt < ORPHAN_GRACE_MS) continue;
			if (this.#registry.get(ref.parentId)) continue;
			out.push({
				key: `orphan:${ref.id}`,
				pathology: "orphan",
				subjectId: ref.id,
				summary: `orphaned — parent ${ref.parentId} is gone`,
				fix: `kill ${ref.id} via Agent Hub (x); its parent is gone`,
			});
		}
	}

	// ========================================================================
	// Action ladder
	// ========================================================================

	#applyDetections(detections: Detection[], now: number, config: TeamObserverConfig): void {
		const seen = new Set<string>();
		for (const detection of detections) {
			seen.add(detection.key);
			let flag = this.#flags.get(detection.key);
			if (!flag) {
				if (this.#flags.size >= MAX_TRACKED_FLAGS) continue;
				flag = {
					...detection,
					firstSeenAt: now,
					lastNoticedAt: 0,
					noticeCount: 0,
					escalated: false,
					missedScans: 0,
				};
				this.#flags.set(detection.key, flag);
			} else {
				flag.summary = detection.summary;
				flag.fix = detection.fix;
				flag.nudgeTarget = detection.nudgeTarget;
				flag.nudgeBody = detection.nudgeBody;
				flag.missedScans = 0;
			}

			if (now - flag.lastNoticedAt < NOTICE_WINDOW_MS) continue;
			flag.lastNoticedAt = now;
			flag.noticeCount++;

			// L1: dim status notice (ProviderHealthNotifier pattern). Agent/board-derived
			// text is control-stripped before it reaches the terminal.
			this.#showStatus(sanitizeText(`Observer: ${flag.summary} (${flag.subjectId}) — ${flag.fix}`));

			// L2: one DM nudge per flag instance (wakes idle / revives parked).
			const ladder = LADDER[flag.pathology];
			if (
				ladder.nudgeAtNotice !== undefined &&
				flag.noticeCount >= ladder.nudgeAtNotice &&
				flag.nudgeTarget &&
				flag.nudgeBody &&
				config.nudgeEnabled &&
				!this.#nudgedKeys.has(flag.key)
			) {
				this.#nudgedKeys.add(flag.key);
				const target = flag.nudgeTarget;
				const body = flag.nudgeBody;
				void this.#irc.send({ from: OBSERVER_SENDER_ID, to: target, body }).catch(error => {
					logger.warn("team-observer: nudge failed", {
						target,
						error: error instanceof Error ? error.message : String(error),
					});
				});
			}

			// L3: one OS notification per flag instance, naming the exact manual fix.
			if (ladder.escalateAtNotice !== undefined && flag.noticeCount >= ladder.escalateAtNotice && !flag.escalated) {
				flag.escalated = true;
				this.#sendNotification({
					title: `Team observer: ${flag.pathology}`,
					body: sanitizeText(`${flag.summary} (${flag.subjectId}) — fix: ${flag.fix}`),
					type: "warning",
					urgency: "normal",
					actions: "focus",
				});
			}
		}

		// Clear resolved flags (with a dim recovery notice when the user was
		// told) — but only after FLAP_GRACE_SCANS consecutive absent scans, so a
		// flapping pathology does not reset the ladder and re-fire the L1
		// notice + L2 DM on every flap.
		for (const [key, flag] of [...this.#flags]) {
			if (seen.has(key)) continue;
			flag.missedScans++;
			if (flag.missedScans <= FLAP_GRACE_SCANS) continue;
			this.#flags.delete(key);
			this.#nudgedKeys.delete(key);
			if (flag.noticeCount > 0) {
				this.#showStatus(sanitizeText(`Observer: cleared — ${flag.pathology} (${flag.subjectId})`));
			}
		}
	}
}

// =============================================================================
// Board helpers (pure, read-only)
// =============================================================================

/** Pending tasks whose blockedBy entries all point at done tasks (completion also clears entries). */
function claimableTasks(tasks: TeamTask[]): TeamTask[] {
	const done = new Set(tasks.filter(task => task.status === "done").map(task => task.id));
	return tasks.filter(task => task.status === "pending" && task.blockedBy.every(id => done.has(id)));
}

/**
 * DFS over blockedBy edges between unfinished tasks; returns the cycle's task
 * ids in walk order, or undefined. board.create validates blocker existence
 * but has no cycle check — this is the detector for that gap.
 */
function findBlockedByCycle(tasks: TeamTask[]): string[] | undefined {
	const byId = new Map(tasks.map(task => [task.id, task]));
	const state = new Map<string, "visiting" | "done">();
	const stack: string[] = [];

	const visit = (id: string): string[] | undefined => {
		const seen = state.get(id);
		if (seen === "done") return undefined;
		if (seen === "visiting") return stack.slice(stack.indexOf(id));
		const task = byId.get(id);
		if (!task || task.status === "done") {
			state.set(id, "done");
			return undefined;
		}
		state.set(id, "visiting");
		stack.push(id);
		for (const dep of task.blockedBy) {
			const depTask = byId.get(dep);
			if (!depTask || depTask.status === "done") continue;
			const cycle = visit(dep);
			if (cycle) return cycle;
		}
		stack.pop();
		state.set(id, "done");
		return undefined;
	};

	for (const task of tasks) {
		if (task.status === "done") continue;
		const cycle = visit(task.id);
		if (cycle) return cycle;
	}
	return undefined;
}
