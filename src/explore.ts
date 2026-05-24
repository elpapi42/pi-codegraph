import { existsSync, readFileSync } from "node:fs";
import type { CodeGraphInstance, Edge, Node } from "./codegraph-sdk.js";
import { resolveWithinRoot } from "./paths.js";
import { clampNumber, requiredString } from "./validate.js";

export interface ExploreRunParams {
  query: unknown;
  maxFiles?: unknown;
}

interface ExploreSubgraph {
  nodes: Map<string, Node>;
  edges: Edge[];
  roots: string[];
}

interface FileGroup {
  nodes: Node[];
  score: number;
}

interface ExploreOutputBudget {
  maxOutputChars: number;
  defaultMaxFiles: number;
  maxCharsPerFile: number;
  gapThreshold: number;
  maxSymbolsInFileHeader: number;
  maxEdgesPerRelationshipKind: number;
  includeRelationships: boolean;
  includeAdditionalFiles: boolean;
  includeCompletenessSignal: boolean;
  includeBudgetNote: boolean;
}

interface SourceRange {
  start: number;
  end: number;
  name: string;
  kind: string;
  importance: number;
}

interface SourceCluster {
  start: number;
  end: number;
  symbols: string[];
  score: number;
  maxImportance: number;
}

const ENVELOPE_KINDS = new Set([
  "file",
  "module",
  "class",
  "struct",
  "interface",
  "enum",
  "namespace",
  "protocol",
  "trait",
  "component",
]);

export async function runExplore(cg: CodeGraphInstance, params: ExploreRunParams): Promise<string> {
  const query = requiredString(params.query, "explore.query");
  const projectRoot = cg.getProjectRoot();
  const budget = getBudgetForGraph(cg);
  const maxFiles = clampNumber(params.maxFiles, budget.defaultMaxFiles, 1, 20);

  const subgraph = await cg.findRelevantContext(query, {
    searchLimit: 8,
    traversalDepth: 3,
    maxNodes: 200,
    minScore: 0.2,
  }) as ExploreSubgraph;

  if (subgraph.nodes.size === 0) {
    return `No relevant code found for "${query}"`;
  }

  const entryNodeIds = new Set(subgraph.roots);
  const connectedToEntry = findNodesConnectedToEntry(subgraph, entryNodeIds);
  const fileGroups = groupNodesByFile(subgraph, entryNodeIds, connectedToEntry);
  const sortedFiles = sortRelevantFiles(fileGroups, query);

  const lines: string[] = [
    `## Exploration: ${query}`,
    "",
    `Found ${subgraph.nodes.size} symbols across ${fileGroups.size} files.`,
    "",
  ];

  addRelationships(lines, subgraph, budget);

  lines.push("### Source Code", "");

  let totalChars = lines.join("\n").length;
  let filesIncluded = 0;
  let anyFileTrimmed = false;

  for (const [filePath, group] of sortedFiles) {
    if (filesIncluded >= maxFiles) break;
    if (totalChars > budget.maxOutputChars * 0.9) break;

    const fileContent = readProjectFile(projectRoot, filePath);
    if (fileContent == null) continue;

    const fileLines = fileContent.split("\n");
    const ranges = buildSourceRanges(cg, subgraph, group, fileLines, entryNodeIds, connectedToEntry);
    if (ranges.length === 0) continue;

    const clusters = clusterRanges(ranges, budget.gapThreshold);
    const fileResult = buildFileSection(filePath, group, fileLines, clusters, budget);
    if (!fileResult) continue;

    let { fileHeader, fileSection, trimmed } = fileResult;
    if (trimmed) anyFileTrimmed = true;

    let hitTotalCap = false;
    if (totalChars + fileSection.length + 200 > budget.maxOutputChars) {
      const remaining = budget.maxOutputChars - totalChars - 200;
      if (remaining < 500) break;
      fileSection = `${fileSection.slice(0, remaining)}\n... (trimmed) ...`;
      trimmed = true;
      hitTotalCap = true;
      anyFileTrimmed = true;
    }

    lines.push(fileHeader, "", `\`\`\`${group.nodes[0]?.language ?? ""}`, fileSection, "```", "");
    totalChars += fileSection.length + 200;
    filesIncluded++;
    if (hitTotalCap) break;
  }

  addAdditionalFiles(lines, sortedFiles, fileGroups, filesIncluded, budget);
  addCompletionNotes(lines, cg, filesIncluded, anyFileTrimmed, budget);

  return capExploreOutput(lines.join("\n"), budget);
}

function getBudgetForGraph(cg: CodeGraphInstance): ExploreOutputBudget {
  try {
    return getExploreOutputBudget(cg.getStats().fileCount);
  } catch {
    return getExploreOutputBudget(Infinity);
  }
}

export function getExploreBudget(fileCount: number): number {
  if (fileCount < 500) return 1;
  if (fileCount < 5000) return 2;
  if (fileCount < 15000) return 3;
  if (fileCount < 25000) return 4;
  return 5;
}

export function getExploreOutputBudget(fileCount: number): ExploreOutputBudget {
  if (fileCount < 500) {
    return {
      maxOutputChars: 18000,
      defaultMaxFiles: 5,
      maxCharsPerFile: 3800,
      gapThreshold: 8,
      maxSymbolsInFileHeader: 6,
      maxEdgesPerRelationshipKind: 6,
      includeRelationships: true,
      includeAdditionalFiles: false,
      includeCompletenessSignal: false,
      includeBudgetNote: false,
    };
  }
  if (fileCount < 5000) {
    return {
      maxOutputChars: 13000,
      defaultMaxFiles: 6,
      maxCharsPerFile: 2500,
      gapThreshold: 10,
      maxSymbolsInFileHeader: 8,
      maxEdgesPerRelationshipKind: 8,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
    };
  }
  if (fileCount < 15000) {
    return {
      maxOutputChars: 35000,
      defaultMaxFiles: 12,
      maxCharsPerFile: 7000,
      gapThreshold: 15,
      maxSymbolsInFileHeader: 15,
      maxEdgesPerRelationshipKind: 15,
      includeRelationships: true,
      includeAdditionalFiles: true,
      includeCompletenessSignal: true,
      includeBudgetNote: true,
    };
  }
  return {
    maxOutputChars: 38000,
    defaultMaxFiles: 14,
    maxCharsPerFile: 7000,
    gapThreshold: 15,
    maxSymbolsInFileHeader: 15,
    maxEdgesPerRelationshipKind: 15,
    includeRelationships: true,
    includeAdditionalFiles: true,
    includeCompletenessSignal: true,
    includeBudgetNote: true,
  };
}

function findNodesConnectedToEntry(subgraph: ExploreSubgraph, entryNodeIds: Set<string>): Set<string> {
  const connectedToEntry = new Set<string>();
  for (const edge of subgraph.edges) {
    if (entryNodeIds.has(edge.source)) connectedToEntry.add(edge.target);
    if (entryNodeIds.has(edge.target)) connectedToEntry.add(edge.source);
  }
  return connectedToEntry;
}

function groupNodesByFile(subgraph: ExploreSubgraph, entryNodeIds: Set<string>, connectedToEntry: Set<string>): Map<string, FileGroup> {
  const fileGroups = new Map<string, FileGroup>();

  for (const node of subgraph.nodes.values()) {
    if (node.kind === "import" || node.kind === "export") continue;

    const group = fileGroups.get(node.filePath) ?? { nodes: [], score: 0 };
    group.nodes.push(node);
    if (entryNodeIds.has(node.id)) {
      group.score += 10;
    } else if (connectedToEntry.has(node.id)) {
      group.score += 3;
    } else {
      group.score += 1;
    }
    fileGroups.set(node.filePath, group);
  }

  return fileGroups;
}

function sortRelevantFiles(fileGroups: Map<string, FileGroup>, query: string): Array<[string, FileGroup]> {
  const relevantFiles = [...fileGroups.entries()].filter(([, group]) => group.score >= 3);
  const queryTerms = query.toLowerCase().split(/\s+/).filter((term) => term.length >= 3);

  return relevantFiles.sort((a, b) => {
    const aPath = a[0].toLowerCase();
    const bPath = b[0].toLowerCase();

    const aRelevant = hasQueryRelevance(aPath, a[1].nodes, queryTerms);
    const bRelevant = hasQueryRelevance(bPath, b[1].nodes, queryTerms);
    if (aRelevant !== bRelevant) return aRelevant ? -1 : 1;

    const aLow = isLowValueFile(aPath);
    const bLow = isLowValueFile(bPath);
    if (aLow !== bLow) return aLow ? 1 : -1;

    if (a[1].score !== b[1].score) return b[1].score - a[1].score;
    return b[1].nodes.length - a[1].nodes.length;
  });
}

function hasQueryRelevance(filePath: string, nodes: Node[], queryTerms: string[]): boolean {
  if (queryTerms.some((term) => filePath.includes(term))) return true;
  return nodes.some((node) => queryTerms.some((term) => node.name.toLowerCase().includes(term)));
}

function isLowValueFile(filePath: string): boolean {
  return /\/(tests?|__tests?__|spec)\//i.test(filePath) || /\bicons?\b/i.test(filePath) || /\bi18n\b/i.test(filePath);
}

function addRelationships(lines: string[], subgraph: ExploreSubgraph, budget: ExploreOutputBudget): void {
  if (!budget.includeRelationships) return;

  const significantEdges = subgraph.edges.filter((edge) => edge.kind !== "contains");
  if (significantEdges.length === 0) return;

  lines.push("### Relationships", "");

  const byKind = new Map<string, Array<{ source: string; target: string }>>();
  for (const edge of significantEdges) {
    const sourceNode = subgraph.nodes.get(edge.source);
    const targetNode = subgraph.nodes.get(edge.target);
    if (!sourceNode || !targetNode) continue;

    const group = byKind.get(edge.kind) ?? [];
    group.push({ source: sourceNode.name, target: targetNode.name });
    byKind.set(edge.kind, group);
  }

  for (const [kind, edges] of byKind) {
    const cap = budget.maxEdgesPerRelationshipKind;
    const shown = edges.slice(0, cap);
    lines.push(`**${kind}:**`);
    for (const edge of shown) {
      lines.push(`- ${edge.source} → ${edge.target}`);
    }
    if (edges.length > cap) {
      lines.push(`- ... and ${edges.length - cap} more`);
    }
    lines.push("");
  }
}

function readProjectFile(projectRoot: string, filePath: string): string | undefined {
  let absPath: string;
  try {
    absPath = resolveWithinRoot(projectRoot, filePath);
  } catch {
    return undefined;
  }

  if (!existsSync(absPath)) return undefined;

  try {
    return readFileSync(absPath, "utf-8");
  } catch {
    return undefined;
  }
}

function buildSourceRanges(
  cg: CodeGraphInstance,
  subgraph: ExploreSubgraph,
  group: FileGroup,
  fileLines: string[],
  entryNodeIds: Set<string>,
  connectedToEntry: Set<string>,
): SourceRange[] {
  const ranges: SourceRange[] = group.nodes
    .filter((node) => node.startLine > 0 && node.endLine > 0)
    .filter((node) => !(ENVELOPE_KINDS.has(node.kind) && (node.endLine - node.startLine + 1) > fileLines.length * 0.5))
    .map((node) => {
      let importance = 1;
      if (entryNodeIds.has(node.id)) importance = 10;
      else if (connectedToEntry.has(node.id)) importance = 3;
      return { start: node.startLine, end: node.endLine, name: node.name, kind: node.kind, importance };
    });

  const edgeLines = new Set<string>();
  for (const node of group.nodes) {
    const outgoing = cg.getOutgoingEdges(node.id);
    for (const edge of outgoing) {
      if (!edge.line || edge.line <= 0 || edge.kind === "contains") continue;
      const key = `${edge.line}:${edge.target}`;
      if (edgeLines.has(key)) continue;
      edgeLines.add(key);
      const targetNode = subgraph.nodes.get(edge.target);
      const targetName = targetNode?.name ?? edge.kind;
      ranges.push({ start: edge.line, end: edge.line, name: targetName, kind: edge.kind, importance: 2 });
    }
  }

  return ranges.sort((a, b) => a.start - b.start);
}

function clusterRanges(ranges: SourceRange[], gapThreshold: number): SourceCluster[] {
  const clusters: SourceCluster[] = [];
  let current: SourceCluster = {
    start: ranges[0]!.start,
    end: ranges[0]!.end,
    symbols: [`${ranges[0]!.name}(${ranges[0]!.kind})`],
    score: ranges[0]!.importance,
    maxImportance: ranges[0]!.importance,
  };

  for (let i = 1; i < ranges.length; i++) {
    const range = ranges[i]!;
    if (range.start <= current.end + gapThreshold) {
      current.end = Math.max(current.end, range.end);
      current.symbols.push(`${range.name}(${range.kind})`);
      current.score += range.importance;
      current.maxImportance = Math.max(current.maxImportance, range.importance);
    } else {
      clusters.push(current);
      current = {
        start: range.start,
        end: range.end,
        symbols: [`${range.name}(${range.kind})`],
        score: range.importance,
        maxImportance: range.importance,
      };
    }
  }
  clusters.push(current);
  return clusters;
}

function buildFileSection(
  filePath: string,
  group: FileGroup,
  fileLines: string[],
  clusters: SourceCluster[],
  budget: ExploreOutputBudget,
): { fileHeader: string; fileSection: string; trimmed: boolean } | undefined {
  const contextPadding = 3;
  const withLineNumbers = exploreLineNumbersEnabled();
  const buildSection = (cluster: SourceCluster): string => {
    const startIdx = Math.max(0, cluster.start - 1 - contextPadding);
    const endIdx = Math.min(fileLines.length, cluster.end + contextPadding);
    const slice = fileLines.slice(startIdx, endIdx).join("\n");
    return withLineNumbers ? numberSourceLines(slice, startIdx + 1) : slice;
  };

  const gapMarker = "\n\n... (gap) ...\n\n";
  const rankedClusters = clusters
    .map((cluster, index) => ({ index, span: cluster.end - cluster.start + 1, cluster }))
    .sort((a, b) => {
      if (b.cluster.maxImportance !== a.cluster.maxImportance) return b.cluster.maxImportance - a.cluster.maxImportance;
      const densityA = a.cluster.score / a.span;
      const densityB = b.cluster.score / b.span;
      if (densityB !== densityA) return densityB - densityA;
      if (b.cluster.score !== a.cluster.score) return b.cluster.score - a.cluster.score;
      return a.span - b.span;
    });

  const chosenIndices = new Set<number>();
  let projectedChars = 0;
  for (const ranked of rankedClusters) {
    const sectionLen = buildSection(ranked.cluster).length + (chosenIndices.size > 0 ? gapMarker.length : 0);
    if (chosenIndices.size === 0) {
      chosenIndices.add(ranked.index);
      projectedChars += sectionLen;
      continue;
    }
    if (projectedChars + sectionLen > budget.maxCharsPerFile) continue;
    chosenIndices.add(ranked.index);
    projectedChars += sectionLen;
  }

  let fileSection = "";
  const allSymbols: string[] = [];
  let fileTrimmed = false;
  for (let i = 0; i < clusters.length; i++) {
    if (!chosenIndices.has(i)) continue;
    const cluster = clusters[i]!;
    const section = buildSection(cluster);
    if (fileSection.length > 0) fileSection += gapMarker;
    fileSection += section;
    allSymbols.push(...cluster.symbols);
  }

  if (fileSection.length === 0) return undefined;

  if (fileSection.length > budget.maxCharsPerFile) {
    fileSection = `${fileSection.slice(0, budget.maxCharsPerFile)}\n... (trimmed) ...`;
    fileTrimmed = true;
  }
  if (chosenIndices.size < clusters.length) {
    fileTrimmed = true;
  }

  const fileHeader = formatFileHeader(filePath, allSymbols, group, budget);
  return { fileHeader, fileSection, trimmed: fileTrimmed };
}

function formatFileHeader(filePath: string, allSymbols: string[], group: FileGroup, budget: ExploreOutputBudget): string {
  const symbols = allSymbols.length > 0 ? allSymbols : group.nodes.map((node) => `${node.name}(${node.kind})`);
  const symbolCounts = new Map<string, number>();
  for (const symbol of symbols) {
    symbolCounts.set(symbol, (symbolCounts.get(symbol) ?? 0) + 1);
  }
  const sortedSymbols = [...symbolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name]) => name);
  const headerSymbols = sortedSymbols.slice(0, budget.maxSymbolsInFileHeader);
  const omittedCount = sortedSymbols.length - headerSymbols.length;
  const headerSuffix = omittedCount > 0 ? `${headerSymbols.join(", ")}, +${omittedCount} more` : headerSymbols.join(", ");
  return headerSuffix ? `#### ${filePath} — ${headerSuffix}` : `#### ${filePath}`;
}

function addAdditionalFiles(
  lines: string[],
  sortedFiles: Array<[string, FileGroup]>,
  fileGroups: Map<string, FileGroup>,
  filesIncluded: number,
  budget: ExploreOutputBudget,
): void {
  if (!budget.includeAdditionalFiles) return;

  const remainingRelevant = sortedFiles.slice(filesIncluded);
  const peripheralFiles = [...fileGroups.entries()]
    .filter(([, group]) => group.score < 3)
    .sort((a, b) => b[1].score - a[1].score);
  const remainingFiles = [...remainingRelevant, ...peripheralFiles];
  if (remainingFiles.length === 0) return;

  lines.push("### Additional relevant files (not shown)", "");
  for (const [filePath, group] of remainingFiles.slice(0, 10)) {
    const symbols = group.nodes.map((node) => `${node.name}:${node.startLine}`).join(", ");
    lines.push(`- ${filePath}: ${symbols}`);
  }
  if (remainingFiles.length > 10) {
    lines.push(`- ... and ${remainingFiles.length - 10} more files`);
  }
}

function addCompletionNotes(lines: string[], cg: CodeGraphInstance, filesIncluded: number, anyFileTrimmed: boolean, budget: ExploreOutputBudget): void {
  if (budget.includeCompletenessSignal) {
    lines.push("", "---");
    if (anyFileTrimmed) {
      lines.push(`> Relevant source sections were included for ${filesIncluded} files, but some sections were trimmed for size. Use \`node\` or \`read\` for exact full-source detail when needed.`);
    } else {
      lines.push(`> Relevant source sections are included above for ${filesIncluded} files. Do not re-read these sections just to rediscover them; use \`node\` or \`read\` only for exact full-source detail before editing.`);
    }
  } else if (anyFileTrimmed) {
    lines.push("", "> Some file sections were trimmed for size. Use `node` or `read` for full source if needed.");
  }

  if (!budget.includeBudgetNote) return;

  try {
    const stats = cg.getStats();
    const callBudget = getExploreBudget(stats.fileCount);
    lines.push("", `> **Explore budget: ${callBudget} calls max for this project (${stats.fileCount.toLocaleString()} files indexed).** Stop exploring and synthesize your answer once you've used ${callBudget} calls unless new information changes the task.`);
  } catch {
    // Stats unavailable — skip budget note.
  }
}

function capExploreOutput(output: string, budget: ExploreOutputBudget): string {
  if (output.length <= budget.maxOutputChars) return output;

  const cut = output.slice(0, budget.maxOutputChars);
  const lastNewline = cut.lastIndexOf("\n");
  const safe = lastNewline > budget.maxOutputChars * 0.8 ? cut.slice(0, lastNewline) : cut;
  return `${safe}\n\n... (explore output truncated to budget — use node or read for more)`;
}

function exploreLineNumbersEnabled(): boolean {
  return process.env.CODEGRAPH_EXPLORE_LINENUMS !== "0";
}

function numberSourceLines(slice: string, firstLineNumber: number): string {
  const out: string[] = [];
  const split = slice.split("\n");
  for (let i = 0; i < split.length; i++) {
    out.push(`${firstLineNumber + i}\t${split[i]}`);
  }
  return out.join("\n");
}
