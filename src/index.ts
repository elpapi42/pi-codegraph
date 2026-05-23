import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerCommands } from "./commands.js";
import { CodeGraphRuntime } from "./runtime.js";
import { registerTools } from "./tools.js";

export default function piCodegraph(pi: ExtensionAPI): void {
  const runtime = new CodeGraphRuntime();

  // MVP intentionally does not call ensureReady() from session_start.
  // Readiness can initialize/index/sync and must be triggered by tool calls.
  pi.on("session_shutdown", async () => {
    await runtime.closeAll();
  });

  registerCommands(pi, runtime);
  registerTools(pi, runtime);
}
