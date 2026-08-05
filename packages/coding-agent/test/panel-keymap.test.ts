/**
 * Contract: the focused agent panel keymap. ↑/↓ and j/k move the selection
 * (cursor follows across renders); Enter activates the selected row — live
 * agents focus the main view on their session (focusAgent) and hand focus back
 * to the editor, rows without a focus path open the sendable transcript
 * viewer; Esc interrupts the selected agent's CURRENT TURN via
 * session.abort({reason: USER_INTERRUPT_LABEL}) — deliberately NOT the hub's
 * kill path (no lifecycle.release); Esc with nothing interruptible, or ←,
 * returns focus to the editor.
 */
import { afterEach, beforeAll, describe, expect, it, type Mock, vi } from "bun:test";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentPanelComponent, type AgentPanelDeps } from "@oh-my-pi/pi-coding-agent/modes/components/agent-panel";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme, theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { Container, type TUI } from "@oh-my-pi/pi-tui";

interface PanelHarness {
	panel: AgentPanelComponent;
	agents: AgentRegistry;
	editor: Container;
	lastFocused: () => unknown;
	focusAgent: Mock<(id: string) => Promise<void>>;
	showOverlay: Mock<() => { hide: () => void }>;
	release: Mock<() => void>;
}

function makePanel(ids: string[], overrides?: Partial<AgentPanelDeps>): PanelHarness {
	const agents = new AgentRegistry();
	for (const id of ids) {
		agents.register({
			id,
			displayName: id,
			kind: "sub",
			session: { subscribe: () => () => {} } as unknown as AgentSession,
		});
	}
	const editor = new Container();
	let focused: unknown;
	const focusAgent = vi.fn<(id: string) => Promise<void>>(async () => {});
	const showOverlay = vi.fn(() => ({ hide: () => {} }));
	const release = vi.fn<() => void>(() => {});
	const ui = {
		setFocus: (component: unknown) => {
			focused = component;
		},
		getFocused: () => focused,
		showOverlay,
		requestRender: () => {},
		requestComponentRender: () => {},
	} as unknown as TUI;
	const panel = new AgentPanelComponent({
		getRegistry: () => agents,
		observers: new SessionObserverRegistry(),
		irc: new IrcBus(agents),
		ui,
		editor,
		requestRender: () => {},
		focusAgent,
		lifecycle: () => ({ release }) as unknown as AgentLifecycleManager,
		...overrides,
	});
	panel.setAgents(
		agents.list().filter(ref => ref.kind === "sub" && (ref.status === "running" || ref.status === "idle")),
	);
	panel.focused = true;
	return { panel, agents, editor, lastFocused: () => focused, focusAgent, showOverlay, release };
}

/** The stripped render line carrying the selection cursor, if any. */
function selectedLine(panel: AgentPanelComponent): string | undefined {
	const cursor = Bun.stripANSI(theme.nav.cursor);
	return panel
		.render(120)
		.map(line => Bun.stripANSI(line))
		.find(line => line.includes(cursor));
}

async function flushMicrotasks(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

describe("Agent panel keymap", () => {
	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentRegistry.resetGlobalForTests();
	});

	it("moves the selection with j/k and ↓/↑, clamped at the edges", () => {
		const { panel } = makePanel(["Alpha", "Beta", "Gamma"]);
		try {
			expect(selectedLine(panel)).toContain("Alpha");

			panel.handleInput("j");
			expect(selectedLine(panel)).toContain("Beta");
			panel.handleInput("\x1b[B"); // ↓
			expect(selectedLine(panel)).toContain("Gamma");
			// Clamped at the bottom.
			panel.handleInput("j");
			expect(selectedLine(panel)).toContain("Gamma");

			panel.handleInput("k");
			expect(selectedLine(panel)).toContain("Beta");
			panel.handleInput("\x1b[A"); // ↑
			expect(selectedLine(panel)).toContain("Alpha");
			// Clamped at the top.
			panel.handleInput("k");
			expect(selectedLine(panel)).toContain("Alpha");
		} finally {
			panel.dispose();
		}
	});

	it("Enter focuses the main view on the selected live agent and returns focus to the editor", async () => {
		const { panel, editor, lastFocused, focusAgent } = makePanel(["Alpha", "Beta"]);
		try {
			panel.handleInput("j");
			panel.handleInput("\r");
			expect(focusAgent).toHaveBeenCalledTimes(1);
			expect(focusAgent).toHaveBeenCalledWith("Beta");
			await flushMicrotasks();
			expect(lastFocused()).toBe(editor);
		} finally {
			panel.dispose();
		}
	});

	it("Enter opens the transcript viewer when no live focus path exists", () => {
		const { panel, editor, lastFocused, focusAgent, showOverlay } = makePanel(["Alpha"], { focusAgent: undefined });
		try {
			panel.handleInput("\r");
			expect(focusAgent).not.toHaveBeenCalled();
			expect(showOverlay).toHaveBeenCalledTimes(1);
			// Focus moves INTO the viewer, not back to the editor.
			expect(lastFocused()).not.toBe(editor);
			expect(lastFocused()).toBeDefined();
		} finally {
			panel.dispose();
		}
	});

	it("Esc interrupts the selected running agent's current turn WITHOUT releasing its lifecycle", () => {
		const { panel, agents, editor, lastFocused, release } = makePanel(["Alpha"]);
		const abort = vi.fn<(options?: { reason?: string }) => Promise<void>>(async () => {});
		const ref = agents.get("Alpha");
		expect(ref).toBeDefined();
		ref!.session = { abort } as unknown as AgentSession;
		try {
			panel.handleInput("\x1b");
			expect(abort).toHaveBeenCalledTimes(1);
			expect(abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });
			// Interrupt ≠ kill: the hub's `x` path (lifecycle release) is never taken.
			expect(release).not.toHaveBeenCalled();
			// Interrupting keeps keyboard focus in the panel.
			expect(lastFocused()).not.toBe(editor);
		} finally {
			panel.dispose();
		}
	});

	it("Esc with nothing interruptible selected returns focus to the editor", () => {
		const { panel, agents, editor, lastFocused } = makePanel(["Alpha"]);
		agents.setStatus("Alpha", "idle"); // no current turn → not interruptible
		try {
			panel.handleInput("\x1b");
			expect(lastFocused()).toBe(editor);
		} finally {
			panel.dispose();
		}
	});

	it("← returns focus to the editor", () => {
		const { panel, editor, lastFocused } = makePanel(["Alpha"]);
		try {
			panel.handleInput("\x1b[D");
			expect(lastFocused()).toBe(editor);
		} finally {
			panel.dispose();
		}
	});
});
