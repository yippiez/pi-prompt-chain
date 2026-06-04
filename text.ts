import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PANEL_BG, SGR_RESET } from "./theme.ts";

// Wrap plain text into chunks no wider than `width` display columns. Returns the
// chunk string and its starting offset (in code units, matching cursor.col).
export function wrapText(text: string, width: number): { str: string; start: number }[] {
	const out: { str: string; start: number }[] = [];
	let start = 0;
	while (start < text.length) {
		let w = 0;
		let end = start;
		while (end < text.length) {
			const cw = visibleWidth(text[end]!) || 1;
			if (w + cw > width && end > start) break;
			w += cw;
			end++;
		}
		out.push({ str: text.slice(start, end), start });
		start = end;
	}
	if (out.length === 0) out.push({ str: "", start: 0 });
	return out;
}

// Muted, compact one-line keybinding hint shown in the footer.
export function shortcutsText(width: number, thm: ExtensionContext["ui"]["theme"]): string {
	const parts = ["⇥ indent", "↵ split", "^d del", "^␣ fold", "! bash", "^r run", "^s send", "^t think", "/ cmd"];
	return thm.fg("dim", truncateToWidth(` ${parts.join("  ")}`, width, "…"));
}

// Make command output safe to render in fixed-width cells: strip ANSI, drop
// carriage returns, expand TABS to spaces (a tab counts as width 1 but the
// terminal expands it to a tab stop, overflowing the line and wrapping — which
// silently desyncs the inline renderer's cursor), and remove other control bytes.
export function sanitizeOutput(s: string): string {
	return s
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal control bytes
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI/SGR escapes
		.replace(/\r/g, "")
		.replace(/\t/g, "    ")
		// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping terminal control bytes
		.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

// Pad `content` to the full width and paint a background across the whole line.
// The content may emit resets (\x1b[0m) that would drop the background mid-line,
// so we re-open `bg` after each. Foreground colors are left as-is.
export function bgFillLine(content: string, width: number, bg: string = PANEL_BG): string {
	const pad = Math.max(0, width - visibleWidth(content));
	const filled = content + " ".repeat(pad);
	const persistent = filled.replace(/\x1b\[0m/g, SGR_RESET + bg);
	return bg + persistent + SGR_RESET;
}

/* ── helpers ────────────────────────────────────────── */

export function fitBorder(
	left: string,
	right: string,
	width: number,
	border: (text: string) => string,
	fill: (text: string) => string = border,
): string {
	if (width <= 0) return "";
	if (width === 1) return border("─");

	let leftText = left;
	let rightText = right;
	const fixedWidth = 2;
	const minimumGap = 3;

	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(rightText) > 0
	) {
		rightText = truncateToWidth(rightText, Math.max(0, visibleWidth(rightText) - 1), "");
	}
	while (
		fixedWidth + visibleWidth(leftText) + visibleWidth(rightText) + minimumGap > width &&
		visibleWidth(leftText) > 0
	) {
		leftText = truncateToWidth(leftText, Math.max(0, visibleWidth(leftText) - 1), "");
	}

	const gapWidth = Math.max(0, width - fixedWidth - visibleWidth(leftText) - visibleWidth(rightText));
	return `${border("─")}${leftText}${fill("─".repeat(gapWidth))}${rightText}${border("─")}`;
}

export function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

export function formatContext(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (!contextWindow || !usage || usage.percent === null) {
		return "ctx ?";
	}
	return `ctx ${Math.round(usage.percent)}%/${(contextWindow / 1000).toFixed(0)}k`;
}
