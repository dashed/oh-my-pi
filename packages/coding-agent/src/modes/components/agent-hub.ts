/**
 * Agent Hub overlay component.
 *
 * One overlay, two views:
 * - Table view: every registered agent except Main (Main IS the ambient
 *   chat), live from the global AgentRegistry — status, unread irc count,
 *   current/last task, last activity. Select with j/k, Enter opens a chat,
 *   `r` revives a parked agent, `x` aborts + releases one.
 * - Chat view: per-agent transcript (incremental session-file tail, absorbed
 *   from the old session observer overlay) plus an input line. Submitting
 *   revives a parked agent, then prompts/steers it; the message lands in the
 *   agent's persisted history via the normal prompt path.
 *
 * Replaces the old SessionObserverOverlayComponent (ctrl+s observer).
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Container, Ellipsis, matchesKey, type OverlayHandle, type TUI } from "@oh-my-pi/pi-tui";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { IrcBus } from "../../irc/bus";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { type AgentRef, AgentRegistry, type AgentStatus, MAIN_AGENT_ID } from "../../registry/agent-registry";
import { registerPersistedSubagents } from "../../registry/persisted-agents";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import { truncateToWidth } from "../../tools/render-utils";
import type { ObservableSession, SessionObserverRegistry } from "../session-observer-registry";
import { theme } from "../theme/theme";
import {
	matchesAppInterrupt,
	matchesSelectConfirm,
	matchesSelectDown,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import { formatAgentRow, sanitizeLine } from "./agent-row";
import { AgentTranscriptViewer } from "./agent-transcript-viewer";
import { DynamicBorder } from "./dynamic-border";
import { editorKey, keyHint, rawKeyHint } from "./keybinding-hints";

/** Refresh cadence for the relative-time column */
const AGE_TICK_MS = 5_000;
const DATA_CHANGE_RENDER_COALESCE_MS = 100;
/** Double-tap window for the table's left-left "close hub" gesture. */
const LEFT_TAP_WINDOW_MS = 500;

function clampHubLine(line: string, width: number): string {
	return truncateToWidth(line.replace(/[\r\n]+/g, " "), Math.max(1, width - 2), Ellipsis.Omit);
}

const STATUS_ORDER: Record<AgentStatus, number> = { running: 0, idle: 1, parked: 2, aborted: 3 };

/** Result of one host-backed transcript read for the Agent Hub viewer. */
export interface AgentHubRemoteTranscript {
	text: string;
	newSize: number;
	/** Terminal read failure reported by the host; guests should surface it instead of retrying hot. */
	error?: string;
}

/** Guest-side proxy for hub actions executed on the collab host. */
export interface AgentHubRemote {
	chat(id: string, text: string): void;
	kill(id: string): void;
	revive(id: string): void;
	/** Mirrors readFileIncremental: text from fromByte (complete JSONL lines), newSize = next fromByte base; null = temporarily unavailable. */
	readTranscript(id: string, fromByte: number): Promise<AgentHubRemoteTranscript | null>;
}

export interface AgentHubDeps {
	/** Progress/status snapshot source (task lifecycle + progress channels). */
	observers: SessionObserverRegistry;
	/** Keys that toggle the hub closed from inside (app.agents.hub + app.session.observe). */
	hubKeys: KeyId[];
	onDone: () => void;
	requestRender: () => void;
	/** Injectable for tests; defaults to the process-global registry. */
	registry?: AgentRegistry;
	/** Injectable for tests; defaults to the process-global lifecycle manager. */
	lifecycle?: AgentLifecycleManager;
	/** Injectable for tests; defaults to the process-global bus. */
	irc?: IrcBus;
	/** TUI handle for transcript components; tests omit it and get a render-only stub. */
	ui?: TUI;
	/** Tool lookup for transcript renderers (labels, custom render functions). */
	getTool?: (name: string) => AgentTool | undefined;
	/** Extension message renderers for custom messages in the transcript. */
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	/** Cwd used by tool renderers for path shortening; defaults to the project dir. */
	cwd?: string;
	/** Mirrors the main transcript's thinking-block visibility. */
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	/** Keys toggling tool output expansion (app.tools.expand). */
	expandKeys?: KeyId[];
	/** Focus the main view on this agent's live session (ctx.focusAgentSession). When absent (collab guest, tests), Enter opens the in-hub chat view instead. */
	focusAgent?: (id: string) => Promise<void>;
	/** Current main session file; used to seed parked historical subagents after restart. */
	sessionFile?: string | null;
	/** Collab guest: route actions/transcripts to the host instead of local sessions. */
	remote?: AgentHubRemote;
}

export class AgentHubOverlayComponent extends Container {
	#registry: AgentRegistry;
	#observers: SessionObserverRegistry;
	#irc: IrcBus;
	#lifecycle: () => AgentLifecycleManager;
	#onDone: () => void;
	#requestRender: () => void;
	#hubKeys: KeyId[];
	#unsubscribers: Array<() => void> = [];
	#ageTimer: NodeJS.Timeout | undefined;
	#dataChangeTimer?: NodeJS.Timeout;
	#remote: AgentHubRemote | undefined;
	/** Resolves after persisted historical subagents have been registered and rows refreshed. */
	readonly persistedSubagentsReady: Promise<void>;

	// Table state
	#rows: AgentRef[] = [];
	#statusCounts: Record<AgentStatus, number> = { running: 0, idle: 0, parked: 0, aborted: 0 };
	#selectedRow = 0;
	#notice: string | undefined;
	/** Captured row order from the first refresh; keeps the hub stable while open. */
	#rowOrder: Map<string, number> | undefined;
	/** Double-tap window state for the table's left-left "close hub" gesture. */
	#lastLeftTap = 0;

	// Transcript-viewer launch deps (passed through to AgentTranscriptViewer).
	#ui: TUI;
	#getTool: ((name: string) => AgentTool | undefined) | undefined;
	#getMessageRenderer: ((customType: string) => MessageRenderer | undefined) | undefined;
	#cwd: string;
	#hideThinkingBlock: (() => boolean) | undefined;
	#proseOnlyThinking: (() => boolean) | undefined;
	#expandKeys: KeyId[];
	#focusAgent: ((id: string) => Promise<void>) | undefined;

	// Fullscreen transcript overlay opened by openChat(), if any.
	#transcriptOverlay: OverlayHandle | undefined;
	#transcriptViewer: AgentTranscriptViewer | undefined;

	constructor(deps: AgentHubDeps) {
		super();
		this.#registry = deps.registry ?? AgentRegistry.global();
		this.#observers = deps.observers;
		this.#irc = deps.irc ?? IrcBus.global();
		// Lazy: the lifecycle global self-constructs against the global
		// registry, so only touch it when revive/kill actually needs it.
		this.#lifecycle = () => deps.lifecycle ?? AgentLifecycleManager.global();
		this.#onDone = deps.onDone;
		this.#requestRender = deps.requestRender;
		this.#hubKeys = deps.hubKeys;
		this.#remote = deps.remote;
		this.#ui =
			deps.ui ??
			({
				requestRender: () => deps.requestRender(),
				requestComponentRender: () => deps.requestRender(),
			} as unknown as TUI);
		this.#getTool = deps.getTool;
		this.#getMessageRenderer = deps.getMessageRenderer;
		this.#cwd = deps.cwd ?? getProjectDir();
		this.#hideThinkingBlock = deps.hideThinkingBlock;
		this.#proseOnlyThinking = deps.proseOnlyThinking;
		this.#expandKeys = deps.expandKeys ?? ["ctrl+o"];
		this.#focusAgent = deps.focusAgent;

		this.#unsubscribers.push(this.#registry.onChange(() => this.#scheduleDataChange()));
		this.#unsubscribers.push(this.#observers.onChange(() => this.#scheduleDataChange()));
		this.#ageTimer = setInterval(() => this.#requestRender(), AGE_TICK_MS);
		this.#ageTimer.unref?.();

		this.persistedSubagentsReady = this.#remote
			? Promise.resolve()
			: registerPersistedSubagents(this.#registry, deps.sessionFile)
					.catch((error: unknown) => {
						logger.warn("Failed to register persisted subagents", { error });
					})
					.then(() => {
						this.#refreshRows();
					})
					.finally(() => this.#requestRender());
		this.#refreshRows();
	}

	/**
	 * Whether the current table view has no agents to show (every registered agent
	 * except Main). Persisted historical rows may arrive later; callers that need
	 * those included must wait for {@link persistedSubagentsReady} first.
	 */
	get isEmpty(): boolean {
		return this.#rows.length === 0;
	}

	/** Tear down every subscription and timer. Called by the overlay owner on close. */
	override dispose(): void {
		for (const unsubscribe of this.#unsubscribers.splice(0)) unsubscribe();
		if (this.#ageTimer) {
			clearInterval(this.#ageTimer);
			this.#ageTimer = undefined;
		}
		if (this.#dataChangeTimer) {
			clearTimeout(this.#dataChangeTimer);
			this.#dataChangeTimer = undefined;
		}
		this.#closeTranscriptOverlay();
	}

	override render(width: number): readonly string[] {
		return this.#renderTable(width).map(line => clampHubLine(line, width));
	}

	handleInput(keyData: string): void {
		// The hub/observe keys always close the overlay (toggle semantics)
		for (const key of this.#hubKeys) {
			if (matchesKey(keyData, key)) {
				this.#onDone();
				return;
			}
		}
		this.#handleTableInput(keyData);
	}

	/**
	 * Seed the table's left-left close detector with the current time so a single
	 * subsequent `←` (within {@link LEFT_TAP_WINDOW_MS}) dismisses the hub.
	 *
	 * The editor's own double-tap detector consumes the `←←` that opens the hub,
	 * leaving this detector at its fresh `0` — without this handoff the user would
	 * have to press `←←` a second time to escape. Called by the opener when the hub
	 * was raised by that gesture.
	 */
	armCloseTap(): void {
		this.#lastLeftTap = Date.now();
	}

	/**
	 * Open the fullscreen transcript viewer for an agent id (public for table Enter
	 * and tests). Mounts {@link AgentTranscriptViewer} as a `fullscreen` overlay so it
	 * owns the alternate screen; the hub table stays mounted underneath and is
	 * restored when the viewer closes. No-op without a real TUI (render-only test stub).
	 */
	openChat(id: string): void {
		if (!this.#registry.get(id)) return;
		if (typeof this.#ui.showOverlay !== "function") return;
		this.#closeTranscriptOverlay();
		this.#notice = undefined;
		const viewer = new AgentTranscriptViewer({
			agentId: id,
			registry: this.#registry,
			remote: this.#remote,
			observers: this.#observers,
			lifecycle: this.#remote ? undefined : this.#lifecycle,
			ui: this.#ui,
			getTool: this.#getTool,
			getMessageRenderer: this.#getMessageRenderer,
			cwd: this.#cwd,
			hideThinkingBlock: this.#hideThinkingBlock,
			proseOnlyThinking: this.#proseOnlyThinking,
			expandKeys: this.#expandKeys,
			hubKeys: this.#hubKeys,
			requestRender: this.#requestRender,
			onClose: () => this.#closeTranscriptOverlay(),
			onHubClose: () => {
				this.#closeTranscriptOverlay();
				this.#onDone();
			},
		});
		this.#transcriptViewer = viewer;
		this.#transcriptOverlay = this.#ui.showOverlay(viewer, { width: "100%", margin: 0, fullscreen: true });
		this.#ui.setFocus(viewer);
		this.#requestRender();
	}

	/** Close and dispose the transcript overlay, restoring focus to the hub table. */
	#closeTranscriptOverlay(): void {
		this.#transcriptOverlay?.hide();
		this.#transcriptOverlay = undefined;
		this.#transcriptViewer?.dispose();
		this.#transcriptViewer = undefined;
		if (typeof this.#ui.setFocus === "function") this.#ui.setFocus(this);
		this.#requestRender();
	}

	// ========================================================================
	// Live data plumbing
	// ========================================================================

	#scheduleDataChange(): void {
		if (this.#dataChangeTimer) return;
		this.#dataChangeTimer = setTimeout(() => {
			this.#dataChangeTimer = undefined;
			this.#onDataChange();
		}, DATA_CHANGE_RENDER_COALESCE_MS);
		this.#dataChangeTimer.unref?.();
	}

	#onDataChange(): void {
		this.#refreshRows();
		this.#requestRender();
	}

	#refreshRows(): void {
		const selectedId = this.#rows[this.#selectedRow]?.id;
		const refs = this.#registry.list().filter(ref => ref.id !== MAIN_AGENT_ID);
		const counts: Record<AgentStatus, number> = { running: 0, idle: 0, parked: 0, aborted: 0 };
		for (const ref of refs) counts[ref.status]++;
		this.#statusCounts = counts;

		if (!this.#rowOrder) {
			// First refresh (usually the constructor): order by status, then recency.
			this.#rows = refs.sort(
				(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity,
			);
			this.#rowOrder = new Map(this.#rows.map((ref, i) => [ref.id, i]));
		} else {
			// After the hub is open, freeze the relative order so keyboard selection
			// does not jump around as agents heartbeat or update activity. New agents
			// are appended at the end and then stay put.
			this.#rows = refs.sort((a, b) => {
				const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
				if (statusDiff !== 0) return statusDiff;
				const aOrder = this.#rowOrder!.get(a.id) ?? Number.MAX_SAFE_INTEGER;
				const bOrder = this.#rowOrder!.get(b.id) ?? Number.MAX_SAFE_INTEGER;
				return aOrder - bOrder;
			});
			for (const ref of this.#rows) {
				if (!this.#rowOrder.has(ref.id)) {
					this.#rowOrder.set(ref.id, this.#rowOrder.size);
				}
			}
		}

		const keptIndex = selectedId ? this.#rows.findIndex(ref => ref.id === selectedId) : -1;
		this.#selectedRow = keptIndex >= 0 ? keptIndex : Math.min(this.#selectedRow, Math.max(0, this.#rows.length - 1));
	}

	#observableFor(id: string): ObservableSession | undefined {
		return this.#observers.getSession(id);
	}

	// ========================================================================
	// Table view
	// ========================================================================

	#renderTable(width: number): string[] {
		const lines: string[] = [];
		lines.push(...new DynamicBorder().render(width));
		const counts = this.#statusSummary();
		lines.push(` ${theme.fg("accent", "Agent Hub")}${counts ? theme.fg("dim", `${theme.sep.dot}${counts}`) : ""}`);
		lines.push(...new DynamicBorder().render(width));

		if (this.#rows.length === 0) {
			lines.push(` ${theme.fg("dim", "no subagents yet — task spawns appear here")}`);
		} else {
			const termHeight = process.stdout.rows || 40;
			// Chrome: 2 borders + title + notice? + blank + hints + border
			const budget = Math.max(4, termHeight - 7 - (this.#notice ? 1 : 0));
			// Render outward from the selection and stop once the viewport is full.
			// Cache rendered entries so a boundary probe is not paid twice when the
			// same index is later accepted into the window.
			const rendered = new Map<number, string[]>();
			const entryAt = (index: number): string[] => {
				const cached = rendered.get(index);
				if (cached) return cached;
				const ref = this.#rows[index];
				if (!ref) return [];
				const entry = formatAgentRow(
					ref,
					this.#observableFor(ref.id),
					index === this.#selectedRow,
					width,
					this.#irc,
				);
				rendered.set(index, entry);
				return entry;
			};
			let start = this.#selectedRow;
			let end = this.#selectedRow + 1;
			let used = entryAt(start).length;
			for (let grew = true; grew; ) {
				grew = false;
				if (end < this.#rows.length) {
					const next = entryAt(end);
					if (used + next.length <= budget) {
						used += next.length;
						end++;
						grew = true;
					}
				}
				if (start > 0) {
					const previous = entryAt(start - 1);
					if (used + previous.length <= budget) {
						start--;
						used += previous.length;
						grew = true;
					}
				}
			}
			if (start > 0) {
				lines.push(` ${theme.fg("dim", `… ${start} more`)}`);
			}
			for (let i = start; i < end; i++) {
				lines.push(...entryAt(i));
			}
			if (end < this.#rows.length) {
				lines.push(` ${theme.fg("dim", `… ${this.#rows.length - end} more`)}`);
			}
		}

		if (this.#notice) {
			lines.push(` ${theme.fg("error", sanitizeLine(this.#notice, Math.max(10, width - 2)))}`);
		}
		lines.push("");
		// j/k/r/x are component-level table keys (#handleTableInput), so they stay
		// raw; open/close labels come from the live keybinding map.
		const closeLabel = `${editorKey("app.interrupt") || "Esc"}/←←`;
		const footer = [
			rawKeyHint("j/k", "select"),
			keyHint("tui.select.confirm", "open"),
			rawKeyHint("r", "revive"),
			rawKeyHint("x", "kill"),
			rawKeyHint(closeLabel, "close"),
		].join(theme.fg("dim", "  "));
		lines.push(` ${footer}`);
		lines.push(...new DynamicBorder().render(width));
		return lines;
	}

	#statusSummary(): string {
		const parts: string[] = [];
		for (const status of ["running", "idle", "parked", "aborted"] as const) {
			const count = this.#statusCounts[status];
			if (count > 0) parts.push(`${count} ${status}`);
		}
		return parts.join(theme.sep.dot);
	}

	#handleTableInput(keyData: string): void {
		if (matchesAppInterrupt(keyData)) {
			this.#onDone();
			return;
		}
		if (matchesKey(keyData, "left")) {
			const now = Date.now();
			if (now - this.#lastLeftTap < LEFT_TAP_WINDOW_MS) {
				this.#lastLeftTap = 0;
				this.#onDone();
			} else {
				this.#lastLeftTap = now;
			}
			return;
		}
		if (matchesKey(keyData, "j") || matchesSelectDown(keyData)) {
			if (this.#rows.length > 0) {
				this.#selectedRow = Math.min(this.#selectedRow + 1, this.#rows.length - 1);
			}
			this.#requestRender();
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			if (this.#rows.length > 0) {
				this.#selectedRow = Math.max(this.#selectedRow - 1, 0);
			}
			this.#requestRender();
			return;
		}
		if (matchesSelectConfirm(keyData) || keyData === "\r" || keyData === "\n") {
			const selected = this.#rows[this.#selectedRow];
			if (selected) this.#activateAgent(selected);
			return;
		}
		if (keyData === "r") {
			this.#reviveSelected();
			return;
		}
		if (keyData === "x") {
			this.#killSelected();
			return;
		}
	}

	/**
	 * Enter on a row: focus the main view on the agent's live session and close
	 * the hub. The transcript then renders through the regular session pipeline —
	 * exact parity by construction. Collab guests (no local sessions) keep the
	 * in-hub chat view.
	 */
	#activateAgent(ref: AgentRef): void {
		this.#notice = undefined;
		const focusAgent = this.#focusAgent;
		// Advisor refs are read-only transcripts with no live/ revivable session;
		// open the in-hub chat view (file-backed) instead of trying to focus one.
		if (ref.kind === "advisor" || this.#remote || !focusAgent) {
			this.openChat(ref.id);
			return;
		}
		void (async () => {
			try {
				await focusAgent(ref.id); // ensureLive inside revives parked agents; no parking, no session files
				this.#onDone();
			} catch (error) {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			}
		})();
	}

	#reviveSelected(): void {
		const ref = this.#rows[this.#selectedRow];
		if (!ref) return;
		if (ref.kind === "advisor") {
			this.#notice = `"${ref.id}" is a read-only advisor transcript — nothing to revive.`;
			this.#requestRender();
			return;
		}
		if (ref.status !== "parked") {
			this.#notice = `Agent "${ref.id}" is ${ref.status} — only parked agents can be revived.`;
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		if (this.#remote) {
			this.#remote.revive(ref.id);
			this.#requestRender();
			return;
		}
		// Fire-and-forget; failures surface as an inline notice
		this.#lifecycle()
			.ensureLive(ref.id)
			.catch((error: unknown) => {
				this.#notice = error instanceof Error ? error.message : String(error);
				this.#requestRender();
			});
		this.#requestRender();
	}

	#killSelected(): void {
		const ref = this.#rows[this.#selectedRow];
		if (!ref) return;
		if (ref.kind === "advisor") {
			this.#notice = `"${ref.id}" is a read-only advisor transcript — cannot be killed.`;
			this.#requestRender();
			return;
		}
		this.#notice = undefined;
		if (this.#remote) {
			this.#remote.kill(ref.id);
			this.#refreshRows();
			this.#requestRender();
			return;
		}
		void (async () => {
			try {
				if (ref.status === "running" && ref.session) {
					await ref.session.abort({ reason: USER_INTERRUPT_LABEL });
				}
				await this.#lifecycle().release(ref.id, ref, { tombstone: true });
			} catch (error) {
				logger.warn("Agent hub: kill failed", { id: ref.id, error: String(error) });
				this.#notice = error instanceof Error ? error.message : String(error);
			}
			this.#refreshRows();
			this.#requestRender();
		})();
	}
}
