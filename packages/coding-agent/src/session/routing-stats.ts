/**
 * Rolling per-upstream-provider routing stats for OpenRouter requests.
 *
 * Fed from `EventController.#handleMessageEnd` with the final assistant
 * message's usage/duration/ttft plus the `upstreamProvider` attribution
 * OpenRouter reports mid-stream. Keeps the last {@link ROUTING_STATS_WINDOW}
 * turns per upstream slug in memory and persists them (throttled, atomic) to
 * `~/.omp/agent/routing-stats.json` so slow-provider detection survives
 * restarts. This is intentionally NOT stats.db: that store is batch-synced
 * transport telemetry, while detection here needs the last-N-turns view
 * synchronously at turn end.
 *
 * Slow detection (v1) is notice-only: {@link SlowProviderNotifier} surfaces a
 * single dim status line per slug per session pointing at `/provider ignore`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";

/** Turns kept per upstream slug for the rolling window. */
export const ROUTING_STATS_WINDOW = 20;
/** Minimum turns before a slug can be flagged slow (avoids one-off verdicts). */
export const ROUTING_STATS_MIN_TURNS = 3;

const ROUTING_STATS_FILE_VERSION = 1;
const DEFAULT_SAVE_THROTTLE_MS = 2_000;

/** One completed turn's performance sample for an upstream provider. */
export interface RoutingTurnSample {
	/** Per-turn output throughput (output tokens / whole-turn seconds). */
	tokensPerSecond?: number;
	/** Time to first token in milliseconds, when the provider reported one. */
	ttftMs?: number;
}

/** Rolling-window summary for one upstream slug. */
export interface RoutingProviderSummary {
	slug: string;
	turns: number;
	/** Median per-turn output tokens/second across the window. */
	medianTokensPerSecond: number | undefined;
	/** Median time-to-first-token across turns that reported one. */
	ttftP50Ms: number | undefined;
}

export interface SlowProviderThresholds {
	/** Flag when the median output rate falls below this (tok/s). */
	minTokensPerSecond: number;
	/** Flag when the TTFT p50 rises above this (ms). */
	maxTtftMs: number;
}

/** Raw turn measurements offered by the message_end handler. */
export interface RoutingTurnInput {
	outputTokens: number;
	durationMs: number | undefined;
	ttftMs: number | undefined;
}

function median(values: readonly number[]): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	const lo = sorted[mid - (sorted.length % 2 === 0 ? 1 : 0)];
	const hi = sorted[mid];
	if (lo === undefined || hi === undefined) return undefined;
	return (lo + hi) / 2;
}

function finiteOrUndefined(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Build the storable sample for a turn. Returns `undefined` when the turn
 * carries no usable signal (no measurable duration and no TTFT), so callers
 * can no-op on aborted/empty turns.
 */
export function buildRoutingTurnSample(input: RoutingTurnInput): RoutingTurnSample | undefined {
	const tokensPerSecond =
		input.durationMs !== undefined && input.durationMs > 0 && input.outputTokens > 0
			? input.outputTokens / (input.durationMs / 1000)
			: undefined;
	const ttftMs = input.ttftMs !== undefined && input.ttftMs > 0 ? input.ttftMs : undefined;
	if (tokensPerSecond === undefined && ttftMs === undefined) return undefined;
	return { tokensPerSecond, ttftMs };
}

interface PersistedRoutingStats {
	version: number;
	providers: Record<string, { samples: RoutingTurnSample[] }>;
}

function parsePersistedSamples(raw: unknown): RoutingTurnSample[] {
	if (!Array.isArray(raw)) return [];
	const samples: RoutingTurnSample[] = [];
	for (const entry of raw) {
		if (typeof entry !== "object" || entry === null) continue;
		const record = entry as Record<string, unknown>;
		const tokensPerSecond = finiteOrUndefined(record.tokensPerSecond ?? record.tps);
		const ttftMs = finiteOrUndefined(record.ttftMs ?? record.ttft);
		if (tokensPerSecond === undefined && ttftMs === undefined) continue;
		samples.push({ tokensPerSecond, ttftMs });
	}
	return samples;
}

async function atomicWriteJson(filePath: string, data: unknown): Promise<void> {
	const content = `${JSON.stringify(data, null, 2)}\n`;
	// Unique per writer: concurrently running omp processes share the stats
	// file, and a fixed tmp name lets interleaved writes tear the document
	// (mirrors the board/settings tmp-name convention). A crash can litter
	// the tmp file; hydration tolerates a missing/corrupt stats file.
	const tmpPath = `${filePath}.${process.pid}.${Bun.randomUUIDv7()}.tmp`;
	await Bun.write(tmpPath, content);
	try {
		await fs.rename(tmpPath, filePath);
	} catch (err) {
		// Windows EPERM fallback: unlink target, then rename.
		if ((err as NodeJS.ErrnoException).code === "EPERM") {
			try {
				await fs.unlink(filePath);
			} catch {
				// Target may not exist — that's fine.
			}
			await fs.rename(tmpPath, filePath);
		} else {
			try {
				await fs.unlink(tmpPath);
			} catch {
				// Best effort.
			}
			throw err;
		}
	}
}

export interface RoutingStatsTrackerOptions {
	/** Persistence target; omit for an in-memory tracker. */
	persistPath?: string;
	/** Rolling window size per slug. */
	window?: number;
	/** Minimum interval between persisted writes. */
	saveThrottleMs?: number;
	/** Set false to skip the initial disk read (tests seeding a clean tracker). */
	hydrate?: boolean;
}

export class RoutingStatsTracker {
	readonly #persistPath: string | undefined;
	readonly #window: number;
	readonly #saveThrottleMs: number;
	readonly #samples = new Map<string, RoutingTurnSample[]>();
	#hydrated: Promise<void>;
	#saveTimer: ReturnType<typeof setTimeout> | undefined;
	#saveChain: Promise<void> = Promise.resolve();
	#dirty = false;

	constructor(options: RoutingStatsTrackerOptions = {}) {
		this.#persistPath = options.persistPath;
		this.#window = options.window ?? ROUTING_STATS_WINDOW;
		this.#saveThrottleMs = options.saveThrottleMs ?? DEFAULT_SAVE_THROTTLE_MS;
		this.#hydrated = options.hydrate === false || !this.#persistPath ? Promise.resolve() : this.#hydrateFromDisk();
	}

	/** Resolved once the initial disk read (if any) settled. Await in tests. */
	get ready(): Promise<void> {
		return this.#hydrated;
	}

	/** Record one completed turn for `slug` and schedule a throttled persist. */
	record(slug: string, sample: RoutingTurnSample): void {
		if (!slug) return;
		const samples = this.#samples.get(slug) ?? [];
		samples.push(sample);
		if (samples.length > this.#window) samples.splice(0, samples.length - this.#window);
		this.#samples.set(slug, samples);
		this.#scheduleSave();
	}

	/** Rolling summary for one slug; `undefined` when no turns are recorded. */
	getSummary(slug: string): RoutingProviderSummary | undefined {
		const samples = this.#samples.get(slug);
		if (!samples || samples.length === 0) return undefined;
		return this.#summarize(slug, samples);
	}

	/** Rolling summaries for every tracked slug, sorted by slug. */
	summaries(): RoutingProviderSummary[] {
		return [...this.#samples.entries()]
			.filter(([, samples]) => samples.length > 0)
			.map(([slug, samples]) => this.#summarize(slug, samples))
			.sort((a, b) => a.slug.localeCompare(b.slug));
	}

	/**
	 * Slow verdict for one slug. Requires at least {@link ROUTING_STATS_MIN_TURNS}
	 * turns; slow means median tok/s below the threshold OR TTFT p50 above it.
	 */
	isSlow(slug: string, thresholds: SlowProviderThresholds): boolean {
		return this.slowReason(slug, thresholds) !== undefined;
	}

	/** Human-readable slow reason ("12.3 tok/s median" / "ttft p50 6.2s"), if slow. */
	slowReason(slug: string, thresholds: SlowProviderThresholds): string | undefined {
		const summary = this.getSummary(slug);
		if (!summary || summary.turns < ROUTING_STATS_MIN_TURNS) return undefined;
		if (
			summary.medianTokensPerSecond !== undefined &&
			summary.medianTokensPerSecond < thresholds.minTokensPerSecond
		) {
			return `${summary.medianTokensPerSecond.toFixed(1)} tok/s median`;
		}
		if (summary.ttftP50Ms !== undefined && summary.ttftP50Ms > thresholds.maxTtftMs) {
			return `ttft p50 ${(summary.ttftP50Ms / 1000).toFixed(1)}s`;
		}
		return undefined;
	}

	/** Flush any pending throttled write now. */
	async flush(): Promise<void> {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = undefined;
		}
		await this.#hydrated;
		await this.#persistNow();
		await this.#saveChain;
	}

	/** Stop the throttle timer (process shutdown / tests). */
	dispose(): void {
		if (this.#saveTimer) {
			clearTimeout(this.#saveTimer);
			this.#saveTimer = undefined;
		}
	}

	#summarize(slug: string, samples: readonly RoutingTurnSample[]): RoutingProviderSummary {
		return {
			slug,
			turns: samples.length,
			medianTokensPerSecond: median(samples.map(s => s.tokensPerSecond).filter((v): v is number => v !== undefined)),
			ttftP50Ms: median(samples.map(s => s.ttftMs).filter((v): v is number => v !== undefined)),
		};
	}

	async #hydrateFromDisk(): Promise<void> {
		const persistPath = this.#persistPath;
		if (!persistPath) return;
		try {
			const file = Bun.file(persistPath);
			if (!(await file.exists())) return;
			const parsed = JSON.parse(await file.text()) as Partial<PersistedRoutingStats> | null;
			if (typeof parsed !== "object" || parsed === null) throw new Error("routing stats root is not an object");
			const providers = typeof parsed.providers === "object" && parsed.providers !== null ? parsed.providers : {};
			for (const [slug, entry] of Object.entries(providers)) {
				if (this.#samples.has(slug)) continue; // in-memory turns are newer
				const samples = parsePersistedSamples(entry?.samples).slice(-this.#window);
				if (samples.length > 0) this.#samples.set(slug, samples);
			}
		} catch (error) {
			// Corrupt or unreadable file: start clean rather than losing the turn.
			logger.warn("Ignoring unreadable routing stats file", { path: persistPath, error: String(error) });
		}
	}

	#scheduleSave(): void {
		if (!this.#persistPath || this.#saveTimer) return;
		this.#dirty = true;
		this.#saveTimer = setTimeout(() => {
			this.#saveTimer = undefined;
			void this.#persistNow();
		}, this.#saveThrottleMs);
		// Never keep a process alive for a stats write.
		this.#saveTimer.unref?.();
	}

	async #persistNow(): Promise<void> {
		const persistPath = this.#persistPath;
		if (!persistPath || !this.#dirty) return;
		this.#dirty = false;
		const body: PersistedRoutingStats = {
			version: ROUTING_STATS_FILE_VERSION,
			providers: Object.fromEntries(
				[...this.#samples.entries()].map(([slug, samples]) => [slug, { samples: [...samples] }]),
			),
		};
		this.#saveChain = this.#saveChain.then(async () => {
			// Wait out the initial hydrate so a fresh process cannot clobber the
			// persisted window with a partial in-memory view.
			await this.#hydrated;
			try {
				await atomicWriteJson(persistPath, body);
			} catch (error) {
				logger.warn("Failed to persist routing stats", { path: persistPath, error: String(error) });
			}
		});
		await this.#saveChain;
	}
}

/** Structural slice of an assistant message the routing recorder reads. */
export interface RoutingMessageSlice {
	upstreamProvider?: string;
	responseId?: string;
	provider?: string;
	stopReason: string;
	usage: { output: number };
	duration?: number;
	ttft?: number;
}

/**
 * Extract the recordable turn sample from a finished assistant message.
 * Returns `undefined` for turns that must not feed the stats: aborted/errored
 * turns, turns without upstream attribution, and turns with no usable signal.
 */
export function routingSampleFromMessage(
	message: RoutingMessageSlice,
): { slug: string; sample: RoutingTurnSample } | undefined {
	if (message.stopReason === "aborted" || message.stopReason === "error") return undefined;
	const slug = message.upstreamProvider;
	if (!slug) return undefined;
	const sample = buildRoutingTurnSample({
		outputTokens: message.usage.output,
		durationMs: message.duration,
		ttftMs: message.ttft,
	});
	if (!sample) return undefined;
	return { slug, sample };
}

/**
 * Whether an unattributed OpenRouter turn is worth a generation-endpoint
 * backfill: the stream never named an upstream but left a `gen-…` id.
 */
export function isOpenRouterBackfillCandidate(message: RoutingMessageSlice): boolean {
	if (message.stopReason === "aborted" || message.stopReason === "error") return false;
	if (message.upstreamProvider) return false;
	return (
		message.provider === "openrouter" &&
		typeof message.responseId === "string" &&
		message.responseId.startsWith("gen-")
	);
}

let defaultTracker: RoutingStatsTracker | undefined;
/** Process-wide tracker persisted to `<agentDir>/routing-stats.json`. */
export function getRoutingStatsTracker(): RoutingStatsTracker {
	if (!defaultTracker) {
		defaultTracker = new RoutingStatsTracker({
			persistPath: path.join(getAgentDir(), "routing-stats.json"),
		});
	}
	return defaultTracker;
}

/** Test hook: drop the process-wide tracker so the next access re-creates it. */
export function resetRoutingStatsTrackerForTests(): void {
	defaultTracker?.dispose();
	defaultTracker = undefined;
}

/**
 * Session-scoped dedup for the slow-upstream notice: fires at most once per
 * slug, pointing the operator at `/provider ignore`.
 */
export class SlowProviderNotifier {
	readonly #notified = new Set<string>();

	/**
	 * Return the slow notice when `slug` newly qualifies; `undefined` when the
	 * slug is fast, has too few turns, or was already flagged this session.
	 */
	maybeNotify(tracker: RoutingStatsTracker, slug: string, thresholds: SlowProviderThresholds): string | undefined {
		if (this.#notified.has(slug)) return undefined;
		const reason = tracker.slowReason(slug, thresholds);
		if (!reason) return undefined;
		this.#notified.add(slug);
		const message = `${slug} slow (${reason}) — /provider ignore ${slug} to ban`;
		return message;
	}

	/** Forget a flagged slug (e.g. after /provider unignore) within this session. */
	reset(slug?: string): void {
		if (slug === undefined) this.#notified.clear();
		else this.#notified.delete(slug);
	}
}
