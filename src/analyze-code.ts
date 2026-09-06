import type { CodeGraphInstance, Edge, Node } from "./codegraph-sdk.js";
import { lastQualifierPart, matchesSymbol } from "./symbols.js";

const sectionLimit = 20;
const impactDepth = 2;
const pathEdgeLimit = 20;

export interface SymbolSelector {
  symbol: unknown;
  file?: unknown;
  line?: unknown;
}

export interface AnalyzeCodeParams {
  target: SymbolSelector;
  related?: SymbolSelector;
}

type RelatedNode = { node: Node; edge?: Edge };
type Resolution =
  | { kind: "resolved"; node: Node }
  | { kind: "candidates"; title: string; nodes: Node[] };

export function runAnalyzeCode(cg: CodeGraphInstance, params: AnalyzeCodeParams): string {
  const target = resolveSelector(cg, params.target, "target");
  const related = params.related === undefined ? undefined : resolveSelector(cg, params.related, "related");

  if (target.kind === "candidates") return formatCandidates(target);
  if (related?.kind === "candidates") return formatCandidates(related);

  const targetOutput = formatNeighborhood(cg, target.node, "Target");
  if (!related) return ["## Code Analysis", "", targetOutput, caveat()].join("\n");

  return [
    "## Code Analysis",
    "",
    targetOutput,
    "",
    formatNeighborhood(cg, related.node, "Related"),
    "",
    formatPaths(cg, target.node, related.node),
    caveat(),
  ].join("\n");
}

function resolveSelector(cg: CodeGraphInstance, selector: SymbolSelector, label: string): Resolution {
  const symbol = requiredSymbol(selector?.symbol, label);
  const file = validateFile(selector?.file, label);
  const line = validateLine(selector?.line, label);
  let results = cg.searchNodes(symbol, { limit: 50 });
  if (results.length === 0 && /[./]|::/.test(symbol)) {
    const tail = lastQualifierPart(symbol);
    if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit: 50 });
  }
  const exact = results.map((result) => result.node).filter((node) => matchesSymbol(node, symbol));
  const selected = exact.filter((node) => (file === undefined || node.filePath === file) && (line === undefined || node.startLine === line));

  if (selected.length === 1) return { kind: "resolved", node: selected[0]! };
  if (selected.length > 1) return { kind: "candidates", title: `Multiple exact definitions match ${JSON.stringify(symbol)}. Refine ${label} with file and line.`, nodes: selected };
  if (exact.length > 0 && (file !== undefined || line !== undefined)) {
    return { kind: "candidates", title: `No exact definition of ${JSON.stringify(symbol)} matches the supplied selector.`, nodes: exact };
  }

  return {
    kind: "candidates",
    title: exact.length === 0
      ? `No exact definition matches ${JSON.stringify(symbol)}. Select a likely candidate before analysis.`
      : `No definition matches ${JSON.stringify(symbol)}.`,
    nodes: results.map((result) => result.node),
  };
}

function formatCandidates(result: Extract<Resolution, { kind: "candidates" }>): string {
  const nodes = sortNodes(result.nodes).slice(0, sectionLimit);
  const lines = ["## Code Analysis", "", result.title];
  if (nodes.length === 0) return [...lines, "", "No likely code-symbol candidates found."].join("\n");

  lines.push("", `## Candidates (${nodes.length} of ${result.nodes.length})`, "");
  for (const node of nodes) lines.push(formatCandidate(node));
  if (result.nodes.length > nodes.length) lines.push("", `Showing the first ${nodes.length} candidates.`);
  return lines.join("\n");
}

function formatNeighborhood(cg: CodeGraphInstance, node: Node, label: string): string {
  const callers = sortRelated(cg.getCallers(node.id) as RelatedNode[]);
  const callees = sortRelated(cg.getCallees(node.id) as RelatedNode[]);
  const directIds = new Set([node.id, ...callers.map((item) => item.node.id), ...callees.map((item) => item.node.id)]);
  const impact = cg.getImpactRadius(node.id, impactDepth);
  const residual = sortNodes([...impact.nodes.values()].filter((item) => !directIds.has(item.id)));
  const testFiles = uniqueTestFiles([...callers.map((item) => item.node), ...residual]);

  return [
    `## ${label}: ${node.name} (${node.kind})`,
    `${node.filePath}:${node.startLine}`,
    node.qualifiedName !== node.name ? `Qualified: ${node.qualifiedName}` : "",
    node.signature ? `Signature: \`${node.signature}\`` : "",
    "",
    formatRelations("Direct Callers", callers, node, "incoming"),
    "",
    formatRelations("Direct Callees", callees, node, "outgoing"),
    "",
    formatNodes("Wider Impact", residual),
    "",
    formatTestFiles(testFiles),
  ].filter((line) => line !== "").join("\n");
}

function formatRelations(title: string, related: RelatedNode[], target: Node, direction: "incoming" | "outgoing"): string {
  const shown = related.slice(0, sectionLimit);
  const lines = [`## ${title} (${shown.length} of ${related.length})`];
  for (const item of shown) {
    const edge = item.edge?.kind ?? "references";
    const relation = direction === "incoming"
      ? `${formatNode(item.node)} --${edge}→ ${target.name}`
      : `${target.name} --${edge}→ ${formatNode(item.node)}`;
    lines.push(`- ${relation}`);
  }
  if (related.length > shown.length) lines.push(`- Truncated after ${shown.length} entries.`);
  return lines.join("\n");
}

function formatNodes(title: string, nodes: Node[]): string {
  const shown = nodes.slice(0, sectionLimit);
  const lines = [`## ${title} (${shown.length} of ${nodes.length})`];
  for (const node of shown) lines.push(`- ${formatNode(node)}`);
  if (nodes.length > shown.length) lines.push(`- Truncated after ${shown.length} entries.`);
  return lines.join("\n");
}

function formatTestFiles(files: string[]): string {
  if (files.length === 0) return "## Test Files Found in This Graph Neighborhood (0)\nNo test files found in this graph neighborhood.";
  return [`## Test Files Found in This Graph Neighborhood (${files.length})`, ...files.map((file) => `- ${file}`)].join("\n");
}

function formatPaths(cg: CodeGraphInstance, from: Node, to: Node): string {
  return [
    "## Graph Paths",
    formatPath("Target to Related", cg.findPath(from.id, to.id), from, to),
    "",
    formatPath("Related to Target", cg.findPath(to.id, from.id), to, from),
  ].join("\n");
}

function formatPath(title: string, path: Array<{ node: Node; edge: Edge | null }> | null, from: Node, to: Node): string {
  if (!path) return `### ${title}\nNo directed graph path found from ${from.name} to ${to.name}.`;
  const edges = path.length - 1;
  const shown = path.slice(0, pathEdgeLimit + 1);
  const lines = [`### ${title} (${edges} edges)`];
  for (let index = 0; index < shown.length; index++) {
    const step = shown[index]!;
    if (index === 0) lines.push(`- ${formatNode(step.node)}`);
    else lines.push(`  --${step.edge?.kind ?? "references"}→ ${formatNode(step.node)}`);
  }
  if (edges > pathEdgeLimit) lines.push(`- Path truncated after ${pathEdgeLimit} of ${edges} edges.`);
  return lines.join("\n");
}

function formatCandidate(node: Node): string {
  const signature = node.signature ? `\n   Signature: \`${node.signature}\`` : "";
  const qualified = node.qualifiedName !== node.name ? `\n   Qualified: ${node.qualifiedName}` : "";
  return `- ${node.name} (${node.kind})\n   Selector: { "symbol": ${JSON.stringify(node.name)}, "file": ${JSON.stringify(node.filePath)}, "line": ${node.startLine} }${qualified}${signature}`;
}

function formatNode(node: Node): string {
  return `${node.name} (${node.kind}) at ${node.filePath}:${node.startLine}`;
}

function sortRelated(nodes: RelatedNode[]): RelatedNode[] {
  return [...nodes].sort((a, b) => compareNodes(a.node, b.node));
}

function sortNodes(nodes: Node[]): Node[] {
  return [...nodes].sort(compareNodes);
}

function compareNodes(a: Node, b: Node): number {
  return a.filePath.localeCompare(b.filePath) || a.startLine - b.startLine || a.name.localeCompare(b.name);
}

function uniqueTestFiles(nodes: Node[]): string[] {
  return [...new Set(nodes.filter((node) => /(^|\/)(test|tests)\/|\.(test|spec)\.[^/]+$/.test(node.filePath)).map((node) => node.filePath))].sort();
}

function requiredSymbol(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label}.symbol must be a non-empty string`);
  return value.trim();
}

function validateFile(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label}.file must be a non-empty project-relative path`);
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some((segment) => segment === "." || segment === ".." || segment.length === 0)) {
    throw new Error(`${label}.file must be an exact safe project-relative path`);
  }
  return value;
}

function validateLine(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) throw new Error(`${label}.line must be a positive integer`);
  return value;
}

function caveat(): string {
  return "\nStatic indexed graph evidence only. It can omit unresolved, generated, dynamic, or runtime behavior.";
}
