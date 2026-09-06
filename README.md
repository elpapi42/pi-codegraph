# pi-codegraph

`pi-codegraph` is a local [Pi](https://github.com/earendil-works/pi-coding-agent) extension for fresh CodeGraph intelligence in Pi's active workspace.

It automatically finds or creates the active CodeGraph root, indexes an empty project, and synchronizes changed files before each query. It exposes exactly two code-navigation tools and two management commands:

- `explore_code`
- `analyze_code`
- `/cg:status`
- `/cg:uninit`

The extension operates only on Pi's active `ctx.cwd`. It has no `projectPath` parameter, does not start an MCP server, and does not import CodeGraph private modules.

## Tools

### `explore_code`

Use `explore_code` to understand indexed-code behavior and retrieve ranked source context. It returns current line-numbered source, ranked relationships, call paths, and blast-radius leads.

Its `query` is free-form. Use one of these patterns:

- Behavior question: `how does login create and validate sessions`
- Focused symbols: `AuthService loginUser createSession`
- Exact path plus symbols: `src/auth/session.ts createSession refreshSession`

These are query patterns, not modes or formal syntax. Include exact project-relative paths and symbols when known. Results are ranked and non-exhaustive. Broad questions can be noisy in multi-repository or duplicate-code indexes, so verify every returned file path before relying on it.

`maxFiles` is optional. Omit it for CodeGraph's adaptive result size, or set it from 1 through 20.

`explore_code` runs the public CodeGraph 1.6 CLI through the installed package shim after this extension prepares the active index. The subprocess has startup cost and no MCP exploration-session reuse. Cancellation is best effort because the shim can start a descendant process.

### `analyze_code`

Use `analyze_code` for bounded static relationships, impact, graph-neighborhood tests, and a graph connection between one or two known symbols. It does not return source.

```ts
analyze_code({
  target: { symbol: "runExploreCode", file: "src/explore-code.ts", line: 42 },
  related: { symbol: "registerTools", file: "src/tools.ts", line: 116 },
})
```

With `target` only, it returns incoming and outgoing relationships, wider impact, and test files found in the target's graph neighborhood. With `related`, it resolves both selectors before traversal, returns the same neighborhood for each, then returns graph paths in both directions.

Each selector has a required `symbol` and optional exact project-relative `file` plus definition `line`. When `file` is set, resolution occurs only inside that file. Pass file and line from `explore_code` or returned candidates whenever available. A partial, missing, or ambiguous selector returns up to 20 selector-ready candidates and performs no traversal.

Target selection uses a bounded candidate search unless `file` is supplied. Relationships and paths are static indexed evidence. They can omit dynamic, generated, unresolved, or unindexed behavior and can contain ambiguous or incorrect resolutions. They are not runtime proof.

## Filesystem boundary

CodeGraph indexes code. Use `read`, `rg`, or `find` for known files, Markdown, configuration, generated runtime wiring, and exact file inventories.

## Readiness and commands

Before each tool query, the runtime:

1. Finds the nearest `.codegraph/codegraph.db` above `ctx.cwd`.
2. Initializes exactly at `ctx.cwd` if no root exists.
3. Indexes a new or empty project.
4. Synchronizes changed files.
5. Fails closed if freshness is unproven.

`/cg:status` reports active path, root, readiness state, graph counts, pending changes, and recent errors without mutating the index.

`/cg:uninit [--force]` removes the active `.codegraph/` directory. Without `--force`, it requires UI confirmation and refuses non-interactive removal. It waits for active readiness work when forced.

There is no `/cg:init`. Tool calls initialize, index, and synchronize automatically.

## CodeGraph 1.6 upgrade

This package uses the published `@colbymchenry/codegraph` 1.6 SDK. After upgrading an existing index from an older engine, rebuild it once:

```bash
npx --no-install codegraph index /path/to/project
```

If you restore an older CodeGraph version, rebuild that index with the restored version. Downgrade migration is not supported.

## Development

Requirements:

- Node.js `>=22.19.0 <25`
- Pi installed locally
- The platform bundle for `@colbymchenry/codegraph`

Run:

```bash
npm install
npm run typecheck
npm test
npm pack --dry-run
```

The test suite covers two-tool registration, active-path-only schemas, automatic readiness, command behavior, real-index `explore_code`, one- and two-selector `analyze_code`, ambiguity and file-local selection, graph-path direction, bounded output, and retained metadata.

## Project structure

```text
src/index.ts          Extension entrypoint and Pi lifecycle wiring
src/runtime.ts        Root resolution, readiness, sync, status, and uninit
src/commands.ts       /cg:status and /cg:uninit
src/tools.ts          Two tool schemas, registration, rendering, and results
src/explore-code.ts   CLI-backed CodeGraph 1.6 exploration
src/analyze-code.ts   Operation-free static graph analysis
src/symbols.ts        Exact selector matching support
src/validate.ts       Retained input validation helpers
src/codegraph-sdk.ts  Public SDK adapter
test/                 Runtime, command, registration, and tool tests
docs/README.md        Detailed design and operational documentation
```

## Operational limits

- First use in an unindexed repository can take time.
- A zero-file index blocks repeated full-index retries in the same process.
- Crash recovery during indexing is best effort.
- Nested Git subrepository synchronization uses CodeGraph's public behavior without an extension-side workaround.
- Static graph output must be verified with source and runtime checks before risky edits.
