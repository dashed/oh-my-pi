/**
 * Contract: the agent panel's entry chords (alt+↓ primary, ctrl+↓ backup) are
 * wired as editor custom keys (InputController → CustomEditor.setCustomKeyHandler),
 * so the chord's CSI sequence fires the focus handler while plain typing and
 * unmodified arrow keys are never eaten.
 */
import { beforeAll, describe, expect, it, vi } from "bun:test";
import { CustomEditor } from "@oh-my-pi/pi-coding-agent/modes/components/custom-editor";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

describe("Agent panel entry chord", () => {
	beforeAll(async () => {
		await initTheme();
	});

	it("fires the handler on the alt+down and ctrl+down CSIs without eating typing", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onFocusPanel = vi.fn();
		editor.setCustomKeyHandler("alt+down", onFocusPanel);
		editor.setCustomKeyHandler("ctrl+down", onFocusPanel);

		editor.handleInput("\x1b[1;3B"); // alt+↓
		expect(onFocusPanel).toHaveBeenCalledTimes(1);
		expect(editor.getText()).toBe("");

		editor.handleInput("\x1b[1;5B"); // ctrl+↓
		expect(onFocusPanel).toHaveBeenCalledTimes(2);
		expect(editor.getText()).toBe("");

		// Plain text still types through — the chords never swallow characters.
		editor.handleInput("?");
		editor.handleInput("a");
		expect(onFocusPanel).toHaveBeenCalledTimes(2);
		expect(editor.getText()).toBe("?a");
	});

	it("does not capture a plain ↓", () => {
		const editor = new CustomEditor(getEditorTheme());
		const onFocusPanel = vi.fn();
		editor.setCustomKeyHandler("alt+down", onFocusPanel);
		editor.setCustomKeyHandler("ctrl+down", onFocusPanel);

		editor.handleInput("\x1b[B"); // unmodified ↓ keeps its editor meaning (cursor/history)
		expect(onFocusPanel).not.toHaveBeenCalled();
		expect(editor.getText()).toBe("");
	});
});
