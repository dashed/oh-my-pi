/**
 * TeamObserver pathology-injection tests: concrete AgentRegistry with fake
 * refs, a SessionObserverRegistry fed by a hand-rolled EventBus with real
 * channel payload shapes, a TeamBoard on a temp dir, recording
 * showStatus/notification sinks, a fake IrcBus, and an injected manual clock
 * + captured timers — fully deterministic, no global fake timers.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import {
	type ObserverTimerHandle,
	TeamObserver,
	type TeamObserverConfig,
} from "@oh-my-pi/pi-coding-agent/observer/team-observer";
import { AgentRegistry, type AgentStatus, MAIN_AGENT_ID } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@oh-my-pi/pi-coding-agent/task/types";
import { TeamBoard, type TeamTask } from "@oh-my-pi/pi-coding-agent/teams/board";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import type { TerminalNotification } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

// =============================================================================
// Harness
// =============================================================================

const STUCK_MS = 180_000;
const STALL_MS = 120_000;
const ERROR_WINDOW_MS = 600_000;
const NOTICE_WINDOW_MS = 300_000;
const ORPHAN_GRACE_MS = 10_000;

function makeConfig(overrides: Partial<TeamObserverConfig> = {}): TeamObserverConfig {
	return {
		enabled: true,
		boardPollMs: 5_000,
		stuckThresholdMs: STUCK_MS,
		stallIdleMs: STALL_MS,
		errorLoopMaxFailures: 3,
		errorLoopWindowMs: ERROR_WINDOW_MS,
		maxCostPerRunUsd: 5,
		maxTokensPerRun: 2_000_000,
		nudgeEnabled: true,
		...overrides,
	};
}

interface FakeTimeout {
	cb: () => void;
	ms: number;
	cleared: boolean;
	handle: ObserverTimerHandle;
}

class Harness {
	/** Real-time base so registry/bus Date.now() stamps stay behind the fake clock as it advances. */
	readonly clock = { now: Date.now() };
	readonly registry = new AgentRegistry();
	readonly bus = new EventBus();
	readonly observers = new SessionObserverRegistry();
	readonly statuses: string[] = [];
	readonly notifications: TerminalNotification[] = [];
	readonly nudges: Array<{ from: string; to: string; body: string }> = [];
	readonly timeouts: FakeTimeout[] = [];
	pollHandle: { unrefCalled: boolean } | undefined;
	temp!: TempDir;
	board!: TeamBoard;
	observer!: TeamObserver;
	config = makeConfig();

	async init(): Promise<this> {
		this.observers.subscribeToEventBus(this.bus);
		this.observer = new TeamObserver({
			registry: this.registry,
			observers: this.observers,
			boardDir: () => this.board.dir,
			irc: {
				send: msg => {
					this.nudges.push({ from: msg.from, to: msg.to, body: msg.body });
					return Promise.resolve({ to: msg.to, outcome: "injected" });
				},
			},
			showStatus: message => this.statuses.push(message),
			sendNotification: notification => this.notifications.push(notification),
			now: () => this.clock.now,
			setIntervalFn: (_cb, _ms) => {
				const pollHandle = { unrefCalled: false };
				this.pollHandle = pollHandle;
				return {
					unref() {
						pollHandle.unrefCalled = true;
					},
				};
			},
			clearIntervalFn: () => {},
			setTimeoutFn: (cb, ms) => {
				const entry: FakeTimeout = { cb, ms, cleared: false, handle: { unref() {} } };
				this.timeouts.push(entry);
				return entry.handle;
			},
			clearTimeoutFn: handle => {
				const entry = this.timeouts.find(t => t.handle === handle);
				if (entry) entry.cleared = true;
			},
			getConfig: () => this.config,
		});
		this.board = new TeamBoard(this.temp.join("tasks"));
		return this;
	}

	async start(): Promise<void> {
		this.observer.start();
		// start() pumps an immediate (detached) async scan; run the awaitable
		// seam instead of racing the real-fs pump through the event loop.
		await this.observer.scanForTest();
	}

	/** One full scan cycle — what the board-poll interval pumps. */
	poll(): Promise<void> {
		return this.observer.scanForTest();
	}

	advance(ms: number): void {
		this.clock.now += ms;
	}

	register(id: string, opts: { kind?: "main" | "sub" | "advisor"; status?: AgentStatus; parentId?: string } = {}) {
		return this.registry.register({
			id,
			displayName: id,
			kind: opts.kind ?? "sub",
			parentId: opts.parentId,
			session: null,
			sessionFile: null,
			status: opts.status ?? "running",
		});
	}

	/** Pin a ref's activity timestamp in the fake time domain. */
	setActivity(id: string, at: number): void {
		const ref = this.registry.get(id);
		if (!ref) throw new Error(`no ref ${id}`);
		ref.lastActivity = at;
	}

	emitLifecycle(id: string, status: "started" | "completed" | "failed" | "aborted"): void {
		const payload: SubagentLifecyclePayload = { id, agent: "task", agentSource: "bundled", status, index: 0 };
		this.bus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, payload);
	}

	emitProgress(id: string, overrides: Partial<AgentProgress> = {}): void {
		const progress: AgentProgress = {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			status: "running",
			task: "task",
			recentTools: [],
			recentOutput: [],
			toolCount: 1,
			requests: 1,
			tokens: 100,
			cost: 0.01,
			durationMs: 1_000,
			...overrides,
		};
		const payload: SubagentProgressPayload = {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "task",
			progress,
		};
		this.bus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, payload);
	}

	/** One terminal failure (started → failed transition records exactly once). */
	emitFailure(id: string): void {
		this.emitLifecycle(id, "started");
		this.emitLifecycle(id, "failed");
	}

	flags() {
		return this.observer.getActiveFlags();
	}

	flagKeys(): string[] {
		return this.flags().map(flag => flag.key);
	}
}

async function boardBytes(dir: string): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	let entries: string[] = [];
	try {
		entries = await fs.readdir(dir);
	} catch {
		return out;
	}
	for (const entry of entries.sort()) {
		if (!entry.endsWith(".json")) continue;
		out.set(entry, await fs.readFile(path.join(dir, entry), "utf8"));
	}
	return out;
}

function makeTask(overrides: Partial<TeamTask> & { id: string; title: string }): TeamTask {
	return {
		status: "pending",
		blockedBy: [],
		createdBy: "test",
		createdAt: 1,
		...overrides,
	};
}

async function writeTask(dir: string, task: TeamTask): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
	await Bun.write(path.join(dir, `${task.id}.json`), `${JSON.stringify(task, null, 2)}\n`);
}

let temp: TempDir;
let harness: Harness;

beforeEach(async () => {
	temp = await TempDir.create("omp-team-observer-");
	harness = new Harness();
	harness.temp = temp;
	await harness.init();
});

afterEach(async () => {
	harness.observer.dispose();
	harness.observers.dispose();
	await temp.remove();
});

// =============================================================================
// (1) P1 stuck-running: notify → nudge → escalate ladder, dedup, clear
// =============================================================================

describe("P1 stuck running agent", () => {
	it("flags past the threshold, ladders notice → nudge → user, dedups within the window, clears on progress", async () => {
		harness.register("Worker");
		harness.setActivity("Worker", harness.clock.now);
		await harness.start();
		expect(harness.flags()).toHaveLength(0);

		// Cross the stuck threshold → L1 notice, no nudge yet (nudge at 2nd notice).
		harness.advance(STUCK_MS + 1);
		await harness.poll();
		expect(harness.flagKeys()).toEqual(["stuck:Worker"]);
		expect(harness.statuses.filter(s => s.includes("stuck"))).toHaveLength(1);
		expect(harness.nudges).toHaveLength(0);
		expect(harness.notifications).toHaveLength(0);

		// Dedup: another poll inside the notice window adds nothing.
		await harness.poll();
		expect(harness.statuses.filter(s => s.includes("stuck"))).toHaveLength(1);

		// Second notice window → L2 nudge fires once.
		harness.advance(NOTICE_WINDOW_MS);
		await harness.poll();
		expect(harness.statuses.filter(s => s.includes("stuck"))).toHaveLength(2);
		expect(harness.nudges).toHaveLength(1);
		expect(harness.nudges[0]!.to).toBe("Worker");
		expect(harness.notifications).toHaveLength(0);

		// Third notice window → L3 user escalation naming the manual kill.
		harness.advance(NOTICE_WINDOW_MS);
		await harness.poll();
		expect(harness.nudges).toHaveLength(1);
		expect(harness.notifications).toHaveLength(1);
		expect(harness.notifications[0]!.body).toContain("kill Worker");

		// Clear on progress: fresh activity drops the flag (with a dim clear notice).
		harness.setActivity("Worker", harness.clock.now);
		await harness.poll();
		expect(harness.flags()).toHaveLength(0);
		expect(harness.statuses.some(s => s.includes("cleared") && s.includes("stuck"))).toBe(true);
	});

	it("ignores a running agent sleeping in provider retryState", async () => {
		harness.register("Retrying");
		harness.setActivity("Retrying", harness.clock.now);
		harness.emitLifecycle("Retrying", "started");
		await harness.start();

		harness.advance(STUCK_MS * 2);
		harness.emitProgress("Retrying", {
			retryState: { attempt: 2, maxAttempts: 5, delayMs: 60_000, errorMessage: "429", startedAtMs: 1 },
		});
		await harness.poll();
		expect(harness.flags()).toHaveLength(0);
	});

	it("never flags Main", async () => {
		harness.register(MAIN_AGENT_ID, { kind: "main" });
		harness.setActivity(MAIN_AGENT_ID, harness.clock.now);
		await harness.start();
		harness.advance(STUCK_MS * 2);
		await harness.poll();
		expect(harness.flags()).toHaveLength(0);
	});
});

// =============================================================================
// (2) P2 error loop
// =============================================================================

describe("P2 error-looping agent", () => {
	it("flags at 3 failures in the window, stays quiet at 2, re-arms past the window", async () => {
		harness.register("Flaky", { status: "idle" });
		await harness.start();

		harness.emitFailure("Flaky");
		harness.emitFailure("Flaky");
		await harness.poll();
		expect(harness.flags()).toHaveLength(0);

		harness.emitFailure("Flaky");
		await harness.poll();
		expect(harness.flagKeys()).toEqual(["error-loop:Flaky"]);
		// Ladder: escalate on the first notice; no nudge step.
		expect(harness.notifications).toHaveLength(1);
		expect(harness.notifications[0]!.body).toContain("history://Flaky");
		expect(harness.nudges).toHaveLength(0);

		// Past the window the failures age out and the flag clears.
		harness.advance(ERROR_WINDOW_MS + 1);
		await harness.poll();
		expect(harness.flags()).toHaveLength(0);

		// A single fresh failure does not re-flag (window re-armed).
		harness.emitFailure("Flaky");
		await harness.poll();
		expect(harness.flags()).toHaveLength(0);

		// Two more inside the fresh window re-flag.
		harness.emitFailure("Flaky");
		harness.emitFailure("Flaky");
		await harness.poll();
		expect(harness.flagKeys()).toEqual(["error-loop:Flaky"]);
	});
});

// =============================================================================
// (3) P3 parked with claimable work
// =============================================================================

describe("P3 parked worker with claimable work", () => {
	it("nudges the parked agent first, escalates on the second notice, clears when work is claimed", async () => {
		const created = await harness.board.create({ title: "Wire retry tests", createdBy: "test" });
		if (!created.ok) throw new Error(created.message);
		harness.register("Sleeper", { status: "parked" });
		harness.setActivity("Sleeper", harness.clock.now);
		await harness.start();

		// Parked past stallIdleMs with claimable work → flag + immediate nudge.
		// (The team-wide all-idle detector co-fires for a lone parked worker.)
		harness.advance(STALL_MS + 1);
		await harness.poll();
		expect(harness.flagKeys()).toContain("parked-stall:Sleeper");
		const stallNudge = harness.nudges.find(n => n.body.includes("team list"));
		expect(stallNudge?.to).toBe("Sleeper");
		expect(harness.notifications).toHaveLength(0);

		// Second notice → L3 user escalation.
		harness.advance(NOTICE_WINDOW_MS);
		await harness.poll();
		expect(harness.notifications.filter(n => n.title === "Team observer: parked-stall")).toHaveLength(1);

		// Claim + complete the work → flag clears.
		const claimed = await harness.board.claim(created.task.id, "test");
		if (!claimed.ok) throw new Error(claimed.message);
		const completed = await harness.board.complete(created.task.id);
		if (!completed.ok) throw new Error(completed.message);
		await harness.poll();
		expect(harness.flags()).toHaveLength(0);
	});

	it("does not flag a freshly parked worker, nor when no work is claimable, nor while a sub runs", async () => {
		await harness.board.create({ title: "Available", createdBy: "test" });
		harness.register("Sleeper", { status: "parked" });
		harness.setActivity("Sleeper", harness.clock.now);
		await harness.start();

		// Fresh park (< stallIdleMs) → quiet.
		harness.advance(STALL_MS - 1);
		await harness.poll();
		expect(harness.flags()).toHaveLength(0);

		// A running sub means the team is working → quiet.
		harness.register("Busy", { status: "running" });
		harness.setActivity("Busy", harness.clock.now);
		harness.advance(2);
		await harness.poll();
		expect(harness.flags()).toHaveLength(0);
	});
});

// =============================================================================
// (4) P4 board deadlock — read-only invariant
// =============================================================================

describe("P4 board deadlock", () => {
	it("flags blockedBy cycles and claimed-by-dead-owner tasks; board files stay byte-identical", async () => {
		// A cycle cannot be created through board.create (blockers must exist) —
		// write the pair directly.
		await writeTask(harness.board.dir, makeTask({ id: "taskA", title: "A", blockedBy: ["taskB"] }));
		await writeTask(harness.board.dir, makeTask({ id: "taskB", title: "B", blockedBy: ["taskA"] }));
		// Claimed by an agent that does not exist in the registry.
		await writeTask(
			harness.board.dir,
			makeTask({ id: "taskC", title: "C", status: "claimed", claimedBy: "ghost", claimedAt: 1 }),
		);
		// Claimed by a hard-aborted agent.
		harness.register("Dead", { status: "aborted" });
		await writeTask(
			harness.board.dir,
			makeTask({ id: "taskD", title: "D", status: "claimed", claimedBy: "Dead", claimedAt: 1 }),
		);
		const before = await boardBytes(harness.board.dir);
		await harness.start();
		await harness.poll();

		const keys = harness.flagKeys();
		expect(keys.some(key => key.startsWith("board-deadlock:cycle:"))).toBe(true);
		expect(keys).toContain("board-deadlock:owner:taskC");
		expect(keys).toContain("board-deadlock:owner:taskD");
		// L3 escalation names the manual fixes; no nudge step for board pathologies.
		expect(harness.nudges).toHaveLength(0);
		const bodies = harness.notifications.map(n => n.body ?? "").join("\n");
		expect(bodies).toContain("team release taskC");
		expect(bodies).toContain("team release taskD");

		// Read-only invariant: the observer never mutates the board.
		const after = await boardBytes(harness.board.dir);
		expect(after).toEqual(before);
		// No-auto-kill invariant: no ref status changed under observation.
		expect(harness.registry.get("Dead")!.status).toBe("aborted");
	});

	it("does not flag a healthy claim chain", async () => {
		const a = await harness.board.create({ title: "A", createdBy: "test" });
		if (!a.ok) throw new Error(a.message);
		const b = await harness.board.create({ title: "B", blockedBy: [a.task.id], createdBy: "test" });
		if (!b.ok) throw new Error(b.message);
		harness.register("Owner");
		const claimed = await harness.board.claim(a.task.id, "Owner");
		if (!claimed.ok) throw new Error(claimed.message);
		await harness.start();
		await harness.poll();
		expect(harness.flags()).toHaveLength(0);
	});
});

// =============================================================================
// (5) P5 cost/token runaway
// =============================================================================

describe("P5 cost/token runaway", () => {
	it("flags cost and token overruns separately; below-threshold runs stay quiet", async () => {
		harness.register("Spender");
		harness.register("Burner");
		harness.register("Frugal");
		for (const id of ["Spender", "Burner", "Frugal"]) {
			harness.setActivity(id, harness.clock.now);
			harness.emitLifecycle(id, "started");
		}
		await harness.start();

		harness.emitProgress("Spender", { cost: 6.25, tokens: 100 });
		harness.emitProgress("Burner", { cost: 0.5, tokens: 2_000_001 });
		harness.emitProgress("Frugal", { cost: 0.5, tokens: 100 });
		await harness.poll();

		expect(harness.flagKeys()).toContain("cost-runaway:Spender");
		expect(harness.flagKeys()).toContain("token-runaway:Burner");
		expect(harness.flagKeys().some(key => key.includes("Frugal"))).toBe(false);
		// Both escalate to the user immediately, pointing at the manual kill.
		expect(harness.notifications).toHaveLength(2);
		expect(harness.notifications.every(n => (n.body ?? "").includes("Agent Hub (x)"))).toBe(true);
	});
});

// =============================================================================
// (6) P6 all-idle with pending work
// =============================================================================

describe("P6 team-wide stall", () => {
	it("flags only with claimable work + no running sub + all workers stale; never Main-idle-no-pending", async () => {
		// Main reading with no pending work → silence.
		harness.register(MAIN_AGENT_ID, { kind: "main", status: "idle" });
		await harness.start();
		harness.advance(STALL_MS * 2);
		await harness.poll();
		expect(harness.flags()).toHaveLength(0);

		// Claimable work + one idle + one parked worker, all stale.
		await harness.board.create({ title: "Waiting", createdBy: "test" });
		harness.register("Idler", { status: "idle" });
		harness.register("Parker", { status: "parked" });
		harness.setActivity("Idler", harness.clock.now);
		harness.setActivity("Parker", harness.clock.now);
		harness.advance(STALL_MS + 1);
		await harness.poll();

		expect(harness.flagKeys()).toContain("all-idle:board");
		// The nudge targets the live idle worker (cheap wake), not the parked one.
		const allIdleNudge = harness.nudges.find(n => n.body.includes("team is stalled"));
		expect(allIdleNudge?.to).toBe("Idler");

		// A running sub clears the stall.
		harness.registry.setStatus("Idler", "running");
		harness.setActivity("Idler", harness.clock.now);
		await harness.poll();
		expect(harness.flagKeys()).not.toContain("all-idle:board");
	});
});

// =============================================================================
// (7) P7 orphaned agents
// =============================================================================

describe("P7 orphaned agents", () => {
	it("flags after the grace period, clears when the parent registers, notice-only", async () => {
		harness.register("Orphan", { parentId: "Ghost" });
		await harness.start();

		// Inside the grace window → quiet.
		await harness.poll();
		expect(harness.flags()).toHaveLength(0);

		harness.advance(ORPHAN_GRACE_MS + 1);
		await harness.poll();
		expect(harness.flagKeys()).toEqual(["orphan:Orphan"]);
		// Low severity: L1 notice only — no nudge, no OS notification.
		expect(harness.statuses.some(s => s.includes("orphan"))).toBe(true);
		expect(harness.nudges).toHaveLength(0);
		expect(harness.notifications).toHaveLength(0);

		// Parent registers → flag clears.
		harness.register("Ghost", { kind: "sub", status: "idle" });
		await harness.poll();
		expect(harness.flags()).toHaveLength(0);
	});
});

// =============================================================================
// (8) Ladder ordering + nudgeEnabled=false
// =============================================================================

describe("action ladder", () => {
	it("nudgeEnabled=false suppresses DM sends but keeps notices and escalations", async () => {
		harness.config = makeConfig({ nudgeEnabled: false });
		await harness.board.create({ title: "Work", createdBy: "test" });
		harness.register("Sleeper", { status: "parked" });
		harness.setActivity("Sleeper", harness.clock.now);
		await harness.start();

		harness.advance(STALL_MS + 1);
		await harness.poll();
		// L1 notice recorded, but no DM went out.
		expect(harness.statuses.some(s => s.includes("claimable work on the board"))).toBe(true);
		expect(harness.nudges).toHaveLength(0);

		harness.advance(NOTICE_WINDOW_MS);
		await harness.poll();
		// L3 escalation still fires.
		expect(harness.notifications.length).toBeGreaterThan(0);
		expect(harness.nudges).toHaveLength(0);
	});

	it("observer.enabled=false hard-disables detection", async () => {
		harness.config = makeConfig({ enabled: false });
		harness.register("Worker");
		harness.setActivity("Worker", harness.clock.now);
		await harness.start();
		harness.advance(STUCK_MS * 2);
		await harness.poll();
		expect(harness.flags()).toHaveLength(0);
		expect(harness.statuses).toHaveLength(0);
	});
});

// =============================================================================
// (9) Dispose cleanliness
// =============================================================================

describe("dispose", () => {
	it("clears interval + pending timeouts, unsubscribes feeds, unref'd timers; later events are inert", async () => {
		harness.register("Worker");
		harness.setActivity("Worker", harness.clock.now);
		await harness.start();
		// Poll timer was unref'd so it can never hold the event loop open.
		expect(harness.pollHandle?.unrefCalled).toBe(true);

		// Queue an event-driven scan, then dispose before it fires.
		harness.registry.setStatus("Worker", "idle");
		expect(harness.timeouts.some(t => !t.cleared)).toBe(true);

		harness.advance(STUCK_MS * 2);
		harness.observer.dispose();

		// Pending debounce timers were cleared; the interval is gone.
		expect(harness.timeouts.every(t => t.cleared)).toBe(true);

		// Registry events no longer reach the observer (unsubscribed).
		const timeoutCount = harness.timeouts.length;
		harness.registry.setStatus("Worker", "running");
		harness.emitFailure("Worker");
		expect(harness.timeouts.length).toBe(timeoutCount);

		// Firing any captured callback after dispose is inert.
		for (const t of harness.timeouts) {
			if (!t.cleared) t.cb();
		}
		expect(harness.flags()).toHaveLength(0);
		expect(harness.statuses).toHaveLength(0);
		expect(harness.notifications).toHaveLength(0);
	});
});
