import path from "node:path";

export function normalizeProjectRelativePath(input: string): string {
  return input.replace(/^@/, "").replace(/^\.\//, "").replace(/\\/g, "/");
}

export function isWithinRoot(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  const relative = path.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveWithinRoot(root: string, relativePath: string): string {
  const normalized = normalizeProjectRelativePath(relativePath);
  const resolved = path.resolve(root, normalized);
  if (!isWithinRoot(root, resolved)) {
    throw new Error(`Path escapes active project root: ${relativePath}`);
  }
  return resolved;
}

export function matchesPathPrefix(filePath: string, prefix?: string): boolean {
  if (!prefix) return true;
  const normalizedFile = normalizeProjectRelativePath(filePath);
  const normalizedPrefix = normalizeProjectRelativePath(prefix).replace(/\/$/, "");
  return normalizedFile === normalizedPrefix || normalizedFile.startsWith(`${normalizedPrefix}/`);
}

export function globToRegex(pattern: string): RegExp {
  const sentinel = "__CODEGRAPH_GLOBSTAR__";
  const escaped = normalizeProjectRelativePath(pattern)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, sentinel)
    .replace(/\*/g, "[^/]*")
    .replace(/\?/g, "[^/]")
    .replaceAll(sentinel, ".*");

  return new RegExp(`^${escaped}$`);
}
