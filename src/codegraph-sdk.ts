import * as CodeGraphModule from "@colbymchenry/codegraph";

type CodeGraphPackage = typeof import("@colbymchenry/codegraph");

type CodeGraphExports = Partial<CodeGraphPackage> & Record<string, unknown>;

const namespaceExports = CodeGraphModule as unknown as CodeGraphExports;
const defaultExports = namespaceExports.default as unknown;
const defaultObject =
  defaultExports && (typeof defaultExports === "object" || typeof defaultExports === "function")
    ? (defaultExports as CodeGraphExports)
    : undefined;

function exportedFunction<K extends keyof CodeGraphPackage>(name: K): CodeGraphPackage[K] | undefined {
  const namespaceValue = namespaceExports[name];
  if (typeof namespaceValue === "function") return namespaceValue as CodeGraphPackage[K];

  const defaultValue = defaultObject?.[name];
  if (typeof defaultValue === "function") return defaultValue as CodeGraphPackage[K];

  return undefined;
}

const resolvedCodeGraph =
  exportedFunction("CodeGraph") ??
  (typeof defaultExports === "function" ? (defaultExports as CodeGraphPackage["CodeGraph"]) : undefined);
const resolvedFindNearestCodeGraphRoot = exportedFunction("findNearestCodeGraphRoot");
const resolvedIsInitialized = exportedFunction("isInitialized");

if (!resolvedCodeGraph || !resolvedFindNearestCodeGraphRoot || !resolvedIsInitialized) {
  throw new Error(
    "Failed to load CodeGraph SDK from @colbymchenry/codegraph. Check that the installed npm package includes the platform bundle required for this runtime.",
  );
}

export const CodeGraph = resolvedCodeGraph;
export const findNearestCodeGraphRoot = resolvedFindNearestCodeGraphRoot;
export const isInitialized = resolvedIsInitialized;

export type {
  CodeGraph as CodeGraphInstance,
  Edge,
  FileRecord,
  GraphStats,
  IndexProgress,
  IndexResult,
  Node,
  SyncResult,
} from "@colbymchenry/codegraph";
