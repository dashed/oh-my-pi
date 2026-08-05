import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { ApiKeyResolveContext, AssistantMessage, AssistantRetryRecovery, Usage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import * as aiStream from "@oh-my-pi/pi-ai/stream";
import type { FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveAssistantErrorPresentation } from "@oh-my-pi/pi-coding-agent/modes/utils/transcript-render-helpers";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SILENT_ABORT_MARKER } from "@oh-my-pi/pi-coding-agent/session/messages";
import type { SessionMessageEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

type AutoRetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

type RecoveryRun = {
	session: AgentSession;
	sessionManager: SessionManager;
	retryEndEvents: AutoRetryEndEvent[];
	requestedKeys: string[];
};

const RATE_LIMIT_ERROR =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}} retry-after-ms=11180000';
const RETRIABLE_SERVER_ERROR = "503 service unavailable: overloaded_error";

function emptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		},
	};
}

function assistantMessage(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: emptyUsage(),
		stopReason: "stop",
		timestamp: 1,
		...overrides,
	};
}

function retryRecovery(recovery: AssistantRetryRecovery["recovery"], note: string): AssistantRetryRecovery {
	return {
		kind: "auto-retry",
		status: "recovered",
		attempt: 1,
		recoveredAt: "2026-07-04T00:00:00.000Z",
		recovery,
		note,
	};
}

function resolveInitialApiKey(
	apiKey: string | ((ctx: ApiKeyResolveContext) => string | Promise<string | undefined> | undefined) | undefined,
): string {
	const resolved = typeof apiKey === "function" ? apiKey({ lastChance: false, error: undefined }) : apiKey;
	if (typeof resolved !== "string") {
		throw new Error("Expected API key to be resolved before streaming");
	}
	return resolved;
}

interface AssistantEntry {
	entry: SessionMessageEntry;
	message: AssistantMessage;
}

function assistantEntries(sessionManager: SessionManager): AssistantEntry[] {
	const result: AssistantEntry[] = [];
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "assistant") continue;
		result.push({ entry, message });
	}
	return result;
}

function recoveredAssistantEntry(sessionManager: SessionManager): AssistantEntry {
	const found = assistantEntries(sessionManager).find(
		candidate => candidate.message.retryRecovery?.status === "recovered",
	);
	if (!found) {
		throw new Error("Expected a recovered assistant entry");
	}
	return found;
}

function successfulAssistantEntry(sessionManager: SessionManager, text: string): AssistantEntry {
	const found = assistantEntries(sessionManager).find(candidate =>
		candidate.message.content.some(block => block.type === "text" && block.text === text),
	);
	if (!found) {
		throw new Error(`Expected successful assistant entry containing ${text}`);
	}
	return found;
}

function sseResponse(events: unknown[]): Response {
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/** Text deltas, then a clean EOF with no terminal response event. */
function truncatedTextSseResponse(text: string, responseId: string): Response {
	return sseResponse([
		{ type: "response.created", response: { id: responseId, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: `msg_${responseId}`, delta: text },
	]);
}

/** Stream acknowledged, then EOF before any output item — nothing ever committed. */
function truncatedEmptySseResponse(responseId: string): Response {
	return sseResponse([{ type: "response.created", response: { id: responseId, status: "in_progress" } }]);
}

function completedTextSseResponse(text: string, responseId: string): Response {
	return sseResponse([
		{ type: "response.created", response: { id: responseId, status: "in_progress" } },
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: `msg_${responseId}`, role: "assistant", status: "in_progress", content: [] },
		},
		{ type: "response.output_text.delta", output_index: 0, item_id: `msg_${responseId}`, delta: text },
		{
			type: "response.output_item.done",
			output_index: 0,
			item: {
				type: "message",
				id: `msg_${responseId}`,
				role: "assistant",
				status: "completed",
				content: [{ type: "output_text", text }],
			},
		},
		{ type: "response.completed", response: { id: responseId, status: "completed" } },
	]);
}

describe("AgentSession retry recovery", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[];
	let managers: SessionManager[];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-retry-recovery-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		vi.spyOn(aiStream, "getEnvApiKey").mockReturnValue(undefined);
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		sessions = [];
		managers = [];
	});

	afterEach(async () => {
		for (const activeSession of sessions.splice(0).reverse()) {
			await activeSession.dispose();
		}
		for (const manager of managers.splice(0).reverse()) {
			await manager.close();
		}
		authStorage.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function runCredentialRecovery(): Promise<RecoveryRun> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}

		authStorage.removeRuntimeApiKey("anthropic");
		await authStorage.set("anthropic", [
			{ type: "api_key", key: "anthropic-key-1" },
			{ type: "api_key", key: "anthropic-key-2" },
		]);

		const mock = createMockModel();
		const requestedKeys: string[] = [];
		let agent!: Agent;
		agent = new Agent({
			getApiKey: requestedModel => modelRegistry.resolver(requestedModel, agent.sessionId),
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => {
				const apiKey = resolveInitialApiKey(options?.apiKey);
				requestedKeys.push(apiKey);
				if (requestedKeys.length === 1) {
					mock.push({ throw: RATE_LIMIT_ERROR });
				} else {
					mock.push({ content: ["recovered after credential switch"], stopReason: "stop" });
				}
				return mock.stream(requestedModel, context, options);
			},
		});

		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		sessions.push(session);

		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger account rate limit recovery");
		await session.waitForIdle();
		await sessionManager.flush();

		return { session, sessionManager, retryEndEvents, requestedKeys };
	}

	/**
	 * Drive a turn through the real OpenAI responses provider with a scripted
	 * fetch, so provider-internal transient-stream retries and the session-level
	 * auto_retry saga are both exercised end to end.
	 */
	async function runOpenAIResponsesTruncation(fetchMock: FetchImpl): Promise<{
		sessionManager: SessionManager;
		retryEndEvents: AutoRetryEndEvent[];
	}> {
		const model = getBundledModel("openai", "gpt-5-mini");
		if (!model) {
			throw new Error("Expected bundled OpenAI test model to exist");
		}
		authStorage.setRuntimeApiKey("openai", "openai-test-key");

		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) =>
				streamOpenAIResponses(requestedModel as Model<"openai-responses">, context, {
					...options,
					apiKey: "openai-test-key",
					fetch: fetchMock,
					providerRetryWait: async () => {},
				}),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		sessions.push(session);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Trigger stream truncation");
		await session.waitForIdle();
		await sessionManager.flush();

		return { sessionManager, retryEndEvents };
	}

	it("marks a recovered retry error, emits it, persists it, and excludes only model-context replay", async () => {
		const { sessionManager, retryEndEvents, requestedKeys } = await runCredentialRecovery();

		expect(new Set(requestedKeys)).toEqual(new Set(["anthropic-key-1", "anthropic-key-2"]));
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
		expect(retryEndEvents[0].recoveredErrors).toHaveLength(1);

		const recoveredEntry = recoveredAssistantEntry(sessionManager);
		const successfulEntry = successfulAssistantEntry(sessionManager, "recovered after credential switch");
		const recoveredEvent = retryEndEvents[0].recoveredErrors?.[0];
		if (!recoveredEvent) {
			throw new Error("Expected a recovered error payload on auto_retry_end");
		}
		const recoveredMarker = recoveredEntry.message.retryRecovery;
		if (!recoveredMarker) {
			throw new Error("Expected recovered marker on superseded assistant message");
		}
		expect(recoveredEvent.entryId).toBe(recoveredEntry.entry.id);
		expect(recoveredEvent.persistenceKey).toBeString();
		expect(recoveredEvent.note).toBe("rate-limited; switched account; retried");
		expect(recoveredEvent.retryRecovery).toEqual(recoveredMarker);
		expect(recoveredEntry.message.stopReason).toBe("error");
		expect(recoveredEntry.message.retryRecovery).toMatchObject({
			kind: "auto-retry",
			status: "recovered",
			attempt: 1,
			recovery: "credential",
			note: "rate-limited; switched account; retried",
			supersededBy: {
				provider: successfulEntry.message.provider,
				model: successfulEntry.message.model,
				timestamp: successfulEntry.message.timestamp,
			},
		});
		expect(Date.parse(recoveredEntry.message.retryRecovery?.recoveredAt ?? "")).not.toBeNaN();

		const modelContext = sessionManager.buildSessionContext();
		expect(modelContext.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(
			modelContext.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(modelContext.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "recovered after credential switch" }],
		});

		const transcriptContext = sessionManager.buildSessionContext({ transcript: true });
		expect(transcriptContext.messages.map(message => message.role)).toEqual(["user", "assistant", "assistant"]);
		expect(
			transcriptContext.messages.some(
				message => message.role === "assistant" && message.retryRecovery?.status === "recovered",
			),
		).toBe(true);
	});

	it("leaves exhausted retries as terminal errors without recovery presentation", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) {
			throw new Error("Expected bundled Anthropic test model to exist");
		}
		authStorage.setRuntimeApiKey("anthropic", "anthropic-test-key");

		const mock = createMockModel({
			responses: [{ throw: RETRIABLE_SERVER_ERROR }, { throw: RETRIABLE_SERVER_ERROR }],
		});
		const agent = new Agent({
			getApiKey: requestedModel => `${requestedModel.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
			streamFn: (requestedModel, context, options) => mock.stream(requestedModel, context, options),
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 100,
			"retry.maxRetries": 1,
			"retry.modelFallback": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);

		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
		});
		sessions.push(session);
		vi.spyOn(scheduler, "wait").mockResolvedValue(undefined);
		const retryEndEvents: AutoRetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		await session.prompt("Exhaust retry attempts");
		await session.waitForIdle();

		expect(mock.calls).toHaveLength(2);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false, attempt: 1 });
		expect(retryEndEvents[0].recoveredErrors).toBeUndefined();

		const terminalError = assistantEntries(sessionManager).at(-1)?.message;
		if (!terminalError) {
			throw new Error("Expected a terminal assistant error entry");
		}
		const terminalErrorText = terminalError.errorMessage;
		if (!terminalErrorText) {
			throw new Error("Expected a terminal assistant errorMessage");
		}
		expect(terminalError).toMatchObject({ role: "assistant", stopReason: "error" });
		expect(terminalError.retryRecovery).toBeUndefined();
		expect(resolveAssistantErrorPresentation(terminalError)).toEqual({
			kind: "full",
			text: terminalErrorText,
			isError: true,
		});
	});

	it("does not loop-retry an interactive text-only truncated turn the provider already retried", async () => {
		const fetchMock = vi.fn(async () =>
			truncatedTextSseResponse("Partial visible answer", "resp_truncated"),
		) as FetchImpl;

		const { sessionManager, retryEndEvents } = await runOpenAIResponsesTruncation(fetchMock);

		// 1 initial attempt + 2 provider-internal transient-stream retries. The
		// final attempt's partial text was forwarded, so the session must NOT
		// replay the turn at the loop level.
		expect(fetchMock).toHaveBeenCalledTimes(3);
		expect(retryEndEvents).toEqual([]);

		const terminalError = assistantEntries(sessionManager).at(-1)?.message;
		if (!terminalError) {
			throw new Error("Expected a terminal assistant error entry");
		}
		expect(terminalError.stopReason).toBe("error");
		expect(terminalError.errorMessage).toContain("closed before a terminal response event");
		expect(JSON.stringify(terminalError.content)).toContain("Partial visible answer");
		expect(terminalError.retryRecovery).toBeUndefined();
	});

	it("runs the auto_retry saga when an empty incomplete-stream error escapes the provider", async () => {
		let call = 0;
		const fetchMock = vi.fn(async () => {
			call++;
			if (call <= 3) return truncatedEmptySseResponse(`resp_truncated_${call}`);
			return completedTextSseResponse("recovered after provider budget exhaustion", "resp_recovered");
		}) as FetchImpl;

		const { sessionManager, retryEndEvents } = await runOpenAIResponsesTruncation(fetchMock);

		// 3 provider attempts (budget exhausted with nothing committed, so the
		// error stays replay-safe) + 1 session-level auto-retry that succeeds.
		expect(fetchMock).toHaveBeenCalledTimes(4);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });

		const recoveredEntry = recoveredAssistantEntry(sessionManager);
		expect(recoveredEntry.message.stopReason).toBe("error");
		expect(recoveredEntry.message.content).toEqual([]);
		successfulAssistantEntry(sessionManager, "recovered after provider budget exhaustion");
	});

	it("maps assistant error presentation for recovered, unrecovered, and silent abort turns", () => {
		const recoveredCases: Array<{
			name: string;
			recovery: AssistantRetryRecovery["recovery"];
			note: string;
		}> = [
			{ name: "credential", recovery: "credential", note: "rate-limited; switched account; retried" },
			{ name: "model", recovery: "model", note: "rate-limited; switched model; retried" },
			{ name: "wait", recovery: "wait", note: "rate-limited; waited; retried" },
			{ name: "plain", recovery: "plain", note: "error; retried" },
		];

		for (const testCase of recoveredCases) {
			expect(
				resolveAssistantErrorPresentation(
					assistantMessage({
						stopReason: "error",
						errorMessage: `${testCase.name} retry was superseded`,
						retryRecovery: retryRecovery(testCase.recovery, testCase.note),
					}),
				),
			).toEqual({ kind: "compact-recovered", text: testCase.note, isError: false });
		}

		expect(
			resolveAssistantErrorPresentation(
				assistantMessage({ stopReason: "error", errorMessage: "503 service unavailable" }),
			),
		).toEqual({ kind: "full", text: "503 service unavailable", isError: true });
		expect(
			resolveAssistantErrorPresentation(
				assistantMessage({ stopReason: "aborted", errorMessage: SILENT_ABORT_MARKER }),
			),
		).toEqual({ kind: "none" });
	});

	it("keeps recovered markers durable across session reload and still excludes them from model context", async () => {
		const { sessionManager } = await runCredentialRecovery();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) {
			throw new Error("Expected recovery run to persist a session file");
		}

		const reloadedManager = await SessionManager.open(sessionFile, path.join(tempDir.path(), "sessions"), undefined, {
			suppressBreadcrumb: true,
		});
		managers.push(reloadedManager);
		const recoveredEntry = recoveredAssistantEntry(reloadedManager);
		expect(recoveredEntry.message.retryRecovery).toMatchObject({
			kind: "auto-retry",
			status: "recovered",
			recovery: "credential",
			note: "rate-limited; switched account; retried",
		});

		const modelContext = reloadedManager.buildSessionContext();
		expect(modelContext.messages.map(message => message.role)).toEqual(["user", "assistant"]);
		expect(
			modelContext.messages.some(message => message.role === "assistant" && message.stopReason === "error"),
		).toBe(false);
		expect(modelContext.messages.at(-1)).toMatchObject({
			role: "assistant",
			content: [{ type: "text", text: "recovered after credential switch" }],
		});
	});
});
