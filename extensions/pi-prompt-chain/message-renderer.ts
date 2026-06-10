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
	const isSlash = node?.kind === "node" && rawText.startsWith("/");
	const branch = row.ancestorContinues.map((cont) => (cont ? BRANCH : BRANCH_BLANK)).join("");
	const glyph = isSlash ? theme.fg("accent", NODE_FILLED) : row.hasChildren ? (row.collapsed ? NODE_FILLED : NODE_OPEN) : row.isLast ? BRANCH_ELBOW : BRANCH_TEE;
	const marker = isBash ? "$ " : isSlash ? "/" : "";
	const firstPrefix = `${branch}${glyph} ${marker ? theme.fg("muted", marker) : ""}`;
	const contPrefix = `${branch}${row.hasChildren ? BRANCH : BRANCH_BLANK} ${" ".repeat(marker.length)}`;
	const textW = Math.max(4, width - visibleWidth(firstPrefix));
	const text = isSlash ? rawText.slice(1) : rawText;
	const paint = (s: string) => (isBash ? theme.fg("muted", s) : isSlash ? theme.fg("accent", s) : s);
	return wrapText(text, textW).map((chunk, index) => {
		const prefix = index === 0 ? firstPrefix : contPrefix;
		return truncateToWidth(` ${prefix}${paint(chunk.str)}`, width, "…");
	});
}

function promptBg(line: string, width: number): string {
	const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
	return `${PANEL_BG}${truncateToWidth(padded, width, "")}${SGR_RESET}`;
}

function renderOutline(markdown: string, width: number, theme: any): string[] {
	const model = OutlineModel.fromMarkdown(markdown);
	const lines: string[] = [fitBorder(theme.fg("dim", " prompt "), "", width, (s) => theme.fg("dim", s))];
	for (const row of model.visibleRows()) {
		lines.push(...renderNodeLines(model, row, width, theme));
		const node = model.getNode(row.id);
		if (node?.kind === "bash" && node.output) {
			for (const raw of node.output.split("\n").slice(0, 5)) {
				lines.push(theme.fg("dim", truncateToWidth(` ${BRANCH_BLANK}  ${raw}`, width, "…")));
			}
		}
	}
	lines.push(fitBorder("", "", width, (s) => theme.fg("dim", s)));
	return lines.map((line) => promptBg(line, width));
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
