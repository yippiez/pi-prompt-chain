import {
	CustomEditor,
	ToolExecutionComponent,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
	type ExtensionContext,
	type KeybindingsManager,
} from "@earendil-works/pi-coding-agent";
import type { Component, EditorTheme, TUI } from "@earendil-works/pi-tui";
import { Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/* ── prompt-chain data model ─────────────────────────────
 * A tree of nodes the prompt chain is built from. Every node has a stable UUID.
 *
 *   Node          content node; can hold an unbounded number of child nodes
 *   BashNode      content node backed by a bash command + its captured result
 *   MirroredNode  pointer only — a live mirror of another node (by UUID)
 *   BacklinkNode  pointer only — a navigational reference to another node (by UUID)
 *
 * Children and pointer targets are referenced by UUID and resolved through a
 * flat NodeStore, so the graph can share/alias nodes without duplicating them.
 */

/** A v4 UUID. Every node — and every pointer target — is one of these. */
export type NodeId = string;

/** Discriminates the node union. */
export type NodeKind = "node" | "bash" | "mirrored" | "backlink";

/** Fields shared by every node. */
export interface NodeBase {
	/** Stable unique identity (UUID v4). */
	readonly id: NodeId;
	readonly kind: NodeKind;
}

/** A plain content node. Holds an unbounded number of child nodes. */
export interface Node extends NodeBase {
	readonly kind: "node";
	text: string;
	/** Child node ids — infinite nesting; resolved through the NodeStore. */
	children: NodeId[];
}

/** A content node backed by a bash command and its captured result. */
export interface BashNode extends NodeBase {
	readonly kind: "bash";
	command: string;
	output?: string;
	exitCode?: number;
	children: NodeId[];
}

/** A live mirror of another node. Pointer only — has its own id + a target. */
export interface MirroredNode extends NodeBase {
	readonly kind: "mirrored";
	/** UUID of the node being mirrored. */
	target: NodeId;
}

/** A backlink to another node. Pointer only — has its own id + a target. */
export interface BacklinkNode extends NodeBase {
	readonly kind: "backlink";
	/** UUID of the node being referenced. */
	target: NodeId;
}

/** Any node in the tree. */
export type AnyNode = Node | BashNode | MirroredNode | BacklinkNode;

/** Nodes that can contain children. */
export type ParentNode = Node | BashNode;

/** Pointer-only nodes that reference another node by UUID. */
export type PointerNode = MirroredNode | BacklinkNode;

/** Flat id→node store; children and targets are resolved through it by UUID. */
export type NodeStore = Map<NodeId, AnyNode>;

/* node factories — every node gets a fresh UUID */

export function createNode(text = "", children: NodeId[] = []): Node {
	return { id: randomUUID(), kind: "node", text, children };
}

export function createBashNode(command: string, children: NodeId[] = []): BashNode {
	return { id: randomUUID(), kind: "bash", command, children };
}

export function createMirroredNode(target: NodeId): MirroredNode {
	return { id: randomUUID(), kind: "mirrored", target };
}

export function createBacklinkNode(target: NodeId): BacklinkNode {
	return { id: randomUUID(), kind: "backlink", target };
}

/* type guards & helpers */

export function isParentNode(node: AnyNode): node is ParentNode {
	return node.kind === "node" || node.kind === "bash";
}

export function isPointerNode(node: AnyNode): node is PointerNode {
	return node.kind === "mirrored" || node.kind === "backlink";
}

/** Resolve a pointer node (or any id) to the node it ultimately refers to. */
export function resolveTarget(store: NodeStore, node: PointerNode): AnyNode | undefined {
	return store.get(node.target);
}

/* ── outline model ──────────────────────────────────────
 * Workflowy-style outline over the node store. Pure data + ops; no I/O, no
 * rendering. The editor owns one instance and drives it from keystrokes.
 */

export interface VisibleRow {
	id: NodeId;
	depth: number;
	hasChildren: boolean;
	collapsed: boolean;
}

interface OutlineMeta {
	t: "meta";
	v: 1;
	roots: NodeId[];
	collapsed: NodeId[];
}

export class OutlineModel {
	cursor: { id: NodeId; col: number } = { id: "", col: 0 };
	// selection: Set<NodeId>  (Milestone 2: multi-select -> markdown -> send)

	constructor(
		private store: NodeStore,
		private roots: NodeId[],
		private collapsed: Set<NodeId>,
	) {
		this.ensureNonEmpty();
	}

	/* ---- invariants / helpers ---- */

	private ensureNonEmpty(): void {
		this.roots = this.roots.filter((id) => this.store.has(id));
		if (this.roots.length === 0) {
			const root = createNode("");
			this.store.set(root.id, root);
			this.roots = [root.id];
		}
		if (!this.store.has(this.cursor.id)) this.cursor = { id: this.roots[0]!, col: 0 };
		this.clampCol();
	}

	private clampCol(): void {
		const len = this.textOf(this.cursor.id).length;
		this.cursor.col = Math.max(0, Math.min(this.cursor.col, len));
	}

	getNode(id: NodeId): AnyNode | undefined {
		return this.store.get(id);
	}

	/** Editable text for a node (single chokepoint; pointers resolve later). */
	textOf(id: NodeId): string {
		const node = this.store.get(id);
		if (!node) return "";
		if (node.kind === "node") return node.text;
		if (node.kind === "bash") return node.command;
		return ""; // mirrored / backlink — resolved in a later milestone
	}

	private setNodeText(id: NodeId, text: string): void {
		const node = this.store.get(id);
		if (!node) return;
		if (node.kind === "node") node.text = text;
		else if (node.kind === "bash") node.command = text;
	}

	childrenOf(id: NodeId): NodeId[] {
		const node = this.store.get(id);
		return node && isParentNode(node) ? node.children : [];
	}

	/** Locate a node's parent context. parentId === null means it is a root. */
	private findParent(id: NodeId): { parentId: NodeId | null; siblings: NodeId[]; index: number } {
		const rootIdx = this.roots.indexOf(id);
		if (rootIdx !== -1) return { parentId: null, siblings: this.roots, index: rootIdx };
		for (const node of this.store.values()) {
			if (isParentNode(node)) {
				const idx = node.children.indexOf(id);
				if (idx !== -1) return { parentId: node.id, siblings: node.children, index: idx };
			}
		}
		return { parentId: null, siblings: this.roots, index: -1 };
	}

	private detach(id: NodeId): void {
		const { siblings, index } = this.findParent(id);
		if (index !== -1) siblings.splice(index, 1);
	}

	/* ---- visible rows: the single source of truth for nav + render ---- */

	visibleRows(): VisibleRow[] {
		const rows: VisibleRow[] = [];
		const walk = (id: NodeId, depth: number): void => {
			const node = this.store.get(id);
			if (!node) return;
			const children = this.childrenOf(id);
			const hasChildren = children.length > 0;
			const collapsed = this.collapsed.has(id);
			rows.push({ id, depth, hasChildren, collapsed });
			if (hasChildren && !collapsed) for (const child of children) walk(child, depth + 1);
		};
		for (const root of this.roots) walk(root, 0);
		return rows;
	}

	private rowIndex(rows: VisibleRow[], id: NodeId): number {
		return rows.findIndex((r) => r.id === id);
	}

	/* ---- text editing ---- */

	setText(text: string): void {
		this.setNodeText(this.cursor.id, text);
		this.clampCol();
	}

	insertChar(s: string): void {
		const text = this.textOf(this.cursor.id);
		const col = this.cursor.col;
		this.setNodeText(this.cursor.id, text.slice(0, col) + s + text.slice(col));
		this.cursor.col = col + s.length;
	}

	deleteCharBefore(): void {
		const text = this.textOf(this.cursor.id);
		const col = this.cursor.col;
		if (col <= 0) return;
		this.setNodeText(this.cursor.id, text.slice(0, col - 1) + text.slice(col));
		this.cursor.col = col - 1;
	}

	deleteCharAfter(): void {
		const text = this.textOf(this.cursor.id);
		const col = this.cursor.col;
		if (col >= text.length) return;
		this.setNodeText(this.cursor.id, text.slice(0, col) + text.slice(col + 1));
	}

	/* ---- structural ops ---- */

	/** Insert an empty node *before* the cursor node and move cursor to it. */
	insertNodeBefore(): void {
		const id = this.cursor.id;
		const node = this.store.get(id);
		if (!node) return;
		const fresh = createNode("");
		this.store.set(fresh.id, fresh);
		const { siblings, index } = this.findParent(id);
		siblings.splice(index, 0, fresh.id);
		this.cursor = { id: fresh.id, col: 0 };
	}

	/** Insert newId as the next SIBLING of `id` (after `id`'s whole subtree).
	 *  Enter never descends into a node's children — use Tab to make a child. */
	private insertAfter(id: NodeId, newId: NodeId): void {
		const { siblings, index } = this.findParent(id);
		siblings.splice(index + 1, 0, newId);
	}

	/** Enter:
	 *   - empty node  -> new empty node BELOW, cursor moves down
	 *   - caret at 0  -> new empty node BEFORE, cursor moves to it
	 *   - mid / end   -> split at caret; text after goes to a new node below */
	enter(): void {
		const id = this.cursor.id;
		const node = this.store.get(id);
		if (!node) return;
		const text = this.textOf(id);

		if (text.length === 0) {
			const fresh = createNode("");
			this.store.set(fresh.id, fresh);
			this.insertAfter(id, fresh.id);
			this.cursor = { id: fresh.id, col: 0 };
			return;
		}
		if (this.cursor.col === 0) return this.insertNodeBefore();

		this.setNodeText(id, text.slice(0, this.cursor.col));
		const fresh = createNode(text.slice(this.cursor.col));
		this.store.set(fresh.id, fresh);
		this.insertAfter(id, fresh.id);
		this.cursor = { id: fresh.id, col: 0 };
	}

	private removeSubtree(id: NodeId): void {
		const node = this.store.get(id);
		if (node && isParentNode(node)) for (const c of [...node.children]) this.removeSubtree(c);
		this.store.delete(id);
	}

	/** Delete the cursor node and its subtree; move cursor to the previous row. */
	deleteCurrentNode(): void {
		const rows = this.visibleRows();
		const i = this.rowIndex(rows, this.cursor.id);
		const id = this.cursor.id;
		const prevId = i > 0 ? rows[i - 1]!.id : undefined;
		this.detach(id);
		this.removeSubtree(id);
		this.cursor =
			prevId && this.store.has(prevId)
				? { id: prevId, col: this.textOf(prevId).length }
				: { id: "", col: 0 }; // ensureNonEmpty fixes a now-missing cursor
		this.ensureNonEmpty();
	}

	indent(): void {
		const id = this.cursor.id;
		const { siblings, index } = this.findParent(id);
		if (index <= 0) return; // no previous sibling
		const prevId = siblings[index - 1]!;
		const prev = this.store.get(prevId);
		if (!prev || !isParentNode(prev)) return; // can't host children
		siblings.splice(index, 1);
		prev.children.push(id);
		this.collapsed.delete(prevId); // keep the moved node visible
	}

	outdent(): void {
		const id = this.cursor.id;
		const { parentId, siblings, index } = this.findParent(id);
		if (parentId === null) return; // already a root
		const gp = this.findParent(parentId); // insert just after the parent
		siblings.splice(index, 1);
		gp.siblings.splice(gp.index + 1, 0, id);
	}

	backspaceMerge(): void {
		const rows = this.visibleRows();
		const i = this.rowIndex(rows, this.cursor.id);
		if (i <= 0) return; // first visible row
		const id = this.cursor.id;
		const node = this.store.get(id);
		if (!node) return;

		// Backspace only removes a TOP-LEVEL LEAF (no parent, no children). A node
		// that has a parent or children can't be merged away — that would change the
		// tree shape implicitly. Use Ctrl+D, which deletes the node and its subtree.
		const hasParent = this.findParent(id).parentId !== null;
		const hasChildren = isParentNode(node) && node.children.length > 0;
		if (hasParent || hasChildren) return;

		const prevId = rows[i - 1]!.id;
		const prev = this.store.get(prevId);
		if (!prev) return;
		const myText = this.textOf(id);

		// Empty leaf -> delete outright; non-empty leaf -> merge its text into prev.
		if (myText.length === 0) {
			this.detach(id);
			this.store.delete(id);
			this.cursor = { id: prevId, col: this.textOf(prevId).length };
			this.ensureNonEmpty();
			return;
		}
		const seam = this.textOf(prevId).length;
		this.setNodeText(prevId, this.textOf(prevId) + myText);
		this.detach(id);
		this.store.delete(id);
		this.cursor = { id: prevId, col: seam };
		this.ensureNonEmpty();
	}

	/* ---- caret movement ---- */

	moveCaretUp(): void {
		const rows = this.visibleRows();
		const i = this.rowIndex(rows, this.cursor.id);
		if (i <= 0) return;
		this.cursor.id = rows[i - 1]!.id;
		this.clampCol();
	}

	moveCaretDown(): void {
		const rows = this.visibleRows();
		const i = this.rowIndex(rows, this.cursor.id);
		if (i === -1 || i >= rows.length - 1) return;
		this.cursor.id = rows[i + 1]!.id;
		this.clampCol();
	}

	moveCaretLeft(): void {
		if (this.cursor.col > 0) {
			this.cursor.col--;
			return;
		}
		const before = this.cursor.id;
		this.moveCaretUp();
		if (this.cursor.id !== before) this.cursor.col = this.textOf(this.cursor.id).length;
	}

	moveCaretRight(): void {
		if (this.cursor.col < this.textOf(this.cursor.id).length) {
			this.cursor.col++;
			return;
		}
		const before = this.cursor.id;
		this.moveCaretDown();
		if (this.cursor.id !== before) this.cursor.col = 0;
	}

	caretHome(): void {
		this.cursor.col = 0;
	}

	caretEnd(): void {
		this.cursor.col = this.textOf(this.cursor.id).length;
	}

	/* ---- collapse ---- */

	toggleCollapse(): void {
		const node = this.store.get(this.cursor.id);
		if (!node || !isParentNode(node) || node.children.length === 0) return;
		if (this.collapsed.has(this.cursor.id)) this.collapsed.delete(this.cursor.id);
		else this.collapsed.add(this.cursor.id);
	}

	/* ---- bash ---- */

	/** Convert the cursor node ("node") into a bash node, keeping id/children. */
	convertCursorToBash(): void {
		const node = this.store.get(this.cursor.id);
		if (!node || node.kind !== "node") return;
		const bash: BashNode = { id: node.id, kind: "bash", command: node.text, children: node.children };
		this.store.set(bash.id, bash); // same id → all references stay valid
	}

	/** The cursor's bash node command, if the cursor is on a bash node. */
	cursorBash(): { id: NodeId; command: string } | undefined {
		const node = this.store.get(this.cursor.id);
		return node?.kind === "bash" ? { id: node.id, command: node.command } : undefined;
	}

	setBashResult(id: NodeId, output: string, exitCode: number): void {
		const node = this.store.get(id);
		if (node?.kind === "bash") {
			node.output = output;
			node.exitCode = exitCode;
		}
	}

	/* ---- compose (selected/all -> markdown for the agent) ---- */

	composeMarkdown(): string {
		const out: string[] = [];
		const walk = (id: NodeId, depth: number): void => {
			const node = this.store.get(id);
			if (!node) return;
			const indent = "  ".repeat(depth);
			if (node.kind === "bash") {
				out.push(`${indent}- \`$ ${node.command}\``);
				const body = (node.output ?? "").replace(/\n+$/, "");
				if (body) for (const l of body.split("\n")) out.push(`${indent}  ${l}`);
			} else {
				out.push(`${indent}- ${this.textOf(id)}`);
			}
			for (const c of this.childrenOf(id)) walk(c, depth + 1);
		};
		for (const r of this.roots) walk(r, 0);
		return out.join("\n");
	}

	/* ---- persistence ---- */

	serialize(): string {
		const meta: OutlineMeta = { t: "meta", v: 1, roots: this.roots, collapsed: [...this.collapsed] };
		const lines = [JSON.stringify(meta)];
		for (const node of this.store.values()) lines.push(JSON.stringify({ t: "node", node }));
		return lines.join("\n");
	}

	static deserialize(text: string): OutlineModel {
		const store: NodeStore = new Map();
		let roots: NodeId[] = [];
		let collapsedIds: NodeId[] = [];
		try {
			for (const raw of text.split("\n")) {
				const line = raw.trim();
				if (!line) continue;
				const rec = JSON.parse(line);
				if (rec?.t === "meta" && Array.isArray(rec.roots)) {
					roots = rec.roots.filter((id: unknown) => typeof id === "string");
					collapsedIds = Array.isArray(rec.collapsed)
						? rec.collapsed.filter((id: unknown) => typeof id === "string")
						: [];
				} else if (
					rec?.t === "node" &&
					rec.node &&
					typeof rec.node.id === "string" &&
					typeof rec.node.kind === "string"
				) {
					store.set(rec.node.id, rec.node as AnyNode);
				}
			}
		} catch {
			// corrupt line(s) -> fall through to the validated fallback below
		}
		// Drop dangling child refs so a corrupt file can't crash navigation.
		for (const node of store.values()) {
			if (isParentNode(node)) node.children = node.children.filter((id) => store.has(id));
		}
		const validRoots = roots.filter((id) => store.has(id));
		const collapsed = new Set(collapsedIds.filter((id) => store.has(id)));
		return new OutlineModel(store, validRoots, collapsed);
	}
}

const BAR_WIDTH_RATIO = 0.8;
const MIN_BAR_WIDTH = 40;

/* ── prompt panel (half-height, dark gray background) ──── */

const PROMPT_HEIGHT_RATIO = 0.5;
// Dark gray background (truecolor #2a2a2a). The TUI appends an SGR reset to
// every line, so the background never bleeds into other rows.
const PANEL_BG = "\x1b[48;2;42;42;42m";
// Slightly lighter background for the cursor's row (jjui-style full-line highlight).
const CURSOR_ROW_BG = "\x1b[48;2;58;58;72m";
// Near-black background for the editor's key-hint bar at the bottom of the box.
const HINT_BAR_BG = "\x1b[48;2;16;16;16m";
const SGR_RESET = "\x1b[0m";

// Outline graph glyphs (jjui-style): circle nodes + vertical branch lines.
const NODE_OPEN = "○"; // leaf or expanded node
const NODE_FILLED = "●"; // collapsed node (has hidden children)
const BRANCH = "│ "; // vertical connector, one per ancestor depth

// Bash output is shown in a FIXED-height rounded box below the node (content
// scrolls inside it). Fixed height keeps the display structure stable as output
// arrives asynchronously, which the inline differential renderer requires.
const BOX_CONTENT_H = 4; // visible output lines inside the box
const BOX_MAX_W = 90; // max box width in columns

// Wrap plain text into chunks no wider than `width` display columns. Returns the
// chunk string and its starting offset (in code units, matching cursor.col).
function wrapText(text: string, width: number): { str: string; start: number }[] {
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
function shortcutsText(width: number, thm: ExtensionContext["ui"]["theme"]): string {
	const parts = ["⇥ indent", "↵ split", "^d del", "^␣ fold", "! bash", "^r run", "^s send", "/ cmd"];
	return thm.fg("dim", truncateToWidth(` ${parts.join("  ")}`, width, "…"));
}

// Make command output safe to render in fixed-width cells: strip ANSI, drop
// carriage returns, expand TABS to spaces (a tab counts as width 1 but the
// terminal expands it to a tab stop, overflowing the line and wrapping — which
// silently desyncs the inline renderer's cursor), and remove other control bytes.
function sanitizeOutput(s: string): string {
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
function bgFillLine(content: string, width: number, bg: string = PANEL_BG): string {
	const pad = Math.max(0, width - visibleWidth(content));
	const filled = content + " ".repeat(pad);
	const persistent = filled.replace(/\x1b\[0m/g, SGR_RESET + bg);
	return bg + persistent + SGR_RESET;
}

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

/* ── streaming tool bar ─────────────────────────────── */

type CompactTool = {
	id: string;
	name: string;
	detail: string;
	isError: boolean;
};

const TOOL_BAR_WIDGET_KEY = "pi-prompt-chain-tool-bar";

type StyledSegment = {
	text: string;
	color: "accent" | "dim" | "error" | "muted";
};

class ToolBarWidget implements Component {
	constructor(
		private getTools: () => CompactTool[],
		private getRevealWidth: () => number,
		private theme: ExtensionContext["ui"]["theme"],
	) {}

	private buildSegments(tools: CompactTool[]): StyledSegment[] {
		const segments: StyledSegment[] = [];
		for (let i = 0; i < tools.length; i++) {
			const tool = tools[i]!;
			const isLast = i === tools.length - 1;
			if (i > 0) segments.push({ text: " · ", color: "muted" });
			segments.push({ text: tool.name, color: tool.isError ? "error" : isLast ? "accent" : "muted" });
			if (tool.detail) segments.push({ text: ` ${tool.detail}`, color: isLast ? "dim" : "muted" });
		}
		return segments;
	}

	private renderTail(segments: StyledSegment[], width: number): string {
		const totalWidth = segments.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
		const endAt = Math.min(totalWidth, this.getRevealWidth());
		const startAt = Math.max(0, endAt - width);
		let cursor = 0;
		let line = "";

		for (const segment of segments) {
			let visible = "";
			for (const char of Array.from(segment.text)) {
				const charWidth = visibleWidth(char);
				const nextCursor = cursor + charWidth;
				if (nextCursor > startAt && cursor < endAt) visible += char;
				cursor = nextCursor;
			}
			if (visible) line += this.theme.fg(segment.color, visible);
		}

		return " ".repeat(Math.max(0, width - visibleWidth(line))) + line;
	}

	render(width: number): string[] {
		const tools = this.getTools();
		if (tools.length === 0) return [];

		const targetWidth = Math.max(MIN_BAR_WIDTH, Math.floor(width * BAR_WIDTH_RATIO));
		const totalPad = Math.max(0, width - targetWidth);
		const leftPad = " ".repeat(Math.floor(totalPad / 2));
		const rightPad = " ".repeat(totalPad - Math.floor(totalPad / 2));
		const line = this.renderTail(this.buildSegments(tools), targetWidth);

		return [leftPad + this.theme.bg("toolPendingBg", line) + rightPad];
	}

	invalidate(): void {}
}

function shortenPath(path: string | undefined, cwd: string): string {
	if (!path) return "";
	if (path.startsWith(`${cwd}/`)) return path.slice(cwd.length + 1);
	const home = process.env.HOME;
	if (home && path.startsWith(home)) return `~${path.slice(home.length)}`;
	return path;
}

function oneLine(text: string | undefined): string {
	return (text ?? "").replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim();
}

function compactDetail(text: string, maxWidth = 22): string {
	return truncateToWidth(oneLine(text), maxWidth, "…");
}

function compactPath(path: string | undefined, cwd: string): string {
	const shortened = shortenPath(path, cwd);
	if (visibleWidth(shortened) <= 22) return shortened;
	const parts = shortened.split(/[\\/]/).filter(Boolean);
	const last = parts.at(-1) ?? shortened;
	return last ? `…/${compactDetail(last, 19)}` : compactDetail(shortened, 22);
}

function compactToolsWidth(tools: CompactTool[]): number {
	return tools.reduce((sum, tool, index) => {
		const separator = index > 0 ? 3 : 0;
		return sum + separator + visibleWidth(tool.name) + (tool.detail ? 1 + visibleWidth(tool.detail) : 0);
	}, 0);
}

function formatToolSummary(toolName: string, args: any, cwd: string): Omit<CompactTool, "id" | "isError"> {
	const name = toolName.charAt(0).toUpperCase() + toolName.slice(1);
	switch (toolName) {
		case "read":
			return { name: "Read", detail: compactPath(args?.path, cwd) };
		case "bash":
			return { name: "Bash", detail: compactDetail(args?.command ?? "", 28) };
		case "edit":
			return { name: "Edit", detail: compactPath(args?.path, cwd) };
		case "write":
			return { name: "Write", detail: compactPath(args?.path, cwd) };
		case "grep": {
			const pattern = args?.pattern ? `"${args.pattern}"` : "";
			const path = compactPath(args?.path ?? args?.include, cwd);
			return { name: "Grep", detail: compactDetail([pattern, path].filter(Boolean).join(" in "), 28) };
		}
		case "find":
			return { name: "Find", detail: compactDetail(args?.pattern ?? compactPath(args?.path, cwd), 28) };
		case "ls":
			return { name: "Ls", detail: compactPath(args?.path ?? ".", cwd) };
		default:
			return { name, detail: compactDetail(JSON.stringify(args ?? {}), 28) };
	}
}

function createBuiltInTools(cwd: string) {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
		ls: createLsTool(cwd),
	};
}

const builtInToolCache = new Map<string, ReturnType<typeof createBuiltInTools>>();
const HIDDEN_TOOL_NAMES = new Set(["read", "bash", "edit", "write", "find", "grep", "ls"]);
let toolExecutionRenderPatched = false;

function patchHiddenToolRows(): void {
	if (toolExecutionRenderPatched) return;
	toolExecutionRenderPatched = true;

	const originalRender = ToolExecutionComponent.prototype.render;
	ToolExecutionComponent.prototype.render = function (this: ToolExecutionComponent, width: number): string[] {
		const toolName = (this as unknown as { toolName?: string }).toolName;
		if (toolName && HIDDEN_TOOL_NAMES.has(toolName)) return [];
		return originalRender.call(this, width);
	};
}

function getBuiltInTools(cwd: string): ReturnType<typeof createBuiltInTools> {
	let tools = builtInToolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		builtInToolCache.set(cwd, tools);
	}
	return tools;
}

function registerHiddenToolRenderers(pi: ExtensionAPI): void {
	patchHiddenToolRows();
	const names = ["read", "bash", "edit", "write", "find", "grep", "ls"] as const;
	for (const name of names) {
		const base = getBuiltInTools(process.cwd())[name];
		pi.registerTool({
			...base,
			name,
			renderShell: "self",
			async execute(toolCallId, params, signal, onUpdate, ctx) {
				const tool = getBuiltInTools(ctx.cwd)[name];
				return tool.execute(toolCallId, params, signal, onUpdate, ctx);
			},
			renderCall() {
				return new EmptyFooter();
			},
			renderResult() {
				return new EmptyFooter();
			},
		});
	}
}

/* ── editor ─────────────────────────────────────────── */

class PromptChainEditor extends CustomEditor {
	private activeTui: TUI;
	private branch: string | undefined;
	private refreshTimer: ReturnType<typeof setInterval> | undefined;
	private model: OutlineModel;
	private scrollTop = 0;
	private commandMode = false; // delegating to the base editor for a /slash command
	private boxScroll = new Map<NodeId, number>(); // per bash node: output box scroll offset
	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	private chainsPath: string;

	constructor(
		tui: TUI,
		theme: EditorTheme,
		keybindings: KeybindingsManager,
		private ctx: ExtensionContext,
		private pi: ExtensionAPI,
	) {
		super(tui, theme, keybindings, { paddingX: 0 });
		this.activeTui = tui;
		this.chainsPath = join(ctx.cwd, ".pi", "chains.jsonl");
		this.model = new OutlineModel(new Map(), [], new Set()); // empty until loaded
		void this.loadFrom(this.chainsPath);
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

	/* ---- persistence ---- */

	private async loadFrom(path: string): Promise<void> {
		try {
			this.model = OutlineModel.deserialize(await readFile(path, "utf8"));
		} catch {
			this.model = new OutlineModel(new Map(), [], new Set());
		}
		this.activeTui.requestRender();
	}

	private async saveNow(): Promise<void> {
		try {
			await mkdir(dirname(this.chainsPath), { recursive: true });
			await writeFile(this.chainsPath, `${this.model.serialize()}\n`, "utf8");
		} catch {
			// best-effort: never crash the TUI on a write error
		}
	}

	private scheduleSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => void this.saveNow(), 400);
	}

	async flushSave(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = undefined;
		}
		if (this.refreshTimer) {
			clearInterval(this.refreshTimer);
			this.refreshTimer = undefined;
		}
		await this.saveNow();
	}

	private afterEdit(): void {
		this.activeTui.requestRender();
		this.scheduleSave();
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
		void this.saveNow();
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

		// Command mode: show the base editor (its input + slash command menu) inside
		// the box. Fixed height keeps the differential renderer stable.
		if (this.commandMode) {
			const base = super.render(W);
			const interior: string[] = [];
			for (let k = 0; k < outlineHeight; k++) {
				interior.push(bgFillLine(truncateToWidth(base[k] ?? "", W, ""), W, PANEL_BG));
			}
			return [topBar, ...interior, bottomBar];
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

/* ── extension entry ────────────────────────────────── */

export default function (pi: ExtensionAPI) {
	// Native conversation (thinking · tools · output) renders inline in the
	// scrollback ABOVE the editor box — nothing custom is pinned above the prompt
	// bar. (Previously tool rows were hidden to feed a top history pane.)

	let compactTools: CompactTool[] = [];
	let revealWidth = 0;
	let animationTimer: ReturnType<typeof setInterval> | undefined;
	let clearTimer: ReturnType<typeof setTimeout> | undefined;
	let widgetTui: TUI | undefined;
	let activeEditor: PromptChainEditor | undefined;

	function stopAnimation(): void {
		if (animationTimer) {
			clearInterval(animationTimer);
			animationTimer = undefined;
		}
	}

	function stopClearTimer(): void {
		if (clearTimer) {
			clearTimeout(clearTimer);
			clearTimer = undefined;
		}
	}

	function animateToolBar(): void {
		const targetWidth = compactToolsWidth(compactTools);
		if (revealWidth >= targetWidth || animationTimer) return;
		animationTimer = setInterval(() => {
			const nextTargetWidth = compactToolsWidth(compactTools);
			revealWidth = Math.min(nextTargetWidth, revealWidth + 4);
			widgetTui?.requestRender();
			if (revealWidth >= nextTargetWidth) stopAnimation();
		}, 20);
	}

	function clearToolBar(ctx: ExtensionContext): void {
		stopAnimation();
		stopClearTimer();
		compactTools = [];
		revealWidth = 0;
		ctx.ui.setWidget(TOOL_BAR_WIDGET_KEY, undefined, { placement: "aboveEditor" });
	}

	function updateToolBar(_ctx: ExtensionContext): void {
		// Nothing is pinned above the editor: tool progress is visible in the
		// native conversation scrollback. Kept as a no-op so the event handlers
		// (which still track compactTools) need no changes.
	}

	function settleToolBar(ctx: ExtensionContext): void {
		stopClearTimer();
		clearTimer = setTimeout(() => clearToolBar(ctx), 1600);
	}

	pi.on("agent_start", (_event, ctx) => {
		clearToolBar(ctx);
	});

	pi.on("tool_execution_start", (event, ctx) => {
		const existing = compactTools.find((tool) => tool.id === event.toolCallId);
		const summary = formatToolSummary(event.toolName, event.args, ctx.cwd);
		if (existing) {
			existing.name = summary.name;
			existing.detail = summary.detail;
			existing.isError = false;
		} else {
			compactTools.push({ id: event.toolCallId, ...summary, isError: false });
		}
		updateToolBar(ctx);
	});

	pi.on("tool_execution_update", (event, ctx) => {
		const existing = compactTools.find((tool) => tool.id === event.toolCallId);
		if (!existing) return;
		const summary = formatToolSummary(event.toolName, event.args, ctx.cwd);
		existing.name = summary.name;
		existing.detail = summary.detail;
		updateToolBar(ctx);
	});

	pi.on("tool_execution_end", (event, ctx) => {
		const existing = compactTools.find((tool) => tool.id === event.toolCallId);
		if (existing) {
			existing.isError = event.isError;
		} else {
			compactTools.push({
				id: event.toolCallId,
				...formatToolSummary(event.toolName, {}, ctx.cwd),
				isError: event.isError,
			});
		}
		updateToolBar(ctx);
	});

	pi.on("agent_end", (event, ctx) => {
		const aborted = event.messages.some(
			(message) => message.role === "assistant" && message.stopReason === "aborted",
		);
		if (aborted) clearToolBar(ctx);
		else settleToolBar(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearToolBar(ctx);
		await activeEditor?.flushSave();
	});

	pi.on("session_start", (_event, ctx) => {
		// Footer: muted keybinding hints, below the editor's bottom prompt bar.
		ctx.ui.setFooter((_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				return [shortcutsText(width, theme)];
			},
		}));

		ctx.ui.setEditorComponent((tui: TUI, theme: EditorTheme, kb: KeybindingsManager) => {
			activeEditor = new PromptChainEditor(tui, theme, kb, ctx, pi);
			return activeEditor;
		});
	});
}
