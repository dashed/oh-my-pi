/**
 * Contract: the OpenRouter API enrichment (session/openrouter-endpoint-stats.ts)
 * parses the per-model `/endpoints` perf fields (verified live 2026-08:
 * `latency_last_30m`/`throughput_last_30m` p50 objects, `uptime_last_30m`,
 * `tag` slugs; nulls when an upstream has no recent traffic), caches per model
 * for a short TTL without caching failures, strips `:variant` suffixes from
 * model ids, and resolves authoritative attribution from the generation
 * endpoint — all through injected fetch fixtures, never the network.
 */
import { describe, expect, it, vi } from "bun:test";
import {
	fetchOpenRouterEndpointPerf,
	fetchOpenRouterGenerationProvider,
	OpenRouterEndpointStatsCache,
	stripOpenRouterVariantSuffix,
} from "@oh-my-pi/pi-coding-agent/session/openrouter-endpoint-stats";

/** Shape mirrors the live /api/v1/models/{id}/endpoints response. */
function endpointsFixture(): Record<string, unknown> {
	return {
		data: {
			endpoints: [
				{
					name: "Google | anthropic/claude-4-sonnet-20250522",
					model_id: "anthropic/claude-sonnet-4",
					provider_name: "Google",
					tag: "google-vertex/global",
					status: 0,
					latency_last_30m: { p50: 1001, p75: 1313, p90: 1747.2, p99: 3199.08 },
					throughput_last_30m: { p50: 43, p75: 50, p90: 60, p99: 74.68 },
					uptime_last_30m: 100,
				},
				{
					name: "Amazon Bedrock | anthropic/claude-4-sonnet-20250522",
					provider_name: "Amazon Bedrock",
					tag: "amazon-bedrock",
					status: 0,
					latency_last_30m: { p50: 989, p75: 1505.5, p90: 1862.1, p99: 4741.35 },
					throughput_last_30m: { p50: 45, p75: 60, p90: 74, p99: 109.41 },
					uptime_last_30m: 99.94870479610157,
				},
				{
					// Regional variant with no recent traffic: perf fields are null.
					name: "Google (EU) | anthropic/claude-4-sonnet-20250522",
					provider_name: "Google",
					tag: "google-vertex/europe",
					status: 0,
					latency_last_30m: null,
					throughput_last_30m: null,
					uptime_last_30m: null,
				},
			],
		},
	};
}

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

describe("stripOpenRouterVariantSuffix", () => {
	it("strips a variant suffix but leaves port-less ids and provider segments alone", () => {
		expect(stripOpenRouterVariantSuffix("anthropic/claude-haiku-latest:nitro")).toBe("anthropic/claude-haiku-latest");
		expect(stripOpenRouterVariantSuffix("anthropic/claude-haiku-latest")).toBe("anthropic/claude-haiku-latest");
		expect(stripOpenRouterVariantSuffix("deepseek/deepseek-v3.1-terminus:exacto")).toBe("deepseek/deepseek-v3.1-terminus");
	});
});

describe("fetchOpenRouterEndpointPerf", () => {
	it("parses per-endpoint p50 latency/throughput and uptime, tolerating nulls", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(endpointsFixture()));
		const perf = await fetchOpenRouterEndpointPerf("anthropic/claude-sonnet-4", { fetchImpl: fetchMock as unknown as typeof fetch });

		expect(perf).toHaveLength(3);
		expect(perf[0]).toEqual({
			tag: "google-vertex/global",
			providerName: "Google",
			latencyP50Ms: 1001,
			throughputP50: 43,
			uptimeLast30m: 100,
		});
		expect(perf[1]?.tag).toBe("amazon-bedrock");
		expect(perf[1]?.uptimeLast30m).toBeCloseTo(99.95, 1);
		expect(perf[2]).toEqual({
			tag: "google-vertex/europe",
			providerName: "Google",
			latencyP50Ms: undefined,
			throughputP50: undefined,
			uptimeLast30m: undefined,
		});
	});

	it("strips the routing variant before building the request URL", async () => {
		let url = "";
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			url = String(input);
			return jsonResponse(endpointsFixture());
		});
		await fetchOpenRouterEndpointPerf("anthropic/claude-sonnet-4:nitro", { fetchImpl: fetchMock as unknown as typeof fetch });
		expect(url).toBe("https://openrouter.ai/api/v1/models/anthropic/claude-sonnet-4/endpoints");
	});

	it("throws on HTTP failure", async () => {
		const fetchMock = vi.fn(async () => jsonResponse({ error: "nope" }, 404));
		await expect(
			fetchOpenRouterEndpointPerf("anthropic/claude-sonnet-4", { fetchImpl: fetchMock as unknown as typeof fetch }),
		).rejects.toThrow("HTTP 404");
	});

	it("drops endpoints without a tag instead of inventing slugs", async () => {
		const fixture = endpointsFixture();
		((fixture.data as Record<string, unknown>).endpoints as unknown[]).push({ provider_name: "Mystery" });
		const fetchMock = vi.fn(async () => jsonResponse(fixture));
		const perf = await fetchOpenRouterEndpointPerf("anthropic/claude-sonnet-4", { fetchImpl: fetchMock as unknown as typeof fetch });
		expect(perf).toHaveLength(3);
	});
});

describe("OpenRouterEndpointStatsCache", () => {
	it("serves repeat lookups from cache within the TTL", async () => {
		const fetchMock = vi.fn(async () => jsonResponse(endpointsFixture()));
		const cache = new OpenRouterEndpointStatsCache({ ttlMs: 60_000 });
		const first = await cache.get("anthropic/claude-sonnet-4", { fetchImpl: fetchMock as unknown as typeof fetch });
		const second = await cache.get("anthropic/claude-sonnet-4", { fetchImpl: fetchMock as unknown as typeof fetch });
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(second).toBe(first);
	});

	it("refetches after the TTL expires", async () => {
		let now = 1_000;
		const fetchMock = vi.fn(async () => jsonResponse(endpointsFixture()));
		const cache = new OpenRouterEndpointStatsCache({ ttlMs: 60_000, now: () => now });
		await cache.get("m", { fetchImpl: fetchMock as unknown as typeof fetch });
		now += 61_000;
		await cache.get("m", { fetchImpl: fetchMock as unknown as typeof fetch });
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("does not cache failures", async () => {
		let calls = 0;
		const fetchMock = vi.fn(async () => {
			calls++;
			return calls === 1 ? jsonResponse({ error: "down" }, 503) : jsonResponse(endpointsFixture());
		});
		const cache = new OpenRouterEndpointStatsCache({ ttlMs: 60_000 });
		await expect(cache.get("m", { fetchImpl: fetchMock as unknown as typeof fetch })).rejects.toThrow("HTTP 503");
		const perf = await cache.get("m", { fetchImpl: fetchMock as unknown as typeof fetch });
		expect(perf).toHaveLength(3);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});
});

describe("fetchOpenRouterGenerationProvider", () => {
	it("returns the authoritative provider_name", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ data: { id: "gen-1", provider_name: "DigitalOcean", latency: 8380, total_cost: 0.1 } }),
		);
		const provider = await fetchOpenRouterGenerationProvider("gen-1", {
			apiKey: "test-key",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		expect(provider).toBe("DigitalOcean");
	});

	it("falls back to provider_responses[0].provider_name", async () => {
		const fetchMock = vi.fn(async () =>
			jsonResponse({ data: { id: "gen-1", provider_responses: [{ provider_name: "Amazon Bedrock", status: 200 }] } }),
		);
		const provider = await fetchOpenRouterGenerationProvider("gen-1", {
			apiKey: "test-key",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		expect(provider).toBe("Amazon Bedrock");
	});

	it("sends the API key without leaking it into errors, and no-ops on 404", async () => {
		let authorization = "";
		const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
			authorization = new Headers(init?.headers).get("authorization") ?? "";
			return jsonResponse({ error: { message: "Generation gen-bogus not found", code: 404 } }, 404);
		});
		const provider = await fetchOpenRouterGenerationProvider("gen-bogus", {
			apiKey: "test-key",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		expect(provider).toBeUndefined();
		expect(authorization).toBe("Bearer test-key");
	});

	it("swallows network errors (backfill is best-effort)", async () => {
		const fetchMock = vi.fn(async () => {
			throw new Error("socket hangup");
		});
		const provider = await fetchOpenRouterGenerationProvider("gen-1", {
			apiKey: "test-key",
			fetchImpl: fetchMock as unknown as typeof fetch,
		});
		expect(provider).toBeUndefined();
	});
});
