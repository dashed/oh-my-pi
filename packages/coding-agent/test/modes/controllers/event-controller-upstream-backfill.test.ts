/**
 * Regression test for the missing OpenRouter upstream attribution on turns
 * served through the Responses transport (e.g. openrouter/moonshotai/kimi-k3,
 * the default `PI_OPENROUTER_RESPONSES` path): the wire carries no `provider`
 * field (verified live 2026-08-05), so attribution depends on the
 * generation-endpoint backfill fired from `#handleMessageEnd`.
 *
 * The backfill lost the endpoint's eventual-consistency race: the generation
 * record 404s while streaming and for ~1–2s after stream end, and the fetch
 * was single-shot, so attribution never resolved — no routing-stats.json, no
 * `via <slug>` on the working indicator. This test drives a real
 * `message_end` through the EventController with a 404→404→200 generation
 * endpoint and asserts the whole chain: stats sample recorded + persisted,
 * message back-filled, live indicator fed.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { getRoutingStatsTracker } from "@oh-my-pi/pi-coding-agent/session/routing-stats";
import { getActiveProfile, Snowflake, setProfile } from "@oh-my-pi/pi-utils";

const GENERATION_ID = "gen-1785963263-6a8HLyRF1DBuhXG4eGTz";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function assistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "Hi" }],
		api: "openai-responses",
		provider: "openrouter",
		model: "moonshotai/kimi-k3",
		usage: {
			input: 87,
			output: 32,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 119,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		responseId: GENERATION_ID,
		duration: 3_200,
		ttft: 1_900,
		timestamp: 1_785_963_263_000,
	} as unknown as AssistantMessage;
}

function createContext() {
	const recordUsage = vi.fn();
	const streamingComponent = {
		updateContent: vi.fn(),
		setHideThinkingBlock: vi.fn(),
		setCacheInvalidation: vi.fn(),
		setErrorPinned: vi.fn(),
		markTranscriptBlockFinalized: vi.fn(),
	};
	const ctx = {
		isInitialized: true,
		settings: { get: () => false },
		noteDisplayableThinkingContent: () => false,
		effectiveHideThinkingBlock: false,
		proseOnlyThinking: false,
		statusLine: { invalidate: vi.fn(), markActivityStart: vi.fn(), markActivityEnd: vi.fn() },
		updateEditorTopBorder: vi.fn(),
		flushPendingCommandOutput: vi.fn(),
		transcriptMessageComponents: new WeakMap(),
		pendingTools: new Map<string, unknown>(),
		hideThinkingBlock: false,
		setWorkingMessage: vi.fn(),
		clearPinnedError: vi.fn(),
		loadingAnimation: { recordUsage, kind: "working" },
		autoCompactionLoader: undefined,
		retryLoader: undefined,
		streamingComponent,
		streamingMessage: undefined,
		lastAssistantUsage: undefined,
		chatContainer: {
			addChild: vi.fn(),
			removeChild: vi.fn(),
			clear: vi.fn(),
			isBlockUncommitted: () => false,
		},
		showStatus: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		showPinnedError: vi.fn(),
		editor: { getText: () => "" },
		ui: { requestRender: vi.fn(), requestComponentRender: vi.fn(), terminal: { setProgress: vi.fn() } },
		viewSession: { isCompacting: false, isTtsrAbortPending: false, retryAttempt: 0 },
		session: {
			sessionId: "test-session",
			isStreaming: true,
			isAborting: false,
			model: { id: "moonshotai/kimi-k3" },
			modelRegistry: { authStorage: { getApiKey: vi.fn(async () => "test-key") } },
			getToolByName: () => undefined,
		},
	} as unknown as InteractiveModeContext;
	return { ctx, recordUsage, streamingComponent };
}

// Integration note: this polls on the real clock because the behavior under
// test IS the production retry timing — the backfill's bounded real-time
// delays (500ms/1s/…) that carry the generation lookup past the endpoint's
// 404 window. The backfill is fire-and-forget with no exposed promise, and
// fake timers would deadlock the interleaved real fetch microtasks.
async function waitFor(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (condition()) return;
		await new Promise(resolve => setTimeout(resolve, 25));
	}
	throw new Error("timed out waiting for condition");
}

describe("OpenRouter upstream attribution backfill", () => {
	const configDirName = `.omp-upstream-backfill-${Snowflake.next()}`;
	const configRoot = path.join(os.homedir(), configDirName);
	const originalProfile = getActiveProfile();
	const originalConfigDir = process.env.PI_CONFIG_DIR;
	const originalFetch = globalThis.fetch;
	let generationCalls = 0;

	beforeAll(async () => {
		initTheme();
		process.env.PI_CONFIG_DIR = configDirName;
		setProfile(undefined);
	});

	beforeEach(async () => {
		resetSettingsForTest();
		await Settings.init({ inMemory: true });
		generationCalls = 0;
		globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
			const url = String(input);
			if (url.includes("/generation?id=")) {
				generationCalls++;
				// Mirror the live eventual-consistency lag: the record 404s right
				// after stream end, then appears with the serving provider_name.
				if (generationCalls < 3) {
					return jsonResponse({ error: { message: `Generation ${GENERATION_ID} not found`, code: 404 } }, 404);
				}
				return jsonResponse({ data: { id: GENERATION_ID, provider_name: "Modal", latency: 2778 } });
			}
			if (url.includes("/endpoints")) {
				return jsonResponse({
					data: {
						endpoints: [
							{
								name: "Modal | moonshotai/kimi-k3",
								provider_name: "Modal",
								tag: "modal",
								status: 0,
								latency_last_30m: { p50: 1000 },
								throughput_last_30m: { p50: 50 },
								uptime_last_30m: 100,
							},
						],
					},
				});
			}
			throw new Error(`unexpected fetch: ${url}`);
		}) as unknown as typeof fetch;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("records the backfilled sample, persists routing-stats.json, and feeds the live indicator", async () => {
		const { ctx, recordUsage } = createContext();
		const controller = new EventController(ctx);
		const message = assistantMessage();
		await controller.handleEvent({ type: "message_end", message } as unknown as AgentSessionEvent);

		const tracker = getRoutingStatsTracker();
		await waitFor(() => tracker.getSummary("modal") !== undefined);

		// The generation 404 window was retried through, not given up on.
		expect(generationCalls).toBe(3);
		// Stats keyed on the endpoint tag; the message + live indicator carry
		// the sanitized display name, mirroring the mid-stream adoption.
		expect(message.upstreamProvider).toBe("Modal");
		expect(recordUsage).toHaveBeenCalledWith(0, "Modal");
		const summary = tracker.getSummary("modal");
		expect(summary?.turns).toBe(1);

		await tracker.flush();
		const statsPath = path.join(configRoot, "agent", "routing-stats.json");
		expect(fs.existsSync(statsPath)).toBe(true);
		const persisted = JSON.parse(fs.readFileSync(statsPath, "utf8")) as {
			providers: Record<string, { samples: unknown[] }>;
		};
		expect(Object.keys(persisted.providers)).toContain("modal");
		expect(persisted.providers.modal?.samples).toHaveLength(1);
		tracker.dispose();

		setProfile(undefined);
		if (originalConfigDir === undefined) {
			delete process.env.PI_CONFIG_DIR;
		} else {
			process.env.PI_CONFIG_DIR = originalConfigDir;
		}
		setProfile(originalProfile);
		fs.rmSync(configRoot, { recursive: true, force: true });
	});
});
