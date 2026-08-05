/**
 * Contract: the status row above the editor is a live working indicator —
 * spinner + current tool activity ("Reading src/foo.ts", shared
 * `formatToolActivity` formatter) or a rotating gerund when no tool is in
 * flight — followed by dim stats: elapsed time, cumulative output tokens,
 * windowed tok/s, TTFT once the first token lands, and the upstream provider
 * an aggregator routed to (OpenRouter's `provider` field). The event
 * controller drives it: agent_start begins the turn, tool_execution_start/end
 * swap the label, message_update folds cumulative usage deltas in at arrival,
 * agent_end hides it. A shared 1s keep-alive ticks the indicator and the
 * subagent HUD rows while anything runs; the HUD rows use the same formatter.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, setSystemTime, vi } from "bun:test";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { WorkingIndicator } from "@oh-my-pi/pi-coding-agent/modes/components/working-indicator";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { InteractiveMode, renderSubagentHudLines } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import type { ObservableSession } from "@oh-my-pi/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { AgentProgress } from "@oh-my-pi/pi-coding-agent/task";
import { formatToolActivity } from "@oh-my-pi/pi-coding-agent/tools/render-utils";
import { Container, type TUI } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

function strip(text: string): string {
	return Bun.stripANSI(text);
}

function makeUi(): TUI {
	return { requestRender: vi.fn(), requestComponentRender: vi.fn() } as unknown as TUI;
}

describe("formatToolActivity", () => {
	it("formats read calls as 'Reading <path>'", () => {
		expect(formatToolActivity("read", { path: "src/foo.ts" })).toBe("Reading src/foo.ts");
	});

	it("formats bash calls as 'Running <command>'", () => {
		expect(formatToolActivity("bash", { command: "bun test" })).toBe("Running bun test");
	});

	it("truncates long command details to a single short line", () => {
		const long = `run ${"x".repeat(200)}`;
		const out = formatToolActivity("bash", { command: long });
		expect(out).toBeDefined();
		expect(Bun.stringWidth(strip(out!))).toBeLessThanOrEqual(48); // "Running " + 40-cell detail budget
		expect(out).toContain("…");
		expect(out).not.toContain(long);
	});

	it("accepts the pre-extracted string preview carried by subagent progress", () => {
		expect(formatToolActivity("read", "src/foo.ts")).toBe("Reading src/foo.ts");
	});

	it("collapses tabs and newlines so the label never breaks the status line", () => {
		const out = formatToolActivity("read", { path: "src/\tfoo.ts\nbar" });
		expect(out).toBeDefined();
		expect(out).not.toContain("\t");
		expect(out).not.toContain("\n");
	});

	it("falls back to the bare verb when no recognizable detail is present", () => {
		expect(formatToolActivity("read")).toBe("Reading");
		expect(formatToolActivity("read", { limit: 50 })).toBe("Reading");
	});

	it("returns undefined for unknown tools so callers fall back to a gerund", () => {
		expect(formatToolActivity("xdev", { path: "src/foo.ts" })).toBeUndefined();
	});

	it("strips ANSI/OSC control bytes from model-controlled tool args", () => {
		const out = formatToolActivity("bash", { command: "ls \x1b]52;c;PGFjZT4=\x07 && cat \x1b[2J secrets" });
		expect(out).toBe("Running ls && cat secrets");
		expect(out).not.toMatch(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/);
	});

	it("strips control bytes from the pre-extracted string preview", () => {
		expect(formatToolActivity("read", "src/\x1b[31mfoo.ts\x1b[0m")).toBe("Reading src/foo.ts");
	});

	it("leaves ordinary text untouched", () => {
		expect(formatToolActivity("grep", { pattern: "foo.*bar" })).toBe("Searching foo.*bar");
	});
});

describe("WorkingIndicator", () => {
	let indicator: WorkingIndicator | undefined;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		indicator?.stop();
		indicator = undefined;
		setSystemTime();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function makeIndicator(): WorkingIndicator {
		indicator = new WorkingIndicator(makeUi());
		return indicator;
	}

	function line(target: WorkingIndicator, width = 120): string {
		return strip(target.render(width).join("\n"));
	}

	it("shows a rotating gerund with ticking elapsed while no tool is in flight", () => {
		setSystemTime(0);
		const target = makeIndicator();
		expect(line(target)).toContain("Working…");
		expect(line(target)).toContain("(0s)");

		setSystemTime(3000);
		expect(line(target)).toContain("Thinking…");
		expect(line(target)).toContain("(3s)");

		setSystemTime(192_000);
		expect(line(target)).toContain("3m 12s");
	});

	it("advances the spinner glyph on the shared 80ms clock", () => {
		setSystemTime(0);
		const target = makeIndicator();
		expect(line(target)).toContain("⠋");
		setSystemTime(80);
		expect(line(target)).toContain("⠙");
	});

	it("switches the label to the current tool activity and back to the gerund", () => {
		setSystemTime(0);
		const target = makeIndicator();
		target.setToolActivity("call-1", "Reading src/foo.ts");
		expect(line(target)).toContain("Reading src/foo.ts…");
		expect(line(target)).not.toContain("Working…");

		// Concurrent tools: the most recently started one owns the label.
		target.setToolActivity("call-2", "Running bun test");
		expect(line(target)).toContain("Running bun test…");

		target.clearToolActivity("call-2");
		expect(line(target)).toContain("Reading src/foo.ts…");
		target.clearToolActivity("call-1");
		expect(line(target)).toContain("Working…");
	});

	it("accumulates output tokens across messages and shows a windowed tok/s", () => {
		setSystemTime(0);
		const target = makeIndicator();
		target.beginTurn(0);

		target.recordUsage(5, undefined, 100);
		target.recordUsage(25, undefined, 300); // 20 tokens in 200ms → 100 tok/s
		let out = line(target);
		expect(out).toContain("↓ 25");
		expect(out).toContain("100.0 tok/s");

		// A new assistant message restarts its cumulative count; the drop is new
		// output, not negative progress.
		target.recordUsage(7, undefined, 500);
		out = line(target);
		expect(out).toContain("↓ 32");
	});

	it("keeps the TTFT segment hidden until the first token lands, then shows it", () => {
		setSystemTime(0);
		const target = makeIndicator();
		target.beginTurn(0);

		setSystemTime(500);
		let out = line(target);
		expect(out).not.toContain("⏱");
		expect(out).not.toContain("↓");
		expect(out).not.toContain("tok/s");

		target.recordUsage(3, undefined, 800);
		out = line(target);
		expect(out).toContain("⏱ 0.8s");
		expect(out).toContain("↓ 3");
	});

	it("shows the upstream provider segment only when one was reported, and resets per turn", () => {
		setSystemTime(0);
		const target = makeIndicator();
		target.beginTurn(0);
		expect(line(target)).not.toContain("via");

		target.recordUsage(5, "DeepSeek", 100);
		expect(line(target)).toContain("via DeepSeek");

		target.beginTurn(200);
		setSystemTime(200);
		expect(line(target)).not.toContain("via");
	});

	it("drops tok/s, then TTFT, then provider as the terminal narrows", () => {
		setSystemTime(0);
		const target = makeIndicator();
		target.beginTurn(0);
		target.setToolActivity("call-1", "Reading some/file.ts");
		target.recordUsage(5000, "DeepSeek", 100);
		target.recordUsage(7500, undefined, 200); // rate clamps to the 200 tok/s ceiling

		const full = line(target, 300);
		expect(full).toContain("200.0 tok/s");
		expect(full).toContain("⏱ 0.1s");
		expect(full).toContain("via DeepSeek");
		expect(full).toContain("↓ 7.5k");
		const fullWidth = Bun.stringWidth(full);

		const tpsDrop = target.render(fullWidth - 1).join("\n");
		expect(Bun.stringWidth(strip(tpsDrop))).toBeLessThanOrEqual(fullWidth - 1);
		expect(strip(tpsDrop)).not.toContain("tok/s");
		expect(strip(tpsDrop)).toContain("⏱ 0.1s");

		const ttftDrop = target.render(fullWidth - 15).join("\n");
		expect(strip(ttftDrop)).not.toContain("tok/s");
		expect(strip(ttftDrop)).not.toContain("⏱");
		expect(strip(ttftDrop)).toContain("via DeepSeek");

		const providerDrop = target.render(fullWidth - 24).join("\n");
		expect(strip(providerDrop)).not.toContain("via DeepSeek");
		// Elapsed and the token count always survive.
		expect(strip(providerDrop)).toContain("↓ 7.5k");
		expect(strip(providerDrop)).toContain("0s");
	});

	it("lets an extension message override the label until cleared", () => {
		setSystemTime(0);
		const target = makeIndicator();
		target.setMessage("Deploying");
		expect(line(target)).toContain("Deploying");
		expect(line(target)).not.toContain("Working…");

		target.setMessage(undefined);
		expect(line(target)).toContain("Working…");
	});
});

// ---------------------------------------------------------------------------
// Event-controller wiring: real WorkingIndicator behind a stub ctx, events
// dispatched through the real subscribe path.
// ---------------------------------------------------------------------------

function messageUpdate(text: string, output: number, upstreamProvider?: string): AgentSessionEvent {
	const message = {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 0,
			output,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: output,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: undefined,
		upstreamProvider,
	};
	return {
		type: "message_update",
		message,
		assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: message },
	} as unknown as AgentSessionEvent;
}

interface WiringHarness {
	ctx: InteractiveModeContext;
	controller: EventController;
	statusContainer: Container;
	streamState: { isStreaming: boolean };
	emit: (event: AgentSessionEvent) => void;
	getIndicator: () => WorkingIndicator | undefined;
}

function createWiringHarness(): WiringHarness {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const streamState = { isStreaming: true };
	const ui = makeUi();
	const statusContainer = new Container();
	let indicator: WorkingIndicator | undefined;
	const session = {
		get isStreaming() {
			return streamState.isStreaming;
		},
		isAborting: false,
		getToolByName: () => undefined,
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {};
		},
	};
	const ctx = {
		isInitialized: true,
		ui,
		settings,
		statusContainer,
		chatContainer: {
			addChild: vi.fn(),
			removeChild: vi.fn(),
			clear: vi.fn(),
			isBlockUncommitted: vi.fn(() => false),
		},
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map<string, unknown>(),
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		clearPinnedError: vi.fn(),
		retryLoader: undefined,
		streamingComponent: undefined,
		streamingMessage: undefined,
		editor: { getText: () => "" },
		sessionManager: { getSessionName: () => "test-session" },
		flushPendingModelSwitch: vi.fn(async () => {}),
		flushPendingCommandOutput: vi.fn(),
		setWorkingMessage: vi.fn(),
		setTodos: vi.fn(),
		viewSession: {
			get isStreaming() {
				return streamState.isStreaming;
			},
			isCompacting: false,
			isRetrying: false,
			getToolByName: () => undefined,
			getContextUsage: () => undefined,
		},
		session,
		get loadingAnimation() {
			return indicator;
		},
		set loadingAnimation(value: WorkingIndicator | undefined) {
			indicator = value;
		},
		ensureLoadingAnimation() {
			if (!indicator) {
				statusContainer.disposeChildren();
				indicator = new WorkingIndicator(ui);
				statusContainer.addChild(indicator);
			}
		},
	} as unknown as InteractiveModeContext;
	const controller = new EventController(ctx);
	controller.subscribeToAgent();
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) void listener(event);
	};
	return { ctx, controller, statusContainer, streamState, emit, getIndicator: () => indicator };
}

async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 12; i++) await Promise.resolve();
}

describe("EventController working-indicator wiring", () => {
	let harnesses: Array<WiringHarness> = [];

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
	});

	afterEach(() => {
		for (const harness of harnesses) harness.getIndicator()?.stop();
		harnesses = [];
		setSystemTime();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function makeHarness(): WiringHarness {
		const harness = createWiringHarness();
		harnesses.push(harness);
		return harness;
	}

	function statusLine(harness: WiringHarness): string {
		return strip(harness.statusContainer.render(120).join("\n"));
	}

	it("shows the indicator with a gerund on agent_start, swaps in tool activity, folds in usage, hides on agent_end", async () => {
		setSystemTime(0);
		const harness = makeHarness();

		harness.emit({ type: "agent_start" } as unknown as AgentSessionEvent);
		await flushMicrotasks();
		expect(harness.getIndicator()).toBeDefined();
		expect(statusLine(harness)).toContain("Working…");
		expect(statusLine(harness)).toContain("(0s)");

		// Pre-seed the pending handle so the handler takes the update branch and
		// skips heavy component construction (same idiom as the interrupt test).
		const component = { updateArgs: vi.fn(), setArgsComplete: vi.fn(), updateResult: vi.fn() };
		harness.ctx.pendingTools.set("call-1", component as never);
		harness.emit({
			type: "tool_execution_start",
			toolCallId: "call-1",
			toolName: "bash",
			args: { command: "bun test" },
		} as unknown as AgentSessionEvent);
		await flushMicrotasks();
		expect(statusLine(harness)).toContain("Running bun test…");

		// message_update folds cumulative usage in at arrival: TTFT times the
		// first positive delta, tokens and provider paint immediately.
		setSystemTime(800);
		harness.emit(messageUpdate("tok", 5, "DeepSeek"));
		expect(statusLine(harness)).toContain("↓ 5");
		expect(statusLine(harness)).toContain("⏱ 0.8s");
		expect(statusLine(harness)).toContain("via DeepSeek");

		harness.emit({
			type: "tool_execution_end",
			toolCallId: "call-1",
			toolName: "bash",
			result: { content: [{ type: "text", text: "ok" }] },
		} as unknown as AgentSessionEvent);
		await flushMicrotasks();
		expect(statusLine(harness)).not.toContain("Running bun test");
		expect(statusLine(harness)).toContain("Working…"); // gerund fallback once no tool is in flight

		harness.streamState.isStreaming = false;
		harness.emit({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);
		await flushMicrotasks();
		expect(harness.getIndicator()).toBeUndefined();
		expect(harness.statusContainer.children).toHaveLength(0);
	});

	it("hides the indicator on an interrupted turn (agent_end after abort)", async () => {
		setSystemTime(0);
		const harness = makeHarness();

		harness.emit({ type: "agent_start" } as unknown as AgentSessionEvent);
		await flushMicrotasks();
		expect(harness.getIndicator()).toBeDefined();

		harness.streamState.isStreaming = false;
		harness.emit({ type: "agent_end", messages: [] } as unknown as AgentSessionEvent);
		await flushMicrotasks();
		expect(harness.getIndicator()).toBeUndefined();
		expect(statusLine(harness)).not.toContain("Working…");
	});
});

// ---------------------------------------------------------------------------
// Subagent HUD rows share formatToolActivity for the live per-agent suffix.
// ---------------------------------------------------------------------------

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeSession(overrides: Partial<ObservableSession> & { id: string }): ObservableSession {
	return {
		kind: "subagent",
		label: overrides.id,
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		...overrides,
	};
}

describe("subagent HUD activity labels", () => {
	beforeAll(async () => {
		await initTheme(false);
	});

	it("renders the live per-subagent activity via formatToolActivity", () => {
		const out = strip(
			renderSubagentHudLines(
				[
					makeSession({
						id: "Worker",
						description: "live work",
						progress: makeProgress({ id: "Worker", currentTool: "read", currentToolArgs: "src/foo.ts" }),
					}),
				],
				120,
			).join("\n"),
		);
		expect(out).toContain("Worker: live work");
		expect(out).toContain("· Reading src/foo.ts");
	});

	it("strips control bytes from an unknown tool's raw name", () => {
		const raw = renderSubagentHudLines(
			[
				makeSession({
					id: "Worker",
					description: "live work",
					progress: makeProgress({ id: "Worker", currentTool: "mcp_evil\x1b[2J_tool" }),
				}),
			],
			120,
		).join("\n");
		// Theme SGR legitimately contains ESC; the injected CSI must not survive.
		expect(raw).not.toContain("\x1b[2J");
		expect(strip(raw)).toContain("mcp_evil_tool");
	});
});

// ---------------------------------------------------------------------------
// The shared 1s keep-alive: ticks while the indicator is up, dies after the
// status row is torn down.
// ---------------------------------------------------------------------------

describe("InteractiveMode HUD keep-alive tick", () => {
	let tempDir: TempDir | undefined;

	beforeAll(async () => {
		await initTheme(false);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-hud-tick-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		tempDir?.removeSync();
		tempDir = undefined;
		resetSettingsForTest();
	});

	it("repaints once per second while the indicator runs and stops after teardown", async () => {
		const sessionManager = SessionManager.inMemory(tempDir!.path());
		await sessionManager.setSessionName("Tick session", "user");
		const session = {
			sessionManager,
			settings,
			agent: { state: { tools: [] }, metadataForProvider: () => undefined },
			customCommands: [],
			skills: [],
			autoCompactionEnabled: true,
			messages: [],
			systemPrompt: [],
			state: { model: undefined },
			model: undefined,
			thinkingLevel: undefined,
		} as unknown as AgentSession;
		const mode = new InteractiveMode(session, "test");
		try {
			vi.useFakeTimers();
			mode.ensureLoadingAnimation();
			// Stop the indicator's own 80ms self-tick so only the shared 1s
			// keep-alive can paint during the advance.
			mode.loadingAnimation?.stop();
			const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});

			vi.advanceTimersByTime(1000);
			expect(requestRender).toHaveBeenCalledTimes(1);
			vi.advanceTimersByTime(1000);
			expect(requestRender).toHaveBeenCalledTimes(2);

			// Teardown drops the indicator; the tick re-evaluates its own need and
			// dies instead of repainting an idle status row forever.
			requestRender.mockClear();
			mode.clearTransientSessionUi();
			vi.advanceTimersByTime(5000);
			expect(requestRender).not.toHaveBeenCalled();
		} finally {
			mode.stop();
		}
	});
});
