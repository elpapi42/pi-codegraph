import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodeGraph } from "../src/codegraph-sdk.js";
import { registerTools } from "../src/tools.js";
import { CodeGraphRuntime } from "../src/runtime.js";
import { errorResult, textResult } from "../src/result.js";

interface RegisteredTool {
  name: string;
  parameters?: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
    onUpdate: ((update: unknown) => void) | undefined,
    ctx: { cwd: string },
  ) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean; details?: Record<string, unknown> }>;
}

function createFakePi() {
  const tools: RegisteredTool[] = [];
  return {
    tools,
    pi: {
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
    },
  };
}

function getTool(tools: RegisteredTool[], name: string): RegisteredTool {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `${name} should be registered`);
  return tool;
}

async function executeTool(tool: RegisteredTool, params: Record<string, unknown>, cwd = "/repo") {
  return tool.execute("tool-call", params, new AbortController().signal, undefined, { cwd });
}

class StaticRuntime {
  constructor(private readonly graph: unknown) {}

  async ensureReady() {
    return this.graph;
  }

  async closeAll() {}
}

class ProgressRuntime {
  constructor(private readonly graph: unknown) {}

  async ensureReady(_ctx: unknown, options?: { onProgress?: (message: string) => void }) {
    options?.onProgress?.("CodeGraph: indexing /repo");
    return this.graph;
  }

  async closeAll() {}
}

function makeNode(overrides: Record<string, unknown>) {
  return {
    id: "node-1",
    name: "loginUser",
    qualifiedName: "loginUser",
    kind: "function",
    filePath: "src/auth.ts",
    startLine: 1,
    endLine: 5,
    language: "typescript",
    signature: "function loginUser()",
    docstring: "",
    visibility: undefined,
    isExported: true,
    ...overrides,
  };
}

function createSymbolGraph() {
  const login = makeNode({ id: "login", name: "loginUser", signature: "function loginUser()", startLine: 10 });
  const caller = makeNode({ id: "caller", name: "handleSubmit", kind: "function", filePath: "src/ui.ts", startLine: 20, signature: "function handleSubmit()" });
  const callee = makeNode({ id: "callee", name: "createSession", kind: "function", filePath: "src/session.ts", startLine: 3, signature: "function createSession()" });
  const klass = makeNode({ id: "class", name: "AuthService", kind: "class", filePath: "src/auth-service.ts", startLine: 1, signature: "class AuthService" });
  const method = makeNode({ id: "method", name: "login", kind: "method", filePath: "src/auth-service.ts", startLine: 4, signature: "login(): void" });

  const nodes = [login, caller, callee, klass, method];

  return {
    getProjectRoot: () => "/repo",
    searchNodes(query: string) {
      const q = query.toLowerCase();
      return nodes
        .filter((node) => node.name.toLowerCase().includes(q) || node.filePath.toLowerCase().includes(q))
        .map((node) => ({ node, score: 1 }));
    },
    getCode(id: string) {
      if (id === "login") return "export function loginUser() {\n  return createSession();\n}";
      return "";
    },
    getChildren(id: string) {
      return id === "class" ? [method] : [];
    },
    getCallers(id: string) {
      return id === "login" ? [{ node: caller }] : [];
    },
    getCallees(id: string) {
      return id === "login" ? [{ node: callee }] : [];
    },
    getImpactRadius(id: string) {
      const impactNodes = new Map<string, unknown>();
      if (id === "login") {
        impactNodes.set("login", login);
        impactNodes.set("caller", caller);
      }
      return { nodes: impactNodes, edges: [{ source: "caller", target: "login", kind: "call" }] };
    },
    buildContext() {
      return { summary: "## Context\n\nRelevant auth context." };
    },
    getFiles() {
      return [
        { path: "src/auth.ts", language: "typescript", nodeCount: 2, size: 100, modifiedAt: 1, indexedAt: 2 },
        { path: "src/session.ts", language: "typescript", nodeCount: 1, size: 80, modifiedAt: 1, indexedAt: 2 },
        { path: "README.md", language: "markdown", nodeCount: 0, size: 20, modifiedAt: 1, indexedAt: 2 },
      ];
    },
  };
}

function registerWithGraph(graph: unknown) {
  const fake = createFakePi();
  registerTools(fake.pi as never, new StaticRuntime(graph) as unknown as CodeGraphRuntime);
  return fake.tools;
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
    "",
    "export class AuthService {",
    "  login() {",
    "    return loginUser();",
    "  }",
    "}",
    "",
    "export type UserId = string;",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "README.md"), "# Fixture\n");

  const cg = await CodeGraph.init(root, { index: false });
  const result = await cg.indexAll();
  assert.equal(result.success, true, `fixture index failed: ${JSON.stringify(result.errors)}`);
  cg.close();

  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("search tool returns real CodeGraph fixture symbol locations", async () => {
  const fixture = await createIndexedFixture();
  try {
    const fake = createFakePi();
    registerTools(fake.pi as never, new CodeGraphRuntime());

    const result = await executeTool(getTool(fake.tools, "search"), { query: "loginUser" }, fixture.root);
    const text = result.content[0]?.text ?? "";

    assert.equal(result.isError, undefined);
    assert.match(text, /## Search Results/);
    assert.match(text, /loginUser/);
    assert.match(text, /src\/auth\.ts/);
  } finally {
    fixture.cleanup();
  }
});

test("search kind type finds real CodeGraph type aliases", async () => {
  const fixture = await createIndexedFixture();
  try {
    const fake = createFakePi();
    registerTools(fake.pi as never, new CodeGraphRuntime());

    const result = await executeTool(getTool(fake.tools, "search"), { query: "UserId", kind: "type" }, fixture.root);
    const text = result.content[0]?.text ?? "";

    assert.equal(result.isError, undefined);
    assert.match(text, /UserId/);
    assert.match(text, /type_alias/);
    assert.match(text, /src\/auth\.ts/);
  } finally {
    fixture.cleanup();
  }
});

test("files tool returns real CodeGraph fixture tree and filters", async () => {
  const fixture = await createIndexedFixture();
  try {
    const fake = createFakePi();
    registerTools(fake.pi as never, new CodeGraphRuntime());

    const tree = await executeTool(getTool(fake.tools, "files"), { format: "tree" }, fixture.root);
    assert.match(tree.content[0]?.text ?? "", /## Project Structure/);
    assert.match(tree.content[0]?.text ?? "", /src\//);
    assert.match(tree.content[0]?.text ?? "", /auth\.ts/);

    const filtered = await executeTool(getTool(fake.tools, "files"), { path: "src", pattern: "**/*.ts", format: "flat" }, fixture.root);
    assert.match(filtered.content[0]?.text ?? "", /src\/auth\.ts/);
    assert.doesNotMatch(filtered.content[0]?.text ?? "", /README\.md/);
  } finally {
    fixture.cleanup();
  }
});

test("node, callers, callees, impact, and context produce representative markdown", async () => {
  const tools = registerWithGraph(createSymbolGraph());

  const node = await executeTool(getTool(tools, "node"), { symbol: "loginUser", includeCode: true });
  assert.match(node.content[0]?.text ?? "", /## loginUser \(function\)/);
  assert.match(node.content[0]?.text ?? "", /```typescript/);

  const container = await executeTool(getTool(tools, "node"), { symbol: "AuthService", includeCode: true });
  assert.match(container.content[0]?.text ?? "", /Members \(1\)/);
  assert.match(container.content[0]?.text ?? "", /Structural outline only/);

  const callers = await executeTool(getTool(tools, "callers"), { symbol: "loginUser" });
  assert.match(callers.content[0]?.text ?? "", /## Callers of loginUser/);
  assert.match(callers.content[0]?.text ?? "", /handleSubmit/);

  const callees = await executeTool(getTool(tools, "callees"), { symbol: "loginUser" });
  assert.match(callees.content[0]?.text ?? "", /## Callees of loginUser/);
  assert.match(callees.content[0]?.text ?? "", /createSession/);

  const impact = await executeTool(getTool(tools, "impact"), { symbol: "loginUser", depth: 2 });
  assert.match(impact.content[0]?.text ?? "", /## Impact: "loginUser" affects/);
  assert.match(impact.content[0]?.text ?? "", /src\/ui\.ts/);

  const context = await executeTool(getTool(tools, "context"), { task: "fix auth" });
  assert.match(context.content[0]?.text ?? "", /Relevant auth context/);
});

test("symbol misses are normal non-error markdown results", async () => {
  const tools = registerWithGraph(createSymbolGraph());
  const result = await executeTool(getTool(tools, "node"), { symbol: "missingSymbol" });

  assert.equal(result.isError, undefined);
  assert.match(result.content[0]?.text ?? "", /not found/);
});

test("tool wrapper ignores progress updates and returns one final result", async () => {
  const fake = createFakePi();
  registerTools(fake.pi as never, new ProgressRuntime(createSymbolGraph()) as unknown as CodeGraphRuntime);
  const updates: unknown[] = [];

  const result = await getTool(fake.tools, "search").execute(
    "tool-call",
    { query: "loginUser" },
    new AbortController().signal,
    (update) => updates.push(update),
    { cwd: "/repo" },
  );

  assert.deepEqual(updates, []);
  assert.equal(result.content[0]?.type, "text");
  assert.match(result.content[0]?.text ?? "", /loginUser/);
  assert.equal(result.details?.tool, "search");
});

test("tool output is truncated and marks details when over budget", () => {
  const result = textResult("a".repeat(60 * 1024), { tool: "test", projectRoot: "/repo" });
  const text = result.content[0]?.text ?? "";

  assert.equal(result.details?.truncated, true);
  assert.match(text, /\.\.\. \(output truncated\)/);
  assert.ok(text.length < 60 * 1024);
});

test("tool errors are truncated and do not store unbounded raw errors", () => {
  const result = errorResult("x".repeat(60 * 1024), { tool: "test" });
  const text = result.content[0]?.text ?? "";

  assert.equal(result.isError, true);
  assert.equal(result.details?.truncated, true);
  assert.match(text, /\.\.\. \(output truncated\)/);
  assert.equal(result.details?.value, text);
  assert.equal(result.details?.error, text);
  assert.ok(text.length < 60 * 1024);
});

test("registered tool metadata does not leak MCP codegraph_* names", () => {
  const fake = createFakePi();
  registerTools(fake.pi as never, new StaticRuntime(createSymbolGraph()) as unknown as CodeGraphRuntime);

  const serialized = JSON.stringify(fake.tools);
  assert.doesNotMatch(serialized, /codegraph_/i);
});
