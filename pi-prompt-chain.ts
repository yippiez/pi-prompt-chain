import {
	CustomEditor,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BAR_WIDTH_RATIO = 0.8;
const MIN_BAR_WIDTH = 40;

/* ── helpers ────────────────────────────────────────── */

function fitBorder(
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

function formatCwd(cwd: string): string {
	const home = process.env.HOME;
	if (home && cwd.startsWith(home)) {
		return `~${cwd.slice(home.length)}`;
	}
	return cwd;
}

function formatContext(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
	if (!contextWindow || !usage || usage.percent === null) {
		return "ctx ?";
	}
	return `ctx ${Math.round(usage.percent)}%/${(contextWindow / 1000).toFixed(0)}k`;
}

function stripAnsi(text: string): string {
	return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isEditorBorderLine(line: string): boolean {
	const plain = stripAnsi(line);
	return /^[─ ↑↓0-9more]+$/.test(plain) && plain.includes("─");
}

function findBottomBorderIndex(lines: string[]): number {
	for (let i = lines.length - 1; i >= 1; i--) {
		if (isEditorBorderLine(lines[i]!)) return i;
	}
	return lines.length - 1;
}

/* ── empty footer (info lives in prompt bar now) ────── */

class EmptyFooter implements Component {
	render(): string[] {
		return [];
	}
	invalidate(): void {}
}

/* ── editor ─────────────────────────────────────────── */

class PromptChainEditor extends CustomEditor {
	private activeTui: TUI;
	private branch: string | undefined;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private ctx: ExtensionContext,
		private pi: ExtensionAPI,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.activeTui = tui;
		void this.refreshBranch();

		// Refresh branch periodically
		this.refreshTimer = setInterval(() => void this.refreshBranch(), 30_000);
	}

	private async refreshBranch(): Promise<void> {
		const result = await this.pi
			.exec("git", ["branch", "--show-current"], { cwd: this.ctx.cwd })
			.catch(() => undefined);
		const stdout = result?.stdout.trim();
		this.branch = stdout && stdout.length > 0 ? stdout : undefined;
		this.activeTui.requestRender();
	}

	override render(width: number): string[] {
		// 1. center at BAR_WIDTH_RATIO
		const targetWidth = Math.max(MIN_BAR_WIDTH, Math.floor(width * BAR_WIDTH_RATIO));
		const lines = super.render(targetWidth);
		if (lines.length < 2) return lines;

		const thm = this.ctx.ui.theme;

		// Detect bash mode: the app swaps editor.borderColor between
		// getThinkingBorderColor(level) and getBashModeBorderColor().
		// We check which one is active by comparing output to known bash color.
		const isBash = this.borderColor("x") === thm.fg("bashMode", "x");
		const barColor = isBash
			? (text: string) => thm.fg("error", text)
			: (text: string) => thm.fg("dim", text);

		// Session name
		const sessionName = this.pi.getSessionName() ?? "untitled";

		// Model
		const model = this.ctx.model
			? `${this.ctx.model.provider}/${this.ctx.model.id} · ${this.pi.getThinkingLevel()}`
			: `no model · ${this.pi.getThinkingLevel()}`;

		// Top bar: session name (left) · model (right)
		const topLeft = barColor(` ${sessionName} `);
		const topRight = barColor(` ${model} `);

		// Bottom bar: cwd (left) · context usage + branch (right)
		const branchStr = this.branch ? ` (${this.branch})` : "";
		const bottomLeft = barColor(` ${formatCwd(this.ctx.cwd)} `);
		const bottomRight = barColor(` ${formatContext(this.ctx)}${branchStr} `);

		const bottomBorderIndex = findBottomBorderIndex(lines);
		lines[0] = fitBorder(topLeft, topRight, targetWidth, barColor);
		lines[bottomBorderIndex] = fitBorder(bottomLeft, bottomRight, targetWidth, barColor);

		// 3. center the whole thing
		const totalPad = Math.max(0, width - targetWidth);
		const leftPad = " ".repeat(Math.floor(totalPad / 2));
		const rightPad = " ".repeat(totalPad - Math.floor(totalPad / 2));

		return lines.map((line) => leftPad + line + rightPad);
	}
}

/* ── extension entry ────────────────────────────────── */

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		// Hide default footer — info is in the prompt bars
		ctx.ui.setFooter(() => new EmptyFooter());

		ctx.ui.setEditorComponent(
			(tui: TUI, theme: EditorTheme, kb: KeybindingsManager) =>
				new PromptChainEditor(tui, theme, kb, ctx, pi),
		);
	});
}
