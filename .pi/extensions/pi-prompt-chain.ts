/**
 * pi-prompt-chain.ts
 *
 * Center the entire prompt bar (border + content) at 80% width.
 *
 * Usage: pi -e ./pi-prompt-chain.ts
 */

import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const BAR_WIDTH_RATIO = 0.8;
const MIN_BAR_WIDTH = 40;

class CenteredPromptBarEditor extends CustomEditor {
	override render(width: number): string[] {
		const targetWidth = Math.max(MIN_BAR_WIDTH, Math.floor(width * BAR_WIDTH_RATIO));
		const lines = super.render(targetWidth);

		const totalPad = Math.max(0, width - targetWidth);
		const leftPad = " ".repeat(Math.floor(totalPad / 2));
		const rightPad = " ".repeat(totalPad - Math.floor(totalPad / 2));

		return lines.map((line) => leftPad + line + rightPad);
	}
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.setEditorComponent((tui, theme, kb) => new CenteredPromptBarEditor(tui, theme, kb));
	});
}
