/**
 * OpenRouter routing control, end-to-end at the wire:
 *
 *  - `:nitro` / `:floor` in the model string survive model resolution into
 *    `model.id` and reach the request body's `model` field untouched.
 *    OpenRouter translates those suffixes server-side — `:nitro` ≡
 *    `provider.sort="throughput"`, `:floor` ≡ `provider.sort="price"` — so the
 *    body carrying the suffix IS the routing directive (no client-side
 *    translation; the variant suffix path predates this feature).
 *  - `SimpleStreamOptions.openRouterRouting` (populated from the
 *    `providers.openrouter.{ignore,only,order,sort}` session settings)
 *    serializes verbatim into the request body's `provider` object at BOTH
 *    OpenAI-family call-sites (Chat Completions and Responses buildParams).
 *  - An explicit model-compat routing pin (`@slug` selectors) wins per field
 *    over the per-request settings routing.
 */
import { describe, expect, it, vi } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import { mergeOpenRouterRouting } from "@oh-my-pi/pi-ai/providers/openai-shared";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model, ModelSpec, OpenAICompat, OpenRouterRouting } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const context: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "ping", timestamp: 0 }],
};

function createChatDoneResponse(): Response {
	return new Response(
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n` +
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
			`data: [DONE]\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function createResponsesDoneResponse(): Response {
	return new Response(
		`data: ${JSON.stringify({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", content: [] },
		})}\n\n` +
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}\n\n` +
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n` +
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
			})}\n\n` +
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: {
						input_tokens: 1,
						output_tokens: 1,
						total_tokens: 2,
						input_tokens_details: { cached_tokens: 0 },
					},
				},
			})}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function buildOpenRouterCompletionsModel(
	overrides: Partial<ModelSpec<"openrouter">> = {},
	compat?: OpenAICompat,
): Model<"openrouter"> {
	return buildModel({
		id: "anthropic/claude-haiku-latest",
		name: "Claude Haiku via OpenRouter",
		api: "openrouter",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 131_072,
		compat,
		...overrides,
	} as ModelSpec<"openrouter">);
}

function buildOpenRouterResponsesModel(
	overrides: Partial<ModelSpec<"openai-responses">> = {},
): Model<"openai-responses"> {
	return buildModel({
		id: "anthropic/claude-haiku-latest",
		name: "Claude Haiku via OpenRouter Responses",
		api: "openai-responses",
		provider: "openrouter",
		baseUrl: "https://openrouter.ai/api/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 131_072,
		...overrides,
	} as ModelSpec<"openai-responses">);
}

function captureFetch(): { fetchMock: FetchImpl; body: () => Record<string, unknown> } {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		return createChatDoneResponse();
	}) as unknown as FetchImpl;
	return {
		fetchMock,
		body: () => {
			if (!body) throw new Error("Expected a captured request body");
			return body;
		},
	};
}

function captureResponsesFetch(): { fetchMock: FetchImpl; body: () => Record<string, unknown> } {
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		return createResponsesDoneResponse();
	}) as unknown as FetchImpl;
	return {
		fetchMock,
		body: () => {
			if (!body) throw new Error("Expected a captured request body");
			return body;
		},
	};
}

describe("OpenRouter routing-variant suffixes reach the wire", () => {
	it("keeps an explicit :nitro suffix from the model string on params.model (chat completions)", async () => {
		// `:nitro` in the selector resolves into model.id (model-resolver.ts) and
		// must reach the body untouched — OpenRouter translates it server-side to
		// provider.sort="throughput".
		const model = buildOpenRouterCompletionsModel({ id: "anthropic/claude-haiku-latest:nitro" });
		const { fetchMock, body } = captureFetch();
		const stream = streamOpenAICompletions(model as unknown as Model<"openai-completions">, context, {
			apiKey: "test-key",
			fetch: fetchMock,
		});
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
		expect(body().model).toBe("anthropic/claude-haiku-latest:nitro");
	});

	it("keeps an explicit :floor suffix on params.model (responses)", async () => {
		// `:floor` ≡ provider.sort="price" server-side.
		const model = buildOpenRouterResponsesModel({ id: "anthropic/claude-haiku-latest:floor" });
		const { fetchMock, body } = captureResponsesFetch();
		const stream = streamOpenAIResponses(model, context, { apiKey: "test-key", fetch: fetchMock });
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
		expect(body().model).toBe("anthropic/claude-haiku-latest:floor");
	});

	it("appends the configured openrouterVariant per request when the id has no variant", async () => {
		const model = buildOpenRouterCompletionsModel();
		const { fetchMock, body } = captureFetch();
		const stream = streamOpenAICompletions(model as unknown as Model<"openai-completions">, context, {
			apiKey: "test-key",
			openrouterVariant: "nitro",
			fetch: fetchMock,
		});
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
		expect(body().model).toBe("anthropic/claude-haiku-latest:nitro");
	});

	it("never overrides an explicit variant with the configured one", async () => {
		const model = buildOpenRouterCompletionsModel({ id: "anthropic/claude-haiku-latest:floor" });
		const { fetchMock, body } = captureFetch();
		const stream = streamOpenAICompletions(model as unknown as Model<"openai-completions">, context, {
			apiKey: "test-key",
			openrouterVariant: "nitro",
			fetch: fetchMock,
		});
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
		expect(body().model).toBe("anthropic/claude-haiku-latest:floor");
	});
});

describe("openRouterRouting request option at the wire", () => {
	const routing: OpenRouterRouting = {
		ignore: ["deepinfra"],
		only: ["anthropic"],
		order: ["anthropic", "openai"],
		sort: "throughput",
	};

	it("serializes verbatim into the provider object (chat completions call-site)", async () => {
		const model = buildOpenRouterCompletionsModel();
		const { fetchMock, body } = captureFetch();
		const stream = streamOpenAICompletions(model as unknown as Model<"openai-completions">, context, {
			apiKey: "test-key",
			openRouterRouting: routing,
			fetch: fetchMock,
		});
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
		expect(body().provider).toEqual(routing);
	});

	it("serializes verbatim into the provider object (responses call-site)", async () => {
		const model = buildOpenRouterResponsesModel();
		const { fetchMock, body } = captureResponsesFetch();
		const stream = streamOpenAIResponses(model, context, {
			apiKey: "test-key",
			openRouterRouting: routing,
			fetch: fetchMock,
		});
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
		expect(body().provider).toEqual(routing);
	});

	it("travels through streamSimple's SimpleStreamOptions forwarding (openrouter api)", async () => {
		const model = buildOpenRouterCompletionsModel();
		const { fetchMock, body } = captureResponsesFetch();
		const stream = streamSimple(model, context, {
			apiKey: "test-key",
			openRouterRouting: routing,
			fetch: fetchMock,
		});
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
		expect(body().provider).toEqual(routing);
	});

	it("lets an explicit compat routing pin win per field over the settings routing", async () => {
		const model = buildOpenRouterCompletionsModel({}, { openRouterRouting: { only: ["anthropic"] } });
		const { fetchMock, body } = captureFetch();
		const stream = streamOpenAICompletions(model as unknown as Model<"openai-completions">, context, {
			apiKey: "test-key",
			openRouterRouting: { only: ["together"], ignore: ["deepinfra"], sort: "price" },
			fetch: fetchMock,
		});
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
		expect(body().provider).toEqual({ only: ["anthropic"], ignore: ["deepinfra"], sort: "price" });
	});

	it("is ignored by non-OpenRouter hosts", async () => {
		const model = buildModel({
			id: "gpt-4o-mini",
			name: "GPT-4o mini",
			api: "openai-completions",
			provider: "openai",
			baseUrl: "https://api.openai.com/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 16_384,
		} as ModelSpec<"openai-completions">);
		const { fetchMock, body } = captureFetch();
		const stream = streamOpenAICompletions(model, context, {
			apiKey: "test-key",
			openRouterRouting: routing,
			fetch: fetchMock,
		});
		for await (const event of stream) {
			if (event.type === "done" || event.type === "error") break;
		}
		expect(body().provider).toBeUndefined();
	});
});

describe("mergeOpenRouterRouting", () => {
	it("returns the override when compat has no routing", () => {
		expect(mergeOpenRouterRouting({ ignore: ["deepinfra"] }, undefined)).toEqual({ ignore: ["deepinfra"] });
	});

	it("returns the compat routing when no override is given", () => {
		expect(mergeOpenRouterRouting(undefined, { only: ["anthropic"] })).toEqual({ only: ["anthropic"] });
	});

	it("merges per field with compat winning and empty values never overriding", () => {
		expect(
			mergeOpenRouterRouting(
				{ only: ["together"], order: [], ignore: ["deepinfra"], sort: "latency" },
				{ only: ["anthropic"], order: ["anthropic", "openai"] },
			),
		).toEqual({ only: ["anthropic"], order: ["anthropic", "openai"], ignore: ["deepinfra"], sort: "latency" });
	});
});
