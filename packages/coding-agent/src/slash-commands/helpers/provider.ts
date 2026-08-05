/**
 * `/provider` command logic: rolling per-upstream OpenRouter stats table plus
 * ignore-list management. Shared by the TUI (`handleTui`) and ACP/headless
 * (`handle`) dispatchers so both render the same text.
 *
 * The table joins the local rolling stats (routing-stats.ts — the live
 * detection source) with OpenRouter-reported per-endpoint perf
 * (openrouter-endpoint-stats.ts), fetched lazily here behind a short cache —
 * never per turn.
 */

import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { Settings } from "../../config/settings";
import type { AgentSession } from "../../session/agent-session";
import {
	type OpenRouterEndpointPerf,
	type OpenRouterEndpointStatsCache,
	openRouterEndpointStatsCache,
} from "../../session/openrouter-endpoint-stats";
import { getRoutingStatsTracker, type RoutingStatsTracker } from "../../session/routing-stats";
import { replaceTabs, truncateToWidth } from "../../tools/render-utils";

const USAGE = "Usage: /provider [ignore <slug>|unignore <slug>]";
const SLUG_COLUMN_WIDTH = 28;

/**
 * Slugs are persisted to config.yml and forwarded to OpenRouter in every
 * request body, and rendered back in the table/slow-notice. Restrict them to
 * the endpoint-tag charset (regional tags carry a `/`, e.g.
 * `google-vertex/europe`) so control bytes, quotes, and YAML indicators can
 * never reach the config file or the terminal.
 */
const SLUG_RE = /^[a-z0-9][a-z0-9._/-]*$/i;

export interface ProviderCommandDeps {
	settings: Settings;
	session: AgentSession;
	/** Stats source; defaults to the process-wide tracker. */
	tracker?: RoutingStatsTracker;
	/** Endpoint-perf cache; defaults to the shared 60s cache. */
	endpointCache?: OpenRouterEndpointStatsCache;
	/** Fetch override for tests. */
	fetchImpl?: typeof fetch;
}

function sanitizeSlug(slug: string): string {
	return truncateToWidth(replaceTabs(sanitizeText(slug)), SLUG_COLUMN_WIDTH);
}

function formatTokensPerSecond(value: number | undefined): string {
	return value === undefined ? "-" : value.toFixed(1);
}

function formatMs(value: number | undefined): string {
	if (value === undefined) return "-";
	return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${Math.round(value)}ms`;
}

function isOpenRouterSessionModel(session: AgentSession): string | undefined {
	const model = session.model;
	if (!model) return undefined;
	const compat = model.compat as { isOpenRouterHost?: boolean } | undefined;
	if (model.provider === "openrouter" || compat?.isOpenRouterHost === true) return model.id;
	return undefined;
}

function indexEndpointPerf(perf: readonly OpenRouterEndpointPerf[]): Map<string, OpenRouterEndpointPerf> {
	const index = new Map<string, OpenRouterEndpointPerf>();
	for (const entry of perf) {
		index.set(entry.tag.toLowerCase(), entry);
		index.set(entry.providerName.toLowerCase(), entry);
	}
	return index;
}

async function buildProviderTable(deps: ProviderCommandDeps): Promise<string> {
	const tracker = deps.tracker ?? getRoutingStatsTracker();
	const settings = deps.settings;
	const ignore = settings.get("providers.openrouter.ignore");
	const only = settings.get("providers.openrouter.only");
	const order = settings.get("providers.openrouter.order");
	const sort = settings.get("providers.openrouter.sort");

	const lines: string[] = [];
	const routingParts: string[] = [];
	if (sort) routingParts.push(`sort=${sort}`);
	if (only.length > 0) routingParts.push(`only=${only.join(",")}`);
	if (order.length > 0) routingParts.push(`order=${order.join(",")}`);
	if (ignore.length > 0) routingParts.push(`ignore=${ignore.join(",")}`);
	lines.push(routingParts.length > 0 ? `Routing: ${routingParts.join(" ")}` : "Routing: OpenRouter default");

	// OpenRouter-reported per-endpoint perf, lazily fetched for the current
	// model only. Failures degrade the OR columns to "-" with a note.
	let endpointIndex: Map<string, OpenRouterEndpointPerf> | undefined;
	const openRouterModelId = isOpenRouterSessionModel(deps.session);
	let endpointNote: string | undefined;
	if (openRouterModelId) {
		try {
			const cache = deps.endpointCache ?? openRouterEndpointStatsCache;
			endpointIndex = indexEndpointPerf(await cache.get(openRouterModelId, { fetchImpl: deps.fetchImpl }));
		} catch (error) {
			endpointNote = `OpenRouter endpoint stats unavailable: ${error instanceof Error ? error.message : String(error)}`;
		}
	}

	const summaries = tracker.summaries();
	const ignoredWithoutStats = ignore.filter(slug => !summaries.some(summary => summary.slug === slug));
	if (summaries.length === 0 && ignoredWithoutStats.length === 0) {
		lines.push("No upstream provider turns recorded yet.");
	} else {
		const header = `${"slug".padEnd(SLUG_COLUMN_WIDTH)}  turns  errs  err rate  tok/s med  ttft p50  OR tok/s  OR lat p50  flags`;
		lines.push(header);
		for (const summary of summaries) {
			const remote = endpointIndex?.get(summary.slug.toLowerCase());
			const flags = ignore.includes(summary.slug) ? "ignored" : "";
			const errs = summary.errors > 0 ? String(summary.errors) : "-";
			const errRate = summary.errors > 0 ? `${Math.round(summary.errorRate * 100)}%` : "-";
			lines.push(
				`${sanitizeSlug(summary.slug).padEnd(SLUG_COLUMN_WIDTH)}  ${String(summary.turns).padStart(5)}  ${errs.padStart(4)}  ${errRate.padStart(8)}  ${formatTokensPerSecond(summary.medianTokensPerSecond).padStart(9)}  ${formatMs(summary.ttftP50Ms).padStart(8)}  ${formatTokensPerSecond(remote?.throughputP50).padStart(8)}  ${formatMs(remote?.latencyP50Ms).padStart(10)}  ${flags}`,
			);
		}
		for (const slug of ignoredWithoutStats) {
			lines.push(
				`${sanitizeSlug(slug).padEnd(SLUG_COLUMN_WIDTH)}  ${"-".padStart(5)}  ${"-".padStart(4)}  ${"-".padStart(8)}  ${"-".padStart(9)}  ${"-".padStart(8)}  ${"-".padStart(8)}  ${"-".padStart(10)}  ignored`,
			);
		}
	}
	if (endpointNote) lines.push(endpointNote);
	return lines.join("\n");
}

/**
 * Run the `/provider` command. Returns the operator-facing text (table,
 * confirmation, or usage).
 */
export async function runProviderCommand(args: string, deps: ProviderCommandDeps): Promise<string> {
	const trimmed = args.trim();
	if (!trimmed) return buildProviderTable(deps);

	const [verb, ...rest] = trimmed.split(/\s+/);
	const slug = rest.join(" ").trim();
	if ((verb === "ignore" || verb === "unignore") && !slug) return USAGE;
	if (verb !== "ignore" && verb !== "unignore") return USAGE;
	if (!SLUG_RE.test(slug)) return USAGE;

	const settings = deps.settings;
	const current = settings.get("providers.openrouter.ignore");
	if (verb === "ignore") {
		if (current.includes(slug)) return `${slug} is already ignored.`;
		settings.set("providers.openrouter.ignore", [...current, slug]);
		await settings.flush();
		return `Ignoring ${sanitizeSlug(slug)} — OpenRouter will skip it on the next request. /provider unignore ${sanitizeSlug(slug)} to undo.`;
	}
	if (!current.includes(slug)) return `${slug} is not in the ignore list.`;
	settings.set(
		"providers.openrouter.ignore",
		current.filter(entry => entry !== slug),
	);
	await settings.flush();
	return `Removed ${sanitizeSlug(slug)} from the ignore list — effective on the next request.`;
}
