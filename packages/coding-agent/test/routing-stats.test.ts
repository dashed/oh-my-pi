/**
 * Contract: the rolling per-upstream routing stats accumulator
 * (session/routing-stats.ts) keeps the last 20 turns per slug, computes
 * median tok/s + TTFT p50 for slow detection (only at ≥3 turns), persists
 * throttled-atomically with corrupt-file tolerance, and the session-scoped
 * notifier fires the slow notice at most once per slug.
 */
import { afterEach, describe, expect, it } from "bun:test";
import {
	buildRoutingTurnSample,
	isOpenRouterBackfillCandidate,
	ROUTING_STATS_WINDOW,
	routingSampleFromMessage,
	RoutingStatsTracker,
	SlowProviderNotifier,
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
					anthropic: { samples: [{ tokensPerSecond: 5, ttftMs: 100 }, "garbage", { tokensPerSecond: Number.NaN }, 42] },
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
		expect(routingSampleFromMessage({ ...baseMessage, usage: { output: 0 }, duration: 0, ttft: undefined })).toBeUndefined();
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
			isOpenRouterBackfillCandidate({ ...baseMessage, upstreamProvider: undefined, responseId: "gen-1", provider: "openai" }),
		).toBe(false);
	});
});

describe("SlowProviderNotifier", () => {
	it("fires the notice once per slug when slow, then stays silent", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		const notifier = new SlowProviderNotifier();
		recordTurns(tracker, "anthropic", 3, slowSample());

		const first = notifier.maybeNotify(tracker, "anthropic", THRESHOLDS);
		expect(first).toBe("anthropic slow (5.0 tok/s median) — /provider ignore anthropic to ban");
		expect(notifier.maybeNotify(tracker, "anthropic", THRESHOLDS)).toBeUndefined();
	});

	it("stays silent for fast providers and under-populated windows", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		const notifier = new SlowProviderNotifier();
		recordTurns(tracker, "fast-one", 5, fastSample());
		recordTurns(tracker, "new-one", 2, slowSample());
		expect(notifier.maybeNotify(tracker, "fast-one", THRESHOLDS)).toBeUndefined();
		expect(notifier.maybeNotify(tracker, "new-one", THRESHOLDS)).toBeUndefined();
	});

	it("reset() re-arms a slug", () => {
		const tracker = new RoutingStatsTracker({ hydrate: false });
		const notifier = new SlowProviderNotifier();
		recordTurns(tracker, "anthropic", 3, slowSample());
		expect(notifier.maybeNotify(tracker, "anthropic", THRESHOLDS)).toBeDefined();
		notifier.reset("anthropic");
		expect(notifier.maybeNotify(tracker, "anthropic", THRESHOLDS)).toBeDefined();
	});
});
