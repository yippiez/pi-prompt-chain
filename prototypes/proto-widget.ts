// PROTOTYPE B — real outline editor + a REAL conversation history pane (widget).
// History = condensed slides (thinking paragraph · tool-call bar · output), built
// live from pi events, placed aboveEditor.
//
// Run:  pi -e prototypes/proto-widget.ts --no-extensions
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import outlineExtension from "../pi-prompt-chain.ts";
import { HistoryStore, renderTimeline } from "./_history.ts";

export default function (pi: ExtensionAPI) {
	outlineExtension(pi); // full functional outline editor
	const store = new HistoryStore();
	store.attach(pi);

	pi.on("session_start", (_e, ctx) => {
		ctx.ui.setWidget(
			"history-pane",
			(tui, theme) => {
				store.onChange = () => tui.requestRender();
				return {
					invalidate() {},
					render(width: number): string[] {
						const histH = Math.max(3, Math.floor(tui.terminal.rows * 0.3));
						return [...renderTimeline(store, width, histH, theme), theme.fg("dim", "─".repeat(width))];
					},
				};
			},
			{ placement: "aboveEditor" },
		);
	});
}
