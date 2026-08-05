/**
 * Contract: a subagent's terminal lifecycle transition (completed / failed /
 * aborted) raises exactly one desktop notification carrying the agent label
 * and outcome, gated by the same `completion.notify` / `error.notify`
 * settings that gate the main-turn notifications. A `started` payload never
 * notifies but re-arms the dedupe so a revived agent's follow-up settle
 * notifies again; advisor transcripts are observability-only and never
 * notify.
 */
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { type SubagentLifecyclePayload, TASK_SUBAGENT_LIFECYCLE_CHANNEL } from "@oh-my-pi/pi-coding-agent/task";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TERMINAL, type TerminalNotification } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";

function notifiedAt(spy: Mock<typeof TERMINAL.sendNotification>, index: number): TerminalNotification {
	const message = spy.mock.calls[index][0];
	if (typeof message === "string") throw new Error(`Expected a structured notification, got: ${message}`);
	return message;
}

function makeLifecycle(
	id: string,
	status: SubagentLifecyclePayload["status"],
	description?: string,
): SubagentLifecyclePayload {
	return {
		id,
		index: 0,
		agent: "task",
		agentSource: "bundled",
		description,
		status,
		parentToolCallId: "tool-call",
		detached: true,
	};
}

describe("subagent lifecycle notifications", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;
	let notifySpy: Mock<typeof TERMINAL.sendNotification>;
	let warpProtocol: string | undefined;

	beforeEach(async () => {
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
		warpProtocol = process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
		delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
		tempDir = TempDir.createSync("@pi-subagent-notify-");
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, undefined, eventBus);
		notifySpy = vi.spyOn(TERMINAL, "sendNotification").mockImplementation(() => {});
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		if (warpProtocol === undefined) delete process.env.WARP_CLI_AGENT_PROTOCOL_VERSION;
		else process.env.WARP_CLI_AGENT_PROTOCOL_VERSION = warpProtocol;
		vi.restoreAllMocks();
		resetSettingsForTest();
		AgentRegistry.resetGlobalForTests();
	});

	it("notifies once when a subagent completes, and never for a repeated transition", () => {
		settings.override("completion.notify", "on");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("AuthLoader", "completed", "Refactoring auth"));
		expect(TERMINAL.sendNotification).toHaveBeenCalledTimes(1);
		const notification = notifiedAt(notifySpy, 0);
		expect(notification.body).toContain("AuthLoader");
		expect(notification.body).toContain("completed");
		expect(notification.type).toBe("completion");

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("AuthLoader", "completed", "Refactoring auth"));
		expect(TERMINAL.sendNotification).toHaveBeenCalledTimes(1);
	});

	it("does not notify when completion.notify is off", () => {
		settings.override("completion.notify", "off");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("AuthLoader", "completed"));
		expect(TERMINAL.sendNotification).not.toHaveBeenCalled();
	});

	it("gates failure outcomes behind error.notify, not completion.notify", () => {
		settings.override("completion.notify", "on");
		// error.notify defaults to off: failures stay silent.
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Flaky", "failed"));
		expect(TERMINAL.sendNotification).not.toHaveBeenCalled();

		settings.override("error.notify", "on");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Flaky2", "failed"));
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Killed", "aborted"));
		expect(TERMINAL.sendNotification).toHaveBeenCalledTimes(2);
		expect(notifiedAt(notifySpy, 0).type).toBe("error");
		expect(notifiedAt(notifySpy, 1).type).toBe("error");
	});

	it("never notifies for started, and re-arms the dedupe so a revived run notifies again", () => {
		settings.override("completion.notify", "on");
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Worker", "started"));
		expect(TERMINAL.sendNotification).not.toHaveBeenCalled();

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Worker", "completed"));
		expect(TERMINAL.sendNotification).toHaveBeenCalledTimes(1);

		// Revive: same id runs again; its new settle must notify again.
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Worker", "started"));
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Worker", "completed"));
		expect(TERMINAL.sendNotification).toHaveBeenCalledTimes(2);
	});

	it("never notifies for advisor transcripts", () => {
		settings.override("completion.notify", "on");
		AgentRegistry.global().register({
			id: "Main/advisor:review",
			displayName: "advisor:review",
			kind: "advisor",
			parentId: "Main",
			session: null,
			sessionFile: null,
		});
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Main/advisor:review", "completed"));
		expect(TERMINAL.sendNotification).not.toHaveBeenCalled();
	});
});
