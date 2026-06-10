import { randomUUID } from "node:crypto";

/* ── prompt-chain data model ─────────────────────────────
 * A tree of nodes the prompt chain is built from. Every node has a stable UUID.
 *
 *   Node          content node; can hold an unbounded number of child nodes
 *   BashNode      content node backed by a bash command + its captured result
 *
 * Children are referenced by UUID and resolved through a flat NodeStore, so the
 * graph can share/alias nodes without duplicating them.
 */

/** A v4 UUID. Every node is one of these. */
export type NodeId = string;

/** Discriminates the node union. */
export type NodeKind = "node" | "bash";

/** A plain content node. Holds an unbounded number of child nodes. */
export interface Node {
	/** Stable unique identity (UUID v4). */
	readonly id: NodeId;
	readonly kind: "node";
	text: string;
	/** Multiline pasted note attached to this node without changing its editable title. */
	pasted?: string;
	/** Child node ids — infinite nesting; resolved through the NodeStore. */
	children: NodeId[];
}

/** A content node backed by a bash command and its captured result. */
export interface BashNode {
	/** Stable unique identity (UUID v4). */
	readonly id: NodeId;
	readonly kind: "bash";
	command: string;
	output?: string;
	exitCode?: number;
	children: NodeId[];
}

/** Any node in the tree. */
export type AnyNode = Node | BashNode;

/** Flat id→node store; children are resolved through it by UUID. */
export type NodeStore = Map<NodeId, AnyNode>;

export interface OutlineSnapshot {
	store: [NodeId, AnyNode][];
	roots: NodeId[];
	collapsed: NodeId[];
	cursor: { id: NodeId; col: number };
}

/* node factories — every node gets a fresh UUID */

export function createNode(text = "", children: NodeId[] = []): Node {
	return { id: randomUUID(), kind: "node", text, children };
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
	/** For each ancestor level: whether that ancestor still has later siblings. */
	ancestorContinues: boolean[];
	/** Whether this row is the final item in its sibling list. */
	isLast: boolean;
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

	static fromMarkdown(text: string): OutlineModel {
		const store: NodeStore = new Map();
		const roots: NodeId[] = [];
		const stack: NodeId[] = [];
		let parsedAny = false;
		let lastBash: { node: BashNode; depth: number } | undefined;
		let lastNode: { node: Node; depth: number } | undefined;
		let bashOutput: { node: BashNode; indent: number } | undefined;
		let pastedOutput: { node: Node; indent: number } | undefined;

		for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
			if (pastedOutput) {
				if (line.trim() === "</pasted>") {
					pastedOutput = undefined;
					continue;
				}
				const pad = " ".repeat(pastedOutput.indent);
				const outLine = line.startsWith(pad) ? line.slice(pad.length) : line;
				pastedOutput.node.pasted = pastedOutput.node.pasted === undefined ? outLine : `${pastedOutput.node.pasted}\n${outLine}`;
				continue;
			}

			if (bashOutput) {
				if (line.trim() === "</bash-output>") {
					bashOutput = undefined;
					continue;
				}
				const pad = " ".repeat(bashOutput.indent);
				const outLine = line.startsWith(pad) ? line.slice(pad.length) : line;
				bashOutput.node.output = bashOutput.node.output === undefined ? outLine : `${bashOutput.node.output}\n${outLine}`;
				continue;
			}

			if (lastNode && line.trim().startsWith("<pasted")) {
				pastedOutput = { node: lastNode.node, indent: line.match(/^\s*/)?.[0].length ?? 0 };
				lastNode.node.pasted = undefined;
				continue;
			}

			if (lastBash && line.trim().startsWith("<bash-output")) {
				bashOutput = { node: lastBash.node, indent: line.match(/^\s*/)?.[0].length ?? 0 };
				lastBash.node.output = undefined;
				continue;
			}

			// Restore both normal markdown list shape (`  - child`) and accidentally
			// re-wrapped outline shape (`- - child`, `-   - child`) without keeping the
			// literal bullet markers in node text.
			const match = line.match(/^(\s*)((?:-\s+)+)(.*)$/);
			if (!match) {
				// Bash output is composed as indented plain lines after a bash bullet.
				// Reattach those lines to the bash node instead of turning them into text nodes.
				if (lastBash) {
					const minIndent = (lastBash.depth + 1) * 2;
					const indent = line.match(/^\s*/)?.[0].length ?? 0;
					if (indent >= minIndent || line.length === 0) {
						const outLine = line.length === 0 ? "" : line.slice(Math.min(indent, minIndent));
						lastBash.node.output = lastBash.node.output === undefined ? outLine : `${lastBash.node.output}\n${outLine}`;
					}
				}
				continue;
			}

			parsedAny = true;
			const bulletCount = [...match[2]!.matchAll(/-/g)].length;
			const depth = Math.floor(match[1]!.length / 2) + bulletCount - 1;
			const raw = match[3] ?? "";
			const bashMatch = raw.match(/^`\$\s(.*)`$/);
			const node = bashMatch
				? ({ id: randomUUID(), kind: "bash", command: bashMatch[1] ?? "", children: [] } satisfies BashNode)
				: createNode(raw);
			store.set(node.id, node);

			stack.length = depth;
			const parentId = stack[depth - 1];
			if (parentId) store.get(parentId)?.children.push(node.id);
			else roots.push(node.id);
			stack[depth] = node.id;
			lastBash = node.kind === "bash" ? { node, depth } : undefined;
			lastNode = node.kind === "node" ? { node, depth } : undefined;
		}

		if (!parsedAny) {
			const model = new OutlineModel(new Map(), [], new Set());
			model.pasteText(text);
			return model;
		}
		return new OutlineModel(store, roots, new Set());
	}

	static fromSnapshot(snapshot: OutlineSnapshot): OutlineModel {
		const store: NodeStore = new Map(
			snapshot.store.map(([id, node]) => [
				id,
				node.kind === "node"
					? { id: node.id, kind: "node", text: node.text, pasted: node.pasted, children: [...node.children] }
					: {
							id: node.id,
							kind: "bash",
							command: node.command,
							output: node.output,
							exitCode: node.exitCode,
							children: [...node.children],
						},
			]),
		);
		const model = new OutlineModel(store, [...snapshot.roots], new Set(snapshot.collapsed));
		model.cursor = { ...snapshot.cursor };
		model.clampCol();
		return model;
	}

	snapshot(): OutlineSnapshot {
		return {
			store: [...this.store.entries()].map(([id, node]) => [
				id,
				node.kind === "node"
					? { id: node.id, kind: "node", text: node.text, pasted: node.pasted, children: [...node.children] }
					: {
							id: node.id,
							kind: "bash",
							command: node.command,
							output: node.output,
							exitCode: node.exitCode,
							children: [...node.children],
						},
			]),
			roots: [...this.roots],
			collapsed: [...this.collapsed],
			cursor: { ...this.cursor },
		};
	}

	isBlank(): boolean {
		if (this.roots.length !== 1) return false;
		const node = this.store.get(this.roots[0]!);
		return !!node && node.kind === "node" && node.text.length === 0 && node.children.length === 0;
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

	/** Editable text for a node (single chokepoint). */
	textOf(id: NodeId): string {
		const node = this.store.get(id);
		if (!node) return "";
		if (node.kind === "node") return node.text;
		return node.command;
	}

	private setNodeText(id: NodeId, text: string): void {
		const node = this.store.get(id);
		if (!node) return;
		if (node.kind === "node") node.text = text;
		else if (node.kind === "bash") node.command = text;
	}

	replaceCursorText(text: string, col = text.length): void {
		this.setNodeText(this.cursor.id, text);
		this.cursor.col = Math.max(0, Math.min(col, text.length));
	}

	appendPastedToCursor(text: string): void {
		const node = this.store.get(this.cursor.id);
		if (!node || node.kind !== "node") return;
		node.pasted = node.pasted ? `${node.pasted}\n${text}` : text;
	}

	childrenOf(id: NodeId): NodeId[] {
		return this.store.get(id)?.children ?? [];
	}

	/** Locate a node's parent context. parentId === null means it is a root. */
	private findParent(id: NodeId): { parentId: NodeId | null; siblings: NodeId[]; index: number } {
		const rootIdx = this.roots.indexOf(id);
		if (rootIdx !== -1) return { parentId: null, siblings: this.roots, index: rootIdx };
		for (const node of this.store.values()) {
			const idx = node.children.indexOf(id);
			if (idx !== -1) return { parentId: node.id, siblings: node.children, index: idx };
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
		const walk = (id: NodeId, depth: number, ancestorContinues: boolean[], isLast: boolean): void => {
			const node = this.store.get(id);
			if (!node) return;
			const children = this.childrenOf(id);
			const hasChildren = children.length > 0;
			const collapsed = this.collapsed.has(id);
			rows.push({ id, depth, hasChildren, collapsed, ancestorContinues, isLast });
			if (hasChildren && !collapsed) {
				children.forEach((child, i) => {
					walk(child, depth + 1, [...ancestorContinues, !isLast], i === children.length - 1);
				});
			}
		};
		this.roots.forEach((root, i) => walk(root, 0, [], i === this.roots.length - 1));
		return rows;
	}

	private rowIndex(rows: VisibleRow[], id: NodeId): number {
		return rows.findIndex((r) => r.id === id);
	}

	/* ---- text editing ---- */

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

	pasteText(raw: string): void {
		const text = raw.replace(/\r\n?/g, "\n").replace(/\t/g, "    ");
		if (!text.includes("\n")) {
			this.insertChar(text);
			return;
		}

		const id = this.cursor.id;
		const current = this.textOf(id);
		const before = current.slice(0, this.cursor.col);
		const after = current.slice(this.cursor.col);
		const lines = text.split("\n");
		this.setNodeText(id, before + (lines[0] ?? ""));

		let prevId = id;
		for (let i = 1; i < lines.length; i++) {
			const isLast = i === lines.length - 1;
			const fresh = createNode((lines[i] ?? "") + (isLast ? after : ""));
			this.store.set(fresh.id, fresh);
			this.insertAfter(prevId, fresh.id);
			prevId = fresh.id;
		}
		const lastPastedLen = lines[lines.length - 1]?.length ?? 0;
		this.cursor = { id: prevId, col: lastPastedLen };
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
		if (node) for (const c of [...node.children]) this.removeSubtree(c);
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
		if (!prev) return; // can't host children
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

	moveNodeUp(): void {
		const { siblings, index } = this.findParent(this.cursor.id);
		if (index <= 0) return;
		[siblings[index - 1], siblings[index]] = [siblings[index]!, siblings[index - 1]!];
	}

	moveNodeDown(): void {
		const { siblings, index } = this.findParent(this.cursor.id);
		if (index < 0 || index >= siblings.length - 1) return;
		[siblings[index], siblings[index + 1]] = [siblings[index + 1]!, siblings[index]!];
	}

	backspaceMerge(): void {
		const id = this.cursor.id;
		const node = this.store.get(id);
		if (!node) return;
		if (node.kind === "bash" && node.command.length === 0) {
			this.convertCursorToNode();
			return;
		}

		const rows = this.visibleRows();
		const i = this.rowIndex(rows, id);
		if (i <= 0) return; // first visible row

		// Backspace only removes a TOP-LEVEL LEAF (no parent, no children). A node
		// that has a parent or children can't be merged away — that would change the
		// tree shape implicitly. Use Ctrl+Backspace, which deletes the node and its subtree.
		const hasParent = this.findParent(id).parentId !== null;
		const hasChildren = node.children.length > 0;
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
		if (!node || node.children.length === 0) return;
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

	/** Convert the cursor bash node back into a plain outline node, keeping id/children. */
	convertCursorToNode(): void {
		const node = this.store.get(this.cursor.id);
		if (!node || node.kind !== "bash") return;
		this.store.set(node.id, { id: node.id, kind: "node", text: node.command, children: node.children });
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
				if (body) {
					out.push(`${indent}  <bash-output exit-code="${node.exitCode ?? 0}">`);
					for (const l of body.split("\n")) out.push(`${indent}  ${l}`);
					out.push(`${indent}  </bash-output>`);
				}
			} else {
				out.push(`${indent}- ${this.textOf(id)}`);
				if (node.pasted) {
					out.push(`${indent}  <pasted>`);
					for (const l of node.pasted.replace(/\n+$/, "").split("\n")) out.push(`${indent}  ${l}`);
					out.push(`${indent}  </pasted>`);
				}
			}
			for (const c of this.childrenOf(id)) walk(c, depth + 1);
		};
		for (const r of this.roots) walk(r, 0);
		return out.join("\n");
	}
}
