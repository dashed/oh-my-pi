/**
 * Contract: the Agent Hub table and the anchored agent panel render
 * BYTE-IDENTICAL rows for the same agent ref + observer snapshot, because both
 * surfaces call the shared {@link formatAgentRow} (agent-row.ts). Guards the
 * extraction: a row cell changed on one surface but not the other fails here.
 */
import { afterEach, beforeAll, describe, expect, it, setSystemTime, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { AgentPanelComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-panel";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { Container, type TUI } from "@oh-my-pi/pi-tui";

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

function makePanel(agents: AgentRegistry, observers: SessionObserverRegistry, irc: IrcBus): AgentPanelComponent {
	const ui = {
		setFocus: () => {},
		requestRender: () => {},
		requestComponentRender: () => {},
	} as unknown as TUI;
	return new AgentPanelComponent({
		getRegistry: () => agents,
		observers,
		irc,
		ui,
		editor: new Container(),
		requestRender: () => {},
	});
}

/** Extract one agent's entry (identity line plus its indented task line) from a surface render. */
function entryFor(lines: readonly string[], id: string): string[] {
	const index = lines.findIndex(line => line.includes(id));
	expect(index).toBeGreaterThanOrEqual(0);
	// Entry lines are pushed consecutively on both surfaces, so a two-line
	// entry's task line is always the line right after the identity line.
	return lines.slice(index, index + 2);
}

describe("shared agent row (hub ≡ panel)", () => {
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

	it("renders identical text for the same ref + observed fixture", async () => {
		restoreGeometry = stubStdoutGeometry(120);
		const agents = new AgentRegistry();
		setSystemTime(1_000_000);
		// Delivery always fails, so sends buffer into the mailbox and drive the
		// shared IrcBus unread (⧉) cell.
		const deadSession = {
			deliverIrcMessage: async () => {
				throw new Error("disposed");
			},
		} as unknown as AgentSession;
		agents.register({ id: "Alpha", displayName: "Alpha", kind: "sub", session: {} as AgentSession });
		agents.register({ id: "Beta", displayName: "Beta", kind: "sub", session: deadSession });
		const irc = new IrcBus(agents);
		await irc.send({ from: "Alpha", to: "Beta", body: "ping 1" });
		await irc.send({ from: "Alpha", to: "Beta", body: "ping 2" });
		expect(irc.unreadCount("Beta")).toBe(2);

		const runStart = 1_000_000;
		const observers = new SessionObserverRegistry();
		vi.spyOn(observers, "getSession").mockImplementation((id: string) =>
			id === "Beta"
				? {
						id: "Beta",
						kind: "subagent",
						label: "Subagent",
						status: "active",
						lastUpdate: runStart,
						progress: {
							startedAtMs: runStart,
							currentTool: "bash",
							cost: 0.42,
							task: "map the shared row extraction",
						} as never,
					}
				: undefined,
		);

		const hub = new AgentHubOverlayComponent({
			observers,
			hubKeys: [],
			onDone: () => {},
			requestRender: () => {},
			registry: agents,
			irc,
			focusAgent: async () => {},
		});
		const panel = makePanel(agents, observers, irc);
		panel.setAgents(agents.list().filter(ref => ref.kind === "sub" && ref.status === "running"));
		try {
			setSystemTime(runStart + 192_000);
			// Beta is row index 1 in the hub (unselected — the hub defaults its
			// cursor to row 0) and the panel is unfocused (no selection cursor), so
			// both surfaces render Beta with selected=false.
			const hubEntry = entryFor(hub.render(120), "Beta");
			const panelEntry = entryFor(panel.render(120), "Beta");
			expect(panelEntry).toEqual(hubEntry);
			// Sanity: the fixture actually exercises the interesting cells.
			const stripped = hubEntry.map(line => Bun.stripANSI(line)).join("\n");
			expect(stripped).toContain("⧉ 2");
			expect(stripped).toContain("3m12s");
			expect(stripped).toContain("bash");
			expect(stripped).toContain("$0.42");
			expect(stripped).toContain("map the shared row extraction");
		} finally {
			hub.dispose();
		}
	});
});
