/**
 * Contract: agent hub rows for RUNNING subagents show a live elapsed-since-start
 * (`⏱ 3m12s`) that advances with the render clock, while non-running rows keep
 * the age-since-last-activity display (`5m ago`). The executor-reported run
 * start (progress.startedAtMs) wins over the ref's registration time so a
 * revived or re-prompted agent times its current run, not its original spawn.
 */
import { afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";

function stubStdoutGeometry(cols: number): () => void {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => 24, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	return () => {
		for (const [key, desc] of [
			["rows", rowsDesc],
			["columns", colsDesc],
		] as const) {
			if (desc) Object.defineProperty(process.stdout, key, desc);
			else Object.defineProperty(process.stdout, key, { configurable: true, value: undefined, writable: true });
		}
	};
}

function makeHub(agents: AgentRegistry, observers?: SessionObserverRegistry): AgentHubOverlayComponent {
	return new AgentHubOverlayComponent({
		observers: observers ?? new SessionObserverRegistry(),
		hubKeys: [],
		onDone: () => {},
		requestRender: () => {},
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent: async () => {},
	});
}

function rowFor(hub: AgentHubOverlayComponent, id: string): string {
	const row = hub
		.render(120)
		.map(line => Bun.stripANSI(line))
		.find(line => line.includes(id));
	expect(row).toBeDefined();
	return row!;
}

describe("Agent hub elapsed timer", () => {
	let restoreGeometry: (() => void) | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		setSystemTime();
		vi.restoreAllMocks();
		restoreGeometry?.();
		restoreGeometry = undefined;
		AgentRegistry.resetGlobalForTests();
	});

	it("shows elapsed-since-start for a running agent and ticks with the render clock", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Timer", displayName: "Timer", kind: "sub", session: {} as AgentSession });
		const hub = makeHub(agents);
		try {
			setSystemTime(1_000_000 + 10_000);
			expect(rowFor(hub, "Timer")).toContain("10.0s");

			setSystemTime(1_000_000 + 192_000);
			expect(rowFor(hub, "Timer")).toContain("3m12s");
		} finally {
			hub.dispose();
		}
	});

	it("keeps age-since-activity for non-running agents", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Idle", displayName: "Idle", kind: "sub", session: {} as AgentSession });
		setSystemTime(1_000_000 + 5_000);
		agents.setStatus("Idle", "idle");
		const hub = makeHub(agents);
		try {
			setSystemTime(1_000_000 + 5_000 + 300_000);
			const row = rowFor(hub, "Idle");
			expect(row).toContain("5m ago");
			expect(row).not.toContain("5m5s");
		} finally {
			hub.dispose();
		}
	});

	it("times the current run from the executor-reported start when available", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		// Registered (spawned) an hour ago, but the current run started 90s ago —
		// e.g. a parked agent revived for a follow-up turn.
		setSystemTime(1_000_000);
		agents.register({ id: "Revived", displayName: "Revived", kind: "sub", session: {} as AgentSession });
		const runStart = 1_000_000 + 3_600_000;
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSession").mockReturnValue({
			id: "Revived",
			kind: "subagent",
			label: "Subagent",
			status: "active",
			lastUpdate: runStart,
			progress: { startedAtMs: runStart } as never,
		});
		const hub = makeHub(agents, observers);
		try {
			setSystemTime(runStart + 90_000);
			const row = rowFor(hub, "Revived");
			expect(row).toContain("1m30s");
			expect(row).not.toContain("1h1m");
		} finally {
			hub.dispose();
		}
	});
});

describe("Agent hub running progress meta", () => {
	let restoreGeometry: (() => void) | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		setSystemTime();
		vi.restoreAllMocks();
		restoreGeometry?.();
		restoreGeometry = undefined;
		AgentRegistry.resetGlobalForTests();
	});

	function observersWithProgress(id: string, progress: Record<string, unknown>): SessionObserverRegistry {
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSession").mockReturnValue({
			id,
			kind: "subagent",
			label: "Subagent",
			status: "active",
			lastUpdate: Date.now(),
			progress: progress as never,
		});
		return observers;
	}

	it("shows the current tool and accrued cost on a running row, alongside the timer", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", session: {} as AgentSession });
		const hub = makeHub(
			agents,
			observersWithProgress("Worker", { startedAtMs: 1_000_000, currentTool: "bash", cost: 0.42 }),
		);
		try {
			setSystemTime(1_000_000 + 10_000);
			const row = rowFor(hub, "Worker");
			expect(row).toContain("10.0s");
			expect(row).toContain("bash");
			expect(row).toContain("$0.42");
		} finally {
			hub.dispose();
		}
	});

	it("truncates a long tool name on the meta segment", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", session: {} as AgentSession });
		const longTool = `tool-${"x".repeat(60)}`;
		const hub = makeHub(agents, observersWithProgress("Worker", { startedAtMs: 1_000_000, currentTool: longTool, cost: 0 }));
		try {
			setSystemTime(1_000_000);
			const row = rowFor(hub, "Worker");
			expect(row).toContain("tool-xxx");
			expect(row).not.toContain(longTool);
		} finally {
			hub.dispose();
		}
	});

	it("keeps tool and cost off non-running rows", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Idle", displayName: "Idle", kind: "sub", session: {} as AgentSession });
		setSystemTime(1_000_000 + 5_000);
		agents.setStatus("Idle", "idle");
		const hub = makeHub(
			agents,
			observersWithProgress("Idle", { startedAtMs: 1_000_000, currentTool: "bash", cost: 0.42 }),
		);
		try {
			setSystemTime(1_000_000 + 5_000 + 300_000);
			const row = rowFor(hub, "Idle");
			expect(row).toContain("5m ago");
			expect(row).not.toContain("bash");
			expect(row).not.toContain("$0.42");
		} finally {
			hub.dispose();
		}
	});
});
