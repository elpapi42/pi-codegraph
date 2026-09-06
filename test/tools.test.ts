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

const fakeTheme: FakeTheme = {
  fg: (_style, text) => text,
  bold: (text) => text,
};

function renderToolCall(tool: RegisteredTool, args: Record<string, unknown>): string {
  assert.ok(tool.renderCall, `${tool.name} should define renderCall`);
  return tool.renderCall(args, fakeTheme, {}).render(200).join("\n").trim();
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

function createExploreGraph(root: string, overrides: Record<string, unknown> = {}) {
  const login = makeNode({ id: "login", name: "loginUser", signature: "function loginUser()", filePath: "src/auth.ts", startLine: 5, endLine: 7 });
  const session = makeNode({ id: "session", name: "createSession", signature: "function createSession()", filePath: "src/auth.ts", startLine: 1, endLine: 3 });
  const nodes = new Map<string, ReturnType<typeof makeNode>>([
    [login.id, login],
    [session.id, session],
  ]);
  const edges = [{ source: "login", target: "session", kind: "calls", line: 6 }];

  return {
    getProjectRoot: () => root,
    getStats: () => ({ fileCount: 100 }),
    findRelevantContext: async () => ({ nodes, edges, roots: ["login"] }),
    getOutgoingEdges: (id: string) => (id === "login" ? edges : []),
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
    findRelevantContext: async () => ({ nodes: new Map(), edges: [], roots: [] }),
    getStats: () => ({ fileCount: 100 }),
    getOutgoingEdges: () => [],
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
    assert.match(text, /1 caller in `src\/auth\.ts`/);
    assert.match(text, /Blast radius/i);
  } finally {
    fixture.cleanup();
  }
});

test("all eight tools return real indexed fixture facts", async () => {
  const fixture = await createIndexedFixture();
  try {
    const fake = createFakePi();
    registerTools(fake.pi as never, new CodeGraphRuntime());

    const results = await Promise.all([
      executeTool(getTool(fake.tools, "search"), { query: "loginUser" }, fixture.root),
      executeTool(getTool(fake.tools, "files"), { format: "flat" }, fixture.root),
      executeTool(getTool(fake.tools, "context"), { task: "understand login authentication" }, fixture.root),
      executeTool(getTool(fake.tools, "explore"), { query: "loginUser createSession" }, fixture.root),
      executeTool(getTool(fake.tools, "callers"), { symbol: "loginUser" }, fixture.root),
      executeTool(getTool(fake.tools, "callees"), { symbol: "loginUser" }, fixture.root),
      executeTool(getTool(fake.tools, "impact"), { symbol: "loginUser", depth: 2 }, fixture.root),
      executeTool(getTool(fake.tools, "node"), { symbol: "loginUser", includeCode: true }, fixture.root),
    ]);
    const text = results.map((result) => result.content[0]?.text ?? "");

    for (const result of results) assert.equal(result.isError, undefined);
    assert.match(text[0]!, /loginUser/);
    assert.match(text[1]!, /src\/auth\.ts/);
    assert.match(text[2]!, /loginUser/);
    assert.match(text[3]!, /loginUser/);
    assert.doesNotMatch(text[4]!, /No callers found/);
    assert.match(text[4]!, /login \(method\)/);
    assert.match(text[5]!, /createSession/);
    assert.doesNotMatch(text[6]!, /No impact found/);
    assert.match(text[6]!, /login:10/);
    assert.match(text[7]!, /return createSession/);
  } finally {
    fixture.cleanup();
  }
});

test("node, callers, callees, impact, context, and explore produce representative markdown", async () => {
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

  const explore = await executeTool(getTool(tools, "explore"), { query: "missing" });
  assert.match(explore.content[0]?.text ?? "", /No relevant code found/);
});

test("explore returns grouped source sections and relationships", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-explore-"));
  const previousLineNumberSetting = process.env.CODEGRAPH_EXPLORE_LINENUMS;
  delete process.env.CODEGRAPH_EXPLORE_LINENUMS;
  try {
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
    ].join("\n"));

    const tools = registerWithGraph(createExploreGraph(root));
    const result = await executeTool(getTool(tools, "explore"), { query: "loginUser createSession", maxFiles: 1 });
    const text = result.content[0]?.text ?? "";

    assert.equal(result.isError, undefined);
    assert.match(text, /## Exploration: loginUser createSession/);
    assert.match(text, /### Relationships/);
    assert.match(text, /loginUser → createSession/);
    assert.match(text, /#### src\/auth\.ts/);
    assert.match(text, /```typescript/);
    assert.match(text, /export function loginUser/);
    assert.match(text, /^5\texport function loginUser/m);
  } finally {
    if (previousLineNumberSetting == null) {
      delete process.env.CODEGRAPH_EXPLORE_LINENUMS;
    } else {
      process.env.CODEGRAPH_EXPLORE_LINENUMS = previousLineNumberSetting;
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explore skips indexed paths that escape the project root", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-explore-safe-"));
  try {
    const escaping = makeNode({ id: "escape", name: "escapeRoot", filePath: "../outside.ts", startLine: 1, endLine: 1 });
    const nodes = new Map<string, ReturnType<typeof makeNode>>([[escaping.id, escaping]]);
    const tools = registerWithGraph(createExploreGraph(root, {
      findRelevantContext: async () => ({ nodes, edges: [], roots: ["escape"] }),
    }));

    const result = await executeTool(getTool(tools, "explore"), { query: "escapeRoot" });
    const text = result.content[0]?.text ?? "";

    assert.equal(result.isError, undefined);
    assert.match(text, /## Exploration: escapeRoot/);
    assert.doesNotMatch(text, /outside/);
    assert.doesNotMatch(text, /```/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("explore applies an explore-specific output budget cap", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-explore-budget-"));
  try {
    const nodes = new Map<string, ReturnType<typeof makeNode>>();
    for (let i = 0; i < 8; i++) {
      const node = makeNode({ id: `huge-${i}`, name: `hugeSymbol${i}_${"x".repeat(5000)}`, filePath: "src/missing.ts", startLine: 1, endLine: 1 });
      nodes.set(node.id, node);
    }
    const ids = [...nodes.keys()];
    const edges = ids.slice(1).map((target) => ({ source: ids[0]!, target, kind: "calls" }));

    const tools = registerWithGraph(createExploreGraph(root, {
      findRelevantContext: async () => ({ nodes, edges, roots: [ids[0]!] }),
      getOutgoingEdges: () => [],
    }));

    const result = await executeTool(getTool(tools, "explore"), { query: "hugeSymbol", maxFiles: 5 });
    const text = result.content[0]?.text ?? "";

    assert.equal(result.isError, undefined);
    assert.match(text, /explore output truncated to budget/);
    assert.ok(text.length <= 18_500);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("symbol misses are normal non-error markdown results", async () => {
  const tools = registerWithGraph(createSymbolGraph());
  const result = await executeTool(getTool(tools, "node"), { symbol: "missingSymbol" });

  assert.equal(result.isError, undefined);
  assert.match(result.content[0]?.text ?? "", /not found/);
});

test("explore_code is registered with its focused schema and guidance", () => {
  const fake = createFakePi();
  registerTools(fake.pi as never, new StaticRuntime(createSymbolGraph()) as unknown as CodeGraphRuntime);
  const tool = getTool(fake.tools, "explore_code");
  const serialized = JSON.stringify(tool.parameters);

  assert.match(serialized, /Natural-language question/);
  assert.match(JSON.stringify(tool), /returned source as already read/);
  assert.doesNotMatch(serialized, /projectPath/);
  assert.doesNotMatch(serialized, /mode/);
  assert.doesNotMatch(serialized, /action/);
});

test("tool call renderer shows compact parameters in the header", () => {
  const tools = registerWithGraph(createSymbolGraph());

  assert.equal(renderToolCall(getTool(tools, "search"), { query: "auth", kind: "function", limit: 25 }), "search \"auth\" kind=function limit=25");
  assert.equal(renderToolCall(getTool(tools, "context"), { task: "fix login redirect bug", maxNodes: 30, includeCode: false }), "context \"fix login redirect bug\" nodes=30 no-code");
  assert.equal(renderToolCall(getTool(tools, "explore"), { query: "AuthService loginUser", maxFiles: 6 }), "explore \"AuthService loginUser\" files=6");
  assert.equal(renderToolCall(getTool(tools, "explore_code"), { query: "how does login work", maxFiles: 6 }), "explore_code \"how does login work\" files=6");
  assert.equal(renderToolCall(getTool(tools, "files"), { path: "src", pattern: "**/*.tsx", format: "tree", maxDepth: 3, includeMetadata: false }), "files src \"**/*.tsx\" tree depth=3 no-meta");
  assert.equal(renderToolCall(getTool(tools, "node"), { symbol: "AuthService.login", includeCode: true }), "node AuthService.login +code");
  assert.equal(renderToolCall(getTool(tools, "callers"), { symbol: "loginUser", limit: 50 }), "callers loginUser limit=50");
  assert.equal(renderToolCall(getTool(tools, "callees"), { symbol: "handleWebhook", limit: 50 }), "callees handleWebhook limit=50");
  assert.equal(renderToolCall(getTool(tools, "impact"), { symbol: "UserService.update", depth: 3 }), "impact UserService.update depth=3");
});

test("tool call renderer truncates long primary values", () => {
  const tools = registerWithGraph(createSymbolGraph());
  const rendered = renderToolCall(getTool(tools, "search"), { query: "a".repeat(120) });

  assert.match(rendered, /^search "/);
  assert.match(rendered, /…"$/);
  assert.ok(rendered.length < 100);
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
