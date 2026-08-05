/**
 * Swarm ensemble for tiny-model utility calls (titles, classifiers, memory).
 *
 * Instead of one handicapped utility call (reasoning disabled, tiny maxTokens
 * cap — a combination that empirically returns empty content 50–100% of the
 * time on reasoning models such as deepseek-v4-flash-0731), the swarm fires N
 * IDENTICAL full-strength {@link completeSimple} calls in parallel: same model,
 * same full untruncated context, reasoning enabled at the model's highest
 * supported effort, and NO output-token cap (on OpenRouter the field is omitted
 * entirely so each upstream self-caps; elsewhere it defaults to the model's
 * catalog completion window — see `mapOptionsForApi`/`resolveOpenAIOutputTokenParam`
 * in pi-ai). No per-member variation: every member is the same request.
 *
 * The ensemble resolves as soon as a quorum of non-empty answers arrives
 * (plus a short grace window for stragglers, then pending members are
 * cancelled). When the timeout fires before quorum, ONE direct full-strength
 * fallback call runs with identical options. Synthesis modes:
 *
 * - `vote`: majority after trim/case normalization; ties break to the
 *   earliest-arriving answer. For classifier-shaped outputs (yes/no, a level
 *   keyword, a `<title>` marker).
 * - `merge`: one full-strength synthesizer call (reasoning on, uncapped) sees
 *   the original context plus all candidate answers and emits the final
 *   answer; on synthesizer failure the earliest member answer wins. For
 *   long-form outputs (memory extraction/consolidation).
 *
 * Every settled member, synthesizer, and fallback response is reported through
 * `recordUsage` so swarm burn is metered exactly like a session turn's.
 */
import {
	type Api,
	type AssistantMessage,
	type Context,
	completeSimple,
	type Effort,
	type Model,
	type SimpleStreamOptions,
	THINKING_EFFORTS,
} from "@oh-my-pi/pi-ai";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { logger } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";

export const SWARM_DEFAULT_MEMBERS = 3;
export const SWARM_DEFAULT_QUORUM = 2;
export const SWARM_DEFAULT_TIMEOUT_MS = 15_000;
/** Post-quorum wait for stragglers before pending members are cancelled. */
export const SWARM_DEFAULT_GRACE_MS = 250;
/** Config escape hatches stay inside sane swarm bounds. */
const SWARM_MAX_MEMBERS = 32;
const SWARM_MIN_TIMEOUT_MS = 100;
const SWARM_MAX_TIMEOUT_MS = 600_000;

/** Extra wall-clock the fallback phase may need beyond the member phase. */
const SWARM_FALLBACK_MARGIN_MS = 1_000;

/**
 * Merge-mode instruction appended (with the candidate answers) as a trailing
 * user message on the ORIGINAL context, so the synthesizer sees exactly what
 * the members saw plus their outputs. Short-output by instruction, not by
 * token cap.
 */
const SWARM_MERGE_INSTRUCTION =
	"The candidate answers above were produced by independent runs of the same request. " +
	"Reconcile them into the single best final answer and reply with ONLY that final answer — no explanation, no preamble, no candidate list.";

/** Sites that may adopt the swarm; per-site defaults live in {@link resolveSwarmConfig}. */
export type SwarmSite = "autoThinking" | "mnemopi" | "title" | "unexpectedStop";

export interface SwarmConfig {
	enabled: boolean;
	members: number;
	quorum: number;
	timeoutMs: number;
	graceMs: number;
}

/**
 * Resolve the effective swarm config for one consumer site. `swarm.enabled` is
 * the master switch (schema default on); the mnemopi memory path additionally
 * requires `swarm.mnemopi` (schema default off — long-form memory outputs are
 * not voteable and consolidation is background batch work where the 3×
 * billing multiplier buys no accuracy over one full-strength call).
 *
 * The enabled flags use `=== true` (not `?? default`): a real Settings always
 * returns the schema default, while hand-rolled settings fakes (tests,
 * extensions) that predate the swarm keys return `undefined` and must get the
 * conservative legacy single-call path rather than an unexpected 3× fan-out.
 */
export function resolveSwarmConfig(settings: Settings, site: SwarmSite): SwarmConfig {
	const members = clampInt(settings.get("swarm.members") ?? SWARM_DEFAULT_MEMBERS, 1, SWARM_MAX_MEMBERS);
	const quorum = clampInt(settings.get("swarm.quorum") ?? SWARM_DEFAULT_QUORUM, 1, members);
	const timeoutMs = clampInt(
		settings.get("swarm.timeoutMs") ?? SWARM_DEFAULT_TIMEOUT_MS,
		SWARM_MIN_TIMEOUT_MS,
		SWARM_MAX_TIMEOUT_MS,
	);
	const masterEnabled = settings.get("swarm.enabled") === true;
	const siteEnabled = site !== "mnemopi" || settings.get("swarm.mnemopi") === true;
	return { enabled: masterEnabled && siteEnabled, members, quorum, timeoutMs, graceMs: SWARM_DEFAULT_GRACE_MS };
}

/**
 * Wall-clock budget a caller should allow around one {@link completeEnsemble}
 * run: the member phase (up to `timeoutMs`), the grace window, then one
 * full-strength fallback phase (bounded by a second `timeoutMs`) plus margin.
 */
export function swarmCallerBudgetMs(config: SwarmConfig): number {
	return config.timeoutMs * 2 + config.graceMs + SWARM_FALLBACK_MARGIN_MS;
}

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Highest effort the model advertises, ranked by the canonical THINKING_EFFORTS
 * ladder (catalog `thinking.efforts` order is not guaranteed ascending).
 * Undefined when the model has no controllable effort surface.
 */
function highestSupportedEffort(model: Model<Api>): Effort | undefined {
	let best: Effort | undefined;
	let bestRank = -1;
	for (const effort of getSupportedEfforts(model)) {
		const rank = THINKING_EFFORTS.indexOf(effort);
		if (rank > bestRank) {
			best = effort;
			bestRank = rank;
		}
	}
	return best;
}

/**
 * Full-strength member options: the caller's base options with every
 * handicapping knob stripped — no `maxTokens` (uncapped; the wire field is
 * omitted on OpenRouter, the model's catalog completion window elsewhere), no
 * `disableReasoning`, no custom thinking budgets — and reasoning pinned to the
 * model's highest supported effort. Identical for every member by
 * construction.
 */
function buildMemberOptions(
	model: Model<Api>,
	base: SimpleStreamOptions | undefined,
	signal: AbortSignal | undefined,
): SimpleStreamOptions {
	const options: SimpleStreamOptions = { ...(base ?? {}), signal };
	delete options.maxTokens;
	delete options.disableReasoning;
	delete options.thinkingBudgets;
	const effort = highestSupportedEffort(model);
	if (effort === undefined) {
		delete options.reasoning;
	} else {
		options.reasoning = effort;
	}
	return options;
}

/** Usable member output: text content with non-whitespace, not an error/abort. */
function ensembleText(message: AssistantMessage): string | undefined {
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	let text = "";
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
	}
	const trimmed = text.trim();
	return trimmed === "" ? undefined : trimmed;
}

interface MemberArrival {
	/** Launch index (stable identity, not arrival order). */
	index: number;
	message: AssistantMessage;
	/** Trimmed text used for vote keys and merge candidates. */
	text: string;
}

export interface EnsembleRequest {
	model: Model<Api>;
	/** Full, untruncated context — the model's own window is the only ceiling. */
	context: Context;
	/**
	 * Base per-call options (apiKey resolver, metadata, temperature, …). The
	 * ensemble owns `signal`, `maxTokens`, `disableReasoning`, `thinkingBudgets`,
	 * and `reasoning`; caller values for those are overridden.
	 */
	options?: SimpleStreamOptions;
}

export interface CompleteEnsembleOptions {
	/** Parallel member count. Default {@link SWARM_DEFAULT_MEMBERS}. */
	members?: number;
	/** Non-empty answers required to proceed. Default {@link SWARM_DEFAULT_QUORUM}. */
	quorum?: number;
	/** Member-phase wall-clock bound. Default {@link SWARM_DEFAULT_TIMEOUT_MS}. */
	timeoutMs?: number;
	/** Post-quorum straggler window before pending members are cancelled. */
	graceMs?: number;
	synthesize: "merge" | "vote";
	/** External cancellation; aborts every member and short-circuits waits. */
	signal?: AbortSignal;
	/** Metering hook fired for every settled member/synthesizer/fallback response. */
	recordUsage?: (message: AssistantMessage) => void;
}

/**
 * Run the swarm. Resolves with the winning/synthesized/fallback
 * {@link AssistantMessage} — the same shape consumers already handle from a
 * direct {@link completeSimple} call. Never rejects for member failures
 * (quorum/timeout machinery absorbs them); rejects only when the fallback
 * itself throws, matching direct-call behavior.
 */
export async function completeEnsemble(
	request: EnsembleRequest,
	options: CompleteEnsembleOptions,
): Promise<AssistantMessage> {
	const members = clampInt(options.members ?? SWARM_DEFAULT_MEMBERS, 1, SWARM_MAX_MEMBERS);
	const quorum = Math.min(members, Math.max(1, Math.floor(options.quorum ?? SWARM_DEFAULT_QUORUM)));
	const timeoutMs = Math.max(SWARM_MIN_TIMEOUT_MS, options.timeoutMs ?? SWARM_DEFAULT_TIMEOUT_MS);
	const graceMs = Math.max(0, options.graceMs ?? SWARM_DEFAULT_GRACE_MS);
	const externalSignal = options.signal;

	// Internal cancellation: post-quorum/post-timeout member teardown. External
	// aborts forward here so pending members die with the caller.
	const controller = new AbortController();
	if (externalSignal !== undefined) {
		if (externalSignal.aborted) {
			controller.abort(externalSignal.reason);
		} else {
			externalSignal.addEventListener("abort", () => controller.abort(externalSignal.reason), { once: true });
		}
	}

	const memberOptions = buildMemberOptions(request.model, request.options, controller.signal);
	const arrivals: MemberArrival[] = [];
	let settledCount = 0;
	let notify: (() => void) | undefined;
	const poke = (): void => {
		notify?.();
	};
	const nextSettle = (): Promise<void> =>
		new Promise<void>(resolve => {
			notify = resolve;
		});

	// Fire-and-forget with per-member handlers: late settlements (aborted
	// stragglers) still get metered and never surface as unhandled rejections.
	for (let index = 0; index < members; index += 1) {
		void completeSimple(request.model, request.context, memberOptions).then(
			message => {
				settledCount += 1;
				options.recordUsage?.(message);
				const text = ensembleText(message);
				if (text !== undefined) arrivals.push({ index, message, text });
				poke();
			},
			(error: unknown) => {
				settledCount += 1;
				logger.debug("swarm: member call failed", {
					index,
					error: error instanceof Error ? error.message : String(error),
				});
				poke();
			},
		);
	}

	// Member phase: wait for quorum, all-settled, or timeout. When every member
	// settled without reaching quorum there is nothing left to wait for — fall
	// through to the fallback immediately rather than burning the full timeout.
	const deadline = Date.now() + timeoutMs;
	while (arrivals.length < quorum && settledCount < members) {
		const remaining = deadline - Date.now();
		if (remaining <= 0) break;
		await Promise.race([nextSettle(), Bun.sleep(remaining)]);
	}

	if (arrivals.length >= quorum) {
		// Grace window for stragglers, then cancel whatever is still pending.
		if (settledCount < members && graceMs > 0) {
			const graceDeadline = Date.now() + graceMs;
			while (settledCount < members) {
				const remaining = graceDeadline - Date.now();
				if (remaining <= 0) break;
				await Promise.race([nextSettle(), Bun.sleep(remaining)]);
			}
		}
		controller.abort("swarm: quorum reached");
		logger.debug("swarm: quorum reached", {
			members,
			quorum,
			arrived: arrivals.length,
			settled: settledCount,
			synthesize: options.synthesize,
		});
		return options.synthesize === "merge"
			? synthesizeMerge(request, memberOptions, externalSignal, arrivals, options.recordUsage)
			: voteArrivals(arrivals);
	}

	// Timeout (or total member failure) before quorum: cancel stragglers and run
	// ONE direct full-strength fallback with identical options, wired only to the
	// caller's signal.
	controller.abort("swarm: quorum timeout");
	logger.debug("swarm: quorum not reached; running direct fallback", {
		members,
		quorum,
		arrived: arrivals.length,
		settled: settledCount,
	});
	const fallback = await completeSimple(request.model, request.context, {
		...memberOptions,
		signal: externalSignal,
	});
	options.recordUsage?.(fallback);
	return fallback;
}

/**
 * Majority vote after trim/case normalization. Ties break to the
 * earliest-arriving answer: `arrivals` is in arrival order and Map iteration
 * follows first-seen key order, so the first group with the highest count is
 * the one whose member arrived earliest. Returns the earliest member message
 * of the winning group verbatim.
 */
function voteArrivals(arrivals: MemberArrival[]): AssistantMessage {
	const groups = new Map<string, MemberArrival[]>();
	for (const arrival of arrivals) {
		const key = arrival.text.toLowerCase();
		const group = groups.get(key);
		if (group === undefined) {
			groups.set(key, [arrival]);
		} else {
			group.push(arrival);
		}
	}
	let winner: MemberArrival[] | undefined;
	for (const group of groups.values()) {
		if (winner === undefined || group.length > winner.length) winner = group;
	}
	return (winner ?? arrivals)[0].message;
}

/**
 * Merge synthesis: one full-strength call (reasoning on, uncapped) on the
 * original context plus the candidate answers and a short-output instruction.
 * Any synthesizer failure — error/empty output or a thrown call — falls back
 * to the earliest member answer.
 */
async function synthesizeMerge(
	request: EnsembleRequest,
	memberOptions: SimpleStreamOptions,
	externalSignal: AbortSignal | undefined,
	arrivals: MemberArrival[],
	recordUsage: ((message: AssistantMessage) => void) | undefined,
): Promise<AssistantMessage> {
	const earliest = arrivals[0].message;
	const candidates = arrivals.map((arrival, position) => `${position + 1}) ${arrival.text}`).join("\n");
	const synthContext: Context = {
		...request.context,
		messages: [
			...request.context.messages,
			{
				role: "user",
				content: `Candidate answers:\n${candidates}\n\n${SWARM_MERGE_INSTRUCTION}`,
				timestamp: Date.now(),
			},
		],
	};
	try {
		const synth = await completeSimple(request.model, synthContext, { ...memberOptions, signal: externalSignal });
		recordUsage?.(synth);
		if (ensembleText(synth) === undefined) return earliest;
		return synth;
	} catch (error) {
		logger.debug("swarm: merge synthesizer failed; using earliest member answer", {
			error: error instanceof Error ? error.message : String(error),
		});
		return earliest;
	}
}

/**
 * Wire swarm usage metering to the session's auth storage, mirroring the
 * per-turn recording in agent-session: observed usage always (broker
 * deployments; a no-op on local stores) plus the opencode-go cost record.
 */
export function createEnsembleUsageRecorder(
	registry: ModelRegistry,
	sessionId?: string,
): (message: AssistantMessage) => void {
	return message => {
		try {
			if (message.provider === "opencode-go") {
				registry.authStorage.recordUsageCost(message.provider, message.usage.cost.total, {
					sessionId,
					recordedAt: message.timestamp,
					baseUrl: registry.getProviderBaseUrl?.(message.provider),
				});
			}
			registry.authStorage.recordObservedUsage({
				provider: message.provider,
				model: message.model,
				at: message.timestamp,
				usage: {
					input: message.usage.input,
					output: message.usage.output,
					cacheRead: message.usage.cacheRead,
					cacheWrite: message.usage.cacheWrite,
				},
				costUsd: message.usage.cost.total,
			});
		} catch (error) {
			logger.debug("swarm: usage recording failed", {
				error: error instanceof Error ? error.message : String(error),
			});
		}
	};
}
