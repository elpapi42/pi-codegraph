import { execFile, type ExecFileOptions } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { requiredString, clampNumber } from "./validate.js";
import type { CodeGraphInstance } from "./codegraph-sdk.js";

const require = createRequire(import.meta.url);
const maxBuffer = 128 * 1024;

export interface ExploreCodeParams {
  query: unknown;
  maxFiles?: unknown;
}

export interface ExploreCodeCommand {
  file: string;
  args: string[];
  options: ExecFileOptions;
}

type ExecuteFile = (command: ExploreCodeCommand) => Promise<{ stdout: string; stderr: string }>;

export function buildExploreCodeCommand(root: string, params: ExploreCodeParams, signal?: AbortSignal): ExploreCodeCommand {
  const query = requiredString(params.query, "explore_code.query");
  const maxFiles = params.maxFiles == null ? undefined : clampNumber(params.maxFiles, 20, 1, 20);
  const packageRoot = path.dirname(require.resolve("@colbymchenry/codegraph/package.json"));
  const args = [path.join(packageRoot, "npm-shim.js"), "--no-color", "explore", "--path", root];
  if (maxFiles !== undefined) args.push("--max-files", String(maxFiles));
  args.push("--", query);

  const env: NodeJS.ProcessEnv = { ...process.env };
  env.CODEGRAPH_NO_DOWNLOAD = "1";
  delete env.CODEGRAPH_DOWNLOAD_BASE;
  delete env.CODEGRAPH_MCP_TOOLS;
  return {
    file: process.execPath,
    args,
    options: { cwd: root, env, signal, encoding: "utf8", maxBuffer },
  };
}

export async function runExploreCode(
  cg: CodeGraphInstance,
  params: ExploreCodeParams,
  signal: AbortSignal | undefined,
  execute: ExecuteFile = executeCodeGraphCli,
): Promise<string> {
  const result = await execute(buildExploreCodeCommand(cg.getProjectRoot(), params, signal));
  const output = result.stdout.trim();
  if (output) return output;

  const detail = result.stderr.trim();
  throw new Error(detail ? `CodeGraph explore returned no output: ${bounded(detail)}` : "CodeGraph explore returned no output.");
}

function executeCodeGraphCli(command: ExploreCodeCommand): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command.file, command.args, command.options, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr).trim();
        reject(new Error(detail ? `CodeGraph explore failed: ${bounded(detail)}` : `CodeGraph explore failed: ${error.message}`));
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

function bounded(value: string, limit = 2_000): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}
