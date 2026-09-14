import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodeGraphRuntime, resolveCodeGraphRoot, type ChangedFiles, type CodeGraphSdk } from "../src/runtime.js";

type Counts = {
  init: number;
  open: number;
};

const emptyChanges = (): ChangedFiles => ({ added: [], modified: [], removed: [] });

class FakeGraph {
  indexAllCalls = 0;
  syncCalls = 0;
  closeCalls = 0;
  clearCalls = 0;
  uninitializeCalls = 0;
  changes: ChangedFiles = emptyChanges();
  indexResult?: { success: boolean; filesIndexed: number; errors: Array<{ message: string }>; durationMs: number };
  indexError?: Error;
  syncResult?: {
    filesChecked: number;
    filesAdded: number;
    filesModified: number;
    filesRemoved: number;
    nodesUpdated: number;
    durationMs: number;
  };

  constructor(
    readonly root: string,
    public fileCount: number,
    private readonly afterIndexFileCount = fileCount,
  ) {}

  getStats() {
    return { fileCount: this.fileCount, nodeCount: this.fileCount * 2, edgeCount: this.fileCount };
  }

  getChangedFiles() {
    return this.changes;
  }

  async indexAll() {
    this.indexAllCalls += 1;
    if (this.indexError) throw this.indexError;
    if (this.indexResult) return this.indexResult;
    this.fileCount = this.afterIndexFileCount;
    return { success: true, filesIndexed: this.fileCount, errors: [], durationMs: 1 };
  }

  async sync() {
    this.syncCalls += 1;
    if (this.syncResult) return this.syncResult;
    const changed = this.changes;
    this.changes = emptyChanges();
    return {
      filesChecked: changed.added.length + changed.modified.length + changed.removed.length,
      filesAdded: changed.added.length,
      filesModified: changed.modified.length,
      filesRemoved: changed.removed.length,
      nodesUpdated: changed.added.length + changed.modified.length,
      durationMs: 1,
    };
  }

  close() {
    this.closeCalls += 1;
  }

  clear() {
    this.clearCalls += 1;
    this.fileCount = 0;
  }

  uninitialize() {
    this.uninitializeCalls += 1;
  }

  getBackend() {
    return "fake";
  }

  getJournalMode() {
    return "fake-journal";
  }
}

function createSdk(options: {
  initializedRoots?: string[];
  graphs?: Map<string, FakeGraph>;
  onInit?: (root: string) => Promise<FakeGraph> | FakeGraph;
  onOpen?: (root: string) => Promise<FakeGraph> | FakeGraph;
  isInitializedOverride?: (root: string, call: number) => boolean;
  markInitializedBeforeInitSettles?: boolean;
} = {}) {
  const initializedRoots = new Set((options.initializedRoots ?? []).map((root) => path.resolve(root)));
  const graphs = options.graphs ?? new Map<string, FakeGraph>();
  const counts: Counts = { init: 0, open: 0 };
  let isInitializedCalls = 0;

  const findNearestCodeGraphRoot = (startPath: string): string | null => {
    let current = path.resolve(startPath);
    while (true) {
      if (initializedRoots.has(current)) return current;
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  };

  const sdk = {
    findNearestCodeGraphRoot,
    isInitialized(root: string) {
      isInitializedCalls += 1;
      return options.isInitializedOverride?.(root, isInitializedCalls) ?? initializedRoots.has(path.resolve(root));
    },
    CodeGraph: {
      async init(root: string) {
        counts.init += 1;
        const resolved = path.resolve(root);
        if (options.markInitializedBeforeInitSettles !== false) {
          initializedRoots.add(resolved);
        }
        const graph = await (options.onInit?.(resolved) ?? new FakeGraph(resolved, 0, 1));
        initializedRoots.add(resolved);
        graphs.set(resolved, graph);
        return graph;
      },
      async open(root: string) {
        counts.open += 1;
        const resolved = path.resolve(root);
        const graph = await (options.onOpen?.(resolved) ?? graphs.get(resolved));
        if (!graph) throw new Error(`No fake graph for ${resolved}`);
        graphs.set(resolved, graph);
        return graph;
      },
    },
  } as unknown as CodeGraphSdk;

  return { sdk, counts, graphs, initializedRoots };
}

test("resolveCodeGraphRoot walks upward to nearest initialized parent", () => {
  const root = path.resolve("/repo");
  const child = path.join(root, "src/components");
  const { sdk } = createSdk({ initializedRoots: [root] });

  assert.deepEqual(resolveCodeGraphRoot(child, sdk), { root, initialized: true });
});

test("ensureReady initializes exactly at ctx.cwd when no parent root exists", async () => {
  const cwd = path.resolve("/workspace/subdir");
  const { sdk, counts, graphs } = createSdk();
  const runtime = new CodeGraphRuntime(sdk);

  const graph = await runtime.ensureReady({ cwd });

  assert.equal(counts.init, 1);
  assert.equal(counts.open, 0);
  assert.equal(graphs.get(cwd), graph);
  assert.equal((graph as unknown as FakeGraph).indexAllCalls, 1);
});

test("ensureReady reuses an external indexed ancestor without initializing it", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-project-path-"));
  const cwd = path.join(fixture, "a");
  const root = path.join(fixture, "b");
  const nested = path.join(root, "Z");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  try {
    const graph = new FakeGraph(root, 3);
    graph.changes = { added: [], modified: ["src/auth.ts"], removed: [] };
    const { sdk, counts } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
    const runtime = new CodeGraphRuntime(sdk);

    const ready = await runtime.ensureReady({ cwd }, { projectPath: nested });

    assert.equal(ready, graph);
    assert.equal(counts.open, 1);
    assert.equal(counts.init, 0);
    assert.equal(graph.indexAllCalls, 0);
    assert.equal(graph.syncCalls, 1);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("ensureReady rejects a supplied path without an existing index before SDK side effects", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-project-path-"));
  const cwd = path.join(fixture, "a");
  const target = path.join(fixture, "b", "Z");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(target, { recursive: true });
  try {
    const { sdk, counts } = createSdk();
    const runtime = new CodeGraphRuntime(sdk);

    await assert.rejects(
      () => runtime.ensureReady({ cwd }, { projectPath: target }),
      (error: Error) => {
        assert.match(error.message, /Continue the current task by using read, rg, or find to inspect code under this path/);
        assert.match(error.message, /Do not retry this path by omitting projectPath/);
        return true;
      },
    );

    assert.equal(counts.open, 0);
    assert.equal(counts.init, 0);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("ensureReady never rebuilds an empty index selected by projectPath", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-project-path-"));
  const cwd = path.join(fixture, "a");
  const root = path.join(fixture, "b");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  try {
    const graph = new FakeGraph(root, 0, 4);
    const { sdk, counts } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
    const runtime = new CodeGraphRuntime(sdk);

    await assert.rejects(() => runtime.ensureReady({ cwd }, { projectPath: root }), /No existing CodeGraph data was found/);

    assert.equal(counts.open, 1);
    assert.equal(counts.init, 0);
    assert.equal(graph.indexAllCalls, 0);
    assert.equal(graph.clearCalls, 0);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("ensureReady preserves reuse-only authority when an external marker disappears", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-project-path-"));
  const cwd = path.join(fixture, "a");
  const root = path.join(fixture, "b");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  try {
    const { sdk, counts } = createSdk({
      initializedRoots: [root],
      isInitializedOverride: (_root, call) => call === 1,
      onOpen: () => { throw new Error("index disappeared"); },
    });
    const runtime = new CodeGraphRuntime(sdk);

    await assert.rejects(() => runtime.ensureReady({ cwd }, { projectPath: root }), /index disappeared/);

    assert.equal(counts.init, 0);
    assert.equal(counts.open, 1);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("ensureReady resolves relative external projectPath values from ctx.cwd", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-project-path-"));
  const cwd = path.join(fixture, "a");
  const root = path.join(fixture, "b");
  const nested = path.join(root, "Z");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(nested, { recursive: true });
  try {
    const graph = new FakeGraph(root, 3);
    const { sdk, counts } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
    const runtime = new CodeGraphRuntime(sdk);

    assert.equal(await runtime.ensureReady({ cwd }, { projectPath: "../b/Z" }), graph);
    assert.equal(counts.open, 1);
    assert.equal(counts.init, 0);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("ensureReady rejects blank, file, and missing projectPath values before SDK side effects", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-project-path-"));
  const cwd = path.join(fixture, "a");
  const file = path.join(fixture, "file.ts");
  fs.mkdirSync(cwd, { recursive: true });
  fs.writeFileSync(file, "export {};\n");
  try {
    const { sdk, counts } = createSdk();
    const runtime = new CodeGraphRuntime(sdk);

    await assert.rejects(() => runtime.ensureReady({ cwd }, { projectPath: " " }), /existing directory/);
    await assert.rejects(() => runtime.ensureReady({ cwd }, { projectPath: file }), /existing directory/);
    await assert.rejects(() => runtime.ensureReady({ cwd }, { projectPath: path.join(fixture, "missing") }), /existing directory/);
    assert.equal(counts.open, 0);
    assert.equal(counts.init, 0);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("ensureReady canonicalizes projectPath aliases before caching a selected root", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-project-path-"));
  const cwd = path.join(fixture, "a");
  const root = path.join(fixture, "b");
  const alias = path.join(fixture, "alias");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(root, alias, "dir");
  try {
    const graph = new FakeGraph(root, 3);
    const { sdk, counts } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
    const runtime = new CodeGraphRuntime(sdk);

    const [first, second] = await Promise.all([
      runtime.ensureReady({ cwd }, { projectPath: alias }),
      runtime.ensureReady({ cwd }, { projectPath: root }),
    ]);

    assert.equal(first, graph);
    assert.equal(second, graph);
    assert.equal(counts.open, 1);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("ensureReady serializes mixed reuse-only and auto-index policies without duplicate graphs", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-project-path-"));
  const root = path.join(fixture, "repo");
  fs.mkdirSync(root, { recursive: true });
  try {
    let releaseOpen!: (graph: FakeGraph) => void;
    const opened = new Promise<FakeGraph>((resolve) => { releaseOpen = resolve; });
    const graph = new FakeGraph(root, 0, 2);
    const { sdk, counts } = createSdk({ initializedRoots: [root], onOpen: () => opened });
    const runtime = new CodeGraphRuntime(sdk);

    const explicit = runtime.ensureReady({ cwd: root }, { projectPath: root });
    const omitted = runtime.ensureReady({ cwd: root });
    releaseOpen(graph);

    await assert.rejects(explicit, /No existing CodeGraph data was found/);
    assert.equal(await omitted, graph);
    assert.equal(graph.indexAllCalls, 1);
    assert.equal(counts.open, 1);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("ensureReady makes explicit reuse wait for an omitted empty-index build", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-project-path-"));
  const root = path.join(fixture, "repo");
  fs.mkdirSync(root, { recursive: true });
  try {
    let releaseOpen!: (graph: FakeGraph) => void;
    const opened = new Promise<FakeGraph>((resolve) => { releaseOpen = resolve; });
    const graph = new FakeGraph(root, 0, 2);
    const { sdk, counts } = createSdk({ initializedRoots: [root], onOpen: () => opened });
    const runtime = new CodeGraphRuntime(sdk);

    const omitted = runtime.ensureReady({ cwd: root });
    const explicit = runtime.ensureReady({ cwd: root }, { projectPath: root });
    releaseOpen(graph);

    assert.equal(await omitted, graph);
    assert.equal(await explicit, graph);
    assert.equal(graph.indexAllCalls, 1);
    assert.equal(counts.open, 1);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("uninitialize force rejects a queued mixed-policy caller before a second sync", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-project-path-"));
  const root = path.join(fixture, "repo");
  fs.mkdirSync(root, { recursive: true });
  try {
    let releaseSync!: () => void;
    let syncStarted!: () => void;
    const started = new Promise<void>((resolve) => { syncStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseSync = resolve; });
    const graph = new FakeGraph(root, 2);
    graph.changes = { added: [], modified: ["src/auth.ts"], removed: [] };
    graph.sync = async () => {
      graph.syncCalls += 1;
      syncStarted();
      await blocked;
      graph.changes = emptyChanges();
      return { filesChecked: 1, filesAdded: 0, filesModified: 1, filesRemoved: 0, nodesUpdated: 1, durationMs: 1 };
    };
    const { sdk } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
    const runtime = new CodeGraphRuntime(sdk);

    const explicit = runtime.ensureReady({ cwd: root }, { projectPath: root });
    await started;
    const omitted = runtime.ensureReady({ cwd: root });
    const removed = runtime.uninitialize(root, true, { hasUI: false });
    releaseSync();

    await assert.rejects(explicit, /being removed/);
    await assert.rejects(omitted, /being removed/);
    assert.match(await removed, /Removed CodeGraph index/);
    assert.equal(graph.syncCalls, 1);
    assert.equal(graph.uninitializeCalls, 1);
    assert.equal(runtime.getCachedState(root), undefined);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("ensureReady uses one canonical state after omitted symlink initialization", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-project-path-"));
  const root = path.join(fixture, "repo");
  const alias = path.join(fixture, "alias");
  fs.mkdirSync(root, { recursive: true });
  fs.symlinkSync(root, alias, "dir");
  try {
    const graph = new FakeGraph(root, 0, 2);
    const { sdk, counts } = createSdk({ onInit: () => graph });
    const runtime = new CodeGraphRuntime(sdk);

    assert.equal(await runtime.ensureReady({ cwd: alias }), graph);
    assert.equal(await runtime.ensureReady({ cwd: alias }), graph);
    assert.equal(await runtime.ensureReady({ cwd: fixture }, { projectPath: root }), graph);
    assert.equal((await runtime.getStatus(alias)).root, root);
    assert.equal(counts.init, 1);
    assert.equal(counts.open, 0);
    assert.equal(runtime.getCachedState(root)?.root, root);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("ensureReady preserves corrupt external index errors without initialization", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-project-path-"));
  const cwd = path.join(fixture, "a");
  const root = path.join(fixture, "b");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  try {
    const { sdk, counts } = createSdk({ initializedRoots: [root], onOpen: () => { throw new Error("corrupt index"); } });
    const runtime = new CodeGraphRuntime(sdk);

    await assert.rejects(() => runtime.ensureReady({ cwd }, { projectPath: root }), /corrupt index/);
    assert.equal(counts.open, 1);
    assert.equal(counts.init, 0);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("ensureReady aborts before resolving or opening a supplied projectPath", async () => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-project-path-"));
  const cwd = path.join(fixture, "a");
  const root = path.join(fixture, "b");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(root, { recursive: true });
  try {
    const graph = new FakeGraph(root, 3);
    const { sdk, counts } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
    const runtime = new CodeGraphRuntime(sdk);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(() => runtime.ensureReady({ cwd }, { projectPath: root, signal: controller.signal }), /aborted/);
    assert.equal(counts.open, 0);
    assert.equal(counts.init, 0);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test("ensureReady opens parent root and skips index/sync when already clean", async () => {
  const root = path.resolve("/repo-clean");
  const child = path.join(root, "src");
  const graph = new FakeGraph(root, 3);
  const { sdk, counts, graphs } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
  const runtime = new CodeGraphRuntime(sdk);

  const ready = await runtime.ensureReady({ cwd: child });

  assert.equal(ready, graph);
  assert.equal(counts.open, 1);
  assert.equal(graph.indexAllCalls, 0);
  assert.equal(graph.syncCalls, 0);
});

test("ensureReady indexes an existing empty graph and then runs query-ready", async () => {
  const root = path.resolve("/repo-empty");
  const graph = new FakeGraph(root, 0, 4);
  const { sdk } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
  const runtime = new CodeGraphRuntime(sdk);

  await runtime.ensureReady({ cwd: root });

  assert.equal(graph.indexAllCalls, 1);
  assert.equal(graph.fileCount, 4);
  assert.equal(runtime.getCachedState(root)?.status, "ready");
});

test("ensureReady syncs when changed files are pending", async () => {
  const root = path.resolve("/repo-changed");
  const graph = new FakeGraph(root, 2);
  graph.changes = { added: [], modified: ["src/a.ts"], removed: [] };
  const { sdk } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
  const runtime = new CodeGraphRuntime(sdk);

  await runtime.ensureReady({ cwd: root });

  assert.equal(graph.syncCalls, 1);
  assert.deepEqual(graph.changes, emptyChanges());
});

test("concurrent ensureReady calls share one initialization/index operation", async () => {
  const cwd = path.resolve("/repo-concurrent");
  let release!: (graph: FakeGraph) => void;
  const initStarted = new Promise<FakeGraph>((resolve) => {
    release = resolve;
  });
  const { sdk, counts } = createSdk({ onInit: () => initStarted });
  const runtime = new CodeGraphRuntime(sdk);

  const first = runtime.ensureReady({ cwd });
  const second = runtime.ensureReady({ cwd });
  release(new FakeGraph(cwd, 0, 1));

  const [firstGraph, secondGraph] = await Promise.all([first, second]);

  assert.equal(firstGraph, secondGraph);
  assert.equal(counts.init, 1);
  assert.equal((firstGraph as unknown as FakeGraph).indexAllCalls, 1);
});


test("ensureReady fails closed and clears partial index when indexAll reports failure", async () => {
  const root = path.resolve("/repo-index-fails");
  const graph = new FakeGraph(root, 0, 0);
  graph.indexResult = {
    success: false,
    filesIndexed: 1,
    errors: [{ message: "parse exploded" }],
    durationMs: 1,
  };
  const { sdk } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
  const runtime = new CodeGraphRuntime(sdk);

  await assert.rejects(() => runtime.ensureReady({ cwd: root }), /parse exploded/);

  assert.ok(graph.clearCalls >= 1);
  assert.equal(runtime.getCachedState(root)?.status, "failed");
  assert.match(runtime.getCachedState(root)?.lastError ?? "", /parse exploded/);
});

test("ensureReady fails closed and clears partial index when indexAll throws cancellation", async () => {
  const root = path.resolve("/repo-index-cancelled");
  const graph = new FakeGraph(root, 0, 0);
  graph.indexError = new Error("Aborted");
  const { sdk } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
  const runtime = new CodeGraphRuntime(sdk);

  await assert.rejects(() => runtime.ensureReady({ cwd: root }), /Aborted/);

  assert.equal(graph.clearCalls, 1);
  assert.equal(runtime.getCachedState(root)?.status, "failed");
});

test("ensureReady treats zero indexed files as not_indexed hard error", async () => {
  const root = path.resolve("/repo-zero-files");
  const graph = new FakeGraph(root, 0, 0);
  const { sdk } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
  const runtime = new CodeGraphRuntime(sdk);

  await assert.rejects(() => runtime.ensureReady({ cwd: root }), /CodeGraph indexed 0 files/);

  assert.equal(graph.indexAllCalls, 1);
  assert.equal(runtime.getCachedState(root)?.status, "not_indexed");
});

test("ensureReady does not endlessly retry zero-file indexing in the same process", async () => {
  const root = path.resolve("/repo-zero-files-repeat");
  const graph = new FakeGraph(root, 0, 0);
  const { sdk } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
  const runtime = new CodeGraphRuntime(sdk);

  await assert.rejects(() => runtime.ensureReady({ cwd: root }), /CodeGraph indexed 0 files/);
  await assert.rejects(() => runtime.ensureReady({ cwd: root }), /CodeGraph indexed 0 files/);

  assert.equal(graph.indexAllCalls, 1);
  assert.equal(runtime.getCachedState(root)?.status, "not_indexed");
});

test("ensureReady fails closed when sync returns the lock-skipped zero result after pending changes", async () => {
  const root = path.resolve("/repo-lock-skipped");
  const graph = new FakeGraph(root, 2);
  graph.changes = { added: [], modified: ["src/a.ts"], removed: [] };
  graph.syncResult = {
    filesChecked: 0,
    filesAdded: 0,
    filesModified: 0,
    filesRemoved: 0,
    nodesUpdated: 0,
    durationMs: 0,
  };
  const { sdk } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
  const runtime = new CodeGraphRuntime(sdk);

  await assert.rejects(() => runtime.ensureReady({ cwd: root }), /could not sync/);

  assert.equal(graph.syncCalls, 1);
  assert.equal(runtime.getCachedState(root)?.status, "not_synced");
});

test("ensureReady clears rejected in-flight promise so later calls can retry", async () => {
  const root = path.resolve("/repo-retry-after-failure");
  const graph = new FakeGraph(root, 0, 3);
  graph.indexError = new Error("temporary failure");
  const { sdk } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
  const runtime = new CodeGraphRuntime(sdk);

  await assert.rejects(() => runtime.ensureReady({ cwd: root }), /temporary failure/);
  graph.indexError = undefined;

  await runtime.ensureReady({ cwd: root });

  assert.equal(graph.indexAllCalls, 2);
  assert.equal(runtime.getCachedState(root)?.status, "ready");
});


test("uninitialize returns no-op message when active path is not initialized", async () => {
  const cwd = path.resolve("/repo-uninit-missing");
  const { sdk } = createSdk();
  const runtime = new CodeGraphRuntime(sdk);

  const message = await runtime.uninitialize(cwd, false);

  assert.match(message, /not initialized/);
  assert.match(message, /Nothing to remove/);
});

test("uninitialize uses UI confirmation and respects cancellation", async () => {
  const root = path.resolve("/repo-uninit-cancel");
  const graph = new FakeGraph(root, 2);
  const { sdk } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
  const runtime = new CodeGraphRuntime(sdk);
  const ctx = {
    hasUI: true,
    ui: {
      async confirm() { return false; },
      notify() {},
    },
  };

  const message = await runtime.uninitialize(root, false, ctx);

  assert.equal(message, "CodeGraph uninit cancelled.");
  assert.equal(graph.uninitializeCalls, 0);
});

test("uninitialize refuses non-interactive removal without force", async () => {
  const root = path.resolve("/repo-uninit-noninteractive");
  const graph = new FakeGraph(root, 2);
  const { sdk } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
  const runtime = new CodeGraphRuntime(sdk);

  await assert.rejects(() => runtime.uninitialize(root, false, { hasUI: false }), /Refusing to remove/);

  assert.equal(graph.uninitializeCalls, 0);
});

test("uninitialize force bypasses confirmation and removes initialized root", async () => {
  const root = path.resolve("/repo-uninit-force");
  const graph = new FakeGraph(root, 2);
  const { sdk } = createSdk({ initializedRoots: [root], graphs: new Map([[root, graph]]) });
  const runtime = new CodeGraphRuntime(sdk);

  const message = await runtime.uninitialize(root, true, { hasUI: false });

  assert.match(message, /Removed CodeGraph index/);
  assert.equal(graph.uninitializeCalls, 1);
  assert.equal(runtime.getCachedState(root), undefined);
});

test("uninitialize refuses while readiness is in-flight without force", async () => {
  const root = path.resolve("/repo-uninit-busy");
  let release!: (graph: FakeGraph) => void;
  const initStarted = new Promise<FakeGraph>((resolve) => {
    release = resolve;
  });
  const { sdk } = createSdk({ onInit: () => initStarted });
  const runtime = new CodeGraphRuntime(sdk);

  const ready = runtime.ensureReady({ cwd: root });
  await assert.rejects(() => runtime.uninitialize(root, false), /currently initializing/);

  release(new FakeGraph(root, 0, 1));
  await ready;
});

test("uninitialize refuses during early init before CodeGraph db exists", async () => {
  const root = path.resolve("/repo-uninit-early-busy");
  let release!: (graph: FakeGraph) => void;
  const initStarted = new Promise<FakeGraph>((resolve) => {
    release = resolve;
  });
  const { sdk } = createSdk({
    markInitializedBeforeInitSettles: false,
    onInit: () => initStarted,
  });
  const runtime = new CodeGraphRuntime(sdk);

  const ready = runtime.ensureReady({ cwd: root });
  await assert.rejects(() => runtime.uninitialize(root, false), /currently initializing/);

  release(new FakeGraph(root, 0, 1));
  await ready;
});

test("uninitialize force waits for early init before removing", async () => {
  const root = path.resolve("/repo-uninit-early-force");
  let release!: (graph: FakeGraph) => void;
  const initStarted = new Promise<FakeGraph>((resolve) => {
    release = resolve;
  });
  const { sdk } = createSdk({
    markInitializedBeforeInitSettles: false,
    onInit: () => initStarted,
  });
  const runtime = new CodeGraphRuntime(sdk);

  const ready = runtime.ensureReady({ cwd: root });
  const removed = runtime.uninitialize(root, true, { hasUI: false });
  const graph = new FakeGraph(root, 0, 1);
  release(graph);

  await assert.rejects(ready, /being removed/);
  const message = await removed;

  assert.match(message, /Removed CodeGraph index/);
  assert.equal(graph.uninitializeCalls, 1);
  assert.equal(runtime.getCachedState(root), undefined);
});
