import { Type, type Static } from "@earendil-works/pi-ai";
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

const symbolSchema = Type.Object({
  name: Type.String(), kind: Type.String(),
  file: Type.String({ description: "Relative to projectRoot" }), line: Type.Integer(),
  qualifiedName: Type.Optional(Type.String()), signature: Type.Optional(Type.String()),
});
const relationSchema = Type.Object({ symbol: symbolSchema, kinds: Type.Array(Type.String()) });
const relationSectionSchema = Type.Object({ items: Type.Array(relationSchema), total: Type.Integer() });
const neighborhoodSchema = Type.Object({
  symbol: symbolSchema,
  incoming: relationSectionSchema, outgoing: relationSectionSchema,
  impact: Type.Object({ items: Type.Array(symbolSchema), total: Type.Integer() }),
  testFiles: Type.Array(Type.String()),
});
const pathSchema = Type.Object({
  steps: Type.Array(Type.Object({ symbol: symbolSchema, kind: Type.Optional(Type.String()) })),
  total: Type.Integer({ description: "Edge count before the 20-edge cap" }),
});
export const analyzeOutputSchema = Type.Union([
  Type.Object({
    projectRoot: Type.String(), status: Type.Literal("candidates"),
    selector: Type.Union([Type.Literal("target"), Type.Literal("related")], { description: "Selector needing refinement" }),
    reason: Type.Union([Type.Literal("ambiguous"), Type.Literal("not_found")]),
    candidates: Type.Array(Type.Object({
      ...symbolSchema.properties,
      selector: Type.Object({ symbol: Type.String(), file: Type.String(), line: Type.Integer() }, { description: "Reusable selector" }),
    })),
    total: Type.Integer({ description: "Candidates found by the bounded resolver" }),
  }),
  Type.Object({
    projectRoot: Type.String(), status: Type.Literal("analyzed"), target: neighborhoodSchema,
    related: Type.Optional(neighborhoodSchema),
    paths: Type.Optional(Type.Object({
      targetToRelated: Type.Union([pathSchema, Type.Null()]),
      relatedToTarget: Type.Union([pathSchema, Type.Null()]),
    })),
  }),
]);
export type AnalyzeOutput = Static<typeof analyzeOutputSchema>;

type RelatedNode = { node: Node; edge?: Edge };
type RelatedGroup = { node: Node; edgeKinds: string[] };
type CodeGraphWithNodesInFile = CodeGraphInstance & { getNodesInFile(filePath: string): Node[] };
type Resolution =
  | { kind: "resolved"; node: Node }
  | { kind: "candidates"; reason: "ambiguous" | "not_found"; title: string; nodes: Node[] };

interface Neighborhood {
  node: Node;
  callers: RelatedGroup[];
  callees: RelatedGroup[];
  residual: Node[];
  testFiles: string[];
}
type GraphPath = Array<{ node: Node; edge: Edge | null }> | null;
type Analysis =
  | { kind: "candidates"; result: Extract<Resolution, { kind: "candidates" }>; selector: "target" | "related" }
  | { kind: "analyzed"; target: Neighborhood; related?: Neighborhood; paths?: { targetToRelated: GraphPath; relatedToTarget: GraphPath } };

function buildAnalysis(cg: CodeGraphInstance, params: AnalyzeCodeParams): Analysis {
  const target = resolveSelector(cg, params.target, "target");
  const related = params.related === undefined ? undefined : resolveSelector(cg, params.related, "related");
  if (target.kind === "candidates") return { kind: "candidates", result: target, selector: "target" };
  if (related?.kind === "candidates") return { kind: "candidates", result: related, selector: "related" };

  const targetNeighborhood = buildNeighborhood(cg, target.node);
  if (!related) return { kind: "analyzed", target: targetNeighborhood };
  return {
    kind: "analyzed", target: targetNeighborhood, related: buildNeighborhood(cg, related.node),
    paths: { targetToRelated: cg.findPath(target.node.id, related.node.id), relatedToTarget: cg.findPath(related.node.id, target.node.id) },
  };
}

function formatAnalysis(analysis: Analysis): string {
  if (analysis.kind === "candidates") return formatCandidates(analysis.result);
  const targetOutput = formatNeighborhood(analysis.target, "Target");
  if (!analysis.related) return ["## Code Analysis", "", targetOutput, caveat()].join("\n");
  return [
    "## Code Analysis", "", targetOutput, "", formatNeighborhood(analysis.related, "Related"), "",
    formatPaths(analysis.paths!, analysis.target.node, analysis.related.node), caveat(),
  ].join("\n");
}

export function runAnalyzeCode(cg: CodeGraphInstance, params: AnalyzeCodeParams): string {
  return formatAnalysis(buildAnalysis(cg, params));
}

export function runAnalyzeCodeResult(cg: CodeGraphInstance, params: AnalyzeCodeParams): { text: string; structuredContent: AnalyzeOutput } {
  const analysis = buildAnalysis(cg, params);
  const text = formatAnalysis(analysis);
  if (analysis.kind === "candidates") {
    return { text, structuredContent: {
      projectRoot: cg.getProjectRoot(), status: "candidates", selector: analysis.selector, reason: analysis.result.reason,
      candidates: sortCandidates(analysis.result.nodes).slice(0, sectionLimit).map(node => ({
        ...projectSymbol(node), selector: { symbol: node.name, file: node.filePath, line: node.startLine },
      })),
      total: analysis.result.nodes.length,
    } };
  }
  return { text, structuredContent: {
    projectRoot: cg.getProjectRoot(), status: "analyzed", target: projectNeighborhood(analysis.target),
    ...(analysis.related ? { related: projectNeighborhood(analysis.related) } : {}),
    ...(analysis.paths ? { paths: {
      targetToRelated: projectPath(analysis.paths.targetToRelated),
      relatedToTarget: projectPath(analysis.paths.relatedToTarget),
    } } : {}),
  } };
}

function projectPath(path: GraphPath): Static<typeof pathSchema> | null {
  if (!path) return null;
  return {
    steps: path.slice(0, pathEdgeLimit + 1).map((step, index) => ({
      symbol: projectSymbol(step.node), ...(index > 0 ? { kind: step.edge?.kind ?? "references" } : {}),
    })),
    total: path.length - 1,
  };
}

function projectSymbol(node: Node): Static<typeof symbolSchema> {
  return {
    name: node.name, kind: node.kind, file: node.filePath, line: node.startLine,
    ...(node.qualifiedName && node.qualifiedName !== node.name ? { qualifiedName: node.qualifiedName } : {}),
    ...(node.signature ? { signature: node.signature } : {}),
  };
}

function projectNeighborhood(neighborhood: Neighborhood): Static<typeof neighborhoodSchema> {
  const relations = (groups: RelatedGroup[]) => ({
    items: groups.slice(0, sectionLimit).map(item => ({ symbol: projectSymbol(item.node), kinds: item.edgeKinds })),
    total: groups.length,
  });
  return {
    symbol: projectSymbol(neighborhood.node), incoming: relations(neighborhood.callers), outgoing: relations(neighborhood.callees),
    impact: { items: neighborhood.residual.slice(0, sectionLimit).map(projectSymbol), total: neighborhood.residual.length },
    testFiles: neighborhood.testFiles,
  };
}

function resolveSelector(cg: CodeGraphInstance, selector: SymbolSelector, label: string): Resolution {
  const symbol = requiredSymbol(selector?.symbol, label);
  const file = validateFile(selector?.file, label);
  const line = validateLine(selector?.line, label);
  if (file !== undefined) return resolveFileSelector(cg, symbol, file, line, label);

  let results = cg.searchNodes(symbol, { limit: 50 });
  if (results.length === 0 && /[./]|::/.test(symbol)) {
    const tail = lastQualifierPart(symbol);
    if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit: 50 });
  }
  const exact = results.map((result) => result.node).filter((node) => matchesSymbol(node, symbol));
  const selected = exact.filter((node) => line === undefined || node.startLine === line);

  if (selected.length === 1) return { kind: "resolved", node: selected[0]! };
  if (selected.length > 1) return { kind: "candidates", reason: "ambiguous", title: `Multiple exact definitions match ${JSON.stringify(symbol)}. Refine ${label} with file and line.`, nodes: selected };
  if (exact.length > 0 && line !== undefined) {
    return { kind: "candidates", reason: "not_found", title: `No exact definition of ${JSON.stringify(symbol)} matches the supplied selector.`, nodes: exact };
  }

  return {
    kind: "candidates",
    reason: "not_found",
    title: exact.length === 0
      ? `No exact definition matches ${JSON.stringify(symbol)}. Select a likely candidate before analysis.`
      : `No definition matches ${JSON.stringify(symbol)}.`,
    nodes: results.map((result) => result.node),
  };
}

function resolveFileSelector(cg: CodeGraphInstance, symbol: string, file: string, line: number | undefined, label: string): Resolution {
  const fileNodes = (cg as CodeGraphWithNodesInFile).getNodesInFile(file);
  const exact = fileNodes.filter((node) => matchesSymbol(node, symbol));
  const selected = exact.filter((node) => line === undefined || node.startLine === line);

  if (selected.length === 1) return { kind: "resolved", node: selected[0]! };
  if (selected.length > 1) return { kind: "candidates", reason: "ambiguous", title: `Multiple exact definitions match ${JSON.stringify(symbol)} in ${JSON.stringify(file)}. Refine ${label} with line.`, nodes: selected };
  if (exact.length > 0) return { kind: "candidates", reason: "not_found", title: `No exact definition of ${JSON.stringify(symbol)} matches the supplied selector.`, nodes: exact };

  return {
    kind: "candidates",
    reason: "not_found",
    title: `No exact definition matches ${JSON.stringify(symbol)} in ${JSON.stringify(file)}. Select a likely candidate before analysis.`,
    nodes: fileNodes.filter((node) => node.name.toLowerCase().includes(symbol.toLowerCase())),
  };
}

function formatCandidates(result: Extract<Resolution, { kind: "candidates" }>): string {
  const nodes = sortCandidates(result.nodes).slice(0, sectionLimit);
  const lines = ["## Code Analysis", "", result.title];
  if (nodes.length === 0) return [...lines, "", "No likely code-symbol candidates found."].join("\n");

  lines.push("", `## Candidates (${nodes.length} of ${result.nodes.length})`, "");
  for (const node of nodes) lines.push(formatCandidate(node));
  if (result.nodes.length > nodes.length) lines.push("", `Showing the first ${nodes.length} candidates.`);
  return lines.join("\n");
}

function buildNeighborhood(cg: CodeGraphInstance, node: Node): Neighborhood {
  const callers = groupRelations(cg.getCallers(node.id) as RelatedNode[]);
  const callees = groupRelations(cg.getCallees(node.id) as RelatedNode[]);
  const directIds = new Set([node.id, ...callers.map((item) => item.node.id), ...callees.map((item) => item.node.id)]);
  const impact = cg.getImpactRadius(node.id, impactDepth);
  const residual = sortNodes([...impact.nodes.values()].filter((item) => !directIds.has(item.id)));
  const testFiles = uniqueTestFiles([...callers.map((item) => item.node), ...residual]);
  return { node, callers, callees, residual, testFiles };
}

function formatNeighborhood(neighborhood: Neighborhood, label: string): string {
  const { node, callers, callees, residual, testFiles } = neighborhood;
  return [
    `## ${label}: ${node.name} (${node.kind})`,
    `${node.filePath}:${node.startLine}`,
    node.qualifiedName !== node.name ? `Qualified: ${node.qualifiedName}` : "",
    node.signature ? `Signature: \`${node.signature}\`` : "",
    "",
    formatRelations("Incoming Relationships", callers, node, "incoming"),
    "",
    formatRelations("Outgoing Relationships", callees, node, "outgoing"),
    "",
    formatNodes("Wider Impact", residual),
    "",
    formatTestFiles(testFiles),
  ].filter((line) => line !== "").join("\n");
}

function formatRelations(title: string, related: RelatedGroup[], target: Node, direction: "incoming" | "outgoing"): string {
  const shown = related.slice(0, sectionLimit);
  const lines = [`## ${title} (${shown.length} of ${related.length})`];
  for (const item of shown) {
    const edges = item.edgeKinds.join(", ");
    const relation = direction === "incoming"
      ? `${formatNode(item.node)} --${edges}→ ${target.name}`
      : `${target.name} --${edges}→ ${formatNode(item.node)}`;
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

function formatPaths(paths: { targetToRelated: GraphPath; relatedToTarget: GraphPath }, from: Node, to: Node): string {
  return [
    "## Graph Paths",
    formatPath("Target to Related", paths.targetToRelated, from, to),
    "",
    formatPath("Related to Target", paths.relatedToTarget, to, from),
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
  return `- ${candidateLabel(node)}: ${node.name} (${node.kind})\n   Selector: { "symbol": ${JSON.stringify(node.name)}, "file": ${JSON.stringify(node.filePath)}, "line": ${node.startLine} }${qualified}${signature}`;
}

function formatNode(node: Node): string {
  return `${node.name} (${node.kind}) at ${node.filePath}:${node.startLine}`;
}

function groupRelations(relations: RelatedNode[]): RelatedGroup[] {
  const grouped = new Map<string, { node: Node; edgeKinds: Set<string> }>();
  for (const relation of relations) {
    const current = grouped.get(relation.node.id) ?? { node: relation.node, edgeKinds: new Set<string>() };
    current.edgeKinds.add(relation.edge?.kind ?? "references");
    grouped.set(relation.node.id, current);
  }
  return [...grouped.values()]
    .map(({ node, edgeKinds }) => ({ node, edgeKinds: [...edgeKinds].sort() }))
    .sort((a, b) => compareNodes(a.node, b.node));
}

function sortNodes(nodes: Node[]): Node[] {
  return [...nodes].sort(compareNodes);
}

function sortCandidates(nodes: Node[]): Node[] {
  return [...nodes].sort((a, b) => candidatePriority(a) - candidatePriority(b) || compareNodes(a, b));
}

function candidatePriority(node: Node): number {
  return node.kind === "file" ? 2 : node.kind === "import" ? 1 : 0;
}

function candidateLabel(node: Node): string {
  return node.kind === "file" ? "File node" : node.kind === "import" ? "Import node" : "Definition";
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
  return "\nTarget selection uses exact matching within a bounded candidate search. Static graph relationships can omit unresolved, generated, dynamic, or runtime behavior and can contain ambiguous or incorrect resolutions. They are not runtime proof.";
}
