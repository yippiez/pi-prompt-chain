import { randomUUID } from "node:crypto";

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
