import { describe, expect, it } from "bun:test";
import { KeybindingsManager } from "@oh-my-pi/pi-coding-agent/config/keybindings";
import { buildHotkeysMarkdown } from "@oh-my-pi/pi-coding-agent/modes/utils/hotkeys-markdown";

describe("buildHotkeysMarkdown", () => {
	it("emits flush-left markdown and uses the configured temporary selector hint", () => {
		const displayStrings: Record<string, string> = {
			"app.clipboard.copyLine": "Alt+Shift+L",
			"app.clipboard.copyPrompt": "Ctrl+Shift+P",
			"app.plan.toggle": "Alt+Shift+P",
			"app.tools.expand": "Ctrl+O",
			"app.tools.toggleVisibility": "Ctrl+Shift+O",
			"app.display.reset": "Alt+L",
			"app.interrupt": "Esc",
			"app.clear": "Ctrl+C",
			"app.exit": "Ctrl+D",
			"app.suspend": "Ctrl+Z",
			"app.thinking.cycle": "Shift+Tab",
			"app.model.cycleForward": "Ctrl+P",
			"app.model.cycleBackward": "Shift+Ctrl+P",
			"app.model.selectTemporary": "Ctrl+Shift+L",
			"app.model.select": "Alt+M",
			"app.history.search": "Ctrl+R",
			"app.thinking.toggle": "Ctrl+T",
			"app.editor.external": "Ctrl+G",
			"app.retry": "Alt+R",
			"app.clipboard.pasteImage": "Ctrl+V",
			"app.stt.toggle": "Alt+H",
			"app.live.toggle": "Ctrl+L",
			"app.help.hotkeys": "F1/Ctrl+/",
			"tui.editor.cursorWordLeft": "Alt+Left",
			"tui.editor.cursorWordRight": "Alt+Right",
			"tui.editor.cursorLineStart": "Home/Ctrl+A",
			"tui.editor.cursorLineEnd": "End/Ctrl+E",
			"tui.input.submit": "Enter",
			"tui.input.newLine": "Shift+Enter/Ctrl+J",
			"tui.input.tab": "Tab",
			"tui.editor.deleteWordBackward": "Ctrl+W/Alt+Backspace",
			"tui.editor.deleteToLineStart": "Ctrl+U",
			"tui.editor.deleteToLineEnd": "Ctrl+K",
		};
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				getDisplayString(action) {
					return displayStrings[action] ?? "Disabled";
				},
			},
		});

		const lines = markdown.split("\n");
		expect(lines[0]).toBe("**Navigation**");
		expect(markdown).toContain("| `F1/Ctrl+/` | Show keyboard shortcuts (this panel) |");
		expect(markdown).toContain("| `Alt+Left` / `Alt+Right` | Move by word |");
		expect(markdown).toContain("| `Home/Ctrl+A` | Start of line |");
		expect(markdown).toContain("| `End/Ctrl+E` | End of line |");
		expect(markdown).toContain("| `Enter` | Send message |");
		expect(markdown).toContain("| `Shift+Enter/Ctrl+J` | New line |");
		expect(markdown).toContain("| `Ctrl+W/Alt+Backspace` | Delete word backwards |");
		expect(markdown).toContain("| `Ctrl+U` | Delete to start of line |");
		expect(markdown).toContain("| `Ctrl+K` | Delete to end of line |");
		expect(markdown).toContain("| `Tab` | Path completion / accept autocomplete |");
		expect(markdown).toContain("| `Ctrl+Shift+P` | Copy whole prompt |");
		expect(markdown).toContain("| `Ctrl+Shift+L` | Select model (temporary) |");
		expect(markdown).toContain("| `Alt+M` | Select model (set roles) |");
		expect(markdown).toContain("| `Alt+L` | Reset terminal display |");
		expect(markdown).toContain("| `Ctrl+L` | Start/stop live voice mode (/live) |");
		expect(markdown).toContain("| `Alt+R` | Retry last failed assistant turn |");
		expect(markdown).toContain("| `Alt+Shift+P` | Toggle plan mode |");
		expect(markdown).toContain("| `Ctrl+Shift+O` | Toggle tool activity visibility |");
		expect(markdown).toContain("| `#<number>` | GitHub issue/PR reference");
		expect(markdown).toContain("| `#` / `#<text>` | Prompt actions");
		for (const line of lines) {
			if (line.length === 0) continue;
			expect(line.startsWith(" ")).toBe(false);
			expect(line.startsWith("\t")).toBe(false);
		}
	});

	it("reflects a rebound help binding through the real keybindings manager", () => {
		const markdown = buildHotkeysMarkdown({
			keybindings: KeybindingsManager.inMemory({ "app.help.hotkeys": "ctrl+h" }),
		});
		expect(markdown).toContain("| `Ctrl+H` | Show keyboard shortcuts (this panel) |");
		expect(markdown).not.toContain("F1/Ctrl+/");
	});

	it("renders the temporary selector row as disabled when no display string is configured", () => {
		const markdown = buildHotkeysMarkdown({
			keybindings: {
				getDisplayString(action) {
					if (action === "app.model.selectTemporary") {
						return "";
					}
					if (action === "app.model.select") {
						return "Alt+M";
					}
					if (action === "app.display.reset") {
						return "Alt+L";
					}
					return "Ctrl+K";
				},
			},
		});

		expect(markdown).toContain("| `Disabled` | Select model (temporary) |");
		expect(markdown).toContain("| `Alt+M` | Select model (set roles) |");
	});
});
