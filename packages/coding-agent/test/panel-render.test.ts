/**
 * Contract: the anchored agent panel lists live (running | idle) subagents via
 * the shared row renderer — a running row shows its status glyph, bold name and
 * a ticking elapsed-since-start; unread mail shows the ⧉ badge from the shared
 * IrcBus; the meta segment carries the observer-provided tool activity suffix;
 * idle rows are ANSI-dimmed while a sibling runs (full brightness once nothing
 * is in flight); and the InteractiveMode sync clears the anchoring container as
 * soon as the last live subagent leaves.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentPanelComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-panel";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { formatToolActivity } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { Container, type TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

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

function makePanel(agents: AgentRegistry, observers?: SessionObserverRegistry, irc?: IrcBus): AgentPanelComponent {
	const ui = {
		setFocus: () => {},
		requestRender: () => {},
		requestComponentRender: () => {},
	} as unknown as TUI;
	return new AgentPanelComponent({
		getRegistry: () => agents,
		observers: observers ?? new SessionObserverRegistry(),
		irc: irc ?? new IrcBus(agents),
		ui,
		editor: new Container(),
		requestRender: () => {},
	});
}

/** Sync the panel with the same live-subagent filter InteractiveMode applies. */
function syncPanel(panel: AgentPanelComponent, agents: AgentRegistry): void {
	panel.setAgents(
		agents.list().filter(ref => ref.kind === "sub" && (ref.status === "running" || ref.status === "idle")),
	);
}

function rowFor(panel: AgentPanelComponent, id: string): string {
	const row = panel
		.render(120)
		.map(line => Bun.stripANSI(line))
		.find(line => line.includes(id));
	expect(row).toBeDefined();
	return row!;
}

describe("Agent panel rows", () => {
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

	it("shows glyph + name + elapsed for a running agent and ticks with the render clock", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Timer", displayName: "Timer", kind: "sub", session: {} as AgentSession });
		const panel = makePanel(agents);
		syncPanel(panel, agents);
		try {
			setSystemTime(1_000_000 + 10_000);
			let row = rowFor(panel, "Timer");
			expect(row).toContain(theme.status.running);
			expect(row).toContain("Timer");
			expect(row).toContain("10.0s");

			setSystemTime(1_000_000 + 192_000);
			row = rowFor(panel, "Timer");
			expect(row).toContain("3m12s");
		} finally {
			panel.dispose();
		}
	});

	it("shows the ⧉ unread badge from the shared IrcBus", async () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		// Delivery always fails, so sends buffer into the mailbox as unread.
		const deadSession = {
			deliverIrcMessage: async () => {
				throw new Error("disposed");
			},
		} as unknown as AgentSession;
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", session: deadSession });
		const irc = new IrcBus(agents);
		const panel = makePanel(agents, undefined, irc);
		syncPanel(panel, agents);
		try {
			expect(rowFor(panel, "Worker")).not.toContain("⧉");
			await irc.send({ from: "Main", to: "Worker", body: "ping 1" });
			expect(rowFor(panel, "Worker")).toContain("⧉ 1");
			await irc.send({ from: "Main", to: "Worker", body: "ping 2" });
			expect(rowFor(panel, "Worker")).toContain("⧉ 2");
		} finally {
			panel.dispose();
		}
	});

	it("carries the observer-provided formatToolActivity label on a running row's meta segment", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Worker", displayName: "Worker", kind: "sub", session: {} as AgentSession });
		// The observer snapshot's currentTool is rendered as-is (same cell the
		// hub shows); callers that compose a "Reading src/foo.ts"-style label via
		// formatToolActivity get it carried through verbatim.
		const activity = formatToolActivity("read", { file_path: "src/foo.ts" });
		expect(activity).toBe("Reading src/foo.ts");
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSession").mockReturnValue({
			id: "Worker",
			kind: "subagent",
			label: "Subagent",
			status: "active",
			lastUpdate: 1_000_000,
			progress: { startedAtMs: 1_000_000, currentTool: activity, cost: 0 } as never,
		});
		const panel = makePanel(agents, observers);
		syncPanel(panel, agents);
		try {
			setSystemTime(1_000_000 + 10_000);
			const row = rowFor(panel, "Worker");
			expect(row).toContain("Reading src/foo.ts");
			expect(row).toContain("10.0s");
		} finally {
			panel.dispose();
		}
	});

	it("dims idle rows while a sibling is running, at full brightness when nothing runs", () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		agents.register({ id: "Busy", displayName: "Busy", kind: "sub", session: {} as AgentSession });
		agents.register({ id: "Done", displayName: "Done", kind: "sub", session: {} as AgentSession });
		agents.setStatus("Done", "idle");
		const panel = makePanel(agents);
		syncPanel(panel, agents);
		try {
			const raw = panel.render(120);
			const idleLine = raw.find(line => line.includes("Done"));
			const runningLine = raw.find(line => line.includes("Busy"));
			expect(idleLine).toBeDefined();
			expect(runningLine).toBeDefined();
			expect(idleLine!.startsWith("\x1b[2m")).toBe(true);
			expect(runningLine!.startsWith("\x1b[2m")).toBe(false);

			// Nothing in flight: the same idle row renders undimmed.
			agents.setStatus("Busy", "idle");
			syncPanel(panel, agents);
			const allIdle = panel.render(120);
			const idleNow = allIdle.find(line => line.includes("Done"));
			expect(idleNow).toBeDefined();
			expect(idleNow!.startsWith("\x1b[2m")).toBe(false);
		} finally {
			panel.dispose();
		}
	});
});

describe("InteractiveMode agent panel container", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-agent-panel-");
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
		resetSettingsForTest();
	});

	it("mounts below the editor while a live subagent exists and clears when the last one leaves", async () => {
		await mode.init({ suppressWelcomeIntro: true });
		expect(mode.agentPanelContainer.children.length).toBe(0);

		const registry = AgentRegistry.global();
		registry.register({ id: "PanelAgent", displayName: "PanelAgent", kind: "sub", session: {} as AgentSession });

		// The panel's registry subscription syncs synchronously on the change event.
		expect(mode.agentPanelContainer.children.length).toBe(1);
		const rendered = Bun.stripANSI(mode.agentPanelContainer.render(120).join("\n"));
		expect(rendered).toContain("PanelAgent");
		expect(rendered).toContain("1 running");

		// The last live subagent leaves the running|idle set: the panel hides and
		// the anchoring container is cleared (no hide timer).
		registry.setStatus("PanelAgent", "parked");
		expect(mode.agentPanelContainer.children.length).toBe(0);
		expect(mode.agentPanelContainer.render(120)).toEqual([]);
	});
});
