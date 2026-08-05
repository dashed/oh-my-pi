/**
 * OpenRouter API enrichment for provider routing control.
 *
 * Two read-only endpoints, both verified against the live API (2026-08):
 *
 *  - `GET /api/v1/models/{modelId}/endpoints` — per-upstream perf telemetry:
 *    `tag` (the slug used in provider.only/order/ignore), `provider_name`,
 *    `latency_last_30m {p50..p99}` (ms), `throughput_last_30m {p50..p99}`
 *    (tok/s), `uptime_last_30m/5m/1d` (%). Public — no auth required. Fields
 *    are null for upstreams with no recent traffic. Fetched LAZILY on
 *    `/provider` invocation behind a short cache; never per turn.
 *    (The `/api/v1/models` list carries no per-provider perf data — only this
 *    per-model endpoints sub-resource does.)
 *
 *  - `GET /api/v1/generation?id=<gen-id>` — authoritative per-turn
 *    attribution (`provider_name`, `latency`, tokens, cost). Account-scoped,
 *    requires the OpenRouter API key. Used to backfill attribution when a
 *    turn's stream never reported `upstreamProvider` but left a `gen-…`
 *    response id.
 *
 * Local rolling stats (routing-stats.ts) remain the live detection source.
 */
import { logger } from "@oh-my-pi/pi-utils";

const OPENROUTER_API_BASE = "https://openrouter.ai/api/v1";
const DEFAULT_CACHE_TTL_MS = 60_000;

/** Per-upstream performance snapshot reported by OpenRouter. */
export interface OpenRouterEndpointPerf {
	/** Upstream slug used in provider.only/order/ignore (endpoint `tag`). */
	tag: string;
	/** Display name (e.g. "Amazon Bedrock"). */
	providerName: string;
	/** p50 latency over the last 30 minutes, ms. */
	latencyP50Ms?: number;
	/** p50 throughput over the last 30 minutes, output tok/s. */
	throughputP50?: number;
	/** Uptime over the last 30 minutes, percent. */
	uptimeLast30m?: number;
}

export interface OpenRouterFetchOptions {
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
}

function percentileP50(raw: unknown): number | undefined {
	if (typeof raw !== "object" || raw === null) return undefined;
	const p50 = (raw as Record<string, unknown>).p50;
	return typeof p50 === "number" && Number.isFinite(p50) ? p50 : undefined;
}

function numberOrUndefined(raw: unknown): number | undefined {
	return typeof raw === "number" && Number.isFinite(raw) ? raw : undefined;
}

/**
 * Strip a routing-variant suffix (`:nitro`, `:floor`, …) from a model id,
 * mirroring `applyOpenRouterRoutingVariant`'s detection: a variant is present
 * when a colon appears after the last `/`.
 */
export function stripOpenRouterVariantSuffix(modelId: string): string {
	const lastSlash = modelId.lastIndexOf("/");
	const lastColon = modelId.lastIndexOf(":");
	return lastColon > lastSlash ? modelId.slice(0, lastColon) : modelId;
}

/** Fetch per-upstream perf for one OpenRouter model. Throws on HTTP/parse failure. */
export async function fetchOpenRouterEndpointPerf(
	modelId: string,
	options: OpenRouterFetchOptions = {},
): Promise<OpenRouterEndpointPerf[]> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const baseId = stripOpenRouterVariantSuffix(modelId);
	// Encode per path segment: a fully-encoded `%2F` 404s on OpenRouter's router.
	const encodedId = baseId.split("/").map(encodeURIComponent).join("/");
	const response = await fetchImpl(`${OPENROUTER_API_BASE}/models/${encodedId}/endpoints`, {
		headers: { Accept: "application/json" },
		signal: options.signal,
	});
	if (!response.ok) {
		throw new Error(`OpenRouter endpoints request failed: HTTP ${response.status}`);
	}
	const json = (await response.json()) as Record<string, unknown>;
	const data = typeof json.data === "object" && json.data !== null ? (json.data as Record<string, unknown>) : {};
	const endpoints = Array.isArray(data.endpoints) ? data.endpoints : [];
	const perf: OpenRouterEndpointPerf[] = [];
	for (const endpoint of endpoints) {
		if (typeof endpoint !== "object" || endpoint === null) continue;
		const record = endpoint as Record<string, unknown>;
		if (typeof record.tag !== "string" || record.tag.length === 0) continue;
		perf.push({
			tag: record.tag,
			providerName: typeof record.provider_name === "string" ? record.provider_name : record.tag,
			latencyP50Ms: percentileP50(record.latency_last_30m),
			throughputP50: percentileP50(record.throughput_last_30m),
			uptimeLast30m: numberOrUndefined(record.uptime_last_30m),
		});
	}
	return perf;
}

/**
 * Short-TTL in-memory cache for endpoint perf. Keyed by model id; failures
 * are not cached so a transient error doesn't blank the table for a minute.
 */
export class OpenRouterEndpointStatsCache {
	readonly #ttlMs: number;
	readonly #now: () => number;
	readonly #entries = new Map<string, { expiresAt: number; value: Promise<OpenRouterEndpointPerf[]> }>();

	constructor(options: { ttlMs?: number; now?: () => number } = {}) {
		this.#ttlMs = options.ttlMs ?? DEFAULT_CACHE_TTL_MS;
		this.#now = options.now ?? Date.now;
	}

	get(modelId: string, options: OpenRouterFetchOptions = {}): Promise<OpenRouterEndpointPerf[]> {
		const key = stripOpenRouterVariantSuffix(modelId);
		const cached = this.#entries.get(key);
		if (cached && cached.expiresAt > this.#now()) return cached.value;
		const value = fetchOpenRouterEndpointPerf(key, options).catch(error => {
			this.#entries.delete(key);
			throw error;
		});
		this.#entries.set(key, { expiresAt: this.#now() + this.#ttlMs, value });
		return value;
	}
}

/** Shared cache for interactive sessions. */
export const openRouterEndpointStatsCache = new OpenRouterEndpointStatsCache();

/**
 * Map a generation-endpoint `provider_name` (a display name like "Amazon
 * Bedrock") to the endpoint `tag` slug the routing prefs/stats keyspace uses.
 * Display names and tags match case-insensitively; the tag itself is also
 * accepted so a tag-shaped attribution round-trips.
 */
export function mapProviderNameToEndpointTag(
	perf: readonly OpenRouterEndpointPerf[],
	providerName: string,
): string | undefined {
	const needle = providerName.trim().toLowerCase();
	if (needle.length === 0) return undefined;
	for (const entry of perf) {
		if (entry.providerName.toLowerCase() === needle || entry.tag.toLowerCase() === needle) return entry.tag;
	}
	return undefined;
}

/**
 * Resolve a generation backfill's display name to the endpoint tag slug for
 * `modelId`, via the (cached) endpoints list. Returns `undefined` — and notes
 * why at debug level — when the name maps to no endpoint: recording the
 * display name itself would poison the tag keyspace with a ban that can never
 * apply (`/provider ignore` matches tags, and spaced names are not even
 * typable).
 */
export async function resolveOpenRouterGenerationTag(
	modelId: string,
	providerName: string,
	options: OpenRouterFetchOptions & { cache?: OpenRouterEndpointStatsCache } = {},
): Promise<string | undefined> {
	const cache = options.cache ?? openRouterEndpointStatsCache;
	let perf: OpenRouterEndpointPerf[];
	try {
		perf = await cache.get(modelId, options);
	} catch (error) {
		logger.debug("OpenRouter generation backfill: endpoint lookup failed, skipping attribution", {
			providerName,
			error: String(error),
		});
		return undefined;
	}
	const tag = mapProviderNameToEndpointTag(perf, providerName);
	if (!tag) {
		logger.debug("OpenRouter generation backfill: provider_name maps to no endpoint tag, skipping attribution", {
			providerName,
		});
	}
	return tag;
}

/**
 * The generation record is eventually consistent: it 404s while the turn is
 * still streaming and for a short window after stream end (observed ~1–2s
 * live, 2026-08), so a single attempt fired at message_end loses the race and
 * attribution silently never lands. Retry only the 404 with a bounded linear
 * backoff; every other failure stays single-shot. The whole backfill runs
 * detached from the turn, so the added latency never blocks the session.
 */
const GENERATION_NOT_FOUND_RETRY_ATTEMPTS = 5;
const GENERATION_NOT_FOUND_RETRY_BASE_DELAY_MS = 500;

/** Resolve `false` when `signal` aborts before `ms` elapse. */
function waitForRetryDelay(ms: number, signal?: AbortSignal): Promise<boolean> {
	if (ms <= 0) return Promise.resolve(!signal?.aborted);
	if (signal?.aborted) return Promise.resolve(false);
	const { promise, resolve } = Promise.withResolvers<boolean>();
	const onAbort = () => {
		clearTimeout(timer);
		resolve(false);
	};
	const timer = setTimeout(() => {
		signal?.removeEventListener("abort", onAbort);
		resolve(true);
	}, ms);
	timer.unref?.();
	signal?.addEventListener("abort", onAbort, { once: true });
	return promise;
}

/**
 * Authoritative upstream attribution for one generation, via the
 * account-scoped generation endpoint. Returns the provider display name
 * (e.g. "DigitalOcean") or `undefined` on any failure — backfill is
 * best-effort and must never break a turn.
 */
export async function fetchOpenRouterGenerationProvider(
	generationId: string,
	options: OpenRouterFetchOptions & {
		apiKey: string;
		/** 404-retry tuning for the eventually-consistent record; defaults cover the observed post-turn lag. */
		notFoundRetry?: { attempts?: number; baseDelayMs?: number };
	},
): Promise<string | undefined> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const maxAttempts = Math.max(1, Math.floor(options.notFoundRetry?.attempts ?? GENERATION_NOT_FOUND_RETRY_ATTEMPTS));
	const baseDelayMs = Math.max(0, options.notFoundRetry?.baseDelayMs ?? GENERATION_NOT_FOUND_RETRY_BASE_DELAY_MS);
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		try {
			const response = await fetchImpl(`${OPENROUTER_API_BASE}/generation?id=${encodeURIComponent(generationId)}`, {
				headers: { Accept: "application/json", Authorization: `Bearer ${options.apiKey}` },
				signal: options.signal,
			});
			if (response.status === 404 && attempt < maxAttempts) {
				if (!(await waitForRetryDelay(attempt * baseDelayMs, options.signal))) return undefined;
				continue;
			}
			if (!response.ok) return undefined;
			const json = (await response.json()) as Record<string, unknown>;
			const data = typeof json.data === "object" && json.data !== null ? (json.data as Record<string, unknown>) : {};
			if (typeof data.provider_name === "string" && data.provider_name.length > 0) return data.provider_name;
			const providerResponses = Array.isArray(data.provider_responses) ? data.provider_responses : [];
			for (const entry of providerResponses) {
				if (typeof entry !== "object" || entry === null) continue;
				const name = (entry as Record<string, unknown>).provider_name;
				if (typeof name === "string" && name.length > 0) return name;
			}
			return undefined;
		} catch (error) {
			logger.debug("OpenRouter generation backfill failed", { generationId, error: String(error) });
			return undefined;
		}
	}
	return undefined;
}
