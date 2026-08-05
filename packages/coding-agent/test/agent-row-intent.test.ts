/**
 * Contract: a RUNNING agent row leads its detail line with the agent's live
 * intent (`progress.lastIntent` — the model-written objective of the current
 * step), sanitized of ANSI/control bytes and truncated to the row width, and
 * flags heartbeat silence with a dim `quiet Ns` meta segment once no observer
 * update or registry heartbeat has landed for a few seconds. Idle/parked rows
 * are unchanged (static task line, age-since-activity, no quiet cue), and the
 * hub and panel render the same running row byte-identically via the shared
 * `formatAgentRow`.
 */
import { afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { AgentPanelComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-panel";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { TUI } from "@oh-my-pi/pi-tui";
import { Container } from "@oh-my-pi/pi-tui";

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

function observersWith(
	id: string,
	fields: { lastUpdate: number; description?: string; progress?: Record<string, unknown> },
): SessionObserverRegistry {
	const observers = new SessionObserverRegistry();
	vi.spyOn(observers, "getSession").mockReturnValue({
		id,
		kind: "subagent",
		label: "Subagent",
		status: "active",
		description: fields.description,
		lastUpdate: fields.lastUpdate,
		progress: fields.progress as never,
	});
	return observers;
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

function makePanel(agents: AgentRegistry, observers?: SessionObserverRegistry): AgentPanelComponent {
	const ui = {
		setFocus: () => {},
		requestRender: () => {},
		requestComponentRender: () => {},
	} as unknown as TUI;
	return new AgentPanelComponent({
		getRegistry: () => agents,
		observers: observers ?? new SessionObserverRegistry(),
		irc: new IrcBus(agents),
		ui,
		editor: new Container(),
		requestRender: () => {},
	});
}

/** All rendered lines belonging to one agent: the id line plus its detail line. */
function entryLines(rendered: string[], id: string): string[] {
	const index = rendered.findIndex(line => line.includes(id));
	expect(index).toBeGreaterThanOrEqual(0);
	const lines = [rendered[index]!];
	const next = rendered[index + 1];
	// Detail lines are indented deeper than the identity line and carry no id.
	if (next?.startsWith("     ")) lines.push(next);
	return lines;
}

describe("Agent row live intent", () => {
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

	it("leads a running row's detail line with the live intent, sanitized and truncated", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", session: {} as AgentSession });
		const tail = "x".repeat(200);
		const intent = `\x1b[999mEditing finding 5/24\x07\tin auth middleware ${tail}`;
		const hub = makeHub(
			agents,
			observersWith("Worker", {
				lastUpdate: 1_000_000,
				description: "static spawn description",
				progress: { startedAtMs: 1_000_000, lastIntent: intent, cost: 0 },
			}),
		);
		try {
			const raw = hub.render(120);
			const detail = raw[raw.findIndex(line => line.includes("Worker")) + 1];
			expect(detail).toBeDefined();
			// ANSI + control bytes are stripped at the source, not just at assert time.
			expect(detail).not.toContain("\x1b[999m");
			expect(detail).not.toContain("\x07");
			const clean = Bun.stripANSI(detail);
			expect(clean).toContain("Editing finding 5/24");
			expect(clean).not.toContain("\t");
			// Truncated to the row width: the 200-char tail does not survive.
			expect(clean).not.toContain(tail);
			expect(clean.length).toBeLessThan(120);
			// The live intent wins over the static description on a running row.
			expect(clean).not.toContain("static spawn description");
		} finally {
			hub.dispose();
		}
	});

	it("falls back to the static task line when a running agent has streamed no intent yet", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", session: {} as AgentSession });
		const hub = makeHub(
			agents,
			observersWith("Worker", {
				lastUpdate: 1_000_000,
				description: "static spawn description",
				progress: { startedAtMs: 1_000_000, cost: 0 },
			}),
		);
		try {
			const text = Bun.stripANSI(hub.render(120).join("\n"));
			expect(text).toContain("static spawn description");
		} finally {
			hub.dispose();
		}
	});

	it("keeps intent off idle rows, which retain the static task line and age display", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Idle", displayName: "Idle", kind: "sub", session: {} as AgentSession });
		setSystemTime(1_000_000 + 5_000);
		agents.setStatus("Idle", "idle");
		const hub = makeHub(
			agents,
			observersWith("Idle", {
				lastUpdate: 1_000_000 + 5_000,
				description: "static spawn description",
				progress: { startedAtMs: 1_000_000, lastIntent: "Editing finding 5/24", currentTool: "bash", cost: 0.42 },
			}),
		);
		try {
			setSystemTime(1_000_000 + 5_000 + 300_000);
			const text = Bun.stripANSI(hub.render(120).join("\n"));
			expect(text).toContain("static spawn description");
			expect(text).toContain("5m ago");
			expect(text).not.toContain("Editing finding 5/24");
			expect(text).not.toContain("quiet");
		} finally {
			hub.dispose();
		}
	});
});

describe("Agent row heartbeat freshness", () => {
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

	it("shows no quiet cue while beats are fresh, then ages it with the render clock", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", session: {} as AgentSession });
		// Fixed last beat at t0: the agent went silent right after starting.
		const hub = makeHub(
			agents,
			observersWith("Worker", {
				lastUpdate: 1_000_000,
				progress: { startedAtMs: 1_000_000, currentTool: "bash", cost: 0 },
			}),
		);
		try {
			// Fresh: sub-threshold silence carries no label.
			setSystemTime(1_000_000 + 2_000);
			expect(Bun.stripANSI(hub.render(120).find(line => line.includes("Worker"))!)).not.toContain("quiet");

			setSystemTime(1_000_000 + 12_000);
			expect(Bun.stripANSI(hub.render(120).find(line => line.includes("Worker"))!)).toContain("quiet 12.0s");

			setSystemTime(1_000_000 + 192_000);
			expect(Bun.stripANSI(hub.render(120).find(line => line.includes("Worker"))!)).toContain("quiet 3m12s");
		} finally {
			hub.dispose();
		}
	});

	it("tracks a moving beat instead of freezing on the observer snapshot", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", session: {} as AgentSession });
		const observers = new SessionObserverRegistry();
		// lastUpdate follows the clock: every render sees a fresh beat.
		vi.spyOn(observers, "getSession").mockImplementation(() => ({
			id: "Worker",
			kind: "subagent",
			label: "Subagent",
			status: "active",
			lastUpdate: Date.now(),
			progress: { startedAtMs: 1_000_000, cost: 0 } as never,
		}));
		const hub = makeHub(agents, observers);
		try {
			setSystemTime(1_000_000 + 300_000);
			expect(Bun.stripANSI(hub.render(120).find(line => line.includes("Worker"))!)).not.toContain("quiet");
		} finally {
			hub.dispose();
		}
	});

	it("falls back to the registry heartbeat when no observer snapshot exists", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", session: {} as AgentSession });
		const hub = makeHub(agents);
		try {
			// No observer: lastActivity (register time) is the only beat; 30s on,
			// the silence is visible.
			setSystemTime(1_000_000 + 30_000);
			const row = Bun.stripANSI(hub.render(120).find(line => line.includes("Worker"))!);
			expect(row).toContain("quiet 30.0s");
			// A heartbeat (activity gist from a progress flush) refreshes it.
			agents.setActivity("Worker", "running bash");
			const refreshed = Bun.stripANSI(hub.render(120).find(line => line.includes("Worker"))!);
			expect(refreshed).not.toContain("quiet");
		} finally {
			hub.dispose();
		}
	});
});

describe("Agent row hub/panel parity", () => {
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

	it("renders the same running row — intent, quiet cue and all — in hub and panel", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", session: {} as AgentSession });
		const makeObservers = () =>
			observersWith("Worker", {
				lastUpdate: 1_000_000,
				progress: {
					startedAtMs: 1_000_000,
					lastIntent: "Editing finding 5/24",
					currentTool: "edit",
					cost: 0.42,
				},
			});
		const hub = makeHub(agents, makeObservers());
		const panel = makePanel(agents, makeObservers());
		panel.setAgents(agents.list().filter(ref => ref.kind === "sub" && ref.status === "running"));
		try {
			setSystemTime(1_000_000 + 12_000);
			const hubLines = entryLines(
				hub.render(120).map(line => Bun.stripANSI(line)),
				"Worker",
			);
			const panelLines = entryLines(
				panel.render(120).map(line => Bun.stripANSI(line)),
				"Worker",
			);
			// The hub selects its first row (cursor glyph); the unfocused panel does
			// not. Normalize that one cell — everything else must be identical.
			const normalizedHub = hubLines.map(line => line.replace(theme.nav.cursor, " "));
			expect(normalizedHub).toEqual(panelLines);
			expect(panelLines[0]).toContain("quiet 12.0s");
			expect(panelLines[1]).toContain("Editing finding 5/24");
		} finally {
			hub.dispose();
			panel.dispose();
		}
	});
});
