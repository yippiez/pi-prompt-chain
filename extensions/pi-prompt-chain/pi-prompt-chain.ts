import type { ExtensionAPI, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { PromptChainEditor } from "./editor.ts";
import { registerPromptChainMessageRenderer } from "./message-renderer.ts";
import { shortcutsText } from "./render.ts";

/* ── extension entry ────────────────────────────────── */

export default function (pi: ExtensionAPI) {
	registerPromptChainMessageRenderer(pi);

	// Native conversation (thinking · tools · output) renders inline in the
	// scrollback ABOVE the editor box — nothing custom is pinned above the prompt bar.
	let activeEditor: PromptChainEditor | undefined;

	pi.on("session_shutdown", async () => {
		await activeEditor?.dispose();
	});

	pi.on("message_start", (event) => {
		if (event.message.role === "custom" && event.message.customType === "pi-prompt-chain-user") {
			activeEditor?.markQueuedDraftStarted();
		}
	});

	pi.on("agent_end", () => {
		// Pi has either delivered or depleted follow-up messages. Reconcile our
		// local queued-draft badge so it cannot get stuck at "1 queued".
		setTimeout(() => activeEditor?.reconcileQueuedDrafts(), 0);
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
