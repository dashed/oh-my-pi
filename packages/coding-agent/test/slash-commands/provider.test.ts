/**
 * Contract: `/provider` renders the rolling per-upstream stats table (local
 * rolling window joined with lazily-fetched OpenRouter endpoint perf), and
 * `/provider ignore|unignore <slug>` updates `providers.openrouter.ignore`
 * through Settings.set + flush so the ban persists to config.yml and applies
 * on the very next request (the settings-aware stream fn re-reads it per call).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { OpenRouterEndpointStatsCache } from "@oh-my-pi/pi-coding-agent/session/openrouter-endpoint-stats";
import { RoutingStatsTracker } from "@oh-my-pi/pi-coding-agent/session/routing-stats";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import { runProviderCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/helpers/provider";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { getProjectAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { YAML } from "bun";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const ENDPOINTS_FIXTURE = {
	data: {
		endpoints: [
			{
				provider_name: "Amazon Bedrock",
				tag: "amazon-bedrock",
				latency_last_30m: { p50: 989, p75: 1505.5, p90: 1862.1, p99: 4741.35 },
				throughput_last_30m: { p50: 45, p75: 60, p90: 74, p99: 109.41 },
				uptime_last_30m: 99.95,
			},
			{
				provider_name: "Google",
				tag: "google-vertex",
				latency_last_30m: { p50: 1001, p75: 1313, p90: 1747.2, p99: 3199.08 },
				throughput_last_30m: { p50: 43, p75: 50, p90: 60, p99: 74.68 },
				uptime_last_30m: 100,
			},
		],
	},
};

function endpointsFetch(): typeof fetch {
	return vi.fn(async () =>
		Response.json(ENDPOINTS_FIXTURE),
	) as unknown as typeof fetch;
}

const openRouterModel = {
	provider: "openrouter",
	id: "anthropic/claude-sonnet-4",
	api: "openrouter",
	compat: { isOpenRouterHost: true },
};

function acpRuntime(settings: Settings, model: unknown = undefined) {
	const output = vi.fn();
	const runtime = {
		session: { settings, model },
		settings,
		output,
	} as unknown as SlashCommandRuntime;
	return { output, runtime };
}

function slowTracker(): RoutingStatsTracker {
	const tracker = new RoutingStatsTracker({ hydrate: false });
	for (let i = 0; i < 4; i++) {
		tracker.record("amazon-bedrock", { tokensPerSecond: 5 + i, ttftMs: 100 * (i + 1) });
	}
	tracker.record("google-vertex", { tokensPerSecond: 80, ttftMs: 250 });
	return tracker;
}

describe("/provider ignore|unignore", () => {
	it("ignore adds the slug and persists via settings flush", async () => {
		const settings = Settings.isolated();
		const flushSpy = vi.spyOn(settings, "flush");
		const { output, runtime } = acpRuntime(settings);

		expect(await executeAcpBuiltinSlashCommand("/provider ignore deepinfra", runtime)).toEqual({ consumed: true });
		expect(settings.get("providers.openrouter.ignore")).toEqual(["deepinfra"]);
		expect(flushSpy).toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(
			"Ignoring deepinfra — OpenRouter will skip it on the next request. /provider unignore deepinfra to undo.",
		);
	});

	it("ignore is idempotent", async () => {
		const settings = Settings.isolated();
		settings.set("providers.openrouter.ignore", ["deepinfra"]);
		const { output, runtime } = acpRuntime(settings);
		await executeAcpBuiltinSlashCommand("/provider ignore deepinfra", runtime);
		expect(settings.get("providers.openrouter.ignore")).toEqual(["deepinfra"]);
		expect(output).toHaveBeenCalledWith("deepinfra is already ignored.");
	});

	it("unignore removes the slug", async () => {
		const settings = Settings.isolated();
		settings.set("providers.openrouter.ignore", ["deepinfra", "together"]);
		const { output, runtime } = acpRuntime(settings);
		await executeAcpBuiltinSlashCommand("/provider unignore deepinfra", runtime);
		expect(settings.get("providers.openrouter.ignore")).toEqual(["together"]);
		expect(output).toHaveBeenCalledWith("Removed deepinfra from the ignore list — effective on the next request.");
	});

	it("unignore on a missing slug says so", async () => {
		const settings = Settings.isolated();
		const { output, runtime } = acpRuntime(settings);
		await executeAcpBuiltinSlashCommand("/provider unignore deepinfra", runtime);
		expect(output).toHaveBeenCalledWith("deepinfra is not in the ignore list.");
	});

	it("rejects malformed invocations with usage", async () => {
		const settings = Settings.isolated();
		const { output, runtime } = acpRuntime(settings);
		await executeAcpBuiltinSlashCommand("/provider ignore", runtime);
		expect(output).toHaveBeenCalledWith("Usage: /provider [ignore <slug>|unignore <slug>]");
	});
});

describe("/provider table", () => {
	it("renders rolling stats joined with OpenRouter endpoint perf and the ignored flag", async () => {
		const settings = Settings.isolated();
		settings.set("providers.openrouter.ignore", ["google-vertex"]);
		const tracker = slowTracker();
		const text = await runProviderCommand("", {
			settings,
			session: { settings, model: openRouterModel } as unknown as SlashCommandRuntime["session"],
			tracker,
			endpointCache: new OpenRouterEndpointStatsCache(),
			fetchImpl: endpointsFetch(),
		});

		const lines = text.split("\n");
		expect(lines[0]).toBe("Routing: ignore=google-vertex");
		expect(lines[1]).toContain("slug");
		const bedrock = lines.find(line => line.startsWith("amazon-bedrock"));
		expect(bedrock).toBeDefined();
		// 4 turns, median of 5,6,7,8 → 6.5 tok/s; ttft p50 of 100..400 → 250ms;
		// OpenRouter-reported 45 tok/s + 989ms latency from the fixture.
		expect(bedrock).toContain("4");
		expect(bedrock).toContain("6.5");
		expect(bedrock).toContain("250ms");
		expect(bedrock).toContain("45.0");
		expect(bedrock).toContain("989ms");
		const vertex = lines.find(line => line.startsWith("google-vertex"));
		expect(vertex).toContain("ignored");
	});

	it("renders configured routing preferences in the header line", async () => {
		const settings = Settings.isolated();
		settings.set("providers.openrouter.sort", "throughput");
		settings.set("providers.openrouter.only", ["anthropic"]);
		const text = await runProviderCommand("", {
			settings,
			session: { settings, model: undefined } as unknown as SlashCommandRuntime["session"],
			tracker: new RoutingStatsTracker({ hydrate: false }),
		});
		expect(text.split("\n")[0]).toBe("Routing: sort=throughput only=anthropic");
	});

	it("shows ignored slugs that have no recorded turns", async () => {
		const settings = Settings.isolated();
		settings.set("providers.openrouter.ignore", ["deepinfra"]);
		const text = await runProviderCommand("", {
			settings,
			session: { settings, model: undefined } as unknown as SlashCommandRuntime["session"],
			tracker: new RoutingStatsTracker({ hydrate: false }),
		});
		const row = text.split("\n").find(line => line.startsWith("deepinfra"));
		expect(row).toBeDefined();
		expect(row).toContain("ignored");
	});

	it("degrades to a note when the endpoint fetch fails", async () => {
		const settings = Settings.isolated();
		const failingFetch = vi.fn(async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
		const text = await runProviderCommand("", {
			settings,
			session: { settings, model: openRouterModel } as unknown as SlashCommandRuntime["session"],
			tracker: slowTracker(),
			endpointCache: new OpenRouterEndpointStatsCache(),
			fetchImpl: failingFetch,
		});
		expect(text).toContain("OpenRouter endpoint stats unavailable: OpenRouter endpoints request failed: HTTP 503");
		// Local stats still render.
		expect(text).toContain("amazon-bedrock");
	});

	it("reports when nothing has been recorded yet", async () => {
		const settings = Settings.isolated();
		const text = await runProviderCommand("", {
			settings,
			session: { settings, model: undefined } as unknown as SlashCommandRuntime["session"],
			tracker: new RoutingStatsTracker({ hydrate: false }),
		});
		expect(text).toContain("No upstream provider turns recorded yet.");
	});
});

describe("/provider persistence", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-provider-cmd-test-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(getProjectAgentDir(projectDir), { recursive: true });
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		AgentStorage.resetInstance();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		await tempDir.remove();
	});

	it("writes the ignore list to config.yml so the ban survives restarts", async () => {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const { runtime } = acpRuntime(settings);

		await executeAcpBuiltinSlashCommand("/provider ignore deepinfra", runtime);

		const saved = YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as Record<string, unknown>;
		const providers = saved.providers as Record<string, unknown>;
		const openrouter = providers.openrouter as Record<string, unknown>;
		expect(openrouter.ignore).toEqual(["deepinfra"]);

		// And a fresh Settings instance over the same directory sees the ban.
		AgentStorage.resetInstance();
		const reloaded = await Settings.init({ cwd: projectDir, agentDir });
		expect(reloaded.get("providers.openrouter.ignore")).toEqual(["deepinfra"]);
	});
});
