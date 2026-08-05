/**
 * Regression test for the missing upstreamProvider attribution on
 * openrouter/moonshotai/kimi-k3 turns.
 *
 * Root cause (verified live 2026-08-05): the catalog resolves
 * `openrouter/moonshotai/kimi-k3` to `api: "openrouter"`, and the dispatcher
 * routes that pseudo-API to the Responses transport by default
 * (`PI_OPENROUTER_RESPONSES !== "0"`). OpenRouter's *Responses* stream carries
 * NO top-level `provider` field anywhere — zero occurrences across every
 * event, including the terminal `response.completed` — unlike the chat
 * completions chunks the attribution feature was built against. The terminal
 * adoption in `processResponsesStream` therefore reads an absent field and
 * `upstreamProvider` never lands; the `gen-…` response id is the only
 * attribution hook left for the coding-agent generation-endpoint backfill.
 *
 * This file pins both halves of that contract through the real dispatcher:
 *  1. a kimi-k3-shaped Responses stream without `provider` still yields the
 *     `gen-…` responseId (backfill stays possible) and no attribution;
 *  2. when the gateway DOES report `provider` on the terminal response, the
 *     sanitized adoption lands it on the assistant message;
 *  3. the chat-completions wire shape (top-level `provider` on every chunk)
 *     lands attribution when the dispatcher takes the completions branch
 *     (`PI_OPENROUTER_RESPONSES=0`).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { stream } from "@oh-my-pi/pi-ai";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const openrouterKimiK3 = buildModel({
	id: "moonshotai/kimi-k3",
	name: "Kimi K3",
	api: "openrouter",
	provider: "openrouter",
	baseUrl: "https://openrouter.ai/api/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 128_000,
});

const context: Context = {
	messages: [{ role: "user", content: "Say hi", timestamp: 1_000 }],
};

function createSseResponse(events: unknown[]): Response {
	return new Response(`${events.map(event => `data: ${JSON.stringify(event)}`).join("\n\n")}\n\ndata: [DONE]\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

/**
 * Trimmed mirror of the live capture: reasoning item with `reasoning_text`
 * deltas, a message item with one output_text delta, terminal
 * `response.completed` carrying usage — and NO `provider` field anywhere.
 */
function kimiK3ResponsesEvents(terminalResponseExtra: Record<string, unknown> = {}): unknown[] {
	const baseResponse = {
		id: "gen-1785963138-lL9tpDs8EdR4O6JN0K8P",
		object: "response",
		created_at: 1_785_963_138,
		model: "moonshotai/kimi-k3",
	};
	return [
		{
			type: "response.created",
			response: { ...baseResponse, status: "in_progress", output: [] },
			sequence_number: 0,
		},
		{
			type: "response.in_progress",
			response: { ...baseResponse, status: "in_progress", output: [] },
			sequence_number: 1,
		},
		{
			type: "response.output_item.added",
			output_index: 0,
			item: { id: "rs_tmp_vd35um2x1kp", type: "reasoning", status: "in_progress", summary: [] },
			sequence_number: 2,
		},
		{
			type: "response.content_part.added",
			output_index: 0,
			item_id: "rs_tmp_vd35um2x1kp",
			content_index: 0,
			part: { type: "reasoning_text", text: "" },
			sequence_number: 3,
		},
		{
			type: "response.reasoning_text.delta",
			output_index: 0,
			item_id: "rs_tmp_vd35um2x1kp",
			content_index: 0,
			delta: "The user wants a greeting.",
			sequence_number: 4,
		},
		{
			type: "response.output_item.added",
			output_index: 1,
			item: { id: "msg_1", type: "message", status: "in_progress", role: "assistant", content: [] },
			sequence_number: 5,
		},
		{
			type: "response.content_part.added",
			output_index: 1,
			item_id: "msg_1",
			content_index: 0,
			part: { type: "output_text", text: "" },
			sequence_number: 6,
		},
		{
			type: "response.output_text.delta",
			output_index: 1,
			item_id: "msg_1",
			content_index: 0,
			delta: "Hi",
			sequence_number: 7,
		},
		{
			type: "response.output_item.done",
			output_index: 1,
			item: {
				id: "msg_1",
				type: "message",
				status: "completed",
				role: "assistant",
				content: [{ type: "output_text", text: "Hi" }],
			},
			sequence_number: 8,
		},
		{
			type: "response.completed",
			response: {
				...baseResponse,
				status: "completed",
				output: [
					{
						id: "msg_1",
						type: "message",
						status: "completed",
						role: "assistant",
						content: [{ type: "output_text", text: "Hi" }],
					},
				],
				usage: { input_tokens: 87, output_tokens: 32, total_tokens: 119 },
				...terminalResponseExtra,
			},
			sequence_number: 9,
		},
	];
}

function completionsChunk(extra: Record<string, unknown>): Record<string, unknown> {
	return {
		id: "gen-1785963178-1vxoaG3TMrc6mVH7kwBH",
		object: "chat.completion.chunk",
		created: 1_785_963_178,
		model: "moonshotai/kimi-k3",
		provider: "Modal",
		...extra,
	};
}

describe("openrouter upstream attribution (kimi-k3)", () => {
	afterEach(() => {
		delete process.env.PI_OPENROUTER_RESPONSES;
	});

	it("captures the gen-… responseId but no provider from the Responses wire shape", async () => {
		const fetchMock: FetchImpl = () => Promise.resolve(createSseResponse(kimiK3ResponsesEvents()));
		const result = await stream(openrouterKimiK3, context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.content.map(block => block.type)).toEqual(["thinking", "text"]);
		expect(result.content.at(-1)).toMatchObject({ type: "text", text: "Hi" });
		// The Responses wire carries no provider field, so attribution must stay
		// absent here — the gen-… id is what the generation-endpoint backfill keys on.
		expect(result.upstreamProvider).toBeUndefined();
		expect(result.responseId).toBe("gen-1785963138-lL9tpDs8EdR4O6JN0K8P");
	});

	it("adopts a gateway-reported provider from the terminal response", async () => {
		const fetchMock: FetchImpl = () =>
			Promise.resolve(createSseResponse(kimiK3ResponsesEvents({ provider: "Together" })));
		const result = await stream(openrouterKimiK3, context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.upstreamProvider).toBe("Together");
		expect(result.responseId).toBe("gen-1785963138-lL9tpDs8EdR4O6JN0K8P");
	});

	it("adopts the per-chunk provider on the completions branch (PI_OPENROUTER_RESPONSES=0)", async () => {
		process.env.PI_OPENROUTER_RESPONSES = "0";
		const fetchMock: FetchImpl = () =>
			Promise.resolve(
				createSseResponse([
					completionsChunk({ choices: [{ index: 0, delta: { content: "Hi", role: "assistant" } }] }),
					completionsChunk({
						choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
						usage: { prompt_tokens: 87, completion_tokens: 32, total_tokens: 119 },
					}),
				]),
			);
		const result = await stream(openrouterKimiK3, context, {
			apiKey: "test-key",
			fetch: fetchMock,
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(result.upstreamProvider).toBe("Modal");
		expect(result.content).toEqual([{ type: "text", text: "Hi" }]);
	});
});
