/**
 * team — shared task board for the session's agent team.
 *
 * Backed by {@link TeamBoard} (`~/.omp/teams/<rootSessionId>/tasks/`): every
 * descendant of the root session resolves the same board, so any agent can
 * publish work and any peer can claim it. Claim/complete broadcast over the
 * hub so idle peers wake to fresh work; broadcast failures never fail the op.
 */

import { type } from "@oh-my-pi/omptype";
import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
	ToolApprovalDecision,
} from "@oh-my-pi/pi-agent-core";
import type { ToolExample } from "@oh-my-pi/pi-ai";
import { logger, sanitizeText } from "@oh-my-pi/pi-utils";
import {
	isValidTaskId,
	resolveTeamBoardDir,
	resolveTeamId,
	TeamBoard,
	type TeamBoardOutcome,
	type TeamTask,
} from "../teams/board";
import type { ToolSession } from ".";
import { executeSend } from "./hub/messaging";

// =============================================================================
// Schema
// =============================================================================

const teamSchema = type({
	op: type('"list" | "create" | "claim" | "complete" | "release"').describe("team board operation"),
	"status?": type('"pending" | "claimed" | "done"').describe("list: only show tasks with this status"),
	"title?": type("string").describe("create: short task title"),
	"description?": type("string").describe("create: longer task description, acceptance criteria, context"),
	"blockedBy?": type("string[]").describe("create: task ids that must be completed before this task can be claimed"),
	"taskId?": type("string").describe("claim/complete/release: target task id from list/create output"),
	"result?": type("string").describe("complete: outcome summary recorded on the board"),
}).describe("a single team board operation");

type TeamParams = typeof teamSchema.infer;
type TeamOperation = TeamParams["op"];

export interface TeamToolDetails {
	op: TeamOperation;
	teamId?: string;
	actor?: string;
	tasks?: TeamTask[];
	task?: TeamTask;
	unblocked?: string[];
	/** Machine-readable failure code when the op failed. */
	error?: string;
}

// =============================================================================
// Tool
// =============================================================================

const TITLE_MAX = 200;
const TEXT_MAX = 4000;
const BLOCKED_BY_MAX = 32;

const TEAM_DESCRIPTION = `Shared task board for the agent team of this session. Every agent (main + all subagents) reads and writes the same board, stored at ~/.omp/teams/<root-session>/tasks/.

Ops:
- list: show board tasks, newest context first: id, title, status, claimedBy, unresolved blockers. Optional status filter.
- create: publish a task (title required; description and blockedBy optional). blockedBy lists task ids that must complete before this task becomes claimable. Returns the new task id.
- claim: atomically claim a pending task for yourself (taskId). Fails with a conflict if another agent already claimed it, or as blocked while any blockedBy prerequisite is not done.
- complete: mark your claimed task done (taskId, optional result). Clears the task from every dependent's blockedBy so they become claimable.
- release: give up a claimed task (taskId), returning it to pending for someone else.

Workflow: create or list to find pending work, claim before starting (exactly one agent wins a claim), complete with a result when done. Check list again after completing — completed prerequisites unblock dependent tasks.`;

function cleanText(value: string, max: number): string {
	return sanitizeText(value).trim().slice(0, max);
}

/** Board ops mutate shared board state; only listing is read-tier. */
function teamApproval(params: unknown): ToolApprovalDecision {
	if (typeof params !== "object" || params === null || !("op" in params)) return "write";
	return params.op === "list" ? "read" : "write";
}

function errorResult(op: TeamOperation, code: string, message: string): AgentToolResult<TeamToolDetails> {
	return {
		content: [{ type: "text", text: message }],
		details: { op, error: code },
		isError: true,
	};
}

export interface TeamToolOptions {
	/** Board directory override (tests). Default: resolved from the session team id. */
	boardDir?: string;
}

export class TeamTool implements AgentTool<typeof teamSchema, TeamToolDetails> {
	readonly name = "team";
	readonly approval = teamApproval;
	readonly label = "Team";
	readonly summary = "Read, claim, and complete tasks on the agent team's shared task board";
	readonly description = TEAM_DESCRIPTION;
	readonly parameters = teamSchema;
	readonly strict = true;

	readonly examples: readonly ToolExample<typeof teamSchema.infer>[] = [
		{ caption: "See what work is available", call: { op: "list", status: "pending" } },
		{
			caption: "Publish a task gated on another",
			call: {
				op: "create",
				title: "Wire retry tests",
				description: "Cover the 5xx path",
				blockedBy: ["0f3a9c1e2b4d5678"],
			},
		},
		{ caption: "Claim before starting", call: { op: "claim", taskId: "0f3a9c1e2b4d5678" } },
		{ caption: "Report the outcome", call: { op: "complete", taskId: "0f3a9c1e2b4d5678", result: "Tests green" } },
	];

	readonly #session: ToolSession;
	readonly #boardDir?: string;

	constructor(session: ToolSession, options: TeamToolOptions = {}) {
		this.#session = session;
		this.#boardDir = options.boardDir;
	}

	#actor(): string {
		return this.#session.getAgentId?.() ?? "unknown";
	}

	#board(teamId: string): TeamBoard {
		return new TeamBoard(this.#boardDir ?? resolveTeamBoardDir(teamId));
	}

	#resolveTeamId(): string | null {
		return this.#boardDir !== undefined ? (resolveTeamId(this.#session) ?? "team") : resolveTeamId(this.#session);
	}

	/** Wake idle peers to fresh work; failures must never break the op. */
	async #notify(event: "claimed" | "completed", task: TeamTask, actor: string): Promise<void> {
		const registry = this.#session.agentRegistry;
		const senderId = this.#session.getAgentId?.() ?? null;
		if (!registry || !senderId) return;
		try {
			await executeSend(
				{ registry, senderId, settings: this.#session.settings },
				{
					to: "all",
					message: `[team:${event}] ${task.id} "${task.title}" ${event} by ${actor}. Run \`team list\` for fresh work.`,
				},
			);
		} catch (error) {
			logger.warn("team: hub broadcast failed", {
				taskId: task.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	async execute(
		_toolCallId: string,
		params: TeamParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<TeamToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<TeamToolDetails>> {
		const teamId = this.#resolveTeamId();
		if (!teamId) {
			return errorResult(
				params.op,
				"no_team",
				"Cannot resolve the team board: no root session id for this session.",
			);
		}
		const board = this.#board(teamId);
		const actor = this.#actor();
		switch (params.op) {
			case "list":
				return this.#list(board, teamId, params);
			case "create":
				return this.#create(board, teamId, actor, params);
			case "claim":
				return this.#mutate(teamId, actor, params, taskId => board.claim(taskId, actor), "claimed");
			case "complete":
				return this.#mutate(
					teamId,
					actor,
					params,
					taskId =>
						board.complete(taskId, params.result !== undefined ? cleanText(params.result, TEXT_MAX) : undefined),
					"completed",
				);
			case "release":
				return this.#mutate(teamId, actor, params, taskId => board.release(taskId), null);
		}
	}

	async #list(board: TeamBoard, teamId: string, params: TeamParams): Promise<AgentToolResult<TeamToolDetails>> {
		const tasks = await board.list(params.status ? { status: params.status } : undefined);
		const lines: string[] = [];
		if (tasks.length === 0) {
			lines.push(
				params.status
					? `No ${params.status} tasks on the team board.`
					: "Team board is empty. Publish work with `team create`.",
			);
		} else {
			lines.push(`${tasks.length} task(s) on the team board:`);
			for (const task of tasks) {
				const state = task.status === "claimed" ? `claimed by ${task.claimedBy ?? "?"}` : task.status;
				const extras: string[] = [];
				if (task.blockedBy.length > 0) extras.push(`blocked by: ${task.blockedBy.join(", ")}`);
				if (task.result !== undefined) extras.push(`result: ${task.result}`);
				lines.push(`- [${state}] ${task.id} "${task.title}"${extras.length ? ` (${extras.join("; ")})` : ""}`);
			}
		}
		return {
			content: [{ type: "text", text: lines.join("\n") }],
			details: { op: "list", teamId, tasks },
		};
	}

	async #create(
		board: TeamBoard,
		teamId: string,
		actor: string,
		params: TeamParams,
	): Promise<AgentToolResult<TeamToolDetails>> {
		if (params.title === undefined) {
			return errorResult("create", "invalid_input", '`title` is required for op="create".');
		}
		const title = cleanText(params.title, TITLE_MAX);
		if (title.length === 0) {
			return errorResult("create", "invalid_input", "`title` must be a non-empty string.");
		}
		const blockedBy = params.blockedBy?.map(id => id.trim());
		if (blockedBy && blockedBy.length > BLOCKED_BY_MAX) {
			return errorResult("create", "invalid_input", `blockedBy accepts at most ${BLOCKED_BY_MAX} task ids.`);
		}
		const outcome = await board.create({
			title,
			...(params.description !== undefined ? { description: cleanText(params.description, TEXT_MAX) } : {}),
			...(blockedBy !== undefined ? { blockedBy } : {}),
			createdBy: actor,
		});
		if (!outcome.ok) return errorResult("create", outcome.code, outcome.message);
		const task = outcome.task;
		const blocked = task.blockedBy.length > 0 ? ` Blocked by: ${task.blockedBy.join(", ")}.` : "";
		return {
			content: [
				{
					type: "text",
					text: `Created task ${task.id}: "${task.title}" (status: pending).${blocked} Peers can claim it with \`team claim\`.`,
				},
			],
			details: { op: "create", teamId, actor, task },
		};
	}

	async #mutate(
		teamId: string,
		actor: string,
		params: TeamParams,
		run: (taskId: string) => Promise<TeamBoardOutcome>,
		notify: "claimed" | "completed" | null,
	): Promise<AgentToolResult<TeamToolDetails>> {
		const op = params.op;
		const taskId = params.taskId?.trim();
		if (!taskId) {
			return errorResult(op, "invalid_input", `\`taskId\` is required for op="${op}".`);
		}
		if (!isValidTaskId(taskId)) {
			return errorResult(op, "invalid_input", `Invalid task id "${taskId}". Use an id from \`team list\`.`);
		}
		const outcome = await run(taskId);
		if (!outcome.ok) return errorResult(op, outcome.code, outcome.message);
		const task = outcome.task;
		if (notify !== null) await this.#notify(notify, task, actor);
		let text: string;
		switch (op) {
			case "claim":
				text = `Claimed task ${task.id}: "${task.title}". Complete it with \`team complete\` or hand it back with \`team release\`.`;
				break;
			case "complete": {
				const unblocked = outcome.unblocked ?? [];
				text = `Completed task ${task.id}: "${task.title}".`;
				if (unblocked.length > 0) {
					text += ` Unblocked dependent task(s): ${unblocked.join(", ")} — now claimable.`;
				}
				break;
			}
			default:
				text = `Released task ${task.id}: "${task.title}" back to pending.`;
		}
		return {
			content: [{ type: "text", text }],
			details: { op, teamId, actor, task, ...(outcome.unblocked ? { unblocked: outcome.unblocked } : {}) },
		};
	}
}
