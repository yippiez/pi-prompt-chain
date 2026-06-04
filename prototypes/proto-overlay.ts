// PROTOTYPE A — real outline editor + a REAL conversation history pane (top overlay).
// History = condensed slides (thinking paragraph · tool-call bar · output), built
// live from pi events. nonCapturing overlay keeps focus on the editor below.
//
// Run:  pi -e prototypes/proto-overlay.ts --no-extensions
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import outlineExtension from "../pi-prompt-chain.ts";
import { HistoryStore, renderTimeline } from "./_history.ts";

export default function (pi: ExtensionAPI) {
	outlineExtension(pi); // full functional outline editor at the bottom
	const store = new HistoryStore();
	store.attach(pi);

	pi.on("session_start", (_e, ctx) => {
		ctx.ui.custom(
			(tui, theme) => {
				store.onChange = () => tui.requestRender();
				return {
					invalidate() {},
					render(width: number): string[] {
						const histH = Math.max(3, Math.floor(tui.terminal.rows * 0.3));
						return renderTimeline(store, width, histH, theme);
					},
				};
			},
			{
				overlay: true,
				overlayOptions: { anchor: "top-center", width: "100%", maxHeight: "30%", nonCapturing: true },
			},
		);
	});
}
