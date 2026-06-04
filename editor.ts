import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import type { NodeId } from "./nodes.ts";
import { OutlineModel, type VisibleRow } from "./outline-model.ts";
import { BOX_CONTENT_H, BOX_MAX_W, BRANCH, CURSOR_ROW_BG, NODE_FILLED, NODE_OPEN, PANEL_BG, PROMPT_HEIGHT_RATIO } from "./theme.ts";
import { bgFillLine, fitBorder, formatContext, formatCwd, sanitizeOutput, wrapText } from "./text.ts";

/** Mirrors @earendil-works/pi-agent-core's ThinkingLevel (not re-exported here). */
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

/* ── editor ─────────────────────────────────────────── */

export class PromptChainEditor extends CustomEditor {
	private activeTui: TUI;
	private branch: string | undefined;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private model: OutlineModel;
	private scrollTop = 0;
	private commandMode = false; // delegating to the base editor for a /slash command
	private boxScroll = new Map<NodeId, number>(); // per bash node: output box scroll offset

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private ctx: ExtensionContext,
		private pi: ExtensionAPI,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.activeTui = tui;
		this.model = new OutlineModel(new Map(), [], new Set()); // in-memory only; not persisted
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

	/* ---- persistence ----
	 * Outline state is kept IN MEMORY only for the lifetime of the session; it is
	 * intentionally NOT persisted to .pi/chains.jsonl. */

	/** Clear timers on shutdown. Kept (and still called from session_shutdown) so
	 *  the refresh interval doesn't outlive the session. */
	async flushSave(): Promise<void> {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	private afterEdit(): void {
		this.activeTui.requestRender();
	}

	/* ---- input (Workflowy always-editing) ---- */

	override handleInput(data: string): void {
		const m = this.model;

		// While composing a /slash command, hand all input to the base editor
		// (which owns the command menu + execution). Escape cancels back to the
		// outline; we also exit once the buffer no longer holds a "/command".
		if (this.commandMode) {
			if (matchesKey(data, "escape")) {
				this.setText("");
				this.commandMode = false;
				this.activeTui.requestRender();
				return;
			}
			super.handleInput(data);
			const text = this.getText();
			if (text.length === 0 || !text.startsWith("/")) this.commandMode = false;
			this.activeTui.requestRender();
			return;
		}
		// "/" on an empty node enters command mode and delegates to the base editor.
		if (data === "/" && m.cursor.col === 0 && m.getNode(m.cursor.id)?.kind === "node" && m.textOf(m.cursor.id).length === 0) {
			this.commandMode = true;
			super.handleInput("/");
			this.activeTui.requestRender();
			return;
		}

		if (matchesKey(data, Key.enter)) return this.run(() => m.enter());
		if (matchesKey(data, Key.ctrl("d"))) return this.run(() => m.deleteCurrentNode());
		if (matchesKey(data, "tab")) return this.run(() => m.indent());
		if (matchesKey(data, "shift+tab")) return this.run(() => m.outdent());
		if (matchesKey(data, Key.up)) return this.run(() => m.moveCaretUp());
		if (matchesKey(data, Key.down)) return this.run(() => m.moveCaretDown());
		if (matchesKey(data, Key.left)) return this.run(() => m.moveCaretLeft());
		if (matchesKey(data, Key.right)) return this.run(() => m.moveCaretRight());
		if (matchesKey(data, Key.home)) return this.run(() => m.caretHome());
		if (matchesKey(data, Key.end)) return this.run(() => m.caretEnd());
		if (matchesKey(data, "backspace")) {
			return this.run(() => (m.cursor.col > 0 ? m.deleteCharBefore() : m.backspaceMerge()));
		}
		if (matchesKey(data, Key.delete)) return this.run(() => m.deleteCharAfter());
		if (matchesKey(data, Key.ctrl("space"))) return this.run(() => m.toggleCollapse());
		if (matchesKey(data, Key.ctrl("r"))) return void this.runBash();
		if (matchesKey(data, Key.ctrl("s"))) return void this.sendOutline();
		if (matchesKey(data, Key.ctrl("t"))) return this.cycleThinkingLevel();
		if (matchesKey(data, "pageDown")) return this.run(() => this.scrollBox(1));
		if (matchesKey(data, "pageUp")) return this.run(() => this.scrollBox(-1));

		// "!" on an empty plain node turns it into a bash node.
		if (data === "!") {
			const node = m.getNode(m.cursor.id);
			if (node?.kind === "node" && m.textOf(m.cursor.id).length === 0) {
				return this.run(() => m.convertCursorToBash());
			}
		}

		// Printable char, or a paste (multi-char without control bytes).
		if (data.length === 1 && data.charCodeAt(0) >= 32) return this.run(() => m.insertChar(data));
		// biome-ignore lint/suspicious/noControlCharactersInRegex: detecting control bytes
		if (data.length > 1 && !/[\x00-\x1f]/.test(data)) return this.run(() => m.insertChar(data));

		// Escape (abort), Ctrl+D (exit), Ctrl+P (model cycle), shortcuts -> app.
		super.handleInput(data);
	}

	private run(op: () => void): void {
		op();
		this.afterEdit();
	}

	/** Run the cursor's bash node and attach its output. */
	private async runBash(): Promise<void> {
		const b = this.model.cursorBash();
		if (!b || !b.command.trim()) return;
		this.model.setBashResult(b.id, "…running…", -1);
		this.afterEdit();
		const res = await this.pi
			.exec("bash", ["-c", b.command], { cwd: this.ctx.cwd })
			.catch(() => undefined);
		const output = res ? sanitizeOutput(`${res.stdout}${res.stderr}`).replace(/\n+$/, "") : "(exec failed)";
		this.model.setBashResult(b.id, output, res?.code ?? -1);
		this.afterEdit();
	}

	/** Compose the whole outline as markdown, send it to the agent, and clear. */
	private sendOutline(): void {
		const md = this.model.composeMarkdown();
		if (!md.trim()) return;
		// isIdle() lives on the ExtensionContext, not the ExtensionAPI.
		this.pi.sendUserMessage(md, this.ctx.isIdle() ? undefined : { deliverAs: "followUp" });
		// Clear the outline — reset to a single empty root node.
		this.model = new OutlineModel(new Map(), [], new Set());
		this.activeTui.requestRender();
	}

	/** Ctrl+T: scroll to the agent's next thinking level. Replaces the built-in
	 *  "hide/show thinking block" toggle. setThinkingLevel clamps unsupported
	 *  levels to the model's capabilities, so we advance through the ordered list
	 *  and stop at the first candidate that actually changes the effective level —
	 *  this skips levels the model doesn't support and never gets stuck. */
	private cycleThinkingLevel(): void {
		const order: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];
		const start = this.pi.getThinkingLevel();
		let idx = order.indexOf(start);
		if (idx < 0) idx = 0;
		for (let step = 1; step <= order.length; step++) {
			this.pi.setThinkingLevel(order[(idx + step) % order.length]);
			if (this.pi.getThinkingLevel() !== start) break; // landed on a supported, different level
		}
		this.activeTui.requestRender();
	}

	/** Scroll the cursor bash node's output box by one page. */
	private scrollBox(dir: number): void {
		const b = this.model.cursorBash();
		const node = b && this.model.getNode(b.id);
		if (!node || node.kind !== "bash" || node.output === undefined) return;
		const total = node.output.replace(/\n+$/, "").split("\n").length;
		const max = Math.max(0, total - BOX_CONTENT_H);
		const cur = this.boxScroll.get(b.id) ?? 0;
		this.boxScroll.set(b.id, Math.max(0, Math.min(max, cur + dir * BOX_CONTENT_H)));
	}

	/** Fixed-height rounded box showing a bash node's output (scrolls inside). */
	private renderOutputBox(
		id: NodeId,
		output: string,
		depth: number,
		width: number,
		thm: ExtensionContext["ui"]["theme"],
	): string[] {
		const dim = (s: string) => thm.fg("dim", s);
		const indent = BRANCH.repeat(depth) + "  "; // align under the node circle
		const boxW = Math.max(8, Math.min(BOX_MAX_W, width - visibleWidth(indent)));
		const innerW = boxW - 4; // "│ " + content + " │"
		const all = sanitizeOutput(output).replace(/\n+$/, "").split("\n");
		const scroll = Math.min(this.boxScroll.get(id) ?? 0, Math.max(0, all.length - BOX_CONTENT_H));

		const lines: string[] = [];
		const label = " stdout ";
		lines.push(dim(`${indent}╭${label}${"─".repeat(Math.max(0, boxW - 2 - label.length))}╮`));
		for (let i = 0; i < BOX_CONTENT_H; i++) {
			let cell = truncateToWidth(all[scroll + i] ?? "", innerW, "…");
			cell += " ".repeat(Math.max(0, innerW - visibleWidth(cell)));
			lines.push(dim(`${indent}│ ${cell} │`));
		}
		const more = all.length - (scroll + BOX_CONTENT_H);
		const tag = more > 0 ? ` ↓${more} ` : scroll > 0 ? ` ↑${scroll} ` : "";
		lines.push(dim(`${indent}╰${tag}${"─".repeat(Math.max(0, boxW - 2 - tag.length))}╯`));
		return lines;
	}

	/* ---- rendering ---- */

	/** Render one node as one OR MORE lines: long text wraps; continuation lines
	 *  are indented to align under the text. The caret lands on the right line. */
	private renderNodeLines(
		row: VisibleRow,
		caretCol: number,
		width: number,
		thm: ExtensionContext["ui"]["theme"],
	): string[] {
		const node = this.model.getNode(row.id);
		const isBash = node?.kind === "bash";
		const branchPlain = BRANCH.repeat(row.depth);
		const branch = row.depth > 0 ? thm.fg("dim", branchPlain) : "";
		const glyph = isBash
			? thm.fg("error", NODE_FILLED) // red circle for bash nodes
			: thm.fg("accent", row.hasChildren && row.collapsed ? NODE_FILLED : NODE_OPEN);
		const cmdMark = isBash ? "$ " : "";
		// Prefix width = branch + glyph(1) + space(1) + "$ "
		const prefixW = visibleWidth(branchPlain) + 2 + cmdMark.length;
		const textW = Math.max(4, width - prefixW);
		const paint = (s: string) => (isBash ? thm.fg("muted", s) : s);
		const text = this.model.textOf(row.id);

		const firstPrefix = `${branch}${glyph} ${isBash ? thm.fg("muted", cmdMark) : ""}`;
		const contPrefix = `${branch}${" ".repeat(2 + cmdMark.length)}`;
		const chunks = wrapText(text, textW);
		const lines: string[] = [];
		for (let li = 0; li < chunks.length; li++) {
			const { str, start } = chunks[li]!;
			const end = start + str.length;
			let body: string;
			const onCaret =
				caretCol >= 0 &&
				caretCol >= start &&
				(caretCol < end || (li === chunks.length - 1 && caretCol === end));
			if (onCaret) {
				const rel = caretCol - start;
				const at = rel < str.length ? str[rel]! : " ";
				body = `${paint(str.slice(0, rel))}\x1b[7m${at}\x1b[27m${paint(str.slice(rel + 1))}`;
			} else {
				body = paint(str);
			}
			lines.push(`${li === 0 ? firstPrefix : contPrefix}${body}`);
		}
		return lines;
	}

	override render(width: number): string[] {
		const thm = this.ctx.ui.theme;
		// Keep every emitted line ONE column short of the terminal width. A line
		// exactly equal to the width leaves the cursor in the terminal's
		// deferred-wrap state, which desyncs pi's differential cursor tracking and
		// stacks stale frames over many re-renders. width-1 avoids that entirely.
		const W = Math.max(1, width - 1);

		// Detect bash mode: the app swaps editor.borderColor between
		// getThinkingBorderColor(level) and getBashModeBorderColor().
		const isBash = this.borderColor("x") === thm.fg("bashMode", "x");
		const barColor = isBash
			? (text: string) => thm.fg("error", text)
			: (text: string) => thm.fg("dim", text);

		const sessionName = this.pi.getSessionName() ?? "untitled";
		const model = this.ctx.model
			? `${this.ctx.model.provider}/${this.ctx.model.id} · ${this.pi.getThinkingLevel()}`
			: `no model · ${this.pi.getThinkingLevel()}`;

		// Bars built from scratch (independent of the base editor's output).
		const branchStr = this.branch ? ` (${this.branch})` : "";
		const topBar = fitBorder(barColor(` ${sessionName} `), barColor(` ${model} `), W, barColor);
		const bottomBar = fitBorder(
			barColor(` ${formatCwd(this.ctx.cwd)} `),
			barColor(` ${formatContext(this.ctx)}${branchStr} `),
			W,
			barColor,
		);

		// FIXED box height. The inline TUI redraws our region in place and requires
		// a CONSTANT number of returned lines per frame; a varying count makes the
		// terminal stack/duplicate previous frames. boxHeight depends only on the
		// terminal size, so it's stable across edits/runs/navigation.
		const termHeight = this.activeTui.terminal.rows;
		const boxHeight = Math.max(4, Math.floor(termHeight * PROMPT_HEIGHT_RATIO));
		const outlineHeight = boxHeight - 2; // minus the two bar rows (hints are in the footer)

		// Command mode: the typed /command stays inside the box, but its slash
		// command menu is moved OUT of the text area to sit below the bottom prompt
		// bar (between the box and the footer). Total height stays == boxHeight by
		// stealing interior rows for the menu, so the differential renderer is stable.
		if (this.commandMode) {
			const base = super.render(W); // [topBorder, ...input, bottomBorder, ...menu]
			const ed = this as unknown as {
				autocompleteState?: unknown;
				autocompleteList?: { render(w: number): string[] };
			};
			const rawMenu = ed.autocompleteState && ed.autocompleteList ? ed.autocompleteList.render(W) : [];
			// Keep at least one input row visible inside the box.
			const menuH = Math.min(rawMenu.length, Math.max(0, outlineHeight - 1));
			const menu = rawMenu.slice(0, menuH);
			// Strip the borders + menu from `base`, leaving just the input line(s).
			const inputLines = base.slice(1, Math.max(1, base.length - rawMenu.length - 1));
			const interiorH = outlineHeight - menuH;
			const interior: string[] = [];
			for (let k = 0; k < interiorH; k++) {
				interior.push(bgFillLine(truncateToWidth(inputLines[k] ?? "", W, ""), W, PANEL_BG));
			}
			// Transparent menu: no background fill, just the styled menu lines.
			const menuLines = menu.map((l) => truncateToWidth(l, W, ""));
			return [topBar, ...interior, bottomBar, ...menuLines];
		}

		// Flatten to a list of display LINES (a node may wrap to several), plus a
		// fixed box for bash output. `cursor` marks lines of the cursor node.
		const rows = this.model.visibleRows();
		const cursor = this.model.cursor;
		const display: { text: string; cursor: boolean }[] = [];
		let cursorDisp = 0;
		for (const row of rows) {
			const isCur = row.id === cursor.id;
			if (isCur) cursorDisp = display.length;
			for (const text of this.renderNodeLines(row, isCur ? cursor.col : -1, W, thm)) {
				display.push({ text, cursor: isCur });
			}
			const node = this.model.getNode(row.id);
			if (node?.kind === "bash" && node.output !== undefined && !row.collapsed) {
				for (const text of this.renderOutputBox(row.id, node.output, row.depth, W, thm)) {
					display.push({ text, cursor: false });
				}
			}
		}

		// Viewport over the display lines, keeping the cursor node's first line visible.
		if (cursorDisp < this.scrollTop) this.scrollTop = cursorDisp;
		else if (cursorDisp >= this.scrollTop + outlineHeight) {
			this.scrollTop = cursorDisp - outlineHeight + 1;
		}
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, display.length - outlineHeight)));
		const windowDisp = display.slice(this.scrollTop, this.scrollTop + outlineHeight);

		const interiorLines: string[] = [];
		for (let k = 0; k < outlineHeight; k++) {
			const d = windowDisp[k];
			if (!d) interiorLines.push(bgFillLine("", W));
			else interiorLines.push(bgFillLine(truncateToWidth(d.text, W, ""), W, d.cursor ? CURSOR_ROW_BG : PANEL_BG));
		}

		// Always exactly boxHeight lines: 1 top bar + outlineHeight + 1 bottom bar.
		return [topBar, ...interiorLines, bottomBar];
	}
}
