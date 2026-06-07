import { CustomEditor, type ExtensionAPI, type ExtensionContext, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, type AutocompleteItem, type AutocompleteProvider, type EditorTheme, type TUI } from "@earendil-works/pi-tui";
import { OutlineModel, type NodeId, type OutlineSnapshot, type VisibleRow } from "./nodes.ts";
import { BOX_CONTENT_H, BOX_MAX_W, BRANCH, BRANCH_BLANK, BRANCH_ELBOW, BRANCH_TEE, CURSOR_ROW_BG, NODE_FILLED, NODE_OPEN, PANEL_BG, PROMPT_HEIGHT_RATIO, bgFillLine, fitBorder, formatContext, formatCwd, sanitizeOutput, sliceDisplayWidth, wrapText } from "./render.ts";

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
	private boxScroll = new Map<NodeId, number>(); // per bash node: vertical output box scroll offset
	private boxHScroll = new Map<NodeId, number>(); // per bash node: horizontal output box scroll offset
	private autocompleteProvider: AutocompleteProvider | undefined;
	private bashCompletion:
		| { id: NodeId; prefix: string; items: AutocompleteItem[]; selected: number }
		| undefined;
	private outlineHistory: OutlineSnapshot[] = [];
	private historyIndex: number | undefined;
	private historyDraft: OutlineSnapshot | undefined;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private ctx: ExtensionContext,
		private pi: ExtensionAPI,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.activeTui = tui;
		this.model = new OutlineModel(new Map(), [], new Set());
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

	override setAutocompleteProvider(provider: AutocompleteProvider): void {
		this.autocompleteProvider = provider;
		super.setAutocompleteProvider(provider);
	}

	override setText(text: string): void {
		// App-level actions such as Alt+Up restore queued messages by calling
		// editor.setText(). In outline mode, convert that restored text into outline
		// nodes instead of leaving it in CustomEditor's hidden text buffer.
		if (!this.commandMode && text.length > 0 && !text.startsWith("/")) {
			this.model = OutlineModel.fromMarkdown(text);
			this.stopHistoryBrowse();
			super.setText("");
			this.activeTui?.requestRender();
			return;
		}
		super.setText(text);
	}

	/** Clear timers on shutdown so the refresh interval doesn't outlive the session. */
	async dispose(): Promise<void> {
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
	}

	/* ---- input (Workflowy always-editing) ---- */

	override handleInput(data: string): void {
		const m = this.model;

		// The base CustomEditor has its own hidden text buffer. Keep it empty while
		// we are in outline mode so app-level actions cannot leave stale text that
		// later breaks slash-command mode.
		if (!this.commandMode && this.getText().length > 0) this.setText("");

		if (this.bashCompletion) {
			if (this.handleBashCompletionInput(data)) return;
			this.bashCompletion = undefined;
		}

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
			this.setText("");
			this.commandMode = true;
			super.handleInput("/");
			this.activeTui.requestRender();
			return;
		}

		if (matchesKey(data, Key.enter)) return this.run(() => m.enter());
		if (matchesKey(data, "ctrl+backspace")) return this.run(() => m.deleteCurrentNode());
		if (matchesKey(data, "tab")) return this.run(() => m.indent());
		if (matchesKey(data, "shift+tab")) return this.run(() => m.outdent());
		if (matchesKey(data, "alt+shift+up") || matchesKey(data, "shift+alt+up")) return this.run(() => m.moveNodeUp());
		if (matchesKey(data, "alt+shift+down") || matchesKey(data, "shift+alt+down")) return this.run(() => m.moveNodeDown());
		// Browse sent-outline history only with Alt+Up/Down, not plain arrows, so
		// normal navigation at the first/last node cannot accidentally replace the draft.
		if (matchesKey(data, "alt+up")) {
			this.navigateOutlineHistory(-1);
			return;
		}
		if (matchesKey(data, "alt+down")) {
			this.navigateOutlineHistory(1);
			return;
		}
		if (matchesKey(data, Key.up)) return this.run(() => m.moveCaretUp(), false);
		if (matchesKey(data, Key.down)) return this.run(() => m.moveCaretDown(), false);
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
		if (matchesKey(data, Key.ctrl("f"))) return void this.completeBashPath();
		if (matchesKey(data, "pageDown")) return this.run(() => this.scrollBox(1));
		if (matchesKey(data, "pageUp")) return this.run(() => this.scrollBox(-1));
		if (matchesKey(data, "alt+right")) return this.run(() => this.scrollBoxHorizontal(1));
		if (matchesKey(data, "alt+left")) return this.run(() => this.scrollBoxHorizontal(-1));

		// "!" at the start of a plain node turns it into a bash node. If the node
		// already has text, keep that text as the command instead of inserting "!".
		if (data === "!") {
			const node = m.getNode(m.cursor.id);
			if (node?.kind === "node" && m.cursor.col === 0) {
				return this.run(() => m.convertCursorToBash());
			}
		}

		// Printable char, or a paste. Bracketed paste includes control bytes, and
		// multi-line clipboard text includes newlines, so handle it before falling
		// through to the base editor.
		if (data.length === 1 && data.charCodeAt(0) >= 32) return this.run(() => m.insertChar(data));
		const paste = this.normalizePaste(data);
		if (paste !== undefined) return this.run(() => m.pasteText(paste));

		// Escape (abort), Ctrl+D (exit), Ctrl+P (model cycle), shortcuts -> app.
		super.handleInput(data);
	}

	private normalizePaste(data: string): string | undefined {
		if (data.length <= 1) return undefined;
		let text = data;
		if (text.startsWith("\x1b[200~") && text.endsWith("\x1b[201~")) {
			text = text.slice("\x1b[200~".length, -"\x1b[201~".length);
		}
		// If it is still an escape/control sequence without printable paste content,
		// let the app handle it as a keybinding instead.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: distinguishing paste from key escape sequences
		if (!text.includes("\n") && /[\x00-\x08\x0b-\x1f\x7f]/.test(text)) return undefined;
		return text;
	}

	private run(op: () => void, clearHistoryBrowse = true): void {
		this.bashCompletion = undefined;
		if (clearHistoryBrowse) this.stopHistoryBrowse();
		op();
		this.activeTui.requestRender();
	}

	private stopHistoryBrowse(): void {
		this.historyIndex = undefined;
		this.historyDraft = undefined;
	}

	private navigateOutlineHistory(dir: -1 | 1): boolean {
		if (this.outlineHistory.length === 0) return false;
		const rows = this.model.visibleRows();
		const rowIdx = rows.findIndex((row) => row.id === this.model.cursor.id);
		if (dir < 0 && rowIdx > 0) return false;
		if (dir > 0 && rowIdx !== -1 && rowIdx < rows.length - 1) return false;

		if (this.historyIndex === undefined) {
			if (dir > 0) return false;
			this.historyDraft = this.model.snapshot();
			this.historyIndex = this.outlineHistory.length - 1;
		} else {
			this.historyIndex += dir;
		}

		if (this.historyIndex < 0) {
			this.historyIndex = 0;
			return false;
		}
		if (this.historyIndex >= this.outlineHistory.length) {
			if (this.historyDraft) this.model = OutlineModel.fromSnapshot(this.historyDraft);
			this.stopHistoryBrowse();
			this.activeTui.requestRender();
			return true;
		}

		this.model = OutlineModel.fromSnapshot(this.outlineHistory[this.historyIndex]!);
		this.activeTui.requestRender();
		return true;
	}

	private handleBashCompletionInput(data: string): boolean {
		const state = this.bashCompletion;
		const b = this.model.cursorBash();
		if (!state || !b || b.id !== state.id) return false;

		if (matchesKey(data, "escape")) {
			this.bashCompletion = undefined;
			this.activeTui.requestRender();
			return true;
		}
		if (matchesKey(data, Key.up)) {
			state.selected = (state.selected + state.items.length - 1) % state.items.length;
			this.activeTui.requestRender();
			return true;
		}
		if (matchesKey(data, Key.down) || matchesKey(data, Key.ctrl("f"))) {
			state.selected = (state.selected + 1) % state.items.length;
			this.activeTui.requestRender();
			return true;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, "tab")) {
			this.applyBashCompletion(state.selected);
			return true;
		}
		return false;
	}

	/** Run the cursor's bash node and attach its output. */
	private async runBash(): Promise<void> {
		const b = this.model.cursorBash();
		if (!b || !b.command.trim()) return;
		this.model.setBashResult(b.id, "…running…", -1);
		this.activeTui.requestRender();
		const res = await this.pi
			.exec("bash", ["-c", b.command], { cwd: this.ctx.cwd })
			.catch(() => undefined);
		const output = res ? sanitizeOutput(`${res.stdout}${res.stderr}`).replace(/\n+$/, "") : "(exec failed)";
		this.model.setBashResult(b.id, output, res?.code ?? -1);
		this.activeTui.requestRender();
	}

	/** Open bash path completions using pi's built-in path provider. */
	private async completeBashPath(): Promise<void> {
		const b = this.model.cursorBash();
		if (!b || !this.autocompleteProvider) return;

		const signal = new AbortController().signal;
		const suggestions = await this.autocompleteProvider
			.getSuggestions([b.command], 0, this.model.cursor.col, { signal, force: true })
			.catch(() => null);
		if (!suggestions || suggestions.items.length === 0) return;

		this.bashCompletion = { id: b.id, prefix: suggestions.prefix, items: suggestions.items, selected: 0 };
		this.activeTui.requestRender();
	}

	private applyBashCompletion(index: number): void {
		const state = this.bashCompletion;
		const b = this.model.cursorBash();
		if (!state || !b || b.id !== state.id || !this.autocompleteProvider) return;
		const item = state.items[index];
		if (!item) return;

		const applied = this.autocompleteProvider.applyCompletion([b.command], 0, this.model.cursor.col, item, state.prefix);
		this.model.replaceCursorText(applied.lines.join("\n"), applied.cursorCol);
		this.bashCompletion = undefined;
		this.activeTui.requestRender();
	}

	/** Compose the whole outline as markdown, send it to the agent, and clear. */
	private sendOutline(): void {
		const md = this.model.composeMarkdown();
		if (!md.trim()) return;
		this.outlineHistory.push(this.model.snapshot());
		this.stopHistoryBrowse();
		// isIdle() lives on the ExtensionContext, not the ExtensionAPI.
		this.pi.sendUserMessage(md, this.ctx.isIdle() ? undefined : { deliverAs: "steer" });
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

	/** Scroll the cursor bash node's output box horizontally. */
	private scrollBoxHorizontal(dir: number): void {
		const b = this.model.cursorBash();
		const node = b && this.model.getNode(b.id);
		if (!node || node.kind !== "bash" || node.output === undefined) return;
		const cur = this.boxHScroll.get(b.id) ?? 0;
		this.boxHScroll.set(b.id, Math.max(0, cur + dir * 8));
	}

	private branchPrefix(row: VisibleRow, continuation: boolean): { plain: string; styled: string } {
		if (row.depth === 0) return { plain: "", styled: "" };
		// Skip the root ancestor column; first-level children should branch directly
		// from the root node circle, not after a leading blank column.
		const parts: string[] = row.ancestorContinues.slice(1).map((continues) => (continues ? BRANCH : BRANCH_BLANK));
		parts.push(continuation ? (row.isLast ? BRANCH_BLANK : BRANCH) : row.isLast ? BRANCH_ELBOW : BRANCH_TEE);
		const plain = parts.join("");
		return { plain, styled: this.ctx.ui.theme.fg("dim", plain) };
	}

	/** Fixed-height rounded box showing a bash node's output (scrolls inside). */
	private renderOutputBox(
		id: NodeId,
		output: string,
		row: VisibleRow,
		width: number,
		thm: ExtensionContext["ui"]["theme"],
	): string[] {
		const dim = (s: string) => thm.fg("dim", s);
		const indent = this.branchPrefix(row, true).plain + "  "; // align under the node circle
		const boxW = Math.max(8, Math.min(BOX_MAX_W, width - visibleWidth(indent)));
		const innerW = boxW - 4; // "│ " + content + " │"
		const all = sanitizeOutput(output).replace(/\n+$/, "").split("\n");
		const scroll = Math.min(this.boxScroll.get(id) ?? 0, Math.max(0, all.length - BOX_CONTENT_H));
		const maxHScroll = Math.max(0, ...all.map((line) => visibleWidth(line) - innerW));
		const hscroll = Math.min(this.boxHScroll.get(id) ?? 0, maxHScroll);

		const lines: string[] = [];
		const label = hscroll > 0 ? ` stdout @${hscroll} ` : " stdout ";
		lines.push(dim(`${indent}╭${label}${"─".repeat(Math.max(0, boxW - 2 - label.length))}╮`));
		for (let i = 0; i < BOX_CONTENT_H; i++) {
			let cell = truncateToWidth(sliceDisplayWidth(all[scroll + i] ?? "", hscroll, innerW + 1), innerW, "…");
			cell += " ".repeat(Math.max(0, innerW - visibleWidth(cell)));
			lines.push(dim(`${indent}│ ${cell} │`));
		}
		const more = all.length - (scroll + BOX_CONTENT_H);
		const tags = [
			all.length > BOX_CONTENT_H ? "Pg↑↓" : "",
			maxHScroll > 0 ? "⌥←→" : "",
			more > 0 ? `↓${more}` : scroll > 0 ? `↑${scroll}` : "",
			hscroll > 0 ? `←${hscroll}` : "",
		].filter(Boolean);
		const tag = tags.length > 0 ? ` ${tags.join(" ")} ` : "";
		lines.push(dim(`${indent}╰${"─".repeat(Math.max(0, boxW - 2 - visibleWidth(tag)))}${tag}╯`));
		return lines;
	}

	/* ---- rendering ---- */

	/** Render one node as one OR MORE lines: long text wraps; continuation lines
	 *  keep graph columns alive. `caretLine` points at the wrapped line containing
	 *  the caret, so scrolling follows wrapped typing instead of only the node top. */
	private renderNodeLines(
		row: VisibleRow,
		caretCol: number,
		width: number,
		thm: ExtensionContext["ui"]["theme"],
	): { lines: string[]; caretLine: number } {
		const node = this.model.getNode(row.id);
		const isBash = node?.kind === "bash";
		const firstBranch = this.branchPrefix(row, false);
		const contBranch = this.branchPrefix(row, true);
		const glyph = isBash
			? thm.fg("error", NODE_FILLED) // red circle for bash nodes
			: thm.fg("accent", row.hasChildren && row.collapsed ? NODE_FILLED : NODE_OPEN);
		const cmdMark = isBash ? "$ " : "";
		// Prefix width = graph branch + glyph(1) + space(1) + "$ "
		const prefixW = visibleWidth(firstBranch.plain) + 2 + cmdMark.length;
		const textW = Math.max(4, width - prefixW);
		const paint = (s: string) => (isBash ? thm.fg("muted", s) : s);
		const text = this.model.textOf(row.id);

		const firstPrefix = `${firstBranch.styled}${glyph} ${isBash ? thm.fg("muted", cmdMark) : ""}`;
		const contPrefix = `${contBranch.styled}${" ".repeat(2 + cmdMark.length)}`;
		const chunks = wrapText(text, textW);
		const lines: string[] = [];
		let caretLine = 0;
		for (let li = 0; li < chunks.length; li++) {
			const { str, start } = chunks[li]!;
			const end = start + str.length;
			let body: string;
			const onCaret =
				caretCol >= 0 &&
				caretCol >= start &&
				(caretCol < end || (li === chunks.length - 1 && caretCol === end));
			if (onCaret) {
				caretLine = li;
				const rel = caretCol - start;
				const at = rel < str.length ? str[rel]! : " ";
				body = `${paint(str.slice(0, rel))}\x1b[7m${at}\x1b[27m${paint(str.slice(rel + 1))}`;
			} else {
				body = paint(str);
			}
			lines.push(`${li === 0 ? firstPrefix : contPrefix}${body}`);
		}
		return { lines, caretLine };
	}

	private renderBashCompletionMenu(width: number, maxHeight: number, thm: ExtensionContext["ui"]["theme"]): string[] {
		const state = this.bashCompletion;
		const b = this.model.cursorBash();
		if (!state || !b || b.id !== state.id || maxHeight <= 0) return [];

		const count = Math.min(maxHeight, state.items.length);
		const start = Math.max(0, Math.min(state.selected - count + 1, state.items.length - count));
		const rows: string[] = [];
		for (let k = 0; k < count; k++) {
			const idx = start + k;
			const item = state.items[idx]!;
			const selected = idx === state.selected;
			const arrow = selected ? thm.fg("accent", "→") : " ";
			const desc = item.description ? thm.fg("dim", `  ${item.description}`) : "";
			rows.push(truncateToWidth(` ${arrow} ${item.label}${desc}`, width, "…"));
		}
		return rows;
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
		let cursorKeepEnd = 0;
		for (const row of rows) {
			const isCur = row.id === cursor.id;
			const nodeStart = display.length;
			const rendered = this.renderNodeLines(row, isCur ? cursor.col : -1, W, thm);
			if (isCur) cursorDisp = nodeStart + rendered.caretLine;
			for (const text of rendered.lines) {
				display.push({ text, cursor: isCur });
			}
			const node = this.model.getNode(row.id);
			if (node?.kind === "bash" && node.output !== undefined && !row.collapsed) {
				for (const text of this.renderOutputBox(row.id, node.output, row, W, thm)) {
					display.push({ text, cursor: false });
				}
			}
			if (isCur) cursorKeepEnd = Math.max(cursorDisp, display.length - 1);
		}

		// Bash completion dropdown renders like the slash-command menu: transparent,
		// outside the prompt box, above the top bar. It does not steal rows from the
		// outline viewport, so the prompt/outline size does not change.
		const completionMenu = this.renderBashCompletionMenu(W, Math.max(0, Math.min(6, outlineHeight - 1)), thm);
		const viewportHeight = outlineHeight;

		// Viewport over display lines. Follow the actual wrapped caret line, and if
		// the cursor is a bash node with output, keep that output box in view too.
		if (cursorDisp < this.scrollTop) this.scrollTop = cursorDisp;
		if (cursorKeepEnd >= this.scrollTop + viewportHeight) this.scrollTop = cursorKeepEnd - viewportHeight + 1;
		// If the cursor block is taller than the viewport, caret visibility wins.
		if (cursorDisp < this.scrollTop) this.scrollTop = cursorDisp;
		else if (cursorDisp >= this.scrollTop + viewportHeight) this.scrollTop = cursorDisp - viewportHeight + 1;
		this.scrollTop = Math.max(0, Math.min(this.scrollTop, Math.max(0, display.length - viewportHeight)));
		const windowDisp = display.slice(this.scrollTop, this.scrollTop + viewportHeight);

		const interiorLines: string[] = [];
		for (let k = 0; k < viewportHeight; k++) {
			const d = windowDisp[k];
			if (!d) interiorLines.push(bgFillLine("", W));
			else interiorLines.push(bgFillLine(truncateToWidth(d.text, W, ""), W, d.cursor ? CURSOR_ROW_BG : PANEL_BG));
		}

		return [...completionMenu, topBar, ...interiorLines, bottomBar];
	}
}
