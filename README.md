# pi-codegraph

`pi-codegraph` is a native [Pi](https://github.com/earendil-works/pi-coding-agent) extension that gives agents fresh, local [CodeGraph](https://github.com/colbymchenry/codegraph)-powered code intelligence for the active workspace.

It is built for the common agent workflow: before answering code-navigation questions, the agent should know the current project, make sure the semantic index exists, sync changed files, and only then return useful context. `pi-codegraph` handles that readiness automatically on every tool call, so users do not need to remember separate init/sync commands.

## What it provides

- A Pi-native extension surface over the CodeGraph TypeScript SDK.
- Active-workspace-only exploration from Pi's current `ctx.cwd`.
- Automatic CodeGraph initialization, indexing, and syncing before tool queries.
- Seven MVP tools: `search`, `context`, `callers`, `callees`, `impact`, `node`, and `files`.
- Two management commands: `/cg:status` and `/cg:uninit`.
- Bounded Markdown results designed for agent context, not terminal UI output.

It does **not** shell out to the CodeGraph CLI, start the CodeGraph MCP server, import private `codegraph/src/*` internals, expose `projectPath`, register `/cg:init`, or register `explore` yet.

## Current status

This project is currently local-development oriented. The extension is implemented and tested, but it depends on a local CodeGraph checkout at `./codegraph` because the published `@colbymchenry/codegraph` package available during implementation was a CLI launcher shim rather than a stable importable SDK package.

That means a fresh clone must provide and build `./codegraph` before `pi-codegraph` can be installed or run. Once CodeGraph publishes an importable SDK package, this project should migrate from `file:./codegraph` to a normal semver dependency.

## Prerequisites

- Node.js `>=20 <25`.
- Pi installed locally.
- A local CodeGraph checkout at `./codegraph`.
- CodeGraph built before installing or typechecking this extension.

## Quick start for development

From the repository root:

```bash
cd codegraph
npm install
npm run build
cd ..
npm install
npm run typecheck
npm run test --loglevel verbose
```

The CodeGraph build step is required because the SDK package root points at `dist/`, and the build copies runtime assets such as `schema.sql` and tree-sitter WASM grammars.

## Loading the extension in Pi

During development, load the extension from this repository with Pi's extension loading mechanism, for example by using a local extension path or Pi's `-e` option if available in your workflow:

```bash
pi -e /absolute/path/to/pi-codegraph/src/index.ts
```

For project or user-level installation, configure Pi to load this package as an extension. The package manifest declares:

```json
{
  "pi": {
    "extensions": ["./src/index.ts"]
  }
}
```

Because this package currently depends on `file:./codegraph`, it is not yet suitable as a self-contained npm install unless the local CodeGraph checkout is present in the same layout.

## Active-path-only behavior

All tools operate on Pi's active working directory, `ctx.cwd`. There is no `projectPath` parameter and no cross-project query mode.

Before every tool query, the runtime:

1. Walks upward from `ctx.cwd` for the nearest `.codegraph/codegraph.db`.
2. Opens that CodeGraph root if it exists.
3. Initializes CodeGraph exactly at `ctx.cwd` if no parent root exists.
4. Runs `indexAll()` if the index is empty.
5. Checks for changed files.
6. Runs `sync()` if changes are pending.
7. Fails closed if freshness is unproven.
8. Runs the requested tool query only after readiness succeeds.

This keeps the agent's mental model simple: the tools see the active Pi workspace, not arbitrary paths supplied through tool arguments.

## Tools

### `search`

Search indexed symbols by name or partial name. Optional filters include `kind` and `limit`. The public `kind: "type"` option maps to CodeGraph's internal `type_alias` node kind.

Use it to find likely entry points before reading files.

### `files`

List indexed files in the active project. Supports:

- `format`: `tree`, `flat`, or `grouped`.
- `path`: intra-project prefix filter.
- `pattern`: glob-like filter over indexed paths.
- `includeMetadata`.
- `maxDepth` for tree output.

`files.path` is not a project selector; it only filters files inside the active CodeGraph root.

### `node`

Inspect one symbol. By default it returns metadata such as name, kind, location, signature, and docstring when available.

With `includeCode: true`, leaf symbols return fenced source code. Container symbols such as classes, interfaces, modules, enums, namespaces, components, and files return a compact structural outline instead of dumping full container bodies.

### `callers`

Find incoming callers or references for a symbol. The tool resolves matching symbols, aggregates across matches, de-duplicates by node ID, and returns Markdown locations.

Missing symbols are normal non-error results.

### `callees`

Find outgoing calls or references from a symbol. Behavior mirrors `callers`, but follows outgoing relationships.

### `impact`

Analyze reverse dependency impact radius for a symbol. The tool resolves matching symbols, calls CodeGraph impact traversal, and groups affected symbols by file.

### `context`

Build broad task context for the active project using CodeGraph's context builder. It accepts a natural-language task and returns Markdown context. The v1 implementation intentionally does not add product-opinionated reminder text beyond CodeGraph's own output.

### Deferred: `explore`

`explore` is intentionally not registered in v1. It needs safe source reads, containment checks, line slicing, relationship maps, clustering, and adaptive output budgets before it should be exposed. Until that complete implementation exists, leaving it unregistered is safer than shipping a partial placeholder.

## Commands

### `/cg:status`

Read-only status for the active path. It reports information such as:

- active path,
- resolved CodeGraph root,
- state,
- file/node/edge counts,
- pending changed files,
- last index/sync result,
- last readiness error.

It does not initialize, index, or sync.

### `/cg:uninit [--force]`

Remove the `.codegraph/` index resolved from the active path.

- Without `--force`, it asks for confirmation when UI is available.
- Without UI and without `--force`, it refuses destructive removal.
- During active readiness work, it refuses unless `--force` is provided.
- With `--force`, it waits for in-flight readiness work to settle and then removes the index.
- `--force` bypasses confirmation; it does not hard-cancel CodeGraph operations.

There is no `/cg:init`. Normal tool calls initialize, index, and sync automatically.

## Failure and output behavior

Tool outputs are Pi text-result envelopes containing bounded Markdown. General output is capped around 50 KB and includes an explicit truncation marker when shortened. Error results are also bounded.

Readiness failures return `isError: true` and do not run the query. This includes:

- initialization failure,
- indexing failure,
- cancellation,
- zero indexed files,
- pending changes with lock-skipped sync,
- unexpected SDK/tool infrastructure errors.

A zero-file index result is treated as a hard not-indexed state and will not retry endlessly in the same process. If you add supported source files after hitting that state, restart Pi or remove/recreate `.codegraph/` to force a fresh attempt.

## Project structure

```text
src/index.ts          Extension entrypoint and Pi registration
src/runtime.ts        CodeGraph root resolution, readiness, cache, sync, uninit
src/commands.ts       /cg:status and /cg:uninit command wiring
src/tools.ts          Tool schemas, registration wrapper, and handlers
src/symbols.ts        Symbol resolution helpers ported from CodeGraph MCP behavior
src/result.ts         Pi text result envelope and truncation helpers
src/paths.ts          Active-project path and glob helpers
src/validate.ts       Shared parameter validation helpers
src/codegraph-sdk.ts  Package-root CodeGraph SDK adapter and migration seam
test/                 Runtime, command, registration, and tool tests
docs/README.md        Detailed design and operational documentation
```

The main design seam is `src/codegraph-sdk.ts`. Runtime and tools should import CodeGraph through that adapter, not directly from package internals.

## Validation

Run:

```bash
npm run typecheck
npm run test --loglevel verbose
```

The test suite covers:

- extension registration,
- absence of `projectPath`, `/cg:init`, startup readiness, and `explore`,
- runtime root resolution and readiness transitions,
- failure paths such as zero-file indexing and lock-skipped sync,
- `/cg:status` and `/cg:uninit` behavior,
- real CodeGraph fixture tests for `search` and `files`,
- representative symbol/context tool outputs,
- truncation and MCP-name leak prevention.

## Known limitations

- The local `file:./codegraph` dependency is not a release-grade packaging model.
- First tool call in a large unindexed repository may take time while CodeGraph indexes.
- Crash recovery after process death mid-index is best effort; there is no persisted “full index completed” marker yet.
- Nested git subrepo sync limitations are accepted as-is for v1.
- `node(includeCode: true)` and `context(includeCode: true)` intentionally expose local source code to the agent context.
- Real fixture coverage currently focuses on `search` and `files`; deeper traversal tools have representative tests but not exhaustive real relationship fixtures.

## Contributing and future work

High-value follow-ups:

- Migrate to a published importable CodeGraph SDK package when available.
- Add real relationship fixture tests for `callers`, `callees`, and `impact`.
- Add real `context` fixture coverage if CodeGraph context behavior stabilizes enough for deterministic assertions.
- Implement and register `explore` only after safe source slicing, relationship maps, and adaptive budgets are complete.
- Consider a persisted full-index completion marker for stronger crash recovery.
- Split `src/tools.ts` before adding more complex tools.

## More documentation

- Detailed extension documentation: [`docs/README.md`](docs/README.md)
