import { type AnyNode, type BashNode, type NodeId, type NodeStore, createNode, isParentNode } from "./nodes.ts";

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
}
