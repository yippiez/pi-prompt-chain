import { readFile, stat } from "node:fs/promises";
import path from "node:path";
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
	private boxScroll = new Map<NodeId, number>(); // per bash node: vertical output box scroll offset
	private boxHScroll = new Map<NodeId, number>(); // per bash node: horizontal output box scroll offset
	private autocompleteProvider: AutocompleteProvider | undefined;
	private completion:
		| { id: NodeId; prefix: string; items: AutocompleteItem[]; selected: number; source: "at" | "slash" | "bash" }
		| undefined;
	private completionRequestId = 0;
	private isInPaste = false;
	private pasteBuffer = "";
	private outlineHistory: OutlineSnapshot[] = [];
	private historyIndex: number | undefined;
	private historyDraft: OutlineSnapshot | undefined;
	private queuedPromptDrafts: string[] = [];

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
		if (text.length > 0) {
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
		if (this.getText().length > 0) this.setText("");

		if (this.handleOutlinePasteInput(data)) return;

		if (this.completion) {
			if (this.handleCompletionInput(data)) return;
			this.completion = undefined;
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
			if (this.queuedPromptDrafts.length > 0 || this.ctx.hasPendingMessages()) {
				const drafts = this.queuedPromptDrafts.splice(0);
				super.handleInput(data);
				const restored = this.getText();
				if (restored.length > 0) this.setText(restored);
				else if (drafts.length > 0) this.model = OutlineModel.fromMarkdown(drafts.join("\n"));
				this.activeTui.requestRender();
				return;
			}
			this.navigateOutlineHistory(-1);
			return;
		}
		if (matchesKey(data, "alt+down")) {
			this.navigateOutlineHistory(1);
			return;
		}
		if (matchesKey(data, "ctrl+left")) return this.run(() => this.moveWordLeft());
		if (matchesKey(data, "ctrl+right")) return this.run(() => this.moveWordRight());
		if (matchesKey(data, Key.up)) return this.run(() => this.moveCaretVisual(-1), false);
		if (matchesKey(data, Key.down)) return this.run(() => this.moveCaretVisual(1), false);
		if (matchesKey(data, Key.left)) return this.run(() => m.moveCaretLeft());
		if (matchesKey(data, Key.right)) return this.run(() => m.moveCaretRight());
		if (matchesKey(data, Key.home)) return this.run(() => m.caretHome());
		if (matchesKey(data, Key.end)) return this.run(() => m.caretEnd());
		if (matchesKey(data, "backspace")) {
			this.run(() => (m.cursor.col > 0 ? m.deleteCharBefore() : m.backspaceMerge()));
			void this.maybeOpenInlineCompletion();
			return;
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

		// Printable char.
		if (data.length === 1 && data.charCodeAt(0) >= 32) {
			this.run(() => m.insertChar(data));
			void this.maybeOpenInlineCompletion();
			return;
		}

		// Escape (abort), Ctrl+D (exit), Ctrl+P (model cycle), shortcuts -> app.
		super.handleInput(data);
	}

	private handleOutlinePasteInput(data: string): boolean {
		const start = "\x1b[200~";
		const end = "\x1b[201~";

		if (data.includes(start)) {
			this.isInPaste = true;
			this.pasteBuffer = "";
			data = data.replace(start, "");
		}

		if (this.isInPaste) {
			this.pasteBuffer += data;
			const endIndex = this.pasteBuffer.indexOf(end);
			if (endIndex === -1) return true;

			const pasted = this.cleanPasteText(this.pasteBuffer.slice(0, endIndex));
			const remaining = this.pasteBuffer.slice(endIndex + end.length);
			this.isInPaste = false;
			this.pasteBuffer = "";
			if (pasted.length > 0) this.run(() => this.pasteIntoOutline(pasted));
			if (remaining.length > 0) this.handleInput(remaining);
			return true;
		}

		const direct = this.normalizeDirectPaste(data);
		if (direct === undefined) return false;
		this.run(() => this.pasteIntoOutline(direct));
		return true;
	}

	private normalizeDirectPaste(data: string): string | undefined {
		if (data.length <= 1) return undefined;
		const decoded = this.decodePasteControlSequences(data);
		// If it is still an escape/control sequence without printable paste content,
		// let the app handle it as a keybinding instead.
		// biome-ignore lint/suspicious/noControlCharactersInRegex: distinguishing paste from key escape sequences
		if (!decoded.includes("\n") && /[\x00-\x08\x0b-\x1f\x7f]/.test(decoded)) return undefined;
		const cleaned = this.cleanPasteText(decoded, false);
		return cleaned.length > 0 ? cleaned : undefined;
	}

	private cleanPasteText(text: string, decode = true): string {
		const decoded = decode ? this.decodePasteControlSequences(text) : text;
		return decoded
			.replace(/\r\n?/g, "\n")
			.replace(/\t/g, "    ")
			.split("")
			.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
			.join("");
	}

	private decodePasteControlSequences(text: string): string {
		// Some terminals/tmux configurations encode control bytes inside bracketed
		// paste as CSI-u Ctrl+<letter> sequences. Decode those back before filtering.
		return text.replace(/\x1b\[(\d+);5u/g, (match, code: string) => {
			const cp = Number(code);
			if (cp >= 97 && cp <= 122) return String.fromCharCode(cp - 96);
			if (cp >= 65 && cp <= 90) return String.fromCharCode(cp - 64);
			return match;
		});
	}

	private pasteIntoOutline(text: string): void {
		if (this.model.isBlank() && text.split("\n").some((line) => /^(\s*)((?:-\s+)+)(.*)$/.test(line))) {
			this.model = OutlineModel.fromMarkdown(text);
			return;
		}
		this.model.pasteText(text);
	}

	private run(op: () => void, clearHistoryBrowse = true): void {
		this.completion = undefined;
		if (clearHistoryBrowse) this.stopHistoryBrowse();
		op();
		this.activeTui.requestRender();
	}

	private stopHistoryBrowse(): void {
		this.historyIndex = undefined;
		this.historyDraft = undefined;
	}

	private currentTextWidth(): number {
		const W = Math.max(1, this.activeTui.terminal.columns - 1);
		const row = this.model.visibleRows().find((r) => r.id === this.model.cursor.id);
		if (!row) return W;
		const branch = row.ancestorContinues.map((cont) => (cont ? BRANCH : BRANCH_BLANK)).join("");
		const glyph = row.hasChildren ? (row.collapsed ? NODE_FILLED : NODE_OPEN) : row.isLast ? BRANCH_ELBOW : BRANCH_TEE;
		const node = this.model.getNode(row.id);
		const isBash = node?.kind === "bash";
		const isFirstRow = this.model.visibleRows()[0]?.id === row.id;
		const isSlash = isFirstRow && row.depth === 0 && node?.kind === "node" && /^\/[\w:-]/.test(this.model.textOf(row.id));
		const prefixW = visibleWidth(`${branch}${glyph} ${isBash ? "$ " : isSlash ? "/" : ""}`);
		return Math.max(4, W - prefixW);
	}

	private moveCaretVisual(delta: -1 | 1): void {
		const id = this.model.cursor.id;
		const text = this.model.textOf(id);
		const chunks = wrapText(text, this.currentTextWidth());
		const col = this.model.cursor.col;
		const found = chunks.findIndex((chunk, i) => {
			const nextStart = chunks[i + 1]?.start;
			return col >= chunk.start && (nextStart === undefined ? col <= text.length : col < nextStart);
		});
		const idx = Math.max(0, found);
		const current = chunks[idx] ?? { start: 0, str: "" };
		const target = chunks[idx + delta];
		if (!target) {
			delta < 0 ? this.model.moveCaretUp() : this.model.moveCaretDown();
			return;
		}
		const x = Math.max(0, col - current.start);
		// A wrapped line's end offset is also the next line's start offset. Clamp to
		// the last character cell on the target visual line so moving up from a line
		// end doesn't land one cell to the right/down on the following wrap line.
		const targetMaxCol = target.start + Math.max(0, target.str.length - 1);
		this.model.cursor.col = Math.min(target.start + x, targetMaxCol);
	}

	private moveWordLeft(): void {
		const text = this.model.textOf(this.model.cursor.id);
		let i = this.model.cursor.col;
		while (i > 0 && /\s/.test(text[i - 1]!)) i--;
		while (i > 0 && !/\s/.test(text[i - 1]!)) i--;
		this.model.cursor.col = i;
	}

	private moveWordRight(): void {
		const text = this.model.textOf(this.model.cursor.id);
		let i = this.model.cursor.col;
		while (i < text.length && /\s/.test(text[i]!)) i++;
		while (i < text.length && !/\s/.test(text[i]!)) i++;
		this.model.cursor.col = i;
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

	private handleCompletionInput(data: string): boolean {
		const state = this.completion;
		if (!state || this.model.cursor.id !== state.id || state.items.length === 0) return false;

		if (matchesKey(data, "escape")) {
			this.completion = undefined;
			this.activeTui.requestRender();
			return true;
		}
		if (matchesKey(data, Key.up)) {
			state.selected = (state.selected + state.items.length - 1) % state.items.length;
			this.activeTui.requestRender();
			return true;
		}
		if (matchesKey(data, Key.down) || (state.source === "bash" && matchesKey(data, Key.ctrl("f")))) {
			state.selected = (state.selected + 1) % state.items.length;
			this.activeTui.requestRender();
			return true;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, "tab")) {
			this.applyCompletion(state.selected);
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

		this.completion = { id: b.id, prefix: suggestions.prefix, items: suggestions.items, selected: 0, source: "bash" };
		this.activeTui.requestRender();
	}

	private atPrefixBeforeCursor(): string | null {
		const text = this.model.textOf(this.model.cursor.id).slice(0, this.model.cursor.col);
		const quoted = text.match(/(?:^|\s)(@"[^"]*)$/);
		if (quoted) return quoted[1] ?? null;
		const unquoted = text.match(/(?:^|\s)(@[^\s@]*)$/);
		return unquoted?.[1] ?? null;
	}

	private slashPrefixBeforeCursor(): string | null {
		const rows = this.model.visibleRows();
		const rowIndex = rows.findIndex((r) => r.id === this.model.cursor.id);
		const row = rowIndex >= 0 ? rows[rowIndex] : undefined;
		if (!row || row.depth !== 0 || rowIndex !== 0) return null;
		const text = this.model.textOf(this.model.cursor.id).slice(0, this.model.cursor.col);
		const match = text.match(/(?:^|\s)(\/[\w:-]*)$/);
		return match?.[1] ?? null;
	}

	/** Open/update @file or /command completions inside the current outline node. */
	private async maybeOpenInlineCompletion(): Promise<void> {
		if (!this.autocompleteProvider) return;
		const atPrefix = this.atPrefixBeforeCursor();
		const slashPrefix = this.slashPrefixBeforeCursor();
		const source = atPrefix ? "at" : slashPrefix ? "slash" : undefined;
		if (!source) {
			if (this.completion?.source === "at" || this.completion?.source === "slash") {
				this.completion = undefined;
				this.activeTui.requestRender();
			}
			return;
		}

		const id = this.model.cursor.id;
		const text = this.model.textOf(id);
		const col = this.model.cursor.col;
		const requestId = ++this.completionRequestId;
		const signal = new AbortController().signal;
		const suggestions = await this.autocompleteProvider
			.getSuggestions([text], 0, col, { signal, force: false })
			.catch(() => null);
		if (requestId !== this.completionRequestId || this.model.cursor.id !== id || this.model.cursor.col !== col) return;
		if (!suggestions || suggestions.items.length === 0) {
			this.completion = undefined;
		} else {
			this.completion = { id, prefix: suggestions.prefix, items: suggestions.items, selected: 0, source };
		}
		this.activeTui.requestRender();
	}

	private applyCompletion(index: number): void {
		const state = this.completion;
		if (!state || this.model.cursor.id !== state.id || !this.autocompleteProvider) return;
		const item = state.items[index];
		if (!item) return;

		const text = this.model.textOf(state.id);
		const applied = this.autocompleteProvider.applyCompletion([text], 0, this.model.cursor.col, item, state.prefix);
		this.model.replaceCursorText(applied.lines.join("\n"), applied.cursorCol);
		this.completion = undefined;
		this.activeTui.requestRender();
	}

	private singleSlashCommand(): string | undefined {
		const rows = this.model.visibleRows();
		if (rows.length !== 1) return undefined;
		const row = rows[0]!;
		if (row.hasChildren) return undefined;
		const node = this.model.getNode(row.id);
		if (node?.kind !== "node") return undefined;
		const text = this.model.textOf(row.id).trim();
		return /^\/[\w:-]+(?:\s+.*)?$/.test(text) ? text : undefined;
	}

	/** Compose the whole outline as markdown, send it to the agent, and clear. */
	private async sendOutline(): Promise<void> {
		if (this.model.isBlank()) return;
		const slashCommand = this.singleSlashCommand();
		if (slashCommand) {
			super.setText(slashCommand);
			super.handleInput("\r");
			this.model = new OutlineModel(new Map(), [], new Set());
			this.activeTui.requestRender();
			return;
		}
		const md = this.model.composeMarkdown();
		if (!md.trim()) return;
		const prompt = await this.expandFileReferences(md);
		this.outlineHistory.push(this.model.snapshot());
		this.stopHistoryBrowse();
		// Send as a rendered custom message so the transcript matches the outline
		// editor, while the LLM still receives the underlying markdown prompt.
		if (this.ctx.isIdle()) {
			this.pi.sendMessage({ customType: "pi-prompt-chain-user", content: prompt, display: true, details: { markdown: md } }, { triggerTurn: true });
		} else {
			this.queuedPromptDrafts.push(md);
			this.pi.sendUserMessage(prompt, { deliverAs: "followUp" });
		}
		// Clear the outline — reset to a single empty root node.
		this.model = new OutlineModel(new Map(), [], new Set());
		this.activeTui.requestRender();
	}

	private async expandFileReferences(prompt: string): Promise<string> {
		const refs = this.findFileReferences(prompt);
		if (refs.length === 0) return prompt;

		const blocks: string[] = [];
		const seen = new Set<string>();
		for (const ref of refs) {
			const abs = this.resolveReferencePath(ref);
			if (seen.has(abs)) continue;
			seen.add(abs);
			blocks.push(await this.readReferenceBlock(abs));
		}
		return `${blocks.join("\n")}\n\n${prompt}`;
	}

	private findFileReferences(text: string): string[] {
		const refs: string[] = [];
		const re = /(?:^|[\s(])@(?:"((?:\\.|[^"\\])*)"|([^\s`"'<>]+))/g;
		let inBashOutput = false;
		for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
			if (line.trim().startsWith("<bash-output")) {
				inBashOutput = true;
				continue;
			}
			if (inBashOutput) {
				if (line.trim() === "</bash-output>") inBashOutput = false;
				continue;
			}
			// Bash command nodes are context already; don't treat @ inside shell commands as file attachments.
			if (/^\s*-\s+`\$\s/.test(line)) continue;
			for (const match of line.matchAll(re)) {
				const raw = match[1] ?? match[2] ?? "";
				const cleaned = this.cleanReferencePath(raw);
				if (cleaned.length > 0) refs.push(cleaned);
			}
		}
		return refs;
	}

	private cleanReferencePath(raw: string): string {
		let p = raw.replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		// Common sentence punctuation should not become part of an unquoted @path.
		while (/[.,;:!?)]$/.test(p)) p = p.slice(0, -1);
		return p;
	}

	private resolveReferencePath(ref: string): string {
		const withHome = ref === "~" || ref.startsWith("~/") ? path.join(process.env.HOME ?? "", ref.slice(1)) : ref;
		return path.resolve(this.ctx.cwd, withHome);
	}

	private async readReferenceBlock(abs: string): Promise<string> {
		const name = this.escapeXml(abs);
		try {
			const st = await stat(abs);
			if (st.isDirectory()) return `<file name="${name}">[Directory reference; use read/list tools for contents.]</file>`;
			if (st.size === 0) return `<file name="${name}">[Empty file.]</file>`;
			const content = await readFile(abs, "utf8");
			return `<file name="${name}">\n${content}\n</file>`;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return `<file name="${name}">[Could not read file: ${this.escapeXml(message)}]</file>`;
		}
	}

	private escapeXml(s: string): string {
		return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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

	/** Rounded box showing a bash node's output (up to BOX_CONTENT_H lines; scrolls inside when longer). */
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
		const contentH = Math.min(BOX_CONTENT_H, Math.max(1, all.length));
		const scroll = Math.min(this.boxScroll.get(id) ?? 0, Math.max(0, all.length - contentH));
		const maxHScroll = Math.max(0, ...all.map((line) => visibleWidth(line) - innerW));
		const hscroll = Math.min(this.boxHScroll.get(id) ?? 0, maxHScroll);

		const lines: string[] = [];
		const label = hscroll > 0 ? ` stdout @${hscroll} ` : " stdout ";
		lines.push(dim(`${indent}╭${label}${"─".repeat(Math.max(0, boxW - 2 - label.length))}╮`));
		for (let i = 0; i < contentH; i++) {
			let cell = truncateToWidth(sliceDisplayWidth(all[scroll + i] ?? "", hscroll, innerW + 1), innerW, "…");
			cell += " ".repeat(Math.max(0, innerW - visibleWidth(cell)));
			lines.push(dim(`${indent}│ ${cell} │`));
		}
		const more = all.length - (scroll + contentH);
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
		const rawText = this.model.textOf(row.id);
		const isFirstRow = this.model.visibleRows()[0]?.id === row.id;
		const isSlash = isFirstRow && row.depth === 0 && node?.kind === "node" && /^\/[\w:-]/.test(rawText);
		const firstBranch = this.branchPrefix(row, false);
		const contBranch = this.branchPrefix(row, true);
		const glyph = isBash
			? thm.fg("error", NODE_FILLED) // red circle for bash nodes
			: isSlash
				? thm.fg("accent", NODE_FILLED) // blue filled circle for slash-command nodes
				: thm.fg("accent", row.hasChildren && row.collapsed ? NODE_FILLED : NODE_OPEN);
		const cmdMark = isBash ? "$ " : isSlash ? "/" : "";
		// Prefix width = graph branch + glyph(1) + space(1) + command marker.
		const prefixW = visibleWidth(firstBranch.plain) + 2 + cmdMark.length;
		const textW = Math.max(4, width - prefixW);
		const paint = (s: string) => (isBash ? thm.fg("muted", s) : isSlash ? thm.fg("accent", s) : s);
		const text = isSlash ? rawText.slice(1) : rawText;
		const displayCaretCol = isSlash && caretCol >= 0 ? Math.max(0, caretCol - 1) : caretCol;

		const firstPrefix = `${firstBranch.styled}${glyph} ${cmdMark ? thm.fg("muted", cmdMark) : ""}`;
		const chunks = wrapText(text, textW);
		// Wrapped continuation lines only keep a connector in the node-glyph column
		// when the node actually has children. For leaf nodes, showing a lone vertical
		// pipe on overflow/wrapped lines incorrectly implies a child connection.
		const wrapGuide = chunks.length > 1 && row.hasChildren ? thm.fg("dim", BRANCH) : "  ";
		const contPrefix = `${contBranch.styled}${wrapGuide}${" ".repeat(cmdMark.length)}`;
		const lines: string[] = [];
		let caretLine = 0;
		for (let li = 0; li < chunks.length; li++) {
			const { str, start } = chunks[li]!;
			const end = start + str.length;
			let body: string;
			const onCaret =
				displayCaretCol >= 0 &&
				displayCaretCol >= start &&
				(displayCaretCol < end || (li === chunks.length - 1 && displayCaretCol === end));
			if (onCaret) {
				caretLine = li;
				const rel = displayCaretCol - start;
				const at = rel < str.length ? str[rel]! : " ";
				body = `${paint(str.slice(0, rel))}\x1b[7m${at}\x1b[27m${paint(str.slice(rel + 1))}`;
			} else {
				body = paint(str);
			}
			lines.push(`${li === 0 ? firstPrefix : contPrefix}${body}`);
		}
		return { lines, caretLine };
	}

	private renderCompletionMenu(width: number, maxHeight: number, thm: ExtensionContext["ui"]["theme"]): string[] {
		const state = this.completion;
		if (!state || this.model.cursor.id !== state.id || maxHeight <= 0) return [];

		const rows: string[] = [];
		rows.push(thm.fg("dim", truncateToWidth(`   (${state.selected + 1}/${state.items.length})`, width, "…")));
		const count = Math.min(Math.max(0, maxHeight - 1), state.items.length);
		const start = Math.max(0, Math.min(state.selected - count + 1, state.items.length - count));
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

		const queued = this.queuedPromptDrafts.length > 0 ? ` · ${this.queuedPromptDrafts.length} queued` : "";
		const sessionName = `${this.pi.getSessionName() ?? "untitled"}${queued}`;
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

		// Flatten to a list of display LINES (a node may wrap to several), plus an
		// output box for bash output. `cursor` marks lines of the cursor node.
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
			for (let i = 0; i < rendered.lines.length; i++) {
				display.push({ text: rendered.lines[i]!, cursor: isCur && i === rendered.caretLine });
			}
			const node = this.model.getNode(row.id);
			if (node?.kind === "bash" && node.output !== undefined && !row.collapsed) {
				for (const text of this.renderOutputBox(row.id, node.output, row, W, thm)) {
					display.push({ text, cursor: false });
				}
			}
			if (isCur) cursorKeepEnd = Math.max(cursorDisp, display.length - 1);
		}

		// File/path completion dropdown renders like the slash-command menu:
		// transparent, outside the prompt box, below the bottom bar. It does not
		// steal rows from the outline viewport, so the prompt/outline size stays put.
		const completionMenu = this.renderCompletionMenu(W, Math.max(0, Math.min(6, outlineHeight - 1)), thm);
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

		return [topBar, ...interiorLines, bottomBar, ...completionMenu];
	}
}
