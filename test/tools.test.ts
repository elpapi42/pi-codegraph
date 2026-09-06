import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { CodeGraph } from "../src/codegraph-sdk.js";
import { errorResult, textResult } from "../src/result.js";
import { registerCodeGraphTool, registerTools } from "../src/tools.js";
import { CodeGraphRuntime } from "../src/runtime.js";

interface RegisteredTool {
  name: string;
  description?: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters?: unknown;
  renderCall?: (args: Record<string, unknown>, theme: FakeTheme, context: { lastComponent?: unknown }) => { render(width: number): string[] };
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: { cwd: string },
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean; details?: Record<string, unknown> }>;
}

interface FakeTheme {
  fg: (style: string, text: string) => string;
  bold: (text: string) => string;
}

const fakeTheme: FakeTheme = { fg: (_style, text) => text, bold: (text) => text };

function createFakePi() {
  const tools: RegisteredTool[] = [];
  return { tools, pi: { registerTool(tool: RegisteredTool) { tools.push(tool); } } };
}

function getTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} should be registered`);
  return tool;
}

function schemaProperty(schema: unknown, name: string): Record<string, unknown> {
  assert.ok(schema && typeof schema === "object", "schema should be an object");
  const properties = (schema as { properties?: unknown }).properties;
  assert.ok(properties && typeof properties === "object", "schema should have properties");
  const property = (properties as Record<string, unknown>)[name];
  assert.ok(property && typeof property === "object", `schema should have ${name}`);
  return property as Record<string, unknown>;
}

function schemaHasProperty(schema: unknown, name: string): boolean {
  if (!schema || typeof schema !== "object") return false;
  const properties = (schema as { properties?: unknown }).properties;
  return Boolean(properties && typeof properties === "object" && Object.hasOwn(properties, name));
}

function renderToolCall(tool: RegisteredTool, args: Record<string, unknown>): string {
  assert.ok(tool.renderCall, `${tool.name} should define renderCall`);
  return tool.renderCall(args, fakeTheme, {}).render(200).join("\n").trim();
}

async function executeTool(tool: RegisteredTool, params: Record<string, unknown>, cwd: string) {
  return tool.execute("tool-call", params, new AbortController().signal, undefined, { cwd });
}

async function createIndexedFixture(): Promise<{ root: string; cleanup: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-fixture-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "auth.ts"), [
    "export function createSession() {",
    "  return 'session';",
    "}",
    "",
    "export function loginUser() {",
    "  return createSession();",
    "}",
  ].join("\n"));

  const cg = await CodeGraph.init(root, { index: false });
  const result = await cg.indexAll();
  assert.equal(result.success, true, `fixture index failed: ${JSON.stringify(result.errors)}`);
  cg.close();
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("explore_code returns upstream source, relationships, and blast radius from a real index", async () => {
  const fixture = await createIndexedFixture();
  try {
    const fake = createFakePi();
    registerTools(fake.pi as never, new CodeGraphRuntime());
    const result = await executeTool(getTool(fake.tools, "explore_code"), { query: "how does login work", maxFiles: 4 }, fixture.root);
    const text = result.content[0]?.text ?? "";
    assert.equal(result.isError, undefined);
    assert.match(text, /loginUser/);
    assert.match(text, /createSession/);
    assert.match(text, /Source Code/);
  } finally {
    fixture.cleanup();
  }
});

test("explore_code describes free-form query patterns and indexed-code limits", () => {
  const fake = createFakePi();
  registerTools(fake.pi as never, new CodeGraphRuntime());
  const tool = getTool(fake.tools, "explore_code");
  const query = schemaProperty(tool.parameters, "query");

  assert.match(tool.description ?? "", /ranked source context/);
  assert.match(tool.description ?? "", /not exhaustive/);
  assert.match(tool.description ?? "", /verify every returned file path/i);
  assert.match(tool.description ?? "", /read, rg, or find/);
  assert.match(String(query.description), /One free-form indexed-code query/);
  assert.match(String(query.description), /how does login create and validate sessions/);
  assert.match(String(query.description), /AuthService loginUser createSession/);
  assert.match(String(query.description), /src\/auth\/session\.ts createSession refreshSession/);
  assert.match(String(query.description), /query patterns, not operation modes or formal syntax/);
  assert.equal(schemaHasProperty(tool.parameters, "projectPath"), false);
  assert.equal(schemaHasProperty(tool.parameters, "mode"), false);
  assert.equal(schemaHasProperty(tool.parameters, "action"), false);
});

test("analyze_code describes target-only and two-selector behavior", () => {
  const fake = createFakePi();
  registerTools(fake.pi as never, new CodeGraphRuntime());
  const tool = getTool(fake.tools, "analyze_code");
  const serialized = JSON.stringify(tool.parameters);
  const target = schemaProperty(tool.parameters, "target");
  const related = schemaProperty(tool.parameters, "related");

  assert.match(tool.description ?? "", /With target only/);
  assert.match(tool.description ?? "", /With related, resolves both selectors first/);
  assert.match(tool.description ?? "", /performs no graph traversal/);
  assert.match(tool.description ?? "", /not runtime proof/);
  assert.match(String(target.description), /Primary symbol to analyze/);
  assert.match(String(target.description), /bounded index/);
  assert.match(String(target.description), /file and line.*exact file-local selection/);
  assert.match(String(related.description), /Optional second symbol/);
  assert.match(String(related.description), /same graph neighborhood for each/);
  assert.match(String(related.description), /graph paths in both directions/);
  assert.match(String(related.description), /performs no traversal/);
  assert.match(String(schemaProperty(target, "symbol").description), /partial or ambiguous name returns candidates/);
  assert.match(String(schemaProperty(target, "file").description), /resolves symbols only in this file/);
  assert.match(String(schemaProperty(target, "line").description), /definition start line/);
  for (const forbidden of ["operation", "depth", "limit", "mode", "projectPath", "includeCode"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
});

test("tool call renderers show compact retained parameters", () => {
  const fake = createFakePi();
  registerTools(fake.pi as never, new CodeGraphRuntime());
  assert.equal(renderToolCall(getTool(fake.tools, "explore_code"), { query: "how does login work", maxFiles: 6 }), "explore_code \"how does login work\" files=6");
  assert.equal(renderToolCall(getTool(fake.tools, "analyze_code"), { target: { symbol: "loginUser" }, related: { symbol: "createSession" } }), "analyze_code loginUser related=createSession");
  const rendered = renderToolCall(getTool(fake.tools, "explore_code"), { query: "a".repeat(120) });
  assert.match(rendered, /^explore_code "/);
  assert.match(rendered, /…"$/);
});

test("shared registration wrapper returns one bounded final result", async () => {
  const fake = createFakePi();
  registerCodeGraphTool(fake.pi as never, {
    async ensureReady() {
      return { getProjectRoot: () => "/repo" };
    },
  } as unknown as CodeGraphRuntime, {
    name: "test_tool",
    label: "Test Tool",
    description: "test",
    parameters: Type.Object({ query: Type.String() }),
    run: () => "result",
  });
  const result = await executeTool(getTool(fake.tools, "test_tool"), { query: "value" }, "/repo");
  assert.equal(result.content[0]?.text, "result");
  assert.equal(result.details?.tool, "test_tool");
});

test("tool output and errors are bounded", () => {
  const success = textResult("a".repeat(60 * 1024), { tool: "test", projectRoot: "/repo" });
  assert.equal(success.details?.truncated, true);
  assert.match(success.content[0]?.text ?? "", /\.\.\. \(output truncated\)/);
  const failure = errorResult("x".repeat(60 * 1024), { tool: "test" });
  assert.equal(failure.isError, true);
  assert.equal(failure.details?.truncated, true);
  assert.match(failure.content[0]?.text ?? "", /\.\.\. \(output truncated\)/);
});

test("registered metadata exposes only retained Pi tool names", () => {
  const fake = createFakePi();
  registerTools(fake.pi as never, new CodeGraphRuntime());
  assert.deepEqual(fake.tools.map((tool) => tool.name).sort(), ["analyze_code", "explore_code"]);
  assert.doesNotMatch(JSON.stringify(fake.tools), /codegraph_/i);
});
