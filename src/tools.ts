import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { CodeGraphInstance, Edge, FileRecord, Node } from "./codegraph-sdk.js";
import type { CodeGraphRuntime } from "./runtime.js";
import { runExplore } from "./explore.js";
import { runExploreCode } from "./explore-code.js";
import { runAnalyzeCode } from "./analyze-code.js";
import { matchesPathPrefix, globToRegex } from "./paths.js";
import { errorResult, textResult, type PiTextToolResult } from "./result.js";
import { findAllSymbols, findSymbol } from "./symbols.js";
import { clampNumber, optionalBoolean, optionalPath, optionalString, requiredString } from "./validate.js";

const SearchParams = Type.Object({
  query: Type.String({
    description: "Symbol name or partial name, e.g. \"auth\", \"signIn\", \"UserService\". Use compact symbol-like terms, not broad natural-language questions.",
  }),
  kind: Type.Optional(Type.Union([
    Type.Literal("function"),
    Type.Literal("method"),
    Type.Literal("class"),
    Type.Literal("interface"),
    Type.Literal("type"),
    Type.Literal("variable"),
    Type.Literal("route"),
    Type.Literal("component"),
  ], {
    description: "Filter by symbol kind. Values: function, method, class, interface, type, variable, route, component.",
  })),
  limit: Type.Optional(Type.Number({
    description: "Maximum symbol matches to return. Default 10, clamped 1..100.",
    default: 10,
  })),
});

const FilesParams = Type.Object({
  path: Type.Optional(Type.String({
    description: "Filter to indexed files under this project-relative directory path, e.g. \"src/components\". Returns all indexed files if omitted; does not select another project.",
  })),
  pattern: Type.Optional(Type.String({
    description: "Filter files matching this glob pattern against full project-relative paths, e.g. \"*.tsx\" or \"**/*.test.ts\"; use \"**/*.ts\" for recursive matches.",
  })),
  format: Type.Optional(Type.Union([
    Type.Literal("tree"),
    Type.Literal("flat"),
    Type.Literal("grouped"),
  ], {
    description: "Output format. Values: tree (hierarchical, default), flat (simple list), grouped (by language).",
    default: "tree",
  })),
  includeMetadata: Type.Optional(Type.Boolean({
    description: "Include file metadata such as language and indexed symbol count. Default true.",
    default: true,
  })),
  maxDepth: Type.Optional(Type.Number({
    description: "Maximum directory depth to show for tree output. Default unlimited, clamped 1..20.",
  })),
});

const SymbolLimitParams = Type.Object({
  symbol: Type.String({ description: "Name of the function, method, class, component, route, or other symbol to inspect. Qualified names and path-like symbol hints are allowed." }),
  limit: Type.Optional(Type.Number({ description: "Maximum number of matching references to return. Default 20, clamped 1..100.", default: 20 })),
});

const ImpactParams = Type.Object({
  symbol: Type.String({ description: "Name of the symbol to analyze impact for. Qualified names and path-like symbol hints are allowed." }),
  depth: Type.Optional(Type.Number({ description: "How many levels of reverse dependencies to traverse. Default 2, clamped 1..10.", default: 2 })),
});

const NodeParams = Type.Object({
  symbol: Type.String({ description: "Name of the symbol to get details for. Qualified names and path-like symbol hints are allowed." }),
  includeCode: Type.Optional(Type.Boolean({ description: "Include source code. Default false to minimize context; functions/methods return bodies, while classes/interfaces/structs/enums return compact member outlines instead of every method body.", default: false })),
});

const ContextParams = Type.Object({
  task: Type.String({ description: "Description of the task, bug, feature, architecture question, or behavior to build code context for. Natural language is appropriate here." }),
  maxNodes: Type.Optional(Type.Number({ description: "Maximum symbols to include. Default 20, clamped 1..200.", default: 20 })),
  includeCode: Type.Optional(Type.Boolean({ description: "Include code snippets for key symbols. Default true.", default: true })),
});

const ExploreParams = Type.Object({
  query: Type.String({ description: "Symbol names, file names, or short code terms to explore, e.g. \"AuthService loginUser session-manager\" or \"GraphTraverser BFS traversal.ts\". Use context first for broad natural-language questions and search first if you need relevant names." }),
  maxFiles: Type.Optional(Type.Number({ description: "Maximum number of files to include source code from. Defaults adaptively by project size, clamped 1..20." })),
});

const ExploreCodeParams = Type.Object({
  query: Type.String({ description: "Natural-language question, symbol names, or indexed code file path. For example: \"how does login work\", \"AuthService loginUser session-manager\", or \"src/auth/session.ts\"." }),
  maxFiles: Type.Optional(Type.Number({ description: "Maximum source files to return. Omit it to let CodeGraph choose an adaptive limit, or set 1 through 20." })),
});

const AnalyzeSelector = Type.Object({
  symbol: Type.String({ description: "Exact or likely code symbol name. If it is ambiguous or partial, analyze_code returns candidates instead of analyzing." }),
  file: Type.Optional(Type.String({ description: "Exact project-relative code file path from an earlier candidate result, used only to disambiguate the symbol." })),
  line: Type.Optional(Type.Number({ description: "Exact definition start line from an earlier candidate result, used only to disambiguate the symbol." })),
});

const AnalyzeCodeParams = Type.Object({
  target: AnalyzeSelector,
  related: Type.Optional(AnalyzeSelector),
});

interface CodeGraphToolSpec<TParams extends TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  promptSnippet?: string;
  promptGuidelines?: string[];
  run: (cg: CodeGraphInstance, params: Static<TParams>, signal: AbortSignal | undefined) => Promise<string> | string;
}

export function registerTools(pi: ExtensionAPI, runtime: CodeGraphRuntime): void {
  registerCodeGraphTool(pi, runtime, {
    name: "search",
    label: "Search Symbols",
    description: "Quick symbol search by name or partial name. Use to locate known or likely functions, methods, classes, interfaces, components, routes, types, or variables before reading files or inspecting a symbol. Returns matching symbols with locations and signatures only, not source code. Use context instead for broad natural-language task or architecture questions.",
    promptSnippet: "search: quick symbol search by name or partial name; returns locations and signatures, not source code.",
    promptGuidelines: [
      "Use `search` to find a known function, method, class, component, route, type, variable, or interface by name.",
      "Use `search` with a compact domain term like `auth`, `billing`, `webhook`, or `settings` to find likely entry symbols.",
      "Use `search` to disambiguate similarly named symbols before choosing one to inspect or edit.",
      "Use `search` before `node`, `callers`, `callees`, or `impact` when you need to identify the exact symbol first.",
      "Use `search` with the `kind` parameter to narrow results to values such as `component`, `route`, `class`, or `function`.",
      "Use `search` to check whether a symbol already exists before adding new code.",
      "Use `search` to find framework entry points such as handlers, routes, hooks, controllers, or services.",
    ],
    parameters: SearchParams,
    run: runSearch,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "files",
    label: "Project Files",
    description: "Required for file and folder exploration. Lists project file structure from the index with optional metadata such as language and symbol count. Much faster than filesystem scanning; use this first when exploring project structure, finding files, or understanding codebase organization.",
    promptSnippet: "files: list indexed project files before choosing files to read.",
    promptGuidelines: [
      "Use `files` to understand project structure before reading files.",
      "Use `files` with `path` to list indexed files under a directory such as `src/` or `src/components`.",
      "Use `files` with `pattern` to find files such as `**/*.test.ts`, `**/*.tsx`, or `**/*config*`.",
      "Use `files` with `format: \"tree\"` and `maxDepth` to get a high-level structure before deeper exploration.",
      "Use `files` with `format: \"grouped\"` to understand the project's languages and broad repo shape.",
      "Use `files` to verify whether expected files or directories are present in the active index.",
      "Use `files` to diagnose empty or surprising `search` results by checking what the active index contains.",
    ],
    parameters: FilesParams,
    run: runFiles,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "context",
    label: "Task Context",
    description: "Primary tool for broad code understanding. Call this first for \"how does X work\", architecture, feature, or bug-context questions. Returns entry points, related symbols, and key code in one call; prefer it over chaining search plus node for broad discovery. Provides code context, not product requirements, so still clarify UX, edge cases, and acceptance criteria for new features.",
    promptSnippet: "context: primary broad-discovery tool for architecture, feature, and bug-context questions.",
    promptGuidelines: [
      "Use `context` at the start of non-trivial work when the user describes a task, bug, feature, or architecture question.",
      "Use `context` for broad questions like `how does auth work?` when you do not yet know the relevant symbol names.",
      "Use `context` to get entry points, related symbols, and key code in one call.",
      "Use `context` to explore an unfamiliar area before planning or editing.",
      "Use `context` to locate likely implementation and test surfaces for a bug fix.",
      "Use `context` for cross-cutting behavior that may span multiple files, layers, or product surfaces.",
      "Use `context` instead of chaining many `search`, `node`, and `read` calls when broad discovery is needed.",
    ],
    parameters: ContextParams,
    run: runContext,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "explore",
    label: "Explore Related Source",
    description: "Return source for several related symbols grouped by file, plus a relationship map, in one capped call. Use after context when you need to inspect actual source for multiple related symbols; prefer it over a series of node or read calls. Query with specific symbol names, file names, or short code terms, not broad natural-language sentences.",
    promptSnippet: "explore: inspect related source sections across files in one capped call, grouped by file with relationships.",
    promptGuidelines: [
      "Use `explore` after `context` when you need source code for several related symbols or files in one result.",
      "Use `explore` with compact symbol, file, or code terms such as `AuthService loginUser createSession` rather than broad natural-language questions.",
      "Use `explore` instead of looping over many `node` or `read` calls when surveying a related source cluster.",
      "Use `search` before `explore` if you need to discover the relevant symbol names first.",
      "Use `node` instead of `explore` when you only need one symbol's signature, metadata, or source.",
      "Use `explore` to inspect multi-file flows such as route handler → service → repository, component → hook → store, or controller → helper chains.",
      "Use `read` after `explore` only when you need exact full-file context, nearby unrelated code, or edit-ready source verification.",
    ],
    parameters: ExploreParams,
    run: runExplore,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "explore_code",
    label: "Explore Indexed Code",
    description: "Explore indexed code for a natural-language question or symbol and file names. Returns current line-numbered source, relationships, call paths including supported dynamic dispatch, and blast radius. Treat returned source as already read. Use a narrower second query only for a specific gap. This tool indexes code, not Markdown, general configuration, generated runtime wiring, or exhaustive filesystem inventories. Use read for known files and filesystem or text-search commands such as rg or find for those surfaces.",
    promptSnippet: "explore_code: primary code-navigation tool for indexed code; returns source, relationships, paths, and blast radius in one call.",
    promptGuidelines: [
      "Use `explore_code` first to understand indexed code, trace a flow, investigate a code bug, or prepare a code change.",
      "Use a natural-language question, a symbol or file name, or related names across a flow.",
      "Treat source returned by `explore_code` as already read. Use a narrower second query only when a specific gap remains.",
      "Use read for known files and filesystem or text-search commands such as rg or find for Markdown, configuration, generated runtime wiring, and exhaustive file inventories because CodeGraph indexes code only.",
    ],
    parameters: ExploreCodeParams,
    run: runExploreCode,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "analyze_code",
    label: "Analyze Code Symbols",
    description: "Analyze one or two indexed code symbols with automatic exact static graph analysis. For one resolved symbol, returns direct callers, direct callees, wider impact, and test files in its graph neighborhood. For two resolved symbols, also returns graph paths in both directions. If either symbol is ambiguous or partial, returns selector-ready candidates without analysis. This output is static indexed evidence, not runtime proof, and does not include source code.",
    promptSnippet: "analyze_code: verify exact static graph relationships for one or two code symbols; ambiguity returns candidates.",
    promptGuidelines: [
      "Use `analyze_code` before changing a known symbol when you need exact callers, callees, impact, or a graph connection to another symbol.",
      "Provide `file` and `line` only when you need to disambiguate a symbol. Use candidates returned by a previous analyze_code call.",
      "Use `explore_code` for source and ranked code context. Use analyze_code for bounded static graph evidence without source.",
      "Treat graph paths and relationships as static indexed evidence, not proof of runtime execution.",
    ],
    parameters: AnalyzeCodeParams,
    run: (cg, params) => runAnalyzeCode(cg, params),
  });

  registerCodeGraphTool(pi, runtime, {
    name: "callers",
    label: "Symbol Callers",
    description: "Find functions, methods, or other symbols that call or reference a specific symbol. Useful for understanding usage patterns, incoming dependencies, and direct impact of changes.",
    promptGuidelines: [
      "Use `callers` to find who calls or references a function, method, class, component, route, or other symbol before changing it.",
      "Use `callers` to understand usage patterns and direct incoming dependencies.",
      "Use `callers` to find call sites that may need updates after a signature or behavior change.",
      "Use `callers` to identify tests or product flows that exercise a symbol.",
      "Use `callers` to decide whether a symbol is internal, shared, or API-like.",
      "Use `callers` to check whether code is unused or lightly used before deleting or refactoring it.",
      "Use `callers` to find high-level entry points that reach a low-level helper.",
    ],
    parameters: SymbolLimitParams,
    run: runCallers,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "callees",
    label: "Symbol Callees",
    description: "Find functions, methods, or other symbols that a specific symbol calls or references. Useful for understanding outgoing dependencies, implementation flow, and what code a symbol relies on.",
    promptGuidelines: [
      "Use `callees` to understand what a function, method, class, component, route, or other symbol calls or depends on.",
      "Use `callees` to trace implementation flow inside a selected symbol.",
      "Use `callees` to identify downstream services, repositories, helpers, hooks, or API calls.",
      "Use `callees` to spot side effects such as database writes, file writes, network calls, telemetry, or emails.",
      "Use `callees` to check whether a path performs auth, validation, error handling, or permission checks.",
      "Use `callees` to understand dependencies before extracting or refactoring code.",
      "Use `callees` together with `callers` to understand both incoming usage and outgoing dependencies.",
    ],
    parameters: SymbolLimitParams,
    run: runCallees,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "impact",
    label: "Change Impact",
    description: "Analyze the impact radius of changing a symbol. Shows what code could be affected by modifications, including reverse dependencies beyond direct callers. Use before edits, refactors, or API/signature changes.",
    promptGuidelines: [
      "Use `impact` to check blast radius before changing a shared symbol.",
      "Use `impact` to analyze likely affected symbols and files before refactors.",
      "Use `impact` before renaming, deleting, moving, or changing signatures.",
      "Use `impact` to find affected consumers beyond direct callers.",
      "Use `impact` to plan tests and review scope for risky changes.",
      "Use `impact` to decide whether a proposed fix is local or cross-cutting.",
      "Use `impact` to compare alternative edit points by how much code each would affect.",
    ],
    parameters: ImpactParams,
    run: runImpact,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "node",
    label: "Symbol Details",
    description: "Get detailed information about one symbol, including location, signature, and docstring when available. Pass includeCode=true for source: functions and methods return their body; classes, interfaces, structs, and enums return a compact member outline with fields, method signatures, and line numbers. Keep includeCode=false to minimize context; use context first for several related symbols.",
    promptGuidelines: [
      "Use `node` to inspect one symbol's location, signature, metadata, and docstring.",
      "Use `node` with `includeCode: true` to get source for a specific function or method.",
      "Use `node` with `includeCode: true` on a class, interface, module, or other container to get a compact outline instead of every body.",
      "Use `node` to inspect a symbol found by `search` or `context`.",
      "Use `node` to resolve ambiguity after multiple `search` results.",
      "Use `node` to verify the exact implementation before editing.",
      "Use `node` to inspect a specific symbol returned by `callers`, `callees`, or `impact` in more detail.",
    ],
    parameters: NodeParams,
    run: runNode,
  });
}

export function registerCodeGraphTool<TParams extends TSchema>(
  pi: ExtensionAPI,
  runtime: CodeGraphRuntime,
  spec: CodeGraphToolSpec<TParams>,
): void {
  pi.registerTool({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    promptGuidelines: spec.promptGuidelines,
    parameters: spec.parameters,
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatToolCall(spec.name, args, theme));
      return text;
    },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      try {
        const cg = await runtime.ensureReady(ctx, { signal });
        const text = await spec.run(cg, params, signal);
        return textResult(text, { tool: spec.name, projectRoot: cg.getProjectRoot() }) as never;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message, { tool: spec.name }) as never;
      }
    },
  });
}

function formatToolCall(toolName: string, args: Record<string, unknown> | undefined, theme: ToolCallTheme): string {
  const title = theme.fg("toolTitle", theme.bold(toolName));
  const params = args ?? {};

  switch (toolName) {
    case "search":
      return joinCallParts(title, formatPrimary(params.query, theme), formatOptional("kind", params.kind, theme), formatOptional("limit", params.limit, theme));
    case "context":
      return joinCallParts(title, formatPrimary(params.task, theme), formatOptional("nodes", params.maxNodes, theme), params.includeCode === false ? theme.fg("dim", "no-code") : undefined);
    case "explore":
    case "explore_code":
      return joinCallParts(title, formatPrimary(params.query, theme), formatOptional("files", params.maxFiles, theme));
    case "analyze_code":
      return joinCallParts(title, formatPrimary((params.target as Record<string, unknown> | undefined)?.symbol, theme, { quote: false }), formatOptional("related", (params.related as Record<string, unknown> | undefined)?.symbol, theme));
    case "files":
      return joinCallParts(
        title,
        params.path ? formatPrimary(params.path, theme, { quote: false }) : undefined,
        params.pattern ? formatPrimary(params.pattern, theme) : undefined,
        typeof params.format === "string" ? theme.fg("dim", params.format) : undefined,
        formatOptional("depth", params.maxDepth, theme),
        params.includeMetadata === false ? theme.fg("dim", "no-meta") : undefined,
      );
    case "node":
      return joinCallParts(title, formatPrimary(params.symbol, theme, { quote: false }), params.includeCode === true ? theme.fg("dim", "+code") : undefined);
    case "callers":
    case "callees":
      return joinCallParts(title, formatPrimary(params.symbol, theme, { quote: false }), formatOptional("limit", params.limit, theme));
    case "impact":
      return joinCallParts(title, formatPrimary(params.symbol, theme, { quote: false }), formatOptional("depth", params.depth, theme));
    default:
      return title;
  }
}

interface ToolCallTheme {
  fg(style: string, text: string): string;
  bold(text: string): string;
}

function joinCallParts(...parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

function formatPrimary(value: unknown, theme: ToolCallTheme, options: { quote?: boolean } = {}): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const truncated = truncateCallValue(value);
  const quote = options.quote ?? true;
  return theme.fg("accent", quote ? JSON.stringify(truncated) : truncated);
}

function formatOptional(label: string, value: unknown, theme: ToolCallTheme): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return theme.fg("dim", `${label}=${String(value)}`);
}

function truncateCallValue(value: string, maxLength = 80): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function runSearch(cg: CodeGraphInstance, params: Static<typeof SearchParams>): string {
  const query = requiredString(params.query, "search.query");
  const limit = clampNumber(params.limit, 10, 1, 100);
  const kind = optionalString(params.kind, "search.kind");
  const sdkKind = kind === "type" ? "type_alias" : kind;

  const results = cg.searchNodes(query, {
    limit,
    kinds: sdkKind ? [sdkKind as never] : undefined,
  });

  if (results.length === 0) {
    return `No results found for "${query}"`;
  }

  const lines = [`## Search Results (${results.length} found)`, ""];
  for (const { node, score } of results) {
    lines.push(formatSearchResult(node, score));
  }

  return lines.join("\n").trimEnd();
}

function formatSearchResult(node: Node, score?: number): string {
  const lines = [`### ${node.name} (${node.kind})`, formatLocation(node)];
  if (node.signature) lines.push(`\`${node.signature}\``);
  if (typeof score === "number") lines.push(`Score: ${score.toFixed(2)}`);
  lines.push("");
  return lines.join("\n");
}

function runFiles(cg: CodeGraphInstance, params: Static<typeof FilesParams>): string {
  const pathFilter = optionalPath(params.path, "files.path");
  const pattern = optionalPath(params.pattern, "files.pattern");
  const format = params.format ?? "tree";
  const includeMetadata = optionalBoolean(params.includeMetadata, true);
  const maxDepth = params.maxDepth == null ? undefined : clampNumber(params.maxDepth, 20, 1, 20);

  let files = cg.getFiles() as FileRecord[];

  if (pathFilter) {
    files = files.filter((file) => matchesPathPrefix(file.path, pathFilter));
  }

  if (pattern) {
    const regex = globToRegex(pattern);
    files = files.filter((file) => regex.test(file.path));
  }

  files = [...files].sort((a, b) => a.path.localeCompare(b.path));

  if (files.length === 0) {
    return "No indexed files found matching the criteria.";
  }

  if (format === "flat") return formatFilesFlat(files, includeMetadata);
  if (format === "grouped") return formatFilesGrouped(files, includeMetadata);
  return formatFilesTree(files, includeMetadata, maxDepth);
}

function formatFilesFlat(files: FileRecord[], includeMetadata: boolean): string {
  const lines = [`## Files (${files.length} total)`, ""];
  for (const file of files) {
    lines.push(`- ${formatFile(file, includeMetadata)}`);
  }
  return lines.join("\n");
}

function formatFilesGrouped(files: FileRecord[], includeMetadata: boolean): string {
  const byLanguage = new Map<string, FileRecord[]>();
  for (const file of files) {
    const group = byLanguage.get(file.language) ?? [];
    group.push(file);
    byLanguage.set(file.language, group);
  }

  const lines = [`## Files by Language (${files.length} total)`, ""];
  for (const [language, languageFiles] of [...byLanguage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`### ${language} (${languageFiles.length})`);
    for (const file of languageFiles) {
      lines.push(`- ${formatFile(file, includeMetadata)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

interface TreeNode {
  children: Map<string, TreeNode>;
  file?: FileRecord;
}

function formatFilesTree(files: FileRecord[], includeMetadata: boolean, maxDepth?: number): string {
  const root: TreeNode = { children: new Map() };
  for (const file of files) {
    let current = root;
    for (const part of file.path.split("/")) {
      let child = current.children.get(part);
      if (!child) {
        child = { children: new Map() };
        current.children.set(part, child);
      }
      current = child;
    }
    current.file = file;
  }

  const lines = [`## Project Structure (${files.length} files)`, ""];
  renderTree(root, lines, 0, includeMetadata, maxDepth);
  return lines.join("\n").trimEnd();
}

function renderTree(
  node: TreeNode,
  lines: string[],
  depth: number,
  includeMetadata: boolean,
  maxDepth?: number,
): void {
  if (maxDepth != null && depth >= maxDepth) return;

  for (const [name, child] of [...node.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const indent = "  ".repeat(depth);
    if (child.file) {
      lines.push(`${indent}${formatFileName(name, child.file, includeMetadata)}`);
    } else {
      lines.push(`${indent}${name}/`);
      renderTree(child, lines, depth + 1, includeMetadata, maxDepth);
    }
  }
}

function formatFile(file: FileRecord, includeMetadata: boolean): string {
  return includeMetadata ? `${file.path} (${file.language}, ${file.nodeCount} symbols)` : file.path;
}

function formatFileName(name: string, file: FileRecord, includeMetadata: boolean): string {
  return includeMetadata ? `${name} (${file.language}, ${file.nodeCount} symbols)` : name;
}

function formatLocation(node: Node): string {
  return node.startLine ? `${node.filePath}:${node.startLine}` : node.filePath;
}

const CONTAINER_NODE_KINDS = new Set<string>([
  "class",
  "interface",
  "struct",
  "trait",
  "protocol",
  "module",
  "enum",
  "namespace",
  "component",
  "file",
]);

async function runNode(cg: CodeGraphInstance, params: Static<typeof NodeParams>): Promise<string> {
  const symbol = requiredString(params.symbol, "node.symbol");
  const includeCode = optionalBoolean(params.includeCode, false);
  const match = findSymbol(cg, symbol);

  if (!match) {
    return `Symbol "${symbol}" not found in the codebase`;
  }

  const { node, note } = match;
  const lines = [`## ${node.name} (${node.kind})`, "", `**Location:** ${formatLocation(node)}`];
  if (node.qualifiedName && node.qualifiedName !== node.name) lines.push(`**Qualified:** \`${node.qualifiedName}\``);
  if (node.signature) lines.push(`**Signature:** \`${node.signature}\``);
  if (node.visibility) lines.push(`**Visibility:** ${node.visibility}`);
  if (node.isExported != null) lines.push(`**Exported:** ${node.isExported ? "yes" : "no"}`);
  if (node.docstring && node.docstring.length < 500) lines.push("", node.docstring);

  if (includeCode) {
    if (CONTAINER_NODE_KINDS.has(node.kind)) {
      const outline = formatContainerOutline(cg, node);
      if (outline) {
        lines.push("", outline, "", `> Structural outline only. Read \`${node.filePath}\` or call \`node\` on a specific member for its body.`);
      }
    } else {
      const code = await cg.getCode(node.id);
      if (code) {
        lines.push("", `\`\`\`${node.language}`, code, "```" );
      }
    }
  }

  return `${lines.join("\n")}${note}`;
}

function formatContainerOutline(cg: CodeGraphInstance, node: Node): string {
  const children = cg.getChildren(node.id)
    .filter((child) => child.kind !== "import" && child.kind !== "export")
    .sort((a, b) => a.startLine - b.startLine);

  if (children.length === 0) return "";

  const lines = [`**Members (${children.length}):**`, ""];
  for (const child of children) {
    const signature = child.signature ? ` — \`${child.signature}\`` : "";
    lines.push(`- ${child.name} (${child.kind})${child.startLine ? `:${child.startLine}` : ""}${signature}`);
  }
  return lines.join("\n");
}

function runCallers(cg: CodeGraphInstance, params: Static<typeof SymbolLimitParams>): string {
  const symbol = requiredString(params.symbol, "callers.symbol");
  const limit = clampNumber(params.limit, 20, 1, 100);
  const matches = findAllSymbols(cg, symbol);

  if (matches.nodes.length === 0) {
    return `Symbol "${symbol}" not found in the codebase`;
  }

  const callers = dedupeRelated(matches.nodes.flatMap((node) => cg.getCallers(node.id).map((item) => item.node)));
  if (callers.length === 0) return `No callers found for "${symbol}"${matches.note}`;
  return `${formatNodeList(callers.slice(0, limit), `Callers of ${symbol}`)}${matches.note}`;
}

function runCallees(cg: CodeGraphInstance, params: Static<typeof SymbolLimitParams>): string {
  const symbol = requiredString(params.symbol, "callees.symbol");
  const limit = clampNumber(params.limit, 20, 1, 100);
  const matches = findAllSymbols(cg, symbol);

  if (matches.nodes.length === 0) {
    return `Symbol "${symbol}" not found in the codebase`;
  }

  const callees = dedupeRelated(matches.nodes.flatMap((node) => cg.getCallees(node.id).map((item) => item.node)));
  if (callees.length === 0) return `No callees found for "${symbol}"${matches.note}`;
  return `${formatNodeList(callees.slice(0, limit), `Callees of ${symbol}`)}${matches.note}`;
}

function runImpact(cg: CodeGraphInstance, params: Static<typeof ImpactParams>): string {
  const symbol = requiredString(params.symbol, "impact.symbol");
  const depth = clampNumber(params.depth, 2, 1, 10);
  const matches = findAllSymbols(cg, symbol);

  if (matches.nodes.length === 0) {
    return `Symbol "${symbol}" not found in the codebase`;
  }

  const mergedNodes = new Map<string, Node>();
  const seenEdges = new Set<string>();
  const mergedEdges: Edge[] = [];

  for (const node of matches.nodes) {
    const impact = cg.getImpactRadius(node.id, depth);
    for (const [id, impactedNode] of impact.nodes) mergedNodes.set(id, impactedNode);
    for (const edge of impact.edges) {
      const key = `${edge.source}->${edge.target}:${edge.kind}`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        mergedEdges.push(edge);
      }
    }
  }

  if (mergedNodes.size === 0) {
    return `No impact found for "${symbol}"${matches.note}`;
  }

  return `${formatImpact(symbol, mergedNodes, mergedEdges)}${matches.note}`;
}

async function runContext(cg: CodeGraphInstance, params: Static<typeof ContextParams>): Promise<string> {
  const task = requiredString(params.task, "context.task");
  const maxNodes = clampNumber(params.maxNodes, 20, 1, 200);
  const includeCode = optionalBoolean(params.includeCode, true);

  const context = await cg.buildContext(task, {
    maxNodes,
    includeCode,
    format: "markdown",
  });

  if (typeof context === "string") {
    return context;
  }

  if (context && typeof context === "object" && "summary" in context && typeof context.summary === "string") {
    return context.summary;
  }

  return "No context found for the given task.";
}

function dedupeRelated(nodes: Node[]): Node[] {
  const seen = new Set<string>();
  const deduped: Node[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    deduped.push(node);
  }
  return deduped.sort((a, b) => a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine);
}

function formatNodeList(nodes: Node[], title: string): string {
  const lines = [`## ${title} (${nodes.length} found)`, ""];
  for (const node of nodes) {
    lines.push(`- ${node.name} (${node.kind}) - ${formatLocation(node)}`);
  }
  return lines.join("\n");
}

function formatImpact(symbol: string, nodes: Map<string, Node>, edges: Edge[]): string {
  const lines = [`## Impact: "${symbol}" affects ${nodes.size} symbols`, ""];
  const byFile = new Map<string, Node[]>();
  for (const node of nodes.values()) {
    const group = byFile.get(node.filePath) ?? [];
    group.push(node);
    byFile.set(node.filePath, group);
  }

  for (const [file, fileNodes] of [...byFile.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`**${file}:**`);
    lines.push(fileNodes
      .sort((a, b) => a.startLine - b.startLine)
      .map((node) => `${node.name}:${node.startLine}`)
      .join(", "));
    lines.push("");
  }

  if (edges.length > 0) {
    lines.push(`Relationships: ${edges.length}`);
  }
  return lines.join("\n").trimEnd();
}
