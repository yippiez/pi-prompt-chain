# pi-prompt-chain

`pi-prompt-chain` is a Pi package with two extensions:

- **Outline editor** — replaces pi's text prompt with a nestable outline you compose, multi-select, and send.
- **Single-line tool calls** — collapses every built-in tool call in the transcript to a single, uniquely-colored line.

## Outline editor

Replaces the prompt with an outline of nodes. Build a tree, drop in bash nodes, multi-select rows to compose one markdown prompt, and send it to the agent.

- `⇥` / `⇧⇥` — indent / outdent the current node
- `↵` — split: append a new sibling node
- `^d` — delete the current node (and its subtree)
- `^␣` — fold / unfold a node with children
- `!` — turn the current node into a bash node
- `^r` — run the bash node inline (stdout renders in a box beneath it)
- `^s` — compose the selected nodes into markdown and send
- `^t` — cycle thinking level
- `/` — slash commands

There is no hot reload — restart pi to pick up changes. The outline is in-memory only (not persisted between sessions).

## pi-single-line-tool-calls

Collapses each built-in tool call (`read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`) to one line — `<Tool> <primary arg>` — instead of a boxed multi-line block.

- Execution is untouched; only the rendering is overridden.
- The tool name is bold and given a unique color hashed from its name, so any tool — including ones not listed — gets a stable, distinct color.
- The argument (path / command / pattern) is muted gray.
- On success the call line stands alone; on error a single red line is shown.

It is **not** auto-loaded. Load it explicitly (or use `./run_pi-single-line-tool-calls.sh`), optionally skipping discovery for a clean view without the outline editor:

```bash
pi --no-extensions -e extensions/pi-single-line-tool-calls/pi-single-line-tool-calls.ts
```

## Install from Git

Global install (writes to `~/.pi/agent/settings.json`):

```bash
pi install git:github.com/yippiez/pi-prompt-chain
```

Local/project install (writes to `.pi/settings.json` in the current repo):

```bash
pi install -l git:github.com/yippiez/pi-prompt-chain
```

## Optional: Pin to a ref

Pin global install to `main`:

```bash
pi install git:github.com/yippiez/pi-prompt-chain@main
```

Pin local install to `main`:

```bash
pi install -l git:github.com/yippiez/pi-prompt-chain@main
```
