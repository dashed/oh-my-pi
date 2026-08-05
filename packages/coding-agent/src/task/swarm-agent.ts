/**
 * Swarm subagent mode for the task tool: `agent: "swarm"` fans ONE assignment
 * out to N identical full-strength member subagents (the session's default
 * worker agent — same model/effort as a normal `task` spawn, no per-member
 * variation), waits for the first quorum of successful completions, cancels
 * the stragglers after a short grace window, and synthesizes the members'
 * outputs into a single result with one merge call (task role model,
 * reasoning on, uncapped — same posture as the tiny-model ensemble in
 * swarm/ensemble.ts). When quorum never arrives, ONE direct full-strength
 * fallback member runs; when the merge call fails, the earliest completed
 * member's output wins.
 *
 * Members are real subagent spawns ({@link runStructuredSubagent}): they
 * register in the AgentRegistry, stream progress, and record usage exactly
 * like any other task child. They carry a `swarm i/N` grouping label as their
 * description and are barred from spawning swarms themselves (`disableAgents`)
 * so a swarm can never multiply into swarms of swarms.
 */
import { type Api, type AssistantMessage, type Context, completeSimple, type Model, type Usage } from "@oh-my-pi/pi-ai";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import { resolveRoleSelection } from "../config/model-resolver";
import subagentUserPromptTemplate from "../prompts/system/subagent-user-prompt.md" with { type: "text" };
import swarmMergePrompt from "../prompts/tools/swarm-merge.md" with { type: "text" };
import {
	createEnsembleUsageRecorder,
	createPhaseSignal,
	highestSupportedEffort,
	SWARM_DEFAULT_GRACE_MS,
	SWARM_DEFAULT_MEMBERS,
	SWARM_DEFAULT_QUORUM,
} from "../swarm/ensemble";
import type { TaskEffort } from "../thinking";
import type { ToolSession } from "../tools";
import { generateTaskName } from "./name-generator";
import { AgentOutputManager } from "./output-manager";
import { runStructuredSubagent, type StructuredSubagentResult } from "./structured-subagent";
import {
	type AgentProgress,
	type AgentSource,
	addUsageTotals,
	createUsageTotals,
	oneLineLabel,
	type SingleResult,
	type SwarmMemberStatus,
	type SwarmMemberSummary,
	type SwarmRunSummary,
	type SwarmSynthesis,
} from "./types";

/** Agent type that routes a task spawn through {@link runSwarmAgent}. */
export const SWARM_AGENT_NAME = "swarm";

/** Member cap mirrors the tiny-model ensemble's bound. */
const SWARM_AGENT_MAX_MEMBERS = 32;
/**
 * Floor for the merge-call deadline: unlike the tiny-model ensemble's 15s
 * utility-call budget, synthesis here reconciles full subagent reports with
 * reasoning on, which routinely outlasts the raw `swarm.timeoutMs` default.
 */
const SWARM_MERGE_MIN_TIMEOUT_MS = 60_000;
/** Bounded drain for cancelled stragglers so their usage lands in the aggregate. */
const SWARM_STRAGGLER_DRAIN_MS = 500;

function clampInt(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, Math.floor(value)));
}

/** Effective swarm shape for a task-tool fan-out: `task.swarm*` overrides, else the shared `swarm.*` knobs. */
export function resolveSwarmAgentShape(session: ToolSession): { members: number; quorum: number } {
	const settings = session.settings;
	const membersOverride = settings.get("task.swarmMembers") as number | undefined;
	const quorumOverride = settings.get("task.swarmQuorum") as number | undefined;
	const members = clampInt(
		membersOverride !== undefined && membersOverride > 0
			? membersOverride
			: ((settings.get("swarm.members") ?? SWARM_DEFAULT_MEMBERS) as number),
		1,
		SWARM_AGENT_MAX_MEMBERS,
	);
	const quorum = clampInt(
		quorumOverride !== undefined && quorumOverride > 0
			? quorumOverride
			: ((settings.get("swarm.quorum") ?? SWARM_DEFAULT_QUORUM) as number),
		1,
		members,
	);
	return { members, quorum };
}

export interface SwarmAgentRunRequest {
	session: ToolSession;
	/** The identical assignment every member receives. */
	assignment: string;
	/** Shared batch context, when the swarm spawned from a `tasks[]` call. */
	context?: string;
	/** Agent type members run as (the session's default full-strength worker — never "swarm"). */
	memberAgent: string;
	/** Source of the swarm agent definition, stamped onto the merged result row. */
	swarmAgentSource: AgentSource;
	effort?: TaskEffort;
	/** Pre-allocated id for the swarm's own merged result row. */
	swarmId?: string;
	/** Stable user-facing label of the swarm spawn (the call's `name`). */
	label?: string;
	index: number;
	parentToolCallId: string;
	detached: boolean;
	invokedAt?: number;
	acquiredAt?: number;
	blockedAgent?: string;
	enableLsp: boolean;
	enableIrc: boolean;
	maxRuntimeMs?: number;
	signal?: AbortSignal;
	onMemberProgress?: (progress: AgentProgress) => void;
}

export interface SwarmAgentRunOutcome {
	result: SingleResult;
	swarm: SwarmRunSummary;
	projectAgentsDir: string | null;
}

interface MemberState {
	index: number;
	id: string;
	startedAt: number;
	/** Set once the member's run settled, successfully or not. */
	execution?: StructuredSubagentResult;
	error?: string;
}

/** Usable member output: clean exit, not aborted, non-empty text (mirrors the ensemble's `ensembleText`). */
function isUsableMember(result: SingleResult): boolean {
	return result.exitCode === 0 && !result.aborted && result.error === undefined && result.output.trim() !== "";
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Text content of an assistant message, or undefined when empty/errored. */
function messageText(message: AssistantMessage): string | undefined {
	if (message.stopReason === "error" || message.stopReason === "aborted") return undefined;
	let text = "";
	for (const block of message.content) {
		if (block.type === "text") text += block.text;
	}
	const trimmed = text.trim();
	return trimmed === "" ? undefined : trimmed;
}

interface MergeOutcome {
	text: string;
	synthesized: boolean;
	/** Assistant requests burned by the merge call (0 or 1), for the aggregate counters. */
	requests: number;
	/** Input + output + cacheWrite tokens burned by the merge call. */
	tokens: number;
}

/**
 * Merge synthesis: one full-strength call on the task role model (reasoning
 * on at the model's highest effort, no output cap) over the assignment plus
 * the quorum members' outputs. Falls back to the earliest member output when
 * no merge model is resolvable/authenticated, the call fails, or its output
 * is unusable — external cancellation likewise yields the earliest output
 * rather than a stale synthesized answer.
 */
async function synthesizeSwarmMerge(
	request: SwarmAgentRunRequest,
	candidates: SingleResult[],
	usage: Usage,
): Promise<MergeOutcome> {
	const earliest = candidates[0]!.output;
	const none: MergeOutcome = { text: earliest, synthesized: false, requests: 0, tokens: 0 };
	const registry = request.session.modelRegistry;
	if (!registry) return none;
	const available = registry.getAvailable();
	if (available.length === 0) return none;
	const resolved = resolveRoleSelection(["task"], request.session.settings, available);
	const model: Model<Api> | undefined = resolved?.model;
	if (!model) return none;
	const sessionId = request.session.getSessionId?.() ?? undefined;
	const apiKey = await registry.getApiKey(model, sessionId);
	if (!apiKey) return none;

	const listing = candidates.map(
		(result, position) => `--- member ${position + 1} (${result.id}) ---\n${result.output.trim()}`,
	);
	const context: Context = {
		systemPrompt: [swarmMergePrompt.trim()],
		messages: [
			{
				role: "user",
				content: `Assignment:\n${request.assignment}\n\nCandidate results from ${candidates.length} independent agents:\n\n${listing.join("\n\n")}`,
				timestamp: Date.now(),
			},
		],
	};
	const recordUsage = createEnsembleUsageRecorder(registry, sessionId);
	const timeoutMs = Math.max(
		SWARM_MERGE_MIN_TIMEOUT_MS,
		(request.session.settings.get("swarm.timeoutMs") ?? 0) as number,
	);
	const phase = createPhaseSignal(timeoutMs, request.signal);
	try {
		const effort = highestSupportedEffort(model);
		const message = await completeSimple(model, context, {
			apiKey: registry.resolver(model, sessionId),
			...(effort !== undefined ? { reasoning: effort } : {}),
			signal: phase.signal,
		});
		recordUsage(message);
		addUsageTotals(usage, message.usage);
		const tokens = message.usage.input + message.usage.output + message.usage.cacheWrite;
		if (request.signal?.aborted) return none;
		const text = messageText(message);
		return text === undefined ? none : { text, synthesized: true, requests: 1, tokens };
	} catch (error) {
		logger.debug("swarm-agent: merge synthesis failed; using earliest member output", {
			error: errorMessage(error),
		});
		return none;
	} finally {
		phase.dispose();
	}
}

/**
 * Run the swarm fan-out for one `agent: "swarm"` task spawn. Never rejects
 * for member failures — quorum machinery absorbs them into the fallback path;
 * catastrophic failures surface as a failed {@link SingleResult}.
 */
export async function runSwarmAgent(request: SwarmAgentRunRequest): Promise<SwarmAgentRunOutcome> {
	const { session } = request;
	const { members, quorum } = resolveSwarmAgentShape(session);
	const startedAt = Date.now();
	const externalSignal = request.signal;
	const gist = oneLineLabel(request.assignment, 48);
	const renderedTask = prompt.render(subagentUserPromptTemplate, { assignment: request.assignment });

	const outputManager = session.agentOutputManager ?? new AgentOutputManager(session.getArtifactsDir ?? (() => null));
	session.agentOutputManager ??= outputManager;
	const swarmId = request.swarmId ?? (await outputManager.allocate(request.label?.trim() || generateTaskName()));

	const states: MemberState[] = [];
	/**
	 * Successful members in arrival order — the quorum candidates. Arrivals in
	 * the same event-loop flush follow launch order, so the earliest arrival is
	 * always a deterministic tie-break for the merge-failure fallback (the
	 * ensemble's vote inherits the same property from Map first-seen order).
	 */
	const arrivals: MemberState[] = [];
	const aggregateUsage = createUsageTotals();
	let settledCount = 0;
	let totalRequests = 0;
	let totalTokens = 0;
	let projectAgentsDir: string | null = null;

	const memberSummary = (state: MemberState, counted: boolean): SwarmMemberSummary => {
		const result = state.execution?.result;
		const status: SwarmMemberStatus =
			state.execution === undefined
				? state.error !== undefined
					? "failed"
					: "cancelled" // never settled: a straggler cancelled post-quorum
				: result!.aborted === true
					? "cancelled"
					: isUsableMember(result!)
						? "completed"
						: "failed";
		return {
			id: state.id,
			status,
			durationMs: result?.durationMs ?? Math.max(0, Date.now() - state.startedAt),
			counted,
		};
	};
	const assemble = (
		final: Pick<SingleResult, "output" | "exitCode"> & Partial<SingleResult>,
		synthesis: SwarmSynthesis,
		counted: (state: MemberState) => boolean,
	): SwarmAgentRunOutcome => ({
		result: {
			index: request.index,
			id: swarmId,
			agent: SWARM_AGENT_NAME,
			agentSource: request.swarmAgentSource,
			task: renderedTask,
			assignment: request.assignment,
			description: request.label,
			stderr: "",
			truncated: false,
			durationMs: Math.max(0, Date.now() - startedAt),
			tokens: totalTokens,
			requests: totalRequests,
			usage: aggregateUsage,
			...final,
		},
		swarm: { members, quorum, synthesis, memberResults: states.map(state => memberSummary(state, counted(state))) },
		projectAgentsDir,
	});

	// Aborted before launch: skip the fan-out entirely.
	if (externalSignal?.aborted) {
		return assemble(
			{ output: "", exitCode: 1, error: "Cancelled", aborted: true, abortReason: "Cancelled" },
			"aborted",
			() => false,
		);
	}

	// One controller for the whole member phase: post-quorum straggler cancel
	// and external abort both fan out to every still-running member. Late
	// settlements are absorbed by the attached handlers (no unhandled
	// rejections) and fold into the aggregate counters.
	const membersController = new AbortController();
	let notify: (() => void) | undefined;
	const poke = (): void => {
		notify?.();
	};
	const nextSettle = (): Promise<void> =>
		new Promise<void>(resolve => {
			notify = resolve;
		});
	const onExternalAbort = (): void => {
		membersController.abort(externalSignal?.reason);
		poke();
	};
	if (externalSignal !== undefined) {
		externalSignal.addEventListener("abort", onExternalAbort, { once: true });
	}
	const detachExternalAbort = (): void => {
		if (externalSignal !== undefined) externalSignal.removeEventListener("abort", onExternalAbort);
	};

	const recordSettled = (
		state: MemberState,
		execution: StructuredSubagentResult | undefined,
		error: unknown,
	): void => {
		settledCount += 1;
		if (execution !== undefined) {
			state.execution = execution;
			projectAgentsDir ??= execution.policy.discovery.projectAgentsDir;
			const result = execution.result;
			totalRequests += result.requests;
			totalTokens += result.tokens;
			if (result.usage) addUsageTotals(aggregateUsage, result.usage);
			if (isUsableMember(result)) arrivals.push(state);
		} else {
			state.error = errorMessage(error);
			logger.debug("swarm-agent: member run failed", { id: state.id, error: state.error });
		}
		poke();
	};

	const memberLabel = (index: number): string => `swarm ${index + 1}/${members}${gist.length > 0 ? ` · ${gist}` : ""}`;
	const memberRequest = (index: number, id: string, signal: AbortSignal | undefined) => ({
		session,
		invocationKind: "task" as const,
		assignment: request.assignment,
		context: request.context,
		agent: request.memberAgent,
		...(request.effort !== undefined ? { effort: request.effort } : {}),
		identity: { id, label: index < members ? memberLabel(index) : `swarm fallback${gist ? ` · ${gist}` : ""}` },
		index,
		parentToolCallId: request.parentToolCallId,
		detached: request.detached,
		invokedAt: request.invokedAt,
		acquiredAt: request.acquiredAt,
		blockedAgent: request.blockedAgent,
		// A swarm member is a full-strength task agent and keeps its own task
		// tool — except for swarms: nesting would multiply one quorum into N.
		disableAgents: [SWARM_AGENT_NAME],
		enableLsp: request.enableLsp,
		enableIrc: request.enableIrc,
		maxRuntimeMs: request.maxRuntimeMs,
		signal,
		onProgress: request.onMemberProgress,
	});

	for (let index = 0; index < members; index += 1) {
		const id = await outputManager.allocate(generateTaskName());
		const state: MemberState = { index, id, startedAt: Date.now() };
		states.push(state);
		void runStructuredSubagent(memberRequest(index, id, membersController.signal)).then(
			execution => recordSettled(state, execution, undefined),
			(error: unknown) => recordSettled(state, undefined, error),
		);
	}

	// Member phase: wait for the first quorum of usable completions. No
	// wall-clock bound of its own — members carry the regular per-subagent
	// limits (task.maxRuntimeMs) and the caller's abort signal; when every
	// member settled without quorum there is nothing left to wait for.
	while (arrivals.length < quorum && settledCount < members && !externalSignal?.aborted) {
		await nextSettle();
	}

	/** Bounded wait for aborted stragglers to settle so their usage lands in the aggregate. */
	const drainStragglers = async (): Promise<void> => {
		const deadline = Date.now() + SWARM_STRAGGLER_DRAIN_MS;
		while (settledCount < members) {
			const remaining = deadline - Date.now();
			if (remaining <= 0) break;
			await Promise.race([nextSettle(), Bun.sleep(remaining)]);
		}
	};

	try {
		if (externalSignal?.aborted) {
			membersController.abort(externalSignal.reason);
			await drainStragglers();
			return assemble(
				{ output: "", exitCode: 1, error: "Cancelled", aborted: true, abortReason: "Cancelled" },
				"aborted",
				() => false,
			);
		}

		if (arrivals.length >= quorum) {
			// Grace window for stragglers, then cancel whatever is still running.
			if (settledCount < members) {
				const graceDeadline = Date.now() + SWARM_DEFAULT_GRACE_MS;
				while (settledCount < members) {
					const remaining = graceDeadline - Date.now();
					if (remaining <= 0) break;
					await Promise.race([nextSettle(), Bun.sleep(remaining)]);
				}
			}
			membersController.abort("swarm: quorum reached");
			await drainStragglers();
			if (externalSignal?.aborted) {
				return assemble(
					{ output: "", exitCode: 1, error: "Cancelled", aborted: true, abortReason: "Cancelled" },
					"aborted",
					() => false,
				);
			}
			const candidates = arrivals.map(state => state.execution!.result);
			const merge = await synthesizeSwarmMerge(request, candidates, aggregateUsage);
			totalRequests += merge.requests;
			totalTokens += merge.tokens;
			const countedIds = new Set(arrivals.map(state => state.id));
			return assemble({ output: merge.text, exitCode: 0 }, merge.synthesized ? "merge" : "earliest", state =>
				countedIds.has(state.id),
			);
		}

		// Quorum never arrived (every member settled, too few usable): run ONE
		// direct full-strength fallback member on the caller's own signal.
		logger.debug("swarm-agent: quorum not reached; running single fallback member", {
			members,
			quorum,
			arrived: arrivals.length,
		});
		const fallbackId = await outputManager.allocate(generateTaskName());
		const fallbackState: MemberState = { index: members, id: fallbackId, startedAt: Date.now() };
		states.push(fallbackState);
		const failedFallback = (cause: string): SwarmAgentRunOutcome =>
			assemble(
				{
					output: arrivals[0]?.execution?.result.output ?? "",
					exitCode: 1,
					error: `Swarm quorum failed (${arrivals.length}/${quorum} members) and the fallback member failed: ${cause}`,
				},
				"fallback",
				state => state === fallbackState,
			);
		try {
			const execution = await runStructuredSubagent(memberRequest(members, fallbackId, externalSignal));
			recordSettled(fallbackState, execution, undefined);
			const result = execution.result;
			if (externalSignal?.aborted || result.aborted) {
				return assemble(
					{
						output: result.output,
						exitCode: 1,
						error: result.error ?? "Cancelled",
						aborted: true,
						abortReason: result.abortReason ?? "Cancelled",
					},
					"aborted",
					state => state === fallbackState,
				);
			}
			if (isUsableMember(result)) {
				return assemble({ output: result.output, exitCode: 0 }, "fallback", state => state === fallbackState);
			}
			return failedFallback(result.error ?? result.stderr ?? "no output");
		} catch (error) {
			recordSettled(fallbackState, undefined, error);
			return failedFallback(errorMessage(error));
		}
	} finally {
		detachExternalAbort();
	}
}
