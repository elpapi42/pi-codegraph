# pi-codegraph Extension Documentation

`pi-codegraph` gives Pi fresh local CodeGraph intelligence for the active workspace. Its product contract is simple: prepare a fresh code index for `ctx.cwd`, then expose a small code-navigation surface that distinguishes ranked source exploration from bounded static graph analysis.

## Public surface

The extension exposes exactly two tools:

- `explore_code` for ranked indexed-code context and source.
- `analyze_code` for bounded static neighborhoods and connections between one or two symbols.

It also exposes `/cg:status` and `/cg:uninit`. It does not expose a project selector, an MCP server, a separate index command, or legacy narrow graph tools.

Use `read`, `rg`, and `find` for known files, Markdown, configuration, generated runtime wiring, and exact inventories. Those tasks are outside a semantic code index.

## Runtime ownership

All tools run through `runtime.ensureReady(ctx, { signal })`:

```text
tool call
  -> resolve nearest CodeGraph root from ctx.cwd
  -> initialize at ctx.cwd when absent
  -> index new or empty graph
  -> sync pending changed files
  -> reject unproven freshness
  -> run tool query
  -> return bounded Pi text result
```

The runtime caches one CodeGraph instance per resolved root and serializes readiness and sync work for that root. It fails closed after initialization, indexing, cancellation, zero-file, or lock-skipped synchronization failures.

`/cg:status` is read-only. `/cg:uninit [--force]` removes the resolved `.codegraph/` directory with confirmation or an explicit force flag. Tools provide automatic initialization, indexing, and synchronization, so there is no `/cg:init`.

## `explore_code`

`explore_code` runs CodeGraph 1.6 exploration through the installed public CLI package shim. The wrapper keeps active-root binding, automatic readiness, output caps, abort forwarding, and a restricted child environment. It uses `process.execPath`, not a shell. It disables package self-download and removes external MCP tool configuration from the child environment.

The input is one free-form `query`, with an optional `maxFiles` from 1 through 20. Query patterns include:

```text
how does login create and validate sessions
AuthService loginUser createSession
src/auth/session.ts createSession refreshSession
```

These are not modes. When paths and symbols are known, include them to improve focus. The result contains ranked line-numbered source, relationships, call paths, and blast-radius leads. It is not exhaustive. In multi-repository or duplicate-code indexes, verify every returned path before using it.

The CLI adds process startup cost and has no persistent MCP exploration-session state. Cancellation is best effort because the npm shim can start a descendant process.

## `analyze_code`

`analyze_code` has a required `target` selector and optional `related` selector:

```ts
{
  target: { symbol: "runExploreCode", file: "src/explore-code.ts", line: 42 },
  related: { symbol: "registerTools", file: "src/tools.ts", line: 116 },
}
```

A selector has a required symbol and optional exact project-relative file and definition line. A selector with `file` resolves only inside that file through CodeGraph's `getNodesInFile()`. File-local selection avoids the bounded global candidate ranking used when no file is supplied.

With only `target`, output contains one selected definition, incoming relationships, outgoing relationships, residual depth-two reverse impact, and test files found in that graph neighborhood. With `related`, both selectors resolve before any traversal. The result contains the same neighborhood for each selector and directed shortest static graph paths in both directions.

Partial, missing, and ambiguous selectors return up to 20 candidate selectors. No graph traversal occurs until all supplied selectors resolve uniquely. Candidate output ranks definitions ahead of import and file nodes. Relationship rows group repeated edges by node and list distinct edge kinds.

The tool intentionally has no operation, depth, direction, limit, source, or project-path parameter. It gives automatic bounded analysis after exact identity selection. Relationships and paths are static indexed evidence, not runtime proof. They can omit unresolved, generated, dynamic, or unindexed behavior and can include incorrect method resolution.

## Package boundary

The extension uses the published `@colbymchenry/codegraph` SDK `^1.6.0`. `src/codegraph-sdk.ts` is the only package-boundary adapter. It normalizes the package export shape and re-exports the public types used by runtime and the two tools.

`explore_code` uses the installed public CLI shim because upstream exploration is not exported from the package root. The extension does not deep-import private CodeGraph modules or embed the MCP server.

After upgrading an existing CodeGraph index from an older engine, rebuild it once:

```bash
npx --no-install codegraph index /path/to/project
```

## Validation

Run:

```bash
npm test
npm run typecheck
npm pack --dry-run
npm audit --audit-level=high
git diff --check
```

Tests cover exact two-tool registration, no public cross-project selector, automatic readiness and command behavior, real-index exploration, target and related graph analysis, file-local selector resolution, candidate-only ambiguity behavior, graph-path direction, output caps, and metadata that does not expose MCP tool names.

## Operational limits

The first call in an unindexed repository can perform a full index. Zero-file results block repeated indexing in the same process. Crash recovery during indexing is best effort. Nested Git subrepository synchronization uses CodeGraph's public behavior without an extension-side full-reindex workaround.
