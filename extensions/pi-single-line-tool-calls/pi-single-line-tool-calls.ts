/**
 * pi-single-line-tool-calls — collapse every built-in tool call to ONE line.
 *
 * Re-registers each built-in tool (read, bash, edit, write, grep, find, ls)
 * under its own name, delegating execution to the original implementation
 * untouched, and replacing only the rendering:
 *   - renderShell: "self"  → no boxed shell / background block around the row
 *   - renderCall           → a single line: "<Verb> <primary arg>"
 *   - renderResult         → nothing on collapsed success (the call line stands alone),
 *                            one red line on collapsed error; Ctrl+O expanded
 *                            details only for bash and edit
 *
 * The effect in the transcript is a compact stream like:
 *   Read src/app.ts
 *   $ npm test
 *   Grep "TODO" src
 *
 * NOT auto-loaded: it lives at the repo root, not in .pi/extensions/. Load it
 * explicitly, and (for a clean demo without the outline editor) skip discovery:
 *   pi --no-extensions -e extensions/pi-single-line-tool-calls/pi-single-line-tool-calls.ts
 */

import {
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const LEFT_PAD = " "; // align compact tool rows with thinking/output transcript rows
const MAX_ARG = 75; // truncate the one-line arg so a padded row never wraps
const BASH_DETAIL_MAX_LINES = 5;

function fit(s: string): string {
	return s.length > MAX_ARG ? `${s.slice(0, MAX_ARG - 1)}…` : s;
}

// Each tool's NAME deterministically picks a unique hue, so any tool — including
// ones we don't know about — gets a stable, distinct color. Same name → same
// color, every session.
function hueFromName(name: string): number {
	let h = 0;
	for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) >>> 0;
	return h % 360;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
	const c = (1 - Math.abs(2 * l - 1)) * s;
	const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
	const m = l - c / 2;
	const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
	return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// Bold, truecolor tool name (raw ANSI — theme.fg only accepts named colors).
function colorName(name: string, label: string): string {
	const [r, g, b] = hslToRgb(hueFromName(name), 0.62, 0.65);
	return `\x1b[1;38;2;${r};${g};${b}m${label}\x1b[22;39m`;
}

class RenderLines {
	constructor(private readonly draw: (width: number) => string[]) {}
	invalidate() {}
	render(width: number): string[] {
		return this.draw(width);
	}
}

function resultText(result: { content?: Array<{ type: string; text?: string }> }): string {
	return result.content?.map((part) => (part.type === "text" ? (part.text ?? "") : "")).filter(Boolean).join("\n") ?? "";
}

function sanitizeDetailText(text: string): string {
	return text
		.replace(/\r\n?/g, "\n")
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "") // OSC escapes
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "") // CSI/SGR escapes
		.replace(/\x1b[ -/]*[@-~]/g, "") // other one-shot ESC sequences
		.replace(/\t/g, "   ")
		.split("")
		.filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
		.join("");
}

function renderBoxDetails(text: string, labelText: string, theme: any): RenderLines {
	return new RenderLines((width) => {
		const indent = LEFT_PAD;
		const boxW = Math.max(1, Math.min(104, width - visibleWidth(indent) - 1));
		const innerW = Math.max(1, boxW - 4);
		const dimLine = (s: string) => theme.fg("dim", truncateToWidth(s, width, ""));
		const label = truncateToWidth(` ${labelText} `, Math.max(0, boxW - 2), "");
		const clean = sanitizeDetailText(text).replace(/\n+$/, "");
		const lines = clean.length > 0 ? clean.split("\n") : [""];
		const visibleLines = lines.slice(0, BASH_DETAIL_MAX_LINES);
		const hidden = Math.max(0, lines.length - visibleLines.length);
		const out: string[] = [];
		out.push(dimLine(`${indent}╭${label}${"─".repeat(Math.max(0, boxW - 2 - visibleWidth(label)))}╮`));
		for (const raw of visibleLines) {
			let cell = truncateToWidth(raw, innerW, "…");
			cell += " ".repeat(Math.max(0, innerW - visibleWidth(cell)));
			out.push(dimLine(`${indent}│ ${cell} │`));
		}
		const tag = hidden > 0 ? truncateToWidth(` ↓${hidden} `, Math.max(0, boxW - 2), "") : "";
		out.push(dimLine(`${indent}╰${"─".repeat(Math.max(0, boxW - 2 - visibleWidth(tag)))}${tag}╯`));
		return out;
	});
}

function colorDiffLine(line: string, theme: any): string {
	const padded = `${LEFT_PAD}${line.replace(/\t/g, "   ")}`;
	if (line.startsWith("+")) return theme.fg("toolDiffAdded", padded);
	if (line.startsWith("-")) return theme.fg("toolDiffRemoved", padded);
	return theme.fg("toolDiffContext", padded);
}

function renderEditDetails(args: any, result: any, isError: boolean, theme: any): RenderLines {
	return new RenderLines((width) => {
		const path = String(args?.path ?? args?.file_path ?? "");
		const out: string[] = [];
		if (path) out.push(theme.fg("dim", truncateToWidth(`${LEFT_PAD}diff ${path}`, width, "…")));
		if (isError) {
			for (const line of resultText(result).split("\n")) out.push(theme.fg("error", truncateToWidth(`${LEFT_PAD}${line}`, width, "…")));
			return out;
		}
		const diff = typeof result.details?.diff === "string" ? result.details.diff : "";
		for (const line of diff.split("\n")) out.push(truncateToWidth(colorDiffLine(line, theme), width, "…"));
		return out.length > 0 ? out : [];
	});
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// verb shown for the row + how to derive the single primary argument
	const specs = [
		{ name: "read", verb: "Read", make: () => createReadTool(cwd), arg: (a: any) => a.path },
		{ name: "bash", verb: "Bash", make: () => createBashTool(cwd), arg: (a: any) => a.command },
		{ name: "edit", verb: "Edit", make: () => createEditTool(cwd), arg: (a: any) => a.path },
		{ name: "write", verb: "Write", make: () => createWriteTool(cwd), arg: (a: any) => a.path },
		{
			name: "grep",
			verb: "Grep",
			make: () => createGrepTool(cwd),
			arg: (a: any) => `"${a.pattern}"${a.path ? ` ${a.path}` : a.glob ? ` ${a.glob}` : ""}`,
		},
		{ name: "find", verb: "Find", make: () => createFindTool(cwd), arg: (a: any) => `${a.pattern}${a.path ? ` ${a.path}` : ""}` },
		{ name: "ls", verb: "Ls", make: () => createLsTool(cwd), arg: (a: any) => a.path ?? "." },
	];

	for (const spec of specs) {
		const original = spec.make();
		pi.registerTool({
			name: spec.name,
			label: spec.name,
			description: original.description,
			parameters: original.parameters,
			renderShell: "self",

			execute(toolCallId, params, signal, onUpdate) {
				return original.execute(toolCallId, params, signal, onUpdate);
			},

			renderCall(args, theme, _context) {
				// Bash is always red; other tool names get a unique color hashed from name.
				// Content: muted gray.
				const toolName = spec.name === "bash" ? theme.fg("error", theme.bold(spec.verb)) : colorName(spec.name, spec.verb);
				let line = `${LEFT_PAD}${toolName} `;
				line += theme.fg("muted", fit(String(spec.arg(args) ?? "")));
				return new Text(line, 0, 0);
			},

			renderResult(result, options, theme, context) {
				if (options.isPartial) return new Container(); // still running: keep the lone call line
				const text = resultText(result);
				const details = result.details as any;
				const isError = Boolean(details?.error || details?.blocked) || /^Error/i.test(text);

				if (options.expanded) {
					if (spec.name === "bash") return renderBoxDetails(text, "stdout", theme) as any;
					if (spec.name === "ls") return renderBoxDetails(text, "ls", theme) as any;
					if (spec.name === "grep") return renderBoxDetails(text, "grep", theme) as any;
					if (spec.name === "edit") return renderEditDetails(context.args, result, isError, theme) as any;
				}

				if (isError) {
					return new Text(theme.fg("error", `${LEFT_PAD}✗ ${fit(text.split("\n")[0] ?? "error")}`), 0, 0);
				}
				return new Container(); // success → no result rows, the call line is the whole thing
			},
		});
	}
}
