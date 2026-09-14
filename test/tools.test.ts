import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Type, validateToolArguments } from "@earendil-works/pi-ai";
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
    assert.doesNotMatch(text, /^Indexed project:/);
    assert.match(text, /loginUser/);
    assert.match(text, /createSession/);
    assert.match(text, /Source Code/);
  } finally {
    fixture.cleanup();
  }
});

test("explore_code uses projectPath to query an external indexed project", async () => {
  const fixture = await createIndexedFixture();
  const activeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-active-"));
  try {
    const fake = createFakePi();
    registerTools(fake.pi as never, new CodeGraphRuntime());
    const result = await executeTool(
      getTool(fake.tools, "explore_code"),
      { query: "how does login work", projectPath: path.join(fixture.root, "src") },
      activeCwd,
    );
    const text = result.content[0]?.text ?? "";

    assert.equal(result.isError, undefined);
    assert.match(text, new RegExp(`^Indexed project: ${fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(text, /File paths below are relative to this directory/);
    assert.match(text, /loginUser/);
    assert.equal(result.details?.projectRoot, fixture.root);
  } finally {
    fixture.cleanup();
    fs.rmSync(activeCwd, { recursive: true, force: true });
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
  const projectPath = schemaProperty(tool.parameters, "projectPath");
  assert.match(String(projectPath.description), /Directory inside the project you want to inspect/);
  assert.match(String(projectPath.description), /A supplied path never initializes a missing index/);
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
  const projectPath = schemaProperty(tool.parameters, "projectPath");
  assert.match(String(projectPath.description), /Results can include other files from that indexed project/);
  for (const forbidden of ["operation", "depth", "limit", "mode", "includeCode"]) {
    assert.doesNotMatch(serialized, new RegExp(forbidden));
  }
});

test("tool call renderers show compact retained parameters", () => {
  const fake = createFakePi();
  registerTools(fake.pi as never, new CodeGraphRuntime());
  assert.equal(renderToolCall(getTool(fake.tools, "explore_code"), { query: "how does login work", maxFiles: 6, projectPath: "/repo" }), "explore_code \"how does login work\" files=6 project=/repo");
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

test("shared registration rejects an explicitly present non-string projectPath", async () => {
  const fake = createFakePi();
  let ensureReadyCalls = 0;
  registerCodeGraphTool(fake.pi as never, {
    async ensureReady() {
      ensureReadyCalls += 1;
      return { getProjectRoot: () => "/active/project" };
    },
  } as unknown as CodeGraphRuntime, {
    name: "test_tool",
    label: "Test Tool",
    description: "test",
    parameters: Type.Object({ query: Type.String(), projectPath: Type.Optional(Type.String()) }),
    run: () => "result",
  });

  const result = await executeTool(getTool(fake.tools, "test_tool"), { query: "value", projectPath: null }, "/active/project");

  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /projectPath must be a string/);
  assert.equal(ensureReadyCalls, 0);
});

test("package validation keeps explicit null projectPath out of omission mode", async () => {
  const fake = createFakePi();
  let receivedProjectPath: unknown;
  registerTools(fake.pi as never, {
    async ensureReady(_ctx: unknown, options: { projectPath?: unknown }) {
      receivedProjectPath = options.projectPath;
      throw new Error("projectPath must be an existing directory.");
    },
  } as unknown as CodeGraphRuntime);
  const tool = getTool(fake.tools, "explore_code");
  const params = validateToolArguments(
    { parameters: tool.parameters } as never,
    { arguments: { query: "inspect code", projectPath: null } } as never,
  ) as Record<string, unknown>;

  assert.equal(params.projectPath, "");
  const result = await executeTool(tool, params, "/active/project");
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /projectPath must be an existing directory/);
  assert.equal(receivedProjectPath, "");
});

const installedPiValidatorPath = process.env.PI_AI_VALIDATOR_PATH;

test("installed Pi validation preserves explicit null projectPath for registered-tool rejection", {
  skip: installedPiValidatorPath === undefined
    ? "Set PI_AI_VALIDATOR_PATH to the installed @earendil-works/pi-ai module to run this compatibility check."
    : false,
}, async () => {
  const fake = createFakePi();
  let ensureReadyCalls = 0;
  registerTools(fake.pi as never, {
    async ensureReady() {
      ensureReadyCalls += 1;
      return { getProjectRoot: () => "/active/project" };
    },
  } as unknown as CodeGraphRuntime);
  const tool = getTool(fake.tools, "explore_code");
  const installedPiAi = await import(pathToFileURL(installedPiValidatorPath!).href) as {
    validateToolArguments: typeof validateToolArguments;
  };
  const params = installedPiAi.validateToolArguments(
    { parameters: tool.parameters } as never,
    { arguments: { query: "inspect code", projectPath: null } } as never,
  ) as Record<string, unknown>;

  assert.equal(params.projectPath, null);
  const result = await executeTool(tool, params, "/active/project");
  assert.equal(result.isError, true);
  assert.match(result.content[0]?.text ?? "", /projectPath must be a string/);
  assert.equal(ensureReadyCalls, 0);
});

test("shared registration forwards projectPath and identifies its selected project in output", async () => {
  const fake = createFakePi();
  let received: unknown;
  registerCodeGraphTool(fake.pi as never, {
    async ensureReady(_ctx: unknown, options: unknown) {
      received = options;
      return { getProjectRoot: () => "/external/project" };
    },
  } as unknown as CodeGraphRuntime, {
    name: "test_tool",
    label: "Test Tool",
    description: "test",
    parameters: Type.Object({ query: Type.String(), projectPath: Type.Optional(Type.String()) }),
    run: () => "result",
  });

  const result = await executeTool(getTool(fake.tools, "test_tool"), { query: "value", projectPath: "/external/project/src" }, "/active/project");

  assert.equal((received as { projectPath?: unknown }).projectPath, "/external/project/src");
  assert.equal(result.content[0]?.text, "Indexed project: /external/project\nFile paths below are relative to this directory.\n\nresult");
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
