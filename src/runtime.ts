import path from "node:path";
import {
  CodeGraph,
  findNearestCodeGraphRoot,
  isInitialized,
  type CodeGraphInstance,
  type GraphStats,
  type IndexProgress,
  type IndexResult,
  type SyncResult,
} from "./codegraph-sdk.js";

export type CodeGraphStatus =
  | "not_initialized"
  | "not_indexed"
  | "not_synced"
  | "ready"
  | "initializing"
  | "indexing"
  | "syncing"
  | "failed";

export interface ChangedFiles {
  added: string[];
  modified: string[];
  removed: string[];
}

export interface ReadyContext {
  cwd: string;
}

export interface ReadyOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}

export interface StatusReport {
  activePath: string;
  root: string;
  searchedFrom: string;
  state: CodeGraphStatus;
  initialized: boolean;
  stats?: GraphStats;
  changes?: ChangedFiles;
  pendingChanges?: number;
  lastError?: string;
  lastIndexResult?: IndexResult;
  lastSyncResult?: SyncResult;
  lastReadyAt?: number;
  backend?: string;
  journalMode?: string;
}

interface ProjectState {
  root: string;
  cg?: CodeGraphInstance;
  status: CodeGraphStatus;
  readyPromise?: Promise<CodeGraphInstance>;
  syncPromise?: Promise<void>;
  lastError?: string;
  lastIndexResult?: IndexResult;
  lastSyncResult?: SyncResult;
  lastReadyAt?: number;
  zeroIndexBlocked?: boolean;
}

interface UninitContext {
  hasUI?: boolean;
  ui?: {
    confirm?: (title: string, message: string, opts?: unknown) => Promise<boolean>;
    notify?: (message: string, type?: "info" | "warning" | "error") => void;
  };
}

export interface CodeGraphSdk {
  CodeGraph: {
    init: typeof CodeGraph.init;
    open: typeof CodeGraph.open;
  };
  findNearestCodeGraphRoot: typeof findNearestCodeGraphRoot;
  isInitialized: typeof isInitialized;
}

const defaultSdk: CodeGraphSdk = {
  CodeGraph,
  findNearestCodeGraphRoot,
  isInitialized,
};

const LOCK_SKIPPED_SYNC_MESSAGE =
  "CodeGraph could not sync because another process may be indexing. Retry or run /cg:status.";
const ZERO_INDEXED_FILES_MESSAGE =
  "CodeGraph indexed 0 files. No supported source files found or indexing failed.";

export function resolveCodeGraphRoot(
  startPath: string,
  sdk: Pick<CodeGraphSdk, "findNearestCodeGraphRoot" | "isInitialized"> = defaultSdk,
): { root: string; initialized: boolean } {
  const resolvedStart = path.resolve(startPath);
  const nearest = sdk.findNearestCodeGraphRoot(resolvedStart);

  if (nearest && sdk.isInitialized(nearest)) {
    return { root: nearest, initialized: true };
  }

  return { root: resolvedStart, initialized: false };
}

export function countChangedFiles(changes: ChangedFiles): number {
  return changes.added.length + changes.modified.length + changes.removed.length;
}

export function isLockSkippedSync(result: SyncResult): boolean {
  return (
    result.filesChecked === 0 &&
    result.filesAdded === 0 &&
    result.filesModified === 0 &&
    result.filesRemoved === 0 &&
    result.nodesUpdated === 0 &&
    result.durationMs === 0
  );
}

export function progressToMessage(
  onProgress?: (message: string) => void,
): ((progress: IndexProgress) => void) | undefined {
  if (!onProgress) return undefined;

  let lastEmit = 0;

  return (progress) => {
    const now = Date.now();
    if (now - lastEmit < 500 && progress.current !== progress.total) return;
    lastEmit = now;

    const total = progress.total ? `/${progress.total}` : "";
    const currentFile = progress.currentFile ? ` ${progress.currentFile}` : "";
    onProgress(`CodeGraph ${progress.phase}: ${progress.current}${total}${currentFile}`);
  };
}

export class CodeGraphRuntime {
  private readonly projects = new Map<string, ProjectState>();

  constructor(private readonly sdk: CodeGraphSdk = defaultSdk) {}

  async ensureReady(ctx: ReadyContext, options: ReadyOptions = {}): Promise<CodeGraphInstance> {
    const { root, initialized } = resolveCodeGraphRoot(ctx.cwd, this.sdk);
    const state = this.getOrCreateState(root, initialized);

    if (state.readyPromise) return state.readyPromise;

    state.readyPromise = this.ensureReadyInner(state, initialized, options)
      .catch((error) => {
        if (state.status !== "not_indexed" && state.status !== "not_synced") {
          state.status = "failed";
        }
        state.lastError = errorToMessage(error);
        throw error;
      })
      .finally(() => {
        state.readyPromise = undefined;
      });

    return state.readyPromise;
  }

  async getStatus(cwd: string): Promise<StatusReport> {
    const activePath = path.resolve(cwd);
    const { root, initialized } = resolveCodeGraphRoot(activePath, this.sdk);
    const state = this.projects.get(root);

    if (!initialized && !state?.cg) {
      return {
        activePath,
        root,
        searchedFrom: activePath,
        state: state?.status ?? "not_initialized",
        initialized: false,
        lastError: state?.lastError,
        lastIndexResult: state?.lastIndexResult,
        lastSyncResult: state?.lastSyncResult,
        lastReadyAt: state?.lastReadyAt,
      };
    }

    try {
      const cg = state?.cg ?? await this.sdk.CodeGraph.open(root);
      const stats = cg.getStats();
      const changes = cg.getChangedFiles() as ChangedFiles;
      const pendingChanges = countChangedFiles(changes);
      const computedState: CodeGraphStatus = state?.status === "failed"
        ? "failed"
        : stats.fileCount === 0
          ? "not_indexed"
          : pendingChanges > 0
            ? "not_synced"
            : state?.status === "initializing" || state?.status === "indexing" || state?.status === "syncing"
              ? state.status
              : "ready";

      const backend = safeCall(() => cg.getBackend());
      const journalMode = safeCall(() => cg.getJournalMode());
      if (!state?.cg) cg.close();

      return {
        activePath,
        root,
        searchedFrom: activePath,
        state: computedState,
        initialized: true,
        stats,
        changes,
        pendingChanges,
        lastError: state?.lastError,
        lastIndexResult: state?.lastIndexResult,
        lastSyncResult: state?.lastSyncResult,
        lastReadyAt: state?.lastReadyAt,
        backend,
        journalMode,
      };
    } catch (error) {
      return {
        activePath,
        root,
        searchedFrom: activePath,
        state: "failed",
        initialized: true,
        lastError: errorToMessage(error),
        lastIndexResult: state?.lastIndexResult,
        lastSyncResult: state?.lastSyncResult,
        lastReadyAt: state?.lastReadyAt,
      };
    }
  }

  async uninitialize(cwd: string, force: boolean, ctx?: UninitContext): Promise<string> {
    const { root, initialized } = resolveCodeGraphRoot(cwd, this.sdk);
    const state = this.projects.get(root);

    if (this.isBusy(state)) {
      if (!force) {
        throw new Error("CodeGraph is currently initializing, indexing, or syncing. Retry later or use --force to wait and remove it.");
      }

      const inFlight: Array<Promise<unknown>> = [];
      if (state?.readyPromise) inFlight.push(state.readyPromise);
      if (state?.syncPromise) inFlight.push(state.syncPromise);
      await Promise.allSettled(inFlight);
    }

    const currentlyInitialized = initialized || this.sdk.isInitialized(root) || Boolean(state?.cg);
    if (!currentlyInitialized) {
      return `CodeGraph is not initialized for ${path.resolve(cwd)}. Nothing to remove.`;
    }

    if (!force) {
      if (!ctx?.hasUI || !ctx.ui?.confirm) {
        throw new Error("Refusing to remove CodeGraph without confirmation. Run /cg:uninit --force to remove it non-interactively.");
      }

      const confirmed = await ctx.ui.confirm(
        "Remove CodeGraph index?",
        `This deletes ${path.join(root, ".codegraph")}. Continue?`,
        { confirmLabel: "Remove", cancelLabel: "Cancel" },
      );

      if (!confirmed) {
        return "CodeGraph uninit cancelled.";
      }
    }

    const cg = state?.cg ?? await this.sdk.CodeGraph.open(root);
    cg.uninitialize();
    this.projects.delete(root);
    return `Removed CodeGraph index from ${root}`;
  }

  async closeAll(): Promise<void> {
    for (const state of this.projects.values()) {
      state.cg?.close();
    }
    this.projects.clear();
  }

  getCachedState(root: string): Pick<ProjectState, "root" | "status" | "lastError" | "lastIndexResult" | "lastSyncResult" | "lastReadyAt"> | undefined {
    const state = this.projects.get(root);
    if (!state) return undefined;
    return {
      root: state.root,
      status: state.status,
      lastError: state.lastError,
      lastIndexResult: state.lastIndexResult,
      lastSyncResult: state.lastSyncResult,
      lastReadyAt: state.lastReadyAt,
    };
  }

  private getOrCreateState(root: string, initialized: boolean): ProjectState {
    let state = this.projects.get(root);
    if (!state) {
      state = {
        root,
        status: initialized ? "not_indexed" : "not_initialized",
      };
      this.projects.set(root, state);
    }
    return state;
  }

  private async ensureReadyInner(
    state: ProjectState,
    initialized: boolean,
    options: ReadyOptions,
  ): Promise<CodeGraphInstance> {
    let cg = state.cg;

    if (!initialized && !cg) {
      state.status = "initializing";
      state.lastError = undefined;
      options.onProgress?.(`CodeGraph: initializing ${state.root}`);
      cg = await this.sdk.CodeGraph.init(state.root, { index: false });
      state.cg = cg;
      await this.indexAllOrThrow(state, cg, options);
    }

    if (!cg) {
      state.lastError = undefined;
      cg = await this.sdk.CodeGraph.open(state.root);
      state.cg = cg;
    }

    const stats = cg.getStats();
    if (stats.fileCount === 0) {
      if (state.zeroIndexBlocked) {
        state.status = "not_indexed";
        state.lastError = state.lastError ?? ZERO_INDEXED_FILES_MESSAGE;
        throw new Error(state.lastError);
      }
      await this.indexAllOrThrow(state, cg, options);
    }

    await this.ensureSynced(state, cg, options);

    state.status = "ready";
    state.lastError = undefined;
    state.lastReadyAt = Date.now();
    return cg;
  }

  private async indexAllOrThrow(
    state: ProjectState,
    cg: CodeGraphInstance,
    options: ReadyOptions,
  ): Promise<void> {
    state.status = "indexing";
    options.onProgress?.(`CodeGraph: indexing ${state.root}`);

    let indexResult: IndexResult | undefined;
    try {
      indexResult = await cg.indexAll({
        signal: options.signal,
        onProgress: progressToMessage(options.onProgress),
      });
      state.lastIndexResult = indexResult;

      if (!indexResult.success) {
        await this.clearPartialIndex(cg);
        throw new Error(formatIndexErrors(indexResult));
      }

      const after = cg.getStats();
      if (after.fileCount === 0) {
        state.status = "not_indexed";
        state.zeroIndexBlocked = true;
        state.lastError = ZERO_INDEXED_FILES_MESSAGE;
        throw new Error(ZERO_INDEXED_FILES_MESSAGE);
      }

      state.zeroIndexBlocked = false;
    } catch (error) {
      if (!indexResult?.success) {
        await this.clearPartialIndex(cg);
      }
      if (state.status !== "not_indexed") {
        state.status = "failed";
      }
      state.lastError = errorToMessage(error);
      throw error;
    }
  }

  private async ensureSynced(
    state: ProjectState,
    cg: CodeGraphInstance,
    options: ReadyOptions,
  ): Promise<void> {
    if (state.syncPromise) return state.syncPromise;

    const changes = cg.getChangedFiles() as ChangedFiles;
    const pending = countChangedFiles(changes);
    if (pending === 0) return;

    state.status = "syncing";
    options.onProgress?.(`CodeGraph: syncing ${pending} changed file(s)`);

    state.syncPromise = cg.sync({
      signal: options.signal,
      onProgress: progressToMessage(options.onProgress),
    }).then((syncResult) => {
      state.lastSyncResult = syncResult;
      if (isLockSkippedSync(syncResult)) {
        state.status = "not_synced";
        state.lastError = LOCK_SKIPPED_SYNC_MESSAGE;
        throw new Error(LOCK_SKIPPED_SYNC_MESSAGE);
      }
    }).catch((error) => {
      if (state.status !== "not_synced") {
        state.status = "failed";
      }
      state.lastError = errorToMessage(error);
      throw error;
    }).finally(() => {
      state.syncPromise = undefined;
    });

    return state.syncPromise;
  }

  private async clearPartialIndex(cg: CodeGraphInstance): Promise<void> {
    try {
      cg.clear();
    } catch {
      // Best-effort cleanup only. The readiness error remains the source of truth.
    }
  }

  private isBusy(state: ProjectState | undefined): boolean {
    return Boolean(
      state &&
      (state.status === "initializing" || state.status === "indexing" || state.status === "syncing") &&
      (state.readyPromise || state.syncPromise),
    );
  }
}

function formatIndexErrors(result: IndexResult): string {
  const errors = result.errors?.map((error) => error.message).filter(Boolean) ?? [];
  return errors.length > 0
    ? `CodeGraph indexing failed: ${errors.join("; ")}`
    : "CodeGraph indexing failed.";
}

function errorToMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function safeCall<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
