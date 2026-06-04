import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { PromptChainEditor } from "./editor.ts";
import { shortcutsText } from "./text.ts";

/* ── extension entry ────────────────────────────────── */

export default function (pi: ExtensionAPI) {
	// Native conversation (thinking · tools · output) renders inline in the
	// scrollback ABOVE the editor box — nothing custom is pinned above the prompt bar.
	let activeEditor: PromptChainEditor | undefined;

	pi.on("session_shutdown", async () => {
		await activeEditor?.flushSave();
	});

	pi.on("session_start", (_event, ctx) => {
		// Footer: muted keybinding hints, below the editor's bottom prompt bar.
		ctx.ui.setFooter((_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				return [shortcutsText(width, theme)];
			},
		}));

		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, kb: KeybindingsManager) => {
			activeEditor = new PromptChainEditor(tui, theme, kb, ctx, pi);
			return activeEditor;
		});
	});
}
