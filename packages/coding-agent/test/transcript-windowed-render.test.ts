/**
 * Windowed initial transcript render (session-resume freeze fix).
 *
 * Resuming a large session synchronously constructed every transcript block
 * before the first paint (a minute-long frozen frame at ~2.6k messages).
 * renderInitialMessages now renders only a tail window and backfills the older
 * prefix in event-loop-bounded chunks, cutting right before a user prompt with
 * no tool call/result pair straddling the cut.
 *
 * These tests pin the contract:
 *  (a) first paint covers only the tail window and stays under budget;
 *  (b) the fully backfilled transcript byte-matches a full synchronous render;
 *  (c) read-group/usage-anchored turns landing at the cut merge identically;
 *  (d) chunked backfill front-inserts older blocks above the untouched tail.
 */

import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TranscriptContainer } from "@oh-my-pi/pi-coding-agent/modes/components/transcript-container";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	type TranscriptWindowConfig,
	UiHelpers,
} from "@oh-my-pi/pi-coding-agent/modes/utils/ui-helpers";
import type { SessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	await initTheme(false);
});

const WIDTH = 100;

function usage(input: number): Usage {
	return {
		input,
		output: input * 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: input * 3,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

let clock = 0;
function nextTimestamp(): number {
	clock += 1;
	return clock;
}

function userMessage(text: string, options?: { synthetic?: boolean }): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		synthetic: options?.synthetic ?? false,
		timestamp: nextTimestamp(),
	} as AgentMessage;
}

function assistantMessage(content: AssistantMessage["content"], usageInput = 12): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: usage(usageInput),
		stopReason: "stop",
		timestamp: nextTimestamp(),
	};
}

function toolResult(callId: string, toolName: string, text: string): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: nextTimestamp(),
	} as AgentMessage;
}

function readCall(id: string, path: string): ToolCall {
	return { type: "toolCall", id, name: "read", arguments: { path } };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
	return { type: "toolCall", id, name, arguments: args };
}

function transcriptWith(messages: AgentMessage[]): SessionContext {
	return {
		messages,
		thinkingLevel: "off",
		serviceTier: undefined,
		models: {},
		injectedTtsrRules: [],
		mode: "none",
	} as unknown as SessionContext;
}

interface RenderHarness {
	ctx: InteractiveModeContext;
	chatContainer: TranscriptContainer;
	helpers: UiHelpers;
	history: string[];
}

function makeRenderCtx(
	transcript: SessionContext,
	options?: { settings?: Record<string, boolean>; streaming?: boolean; window?: Partial<TranscriptWindowConfig> },
): RenderHarness {
	const chatContainer = new TranscriptContainer();
	const history: string[] = [];
	const settingsMap = options?.settings ?? {};
	let helpers: UiHelpers;
	const viewSession = {
		isStreaming: options?.streaming ?? false,
		retryAttempt: 0,
		buildTranscriptSessionContext: () => transcript,
		getToolByName: () => undefined,
		extensionRunner: undefined,
		sessionManager: {
			getEntries: vi.fn(() => []),
			getCwd: vi.fn(() => "/tmp"),
			putBlobSync: vi.fn(() => ({
				hash: "hash",
				path: "/tmp/hash",
				displayPath: "/tmp/hash.png",
				ref: "blob:sha256:hash",
			})),
		},
	};
	const ctx = {
		chatContainer,
		pendingMessagesContainer: { disposeChildren: vi.fn() },
		pendingBashComponents: [],
		pendingPythonComponents: [],
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map(),
		lastAssistantUsage: undefined,
		compactionQueuedMessages: [],
		statusLine: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		ui: { requestRender: vi.fn(), imageBudget: undefined },
		resetTranscript: () => chatContainer.clear(),
		settings: { get: (key: string) => settingsMap[key] ?? false },
		toolOutputExpanded: false,
		hideToolActivity: false,
		hideThinkingBlock: false,
		focusedAgentId: undefined,
		initialChatRendered: false,
		editor: { addToHistory: (text: string) => history.push(text) },
		eventController: undefined,
		viewSession,
		sessionManager: viewSession.sessionManager,
		noteDisplayableThinkingContent: vi.fn(() => false),
		addMessageToChat: (message: AgentMessage, opts?: { populateHistory?: boolean }) =>
			helpers.addMessageToChat(message, opts),
		renderSessionContext: (context: SessionContext, opts?: { updateFooter?: boolean; populateHistory?: boolean }) =>
			helpers.renderSessionContext(context, opts),
		getUserMessageText: (message: Message) => helpers.getUserMessageText(message),
		present: vi.fn(),
		showStatus: vi.fn(),
	} as unknown as InteractiveModeContext;
	helpers = new UiHelpers(ctx, options?.window);
	return { ctx, chatContainer, helpers, history };
}

/** One event-loop turn: lets the backfill's setImmediate-scheduled chunk run. */
function nextImmediate(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Pump every scheduled backfill chunk to completion, one event-loop turn at a time. */
async function drainBackfill(helpers: UiHelpers): Promise<void> {
	while (helpers.hasPendingTranscriptBackfill()) {
		await nextImmediate();
	}
}

function renderedTranscript(chatContainer: TranscriptContainer): string {
	return chatContainer.render(WIDTH).join("\n");
}

/**
 * Mixed transcript covering the merge/anchor machinery: read-run groups with
 * usage attach, plain tools, a todo snapshot pair, a task block, thinking,
 * synthetic user prompts, and a dangling read run. Window boundaries sweep
 * across it via the window-size override in the equality tests.
 */
function mixedFixture(): AgentMessage[] {
	clock = 0;
	const messages: AgentMessage[] = [];
	for (let turn = 0; turn < 8; turn++) {
		messages.push(userMessage(`turn ${turn}: please inspect the code`));
		if (turn % 3 === 0) {
			// Pure read turn: collapses into a read group and anchors the usage row.
			messages.push(
				assistantMessage(
					[readCall(`r${turn}a`, `src/alpha-${turn}.ts`), readCall(`r${turn}b`, `src/beta-${turn}.ts`)],
					20 + turn,
				),
			);
			messages.push(toolResult(`r${turn}a`, "read", `export const alpha${turn} = ${turn};\n`.repeat(3)));
			messages.push(toolResult(`r${turn}b`, "read", `export const beta${turn} = ${turn};\n`.repeat(2)));
		} else if (turn % 3 === 1) {
			messages.push(
				assistantMessage([
					{ type: "thinking", thinking: `planning turn ${turn}\n\n- step one\n- step two` },
					{ type: "text", text: `Turn ${turn} analysis:\n\n\`\`\`ts\nconst x = ${turn};\n\`\`\`\n\nNow running it.` },
					toolCall(`b${turn}`, "bash", { command: `echo turn-${turn}` }),
				]),
			);
			messages.push(toolResult(`b${turn}`, "bash", `turn-${turn}`));
		} else {
			messages.push(
				assistantMessage([
					{ type: "text", text: `Turn ${turn}: updating todos and delegating.` },
					toolCall(`t${turn}`, "todo", { todos: [{ id: `${turn}`, text: `task ${turn}`, status: "pending" }] }),
					toolCall(`w${turn}`, "write", {
						path: `src/out-${turn}.ts`,
						content: `// generated ${turn}\nexport const out = ${turn};\n`.repeat(4),
					}),
				]),
			);
			messages.push(toolResult(`t${turn}`, "todo", "Todos updated"));
			messages.push(toolResult(`w${turn}`, "write", `Wrote src/out-${turn}.ts`));
		}
		messages.push(assistantMessage([{ type: "text", text: `Turn ${turn} **summary** with \`code\` inline.` }]));
	}
	messages.push(userMessage("final question?"));
	messages.push(assistantMessage([{ type: "text", text: "FINAL_ANSWER_MARKER with *emphasis*." }]));
	return messages;
}

/** Deterministic ~1.5KB markdown body so render cost scales with fixture size. */
function markdownBody(seed: number): string {
	const words = `alpha${seed} beta gamma delta epsilon zeta`.split(" ");
	const prose = Array.from({ length: 24 }, (_, i) => words[(seed + i) % words.length]).join(" ");
	return [
		`## Section ${seed}`,
		"",
		prose,
		"",
		"```ts",
		`export function handler${seed}(input: number): number {`,
		`	const value${seed} = input * ${seed} + ${seed * 7};`,
		`	return value${seed} > 100 ? ${seed} : value${seed};`,
		"}",
		"```",
		"",
		`- item ${seed} one`,
		`- item ${seed} two with **bold** and \`inline\``,
	].join("\n");
}

/** ~600 messages / ~900KB of markdown — full render takes seconds in-process. */
function bigFixture(): AgentMessage[] {
	clock = 0;
	const messages: AgentMessage[] = [];
	for (let turn = 0; turn < 150; turn++) {
		messages.push(userMessage(`TURN_${turn}_QUESTION: explain component ${turn}`));
		messages.push(
			assistantMessage([
				{ type: "text", text: markdownBody(turn) },
				toolCall(`big-bash-${turn}`, "bash", { command: `bun test test/suite-${turn}.test.ts` }),
			]),
		);
		messages.push(toolResult(`big-bash-${turn}`, "bash", `${turn} pass, 0 fail\n`.repeat(3)));
		messages.push(assistantMessage([{ type: "text", text: markdownBody(turn + 1000) }]));
	}
	messages.push(userMessage("wrap up"));
	messages.push(assistantMessage([{ type: "text", text: "BIG_FIXTURE_TAIL_MARKER" }]));
	return messages;
}

describe("windowed transcript render", () => {
	it("(a) first paint on a large session stays under the 2s budget", async () => {
		const messages = bigFixture();
		expect(messages.length).toBeGreaterThan(500);

		const full = makeRenderCtx(transcriptWith(messages));
		const fullStart = performance.now();
		full.helpers.renderInitialMessages();
		renderedTranscript(full.chatContainer);
		const fullMs = performance.now() - fullStart;

		// Production window configuration: no overrides.
		const windowed = makeRenderCtx(transcriptWith(messages));
		const windowStart = performance.now();
		windowed.helpers.renderInitialMessages();
		const firstPaintMs = performance.now() - windowStart;
		const firstPaint = renderedTranscript(windowed.chatContainer);

		expect(windowed.helpers.hasPendingTranscriptBackfill()).toBe(true);
		expect(firstPaint).toContain("BIG_FIXTURE_TAIL_MARKER");
		expect(firstPaint).not.toContain("TURN_0_QUESTION");
		// The absolute budget from the freeze report, and a relative guard so the
		// test can't pass because the fixture got cheap to render in full.
		expect(firstPaintMs).toBeLessThan(2000);
		expect(fullMs).toBeGreaterThan(firstPaintMs * 2);
		console.log(
			`[windowed-resume] full=${fullMs.toFixed(0)}ms firstPaint=${firstPaintMs.toFixed(0)}ms messages=${messages.length}`,
		);

		await drainBackfill(windowed.helpers);
		renderedTranscript(windowed.chatContainer);
		expect(renderedTranscript(windowed.chatContainer)).toBe(renderedTranscript(full.chatContainer));
	}, 30_000);

	it("renders small transcripts in full with no backfill", () => {
		const messages = mixedFixture();
		const { helpers, chatContainer } = makeRenderCtx(transcriptWith(messages), {
			window: { minTotalMessages: 1000 },
		});
		helpers.renderInitialMessages();
		expect(helpers.hasPendingTranscriptBackfill()).toBe(false);
		expect(renderedTranscript(chatContainer)).toContain("FINAL_ANSWER_MARKER");
	});

	it("(a) first paint covers only the tail window, backfill completes the transcript", async () => {
		const messages = mixedFixture();
		const full = makeRenderCtx(transcriptWith(messages));
		full.helpers.renderInitialMessages();
		expect(full.helpers.hasPendingTranscriptBackfill()).toBe(false);
		const fullText = renderedTranscript(full.chatContainer);

		const windowed = makeRenderCtx(transcriptWith(messages), {
			window: { minTotalMessages: 10, maxWindowMessages: 6, minWindowMessages: 2, windowByteBudget: 1 },
		});
		windowed.helpers.renderInitialMessages();
		expect(windowed.helpers.hasPendingTranscriptBackfill()).toBe(true);
		const firstPaint = renderedTranscript(windowed.chatContainer);
		expect(firstPaint).toContain("FINAL_ANSWER_MARKER");
		// The oldest history is not part of the first paint…
		expect(firstPaint).not.toContain("turn 0: please inspect");
		await drainBackfill(windowed.helpers);
		// …and the completed transcript matches the full render byte for byte.
		expect(renderedTranscript(windowed.chatContainer)).toBe(fullText);
	});

	it("(b) backfilled transcript byte-matches the full render across cut positions", async () => {
		const messages = mixedFixture();
		const full = makeRenderCtx(transcriptWith(messages), {
			settings: { "display.showTokenUsage": true },
		});
		full.helpers.renderInitialMessages();
		const fullText = renderedTranscript(full.chatContainer);

		// Each window size snaps the cut to a different user-prompt boundary,
		// sweeping it across read groups, todo snapshots, and usage anchors.
		for (const minWindowMessages of [2, 3, 5, 7, 11, 17]) {
			const windowed = makeRenderCtx(transcriptWith(messages), {
				settings: { "display.showTokenUsage": true },
				window: { minTotalMessages: 10, maxWindowMessages: 1000, minWindowMessages, windowByteBudget: 1 },
			});
			windowed.helpers.renderInitialMessages();
			expect(windowed.helpers.hasPendingTranscriptBackfill()).toBe(true);
			await drainBackfill(windowed.helpers);
			const windowedText = renderedTranscript(windowed.chatContainer);
			expect(windowedText.length).toBe(fullText.length);
			expect(windowedText).toBe(fullText);
		}
	});

	it("(b2) populates editor history oldest-first even though the tail renders first", async () => {
		const messages = mixedFixture();
		const full = makeRenderCtx(transcriptWith(messages));
		full.helpers.renderInitialMessages();
		const windowed = makeRenderCtx(transcriptWith(messages), {
			window: { minTotalMessages: 10, maxWindowMessages: 4, minWindowMessages: 2, windowByteBudget: 1 },
		});
		windowed.helpers.renderInitialMessages();
		await drainBackfill(windowed.helpers);
		expect(windowed.history).toEqual(full.history);
		expect(windowed.history.length).toBeGreaterThan(3);
	});

	it("(c) a read group ending exactly at the cut merges and anchors usage identically", async () => {
		clock = 0;
		const messages: AgentMessage[] = [
			userMessage("older turn"),
			assistantMessage([{ type: "text", text: "older answer" }]),
			userMessage("read some files"),
			assistantMessage([readCall("ga", "src/a.ts"), readCall("gb", "src/b.ts")], 42),
			toolResult("ga", "read", "A_CONTENT\n".repeat(3)),
			toolResult("gb", "read", "B_CONTENT\n".repeat(3)),
			// The cut snaps to right before this prompt, so the read group + its
			// attached usage row are the last blocks the prefix backfill emits.
			userMessage("boundary prompt"),
			assistantMessage([{ type: "text", text: "window answer one" }]),
			userMessage("latest prompt"),
			assistantMessage([{ type: "text", text: "window answer two" }]),
		];
		const full = makeRenderCtx(transcriptWith(messages), {
			settings: { "display.showTokenUsage": true },
		});
		full.helpers.renderInitialMessages();
		const fullText = renderedTranscript(full.chatContainer);
		expect(fullText).toContain("src/a.ts");

		// A 4-message window starts exactly at "boundary prompt", so the read
		// group + its anchored usage row are the prefix backfill's last blocks.
		const windowed = makeRenderCtx(transcriptWith(messages), {
			settings: { "display.showTokenUsage": true },
			window: { minTotalMessages: 5, maxWindowMessages: 4, minWindowMessages: 4, windowByteBudget: 1 },
		});
		windowed.helpers.renderInitialMessages();
		expect(renderedTranscript(windowed.chatContainer)).not.toContain("src/a.ts");
		windowed.helpers.renderInitialMessages();
		await drainBackfill(windowed.helpers);
		expect(renderedTranscript(windowed.chatContainer)).toBe(fullText);
	});

	it("(c2) a straddling tool result pushes the cut forward instead of orphaning", async () => {
		clock = 0;
		const messages: AgentMessage[] = [
			userMessage("start"),
			assistantMessage([{ type: "text", text: "early" }]),
			userMessage("middle prompt"),
			// The tool result lands AFTER the next user prompt (out-of-order tail);
			// cutting before that prompt would straddle the pair, so the planner
			// must move the cut past the result.
			assistantMessage([toolCall("late-call", "bash", { command: "echo late" })]),
			userMessage("prompt before late result"),
			toolResult("late-call", "bash", "LATE_RESULT"),
			userMessage("tail prompt"),
			assistantMessage([{ type: "text", text: "tail answer" }]),
		];
		const full = makeRenderCtx(transcriptWith(messages));
		full.helpers.renderInitialMessages();
		const fullText = renderedTranscript(full.chatContainer);

		// A 4-message window candidate starts at "prompt before late result",
		// straddling the late-call pair; the planner must move the cut forward.
		const windowed = makeRenderCtx(transcriptWith(messages), {
			window: { minTotalMessages: 5, maxWindowMessages: 4, minWindowMessages: 4, windowByteBudget: 1 },
		});
		windowed.helpers.renderInitialMessages();
		await drainBackfill(windowed.helpers);
		expect(renderedTranscript(windowed.chatContainer)).toBe(fullText);
		expect(fullText).toContain("LATE_RESULT");
	});

	it("(d) chunked backfill front-inserts ordered history above an untouched tail", async () => {
		const messages = mixedFixture();
		const harness = makeRenderCtx(transcriptWith(messages), {
			window: { minTotalMessages: 10, maxWindowMessages: 5, minWindowMessages: 2, windowByteBudget: 1, chunkBudgetMs: 0 },
		});
		harness.helpers.renderInitialMessages();
		const tailChildren = [...harness.chatContainer.children];
		expect(tailChildren.length).toBeGreaterThan(0);
		let previousCount = tailChildren.length;
		while (harness.helpers.hasPendingTranscriptBackfill()) {
			await nextImmediate();
			const children = harness.chatContainer.children;
			// Growth is monotonic and purely a prefix: the windowed tail blocks
			// keep their identity and their relative order at the end.
			expect(children.length).toBeGreaterThanOrEqual(previousCount);
			const tail = children.slice(children.length - tailChildren.length);
			expect(tail).toEqual(tailChildren);
			previousCount = children.length;
		}
		expect(previousCount).toBeGreaterThan(tailChildren.length);

		const full = makeRenderCtx(transcriptWith(messages));
		full.helpers.renderInitialMessages();
		expect(renderedTranscript(harness.chatContainer)).toBe(renderedTranscript(full.chatContainer));
	});

	it("replays in full while streaming (dangling tool calls stay wired for live routing)", () => {
		const messages = mixedFixture();
		const harness = makeRenderCtx(transcriptWith(messages), {
			streaming: true,
			window: { minTotalMessages: 10, maxWindowMessages: 4, minWindowMessages: 1, windowByteBudget: 1 },
		});
		harness.helpers.renderInitialMessages();
		expect(harness.helpers.hasPendingTranscriptBackfill()).toBe(false);
		expect(renderedTranscript(harness.chatContainer)).toContain("turn 0: please inspect");
	});

	it("windows a transcript whose tail is one long user-less final turn", async () => {
		clock = 0;
		const messages: AgentMessage[] = [
			userMessage("early prompt"),
			assistantMessage([{ type: "text", text: "early answer" }]),
			userMessage("FINAL_TURN_START prompt"),
		];
		// A long agentic final turn: no user prompt for the rest of the transcript.
		for (let round = 0; round < 6; round++) {
			messages.push(
				assistantMessage([
					{ type: "text", text: `round ${round}` },
					toolCall(`ft-${round}`, "bash", { command: `echo round-${round}` }),
				]),
			);
			messages.push(toolResult(`ft-${round}`, "bash", `round-${round}`));
		}
		messages.push(assistantMessage([{ type: "text", text: "FINAL_TURN_TAIL" }]));

		const full = makeRenderCtx(transcriptWith(messages));
		full.helpers.renderInitialMessages();
		const fullText = renderedTranscript(full.chatContainer);

		const windowed = makeRenderCtx(transcriptWith(messages), {
			window: { minTotalMessages: 5, maxWindowMessages: 4, minWindowMessages: 2, windowByteBudget: 1 },
		});
		windowed.helpers.renderInitialMessages();
		// The forward snap finds no prompt in the tail, so the cut moves backward
		// to "FINAL_TURN_START prompt" and the window covers the whole final turn.
		expect(windowed.helpers.hasPendingTranscriptBackfill()).toBe(true);
		const firstPaint = renderedTranscript(windowed.chatContainer);
		expect(firstPaint).toContain("FINAL_TURN_TAIL");
		expect(firstPaint).not.toContain("early answer");
		await drainBackfill(windowed.helpers);
		expect(renderedTranscript(windowed.chatContainer)).toBe(fullText);
	});

	it("a superseding renderInitialMessages cancels the pending backfill", async () => {
		const messages = mixedFixture();
		const harness = makeRenderCtx(transcriptWith(messages), {
			window: { minTotalMessages: 10, maxWindowMessages: 4, minWindowMessages: 2, windowByteBudget: 1 },
		});
		harness.helpers.renderInitialMessages();
		expect(harness.helpers.hasPendingTranscriptBackfill()).toBe(true);
		// A rebuild (session switch, compaction) clears the container; the stale
		// backfill must abort instead of front-inserting into the fresh render.
		harness.helpers.renderInitialMessages();
		expect(harness.helpers.hasPendingTranscriptBackfill()).toBe(true); // re-planned for the same big transcript
		await drainBackfill(harness.helpers);
		const full = makeRenderCtx(transcriptWith(messages));
		full.helpers.renderInitialMessages();
		expect(renderedTranscript(harness.chatContainer)).toBe(renderedTranscript(full.chatContainer));
	});
});
