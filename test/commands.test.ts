import assert from "node:assert/strict";
import test from "node:test";
import { registerCommands } from "../src/commands.js";
import type { ChangedFiles, CodeGraphRuntime, StatusReport } from "../src/runtime.js";

interface RegisteredCommand {
  name: string;
  options: {
    handler: (args: string, ctx: FakeCommandContext) => Promise<void> | void;
  };
}

interface Notification {
  message: string;
  type?: "info" | "warning" | "error";
}

interface FakeCommandContext {
  cwd: string;
  hasUI: boolean;
  ui: {
    notifications: Notification[];
    confirmCalls: Array<{ title: string; message: string; opts?: unknown }>;
    confirmResult: boolean;
    notify(message: string, type?: "info" | "warning" | "error"): void;
    confirm(title: string, message: string, opts?: unknown): Promise<boolean>;
  };
}

class FakeRuntime {
  statusReport: StatusReport;
  uninitializeCalls: Array<{ cwd: string; force: boolean }> = [];
  uninitializeMessage = "Removed CodeGraph index from /repo";
  uninitializeError?: Error;

  constructor(statusReport: StatusReport = createStatusReport()) {
    this.statusReport = statusReport;
  }

  async getStatus(cwd: string): Promise<StatusReport> {
    return { ...this.statusReport, activePath: cwd, searchedFrom: cwd };
  }

  async uninitialize(cwd: string, force: boolean): Promise<string> {
    this.uninitializeCalls.push({ cwd, force });
    if (this.uninitializeError) throw this.uninitializeError;
    return this.uninitializeMessage;
  }

  async closeAll(): Promise<void> {}
}

function createFakePi() {
  const commands: RegisteredCommand[] = [];
  return {
    commands,
    pi: {
      registerCommand(name: string, options: RegisteredCommand["options"]) {
        commands.push({ name, options });
      },
    },
  };
}

function createCtx(options: { cwd?: string; hasUI?: boolean; confirmResult?: boolean } = {}): FakeCommandContext {
  const ui = {
    notifications: [] as Notification[],
    confirmCalls: [] as Array<{ title: string; message: string; opts?: unknown }>,
    confirmResult: options.confirmResult ?? true,
    notify(message: string, type?: "info" | "warning" | "error") {
      this.notifications.push({ message, type });
    },
    async confirm(title: string, message: string, opts?: unknown) {
      this.confirmCalls.push({ title, message, opts });
      return this.confirmResult;
    },
  };

  return {
    cwd: options.cwd ?? "/repo",
    hasUI: options.hasUI ?? true,
    ui,
  };
}

function registerWith(runtime: FakeRuntime) {
  const fake = createFakePi();
  registerCommands(fake.pi as never, runtime as unknown as CodeGraphRuntime);
  return fake.commands;
}

function command(commands: RegisteredCommand[], name: string): RegisteredCommand {
  const found = commands.find((item) => item.name === name);
  assert.ok(found, `${name} should be registered`);
  return found;
}

function createStatusReport(overrides: Partial<StatusReport> = {}): StatusReport {
  const changes: ChangedFiles = { added: [], modified: [], removed: [] };
  return {
    activePath: "/repo",
    root: "/repo",
    searchedFrom: "/repo",
    state: "ready",
    initialized: true,
    stats: { fileCount: 2, nodeCount: 4, edgeCount: 1 } as StatusReport["stats"],
    changes,
    pendingChanges: 0,
    backend: "fake",
    journalMode: "fake-journal",
    ...overrides,
  };
}

test("/cg:status reports active path, root, state, stats, pending changes, and last error", async () => {
  const runtime = new FakeRuntime(createStatusReport({
    state: "not_synced",
    changes: { added: ["new.ts"], modified: ["src/a.ts"], removed: [] },
    pendingChanges: 2,
    lastError: "needs sync",
  }));
  const commands = registerWith(runtime);
  const ctx = createCtx({ cwd: "/repo/src" });

  await command(commands, "cg:status").options.handler("", ctx);

  const message = ctx.ui.notifications[0]?.message ?? "";
  assert.match(message, /CodeGraph: not_synced/);
  assert.match(message, /Active path: \/repo\/src/);
  assert.match(message, /Root: \/repo/);
  assert.match(message, /Files: 2, Nodes: 4, Edges: 1/);
  assert.match(message, /Pending: 2 \(1 added, 1 modified, 0 removed\)/);
  assert.match(message, /Last error: needs sync/);
});

test("/cg:uninit delegates not-initialized no-op to runtime and reports warning", async () => {
  const runtime = new FakeRuntime();
  runtime.uninitializeMessage = "CodeGraph is not initialized for /repo. Nothing to remove.";
  const commands = registerWith(runtime);
  const ctx = createCtx({ cwd: "/repo" });

  await command(commands, "cg:uninit").options.handler("", ctx);

  assert.deepEqual(runtime.uninitializeCalls, [{ cwd: "/repo", force: false }]);
  assert.equal(ctx.ui.notifications[0]?.type, "warning");
  assert.match(ctx.ui.notifications[0]?.message ?? "", /Nothing to remove/);
});

test("/cg:uninit passes force flag to runtime", async () => {
  const runtime = new FakeRuntime();
  const commands = registerWith(runtime);
  const ctx = createCtx({ cwd: "/repo" });

  await command(commands, "cg:uninit").options.handler("--force", ctx);

  assert.deepEqual(runtime.uninitializeCalls, [{ cwd: "/repo", force: true }]);
  assert.equal(ctx.ui.notifications[0]?.type, "info");
  assert.match(ctx.ui.notifications[0]?.message ?? "", /Removed CodeGraph/);
});

test("/cg:uninit surfaces confirmation, non-interactive, and busy refusals from runtime as errors", async () => {
  const runtime = new FakeRuntime();
  runtime.uninitializeError = new Error("CodeGraph is currently initializing, indexing, or syncing.");
  const commands = registerWith(runtime);
  const ctx = createCtx({ cwd: "/repo", hasUI: false });

  await command(commands, "cg:uninit").options.handler("", ctx);

  assert.equal(ctx.ui.notifications[0]?.type, "error");
  assert.match(ctx.ui.notifications[0]?.message ?? "", /currently initializing/);
});

test("commands register status and uninit but not init", () => {
  const commands = registerWith(new FakeRuntime());

  assert.deepEqual(commands.map((item) => item.name).sort(), ["cg:status", "cg:uninit"]);
  assert.equal(commands.some((item) => item.name === "cg:init"), false);
});
