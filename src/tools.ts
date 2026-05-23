import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CodeGraphInstance, Edge, FileRecord, Node } from "./codegraph-sdk.js";
import type { CodeGraphRuntime } from "./runtime.js";
import { matchesPathPrefix, globToRegex } from "./paths.js";
import { errorResult, textResult, type PiTextToolResult } from "./result.js";
import { findAllSymbols, findSymbol } from "./symbols.js";
import { clampNumber, optionalBoolean, optionalPath, optionalString, requiredString } from "./validate.js";

const SearchParams = Type.Object({
  query: Type.String({
    description: "Symbol name or partial name in the active project, e.g. auth, signIn, UserService.",
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
    description: "Optional node kind filter.",
  })),
  limit: Type.Optional(Type.Number({
    description: "Maximum results. Default 10, clamped 1..100.",
    default: 10,
  })),
});

const FilesParams = Type.Object({
  path: Type.Optional(Type.String({
    description: "Filter to indexed files under this directory within the active project, e.g. src/components.",
  })),
  pattern: Type.Optional(Type.String({
    description: "Glob-like filter within the active project, e.g. *.tsx or **/*.test.ts.",
  })),
  format: Type.Optional(Type.Union([
    Type.Literal("tree"),
    Type.Literal("flat"),
    Type.Literal("grouped"),
  ], {
    description: "Output format. Default tree.",
    default: "tree",
  })),
  includeMetadata: Type.Optional(Type.Boolean({
    description: "Include language and symbol count. Default true.",
    default: true,
  })),
  maxDepth: Type.Optional(Type.Number({
    description: "Maximum directory depth for tree output. Default unlimited, clamped 1..20.",
  })),
});

const SymbolLimitParams = Type.Object({
  symbol: Type.String({ description: "Symbol name in the active project." }),
  limit: Type.Optional(Type.Number({ description: "Maximum results. Default 20, clamped 1..100.", default: 20 })),
});

const ImpactParams = Type.Object({
  symbol: Type.String({ description: "Symbol to analyze impact for in the active project." }),
  depth: Type.Optional(Type.Number({ description: "Reverse dependency depth. Default 2, clamped 1..10.", default: 2 })),
});

const NodeParams = Type.Object({
  symbol: Type.String({ description: "Symbol name to inspect in the active project." }),
  includeCode: Type.Optional(Type.Boolean({ description: "Include source code. Default false.", default: false })),
});

const ContextParams = Type.Object({
  task: Type.String({ description: "Task, bug, or feature description for the active project." }),
  maxNodes: Type.Optional(Type.Number({ description: "Maximum symbols to include. Default 20, clamped 1..200.", default: 20 })),
  includeCode: Type.Optional(Type.Boolean({ description: "Include code snippets for key symbols. Default true.", default: true })),
});

interface CodeGraphToolSpec<TParams extends TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  promptSnippet?: string;
  promptGuidelines?: string[];
  run: (cg: CodeGraphInstance, params: Static<TParams>) => Promise<string> | string;
}

export function registerTools(pi: ExtensionAPI, runtime: CodeGraphRuntime): void {
  registerCodeGraphTool(pi, runtime, {
    name: "search",
    label: "Search CodeGraph",
    description: "Search indexed symbols by name or partial name in the active project. Returns locations and signatures, not source code.",
    promptSnippet: "search: search indexed symbols in the active project by name.",
    parameters: SearchParams,
    run: runSearch,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "files",
    label: "CodeGraph Files",
    description: "List indexed file structure for the active project. Supports tree, flat, and grouped output.",
    promptSnippet: "files: list indexed files in the active project.",
    parameters: FilesParams,
    run: runFiles,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "context",
    label: "CodeGraph Context",
    description: "Build broad task context for the active project using CodeGraph semantic understanding.",
    promptSnippet: "context: build task context for the active project.",
    parameters: ContextParams,
    run: runContext,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "callers",
    label: "CodeGraph Callers",
    description: "Find incoming callers/references for a symbol in the active project.",
    parameters: SymbolLimitParams,
    run: runCallers,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "callees",
    label: "CodeGraph Callees",
    description: "Find outgoing calls/references from a symbol in the active project.",
    parameters: SymbolLimitParams,
    run: runCallees,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "impact",
    label: "CodeGraph Impact",
    description: "Analyze reverse dependency impact radius for a symbol in the active project.",
    parameters: ImpactParams,
    run: runImpact,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "node",
    label: "CodeGraph Node",
    description: "Inspect one symbol in the active project.",
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
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      try {
        const cg = await runtime.ensureReady(ctx, {
          signal,
          onProgress: (message) => onUpdate?.({ message } as never),
        });
        const text = await spec.run(cg, params);
        return textResult(text, { tool: spec.name, projectRoot: cg.getProjectRoot() }) as never;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message, { tool: spec.name }) as never;
      }
    },
  });
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
