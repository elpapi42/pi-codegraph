import type { CodeGraphInstance, Node } from "./codegraph-sdk.js";

const RUST_PATH_PREFIXES = new Set(["crate", "self", "super"]);

export function lastQualifierPart(symbol: string): string | null {
  const parts = symbol.split(/::|[./]/).filter((part) => part.length > 0);
  return parts.at(-1) ?? null;
}

export function matchesSymbol(node: Node, symbol: string): boolean {
  if (node.name === symbol) return true;
  if (node.kind === "file" && node.name.replace(/\.[^.]+$/, "") === symbol) return true;

  if (!/[./]|::/.test(symbol)) return false;
  const parts = symbol.split(/::|[./]/).filter((part) => part.length > 0);
  if (parts.length < 2) return false;

  const lastPart = parts.at(-1);
  if (!lastPart || node.name !== lastPart) return false;

  const colonSuffix = parts.join("::");
  if (node.qualifiedName.includes(colonSuffix)) return true;

  const containerHints = parts.slice(0, -1).filter((part) => !RUST_PATH_PREFIXES.has(part));
  if (containerHints.length === 0) return false;

  const segments = node.filePath.split("/").filter((segment) => segment.length > 0);
  return containerHints.every((hint) =>
    segments.some((segment) => segment === hint || segment.replace(/\.[^.]+$/, "") === hint),
  );
}

export function findSymbol(cg: CodeGraphInstance, symbol: string): { node: Node; note: string } | null {
  const isQualified = /[./]|::/.test(symbol);
  const limit = isQualified ? 50 : 10;
  let results = cg.searchNodes(symbol, { limit });

  if (isQualified && results.length === 0) {
    const tail = lastQualifierPart(symbol);
    if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit });
  }

  if (results.length === 0 || !results[0]) return null;

  const exactMatches = results.filter((result) => matchesSymbol(result.node, symbol));

  if (exactMatches.length === 1) {
    return { node: exactMatches[0]!.node, note: "" };
  }

  if (exactMatches.length > 1) {
    const picked = exactMatches[0]!.node;
    const others = exactMatches.slice(1).map((result) =>
      `${result.node.name} (${result.node.kind}) at ${result.node.filePath}:${result.node.startLine}`,
    );
    return {
      node: picked,
      note: `\n\n> **Note:** ${exactMatches.length} symbols named "${symbol}". Showing results for \`${picked.filePath}:${picked.startLine}\`. Others: ${others.join(", ")}`,
    };
  }

  if (isQualified) return null;
  return { node: results[0]!.node, note: "" };
}

export function findAllSymbols(cg: CodeGraphInstance, symbol: string): { nodes: Node[]; note: string } {
  let results = cg.searchNodes(symbol, { limit: 50 });

  if (results.length === 0 && /[./]|::/.test(symbol)) {
    const tail = lastQualifierPart(symbol);
    if (tail && tail !== symbol) results = cg.searchNodes(tail, { limit: 50 });
  }

  if (results.length === 0) {
    return { nodes: [], note: "" };
  }

  const exactMatches = results.filter((result) => matchesSymbol(result.node, symbol));

  if (exactMatches.length <= 1) {
    const node = exactMatches[0]?.node ?? results[0]!.node;
    return { nodes: [node], note: "" };
  }

  const locations = exactMatches.map((result) =>
    `${result.node.kind} at ${result.node.filePath}:${result.node.startLine}`,
  );
  return {
    nodes: exactMatches.map((result) => result.node),
    note: `\n\n> **Note:** Aggregated results across ${exactMatches.length} symbols named "${symbol}": ${locations.join(", ")}`,
  };
}
