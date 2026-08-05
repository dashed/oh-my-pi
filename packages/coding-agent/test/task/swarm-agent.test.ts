/**
 * Contracts for the swarm subagent mode (task tool `agent: "swarm"`):
 *
 * 1. Fan-out: one swarm spawn runs N full-strength members of the session's
 *    default worker agent on the identical assignment, then one merge call
 *    (task role model) synthesizes the quorum outputs.
 * 2. Quorum: the run proceeds at the first `quorum` usable completions and
 *    cancels stragglers after the grace window.
 * 3. Quorum failure: ONE direct full-strength fallback member runs; the merge
 *    call is skipped.
 * 4. Merge failure: the earliest completed member's output wins.
 * 5. Members are real spawns: distinct ids, shared parentToolCallId, and a
 *    `swarm i/N` grouping label as their registry/HUD description.
 * 6. The task row carries a `swarm` badge (member count in the meta line).
 * 7. No swarm-of-swarms: member spawns carry `disableAgents: ["swarm"]`, and
 *    the disabledAgents channel rejects a nested swarm spawn.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import { renderResult } from "@oh-my-pi/pi-coding-agent/task/render";
import type { AgentDefinition, SingleResult, TaskParams, TaskToolDetails } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";

const taskAgent: AgentDefinition = {
	name: "task",
	description: "General-purpose task agent",
	systemPrompt: "You are a task agent.",
	source: "bundled",
};

const swarmAgent: AgentDefinition = {
	name: "swarm",
	description: "Swarm fan-out",
	systemPrompt: "Never runs a session.",
	source: "bundled",
	blocking: true,
};

function swarmModel(): Model {
	return buildModel({
		id: "mock-swarm",
		name: "mock-swarm",
		api: "openai-completions",
		provider: "mock",
		baseUrl: "https://example.com",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_048_576,
		maxTokens: 65_536,
	});
}

let fixtureTimestamp = 1_000_000;
function mergeMessage(text: string): AssistantMessage {
	fixtureTimestamp += 1;
	return {
		role: "assistant",
		api: "openai-completions",
		provider: "mock",
		model: "mock-swarm",
		content: [{ type: "text", text }],
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
		},
		stopReason: "stop",
		timestamp: fixtureTimestamp,
	};
}

function memberUsage(): SingleResult["usage"] {
	return {
		input: 10,
		output: 5,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 15,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.001 },
	};
}

function makeResult(id: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent: "task",
		agentSource: "bundled",
		task: "task prompt",
		assignment: "Do the thing.",
		exitCode: 0,
		output: `answer from ${id}`,
		stderr: "",
		truncated: false,
		durationMs: 5,
		tokens: 15,
		requests: 1,
		usage: memberUsage(),
		...overrides,
	};
}

interface FakeRegistry {
	registry: unknown;
	observed: unknown[];
}

function createFakeRegistry(): FakeRegistry {
	const observed: unknown[] = [];
	const model = swarmModel();
	const registry = {
		getAvailable: () => [model],
		getApiKey: async () => "test-key",
		resolver: () => "test-key",
		authStorage: {
			recordUsageCost: () => {},
			recordObservedUsage: (entry: unknown) => {
				observed.push(entry);
			},
		},
	};
	return { registry, observed };
}

function createSession(options: { settings?: Record<string, unknown>; registry?: unknown }): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		settings: Settings.isolated({
			modelRoles: { task: "mock/mock-swarm" },
			...options.settings,
		}),
		getSessionFile: () => null,
		getSessionId: () => "swarm-test-session",
		getSessionSpawns: () => "*",
		modelRegistry: options.registry,
	} as unknown as ToolSession;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
	const content = result.content.find(part => part.type === "text");
	return content?.type === "text" ? (content.text ?? "") : "";
}

describe("task swarm agent mode", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [taskAgent, swarmAgent],
			projectAgentsDir: null,
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	it("fans out N full-strength members on the identical assignment and merges the quorum", async () => {
		const { registry, observed } = createFakeRegistry();
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			return makeResult(options.id ?? "?", { index: options.index });
		});
		const mergeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(mergeMessage("merged final answer"));

		const tool = await TaskTool.create(createSession({ registry }));
		const result = await tool.execute("tc-swarm", { agent: "swarm", task: "Do the thing." } as TaskParams);

		// N=3 members, all running the default worker agent on the same assignment.
		// (runSubprocess call order is nondeterministic: each member's async
		// preflight/lease interleaves, so assertions key off options.index.)
		expect(runSpy).toHaveBeenCalledTimes(3);
		const memberOptions = runSpy.mock.calls.map(call => call[0]);
		expect(new Set(memberOptions.map(options => options.index))).toEqual(new Set([0, 1, 2]));
		for (const options of memberOptions) {
			expect(options.agent.name).toBe("task");
			expect(options.assignment).toBe("Do the thing.");
			expect(options.parentToolCallId).toBe("tc-swarm");
			// Registry/HUD grouping: `swarm i/N · <gist>` as the spawn description.
			expect(options.description).toBe(`swarm ${options.index + 1}/3 · Do the thing.`);
			// No swarm-of-swarms: members are barred from spawning swarms.
			expect(options.disableAgents).toEqual(["swarm"]);
		}
		expect(new Set(memberOptions.map(options => options.id)).size).toBe(3);

		// One merge call over the quorum outputs with the merge instruction.
		expect(mergeSpy).toHaveBeenCalledTimes(1);
		const mergeContext = mergeSpy.mock.calls[0]![1];
		expect(mergeContext.systemPrompt?.[0]).toContain("synthesis pass of a swarm run");
		const mergeUser = mergeContext.messages.at(-1);
		expect(mergeUser?.role).toBe("user");
		const mergeText = typeof mergeUser?.content === "string" ? mergeUser.content : "";
		expect(mergeText).toContain("Assignment:\nDo the thing.");
		expect(mergeText).toContain("Candidate results");
		const candidateOutputs = memberOptions.map(options => `answer from ${options.id}`);
		expect(candidateOutputs.filter(output => mergeText.includes(output)).length).toBeGreaterThanOrEqual(2);

		// The merged output becomes the single swarm result; usage aggregates
		// settled members + merge (2 members + merge = 30 input minimum — a
		// slow third member could miss the grace window under load), and the
		// merge call is metered like the ensemble's.
		const details = result.details!;
		expect(details.results).toHaveLength(1);
		expect(details.results[0]!.agent).toBe("swarm");
		expect(details.results[0]!.output).toBe("merged final answer");
		expect(details.results[0]!.usage?.input).toBeGreaterThanOrEqual(30);
		expect(observed).toHaveLength(1);
		expect(details.swarm?.members).toBe(3);
		expect(details.swarm?.quorum).toBe(2);
		expect(details.swarm?.synthesis).toBe("merge");
		expect(details.swarm?.memberResults).toHaveLength(3);
		expect(details.swarm?.memberResults.filter(member => member.counted).length).toBeGreaterThanOrEqual(2);
		expect(
			details.swarm?.memberResults.every(member => member.status === "completed" || member.status === "cancelled"),
		).toBe(true);
		expect(getFirstText(result)).toContain("merged final answer");
	});

	it("proceeds at the first quorum and cancels the straggler after grace", async () => {
		const { registry } = createFakeRegistry();
		let stragglerSignal: AbortSignal | undefined;
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			if (options.index === 2) {
				stragglerSignal = options.signal;
				await new Promise<void>(resolve => {
					if (options.signal?.aborted) return resolve();
					options.signal?.addEventListener("abort", () => resolve(), { once: true });
				});
				return makeResult(options.id ?? "?", {
					index: 2,
					exitCode: 1,
					output: "",
					error: "Cancelled",
					aborted: true,
					abortReason: "swarm: quorum reached",
				});
			}
			return makeResult(options.id ?? "?", { index: options.index, output: `answer-${options.index}` });
		});
		const mergeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(mergeMessage("merged from quorum"));

		const tool = await TaskTool.create(createSession({ registry }));
		const result = await tool.execute("tc-swarm", { agent: "swarm", task: "Do the thing." } as TaskParams);

		expect(runSpy).toHaveBeenCalledTimes(3);
		expect(stragglerSignal?.aborted).toBe(true);
		expect(stragglerSignal?.reason).toBe("swarm: quorum reached");

		// The merge saw exactly the two quorum outputs, not the straggler.
		const mergeUser = mergeSpy.mock.calls[0]![1].messages.at(-1);
		const mergeText = typeof mergeUser?.content === "string" ? mergeUser.content : "";
		expect(mergeText).toContain("answer-0");
		expect(mergeText).toContain("answer-1");
		expect(mergeText).not.toContain("answer-2");

		const members = result.details!.swarm!.memberResults;
		expect(members).toHaveLength(3);
		expect(members.filter(member => member.status === "completed" && member.counted)).toHaveLength(2);
		expect(members.filter(member => member.status === "cancelled" && !member.counted)).toHaveLength(1);
		expect(result.details!.results[0]!.output).toBe("merged from quorum");
	});

	it("runs one direct full-strength fallback when quorum never arrives", async () => {
		const { registry } = createFakeRegistry();
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			if (options.index === 3) {
				return makeResult(options.id ?? "?", { index: 3, output: "fallback answer" });
			}
			return makeResult(options.id ?? "?", { index: options.index, exitCode: 1, output: "", error: "boom" });
		});
		const mergeSpy = vi.spyOn(ai, "completeSimple").mockResolvedValue(mergeMessage("should not be used"));

		const tool = await TaskTool.create(createSession({ registry }));
		const result = await tool.execute("tc-swarm", { agent: "swarm", task: "Do the thing." } as TaskParams);

		expect(runSpy).toHaveBeenCalledTimes(4);
		const fallbackOptions = runSpy.mock.calls[3]![0];
		expect(fallbackOptions.agent.name).toBe("task");
		expect(fallbackOptions.assignment).toBe("Do the thing.");
		expect(fallbackOptions.description).toBe("swarm fallback · Do the thing.");
		expect(fallbackOptions.disableAgents).toEqual(["swarm"]);
		// No merge synthesis on the fallback path.
		expect(mergeSpy).not.toHaveBeenCalled();

		const details = result.details!;
		expect(details.results[0]!.output).toBe("fallback answer");
		expect(details.swarm?.synthesis).toBe("fallback");
		const members = details.swarm!.memberResults;
		expect(members).toHaveLength(4);
		expect(members.slice(0, 3).every(member => member.status === "failed" && !member.counted)).toBe(true);
		expect(members[3]).toMatchObject({ status: "completed", counted: true });
	});

	it("falls back to a completed member's verbatim output when synthesis fails", async () => {
		const { registry } = createFakeRegistry();
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			return makeResult(options.id ?? "?", { index: options.index, output: `answer-${options.index}` });
		});
		const mergeSpy = vi.spyOn(ai, "completeSimple").mockRejectedValue(new Error("provider down"));

		const tool = await TaskTool.create(createSession({ registry }));
		const result = await tool.execute("tc-swarm", { agent: "swarm", task: "Do the thing." } as TaskParams);

		// The merge was attempted, failed, and the run degraded to a member's
		// verbatim output — never the merge error, never an empty result.
		expect(mergeSpy).toHaveBeenCalledTimes(1);
		const memberOutputs = runSpy.mock.calls.map(call => `answer-${call[0].index}`);
		expect(memberOutputs).toContain(result.details!.results[0]!.output);
		expect(result.details!.results[0]!.exitCode).toBe(0);
		expect(result.details!.swarm?.synthesis).toBe("earliest");
	});

	it("rejects a swarm spawn on a session whose disabledAgents channel bars it", async () => {
		const runSpy = vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			return makeResult(options.id ?? "?");
		});
		const tool = await TaskTool.create(
			createSession({ registry: createFakeRegistry().registry, settings: { "task.disabledAgents": ["swarm"] } }),
		);
		const result = await tool.execute("tc-swarm", { agent: "swarm", task: "Do the thing." } as TaskParams);
		expect(getFirstText(result)).toContain('Agent "swarm" is disabled');
		expect(runSpy).not.toHaveBeenCalled();
	});

	it("renders the swarm badge in the task row meta line", async () => {
		await Settings.init({ inMemory: true });
		const loaded = await getThemeByName("dark");
		if (!loaded) throw new Error("theme unavailable");
		const uiTheme: Theme = loaded;
		setThemeInstance(uiTheme);
		const strip = (lines: readonly string[]): string =>
			lines
				.join("\n")
				.replace(/\x1b\]8;[^\x1b\x07]*(?:\x07|\x1b\\)/g, "")
				.replace(/\x1b\[[0-9;]*m/g, "");

		const settled: TaskToolDetails = {
			projectAgentsDir: null,
			results: [makeResult("Swarmy", { agent: "swarm", output: "merged" })],
			totalDurationMs: 10,
			swarm: {
				members: 3,
				quorum: 2,
				synthesis: "merge",
				memberResults: [
					{ id: "m1", status: "completed", durationMs: 5, counted: true },
					{ id: "m2", status: "completed", durationMs: 6, counted: true },
					{ id: "m3", status: "cancelled", durationMs: 250, counted: false },
				],
			},
		};
		const settledText = strip(
			renderResult(
				{ content: [{ type: "text", text: "done" }], details: settled },
				{ expanded: false, isPartial: false },
				uiTheme,
			).render(120),
		);
		expect(settledText).toContain("swarm 2/3 · merge");

		const live: TaskToolDetails = {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 10,
			swarm: { members: 3, quorum: 2, memberResults: [] },
		};
		const liveText = strip(
			renderResult(
				{ content: [{ type: "text", text: "running" }], details: live },
				{ expanded: false, isPartial: true },
				uiTheme,
			).render(120),
		);
		expect(liveText).toContain("swarm ×3");
	});
});
