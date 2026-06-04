# pi-prompt-chain

A Workflowy-style outline editor implemented as a pi coding-agent extension
(`pi-prompt-chain.ts`). It replaces pi's text prompt with a nestable outline:
notes, bash nodes (`!`), multi-select → compose markdown → send.

## Version control: use `jj`, not `git`

This repo is managed with **jujutsu (`jj`)**, colocated with a git backend.
Always use `jj` for version-control operations — do **not** use `git add` /
`git commit` / `git checkout`.

- Inspect: `jj status`, `jj diff`, `jj log`
- Commit a logical chunk by path: `jj commit <paths> -m "msg"`
  (puts only those paths in the commit; the rest stays in the working copy)
- Revert a file to its parent: `jj restore <path>`
- The working copy is itself a commit (`@`); a detached git HEAD is normal.

## Editing the extension

The extension is split into modules in the repo root:

- `pi-prompt-chain.ts` — entry (default export): wires session events + registers the editor
- `editor.ts` — `PromptChainEditor` (the `CustomEditor`): input handling + rendering
- `outline-model.ts` — `OutlineModel`: the pure outline tree + cursor + ops
- `nodes.ts` — node data model: types, factories, guards
- `theme.ts` — colors, glyphs, layout ratios
- `text.ts` — pure render/format helpers (wrap, fit, sanitize, format)

`pi` auto-loads `.pi/extensions/pi-prompt-chain.ts`, which is a small REAL shim
(`export { default } from "../../pi-prompt-chain.ts"`) — NOT a symlink. pi
resolves an extension's relative imports from the loaded file's directory and
does not follow symlinks, so a symlink there would break the root module's
`./editor.ts` imports. Edit the root modules; the shim never changes. There is
no hot reload — restart pi to pick up changes.
