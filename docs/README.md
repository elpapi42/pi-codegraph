# pi-codegraph Extension Documentation

`pi-codegraph` is a native Pi extension that gives the agent fresh, local CodeGraph intelligence for the active workspace. Its purpose is to make code exploration cheaper, more accurate, and less repetitive by letting the agent query a maintained semantic index instead of repeatedly scanning files with ad hoc shell commands.

The extension is intentionally thin: it wraps the CodeGraph TypeScript SDK directly. It does **not** shell out to the CodeGraph CLI, start the CodeGraph MCP server, or deep-import private `codegraph/src/*` internals. Pi owns the tool and command surface; CodeGraph owns parsing, indexing, symbol extraction, relationships, file metadata, and task context.

## Intention and purpose

The product goal is **self-healing fresh code intelligence for the active Pi workspace**.

When an agent asks a code-navigation question, the useful behavior is not merely “run a search.” The useful behavior is:

1. Know which project the current Pi session is working in.
2. Ensure the CodeGraph index for that project exists.
3. Ensure the index has source files.
4. Ensure changed files have been synced.
5. Refuse to answer if freshness is unproven.
6. Return bounded, model-friendly Markdown that helps the agent continue work.

That is the core contract of this extension. The agent should be able to call `search`, `files`, `node`, `callers`, `callees`, `impact`, or `context` without first asking the user to initialize or sync CodeGraph manually. The first relevant tool call may initialize and index the project, but subsequent calls should reuse the same cached CodeGraph instance and avoid redundant work.

This extension replaces the older CodeMapper-style mental model with CodeGraph’s richer semantic model. It is not a strict compatibility layer for old `map/search/outline/expand/path` JSON-array tools. It exposes a Pi-native CodeGraph surface with simple tool names and Markdown results.

## Non-goals

`pi-codegraph` deliberately avoids several tempting shortcuts:

- It does not expose `projectPath` on tools. Exploration is limited to the active Pi path.
- It does not register `/cg:init`; tools initialize/index/sync automatically when needed.
- It does not run full readiness from `session_start`; startup must not unexpectedly mutate or index the workspace.
- It does not register `explore` in v1. `explore` needs a complete source-slicing implementation before it is safe to expose.
- It does not shell out to `codegraph` CLI commands.
- It does not proxy or embed the CodeGraph MCP server.
- It does not import private CodeGraph source files from `codegraph/src/*`.

## Active-path-only philosophy

All behavior starts from Pi’s active working directory, `ctx.cwd`. This is the product boundary.

There is no per-tool project selector and no cross-project query mode. If Pi is running in one workspace, CodeGraph tools should answer about that workspace only. This prevents accidental indexing or querying of unrelated repositories and keeps the agent’s mental model simple: “the tools see what this Pi session is working on.”

Root resolution follows two rules:

1. Walk upward from `ctx.cwd` to find the nearest initialized CodeGraph root containing `.codegraph/codegraph.db`.
2. If no initialized root exists above `ctx.cwd`, initialize exactly at `ctx.cwd` when the first CodeGraph tool needs readiness.

The runtime does not guess git roots. If the user starts Pi in a subdirectory with no parent `.codegraph/`, the extension treats that subdirectory as the active project root. This is intentional: Pi’s active path is the authority.

## Current dependency model

The current implementation depends on the local CodeGraph checkout inside this repository:

```json
{
  "dependencies": {
    "@colbymchenry/codegraph": "file:./codegraph"
  }
}
```

This is necessary because the published `@colbymchenry/codegraph` package checked during implementation was a CLI launcher shim, not a stable importable SDK package. The local `./codegraph` package exports the SDK surface this extension needs from the package root.

Because the dependency is a local file dependency, setup requires the local CodeGraph package to exist and be built before `pi-codegraph` can typecheck or run.

```bash
cd codegraph
npm install
npm run build
cd ..
npm install
```

The CodeGraph build step is not optional. CodeGraph’s package root points at `dist/`, and the build copies runtime assets such as `schema.sql` and tree-sitter WASM grammars. If those files are missing, SDK imports or indexing can fail even if TypeScript source exists.

The extension imports CodeGraph only through `src/codegraph-sdk.ts`. That adapter is the migration seam for a future npm SDK release.

## Package and extension shape

`package.json` declares the Pi extension entry:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

The entrypoint constructs one runtime and registers commands/tools:

- `src/index.ts` — Pi extension default export and lifecycle wiring.
- `src/runtime.ts` — root resolution, CodeGraph open/init/index/sync, status, uninit, cache, concurrency.
- `src/commands.ts` — `/cg:status` and `/cg:uninit`.
- `src/tools.ts` — tool schemas, registration wrapper, handlers, and Markdown formatting.
- `src/symbols.ts` — symbol lookup/disambiguation helpers adapted from CodeGraph MCP behavior.
- `src/result.ts` — Pi text result envelope and truncation.
- `src/validate.ts` — parameter validation and clamping.
- `src/paths.ts` — active-project path filtering and glob helpers.
- `src/codegraph-sdk.ts` — package-root SDK adapter.

The extension registers `session_shutdown` cleanup only. It intentionally does not register `session_start` readiness, because readiness can create `.codegraph/`, run a full index, or sync files.

## Readiness lifecycle

Every registered CodeGraph tool goes through the same readiness wrapper before its handler runs.

```text
tool execute
  -> runtime.ensureReady(ctx, { signal, onProgress })
      -> resolve root from ctx.cwd
      -> init if no root exists
      -> index if new or empty
      -> check changed files
      -> sync if needed
      -> fail if freshness is unproven
      -> return ready CodeGraph instance
  -> tool-specific SDK query
  -> bounded Markdown result envelope
```

### Not initialized

If no `.codegraph/codegraph.db` exists at or above `ctx.cwd`, the runtime calls:

```ts
CodeGraph.init(root, { index: false })
```

It then explicitly calls `indexAll()`. The explicit two-step is important: `CodeGraph.init(..., { index: true })` would hide the `IndexResult`, but `/cg:status` needs the last index result for observability.

### Initialized but empty

If a CodeGraph database exists but `getStats().fileCount === 0`, the runtime runs `indexAll()`.

If `indexAll()` completes and the file count is still zero, readiness fails with a hard error. The runtime records `not_indexed`, stores the last index result, and blocks repeated full-index retries in the same process with a `zeroIndexBlocked` flag. This prevents every tool call from repeatedly scanning an unsupported or empty project.

The tradeoff is that if supported source files are added after a zero-file result, the current process may still refuse to retry until the session restarts or the index is removed/recreated. This is accepted for v1 to prevent endless expensive retries.

### Indexed but changed

If `getChangedFiles()` reports added, modified, or removed files, the runtime calls `sync()` before running the tool query.

`getChangedFiles()` is read-only. `sync()` mutates the CodeGraph database: removed files are deleted, changed files are reparsed, content hashes are updated, references are resolved, and maintenance may run.

### Lock-skipped sync

CodeGraph can return a zeroed `SyncResult` if another process holds the index lock. If pending changes were detected before sync and sync returns the zeroed result, the extension treats freshness as unproven. It records `not_synced`, returns `isError: true`, and does not query stale data.

### Cancellation and failures

If initialization, indexing, syncing, or cancellation fails, the tool returns an error result and does not run the query. Failed or cancelled full-index attempts trigger best-effort `cg.clear()` cleanup to reduce partial-index risk.

Rejected readiness promises are cleared so later calls can retry when appropriate.

## Runtime state model

The runtime maintains one state object per resolved root. Important fields include:

- `cg` — cached CodeGraph instance.
- `status` — current readiness state.
- `readyPromise` — in-flight initialization/index/readiness work.
- `syncPromise` — in-flight sync work.
- `lastError` — last readiness or runtime error.
- `lastIndexResult` — latest full-index result.
- `lastSyncResult` — latest sync result.
- `lastReadyAt` — timestamp of last successful readiness.
- `zeroIndexBlocked` — prevents repeated zero-file indexing loops.

Supported status values are:

- `not_initialized`
- `not_indexed`
- `not_synced`
- `ready`
- `initializing`
- `indexing`
- `syncing`
- `failed`

Concurrency is per root. If several tools run at the same time for the same root, they await the same readiness or sync promise rather than starting duplicate CodeGraph writes.

## Commands

### `/cg:status`

`/cg:status` is read-only observability. It does not initialize, index, or sync.

It reports:

- active path searched from `ctx.cwd`
- resolved CodeGraph root
- status
- initialization state
- file/node/edge counts when available
- backend and journal mode when available
- pending changed-file counts
- last index result summary
- last sync result summary
- last readiness timestamp
- last error

Use `/cg:status` when a tool fails readiness, when the first tool call appears expensive, or when you need to confirm which root Pi is using.

### `/cg:uninit [--force]`

`/cg:uninit` removes the `.codegraph/` directory for the active resolved root.

Behavior:

- If no initialized root exists, it reports that there is nothing to remove.
- Without `--force`, it asks for UI confirmation when UI is available.
- Without UI and without `--force`, it refuses destructive removal.
- If initialization/indexing/syncing is in progress, it refuses unless `--force` is used.
- With `--force`, it bypasses confirmation and waits for in-flight work to settle before uninitializing.

`--force` is not a hard cancellation mechanism. It means “do not ask for confirmation.” If CodeGraph work is hung, forced uninit may wait.

There is no `/cg:init`. Tool calls self-heal by initializing, indexing, and syncing as needed.

## Tools

All tool outputs are Markdown text in Pi’s standard text result envelope:

```ts
{
  content: [{ type: "text", text }],
  isError?: boolean,
  details: {
    tool?: string,
    projectRoot?: string,
    value?: string,
    error?: string,
    truncated?: boolean
  }
}
```

Outputs are bounded to roughly 50 KB. Both success and error paths are truncated. The extension avoids old MCP tool names such as `codegraph_search` in Pi-facing guidance.

### `search`

Search indexed symbols by name or partial name.

Parameters:

- `query` — required symbol/name fragment.
- `kind` — optional filter: `function`, `method`, `class`, `interface`, `type`, `variable`, `route`, `component`.
- `limit` — optional result count, default 10, clamped 1..100.

The public kind value `type` is mapped to CodeGraph’s SDK node kind `type_alias` so TypeScript type aliases are found while keeping the Pi schema user-friendly.

Use `search` when you know a symbol, class, route, component, or concept name and need candidate definitions quickly.

### `files`

List indexed files in the active project.

Parameters:

- `path` — optional active-project-relative prefix filter.
- `pattern` — optional glob-like filter, such as `**/*.ts`.
- `format` — `tree`, `flat`, or `grouped`; default `tree`.
- `includeMetadata` — include language/node-count metadata; default true.
- `maxDepth` — optional tree depth, clamped 1..20.

`files.path` is not a project selector. It only filters indexed file records within the active CodeGraph root. The tool does not read arbitrary filesystem paths.

Use `files` to understand project shape after CodeGraph has indexed it.

### `node`

Inspect one symbol.

Parameters:

- `symbol` — required symbol name or qualified-ish name.
- `includeCode` — optional, default false.

Without code, `node` returns metadata such as kind, location, signature, and docstring when available.

With `includeCode=true`, leaf symbols return source from `cg.getCode(node.id)`. Container nodes return a structural member outline instead of full container bodies. Container kinds are:

- `class`
- `interface`
- `struct`
- `trait`
- `protocol`
- `module`
- `enum`
- `namespace`
- `component`
- `file`

Use `node` after `search` when you need details or source for one candidate.

### `callers`

Find incoming callers/references/importers for a symbol.

Parameters:

- `symbol` — required.
- `limit` — optional, default 20, clamped 1..100.

The tool resolves all matching symbols, gathers callers for each match, de-duplicates by node id, sorts locations, and returns a flat Markdown list. Missing symbols are normal non-error results.

Use `callers` to answer “who uses this?”

### `callees`

Find outgoing calls/references/imports from a symbol.

Parameters are the same as `callers`.

Use `callees` to answer “what does this call or depend on?”

### `impact`

Analyze reverse dependency impact radius for changing a symbol.

Parameters:

- `symbol` — required.
- `depth` — optional, default 2, clamped 1..10.

`impact` is not just callers plus callees. It uses CodeGraph’s reverse dependency radius and groups affected symbols by file.

Use `impact` before refactors or behavior changes where the blast radius matters.

### `context`

Build broad task context for a bug, feature, or architecture task.

Parameters:

- `task` — required natural-language task description.
- `maxNodes` — optional, default 20, clamped 1..200.
- `includeCode` — optional, default true.

The tool calls:

```ts
cg.buildContext(task, { maxNodes, includeCode, format: "markdown" })
```

It handles both string and object-with-`summary` return shapes. The earlier product-opinionated feature reminder heuristic is intentionally a no-op in v1 to avoid noisy model behavior.

Use `context` when the task is broad and you want CodeGraph to select relevant code areas.

## Deferred `explore`

CodeGraph’s MCP server has an `explore` concept that returns related symbols, selected source slices, and relationship maps in one bounded call. That tool is intentionally deferred from this extension’s v1.

Reasons:

- It reads source files directly.
- It requires root-containment safety checks.
- It clusters nodes by file and line proximity.
- It has adaptive output budgets based on project size.
- It formats relationship maps and source snippets.
- It is significantly more complex than the other tools.

Do not register a placeholder `explore` tool. Add it only when the full implementation is ready, including tests for source read safety, output budgets, and no stale MCP-name guidance.

## Output and error behavior

All tool outputs are bounded Markdown. The default output budget is roughly 50 KB. Truncated output includes an explicit marker:

```text
... (output truncated)
```

Both normal and error results are bounded. Error results use `isError: true` and store bounded text in `details.error` and `details.value`; they do not preserve unbounded raw SDK errors in the result envelope.

Missing symbols are not infrastructure errors. For `node`, `callers`, `callees`, and `impact`, a missing symbol returns a normal Markdown message explaining that no matching symbol was found.

Readiness failures are infrastructure errors. If freshness is not proven, the tool returns `isError: true` and does not query.

## Symbol resolution behavior

Symbol tools use helper logic adapted from CodeGraph MCP behavior instead of naïvely taking the first fuzzy result.

The resolver handles:

- exact name matches
- simple file-node basename matches
- qualified-ish names using `.`, `/`, and `::`
- Rust-style prefixes such as `crate`, `self`, and `super`
- suffix matching for qualified names
- fallback search by last qualifier when full-text search strips separators
- ambiguity notes when multiple symbols match

This matters because `foo::bar`, `src/auth/login`, and `Class.method` style lookups can otherwise degrade into unrelated fuzzy matches.

## Testing and validation

Development validation commands:

```bash
npm run typecheck
npm run test --loglevel verbose
```

The current test suite uses `tsx --test` and covers:

- package/extension registration
- command registration: `/cg:status`, `/cg:uninit`, no `/cg:init`
- tool registration: seven MVP tools, no `explore`
- active-path-only schemas with no `projectPath`
- root discovery from subdirectories
- initialization at `ctx.cwd`
- clean-ready path
- empty-index indexing
- pending-change sync
- concurrent readiness serialization
- indexing failure
- cancellation
- zero-file hard failure
- no endless zero-file retry
- lock-skipped sync failure
- rejected promise retry
- uninit confirmation, force, non-interactive refusal, and in-flight races
- real CodeGraph fixture coverage for `search` and `files`
- real type-alias search kind mapping (`type` -> `type_alias`)
- representative output for `node`, `callers`, `callees`, `impact`, and `context`
- bounded success and error output
- no MCP-style `codegraph_*` names in registered metadata

The suite intentionally uses fakes for rare runtime failure states such as lock-skipped sync and mid-index cancellation. It uses real temporary CodeGraph projects for the most important SDK/package/assets path: indexing and querying `search`/`files`.

## Operational limitations and tradeoffs

### Local dependency is not release-packaging-safe

`file:./codegraph` plus an ignored `codegraph/` directory is suitable for local development, but it is not a self-contained package distribution model. A fresh checkout or CI environment must provide and build `./codegraph` before installing `pi-codegraph`.

Before publishing or sharing this extension broadly, choose one of these paths:

- migrate to a real npm SDK package when available;
- make `codegraph/` a submodule or workspace dependency;
- keep it as an explicit local prerequisite and document setup carefully.

### First tool call can be slow

The first CodeGraph tool call in an uninitialized project can run a full index. Large repositories can take longer than a typical tool query. Progress updates are sent through Pi tool updates, but the call is still blocking from the tool’s perspective.

### Zero-file blocking is process-lifetime behavior

After a zero-file index result, the runtime blocks repeated reindex attempts in the same process. This prevents expensive loops, but it also means adding supported files after the failure may require restarting Pi or removing/recreating the index before the tool retries.

### Crash recovery is best effort

The runtime attempts `cg.clear()` after failed or cancelled full indexes. It cannot fully protect against process death or SIGKILL during indexing. If stronger crash-recovery guarantees are needed later, add a persisted “full index completed” marker or a forced rebuild path.

### Git subrepo sync limitation is accepted

The extension does not work around CodeGraph’s known git fast-path limitation with nested non-submodule git repositories. The accepted v1 choice is to use CodeGraph’s public `getChangedFiles()` and `sync()` behavior as-is rather than adding a heavy extension-side full-reindex workaround.

### Source exposure is intentional

`node(includeCode=true)` and `context(includeCode=true)` can place local source code into model context. This is the purpose of the extension, but it means the trust boundary is the active Pi workspace. There is no per-call source disclosure prompt.

## Future npm SDK migration

When `@colbymchenry/codegraph` publishes an importable SDK package, migration should be localized:

1. Replace the local file dependency:

   ```diff
   - "@colbymchenry/codegraph": "file:./codegraph"
   + "@colbymchenry/codegraph": "^<sdk-version>"
   ```

2. Run `npm install`.
3. Check `src/codegraph-sdk.ts` for export-name or CommonJS/ESM shape differences.
4. Run `npm run typecheck`.
5. Run `npm run test --loglevel verbose`.
6. Run OpenSpec validation if the change is still governed by an active spec.

Do not fix SDK export differences by deep-importing private CodeGraph source files. Keep the adapter as the only package-boundary seam.

## Future work

High-value follow-ups:

- Implement `explore` with full source-slicing, relationship-map, containment, and adaptive-budget tests.
- Add real CodeGraph fixture tests for `callers`, `callees`, and `impact` relationship directionality.
- Add real `node(includeCode=true)` fixture tests for leaf source and container outline behavior.
- Improve zero-file recovery with an explicit reset trigger when new supported files appear.
- Add a persisted full-index completion marker if crash recovery becomes important.
- Decide the long-term dependency model before packaging or CI: npm SDK, submodule/workspace, or explicit local prerequisite.
