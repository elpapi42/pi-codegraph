import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  countChangedFiles,
  type ChangedFiles,
  type CodeGraphRuntime,
  type StatusReport,
} from "./runtime.js";

export function registerCommands(pi: ExtensionAPI, runtime: CodeGraphRuntime): void {
  pi.registerCommand("cg:status", {
    description: "Show CodeGraph state, stats, and pending changes for the active path",
    handler: async (_args, ctx) => {
      const report = await runtime.getStatus(ctx.cwd);
      notify(ctx, formatStatus(report), report.state === "failed" ? "error" : "info");
    },
  });

  pi.registerCommand("cg:uninit", {
    description: "Remove the CodeGraph index for the active path",
    handler: async (args, ctx) => {
      const force = hasForceArg(args);

      try {
        const message = await runtime.uninitialize(ctx.cwd, force, ctx as Parameters<CodeGraphRuntime["uninitialize"]>[2]);
        notify(ctx, message, message.includes("cancelled") || message.includes("Nothing to remove") ? "warning" : "info");
      } catch (error) {
        notify(ctx, errorToMessage(error), "error");
      }
    },
  });
}

export function formatStatus(report: StatusReport): string {
  const lines = [`CodeGraph: ${report.state}`, `Active path: ${report.activePath}`, `Root: ${report.root}`];

  if (!report.initialized) {
    lines.push("Initialized: no");
    lines.push("The next CodeGraph tool call will initialize and index this active path.");
    appendLastError(lines, report);
    return lines.join("\n");
  }

  lines.push("Initialized: yes");

  if (report.stats) {
    lines.push(formatStats(report.stats));
  }

  if (report.backend) lines.push(`Backend: ${report.backend}`);
  if (report.journalMode) lines.push(`Journal: ${report.journalMode}`);

  if (report.changes) {
    const pending = report.pendingChanges ?? countChangedFiles(report.changes);
    lines.push(`Pending: ${pending} (${report.changes.added.length} added, ${report.changes.modified.length} modified, ${report.changes.removed.length} removed)`);
  }

  if (report.lastIndexResult) {
    lines.push(formatLastIndexResult(report.lastIndexResult));
  }

  if (report.lastSyncResult) {
    lines.push(formatLastSyncResult(report.lastSyncResult));
  }

  if (report.lastReadyAt) {
    lines.push(`Last ready: ${new Date(report.lastReadyAt).toISOString()}`);
  }

  appendLastError(lines, report);
  return lines.join("\n");
}

function formatStats(stats: StatusReport["stats"]): string {
  if (!stats) return "Files: unknown, Nodes: unknown, Edges: unknown";
  const record = stats as unknown as Record<string, unknown>;
  const fileCount = formatUnknown(record.fileCount);
  const nodeCount = formatUnknown(record.nodeCount);
  const edgeCount = formatUnknown(record.edgeCount);
  return `Files: ${fileCount}, Nodes: ${nodeCount}, Edges: ${edgeCount}`;
}

function formatLastIndexResult(result: NonNullable<StatusReport["lastIndexResult"]>): string {
  const record = result as unknown as Record<string, unknown>;
  const success = formatUnknown(record.success);
  const filesIndexed = formatUnknown(record.filesIndexed);
  const durationMs = formatUnknown(record.durationMs);
  const errors = Array.isArray(record.errors) ? record.errors.length : 0;
  return `Last index: success=${success}, filesIndexed=${filesIndexed}, errors=${errors}, durationMs=${durationMs}`;
}

function formatLastSyncResult(result: NonNullable<StatusReport["lastSyncResult"]>): string {
  return [
    `Last sync: checked=${result.filesChecked}`,
    `added=${result.filesAdded}`,
    `modified=${result.filesModified}`,
    `removed=${result.filesRemoved}`,
    `nodesUpdated=${result.nodesUpdated}`,
    `durationMs=${result.durationMs}`,
  ].join(", ");
}

function appendLastError(lines: string[], report: StatusReport): void {
  if (report.lastError) {
    lines.push(`Last error: ${report.lastError}`);
  }
}

function hasForceArg(args: string): boolean {
  return args.split(/\s+/).filter(Boolean).includes("--force");
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error"): void {
  ctx.ui.notify(message, type);
}

function formatUnknown(value: unknown): string {
  return value === undefined || value === null ? "unknown" : String(value);
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
