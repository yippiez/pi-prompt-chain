/**
 * pi-scratch.ts
 *
 * Empty scratch extension for experiments.
 * Edit and /reload to test changes.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
		ctx.ui.notify("scratch extension loaded", "info");
	});
}
