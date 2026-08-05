/**
 * Contract: applyAutoThinkingLevel bounds online classification with the
 * legacy 4s budget on the single-call path, but sizes the caller budget with
 * swarmCallerBudgetMs when the swarm ensemble is enabled — a 15s member
 * phase can never quorum inside 4s, so the smaller budget silently degrades
 * every classified turn to the fallback level (mirrors turn-recovery).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import * as classifierModule from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ModelControls, type ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";
import { swarmCallerBudgetMs } from "@oh-my-pi/pi-coding-agent/swarm/ensemble";
import { AUTO_THINKING } from "@oh-my-pi/pi-coding-agent/thinking";

/** Default swarm knobs: 15s member phase + 250ms grace + 15s fallback + 1s margin. */
const DEFAULT_SWARM_BUDGET_MS = 31_250;
const LEGACY_AUTO_THINKING_BUDGET_MS = 4_000;

function reasoningModel(): Model {
	return buildModel({
		id: "mock-reasoning",
		name: "mock-reasoning",
		api: "openai-completions",
		provider: "mock",
		baseUrl: "https://example.com",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	});
}

function makeControls(settings: Settings): { controls: ModelControls; classificationSignals: AbortSignal[] } {
	const classificationSignals: AbortSignal[] = [];
	vi.spyOn(classifierModule, "classifyDifficulty").mockImplementation((_text, deps) => {
		if (deps.signal) classificationSignals.push(deps.signal);
		// The classifier settles only when its caller signal aborts (the swarm
		// member-phase shape: long-running, abort-driven).
		return new Promise<Effort | undefined>(resolve => {
			deps.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
		});
	});
	const model = reasoningModel();
	const host = {
		agent: {
			setThinkingLevel: () => {},
			setDisableReasoning: () => {},
			metadataForProvider: () => undefined,
		},
		settings,
		modelRegistry: {},
		sessionManager: { appendThinkingLevelChange: () => {} },
		providerSessionState: new Map(),
		model: () => model,
		sessionId: () => "session-1",
		promptGeneration: () => 1,
		resolveActiveEditMode: () => "hashline",
		syncAfterModelChange: async () => {},
		setModelWithProviderSessionReset: async () => {},
		clearActiveRetryFallback: () => {},
		clearInheritedProviderPromptCacheKey: () => {},
		magicKeywordEnabled: () => false,
		emit: () => {},
		emitSessionEvent: async () => {},
		emitNotice: () => {},
	} as unknown as ModelControlsHost;
	return { controls: new ModelControls(host, { thinkingLevel: AUTO_THINKING }), classificationSignals };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("applyAutoThinkingLevel classification budget", () => {
	it("uses the swarm caller budget when the ensemble is enabled (schema default)", async () => {
		vi.useFakeTimers();
		expect(swarmCallerBudgetMs({ enabled: true, members: 3, quorum: 2, timeoutMs: 15_000, graceMs: 250 })).toBe(
			DEFAULT_SWARM_BUDGET_MS,
		);
		const { controls, classificationSignals } = makeControls(Settings.isolated());

		const pending = controls.applyAutoThinkingLevel("fix the flaky test", 1);
		// The classification is in flight with a live signal past the legacy 4s.
		expect(classificationSignals).toHaveLength(1);
		vi.advanceTimersByTime(LEGACY_AUTO_THINKING_BUDGET_MS + 1);
		expect(classificationSignals[0]?.aborted).toBe(false);

		// The swarm budget (member phase + grace + fallback phase) is the abort.
		vi.advanceTimersByTime(DEFAULT_SWARM_BUDGET_MS - LEGACY_AUTO_THINKING_BUDGET_MS - 1);
		expect(classificationSignals[0]?.aborted).toBe(true);
		await pending;
	});

	it("keeps the legacy 4s budget when the swarm is disabled", async () => {
		vi.useFakeTimers();
		const { controls, classificationSignals } = makeControls(Settings.isolated({ "swarm.enabled": false }));

		const pending = controls.applyAutoThinkingLevel("fix the flaky test", 1);
		vi.advanceTimersByTime(LEGACY_AUTO_THINKING_BUDGET_MS - 1);
		expect(classificationSignals[0]?.aborted).toBe(false);
		vi.advanceTimersByTime(1);
		expect(classificationSignals[0]?.aborted).toBe(true);
		await pending;
	});
});
