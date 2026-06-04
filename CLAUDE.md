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

`pi` loads `.pi/extensions/pi-prompt-chain.ts`, which is a symlink to the root
`pi-prompt-chain.ts` — edit the root file. There is no hot reload; restart pi
to pick up changes.
