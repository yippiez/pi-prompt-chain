# pi-prompt-chain

`pi-prompt-chain` is a standalone Pi extension that replaces pi's text prompt with a nestable outline editor.

## Outline editor

Build a tree, drop in bash nodes, multi-select rows to compose one markdown prompt, and send it to the agent.

- `⇥` / `⇧⇥` — indent / outdent the current node
- `↵` — split: append a new sibling node
- `^d` — delete the current node (and its subtree)
- `^␣` — fold / unfold a node with children
- `!` — turn the current node into a bash node
- `^r` — run the bash node inline (stdout renders in a box beneath it)
- `^s` — compose the selected nodes into markdown and send
- `^t` — cycle thinking level
- `^o` — pi's built-in collapse / expand tool output
- `@` — file reference completion; referenced text files are included when sent
- `^f` — bash path completion for bash nodes
- `/` — slash commands

There is no hot reload — restart pi to pick up changes. The outline is in-memory only (not persisted between sessions).

## Run locally

```bash
./run.sh
```

or:

```bash
pi --no-extensions -e extensions/pi-prompt-chain/pi-prompt-chain.ts
```

## Companion extension

Compact tool-call rendering now lives in its own independent package:

```text
/home/eren/work2/pi-compact-tool-calls
```

Install/run that package separately, or load both extensions explicitly if you want both behaviors.

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
