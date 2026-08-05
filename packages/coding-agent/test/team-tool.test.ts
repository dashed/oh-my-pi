import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getConfigRootDir, TempDir } from "@oh-my-pi/pi-utils";
import { Settings } from "../src/config/settings";
import { AgentRegistry } from "../src/registry/agent-registry";
import type { AgentSession } from "../src/session/agent-session";
import { resolveTeamBoardDir, resolveTeamId, type TeamLineageSource } from "../src/teams/board";
import type { ToolSession } from "../src/tools";
import { TeamTool, type TeamToolDetails } from "../src/tools/team";

let temp: TempDir;

beforeEach(async () => {
	temp = await TempDir.create("omp-team-tool-");
});

afterEach(async () => {
	await temp.remove();
});

function makeToolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: temp.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => null,
		settings: Settings.isolated(),
		getAgentId: () => "Tester",
		getSessionId: () => "root-session-id",
		...overrides,
	};
}

function makeTool(session: ToolSession = makeToolSession()): TeamTool {
	return new TeamTool(session, { boardDir: temp.join("tasks") });
}

async function execute(tool: TeamTool, params: Record<string, unknown>) {
	return tool.execute("call", params as never) as Promise<{
		content: Array<{ type: string; text?: string }>;
		details?: TeamToolDetails;
		isError?: boolean;
	}>;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text ?? "";
}

describe("team id resolution", () => {
	it("walks the AgentRef parent chain to the root session's board", () => {
		const registry = new AgentRegistry();
		const rootSession = {
			sessionManager: { getSessionId: () => "root-session-id" },
		} as unknown as AgentSession;
		registry.register({ id: "Main", displayName: "main", kind: "main", session: rootSession });
		registry.register({ id: "Sub1", displayName: "sub", kind: "sub", parentId: "Main", session: null });
		registry.register({ id: "Sub2", displayName: "sub", kind: "sub", parentId: "Sub1", session: null });

		const lineage: TeamLineageSource = {
			getAgentId: () => "Sub2",
			agentRegistry: registry,
			getSessionId: () => "sub2-own-session-id",
		};
		expect(resolveTeamId(lineage)).toBe("root-session-id");
	});

	it("resolves the root agent's own session id for the main session", () => {
		const registry = new AgentRegistry();
		const rootSession = {
			sessionManager: { getSessionId: () => "root-session-id" },
		} as unknown as AgentSession;
		registry.register({ id: "Main", displayName: "main", kind: "main", session: rootSession });
		expect(resolveTeamId({ getAgentId: () => "Main", agentRegistry: registry })).toBe("root-session-id");
	});

	it("falls back to the caller's own session id without a registry lineage", () => {
		expect(resolveTeamId({ getAgentId: () => "Orphan", getSessionId: () => "own-id" })).toBe("own-id");
		expect(resolveTeamId({})).toBeNull();
	});

	it("maps the team id onto the ~/.omp/teams/<id>/tasks layout", () => {
		expect(resolveTeamBoardDir("root-session-id")).toBe(
			path.join(getConfigRootDir(), "teams", "root-session-id", "tasks"),
		);
	});
});

describe("input validation", () => {
	it("rejects create without a title", async () => {
		const result = await execute(makeTool(), { op: "create" });
		expect(result.isError).toBe(true);
		expect(result.details?.error).toBe("invalid_input");
	});

	it("rejects create with a blank title", async () => {
		const result = await execute(makeTool(), { op: "create", title: "   " });
		expect(result.isError).toBe(true);
		expect(result.details?.error).toBe("invalid_input");
	});

	it("rejects create with a nonexistent blockedBy id", async () => {
		const result = await execute(makeTool(), {
			op: "create",
			title: "orphan",
			blockedBy: ["0f3a9c1e2b4d5678"],
		});
		expect(result.isError).toBe(true);
		expect(result.details?.error).toBe("invalid_input");
	});

	it("rejects create with a malformed blockedBy id", async () => {
		const result = await execute(makeTool(), { op: "create", title: "bad dep", blockedBy: ["../evil"] });
		expect(result.isError).toBe(true);
		expect(result.details?.error).toBe("invalid_input");
	});

	for (const op of ["claim", "complete", "release"] as const) {
		it(`rejects ${op} without a taskId`, async () => {
			const result = await execute(makeTool(), { op });
			expect(result.isError).toBe(true);
			expect(result.details?.error).toBe("invalid_input");
		});

		it(`rejects ${op} with a path-unsafe taskId`, async () => {
			const result = await execute(makeTool(), { op, taskId: "../evil" });
			expect(result.isError).toBe(true);
			expect(result.details?.error).toBe("invalid_input");
		});

		it(`rejects ${op} for an unknown task`, async () => {
			const result = await execute(makeTool(), { op, taskId: "0f3a9c1e2b4d5678" });
			expect(result.isError).toBe(true);
			expect(result.details?.error).toBe("not_found");
		});
	}
});

describe("board flow through the tool", () => {
	it("create → list → claim → complete with blockedBy gating", async () => {
		const tool = makeTool();

		const pred = await execute(tool, { op: "create", title: "predecessor" });
		expect(pred.isError).toBeUndefined();
		const predId = pred.details?.task?.id;
		expect(predId).toBeDefined();

		const dep = await execute(tool, { op: "create", title: "dependent", blockedBy: [predId!] });
		const depId = dep.details?.task?.id;
		expect(depId).toBeDefined();

		const blockedClaim = await execute(tool, { op: "claim", taskId: depId! });
		expect(blockedClaim.isError).toBe(true);
		expect(blockedClaim.details?.error).toBe("blocked");
		expect(textOf(blockedClaim)).toContain(predId!);

		expect((await execute(tool, { op: "claim", taskId: predId! })).isError).toBeUndefined();

		const done = await execute(tool, { op: "complete", taskId: predId!, result: "shipped" });
		expect(done.isError).toBeUndefined();
		expect(done.details?.unblocked).toEqual([depId!]);

		const claim = await execute(tool, { op: "claim", taskId: depId! });
		expect(claim.isError).toBeUndefined();

		const pending = await execute(tool, { op: "list", status: "pending" });
		expect(textOf(pending)).toContain("No pending tasks");
		const all = await execute(tool, { op: "list" });
		expect(all.details?.tasks).toHaveLength(2);
	});

	it("claim conflict is a typed tool result, not a throw", async () => {
		const tool = makeTool();
		const created = await execute(tool, { op: "create", title: "contended" });
		const taskId = created.details!.task!.id;

		const first = await execute(tool, { op: "claim", taskId });
		expect(first.isError).toBeUndefined();

		const second = await execute(tool, { op: "claim", taskId });
		expect(second.isError).toBe(true);
		expect(second.details?.error).toBe("already_claimed");
		expect(textOf(second)).toContain("already claimed by Tester");
	});

	it("release returns the task to pending for reclaim", async () => {
		const tool = makeTool();
		const created = await execute(tool, { op: "create", title: "handoff" });
		const taskId = created.details!.task!.id;
		await execute(tool, { op: "claim", taskId });

		const released = await execute(tool, { op: "release", taskId });
		expect(released.isError).toBeUndefined();
		expect(released.details?.task?.status).toBe("pending");
	});

	it("completing an unclaimed task is an invalid_state error", async () => {
		const tool = makeTool();
		const created = await execute(tool, { op: "create", title: "pending" });
		const result = await execute(tool, { op: "complete", taskId: created.details!.task!.id });
		expect(result.isError).toBe(true);
		expect(result.details?.error).toBe("invalid_state");
	});
});

describe("hub notify", () => {
	it("claim/complete broadcast failures never break the op", async () => {
		// A registry with only the caller registered: the broadcast has no live
		// peers and must not affect the claim result.
		const registry = new AgentRegistry();
		registry.register({ id: "Tester", displayName: "tester", kind: "main", session: null });
		const tool = makeTool(makeToolSession({ agentRegistry: registry }));

		const created = await execute(tool, { op: "create", title: "notify-me" });
		const taskId = created.details!.task!.id;
		const claimed = await execute(tool, { op: "claim", taskId });
		expect(claimed.isError).toBeUndefined();
		const completed = await execute(tool, { op: "complete", taskId, result: "ok" });
		expect(completed.isError).toBeUndefined();
	});
});
