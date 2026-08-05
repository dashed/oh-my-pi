/**
 * Live working indicator rendered in place of the old plain "Working…" loader
 * above the editor: spinner + current activity (or a rotating gerund when no
 * tool is in flight), followed by a dim stats block — elapsed time, cumulative
 * output tokens, windowed tok/s, time-to-first-token, and the upstream provider
 * an aggregator routed to (e.g. OpenRouter's `provider` field):
 *
 *   ⠋ Reading src/foo.ts… (3m 12s · ↓ 7.5k · 77.1 tok/s · ⏱ 0.8s · via DeepSeek)
 *
 * State flows in from the event controller: `beginTurn` on agent_start,
 * `recordUsage` on every assistant message_update (cumulative usage deltas),
 * `setToolActivity`/`clearToolActivity` on tool_execution start/end, and the
 * extension-facing `setMessage` override via InteractiveMode.setWorkingMessage.
 * Everything time-derived (spinner glyph, gerund rotation, elapsed) is computed
 * at render time from the clock, so a bare requestRender repaints a fresh frame.
 */
import { Text, truncateToWidth, type TUI, visibleWidth } from "@oh-my-pi/pi-tui";
import { formatNumber } from "@oh-my-pi/pi-utils";
import { type ShimmerPalette, shimmerEnabled, shimmerText } from "../theme/shimmer";
import { theme } from "../theme/theme";
import { SpeedTracker } from "./speed-tracker";
import { sharedSpinnerFrame, SPINNER_RENDER_INTERVAL_MS } from "./tool-execution";

/** Session-accent ANSI pair resolved by the host (see InteractiveMode). */
export interface WorkingMessageAccent {
	main: string;
	dim: string;
}

/**
 * Intern the shimmer palette for each `WorkingMessageAccent` so `compile()`
 * inside `shimmerSegments` sees a stable palette object between animation
 * ticks. Allocating a fresh palette literal every frame guaranteed a cache miss
 * on the Symbol-keyed compiled-ANSI slot and forced `resolveTierAnsi` to walk
 * every tier open/close for the ~30fps indicator redraw (issue #4377).
 */
const workingMessagePaletteCache = new WeakMap<WorkingMessageAccent, ShimmerPalette>();

function workingMessagePalette(accent: WorkingMessageAccent): ShimmerPalette {
	let palette = workingMessagePaletteCache.get(accent);
	if (!palette) {
		palette = { low: "dim", mid: { ansi: accent.main }, high: { ansi: accent.main }, bold: true };
		workingMessagePaletteCache.set(accent, palette);
	}
	return palette;
}

/** Fallback spinner glyphs mirroring `Loader`'s defaults. */
const DEFAULT_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

/** Shimmer repaint cadence (mirrors `Loader`'s 30fps animated path). */
const SHIMMER_RENDER_INTERVAL_MS = 1000 / 30;

/** Idle label rotation: short gerunds, one every ~3s, rendered dim. */
const WORKING_GERUNDS = [
	"Working",
	"Thinking",
	"Crafting",
	"Pondering",
	"Computing",
	"Brewing",
	"Forging",
	"Weaving",
	"Shaping",
	"Building",
	"Parsing",
	"Reasoning",
] as const;
const GERUND_ROTATE_MS = 3000;

/** Stats segments dropped in this order when the line outgrows the terminal. */
const STATS_SEGMENT_KEYS = ["elapsed", "tokens", "tps", "ttft", "provider"] as const;
type StatsSegmentKey = (typeof STATS_SEGMENT_KEYS)[number];
const STATS_SEGMENT_DROP_ORDER: readonly StatsSegmentKey[] = ["tps", "ttft", "provider"];

/** Elapsed as `12s` / `3m 12s` / `1h 4m` for the stats block. */
function formatWorkingElapsed(ms: number): string {
	const totalSeconds = Math.max(0, Math.floor(ms / 1000));
	if (totalSeconds < 60) return `${totalSeconds}s`;
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes < 60) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMinutes = minutes % 60;
	return restMinutes > 0 ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

export interface WorkingIndicatorOptions {
	/** Lazy session-accent lookup, evaluated at render time so renames/theme
	 *  changes recolor without recreating the component. */
	getAccent?: () => WorkingMessageAccent | undefined;
	spinnerFrames?: readonly string[];
}

export class WorkingIndicator extends Text {
	#ui: TUI;
	#frames: readonly string[];
	#getAccent: (() => WorkingMessageAccent | undefined) | undefined;
	#intervalId: NodeJS.Timeout | undefined;

	// Turn stats (reset by `beginTurn`).
	#startMs: number;
	#outputTokens = 0;
	#lastUsageOutput: number | undefined;
	#lastUsageTime = 0;
	#ttftMs: number | undefined;
	#upstreamProvider: string | undefined;
	#speed = new SpeedTracker();

	// Label state: extension override wins, then the most recent tool in flight,
	// then the rotating gerund.
	#customMessage: string | undefined;
	#toolActivities = new Map<string, string>();

	constructor(ui: TUI, options: WorkingIndicatorOptions = {}) {
		super("", 1, 0);
		this.#ui = ui;
		this.#frames = options.spinnerFrames && options.spinnerFrames.length > 0 ? options.spinnerFrames : DEFAULT_SPINNER_FRAMES;
		this.#getAccent = options.getAccent;
		this.#startMs = Date.now();
		this.start();
	}

	/** Reset every per-turn stat at agent_start; the label override survives
	 *  (extension working messages span turns until explicitly cleared). */
	beginTurn(now: number = Date.now()): void {
		this.#startMs = now;
		this.#outputTokens = 0;
		this.#lastUsageOutput = undefined;
		this.#lastUsageTime = 0;
		this.#ttftMs = undefined;
		this.#upstreamProvider = undefined;
		this.#speed.reset();
		this.#toolActivities.clear();
		this.#requestPaint();
	}

	/** Extension-facing label override (`setWorkingMessage`); `undefined` clears
	 *  it and restores the tool-activity/gerund label. */
	setMessage(message?: string): void {
		const next = message && message.trim().length > 0 ? message : undefined;
		if (next === this.#customMessage) return;
		this.#customMessage = next;
		this.#requestPaint();
	}

	/** Mark a tool as in flight with its formatted activity label
	 *  (`formatToolActivity` output); the most recently started tool owns the
	 *  label while several run concurrently. */
	setToolActivity(toolCallId: string, label: string | undefined): void {
		if (!label) return;
		this.#toolActivities.delete(toolCallId);
		this.#toolActivities.set(toolCallId, label);
		this.#requestPaint();
	}

	clearToolActivity(toolCallId: string): void {
		if (this.#toolActivities.delete(toolCallId)) {
			this.#requestPaint();
		}
	}

	/**
	 * Fold one cumulative assistant `usage.output` snapshot into the stats.
	 * message_update is cumulative per assistant message and a new message
	 * restarts the count, so a drop means "new message", not negative output.
	 * The first positive delta lands TTFT; per-delta rates feed the windowed
	 * tok/s gauge.
	 */
	recordUsage(outputTokens: number, upstreamProvider?: string, now: number = Date.now()): void {
		if (upstreamProvider && !this.#upstreamProvider) {
			this.#upstreamProvider = upstreamProvider;
		}
		if (!Number.isFinite(outputTokens) || outputTokens < 0) return;
		const previous = this.#lastUsageOutput;
		this.#lastUsageOutput = outputTokens;
		const delta = previous === undefined || outputTokens < previous ? outputTokens : outputTokens - previous;
		if (delta <= 0) return;
		this.#outputTokens += delta;
		if (this.#ttftMs === undefined) {
			this.#ttftMs = Math.max(0, now - this.#startMs);
		}
		const hadPreviousTime = this.#lastUsageTime > 0;
		const elapsedMs = now - this.#lastUsageTime;
		this.#lastUsageTime = now;
		if (hadPreviousTime && elapsedMs > 0) {
			this.#speed.observe((delta / elapsedMs) * 1000, now);
		}
		this.#requestPaint();
	}

	start(): void {
		if (this.#intervalId) return;
		// Shimmer needs the 30fps cadence; without it only the spinner glyph
		// moves, so the classic 80ms step is enough (mirrors `Loader`).
		const intervalMs = shimmerEnabled() ? SHIMMER_RENDER_INTERVAL_MS : SPINNER_RENDER_INTERVAL_MS;
		this.#intervalId = setInterval(() => this.#requestPaint(), intervalMs);
		this.#intervalId.unref?.();
	}

	stop(): void {
		if (this.#intervalId) {
			clearInterval(this.#intervalId);
			this.#intervalId = undefined;
		}
	}

	/** Lifecycle teardown: stop the animation timer. Idempotent. */
	dispose(): void {
		this.stop();
	}

	override render(width: number): readonly string[] {
		const now = Date.now();
		const accent = this.#getAccent?.();
		const frame = this.#frames[sharedSpinnerFrame(this.#frames.length, now)] ?? this.#frames[0] ?? "";
		const spinner = accent ? `${accent.main}${frame}\x1b[39m` : theme.fg("accent", frame);
		const label = this.#label(now);
		const paintedLabel =
			label.kind === "gerund"
				? theme.fg("dim", label.text)
				: shimmerText(label.text, theme, accent ? workingMessagePalette(accent) : undefined);
		const segments = this.#statsSegments(now);
		const compose = (kept: Array<{ key: StatsSegmentKey; text: string }>): string => {
			const stats = kept.length > 0 ? theme.fg("dim", ` (${kept.map(segment => segment.text).join(" · ")})`) : "";
			return ` ${spinner} ${paintedLabel}${stats}`;
		};
		let kept = segments;
		let line = compose(kept);
		// Graceful degradation on narrow terminals: drop tok/s, then TTFT, then
		// provider; elapsed and the token count always survive.
		for (const dropKey of STATS_SEGMENT_DROP_ORDER) {
			if (visibleWidth(line) <= width) break;
			kept = kept.filter(segment => segment.key !== dropKey);
			line = compose(kept);
		}
		if (visibleWidth(line) > width) {
			line = truncateToWidth(line, width);
		}
		return ["", line];
	}

	#label(now: number): { text: string; kind: "custom" | "activity" | "gerund" } {
		if (this.#customMessage) return { text: this.#customMessage, kind: "custom" };
		let current: string | undefined;
		for (const activity of this.#toolActivities.values()) current = activity;
		if (current) return { text: `${current}…`, kind: "activity" };
		const gerund = WORKING_GERUNDS[Math.floor(now / GERUND_ROTATE_MS) % WORKING_GERUNDS.length]!;
		return { text: `${gerund}…`, kind: "gerund" };
	}

	#statsSegments(now: number): Array<{ key: StatsSegmentKey; text: string }> {
		const segments: Array<{ key: StatsSegmentKey; text: string }> = [
			{ key: "elapsed", text: formatWorkingElapsed(now - this.#startMs) },
		];
		if (this.#outputTokens > 0) {
			segments.push({ key: "tokens", text: `↓ ${formatNumber(this.#outputTokens).toLowerCase()}` });
		}
		const speed = this.#speed.getSpeed(now);
		if (speed > 0) {
			segments.push({ key: "tps", text: `${speed.toFixed(1)} tok/s` });
		}
		if (this.#ttftMs !== undefined) {
			segments.push({ key: "ttft", text: `${theme.icon.time} ${(this.#ttftMs / 1000).toFixed(1)}s` });
		}
		if (this.#upstreamProvider) {
			segments.push({ key: "provider", text: `via ${this.#upstreamProvider}` });
		}
		return segments;
	}

	#requestPaint(): void {
		// Direct write: a tick changes only this component, so the TUI can update
		// the already-positioned rows without driving the full compose pipeline.
		// Lightweight test stubs may not carry the newer API; keep their legacy
		// component-scoped path working (mirrors `Loader.#requestPaint`).
		const ui = this.#ui as TUI & { requestDirectWrite?: (component: Text) => void };
		if (typeof ui.requestDirectWrite === "function") {
			ui.requestDirectWrite(this);
		} else {
			this.#ui.requestComponentRender(this);
		}
	}
}
