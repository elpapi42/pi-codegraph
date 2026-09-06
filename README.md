# pi-codegraph

`pi-codegraph` is a native [Pi](https://github.com/earendil-works/pi-coding-agent) extension that gives agents fresh, local [CodeGraph](https://github.com/colbymchenry/codegraph)-powered code intelligence for the active workspace.

It is built for the common agent workflow: before answering code-navigation questions, the agent should know the current project, make sure the semantic index exists, sync changed files, and only then return useful context. `pi-codegraph` handles that readiness automatically on every tool call, so users do not need to remember separate init/sync commands.

## What it provides

- A Pi-native extension surface over the CodeGraph TypeScript SDK.
- Active-workspace-only exploration from Pi's current `ctx.cwd`.
- Automatic CodeGraph initialization, indexing, and syncing before tool queries.
- Ten code-intelligence tools: experimental `explore_code` and `analyze_code`, plus `search`, `context`, `explore`, `callers`, `callees`, `impact`, `node`, and `files`.
- Two management commands: `/cg:status` and `/cg:uninit`.
- Bounded Markdown results designed for agent context, not terminal UI output.

It does not start the CodeGraph MCP server, import private `codegraph/src/*` internals, expose `projectPath`, or register `/cg:init`.

## Current status

This project now depends on the published `@colbymchenry/codegraph` npm SDK package rather than a local `./codegraph` clone. The extension remains local-development oriented because it is a private Pi package, but a fresh clone no longer needs the CodeGraph repository initialized or built just to install, typecheck, or run the extension.

### Experimental `explore_code`

`explore_code` is an experimental single-call view of indexed code. It accepts a natural-language question or symbol and file names, then returns CodeGraph 1.6 source, relationships, call paths, and blast-radius output. It runs the extension-local public `codegraph` CLI after this extension has prepared the active project index. The eight existing tools remain available during this experiment.

The CLI subprocess has startup cost and does not retain upstream MCP exploration-session deduplication between calls. It operates only on the active CodeGraph root. Cancellation is best effort because the package shim can start a descendant process. Use read for known files and filesystem or text-search commands such as `rg` or `find` for Markdown, general configuration, generated runtime wiring, and exhaustive file inventories.

### Experimental `analyze_code`

`analyze_code` is an experimental automatic static-graph view for one or two code symbols. It has a required `target` selector and an optional `related` selector. Each selector contains `symbol` and may include exact project-relative `file` and definition `line` values when a name is ambiguous.

For one resolved symbol, it returns direct callers, direct callees, residual bounded impact, and test-file paths found in that graph neighborhood. For two resolved symbols, it returns both neighborhoods and a directed graph path in each direction when available. It never returns full source. It chooses graph operations and bounds internally, so callers do not select an operation, depth, limit, or direction.

If a symbol is partial, missing, or ambiguous, the tool returns up to 20 selector-ready candidates and performs no traversal. It labels definition candidates separately from import and file nodes, and ranks definitions first. Target selection uses exact matching within a bounded candidate search. Relationships are static indexed evidence that can omit dynamic, generated, unresolved, and unindexed behavior and can contain ambiguous or incorrect resolutions. They are not runtime proof. Existing narrow tools remain available during this experiment.

### CodeGraph 1.6 upgrade

The runtime still initializes empty projects and syncs ordinary changes automatically. After upgrading an existing project index from an older CodeGraph engine, rebuild it once so CodeGraph 1.6 applies its newer extraction and derived graph behavior:

```bash
cd /home/elpapi/.pi/agent/extensions/pi-codegraph
npx --no-install codegraph index /path/to/project
```

This is a one-time upgrade action, not a normal startup step. If you restore an older CodeGraph version, rebuild that project's index with the restored version because downgrade migration is not supported.

## Prerequisites

- Node.js `>=22.19.0 <25`.
- Pi installed locally.
- npm able to install the platform bundle required by `@colbymchenry/codegraph`.

## Quick start for development

From the repository root:

```bash
npm install
npm run typecheck
npm test
```

If `@colbymchenry/codegraph` fails to load at runtime, verify that npm installed the matching platform package for your machine (for example `@colbymchenry/codegraph-linux-x64`).

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

This package now installs CodeGraph from npm, so it no longer requires the local `./codegraph` repository to exist in the same layout.

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

### `analyze_code`

Analyze one or two selected code symbols without selecting an operation. Use it before changing a known symbol when static callers, callees, bounded impact, or a graph connection matter.

Inputs:

- `target`: required `{ symbol, file?, line? }` selector.
- `related`: optional selector. When present, the output includes directed graph paths in both directions when they exist.

A selector with one exact match in the bounded candidate search runs analysis. A partial, missing, or ambiguous selector returns candidates with exact `symbol`, `file`, and `line` values for a corrected call. File selectors must be exact safe project-relative code paths. Line selectors must be exact positive definition start lines.

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

### `explore`

Return source for several related symbols grouped by file, plus a relationship map, in one capped call. Use it after `context` when you need to inspect actual source for multiple related symbols, or when a flow spans several files and many separate `node`/`read` calls would be wasteful.

Inputs:

- `query`: compact symbol names, file names, or short code terms such as `AuthService loginUser createSession`; use `context` first for broad natural-language questions and `search` first if you need relevant names.
- `maxFiles`: optional cap on files to include; defaults adaptively by project size and is clamped `1..20`.

`explore` reads source files directly after validating indexed paths stay inside the active project root. Output is line-numbered by default, uses per-file and total adaptive budgets, and may include trimmed sections with guidance to use `node` or `read` for exact full-source detail.

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
src/analyze-code.ts   Experimental operation-free static graph analysis
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
- absence of `projectPath`, `/cg:init`, and startup readiness,
- runtime root resolution and readiness transitions,
- failure paths such as zero-file indexing and lock-skipped sync,
- `/cg:status` and `/cg:uninit` behavior,
- real CodeGraph fixture tests for `search`, `files`, and one- and two-symbol `analyze_code`,
- ambiguity, strict selector, graph-direction, truncation, and static-analysis output checks,
- representative symbol/context/explore tool outputs,
- truncation and MCP-name leak prevention.

## Known limitations

- First tool call in a large unindexed repository may take time while CodeGraph indexes.
- Crash recovery after process death mid-index is best effort; there is no persisted “full index completed” marker yet.
- Nested git subrepo sync limitations are accepted as-is for v1.
- `node(includeCode: true)`, `context(includeCode: true)`, and `explore` intentionally expose local source code to the agent context.
- Real fixture coverage currently focuses on `search` and `files`; deeper traversal and explore behavior have representative tests but not exhaustive real relationship fixtures.

## Contributing and future work

High-value follow-ups:

- Add real relationship fixture tests for `callers`, `callees`, and `impact`.
- Add real `context` fixture coverage if CodeGraph context behavior stabilizes enough for deterministic assertions.
- Add real relationship fixture tests for `explore` once CodeGraph relationship extraction is deterministic enough for stable assertions.
- Consider a persisted full-index completion marker for stronger crash recovery.
- Split more tool implementations out of `src/tools.ts` if future tools add comparable complexity.

## More documentation

- Detailed extension documentation: [`docs/README.md`](docs/README.md)
