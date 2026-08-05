/**
 * Contract: the agent hub bottom bar sources its open/close labels from the
 * live keybinding map (`tui.select.confirm` / `app.interrupt`), so a user
 * rebind is reflected in the footer AND honored by the table input handler.
 * Component-level keys (j/k/r/x, double-tap ←) stay hardcoded.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@oh-my-pi/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { setKeybindings } from "@oh-my-pi/pi-tui";

const AGENT_ID = "Worker";

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

function makeHub(onDone: () => void, focusAgent: (id: string) => Promise<void> = async () => {}) {
	const agents = new AgentRegistry();
	agents.register({
		id: AGENT_ID,
		displayName: AGENT_ID,
		kind: "sub",
		parentId: "Main",
		session: { subscribe: () => () => {} } as unknown as AgentSession,
		sessionFile: null,
		status: "running",
	});
	const hub = new AgentHubOverlayComponent({
		observers: new SessionObserverRegistry(),
		hubKeys: [],
		onDone,
		requestRender: () => {},
		registry: agents,
		irc: new IrcBus(agents),
		focusAgent,
	});
	return hub;
}

function footerFor(hub: AgentHubOverlayComponent): string {
	const footer = hub
		.render(120)
		.map(line => Bun.stripANSI(line))
		.find(line => line.includes("revive"));
	expect(footer).toBeDefined();
	return footer!;
}

describe("Agent hub footer keybinding hints", () => {
	let restoreGeometry: (() => void) | undefined;

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(() => {
		setKeybindings(KeybindingsManager.inMemory());
		restoreGeometry?.();
		restoreGeometry = undefined;
		AgentRegistry.resetGlobalForTests();
	});

	it("shows the shipped labels by default", () => {
		restoreGeometry = stubStdoutGeometry(120);
		setKeybindings(KeybindingsManager.inMemory());
		const hub = makeHub(() => {});
		try {
			const footer = footerFor(hub);
			expect(footer).toContain("j/k select");
			expect(footer).toContain("Enter open");
			expect(footer).toContain("r revive");
			expect(footer).toContain("x kill");
			expect(footer).toContain("Esc/←← close");
		} finally {
			hub.dispose();
		}
	});

	it("reflects rebound confirm and interrupt keys in the footer", () => {
		restoreGeometry = stubStdoutGeometry(120);
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.confirm": "o", "app.interrupt": "alt+x" }));
		const hub = makeHub(() => {});
		try {
			const footer = footerFor(hub);
			expect(footer).toContain("O open");
			expect(footer).toContain("Alt+X/←← close");
			expect(footer).not.toContain("Enter open");
			// Component-level keys are not registry actions and stay hardcoded.
			expect(footer).toContain("j/k select");
			expect(footer).toContain("r revive");
		} finally {
			hub.dispose();
		}
	});

	it("honors rebound confirm and interrupt keys in the table input handler", async () => {
		restoreGeometry = stubStdoutGeometry(120);
		setKeybindings(KeybindingsManager.inMemory({ "tui.select.confirm": "o", "app.interrupt": "alt+x" }));
		const focusedIds: string[] = [];
		const done = Promise.withResolvers<void>();
		let doneCalls = 0;
		const hub = makeHub(
			() => {
				doneCalls++;
				done.resolve();
			},
			async id => {
				focusedIds.push(id);
			},
		);
		try {
			// Rebound confirm activates the row; raw Escape no longer closes.
			hub.handleInput("o");
			await done; // activation is fire-and-forget async; onDone signals completion
			expect(focusedIds).toEqual([AGENT_ID]);
			expect(doneCalls).toBe(1);

			const closed = Promise.withResolvers<void>();
			const hub2 = makeHub(() => closed.resolve());
			try {
				hub2.handleInput("\x1b"); // escape: unbound from app.interrupt, must not close
				hub2.handleInput("\x1bx"); // alt+x: the rebound interrupt key
				await closed.promise;
			} finally {
				hub2.dispose();
			}
		} finally {
			hub.dispose();
		}
	});
});
