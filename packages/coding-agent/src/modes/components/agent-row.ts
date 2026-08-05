/**
 * Shared agent row renderer — the single source of truth for how one agent
 * appears in the Agent Hub table and the interactive agent panel. Extracted
 * from AgentHubOverlayComponent.#renderEntry so both surfaces render
 * byte-identical rows for the same ref + observer snapshot.
 *
 * One agent entry, 1-2 lines:
 * `❯ ⟳ Name  type  ↳ parent  ⧉ 2 ········ model ◒ level · age` — identity
 * left, metadata right-aligned (inlined when the terminal is too narrow) —
 * plus an indented dim task line when the agent's work is known. Running
 * agents show a ticking elapsed-since-start (`⏱ 3m12s`) instead of age.
 */
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import { padding, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatAge, formatDuration, sanitizeText } from "@oh-my-pi/pi-utils";
import type { IrcBus } from "../../irc/bus";
import { type AgentRef, type AgentStatus, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { parseThinkingLevel } from "../../thinking";
import { replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession } from "../session-observer-registry";
import { theme } from "../theme/theme";

/** Max width for the current-tool name on a running row's meta segment. */
const AGENT_ROW_CURRENT_TOOL_MAX = 24;

/** Compute the max content width for the current terminal, accounting for chrome. */
function contentWidth(): number {
	return Math.max(TRUNCATE_LENGTHS.SHORT, (process.stdout.columns || 80) - 6);
}

/** Sanitize a line for TUI display: replace tabs, then truncate to viewport width. */
export function sanitizeLine(text: string, maxWidth?: number): string {
	const singleLine = replaceTabs(text).replace(/[\r\n]+/g, " ");
	return truncateToWidth(singleLine, maxWidth ?? contentWidth());
}

/** Status glyph, colored per theme status conventions. The title-line counts spell out the words. */
function statusGlyph(status: AgentStatus): string {
	switch (status) {
		case "running":
			return theme.fg("accent", theme.status.running);
		case "idle":
			return theme.fg("success", theme.status.enabled);
		case "parked":
			return theme.fg("muted", theme.status.shadowed);
		case "aborted":
			return theme.fg("error", theme.status.aborted);
	}
}

/** Model id + thinking level (`sonnet-4-6 ◒ high`), level colored per theme. */
function formatModelBadge(modelId: string, level: ThinkingLevel | undefined): string {
	const model = theme.fg("muted", replaceTabs(modelId));
	if (!level || level === ThinkingLevel.Off || level === ThinkingLevel.Inherit) return model;
	const display = theme.thinking[level as keyof typeof theme.thinking] ?? level;
	return `${model} ${theme.getThinkingBorderColor(level)(display)}`;
}

/** Format a resolved selector, preserving provider identity when requested. */
function formatResolvedModelBadge(resolved: string, preserveProvider = false): string {
	// Model ids may themselves contain colons (`qwen3:14b`), so only treat the
	// suffix as a thinking level when it parses as one.
	const colon = resolved.lastIndexOf(":");
	const level = colon >= 0 ? parseThinkingLevel(resolved.slice(colon + 1)) : undefined;
	const selector = level !== undefined ? resolved.slice(0, colon) : resolved;
	const label = preserveProvider ? selector : selector.slice(selector.indexOf("/") + 1);
	return formatModelBadge(label, level);
}

/**
 * Active model + reasoning level for a row: live session state when the
 * agent is attached, else the executor-reported `resolvedModel` selector
 * (`provider/id`, optionally `:<level>`). Active retry fallbacks retain their
 * provider and carry an explicit marker. Undefined when no model is known
 * (e.g. a parked historical agent restored from disk).
 */
function modelBadge(ref: AgentRef, observed: ObservableSession | undefined): string | undefined {
	const progress = observed?.progress;
	// Prefer the live session's own resolved fallback selector; else honor the
	// executor-reported fallback flag. The latter covers observer-only rows (no
	// live session) AND live rows whose fallback armed no session retry state —
	// e.g. the Fireworks Fast → base degrade, which emits `retry_fallback_applied`
	// without populating `#activeRetryFallback`, so `retryFallbackModel` is undefined.
	const fallbackSelector =
		ref.session?.retryFallbackModel ?? (progress?.resolvedModelIsFallback ? progress.resolvedModel : undefined);
	if (fallbackSelector) {
		return `${theme.fg("warning", "fallback →")} ${formatResolvedModelBadge(fallbackSelector, true)}`;
	}
	const model = ref.session?.model;
	if (model) {
		const level = model.thinking ? ref.session?.thinkingLevel : undefined;
		return formatModelBadge(model.id, level);
	}
	const resolved = progress?.resolvedModel;
	return resolved ? formatResolvedModelBadge(resolved) : undefined;
}

/**
 * One agent row, 1-2 lines — identity left, metadata right-aligned (inlined
 * when the terminal is too narrow), plus an indented muted task line when the
 * agent's work is known. `observed` is the caller-resolved observer snapshot
 * for `ref.id` (hub: `#observableFor`, panel: `observers.getSession`); `irc`
 * supplies the unread-count badge. Running agents show a ticking
 * elapsed-since-start (`⏱ 3m12s`) instead of age.
 */
export function formatAgentRow(
	ref: AgentRef,
	observed: ObservableSession | undefined,
	selected: boolean,
	width: number,
	irc: IrcBus,
): string[] {
	const max = Math.max(1, width - 2);
	const cursor = selected ? theme.fg("accent", theme.nav.cursor) : " ";
	const fields: string[] = [`${cursor} ${statusGlyph(ref.status)} ${theme.bold(replaceTabs(ref.id))}`];
	if (ref.displayName && ref.displayName !== ref.id) {
		// displayName is model-chosen at spawn; strip control bytes before render.
		fields.push(theme.fg("dim", replaceTabs(sanitizeText(ref.displayName))));
	}
	if (ref.parentId && ref.parentId !== MAIN_AGENT_ID) {
		fields.push(theme.fg("dim", `↳ ${replaceTabs(ref.parentId)}`));
	}
	if (ref.kind === "advisor") {
		fields.push(theme.fg("warning", "read-only"));
	}
	const unread = irc.unreadCount(ref.id);
	if (unread > 0) {
		fields.push(theme.fg("warning", `⧉ ${unread}`));
	}
	const left = ` ${fields.join("  ")}`;

	const meta: string[] = [];
	const badge = modelBadge(ref, observed);
	if (badge) meta.push(badge);
	if (ref.status === "running") {
		// Live elapsed-since-start, ticking via the caller's repaint cadence.
		// Age-since-activity is pinned at "just now" by running heartbeats, so it
		// carries no information here. Prefer the executor-reported run start
		// (fresh after a revive or follow-up turn) over the ref's registration time.
		const startMs = observed?.progress?.startedAtMs ?? ref.createdAt;
		meta.push(theme.fg("dim", `${theme.icon.time} ${formatDuration(Math.max(0, Date.now() - startMs))}`));
		// Live progress: the tool currently in flight plus the run's accrued
		// cost, formatted like the inline task rows' stats segment.
		const progress = observed?.progress;
		if (progress?.currentTool) {
			meta.push(
				theme.fg(
					"dim",
					truncateToWidth(replaceTabs(sanitizeText(progress.currentTool)), AGENT_ROW_CURRENT_TOOL_MAX),
				),
			);
		}
		if (progress && progress.cost > 0) {
			meta.push(theme.fg("statusLineCost", `$${progress.cost.toFixed(2)}`));
		}
	} else {
		meta.push(theme.fg("dim", formatAge(Math.max(1, Math.round((Date.now() - ref.lastActivity) / 1000)))));
	}
	const right = meta.join(theme.sep.dot);

	const leftWidth = visibleWidth(left);
	const rightWidth = visibleWidth(right);
	const line =
		leftWidth + 2 + rightWidth <= max
			? left + padding(max - leftWidth - rightWidth) + right
			: truncateToWidth(`${left}  ${right}`.replace(/[\r\n]+/g, " "), max);
	const entry = [line];

	const task = observed?.description ?? observed?.progress?.task ?? ref.activity;
	if (task) {
		// Model/collab-chosen text: strip control bytes (sanitizeText) before
		// the single-line/truncate pass, mirroring displayName/currentTool.
		entry.push(`     ${theme.fg("muted", sanitizeLine(sanitizeText(task), Math.max(10, max - 5)))}`);
	}
	return entry;
}
