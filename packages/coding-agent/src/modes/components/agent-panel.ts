/**
 * Agent panel — a persistent live panel anchored below the prompt editor
 * (after the hook-widget container) listing the live (running | idle)
 * subagents from the running-subagent badge registry. Rows are rendered by
 * the shared {@link formatAgentRow}, so the panel and the Agent Hub always
 * agree on how an agent looks.
 *
 * The panel is mounted by InteractiveMode only while at least one live
 * subagent exists (or the observer registry still reports an active subagent
 * session); with zero rows it renders nothing and the anchoring container is
 * cleared. While any sibling row is running, idle rows are ANSI-dimmed so
 * finished work recedes behind in-flight work.
 *
 * Focus: alt+↓ / ctrl+↓ from the editor (wired in InputController) routes
 * keys here via `ui.setFocus(panel)`. ↑/k and ↓/j move the selection, Enter
 * focuses the main view on the agent's live session (SessionFocusController,
 * which revives parked agents via ensureLive) or opens the sendable
 * transcript viewer for historical rows, Esc interrupts the selected agent's
 * CURRENT TURN (`session.abort` — never the hub's `x` kill/release), and ←
 * (or Esc with nothing interruptible selected) returns focus to the editor.
 */
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { type Component, Container, matchesKey, type OverlayHandle, type TUI } from "@oh-my-pi/pi-tui";
import { getProjectDir, logger } from "@oh-my-pi/pi-utils";
import type { KeyId } from "../../config/keybindings";
import type { MessageRenderer } from "../../extensibility/extensions/types";
import { IrcBus } from "../../irc/bus";
import type { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import type { AgentRef, AgentRegistry, AgentStatus } from "../../registry/agent-registry";
import { USER_INTERRUPT_LABEL } from "../../session/messages";
import type { SessionObserverRegistry } from "../session-observer-registry";
import { theme } from "../theme/theme";
import {
	matchesAppInterrupt,
	matchesSelectConfirm,
	matchesSelectDown,
	matchesSelectUp,
} from "../utils/keybinding-matchers";
import type { AgentHubRemote } from "./agent-hub";
import { formatAgentRow } from "./agent-row";
import { AgentTranscriptViewer } from "./agent-transcript-viewer";
import { keyHint, rawKeyHint } from "./keybinding-hints";

/** Max agent rows before the overflow summary — mirrors SUBAGENT_HUD_VISIBLE_LIMIT. */
export const AGENT_PANEL_VISIBLE_LIMIT = 8;

const STATUS_ORDER: Record<AgentStatus, number> = { running: 0, idle: 1, parked: 2, aborted: 3 };

/**
 * ANSI-dim a composite row line. `chalk.bold` segments close with `\x1b[22m`,
 * which also clears the dim attribute, so dim is re-asserted after every such
 * reset to keep the whole line dimmed. Inner foreground resets (`\x1b[39m`)
 * do not touch the dim attribute.
 */
function dimLine(line: string): string {
	return `\x1b[2m${line.replaceAll("\x1b[22m", "\x1b[22m\x1b[2m")}\x1b[22m`;
}

export interface AgentPanelDeps {
	/** Live agent source (badge registry: local global or collab guest's). Accessor so collab swaps retarget. */
	getRegistry: () => AgentRegistry;
	/** Progress/status snapshot source — the same observer registry the subagent HUD reads. */
	observers: SessionObserverRegistry;
	/** Unread badge source; defaults to the process-global bus. */
	irc?: IrcBus;
	/** TUI handle for focus routing and the transcript overlay; tests pass a stub. */
	ui: TUI;
	/** Focus return target (the prompt editor). */
	editor: Component;
	requestRender: () => void;
	/**
	 * Focus the main view on an agent's live session (InteractiveMode.focusAgentSession,
	 * delegating to SessionFocusController). Absent for collab guests and tests —
	 * Enter then opens the transcript viewer instead (hub `#activateAgent` precedent).
	 */
	focusAgent?: (id: string) => Promise<void>;
	/** Collab guest: route transcript reads to the host instead of local session files. Accessor because the guest link attaches after construction. */
	remote?: () => AgentHubRemote | undefined;
	/** Revive+prompt path for the transcript viewer. Lazy to avoid touching the global. */
	lifecycle?: () => AgentLifecycleManager;
	/** Tool lookup for transcript renderers (labels, custom render functions). */
	getTool?: (name: string) => AgentTool | undefined;
	/** Extension message renderers for custom messages in the transcript. */
	getMessageRenderer?: (customType: string) => MessageRenderer | undefined;
	/** Cwd used by tool renderers for path shortening; defaults to the project dir. */
	cwd?: string;
	/** Mirrors the main transcript's thinking-block visibility. */
	hideThinkingBlock?: () => boolean;
	proseOnlyThinking?: () => boolean;
	/** Live key reads (app.tools.expand / hub toggles) so a mid-session rebind is honored. */
	expandKeys?: () => KeyId[];
	hubKeys?: () => KeyId[];
}

export class AgentPanelComponent extends Container {
	/** TUI focus flag (Focusable): set by `ui.setFocus`. Gates the selection cursor + hint line. */
	focused = false;

	readonly #deps: AgentPanelDeps;
	readonly #irc: IrcBus;
	#rows: AgentRef[] = [];
	/** Selection tracked by id so a status-driven reorder keeps the highlight on the same agent. */
	#selectedId: string | undefined;

	// Fullscreen transcript overlay opened by openChat(), if any.
	#transcriptOverlay: OverlayHandle | undefined;
	#transcriptViewer: AgentTranscriptViewer | undefined;

	constructor(deps: AgentPanelDeps) {
		super();
		this.#deps = deps;
		this.#irc = deps.irc ?? IrcBus.global();
	}

	/** Whether the panel currently has no agents to show. */
	get isEmpty(): boolean {
		return this.#rows.length === 0;
	}

	/** Ids of the current rows, in display order (test introspection). */
	get rowIds(): string[] {
		return this.#rows.map(ref => ref.id);
	}

	/**
	 * Replace the row set with the caller's live-subagent filter. Rows are
	 * grouped by status (running first, mirroring the hub's STATUS_ORDER) and
	 * keep spawn order within a group so the list never reshuffles under
	 * progress heartbeats. The selection follows its agent id across refreshes
	 * and falls back to the first row when its agent leaves.
	 */
	setAgents(refs: AgentRef[]): void {
		this.#rows = [...refs].sort(
			(a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.createdAt - b.createdAt,
		);
		if (!this.#rows.some(ref => ref.id === this.#selectedId)) {
			this.#selectedId = this.#rows[0]?.id;
		}
	}

	override render(width: number): readonly string[] {
		if (this.#rows.length === 0) return [];
		const running = this.#rows.filter(ref => ref.status === "running").length;
		const idle = this.#rows.length - running;
		const counts: string[] = [];
		if (running > 0) counts.push(`${running} running`);
		if (idle > 0) counts.push(`${idle} idle`);
		const header = [` ${theme.bold(theme.fg("accent", "Agents"))}`];
		if (counts.length > 0) header.push(theme.fg("dim", counts.join(theme.sep.dot)));
		if (!this.focused) header.push(theme.fg("dim", "alt+↓ focus"));
		const lines: string[] = ["", header.join(theme.fg("dim", theme.sep.dot))];

		const visible = this.#rows.slice(0, AGENT_PANEL_VISIBLE_LIMIT);
		for (const ref of visible) {
			const selected = this.focused && ref.id === this.#selectedId;
			let entry = formatAgentRow(ref, this.#deps.observers.getSession(ref.id), selected, width, this.#irc);
			// Idle rows recede while a sibling is running; with nothing in flight
			// every row renders at full brightness.
			if (running > 0 && ref.status === "idle") {
				entry = entry.map(dimLine);
			}
			lines.push(...entry);
		}
		const hidden = this.#rows.length - visible.length;
		if (hidden > 0) {
			lines.push(` ${theme.fg("dim", `… ${hidden} more — open Agent Hub`)}`);
		}
		if (this.focused) {
			const hints = [
				rawKeyHint("↑/↓", "select"),
				keyHint("tui.select.confirm", "open"),
				rawKeyHint("Esc", "interrupt"),
				rawKeyHint("←", "editor"),
			].join(theme.fg("dim", "  "));
			lines.push(` ${hints}`);
		}
		return lines;
	}

	handleInput(keyData: string): void {
		if (matchesKey(keyData, "j") || matchesSelectDown(keyData)) {
			this.#moveSelection(1);
			return;
		}
		if (matchesKey(keyData, "k") || matchesSelectUp(keyData)) {
			this.#moveSelection(-1);
			return;
		}
		if (matchesSelectConfirm(keyData) || keyData === "\r" || keyData === "\n") {
			const selected = this.#selectedRef();
			if (selected) this.#activate(selected);
			return;
		}
		if (matchesKey(keyData, "left")) {
			this.#exitToEditor();
			return;
		}
		if (matchesAppInterrupt(keyData)) {
			const selected = this.#selectedRef();
			if (selected?.status === "running" && selected.session) {
				// Interrupt the selected agent's CURRENT TURN. This is deliberately
				// NOT the hub's `x` kill path: no lifecycle release, no tombstone —
				// the agent stays live and keeps its session.
				void selected.session.abort({ reason: USER_INTERRUPT_LABEL }).catch((error: unknown) => {
					logger.warn("Agent panel: interrupt failed", { id: selected.id, error: String(error) });
				});
			} else {
				// Nothing with a current turn selected — Esc falls through to focus exit.
				this.#exitToEditor();
			}
			return;
		}
	}

	/**
	 * Open the fullscreen transcript viewer for an agent id — the same sendable
	 * viewer the hub mounts (steer prompts revive+prompt through the lifecycle).
	 * No-op without a real TUI (render-only test stub).
	 */
	openChat(id: string): void {
		const registry = this.#deps.getRegistry();
		if (!registry.get(id)) return;
		if (typeof this.#deps.ui.showOverlay !== "function") return;
		this.#closeTranscriptOverlay();
		const remote = this.#deps.remote?.();
		const viewer = new AgentTranscriptViewer({
			agentId: id,
			registry,
			remote,
			observers: this.#deps.observers,
			lifecycle: remote ? undefined : this.#deps.lifecycle,
			ui: this.#deps.ui,
			getTool: this.#deps.getTool,
			getMessageRenderer: this.#deps.getMessageRenderer,
			cwd: this.#deps.cwd ?? getProjectDir(),
			hideThinkingBlock: this.#deps.hideThinkingBlock,
			proseOnlyThinking: this.#deps.proseOnlyThinking,
			expandKeys: this.#deps.expandKeys?.() ?? ["ctrl+o"],
			hubKeys: this.#deps.hubKeys?.() ?? [],
			requestRender: this.#deps.requestRender,
			onClose: () => this.#closeTranscriptOverlay(),
			onHubClose: () => {
				this.#closeTranscriptOverlay();
				this.#exitToEditor();
			},
		});
		this.#transcriptViewer = viewer;
		this.#transcriptOverlay = this.#deps.ui.showOverlay(viewer, { width: "100%", margin: 0, fullscreen: true });
		this.#deps.ui.setFocus(viewer);
		this.#deps.requestRender();
	}

	/** Tear down the transcript overlay, if any. Called by the mode on stop. */
	override dispose(): void {
		this.#transcriptOverlay?.hide();
		this.#transcriptOverlay = undefined;
		this.#transcriptViewer?.dispose();
		this.#transcriptViewer = undefined;
	}

	#selectedRef(): AgentRef | undefined {
		return this.#rows.find(ref => ref.id === this.#selectedId);
	}

	#moveSelection(delta: -1 | 1): void {
		if (this.#rows.length === 0) return;
		const index = this.#rows.findIndex(ref => ref.id === this.#selectedId);
		const next = Math.min(Math.max((index < 0 ? 0 : index) + delta, 0), this.#rows.length - 1);
		this.#selectedId = this.#rows[next]?.id;
		this.#deps.requestRender();
	}

	/**
	 * Enter on a row: focus the main view on the agent's live session and hand
	 * focus back to the editor (hub `#activateAgent` precedent — ensureLive
	 * inside revives parked agents). Without a focus path (collab guest, tests)
	 * the sendable transcript viewer opens instead.
	 */
	#activate(ref: AgentRef): void {
		const focusAgent = this.#deps.focusAgent;
		if (ref.kind === "advisor" || this.#deps.remote?.() || !focusAgent) {
			this.openChat(ref.id);
			return;
		}
		void (async () => {
			try {
				await focusAgent(ref.id);
				this.#exitToEditor();
			} catch (error) {
				logger.warn("Agent panel: focus failed", { id: ref.id, error: String(error) });
			}
		})();
	}

	/** Close and dispose the transcript overlay, restoring focus to the panel. */
	#closeTranscriptOverlay(): void {
		this.#transcriptOverlay?.hide();
		this.#transcriptOverlay = undefined;
		this.#transcriptViewer?.dispose();
		this.#transcriptViewer = undefined;
		if (typeof this.#deps.ui.setFocus === "function") this.#deps.ui.setFocus(this);
		this.#deps.requestRender();
	}

	#exitToEditor(): void {
		this.#deps.ui.setFocus(this.#deps.editor);
		this.#deps.requestRender();
	}
}
