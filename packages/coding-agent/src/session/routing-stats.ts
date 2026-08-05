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
 * Slow + flaky detection is notice-only: {@link ProviderHealthNotifier}
 * surfaces a single dim status line per slug per session pointing at
 * `/provider ignore`. Flaky detection reads a parallel rolling error channel:
 * errored turns (classified by {@link classifyRoutingError}) recorded per
 * slug, with unattributable errors landing in the explicit
 * {@link UNKNOWN_PROVIDER_SLUG} bucket so they never poison a real slug's
 * stats.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, logger } from "@oh-my-pi/pi-utils";

/** Turns kept per upstream slug for the rolling window. */
export const ROUTING_STATS_WINDOW = 20;
/** Minimum turns before a slug can be flagged slow (avoids one-off verdicts). */
export const ROUTING_STATS_MIN_TURNS = 3;
/**
 * Minimum samples reporting a given metric before its median can flag a
 * slug — a median over one sample IS that sample, so a single outlier turn
 * would otherwise trip the slow notice.
 */
const ROUTING_STATS_MIN_METRIC_SAMPLES = 2;

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
	/** Success turns in the window (turns that produced a perf sample). */
	turns: number;
	/** Median per-turn output tokens/second across the window. */
	medianTokensPerSecond: number | undefined;
	/** Median time-to-first-token across turns that reported one. */
	ttftP50Ms: number | undefined;
	/** Errored turns in the window. */
	errors: number;
	/** errors / (turns + errors) over the window; 0 when no errors recorded. */
	errorRate: number;
	/** Per-class error counts across the window (only classes that occurred). */
	errorCounts: Partial<Record<RoutingErrorClass, number>>;
}

export interface SlowProviderThresholds {
	/** Flag when the median output rate falls below this (tok/s). */
	minTokensPerSecond: number;
	/** Flag when the TTFT p50 rises above this (ms). */
	maxTtftMs: number;
}

export interface FlakyProviderThresholds {
	/** Flag when the window carries at least this many errored turns. */
	minErrors: number;
	/** Flag when the window error rate (errors / total turns) reaches this. */
	minErrorRate: number;
}

/** Bucket for errored turns with no attributable upstream. */
export const UNKNOWN_PROVIDER_SLUG = "unknown";

/** Provider-stream error classes the rolling error channel distinguishes. */
export const ROUTING_ERROR_CLASSES = [
	"stream-stall",
	"truncated-stream",
	"first-event-timeout",
	"network",
	"other",
] as const;
export type RoutingErrorClass = (typeof ROUTING_ERROR_CLASSES)[number];

/** One errored turn's attribution sample. */
export interface RoutingErrorSample {
	class: RoutingErrorClass;
}

/** Singular class labels for the flaky notice; pluralized by appending "s". Also the class-membership table. */
const ERROR_CLASS_LABELS: Record<RoutingErrorClass, string> = {
	"stream-stall": "stream stall",
	"truncated-stream": "truncated stream",
	"first-event-timeout": "first-event timeout",
	network: "network error",
	other: "error",
};

const NETWORK_ERROR_RE =
	/network connection lost|fetch failed|socket hang up|econnreset|econnrefused|etimedout|connection reset|other side closed|network error/;

/**
 * Classify an errored turn's `errorMessage` into a routing error class, keyed
 * on the exact wordings the pi-ai stream layer emits:
 * - idle-watchdog aborts ("… stream stalled while waiting for the next
 *   event", incl. the generic "Provider stream stalled …" lazy wrapper and
 *   "stream stall" retry wordings) → `stream-stall`;
 * - cold-start watchdog ("… stream timed out while waiting for the first
 *   event") → `first-event-timeout`;
 * - mid-stream transport closes ("… closed before a terminal response event
 *   was received", "… ended without a finish reason (connection dropped or
 *   response truncated)", "stream closed without terminal event") →
 *   `truncated-stream`;
 * - TCP/TLS-level failures (incl. OpenRouter's "server_error: Network
 *   connection lost") → `network`;
 * - everything else (incl. missing messages) → `other`.
 */
export function classifyRoutingError(errorMessage: string | undefined): RoutingErrorClass {
	if (!errorMessage) return "other";
	const message = errorMessage.toLowerCase();
	if (message.includes("stalled while waiting for the next event") || message.includes("stream stall")) {
		return "stream-stall";
	}
	if (message.includes("timed out while waiting for the first event")) return "first-event-timeout";
	if (
		message.includes("closed before a terminal") ||
		message.includes("without a finish reason") ||
		message.includes("without terminal event") ||
		message.includes("truncat")
	) {
		return "truncated-stream";
	}
	if (NETWORK_ERROR_RE.test(message)) return "network";
	return "other";
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

/** Most frequent error class in the counts map, in stable class-declaration order. */
function dominantErrorClass(counts: Partial<Record<RoutingErrorClass, number>>): RoutingErrorClass | undefined {
	let best: RoutingErrorClass | undefined;
	let bestCount = 0;
	for (const errorClass of ROUTING_ERROR_CLASSES) {
		const count = counts[errorClass] ?? 0;
		if (count > bestCount) {
			best = errorClass;
			bestCount = count;
		}
	}
	return best;
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
	providers: Record<string, { samples: RoutingTurnSample[]; errors?: RoutingErrorSample[] }>;
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

function parsePersistedErrors(raw: unknown): RoutingErrorSample[] {
	if (!Array.isArray(raw)) return [];
	const errors: RoutingErrorSample[] = [];
	for (const entry of raw) {
		// Accept the `{ class }` sample shape and bare class strings.
		const errorClass = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>).class : entry;
		if (typeof errorClass !== "string" || !(errorClass in ERROR_CLASS_LABELS)) continue;
		errors.push({ class: errorClass as RoutingErrorClass });
	}
	return errors;
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
	readonly #errors = new Map<string, RoutingErrorSample[]>();
	#hydrated: Promise<void>;
	#saveTimer: NodeJS.Timeout | undefined;
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

	/** Record one errored turn for `slug` and schedule a throttled persist. */
	recordError(slug: string, errorClass: RoutingErrorClass): void {
		if (!slug) return;
		const errors = this.#errors.get(slug) ?? [];
		errors.push({ class: errorClass });
		if (errors.length > this.#window) errors.splice(0, errors.length - this.#window);
		this.#errors.set(slug, errors);
		this.#scheduleSave();
	}

	/** Rolling summary for one slug; `undefined` when no turns are recorded. */
	getSummary(slug: string): RoutingProviderSummary | undefined {
		const samples = this.#samples.get(slug) ?? [];
		const errors = this.#errors.get(slug) ?? [];
		if (samples.length === 0 && errors.length === 0) return undefined;
		return this.#summarize(slug, samples, errors);
	}

	/** Rolling summaries for every tracked slug, sorted by slug. */
	summaries(): RoutingProviderSummary[] {
		return [...new Set([...this.#samples.keys(), ...this.#errors.keys()])]
			.map(slug => this.#summarize(slug, this.#samples.get(slug) ?? [], this.#errors.get(slug) ?? []))
			.filter(summary => summary.turns > 0 || summary.errors > 0)
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
		// Per-metric floors: each median runs over only the turns that reported
		// that metric, and a one-sample "median" IS that sample — one outlier
		// turn must not trip the ban-suggestion notice.
		const samples = this.#samples.get(slug) ?? [];
		const tpsSamples = samples.filter(sample => sample.tokensPerSecond !== undefined).length;
		const ttftSamples = samples.filter(sample => sample.ttftMs !== undefined).length;
		if (
			tpsSamples >= ROUTING_STATS_MIN_METRIC_SAMPLES &&
			summary.medianTokensPerSecond !== undefined &&
			summary.medianTokensPerSecond < thresholds.minTokensPerSecond
		) {
			return `${summary.medianTokensPerSecond.toFixed(1)} tok/s median`;
		}
		if (
			ttftSamples >= ROUTING_STATS_MIN_METRIC_SAMPLES &&
			summary.ttftP50Ms !== undefined &&
			summary.ttftP50Ms > thresholds.maxTtftMs
		) {
			return `ttft p50 ${(summary.ttftP50Ms / 1000).toFixed(1)}s`;
		}
		return undefined;
	}

	/**
	 * Flaky verdict for one slug: at least `minErrors` errored turns in the
	 * window AND an error rate (errors / total turns) at `minErrorRate`.
	 */
	isFlaky(slug: string, thresholds: FlakyProviderThresholds): boolean {
		return this.flakyReason(slug, thresholds) !== undefined;
	}

	/** Human-readable flaky reason ("3 stream stalls in 10 turns"), if flaky. */
	flakyReason(slug: string, thresholds: FlakyProviderThresholds): string | undefined {
		const summary = this.getSummary(slug);
		if (!summary || summary.errors < thresholds.minErrors) return undefined;
		if (summary.errorRate < thresholds.minErrorRate) return undefined;
		const dominant = dominantErrorClass(summary.errorCounts);
		if (!dominant) return undefined;
		const count = summary.errorCounts[dominant] ?? summary.errors;
		const label = ERROR_CLASS_LABELS[dominant];
		return `${count} ${count === 1 ? label : `${label}s`} in ${summary.turns + summary.errors} turns`;
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

	#summarize(
		slug: string,
		samples: readonly RoutingTurnSample[],
		errors: readonly RoutingErrorSample[],
	): RoutingProviderSummary {
		const errorCounts: Partial<Record<RoutingErrorClass, number>> = {};
		for (const sample of errors) {
			errorCounts[sample.class] = (errorCounts[sample.class] ?? 0) + 1;
		}
		return {
			slug,
			turns: samples.length,
			medianTokensPerSecond: median(samples.map(s => s.tokensPerSecond).filter((v): v is number => v !== undefined)),
			ttftP50Ms: median(samples.map(s => s.ttftMs).filter((v): v is number => v !== undefined)),
			errors: errors.length,
			errorRate: errors.length === 0 ? 0 : errors.length / (samples.length + errors.length),
			errorCounts,
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
				if (!this.#samples.has(slug)) {
					// in-memory turns are newer
					const samples = parsePersistedSamples(entry?.samples).slice(-this.#window);
					if (samples.length > 0) this.#samples.set(slug, samples);
				}
				if (!this.#errors.has(slug)) {
					const errors = parsePersistedErrors(entry?.errors).slice(-this.#window);
					if (errors.length > 0) this.#errors.set(slug, errors);
				}
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
				[...new Set([...this.#samples.keys(), ...this.#errors.keys()])].map(slug => [
					slug,
					{ samples: [...(this.#samples.get(slug) ?? [])], errors: [...(this.#errors.get(slug) ?? [])] },
				]),
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
	return hasOpenRouterGenerationId(message);
}

/** Structural slice of an errored assistant message the error recorder reads. */
export interface RoutingErrorMessageSlice {
	upstreamProvider?: string;
	responseId?: string;
	provider?: string;
	stopReason: string;
	errorMessage?: string;
}

function hasOpenRouterGenerationId(message: {
	upstreamProvider?: string;
	responseId?: string;
	provider?: string;
}): boolean {
	if (message.upstreamProvider) return false;
	return (
		message.provider === "openrouter" &&
		typeof message.responseId === "string" &&
		message.responseId.startsWith("gen-")
	);
}

/**
 * Extract the recordable error sample from a failed assistant message.
 * Returns `undefined` for non-error turns. Turns without upstream attribution
 * fall back to the explicit {@link UNKNOWN_PROVIDER_SLUG} bucket so they
 * never poison a real slug's stats; callers with a `gen-…` id should prefer
 * the generation-endpoint backfill ({@link isOpenRouterErrorBackfillCandidate})
 * and only record the unknown bucket when attribution resolves to nothing.
 */
export function routingErrorFromMessage(
	message: RoutingErrorMessageSlice,
): { slug: string; sample: RoutingErrorSample } | undefined {
	if (message.stopReason !== "error") return undefined;
	return {
		slug: message.upstreamProvider ?? UNKNOWN_PROVIDER_SLUG,
		sample: { class: classifyRoutingError(message.errorMessage) },
	};
}

/**
 * Whether an errored OpenRouter turn is worth a generation-endpoint backfill:
 * the stream died before naming an upstream but left a `gen-…` id.
 */
export function isOpenRouterErrorBackfillCandidate(message: RoutingErrorMessageSlice): boolean {
	if (message.stopReason !== "error") return false;
	return hasOpenRouterGenerationId(message);
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

/**
 * Session-scoped dedup for the slow/flaky-upstream notices: each fires at
 * most once per slug, pointing the operator at `/provider ignore`.
 */
export class ProviderHealthNotifier {
	readonly #notifiedSlow = new Set<string>();
	readonly #notifiedFlaky = new Set<string>();

	/**
	 * Return the slow notice when `slug` newly qualifies; `undefined` when the
	 * slug is fast, has too few turns, or was already flagged this session.
	 */
	maybeNotifySlow(tracker: RoutingStatsTracker, slug: string, thresholds: SlowProviderThresholds): string | undefined {
		if (this.#notifiedSlow.has(slug)) return undefined;
		const reason = tracker.slowReason(slug, thresholds);
		if (!reason) return undefined;
		this.#notifiedSlow.add(slug);
		return `${slug} slow (${reason}) — /provider ignore ${slug} to ban`;
	}

	/**
	 * Return the flaky notice when `slug` newly qualifies; `undefined` when
	 * the slug is below the error thresholds or was already flagged this
	 * session. The {@link UNKNOWN_PROVIDER_SLUG} bucket never notifies — it
	 * names no ban-able upstream.
	 */
	maybeNotifyFlaky(
		tracker: RoutingStatsTracker,
		slug: string,
		thresholds: FlakyProviderThresholds,
	): string | undefined {
		if (slug === UNKNOWN_PROVIDER_SLUG) return undefined;
		if (this.#notifiedFlaky.has(slug)) return undefined;
		const reason = tracker.flakyReason(slug, thresholds);
		if (!reason) return undefined;
		this.#notifiedFlaky.add(slug);
		return `${slug} erroring (${reason}) — /provider ignore ${slug} to ban`;
	}

	/** Forget a flagged slug (e.g. after /provider unignore) within this session. */
	reset(slug?: string): void {
		if (slug === undefined) {
			this.#notifiedSlow.clear();
			this.#notifiedFlaky.clear();
		} else {
			this.#notifiedSlow.delete(slug);
			this.#notifiedFlaky.delete(slug);
		}
	}
}
