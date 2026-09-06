import type { Node } from "./codegraph-sdk.js";

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
