import type { Keybinding, KeybindingsManager } from "../../config/keybindings";

export interface HotkeysMarkdownBindings {
	keybindings: Pick<KeybindingsManager, "getDisplayString">;
}

function keyLabel(bindings: HotkeysMarkdownBindings, action: Keybinding): string {
	return bindings.keybindings.getDisplayString(action) || "Disabled";
}

export function buildHotkeysMarkdown(bindings: HotkeysMarkdownBindings): string {
	return [
		"**Navigation**",
		"| Key | Action |",
		"|-----|--------|",
		"| `Arrow keys` | Move cursor / browse history (Up when empty) |",
		`| \`${keyLabel(bindings, "tui.editor.cursorWordLeft")}\` / \`${keyLabel(bindings, "tui.editor.cursorWordRight")}\` | Move by word |`,
		`| \`${keyLabel(bindings, "tui.editor.cursorLineStart")}\` | Start of line |`,
		`| \`${keyLabel(bindings, "tui.editor.cursorLineEnd")}\` | End of line |`,
		"",
		"**Editing**",
		"| Key | Action |",
		"|-----|--------|",
		`| \`${keyLabel(bindings, "tui.input.submit")}\` | Send message |`,
		`| \`${keyLabel(bindings, "tui.input.newLine")}\` | New line |`,
		`| \`${keyLabel(bindings, "tui.editor.deleteWordBackward")}\` | Delete word backwards |`,
		`| \`${keyLabel(bindings, "tui.editor.deleteToLineStart")}\` | Delete to start of line |`,
		`| \`${keyLabel(bindings, "tui.editor.deleteToLineEnd")}\` | Delete to end of line |`,
		`| \`${keyLabel(bindings, "app.clipboard.copyLine")}\` | Copy current line |`,
		`| \`${keyLabel(bindings, "app.clipboard.copyPrompt")}\` | Copy whole prompt |`,
		"",
		"**Other**",
		"| Key | Action |",
		"|-----|--------|",
		`| \`${keyLabel(bindings, "app.help.hotkeys")}\` | Show keyboard shortcuts (this panel) |`,
		`| \`${keyLabel(bindings, "tui.input.tab")}\` | Path completion / accept autocomplete |`,
		`| \`${keyLabel(bindings, "app.interrupt")}\` | Cancel autocomplete / interrupt active work |`,
		`| \`${keyLabel(bindings, "app.clear")}\` | Clear editor (first) / exit (second) |`,
		`| \`${keyLabel(bindings, "app.exit")}\` | Exit (when editor is empty) |`,
		`| \`${keyLabel(bindings, "app.suspend")}\` | Suspend to background |`,
		`| \`${keyLabel(bindings, "app.display.reset")}\` | Reset terminal display |`,
		`| \`${keyLabel(bindings, "app.thinking.cycle")}\` | Cycle thinking level |`,
		`| \`${keyLabel(bindings, "app.model.cycleForward")}\` | Cycle role models (slow/default/smol) |`,
		`| \`${keyLabel(bindings, "app.model.cycleBackward")}\` | Cycle role models (backward) |`,
		`| \`${keyLabel(bindings, "app.model.selectTemporary")}\` | Select model (temporary) |`,
		`| \`${keyLabel(bindings, "app.model.select")}\` | Select model (set roles) |`,
		`| \`${keyLabel(bindings, "app.plan.toggle")}\` | Toggle plan mode |`,
		`| \`${keyLabel(bindings, "app.history.search")}\` | Search prompt history |`,
		`| \`${keyLabel(bindings, "app.tools.expand")}\` | Toggle tool output expansion |`,
		`| \`${keyLabel(bindings, "app.tools.toggleVisibility")}\` | Toggle tool activity visibility |`,
		`| \`${keyLabel(bindings, "app.thinking.toggle")}\` | Toggle thinking block visibility |`,
		`| \`${keyLabel(bindings, "app.editor.external")}\` | Edit message in external editor |`,
		`| \`${keyLabel(bindings, "app.retry")}\` | Retry last failed assistant turn |`,
		`| \`${keyLabel(bindings, "app.clipboard.pasteImage")}\` | Paste image or text from clipboard |`,
		"| Hold `Space` | Speech-to-text (push-to-talk): hold to record, release to transcribe |",
		`| \`${keyLabel(bindings, "app.live.toggle")}\` | Start/stop live voice mode (/live) |`,
		`| \`${keyLabel(bindings, "app.agents.hub")}\` / \`${keyLabel(bindings, "app.session.observe")}\` / double-tap \`←\` (empty editor) | Open the agent hub |`,
		"| `#<number>` | GitHub issue/PR reference (e.g. `#3164` → `pr://`/`issue://`) |",
		"| `#` / `#<text>` | Prompt actions (copy / undo / move cursor) |",
		"| `/` | Slash commands |",
		"| `!` | Run bash command |",
		"| `!!` | Run bash command (excluded from context) |",
		"| `$` | Run Python in shared kernel |",
		"| `$$` | Run Python (excluded from context) |",
	].join("\n");
}
