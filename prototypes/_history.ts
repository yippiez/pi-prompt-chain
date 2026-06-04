// Real conversation timeline for the history-pane prototypes.
// Listens to pi events and builds a sequence of condensed "slides":
//   user prompt · thinking (paragraph) · tool calls (one condensed bar) · output
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Slide =
	| { kind: "user"; text: string }
	| { kind: "thinking"; text: string }
	| { kind: "tools"; items: string[] }
	| { kind: "output"; text: string };

const para = (s: string) => s.replace(/\s+/g, " ").trim();

/** Pull thinking + visible text out of a message of unknown-ish shape. */
function extract(msg: any): { role: string; thinking: string; text: string } {
	const role = msg?.role ?? "";
	let thinking = "";
	let text = "";
	const c = msg?.content;
	if (typeof c === "string") text = c;
	else if (Array.isArray(c)) {
		for (const b of c) {
			if (!b || typeof b !== "object") continue;
			const t = b.type;
			if (t === "thinking" || t === "reasoning") thinking += `${b.thinking ?? b.text ?? ""}\n`;
			else if (t === "text") text += `${b.text ?? ""}\n`;
			// tool_use blocks are surfaced via tool_execution_* events instead
		}
	}
	return { role, thinking: para(thinking), text: para(text) };
}

/** Short, condensed label for one tool call (mirrors the inline tool bar). */
function toolLabel(name: string, args: any): string {
	const cap = name.charAt(0).toUpperCase() + name.slice(1);
	const short = (s: string, n = 22) => truncateToWidth(String(s ?? "").replace(/\s+/g, " ").trim(), n, "…");
	const base = (p: string) => (p ? p.split("/").slice(-1)[0] : "");
	switch (name) {
		case "read":
		case "edit":
		case "write":
		case "ls":
			return `${cap} ${base(args?.path)}`;
		case "bash":
			return `${cap} ${short(args?.command, 24)}`;
		case "grep":
			return `${cap} ${short(args?.pattern, 18)}`;
		case "find":
			return `${cap} ${short(args?.pattern ?? args?.path, 18)}`;
		default:
			return cap;
	}
}

export class HistoryStore {
	slides: Slide[] = [];
	onChange: (() => void) | undefined;
	private tools: Extract<Slide, { kind: "tools" }> | undefined;

	private bump() {
		this.onChange?.();
	}

	attach(pi: ExtensionAPI): void {
		pi.on("tool_execution_start", (e) => {
			if (!this.tools) {
				this.tools = { kind: "tools", items: [] };
				this.slides.push(this.tools);
			}
			this.tools.items.push(toolLabel(e.toolName, e.args));
			this.bump();
		});
		pi.on("message_end", (e) => {
			this.tools = undefined; // a new message ends the current tool group
			const { role, thinking, text } = extract((e as any).message);
			if (role === "user" && text) this.slides.push({ kind: "user", text });
			else if (role === "assistant") {
				if (thinking) this.slides.push({ kind: "thinking", text: thinking });
				if (text) this.slides.push({ kind: "output", text });
			}
			this.bump();
		});
	}
}

const HIST_BG = "\x1b[48;2;22;22;28m";
const RESET = "\x1b[0m";
function fill(content: string, width: number): string {
	const pad = Math.max(0, width - visibleWidth(content));
	return HIST_BG + (content + " ".repeat(pad)).replace(/\x1b\[0m/g, RESET + HIST_BG) + RESET;
}

function wrap(prefix: string, body: string, width: number, cap: number): string[] {
	const lines: string[] = [];
	let cur = prefix;
	for (const w of body.split(" ")) {
		const next = cur ? `${cur} ${w}` : w;
		if (visibleWidth(next) > width - 1 && cur !== prefix) {
			lines.push(cur);
			cur = `  ${w}`; // hanging indent for continuation
		} else cur = next;
	}
	if (cur.trim()) lines.push(cur);
	if (lines.length > cap) return [...lines.slice(0, cap - 1), `${lines[cap - 1]} …`];
	return lines;
}

function slideLines(s: Slide, width: number, thm: ExtensionContext["ui"]["theme"]): string[] {
	if (s.kind === "user") return wrap(thm.fg("accent", "❯ "), thm.fg("text", s.text), width, 3);
	if (s.kind === "thinking")
		return wrap(thm.fg("dim", "✱ thinking  "), thm.fg("dim", s.text), width, 4);
	if (s.kind === "output") return wrap(thm.fg("success", "● "), thm.fg("text", s.text), width, 5);
	// tools: one condensed bar
	const bar = thm.fg("warning", "⚙ ") + s.items.map((t) => thm.fg("dim", t)).join(thm.fg("dim", " · "));
	return [truncateToWidth(bar, width, "…")];
}

/** Render the timeline's TAIL to exactly `height` lines (most recent first-fit). */
export function renderTimeline(
	store: HistoryStore,
	width: number,
	height: number,
	thm: ExtensionContext["ui"]["theme"],
): string[] {
	const all = store.slides.flatMap((s) => slideLines(s, width, thm));
	if (all.length === 0)
		all.push(thm.fg("dim", "  (conversation will appear here — thinking · tools · output)"));
	const bodyH = Math.max(1, height - 1);
	const start = Math.max(0, all.length - bodyH);
	const out = [
		fill(` ${thm.fg("accent", "history")} ${thm.fg("dim", `· ${store.slides.length} steps`)}`, width),
	];
	for (let i = 0; i < bodyH; i++) out.push(fill(truncateToWidth(all[start + i] ?? "", width, ""), width));
	return out;
}
