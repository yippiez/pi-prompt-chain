// Loader shim (a REAL file, not a symlink).
//
// pi resolves an extension's relative imports from the loaded file's own
// directory and does NOT follow a symlink to its real path. A symlink here would
// make the root module's `./editor.ts` (etc.) resolve inside .pi/extensions/ and
// fail. Re-exporting through this real shim keeps the single source of truth in
// extensions/pi-prompt-chain/ while letting its sibling imports resolve there.
export { default } from "../../extensions/pi-prompt-chain/pi-prompt-chain.ts";
