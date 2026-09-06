import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { CodeGraphInstance } from "./codegraph-sdk.js";
import type { CodeGraphRuntime } from "./runtime.js";
import { runAnalyzeCode } from "./analyze-code.js";
import { runExploreCode } from "./explore-code.js";
import { errorResult, textResult, type PiTextToolResult } from "./result.js";

const ExploreCodeParams = Type.Object({
  query: Type.String({ description: "One free-form indexed-code query. Use a behavior question such as \"how does login create and validate sessions\", focused symbols such as \"AuthService loginUser createSession\", or an exact path plus symbols such as \"src/auth/session.ts createSession refreshSession\". These are query patterns, not operation modes or formal syntax. Include paths and symbols when known." }),
  maxFiles: Type.Optional(Type.Number({ description: "Maximum source files to return. Omit it to let CodeGraph choose an adaptive limit, or set 1 through 20." })),
});

function analyzeSelector(description: string) {
  return Type.Object({
    symbol: Type.String({ description: "Exact or likely code symbol name. A partial or ambiguous name returns candidates instead of analysis." }),
    file: Type.Optional(Type.String({ description: "Exact project-relative code file path from explore_code or analyze_code candidates. When set, analyze_code resolves symbols only in this file." })),
    line: Type.Optional(Type.Number({ description: "Exact definition start line from explore_code or analyze_code candidates. Use with file to select one definition." })),
  }, { description });
}

const AnalyzeCodeParams = Type.Object({
  target: analyzeSelector("Primary symbol to analyze. Symbol alone searches a bounded index. Add file and line from explore_code or candidates for exact file-local selection."),
  related: Type.Optional(analyzeSelector("Optional second symbol. When supplied, analyze_code resolves both selectors first, returns the same graph neighborhood for each, then returns graph paths in both directions. If either selector is not unique, it returns candidates and performs no traversal.")),
}, {
  description: "Analyze one primary symbol, or compare it with one optional related symbol. With target only, returns the target's graph neighborhood without source. With related, resolves both selectors first, returns the same neighborhood for each, then returns graph paths in both directions. If either selector is partial or ambiguous, returns candidates and performs no graph traversal.",
});

interface CodeGraphToolSpec<TParams extends TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  promptSnippet?: string;
  promptGuidelines?: string[];
  run: (cg: CodeGraphInstance, params: Static<TParams>, signal: AbortSignal | undefined) => Promise<string> | string;
}

export function registerTools(pi: ExtensionAPI, runtime: CodeGraphRuntime): void {
  registerCodeGraphTool(pi, runtime, {
    name: "explore_code",
    label: "Explore Indexed Code",
    description: "Understand indexed code behavior and retrieve ranked source context in one call. Returns current line-numbered source plus ranked relationships, call paths, and blast-radius leads. The result is not exhaustive and can be noisy in multi-repository or duplicate-code indexes, so verify every returned file path before using it. Include exact project-relative paths and symbols when known. This tool indexes code only. Use read, rg, or find for Markdown, configuration, generated runtime wiring, and exact file inventories.",
    promptSnippet: "explore_code: understand indexed code and retrieve ranked source context; use paths and symbols when known, then verify returned paths.",
    promptGuidelines: [
      "Use `explore_code` to understand indexed-code behavior, architecture, bugs, flows, or surrounding source.",
      "The query is free-form: use a behavior question, focused symbols, or an exact project-relative path plus symbols. These are query patterns, not modes.",
      "When known, include exact project-relative paths and symbol names to focus retrieval.",
      "Results are ranked and non-exhaustive. Broad queries can be noisy in multi-repository or duplicate-code indexes. Verify every returned file path before relying on it.",
      "Treat source returned by `explore_code` as already read. Use a narrower second query only for a specific gap.",
      "Use read, rg, or find for Markdown, configuration, generated runtime wiring, and exact file inventories because CodeGraph indexes code only.",
    ],
    parameters: ExploreCodeParams,
    run: runExploreCode,
  });

  registerCodeGraphTool(pi, runtime, {
    name: "analyze_code",
    label: "Analyze Code Symbols",
    description: "Analyze one or two indexed code symbols without choosing a mode. With target only, returns incoming and outgoing relationships, wider impact, and test files in the target's graph neighborhood without source. With related, resolves both selectors first, returns the same neighborhood for each, then returns graph paths in both directions. Pass file and line from explore_code or returned candidates whenever available. When file is set, analyze_code resolves symbols only in that file. If either selector is partial or ambiguous, returns selector-ready candidates and performs no graph traversal. Relationships are static indexed evidence that can omit behavior or contain ambiguous or incorrect resolutions. They are not runtime proof.",
    promptSnippet: "analyze_code: inspect automatic bounded static neighborhoods for one symbol, or two neighborhoods plus paths between them; ambiguity returns candidates.",
    promptGuidelines: [
      "Use `analyze_code` for bounded static relationships, impact, and graph-neighborhood tests for one known symbol. It does not return source.",
      "Add `related` when you need the same neighborhood for a second symbol and graph paths in both directions between the two symbols.",
      "Pass file and line from explore_code or returned candidates whenever available. When file is set, analyze_code resolves symbols only in that file.",
      "If either selector is partial or ambiguous, select a returned candidate and call again. No graph traversal occurs until both selectors resolve uniquely.",
      "Use `explore_code` for source and ranked code context. Treat analyze_code paths and relationships as static evidence, not runtime proof.",
    ],
    parameters: AnalyzeCodeParams,
    run: (cg, params) => runAnalyzeCode(cg, params),
  });
}

export function registerCodeGraphTool<TParams extends TSchema>(
  pi: ExtensionAPI,
  runtime: CodeGraphRuntime,
  spec: CodeGraphToolSpec<TParams>,
): void {
  pi.registerTool({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    promptSnippet: spec.promptSnippet,
    promptGuidelines: spec.promptGuidelines,
    parameters: spec.parameters,
    renderCall(args, theme, context) {
      const text = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      text.setText(formatToolCall(spec.name, args, theme));
      return text;
    },
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      try {
        const cg = await runtime.ensureReady(ctx, { signal });
        const text = await spec.run(cg, params, signal);
        return textResult(text, { tool: spec.name, projectRoot: cg.getProjectRoot() }) as never;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return errorResult(message, { tool: spec.name }) as never;
      }
    },
  });
}

function formatToolCall(toolName: string, args: Record<string, unknown> | undefined, theme: ToolCallTheme): string {
  const title = theme.fg("toolTitle", theme.bold(toolName));
  const params = args ?? {};

  if (toolName === "explore_code") {
    return joinCallParts(title, formatPrimary(params.query, theme), formatOptional("files", params.maxFiles, theme));
  }

  return joinCallParts(
    title,
    formatPrimary((params.target as Record<string, unknown> | undefined)?.symbol, theme, { quote: false }),
    formatOptional("related", (params.related as Record<string, unknown> | undefined)?.symbol, theme),
  );
}

interface ToolCallTheme {
  fg(style: string, text: string): string;
  bold(text: string): string;
}

function joinCallParts(...parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" ");
}

function formatPrimary(value: unknown, theme: ToolCallTheme, options: { quote?: boolean } = {}): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const truncated = truncateCallValue(value);
  const quote = options.quote ?? true;
  return theme.fg("accent", quote ? JSON.stringify(truncated) : truncated);
}

function formatOptional(label: string, value: unknown, theme: ToolCallTheme): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return theme.fg("dim", `${label}=${String(value)}`);
}

function truncateCallValue(value: string, maxLength = 80): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}
