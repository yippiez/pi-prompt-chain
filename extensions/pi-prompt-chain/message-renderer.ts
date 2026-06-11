import { Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { OutlineModel, type NodeId, type VisibleRow } from "./nodes.ts";
import { BRANCH, BRANCH_BLANK, BRANCH_ELBOW, BRANCH_TEE, NODE_FILLED, NODE_OPEN, PANEL_BG, SGR_RESET, fitBorder, wrapText } from "./render.ts";

class RenderLines {
	constructor(private readonly draw: (width: number) => string[]) {}
	invalidate() {}
	render(width: number): string[] {
		return this.draw(width);
	}
}

function renderNodeLines(model: OutlineModel, row: VisibleRow, width: number, theme: any): string[] {
	const node = model.getNode(row.id);
	const rawText = model.textOf(row.id);
	const isBash = node?.kind === "bash";
	const isFirstRow = model.visibleRows()[0]?.id === row.id;
	const isSlash = isFirstRow && row.depth === 0 && node?.kind === "node" && /^\/[\w:-]/.test(rawText);
	const branch = row.ancestorContinues.map((cont) => (cont ? BRANCH : BRANCH_BLANK)).join("");
	const glyph = isSlash ? theme.fg("accent", NODE_FILLED) : row.depth === 0 ? theme.fg("accent", row.hasChildren && row.collapsed ? NODE_FILLED : NODE_OPEN) : row.hasChildren ? (row.collapsed ? NODE_FILLED : NODE_OPEN) : row.isLast ? BRANCH_ELBOW : BRANCH_TEE;
	const marker = isBash ? "$ " : isSlash ? "/" : "";
	const firstPrefix = `${branch}${glyph} ${marker ? theme.fg("muted", marker) : ""}`;
	const contPrefix = `${branch}${row.hasChildren ? BRANCH : BRANCH_BLANK}${" ".repeat(marker.length)}`;
	const textW = Math.max(4, width - visibleWidth(firstPrefix));
	const text = isSlash ? rawText.slice(1) : rawText;
	const paint = (s: string) => (isBash ? theme.fg("muted", s) : isSlash ? theme.fg("accent", s) : s);
	return wrapText(text, textW).map((chunk, index) => {
		const prefix = index === 0 ? firstPrefix : contPrefix;
		return truncateToWidth(`${prefix}${paint(chunk.str)}`, width, "…");
	});
}

function promptBg(line: string, width: number): string {
	// Color node rows like the prompt editor panel. Border rows remain transparent.
	const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
	const clipped = truncateToWidth(padded, width, "")
		.replaceAll(SGR_RESET, `${SGR_RESET}${PANEL_BG}`)
		.replaceAll("\x1b[49m", `\x1b[49m${PANEL_BG}`);
	return `${PANEL_BG}${clipped}${SGR_RESET}`;
}

function renderOutline(markdown: string, width: number, theme: any): string[] {
	const model = OutlineModel.fromMarkdown(markdown);
	const lines: string[] = [fitBorder("", "", width, (s) => theme.fg("dim", s))];
	for (const row of model.visibleRows()) {
		lines.push(...renderNodeLines(model, row, width, theme).map((line) => promptBg(line, width)));
		const node = model.getNode(row.id);
		if (node?.kind === "bash" && node.output) {
			for (const raw of node.output.split("\n").slice(0, 5)) {
				lines.push(promptBg(theme.fg("dim", truncateToWidth(`${BRANCH_BLANK}  ${raw}`, width, "…")), width));
			}
		} else if (node?.kind === "node" && node.pasted) {
			for (const raw of node.pasted.split("\n").slice(0, 5)) {
				lines.push(promptBg(theme.fg("dim", truncateToWidth(`${BRANCH_BLANK}  ${raw}`, width, "…")), width));
			}
		}
	}
	lines.push(fitBorder("", "", width, (s) => theme.fg("dim", s)));
	return lines;
}

export function registerPromptChainMessageRenderer(pi: ExtensionAPI): void {
	pi.registerMessageRenderer<{ markdown?: string }>("pi-prompt-chain-user", (message, _options, theme) => {
		const markdown = typeof message.details?.markdown === "string"
			? message.details.markdown
			: typeof message.content === "string"
				? message.content
				: "";
		if (!markdown.trim()) return new Container();
		return new RenderLines((width) => renderOutline(markdown, Math.max(1, width - 1), theme)) as any;
	});
}
