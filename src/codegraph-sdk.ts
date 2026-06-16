import * as CodeGraphModule from "@colbymchenry/codegraph";

type CodeGraphPackage = typeof import("@colbymchenry/codegraph");

const sdk = ((CodeGraphModule as Record<string, unknown>).default ??
  (CodeGraphModule as Record<string, unknown>)) as Partial<CodeGraphPackage>;

export const CodeGraph = sdk.CodeGraph as CodeGraphPackage["CodeGraph"];
export const findNearestCodeGraphRoot =
  sdk.findNearestCodeGraphRoot as CodeGraphPackage["findNearestCodeGraphRoot"];
export const isInitialized = sdk.isInitialized as CodeGraphPackage["isInitialized"];

if (
  typeof CodeGraph !== "function" ||
  typeof findNearestCodeGraphRoot !== "function" ||
  typeof isInitialized !== "function"
) {
  throw new Error(
    "Failed to load CodeGraph SDK from @colbymchenry/codegraph. Check that the installed npm package includes the platform bundle required for this runtime.",
  );
}

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
