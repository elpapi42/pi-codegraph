import * as CodeGraphModule from "@colbymchenry/codegraph";

export const CodeGraph = CodeGraphModule.CodeGraph ?? CodeGraphModule.default;
export const { findNearestCodeGraphRoot, isInitialized } = CodeGraphModule;

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
