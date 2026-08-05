/**
 * Rolling-window streaming-speed gauge, shared by the thinking-block speed
 * badge ({@link ../assistant-message}) and the working indicator's live tok/s
 * segment. Extracted so each surface owns an independent instance: the
 * session-wide thinking gauge must never leak into the per-turn indicator and
 * vice versa.
 */

/** Rolling window (ms) over which streaming-rate observations are averaged. */
const SPEED_WINDOW_MS = 3000;
/** Color/clamp ceiling: a rate at or above this maps to the full accent color. */
export const SPEED_MAX = 200;

/**
 * Streaming-speed gauge. Callers feed it instantaneous tok/s observations and
 * read back their windowed average — smoothing the jumpy per-delta numbers.
 * Each thinking block resets the gauge on its first live sample (see
 * {@link AssistantMessageComponent.updateContent}) so the average reflects only
 * the active block, never a previous turn's trailing rate. Components feed it
 * deltas (not cumulative totals), so a fresh turn restarting its token count at
 * zero never produces a spike.
 */
export class SpeedTracker {
	#observations: Array<{ time: number; rate: number }> = [];

	#prune(now: number): void {
		const threshold = now - SPEED_WINDOW_MS;
		while (this.#observations.length > 0 && this.#observations[0]!.time < threshold) {
			this.#observations.shift();
		}
	}

	/** Record one instantaneous tok/s reading, clamped to {@link SPEED_MAX} so a
	 *  single oversized delta (e.g. a buffered reflow tick) can't poison the
	 *  windowed average. Non-finite/negative rates ignored. */
	observe(rate: number, now = performance.now()): void {
		if (!Number.isFinite(rate) || rate < 0) return;
		this.#observations.push({ time: now, rate: Math.min(rate, SPEED_MAX) });
		this.#prune(now);
	}

	/** Windowed-average tok/s; 0 once observations age out of the window. */
	getSpeed(now = performance.now()): number {
		this.#prune(now);
		if (this.#observations.length === 0) return 0;
		let sum = 0;
		for (const o of this.#observations) sum += o.rate;
		return sum / this.#observations.length;
	}

	reset(): void {
		this.#observations = [];
	}
}
