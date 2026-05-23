import assert from "node:assert/strict";
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
  markInitializedBeforeInitSettles?: boolean;
} = {}) {
  const initializedRoots = new Set((options.initializedRoots ?? []).map((root) => path.resolve(root)));
  const graphs = options.graphs ?? new Map<string, FakeGraph>();
  const counts: Counts = { init: 0, open: 0 };

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
      return initializedRoots.has(path.resolve(root));
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

  await ready;
  const message = await removed;

  assert.match(message, /Removed CodeGraph index/);
  assert.equal(graph.uninitializeCalls, 1);
  assert.equal(runtime.getCachedState(root), undefined);
});
