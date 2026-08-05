/**
 * Contract: the rolling per-upstream routing stats accumulator
 * (session/routing-stats.ts) keeps the last 20 turns per slug, computes
 * median tok/s + TTFT p50 for slow detection (only at ≥3 turns), persists
 * throttled-atomically with corrupt-file tolerance, and the session-scoped
 * notifier fires the slow notice at most once per slug. A parallel rolling
 * error channel classifies errored turns (stream-stall / truncated-stream /
 * first-event-timeout / network / other), computes the window error rate,
 * attributes to `upstreamProvider` or the explicit `unknown` bucket, and
 * drives the flaky notice with the same once-per-slug dedup.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import {
	buildRoutingTurnSample,
	classifyRoutingError,
	isOpenRouterBackfillCandidate,
	isOpenRouterErrorBackfillCandidate,
	ProviderHealthNotifier,
	ROUTING_STATS_WINDOW,
	RoutingStatsTracker,
	routingErrorFromMessage,
	routingSampleFromMessage,
	UNKNOWN_PROVIDER_SLUG,
} from "@oh-my-pi/pi-coding-agent/session/routing-stats";
import { TempDir } from "@oh-my-pi/pi-utils";

const THRESHOLDS = { minTokensPerSecond: 15, maxTtftMs: 5000 };

let tempDir: TempDir | undefined;

afterEach(async () => {
	await tempDir?.remove();
	tempDir = undefined;
});

function slowSample(): { outputTokens: number; durationMs: number; ttftMs: number } {
	// 10 output tokens over 2s → 5 tok/s, well under the 15 tok/s threshold.
	return { outputTokens: 10, durationMs: 2000, ttftMs: 500 };
}

function fastSample(): { outputTokens: number; durationMs: number; ttftMs: number } {
	// 200 output tokens over 2s → 100 tok/s, 300ms ttft.
	return { outputTokens: 200, durationMs: 2000, ttftMs: 300 };
}

function recordTurns(
	tracker: RoutingStatsTracker,
	slug: string,
	count: number,
	sample: { outputTokens: number; durationMs: number; ttftMs: number },
): void {
	for (let i = 0; i < count; i++) {
		const built = buildRoutingTurnSample(sample);
		if (!built) throw new Error("test sample must be recordable");
		tracker.record(slug, built);
	}
}

describe("RoutingStatsTracker rolling window", () => {
	it("keeps only the last N turns per slug", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		recordTurns(tracker, "anthropic", ROUTING_STATS_WINDOW + 5, { outputTokens: 10, durationMs: 1000, ttftMs: 100 });
		const summary = tracker.getSummary("anthropic");
		expect(summary?.turns).toBe(ROUTING_STATS_WINDOW);

		// The first 5 turns (10 tok/s) fell out of the window; 5 fresh fast turns
		// shift the median to the recent values.
		recordTurns(tracker, "anthropic", 5, { outputTokens: 1000, durationMs: 1000, ttftMs: 100 });
		expect(tracker.getSummary("anthropic")?.turns).toBe(ROUTING_STATS_WINDOW);
	});

	it("tracks slugs independently", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		recordTurns(tracker, "anthropic", 3, slowSample());
		recordTurns(tracker, "google-vertex", 4, fastSample());
		expect(tracker.getSummary("anthropic")?.turns).toBe(3);
		expect(tracker.getSummary("google-vertex")?.turns).toBe(4);
		expect(tracker.summaries().map(s => s.slug)).toEqual(["anthropic", "google-vertex"]);
	});
});

describe("RoutingStatsTracker medians", () => {
	it("computes median tok/s and ttft p50 over the window", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		// tok/s per turn: 10, 20, 30 → median 20; ttft: 4000, 100, 200 → p50 200.
		const turns = [
			{ outputTokens: 10, durationMs: 1000, ttftMs: 4000 },
			{ outputTokens: 40, durationMs: 2000, ttftMs: 100 },
			{ outputTokens: 90, durationMs: 3000, ttftMs: 200 },
		];
		recordTurns(tracker, "anthropic", 1, turns[0]);
		recordTurns(tracker, "anthropic", 1, turns[1]);
		recordTurns(tracker, "anthropic", 1, turns[2]);
		const summary = tracker.getSummary("anthropic");
		expect(summary?.medianTokensPerSecond).toBe(20);
		expect(summary?.ttftP50Ms).toBe(200);
	});

	it("averages the two middle values on even windows and skips turns without ttft", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		recordTurns(tracker, "anthropic", 1, { outputTokens: 10, durationMs: 1000, ttftMs: 100 });
		recordTurns(tracker, "anthropic", 1, { outputTokens: 30, durationMs: 1000, ttftMs: 300 });
		tracker.record("anthropic", { tokensPerSecond: 20 }); // no ttft
		const summary = tracker.getSummary("anthropic");
		expect(summary?.medianTokensPerSecond).toBe(20);
		expect(summary?.ttftP50Ms).toBe(200);
	});
});

describe("RoutingStatsTracker slow detection", () => {
	it("does not flag slugs with fewer than 3 turns even when slow", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		recordTurns(tracker, "anthropic", 2, slowSample());
		expect(tracker.isSlow("anthropic", THRESHOLDS)).toBe(false);
		expect(tracker.slowReason("anthropic", THRESHOLDS)).toBeUndefined();
	});

	it("flags a slow median tok/s once the window has 3 turns", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		recordTurns(tracker, "anthropic", 3, slowSample());
		expect(tracker.isSlow("anthropic", THRESHOLDS)).toBe(true);
		expect(tracker.slowReason("anthropic", THRESHOLDS)).toBe("5.0 tok/s median");
	});

	it("flags a high ttft p50 even when throughput is fine", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		recordTurns(tracker, "anthropic", 3, { outputTokens: 200, durationMs: 2000, ttftMs: 8000 });
		expect(tracker.isSlow("anthropic", THRESHOLDS)).toBe(true);
		expect(tracker.slowReason("anthropic", THRESHOLDS)).toBe("ttft p50 8.0s");
	});

	it("stays silent for fast providers", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		recordTurns(tracker, "anthropic", 5, fastSample());
		expect(tracker.isSlow("anthropic", THRESHOLDS)).toBe(false);
	});

	it("does not flag a single-sample ttft outlier (per-metric floor)", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		// 3 turns of healthy throughput, but exactly ONE reported a ttft — a
		// one-sample "median" IS that sample and must not trip the notice.
		tracker.record("anthropic", { tokensPerSecond: 100 });
		tracker.record("anthropic", { tokensPerSecond: 100 });
		tracker.record("anthropic", { tokensPerSecond: 100, ttftMs: 60_000 });
		expect(tracker.isSlow("anthropic", THRESHOLDS)).toBe(false);
		expect(tracker.slowReason("anthropic", THRESHOLDS)).toBeUndefined();
	});

	it("does not flag a single-sample tok/s outlier (per-metric floor)", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		// 3 turns with healthy ttft; exactly ONE reported a (slow) tok/s.
		tracker.record("anthropic", { ttftMs: 300 });
		tracker.record("anthropic", { ttftMs: 300 });
		tracker.record("anthropic", { tokensPerSecond: 1, ttftMs: 300 });
		expect(tracker.isSlow("anthropic", THRESHOLDS)).toBe(false);
		expect(tracker.slowReason("anthropic", THRESHOLDS)).toBeUndefined();
	});

	it("flags once the outlier metric reaches two samples", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		tracker.record("anthropic", { tokensPerSecond: 100 });
		tracker.record("anthropic", { tokensPerSecond: 100, ttftMs: 60_000 });
		tracker.record("anthropic", { tokensPerSecond: 100, ttftMs: 60_000 });
		expect(tracker.isSlow("anthropic", THRESHOLDS)).toBe(true);
		expect(tracker.slowReason("anthropic", THRESHOLDS)).toBe("ttft p50 60.0s");
	});
});

describe("RoutingStatsTracker persistence", () => {
	it("round-trips through the stats file", async () => {
		tempDir = TempDir.createSync("@pi-routing-stats-");
		const filePath = tempDir.join("routing-stats.json");
		const first = new RoutingStatsTracker({ persistPath: filePath, saveThrottleMs: 0 });
		await first.ready;
		recordTurns(first, "anthropic", 4, slowSample());
		recordTurns(first, "google-vertex", 2, fastSample());
		await first.flush();

		const second = new RoutingStatsTracker({ persistPath: filePath });
		await second.ready;
		expect(second.getSummary("anthropic")?.turns).toBe(4);
		expect(second.getSummary("anthropic")?.medianTokensPerSecond).toBe(5);
		expect(second.getSummary("google-vertex")?.turns).toBe(2);
		expect(second.isSlow("anthropic", THRESHOLDS)).toBe(true);
	});

	it("persists via a unique tmp name and leaves no tmp litter behind", async () => {
		tempDir = TempDir.createSync("@pi-routing-stats-");
		const filePath = tempDir.join("routing-stats.json");
		const tracker = new RoutingStatsTracker({ persistPath: filePath, saveThrottleMs: 0 });
		await tracker.ready;
		recordTurns(tracker, "anthropic", 1, slowSample());
		await tracker.flush();

		const entries = await fs.readdir(tempDir.path());
		expect(entries.filter(entry => entry.endsWith(".tmp"))).toEqual([]);
		expect(entries).toContain("routing-stats.json");
		const persisted = JSON.parse(await Bun.file(filePath).text()) as {
			providers: Record<string, { samples: unknown[] }>;
		};
		expect(persisted.providers.anthropic?.samples).toHaveLength(1);
		tracker.dispose();
	});

	it("throttles writes and flush() forces them", async () => {
		tempDir = TempDir.createSync("@pi-routing-stats-");
		const filePath = tempDir.join("routing-stats.json");
		const tracker = new RoutingStatsTracker({ persistPath: filePath, saveThrottleMs: 60_000 });
		await tracker.ready;
		recordTurns(tracker, "anthropic", 1, slowSample());
		// Throttled: nothing on disk until flush.
		expect(await Bun.file(filePath).exists()).toBe(false);
		await tracker.flush();
		expect(await Bun.file(filePath).exists()).toBe(true);
		tracker.dispose();
	});

	it("tolerates a corrupt stats file by starting clean", async () => {
		tempDir = TempDir.createSync("@pi-routing-stats-");
		const filePath = tempDir.join("routing-stats.json");
		await Bun.write(filePath, "{ not json !!");
		const tracker = new RoutingStatsTracker({ persistPath: filePath });
		await tracker.ready;
		expect(tracker.summaries()).toEqual([]);
		// And the tracker still records/persists afterwards.
		recordTurns(tracker, "anthropic", 1, slowSample());
		await tracker.flush();
		const reloaded = new RoutingStatsTracker({ persistPath: filePath });
		await reloaded.ready;
		expect(reloaded.getSummary("anthropic")?.turns).toBe(1);
	});

	it("drops malformed entries from a structurally valid file", async () => {
		tempDir = TempDir.createSync("@pi-routing-stats-");
		const filePath = tempDir.join("routing-stats.json");
		await Bun.write(
			filePath,
			JSON.stringify({
				version: 1,
				providers: {
					anthropic: {
						samples: [{ tokensPerSecond: 5, ttftMs: 100 }, "garbage", { tokensPerSecond: Number.NaN }, 42],
					},
					empty: { samples: [] },
					wrong: "shape",
				},
			}),
		);
		const tracker = new RoutingStatsTracker({ persistPath: filePath });
		await tracker.ready;
		expect(tracker.getSummary("anthropic")?.turns).toBe(1);
		expect(tracker.getSummary("empty")).toBeUndefined();
		expect(tracker.getSummary("wrong")).toBeUndefined();
	});
});

describe("routingSampleFromMessage / backfill candidacy", () => {
	const baseMessage = {
		upstreamProvider: "anthropic",
		provider: "openrouter",
		stopReason: "stop",
		usage: { output: 10 },
		duration: 2000,
		ttft: 400,
	};

	it("extracts the sample for an attributed completed turn", () => {
		const recorded = routingSampleFromMessage(baseMessage);
		expect(recorded?.slug).toBe("anthropic");
		expect(recorded?.sample.tokensPerSecond).toBe(5);
		expect(recorded?.sample.ttftMs).toBe(400);
	});

	it("is a no-op when upstreamProvider is absent", () => {
		expect(routingSampleFromMessage({ ...baseMessage, upstreamProvider: undefined })).toBeUndefined();
	});

	it("skips aborted and errored turns", () => {
		expect(routingSampleFromMessage({ ...baseMessage, stopReason: "aborted" })).toBeUndefined();
		expect(routingSampleFromMessage({ ...baseMessage, stopReason: "error" })).toBeUndefined();
	});

	it("skips turns with no usable signal", () => {
		expect(
			routingSampleFromMessage({ ...baseMessage, usage: { output: 0 }, duration: 0, ttft: undefined }),
		).toBeUndefined();
	});

	it("marks gen-id OpenRouter turns without attribution as backfill candidates", () => {
		expect(
			isOpenRouterBackfillCandidate({ ...baseMessage, upstreamProvider: undefined, responseId: "gen-123-abc" }),
		).toBe(true);
		expect(isOpenRouterBackfillCandidate(baseMessage)).toBe(false); // already attributed
		expect(
			isOpenRouterBackfillCandidate({ ...baseMessage, upstreamProvider: undefined, responseId: "chatcmpl-1" }),
		).toBe(false);
		expect(
			isOpenRouterBackfillCandidate({
				...baseMessage,
				upstreamProvider: undefined,
				responseId: "gen-1",
				provider: "openai",
			}),
		).toBe(false);
	});
});

describe("ProviderHealthNotifier slow notices", () => {
	it("fires the notice once per slug when slow, then stays silent", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		const notifier = new ProviderHealthNotifier();
		recordTurns(tracker, "anthropic", 3, slowSample());

		const first = notifier.maybeNotifySlow(tracker, "anthropic", THRESHOLDS);
		expect(first).toBe("anthropic slow (5.0 tok/s median) — /provider ignore anthropic to ban");
		expect(notifier.maybeNotifySlow(tracker, "anthropic", THRESHOLDS)).toBeUndefined();
	});

	it("stays silent for fast providers and under-populated windows", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		const notifier = new ProviderHealthNotifier();
		recordTurns(tracker, "fast-one", 5, fastSample());
		recordTurns(tracker, "new-one", 2, slowSample());
		expect(notifier.maybeNotifySlow(tracker, "fast-one", THRESHOLDS)).toBeUndefined();
		expect(notifier.maybeNotifySlow(tracker, "new-one", THRESHOLDS)).toBeUndefined();
	});

	it("reset() re-arms a slug", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		const notifier = new ProviderHealthNotifier();
		recordTurns(tracker, "anthropic", 3, slowSample());
		expect(notifier.maybeNotifySlow(tracker, "anthropic", THRESHOLDS)).toBeDefined();
		notifier.reset("anthropic");
		expect(notifier.maybeNotifySlow(tracker, "anthropic", THRESHOLDS)).toBeDefined();
	});
});

describe("classifyRoutingError", () => {
	it("classifies the idle-watchdog abort as stream-stall", () => {
		expect(classifyRoutingError("OpenAI responses stream stalled while waiting for the next event")).toBe(
			"stream-stall",
		);
		expect(classifyRoutingError("Provider stream stalled while waiting for the next event")).toBe("stream-stall");
	});

	it("classifies the first-event watchdog as first-event-timeout", () => {
		expect(classifyRoutingError("OpenAI responses stream timed out while waiting for the first event")).toBe(
			"first-event-timeout",
		);
		expect(classifyRoutingError("Anthropic stream timed out while waiting for the first event")).toBe(
			"first-event-timeout",
		);
	});

	it("classifies mid-stream transport closes as truncated-stream", () => {
		expect(classifyRoutingError("OpenAI responses stream closed before a terminal response event was received")).toBe(
			"truncated-stream",
		);
		expect(
			classifyRoutingError(
				"Google API stream ended without a finish reason (connection dropped or response truncated)",
			),
		).toBe("truncated-stream");
	});

	it("classifies connection-level failures as network", () => {
		expect(classifyRoutingError("server_error: Network connection lost")).toBe("network");
		expect(classifyRoutingError("fetch failed")).toBe("network");
	});

	it("keeps the user-visible stall and network classes distinct", () => {
		expect(classifyRoutingError("OpenAI responses stream stalled while waiting for the next event")).not.toBe(
			classifyRoutingError("server_error: Network connection lost"),
		);
	});

	it("falls back to other for unrecognized or missing messages", () => {
		expect(classifyRoutingError("500 Internal Server Error")).toBe("other");
		expect(classifyRoutingError(undefined)).toBe("other");
	});
});

describe("RoutingStatsTracker error channel", () => {
	it("computes the error rate over successes plus errors in the window", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		recordTurns(tracker, "deepinfra", 7, fastSample());
		tracker.recordError("deepinfra", "stream-stall");
		tracker.recordError("deepinfra", "stream-stall");
		tracker.recordError("deepinfra", "network");
		const summary = tracker.getSummary("deepinfra");
		expect(summary?.turns).toBe(7);
		expect(summary?.errors).toBe(3);
		expect(summary?.errorRate).toBeCloseTo(0.3);
		expect(summary?.errorCounts).toEqual({ "stream-stall": 2, network: 1 });
	});

	it("surfaces error-only slugs with zero success turns", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		tracker.recordError("deepinfra", "other");
		const summary = tracker.getSummary("deepinfra");
		expect(summary?.turns).toBe(0);
		expect(summary?.errors).toBe(1);
		expect(summary?.errorRate).toBe(1);
		expect(tracker.summaries().map(s => s.slug)).toEqual(["deepinfra"]);
	});

	it("caps the error channel at the rolling window", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		for (let i = 0; i < ROUTING_STATS_WINDOW + 5; i++) tracker.recordError("deepinfra", "network");
		expect(tracker.getSummary("deepinfra")?.errors).toBe(ROUTING_STATS_WINDOW);
	});
});

describe("RoutingStatsTracker flaky detection", () => {
	const FLAKY = { minErrors: 3, minErrorRate: 0.3 };

	it("flags a slug once errors pass both thresholds", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		recordTurns(tracker, "deepinfra", 7, fastSample());
		for (let i = 0; i < 3; i++) tracker.recordError("deepinfra", "stream-stall");
		expect(tracker.isFlaky("deepinfra", FLAKY)).toBe(true);
		expect(tracker.flakyReason("deepinfra", FLAKY)).toBe("3 stream stalls in 10 turns");
	});

	it("stays silent below the minimum error count", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		tracker.recordError("deepinfra", "stream-stall");
		tracker.recordError("deepinfra", "stream-stall");
		expect(tracker.isFlaky("deepinfra", FLAKY)).toBe(false);
	});

	it("stays silent below the error-rate threshold even with enough errors", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		recordTurns(tracker, "deepinfra", 17, fastSample());
		for (let i = 0; i < 3; i++) tracker.recordError("deepinfra", "stream-stall");
		expect(tracker.isFlaky("deepinfra", FLAKY)).toBe(false);
	});

	it("names the dominant error class and singularizes a single occurrence", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		recordTurns(tracker, "deepinfra", 1, fastSample());
		tracker.recordError("deepinfra", "network");
		expect(tracker.flakyReason("deepinfra", { minErrors: 1, minErrorRate: 0.3 })).toBe("1 network error in 2 turns");
	});
});

describe("routingErrorFromMessage / error backfill candidacy", () => {
	const baseError = {
		upstreamProvider: "deepinfra",
		provider: "openrouter",
		stopReason: "error",
		errorMessage: "OpenAI responses stream stalled while waiting for the next event",
	};

	it("attributes an errored turn to its upstreamProvider", () => {
		const recorded = routingErrorFromMessage(baseError);
		expect(recorded?.slug).toBe("deepinfra");
		expect(recorded?.sample.class).toBe("stream-stall");
	});

	it("records unattributed errors under the explicit unknown bucket", () => {
		const recorded = routingErrorFromMessage({ ...baseError, upstreamProvider: undefined });
		expect(recorded?.slug).toBe(UNKNOWN_PROVIDER_SLUG);
		expect(recorded?.sample.class).toBe("stream-stall");
	});

	it("ignores non-error turns", () => {
		expect(routingErrorFromMessage({ ...baseError, stopReason: "stop" })).toBeUndefined();
		expect(routingErrorFromMessage({ ...baseError, stopReason: "aborted" })).toBeUndefined();
	});

	it("marks gen-id errored OpenRouter turns without attribution as backfill candidates", () => {
		expect(
			isOpenRouterErrorBackfillCandidate({ ...baseError, upstreamProvider: undefined, responseId: "gen-123-abc" }),
		).toBe(true);
		expect(isOpenRouterErrorBackfillCandidate(baseError)).toBe(false); // already attributed
		expect(isOpenRouterErrorBackfillCandidate({ ...baseError, stopReason: "stop" })).toBe(false); // not an error
		expect(
			isOpenRouterErrorBackfillCandidate({
				...baseError,
				upstreamProvider: undefined,
				responseId: "gen-1",
				provider: "openai",
			}),
		).toBe(false);
	});
});

describe("RoutingStatsTracker error persistence", () => {
	it("round-trips the error channel through the stats file", async () => {
		tempDir = TempDir.createSync("@pi-routing-stats-");
		const filePath = tempDir.join("routing-stats.json");
		const first = new RoutingStatsTracker({ persistPath: filePath, saveThrottleMs: 0 });
		await first.ready;
		recordTurns(first, "deepinfra", 7, fastSample());
		first.recordError("deepinfra", "stream-stall");
		first.recordError("deepinfra", "network");
		first.recordError(UNKNOWN_PROVIDER_SLUG, "first-event-timeout");
		await first.flush();

		const second = new RoutingStatsTracker({ persistPath: filePath });
		await second.ready;
		const summary = second.getSummary("deepinfra");
		expect(summary?.turns).toBe(7);
		expect(summary?.errors).toBe(2);
		expect(summary?.errorCounts).toEqual({ "stream-stall": 1, network: 1 });
		expect(second.getSummary(UNKNOWN_PROVIDER_SLUG)?.errors).toBe(1);
	});

	it("drops malformed persisted error entries", async () => {
		tempDir = TempDir.createSync("@pi-routing-stats-");
		const filePath = tempDir.join("routing-stats.json");
		await Bun.write(
			filePath,
			JSON.stringify({
				version: 1,
				providers: {
					deepinfra: { samples: [], errors: [{ class: "network" }, "stream-stall", { class: "bogus" }, 42] },
				},
			}),
		);
		const tracker = new RoutingStatsTracker({ persistPath: filePath });
		await tracker.ready;
		expect(tracker.getSummary("deepinfra")?.errorCounts).toEqual({ network: 1, "stream-stall": 1 });
	});
});

describe("ProviderHealthNotifier flaky notices", () => {
	const FLAKY = { minErrors: 3, minErrorRate: 0.3 };

	it("fires the erroring notice once per slug, pointing at /provider ignore", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		const notifier = new ProviderHealthNotifier();
		recordTurns(tracker, "deepinfra", 7, fastSample());
		for (let i = 0; i < 3; i++) tracker.recordError("deepinfra", "stream-stall");

		const first = notifier.maybeNotifyFlaky(tracker, "deepinfra", FLAKY);
		expect(first).toBe("deepinfra erroring (3 stream stalls in 10 turns) — /provider ignore deepinfra to ban");
		expect(notifier.maybeNotifyFlaky(tracker, "deepinfra", FLAKY)).toBeUndefined();
	});

	it("stays silent below the thresholds and re-arms on reset()", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		const notifier = new ProviderHealthNotifier();
		recordTurns(tracker, "deepinfra", 18, fastSample());
		for (let i = 0; i < 2; i++) tracker.recordError("deepinfra", "stream-stall");
		expect(notifier.maybeNotifyFlaky(tracker, "deepinfra", FLAKY)).toBeUndefined();

		tracker.recordError("deepinfra", "stream-stall"); // 3 errors / 21 turns still below 0.3
		expect(notifier.maybeNotifyFlaky(tracker, "deepinfra", FLAKY)).toBeUndefined();

		for (let i = 0; i < 4; i++) tracker.recordError("deepinfra", "stream-stall"); // 7/25 = 0.28, still below
		expect(notifier.maybeNotifyFlaky(tracker, "deepinfra", FLAKY)).toBeUndefined();

		for (let i = 0; i < 4; i++) tracker.recordError("deepinfra", "stream-stall"); // 11/29 ≈ 0.38, flaky
		expect(notifier.maybeNotifyFlaky(tracker, "deepinfra", FLAKY)).toBeDefined();
		notifier.reset("deepinfra");
		expect(notifier.maybeNotifyFlaky(tracker, "deepinfra", FLAKY)).toBeDefined();
	});

	it("never notifies for the unknown bucket", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		const notifier = new ProviderHealthNotifier();
		for (let i = 0; i < 5; i++) tracker.recordError(UNKNOWN_PROVIDER_SLUG, "other");
		expect(
			notifier.maybeNotifyFlaky(tracker, UNKNOWN_PROVIDER_SLUG, { minErrors: 1, minErrorRate: 0 }),
		).toBeUndefined();
	});
});
