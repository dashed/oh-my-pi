import { afterEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@oh-my-pi/pi-ai";
import { type AssistantMessage, type Context, Effort, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { classifyDifficulty } from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	completeEnsemble,
	createEnsembleUsageRecorder,
	resolveSwarmConfig,
	SWARM_DEFAULT_GRACE_MS,
} from "@oh-my-pi/pi-coding-agent/swarm/ensemble";
import { generateTitleOnline } from "@oh-my-pi/pi-coding-agent/utils/title-generator";

function buildSwarmModel(efforts: Effort[] = [Effort.Low, Effort.High, Effort.Max]): Model {
	return buildModel({
		id: "mock-swarm",
		name: "mock-swarm",
		api: "openai-completions",
		provider: "mock",
		baseUrl: "https://example.com",
		reasoning: true,
		thinking: { mode: "effort", efforts },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	});
}

let fixtureTimestamp = 1_000_000;
function swarmMessage(text: string, overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	fixtureTimestamp += 1;
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "mock",
		model: "mock-swarm",
		content: [{ type: "text", text }],
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
		},
		stopReason: "stop",
		timestamp: fixtureTimestamp,
		...overrides,
	};
}

const CONTEXT: Context = {
	systemPrompt: ["Answer with a single word."],
	messages: [{ role: "user", content: "Is this unexpected?", timestamp: 1 }],
};

function memberOptions(mock: { mock: { calls: unknown[][] } }): SimpleStreamOptions[] {
	return mock.mock.calls.map(call => call[2] as SimpleStreamOptions);
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("completeEnsemble", () => {
	it("proceeds at the first quorum of non-empty answers and cancels pending members after grace", async () => {
		const model = buildSwarmModel();
		const signals: (AbortSignal | undefined)[] = [];
		const first = swarmMessage(" YES ");
		let call = 0;
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockImplementation((_model, _context, options) => {
			call += 1;
			signals.push(options?.signal);
			// Member 3 is a straggler that never settles on its own.
			if (call === 3) return new Promise<AssistantMessage>(() => {});
			return Promise.resolve(call === 1 ? first : swarmMessage("yes"));
		});

		const result = await completeEnsemble(
			{ model, context: CONTEXT },
			{ members: 3, quorum: 2, graceMs: 10, timeoutMs: 5_000, synthesize: "vote" },
		);

		// Vote ran on the two arrivals; both normalize to "yes" so the earliest wins.
		expect(result).toBe(first);
		expect(call).toBe(3);
		expect(signals).toHaveLength(3);
		for (const signal of signals) expect(signal?.aborted).toBe(true);
		expect(completeSimpleMock).toHaveBeenCalledTimes(3);
	});

	it("issues identical full-strength member calls: same options, reasoning on, no output clipping, untruncated prompt", async () => {
		const model = buildSwarmModel();
		const longInput = `HEAD ${"x".repeat(50_000)} TAIL`;
		const context: Context = {
			systemPrompt: ["sys"],
			messages: [{ role: "user", content: longInput, timestamp: 1 }],
		};
		const metadata = { account_uuid: "acct-1" };
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockImplementation(async () => swarmMessage("yes"));

		await completeEnsemble(
			{
				model,
				context,
				options: {
					apiKey: "test-key",
					// Handicapping knobs a legacy caller might pass — all must be stripped.
					maxTokens: 64,
					disableReasoning: true,
					thinkingBudgets: { high: 128 },
					temperature: 0.4,
					metadata,
				},
			},
			{ members: 3, quorum: 2, graceMs: 5, timeoutMs: 5_000, synthesize: "vote" },
		);

		expect(completeSimpleMock).toHaveBeenCalledTimes(3);
		const optionsList = memberOptions(completeSimpleMock);
		for (const options of optionsList) {
			expect(options.maxTokens).toBeUndefined();
			expect(options.disableReasoning).toBeUndefined();
			expect(options.thinkingBudgets).toBeUndefined();
			expect(options.reasoning).toBe(Effort.Max);
			expect(options.temperature).toBe(0.4);
			expect(options.apiKey).toBe("test-key");
			expect(options.metadata).toBe(metadata);
		}
		// One shared internal cancellation signal, identical for every member.
		expect(optionsList[0]?.signal).toBe(optionsList[1]?.signal);
		expect(optionsList[1]?.signal).toBe(optionsList[2]?.signal);
		// The full, untruncated prompt reaches every member verbatim.
		for (const call of completeSimpleMock.mock.calls) {
			const memberContext = call[1] as Context;
			expect(memberContext.messages[0]?.content).toBe(longInput);
		}
	});

	it("omits the reasoning option entirely for models without a controllable effort surface", async () => {
		const model = buildModel({
			id: "mock-plain",
			name: "mock-plain",
			api: "openai-completions",
			provider: "mock",
			baseUrl: "https://example.com",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		});
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockImplementation(async () => swarmMessage("yes"));

		await completeEnsemble({ model, context: CONTEXT }, { synthesize: "vote", graceMs: 5, timeoutMs: 5_000 });

		expect(completeSimpleMock).toHaveBeenCalledTimes(3);
		for (const options of memberOptions(completeSimpleMock)) {
			expect(options.reasoning).toBeUndefined();
			expect(options.disableReasoning).toBeUndefined();
			expect(options.maxTokens).toBeUndefined();
		}
	});

	it("breaks vote ties by earliest arrival", async () => {
		const model = buildSwarmModel();
		const yes = swarmMessage("yes");
		const no = swarmMessage("no");
		let call = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			call += 1;
			if (call === 1) return Promise.resolve(yes);
			if (call === 2) return Promise.resolve(no);
			return Promise.resolve(swarmMessage("", { stopReason: "error", errorMessage: "boom" }));
		});

		const result = await completeEnsemble(
			{ model, context: CONTEXT },
			{ members: 3, quorum: 2, graceMs: 5, timeoutMs: 5_000, synthesize: "vote" },
		);

		expect(result).toBe(yes);
	});

	it("falls back to one direct identical call when fewer than quorum answers are usable, metering every attempt", async () => {
		const model = buildSwarmModel();
		const fallback = swarmMessage("yes");
		const memberSignals: (AbortSignal | undefined)[] = [];
		let fallbackSignal: AbortSignal | undefined;
		let call = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation((_model, _context, options) => {
			call += 1;
			if (call <= 3) {
				memberSignals.push(options?.signal);
				// One empty answer, two errors: zero usable arrivals.
				return Promise.resolve(
					call === 1 ? swarmMessage("   ") : swarmMessage("", { stopReason: "error", errorMessage: "boom" }),
				);
			}
			fallbackSignal = options?.signal;
			return Promise.resolve(fallback);
		});
		const usage: AssistantMessage[] = [];

		const result = await completeEnsemble(
			{ model, context: CONTEXT },
			{ members: 3, quorum: 2, graceMs: 5, timeoutMs: 5_000, synthesize: "vote", recordUsage: m => usage.push(m) },
		);

		expect(result).toBe(fallback);
		expect(call).toBe(4);
		expect(usage).toHaveLength(4);
		// Members were cancelled; the fallback is wired to the external signal
		// (undefined here — never the aborted internal controller).
		for (const signal of memberSignals) expect(signal?.aborted).toBe(true);
		expect(fallbackSignal?.aborted ?? false).toBe(false);
	});

	it("times out before quorum, cancels members, and runs one direct fallback", async () => {
		const model = buildSwarmModel();
		const fallback = swarmMessage("fallback");
		const signals: (AbortSignal | undefined)[] = [];
		let call = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation((_model, _context, options) => {
			call += 1;
			signals.push(options?.signal);
			if (call <= 3) return new Promise<AssistantMessage>(() => {});
			return Promise.resolve(fallback);
		});
		const usage: AssistantMessage[] = [];

		const result = await completeEnsemble(
			{ model, context: CONTEXT },
			{ members: 3, quorum: 2, graceMs: 5, timeoutMs: 50, synthesize: "vote", recordUsage: m => usage.push(m) },
		);

		expect(result).toBe(fallback);
		expect(call).toBe(4);
		expect(signals).toHaveLength(4);
		for (const signal of signals.slice(0, 3)) expect(signal?.aborted).toBe(true);
		expect(signals[3]?.aborted ?? false).toBe(false);
		// Only the fallback produced a metered response (members never settled).
		expect(usage).toHaveLength(1);
		expect(usage[0]).toBe(fallback);
	});

	it("merge synthesis appends all candidates to the original context and returns the synthesized answer", async () => {
		const model = buildSwarmModel();
		const answers = ["alpha", "beta", "gamma"].map(text => swarmMessage(text));
		const synth = swarmMessage("merged facts");
		const contexts: Context[] = [];
		let call = 0;
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockImplementation((_model, context) => {
			contexts.push(context as Context);
			call += 1;
			return Promise.resolve(call <= 3 ? answers[call - 1] : synth);
		});
		const usage: AssistantMessage[] = [];

		const result = await completeEnsemble(
			{ model, context: CONTEXT },
			{ members: 3, quorum: 2, graceMs: 5, timeoutMs: 5_000, synthesize: "merge", recordUsage: m => usage.push(m) },
		);

		expect(result).toBe(synth);
		expect(call).toBe(4);
		// 3 members + 1 synthesizer, all metered.
		expect(usage).toHaveLength(4);
		// Members saw the pristine context; the synthesizer saw it plus candidates.
		expect(contexts[0]).toBe(CONTEXT);
		const synthContext = contexts[3];
		if (!synthContext) throw new Error("Expected a synthesizer call");
		expect(synthContext.systemPrompt).toEqual(CONTEXT.systemPrompt);
		expect(synthContext.messages[0]).toEqual(CONTEXT.messages[0]);
		const last = synthContext.messages[synthContext.messages.length - 1];
		if (last?.role !== "user" || typeof last.content !== "string") {
			throw new Error("Expected a trailing user message with candidates");
		}
		expect(last.content).toContain("Candidate answers:");
		expect(last.content).toContain("1) alpha");
		expect(last.content).toContain("2) beta");
		expect(last.content).toContain("3) gamma");
		// The synthesizer is a full-strength call too: reasoning on, no output cap.
		const synthOptions = memberOptions(completeSimpleMock)[3];
		if (!synthOptions) throw new Error("Expected synthesizer options");
		expect(synthOptions.maxTokens).toBeUndefined();
		expect(synthOptions.disableReasoning).toBeUndefined();
		expect(synthOptions.reasoning).toBe(Effort.Max);
	});

	it("falls back to the earliest member answer when the merge synthesizer fails", async () => {
		const model = buildSwarmModel();
		const answers = ["alpha", "beta", "gamma"].map(text => swarmMessage(text));
		let call = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			call += 1;
			if (call <= 3) return Promise.resolve(answers[call - 1]);
			return Promise.resolve(swarmMessage("", { stopReason: "error", errorMessage: "synth boom" }));
		});

		const result = await completeEnsemble(
			{ model, context: CONTEXT },
			{ members: 3, quorum: 2, graceMs: 5, timeoutMs: 5_000, synthesize: "merge" },
		);

		expect(result).toBe(answers[0]);
	});

	it("forwards external aborts to in-flight members without waiting out the timeout", async () => {
		const model = buildSwarmModel();
		const signals: (AbortSignal | undefined)[] = [];
		const fallback = swarmMessage("aborted-fallback");
		let call = 0;
		vi.spyOn(ai, "completeSimple").mockImplementation((_model, _context, options) => {
			call += 1;
			signals.push(options?.signal);
			if (call <= 3) {
				// Members settle as aborted only when their signal fires.
				return new Promise<AssistantMessage>(resolve => {
					options?.signal?.addEventListener("abort", () => resolve(swarmMessage("", { stopReason: "aborted" })), {
						once: true,
					});
				});
			}
			return Promise.resolve(fallback);
		});
		const external = new AbortController();

		const startedAt = Date.now();
		const pending = completeEnsemble(
			{ model, context: CONTEXT },
			{ members: 3, quorum: 2, graceMs: 5, timeoutMs: 5_000, synthesize: "vote", signal: external.signal },
		);
		external.abort();
		const result = await pending;

		expect(result).toBe(fallback);
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		for (const signal of signals.slice(0, 3)) expect(signal?.aborted).toBe(true);
		expect(signals[3]).toBe(external.signal);
	});
});

describe("resolveSwarmConfig", () => {
	it("defaults to enabled for title/classifier sites and disabled for mnemopi", () => {
		const settings = Settings.isolated();
		expect(resolveSwarmConfig(settings, "title").enabled).toBe(true);
		expect(resolveSwarmConfig(settings, "autoThinking").enabled).toBe(true);
		expect(resolveSwarmConfig(settings, "unexpectedStop").enabled).toBe(true);
		expect(resolveSwarmConfig(settings, "mnemopi").enabled).toBe(false);
	});

	it("honors the master switch for every site", () => {
		const settings = Settings.isolated({ "swarm.enabled": false, "swarm.mnemopi": true });
		expect(resolveSwarmConfig(settings, "title").enabled).toBe(false);
		expect(resolveSwarmConfig(settings, "autoThinking").enabled).toBe(false);
		expect(resolveSwarmConfig(settings, "unexpectedStop").enabled).toBe(false);
		expect(resolveSwarmConfig(settings, "mnemopi").enabled).toBe(false);
	});

	it("lets the mnemopi opt-in enable the memory path", () => {
		const settings = Settings.isolated({ "swarm.mnemopi": true });
		expect(resolveSwarmConfig(settings, "mnemopi").enabled).toBe(true);
	});

	it("exposes schema defaults and clamps shape knobs", () => {
		const defaults = resolveSwarmConfig(Settings.isolated(), "title");
		expect(defaults).toMatchObject({ members: 3, quorum: 2, timeoutMs: 15_000, graceMs: SWARM_DEFAULT_GRACE_MS });

		const clamped = resolveSwarmConfig(
			Settings.isolated({ "swarm.members": 1, "swarm.quorum": 5, "swarm.timeoutMs": 0 }),
			"title",
		);
		expect(clamped).toMatchObject({ members: 1, quorum: 1, timeoutMs: 100 });
	});

	it("keeps hand-rolled settings fakes on the legacy single-call path", () => {
		const fake = { get: () => undefined } as never;
		expect(resolveSwarmConfig(fake, "title").enabled).toBe(false);
		expect(resolveSwarmConfig(fake, "mnemopi").enabled).toBe(false);
	});
});

describe("createEnsembleUsageRecorder", () => {
	it("records observed usage for every response and opencode-go cost records", () => {
		const observed: { provider: string; model: string; costUsd?: number }[] = [];
		const costs: [string, number, { sessionId?: string }?][] = [];
		const registry = {
			authStorage: {
				recordObservedUsage: (entry: { provider: string; model: string; costUsd?: number }) => observed.push(entry),
				recordUsageCost: (provider: string, costUsd: number, options?: { sessionId?: string }) => {
					costs.push([provider, costUsd, options]);
					return true;
				},
			},
			getProviderBaseUrl: () => "https://example.com",
		} as never;
		const recorder = createEnsembleUsageRecorder(registry, "session-1");

		recorder(swarmMessage("one"));
		expect(observed).toHaveLength(1);
		expect(costs).toHaveLength(0);

		recorder(swarmMessage("two", { provider: "opencode-go" }));
		expect(observed).toHaveLength(2);
		expect(costs).toHaveLength(1);
		expect(costs[0]?.[0]).toBe("opencode-go");
		expect(costs[0]?.[1]).toBe(0.001);
		expect(costs[0]?.[2]).toMatchObject({ sessionId: "session-1" });
	});
});

describe("consumer adoption", () => {
	function swarmAwareSettings(overrides: Record<string, unknown>, smolModel: Model) {
		return {
			get(path: string) {
				if (path in overrides) return overrides[path];
				return undefined;
			},
			getModelRole(role: string) {
				return role === "smol" ? `${smolModel.provider}/${smolModel.id}` : undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;
	}

	it("title generation fans out to identical full-strength members and votes", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Claude Sonnet 4.5 model");
		const settings = swarmAwareSettings({ "swarm.enabled": true }, model);
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as never;
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Swarm Title</title>" }],
		} as never);

		const title = await generateTitleOnline("build a swarm of title models", registry, settings);

		expect(title).toBe("Swarm Title");
		expect(completeSimpleMock).toHaveBeenCalledTimes(3);
		for (const options of memberOptions(completeSimpleMock)) {
			expect(options.maxTokens).toBeUndefined();
			expect(options.disableReasoning).toBeUndefined();
		}
	});

	it("title legacy path keeps reasoning disabled with the raised 2048 guardrail", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Claude Sonnet 4.5 model");
		const settings = swarmAwareSettings({ "swarm.enabled": false }, model);
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as never;
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "<title>Legacy Title</title>" }],
		} as never);

		const title = await generateTitleOnline("build a swarm of title models", registry, settings);

		expect(title).toBe("Legacy Title");
		expect(completeSimpleMock).toHaveBeenCalledTimes(1);
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({ disableReasoning: true, maxTokens: 2048 });
	});

	it("online auto-thinking classification reaches quorum without truncating long prompts", async () => {
		const targetModel = buildSwarmModel();
		const classifierModel = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!classifierModel) throw new Error("Expected bundled Claude Sonnet 4.6 model");
		const longPrompt = `refactor the scheduler ${"x".repeat(10_000)}`;
		const settings = swarmAwareSettings(
			{
				"providers.autoThinkingModel": "online",
				"swarm.enabled": true,
				"swarm.timeoutMs": 5_000,
			},
			classifierModel,
		);
		const registry = {
			getAvailable: () => [classifierModel],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as never;
		let call = 0;
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockImplementation(() => {
			call += 1;
			// Only two members answer; the third hangs. Quorum must still resolve.
			if (call === 3) return new Promise<AssistantMessage>(() => {});
			return Promise.resolve(swarmMessage("high"));
		});

		const effort = await classifyDifficulty(longPrompt, { settings, registry, model: targetModel });

		expect(effort).toBe(Effort.High);
		expect(completeSimpleMock).toHaveBeenCalledTimes(3);
		for (const memberCall of completeSimpleMock.mock.calls) {
			const context = memberCall[1] as Context;
			expect(context.messages[0]?.content).toBe(longPrompt);
			const options = memberCall[2] as SimpleStreamOptions;
			expect(options.maxTokens).toBeUndefined();
			expect(options.disableReasoning).toBeUndefined();
		}
	});
});
