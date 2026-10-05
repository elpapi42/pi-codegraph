import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Value } from "typebox/value";
import { CodeGraph } from "../src/codegraph-sdk.js";
import { runAnalyzeCode } from "../src/analyze-code.js";
import { registerTools } from "../src/tools.js";
import { CodeGraphRuntime } from "../src/runtime.js";

function node(overrides: Record<string, unknown>) {
  return {
    id: "login", name: "loginUser", qualifiedName: "loginUser", kind: "function", filePath: "src/auth.ts", startLine: 10, endLine: 12,
    language: "typescript", signature: "function loginUser()", docstring: "", visibility: undefined, isExported: true, ...overrides,
  };
}

function registeredAnalyzeTool() {
  const tools: any[] = [];
  registerTools({ registerTool(tool: unknown) { tools.push(tool); } } as never, new CodeGraphRuntime());
  const tool = tools.find((item) => item.name === "analyze_code");
  assert.ok(tool);
  return tool;
}

async function createIndexedFixture(): Promise<{ root: string; cleanup: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-analyze-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "auth.ts"), [
    "export function createSession() { const ANALYZE_CODE_BODY_LITERAL = 'must-not-appear'; return 'session'; }",
    "export function loginUser() { return createSession(); }",
    "export function handleSubmit() { return loginUser(); }",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "test", "auth.test.ts"), "import { loginUser } from '../src/auth.js';\nloginUser();\n");
  const cg = await CodeGraph.init(root, { index: false });
  await cg.indexAll();
  cg.close();
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function graph() {
  const login = node({ id: "login" });
  const caller = node({ id: "caller", name: "handleSubmit", filePath: "src/ui.ts", startLine: 20 });
  const callee = node({ id: "callee", name: "createSession", filePath: "src/session.ts", startLine: 3 });
  const impacted = node({ id: "impacted", name: "refreshSession", filePath: "src/session.ts", startLine: 30 });
  const testNode = node({ id: "test", name: "login test", kind: "function", filePath: "test/auth.test.ts", startLine: 5 });
  const nodes = [login, caller, callee, impacted, testNode];
  return {
    searchNodes(query: string) { const lower = query.toLowerCase(); return nodes.filter((item) => item.name.toLowerCase().includes(lower)).map((item) => ({ node: item, score: 1 })); },
    getCallers(id: string) { return id === "login" ? [{ node: caller, edge: { kind: "calls" } }] : []; },
    getCallees(id: string) { return id === "login" ? [{ node: callee, edge: { kind: "calls" } }] : []; },
    getImpactRadius(id: string) { return id === "login" ? { nodes: new Map([["login", login], ["caller", caller], ["callee", callee], ["impacted", impacted], ["test", testNode]]), edges: [] } : { nodes: new Map([[id, nodes.find((item) => item.id === id)]]), edges: [] }; },
    findPath(from: string, to: string) { return from === "caller" && to === "login" ? [{ node: caller, edge: null }, { node: login, edge: { kind: "calls" } }] : null; },
  };
}

test("analyzes one exact symbol with direct neighbors, residual impact, and test files", () => {
  const output = runAnalyzeCode(graph() as never, { target: { symbol: "loginUser" } });
  assert.match(output, /## Code Analysis/);
  assert.match(output, /Target: loginUser \(function\)/);
  assert.match(output, /## Incoming Relationships \(1 of 1\)/);
  assert.match(output, /handleSubmit \(function\) at src\/ui\.ts:20 --calls→ loginUser/);
  assert.match(output, /## Outgoing Relationships \(1 of 1\)/);
  assert.match(output, /loginUser --calls→ createSession \(function\) at src\/session\.ts:3/);
  assert.match(output, /## Wider Impact \(2 of 2\)/);
  assert.match(output, /refreshSession/);
  const widerImpact = output.split("## Wider Impact")[1]?.split("## Test Files")[0] ?? "";
  assert.doesNotMatch(widerImpact, /loginUser/);
  assert.doesNotMatch(widerImpact, /handleSubmit/);
  assert.doesNotMatch(widerImpact, /createSession/);
  assert.match(output, /## Test Files Found in This Graph Neighborhood/);
  assert.match(output, /test\/auth\.test\.ts/);
  assert.match(output, /Target selection uses exact matching within a bounded candidate search/);
  assert.match(output, /relationships can omit .* and can contain ambiguous or incorrect resolutions/);
  assert.doesNotMatch(output, /```/);
});

test("groups repeated direct relationships by node and preserves distinct edge kinds", async () => {
  const login = node({ id: "login" });
  const caller = node({ id: "caller", name: "handleSubmit", filePath: "src/ui.ts", startLine: 20 });
  const callee = node({ id: "callee", name: "createSession", filePath: "src/session.ts", startLine: 3 });
  const relationGraph = {
    getProjectRoot: () => "/indexed",
    searchNodes: () => [{ node: login, score: 1 }],
    getCallers: () => [
      { node: caller, edge: { kind: "calls" } },
      { node: caller, edge: { kind: "calls" } },
      { node: caller, edge: { kind: "references" } },
    ],
    getCallees: () => [
      { node: callee, edge: { kind: "references" } },
      { node: callee, edge: { kind: "calls" } },
      { node: callee, edge: { kind: "calls" } },
    ],
    getImpactRadius: () => ({ nodes: new Map([[login.id, login]]), edges: [] }),
    findPath: () => null,
  };

  const output = runAnalyzeCode(relationGraph as never, { target: { symbol: "loginUser" } });

  assert.match(output, /## Incoming Relationships \(1 of 1\)/);
  assert.match(output, /handleSubmit \(function\) at src\/ui\.ts:20 --calls, references→ loginUser/);
  assert.match(output, /## Outgoing Relationships \(1 of 1\)/);
  assert.match(output, /loginUser --calls, references→ createSession \(function\) at src\/session\.ts:3/);
  assert.equal((output.match(/handleSubmit \(function\) at src\/ui\.ts:20/g) ?? []).length, 1);
  assert.equal((output.match(/createSession \(function\) at src\/session\.ts:3/g) ?? []).length, 1);
  const structured = (await structuredAnalysis(relationGraph, { target: { symbol: "loginUser" } })).structuredContent;
  assert.equal(structured.target.incoming.total, 1);
  assert.equal(structured.target.outgoing.total, 1);
  assert.deepEqual(structured.target.incoming.items[0].kinds, ["calls", "references"]);
  assert.deepEqual(structured.target.outgoing.items[0].kinds, ["calls", "references"]);
});

test("returns candidates without traversal for partial, missing, and duplicate selectors", () => {
  const login = node({ id: "login", name: "loginUser" });
  const duplicate = node({ id: "duplicate", name: "loginUser", filePath: "profiles/auth.ts", startLine: 2 });
  let traversed = false;
  const candidateGraph = {
    searchNodes(query: string) { if (query === "loginUser") return [{ node: login, score: 1 }, { node: duplicate, score: 1 }]; if (query === "login") return [{ node: login, score: 1 }]; return []; },
    getCallers() { traversed = true; return []; }, getCallees() { traversed = true; return []; }, getImpactRadius() { traversed = true; return { nodes: new Map(), edges: [] }; }, findPath() { traversed = true; return null; },
  };
  const partial = runAnalyzeCode(candidateGraph as never, { target: { symbol: "login" } });
  assert.match(partial, /No exact definition matches "login"/);
  assert.match(partial, /Selector:/);
  assert.equal(traversed, false);
  const duplicateOutput = runAnalyzeCode(candidateGraph as never, { target: { symbol: "loginUser" } });
  assert.match(duplicateOutput, /Multiple exact definitions match "loginUser"/);
  assert.match(duplicateOutput, /profiles\/auth\.ts/);
  assert.equal(traversed, false);
  const missing = runAnalyzeCode(candidateGraph as never, { target: { symbol: "missing" } });
  assert.match(missing, /No likely code-symbol candidates found/);
  assert.equal(traversed, false);
});

test("ranks definition candidates before import and file nodes", () => {
  const definition = node({ id: "definition", name: "loginHandler", filePath: "src/z-handler.ts", startLine: 12 });
  const importNode = node({ id: "import", name: "loginBinding", kind: "import", filePath: "src/a-import.ts", startLine: 1 });
  const fileNode = node({ id: "file", name: "loginModule", kind: "file", filePath: "src/b-login.ts", startLine: 1 });
  const candidateGraph = {
    searchNodes: () => [{ node: fileNode, score: 1 }, { node: importNode, score: 1 }, { node: definition, score: 1 }],
    getCallers: () => { throw new Error("candidate output must not traverse"); },
    getCallees: () => { throw new Error("candidate output must not traverse"); },
    getImpactRadius: () => { throw new Error("candidate output must not traverse"); },
    findPath: () => { throw new Error("candidate output must not traverse"); },
  };

  const output = runAnalyzeCode(candidateGraph as never, { target: { symbol: "login" } });

  assert.match(output, /## Candidates \(3 of 3\)/);
  assert.match(output, /- Definition: loginHandler \(function\)/);
  assert.match(output, /- Import node: loginBinding \(import\)/);
  assert.match(output, /- File node: loginModule \(file\)/);
  assert.ok(output.indexOf("Definition: loginHandler") < output.indexOf("Import node: loginBinding"));
  assert.ok(output.indexOf("Import node: loginBinding") < output.indexOf("File node: loginModule"));
});

test("does not traverse when a related selector is ambiguous", () => {
  const target = node({ id: "target", name: "target" });
  const firstRelated = node({ id: "related-one", name: "related", filePath: "src/one.ts", startLine: 1 });
  const secondRelated = node({ id: "related-two", name: "related", filePath: "src/two.ts", startLine: 2 });
  let traversed = false;
  const candidateGraph = {
    searchNodes(query: string) {
      if (query === "target") return [{ node: target, score: 1 }];
      if (query === "related") return [{ node: firstRelated, score: 1 }, { node: secondRelated, score: 1 }];
      return [];
    },
    getCallers() { traversed = true; return []; }, getCallees() { traversed = true; return []; },
    getImpactRadius() { traversed = true; return { nodes: new Map(), edges: [] }; },
    findPath() { traversed = true; return null; },
  };
  const output = runAnalyzeCode(candidateGraph as never, { target: { symbol: "target" }, related: { symbol: "related" } });
  assert.match(output, /Multiple exact definitions match "related"/);
  assert.equal(traversed, false);
});

test("resolves qualified symbols through their exact definition", () => {
  const method = node({ id: "method", name: "login", qualifiedName: "AuthService::login", filePath: "src/auth.ts", startLine: 20 });
  const qualifiedGraph = {
    searchNodes(query: string) { return query === "login" ? [{ node: method, score: 1 }] : []; },
    getCallers: () => [], getCallees: () => [], getImpactRadius: () => ({ nodes: new Map([[method.id, method]]), edges: [] }), findPath: () => null,
  };
  const output = runAnalyzeCode(qualifiedGraph as never, { target: { symbol: "AuthService::login" } });
  assert.match(output, /Target: login/);
  assert.match(output, /Qualified: AuthService::login/);
});

test("uses exact file and line selectors and rejects unsafe selectors", () => {
  const active = node({ id: "active", name: "registerTools", filePath: "agent/extensions/pi-codegraph/src/tools.ts", startLine: 100 });
  const profile = node({ id: "profile", name: "registerTools", filePath: "profiles/fork/packages/pi-codegraph/src/tools.ts", startLine: 94 });
  const selectionGraph = {
    searchNodes: () => [{ node: active, score: 1 }, { node: profile, score: 1 }],
    getNodesInFile: (file: string) => file === active.filePath ? [active] : file === profile.filePath ? [profile] : [],
    getCallers: () => [], getCallees: () => [],
    getImpactRadius: (id: string) => ({ nodes: new Map([[id, id === "active" ? active : profile]]), edges: [] }), findPath: () => null,
  };
  const output = runAnalyzeCode(selectionGraph as never, { target: { symbol: "registerTools", file: "agent/extensions/pi-codegraph/src/tools.ts", line: 100 } });
  assert.match(output, /Target: registerTools/);
  assert.match(output, /agent\/extensions\/pi-codegraph\/src\/tools\.ts:100/);
  assert.doesNotMatch(output, /profiles\/fork/);
  for (const file of ["/tmp/tools.ts", "../tools.ts", "src\\tools.ts", "src//tools.ts", "src/./tools.ts"]) assert.throws(() => runAnalyzeCode(selectionGraph as never, { target: { symbol: "registerTools", file } }), /safe project-relative path/);
  for (const line of [0, -1, 1.5, "1"]) assert.throws(() => runAnalyzeCode(selectionGraph as never, { target: { symbol: "registerTools", line } }), /positive integer/);
});

test("resolves file selectors locally before global candidate ranking", () => {
  const target = node({ id: "target", name: "execute", qualifiedName: "ProcessEvent::execute", kind: "method", filePath: "src/ports/primary/processEvent.ts", startLine: 8 });
  const related = node({ id: "related", name: "dispatch", qualifiedName: "EventBus::dispatch", kind: "method", filePath: "src/adapters/event-bus.ts", startLine: 12 });
  const common = Array.from({ length: 51 }, (_, index) => node({ id: `common-${index}`, name: "execute", filePath: `src/common-${index}.ts`, startLine: index + 1 }));
  let globalSearches = 0;
  const selectorGraph = {
    searchNodes() { globalSearches++; return common.map((item) => ({ node: item, score: 1 })); },
    getNodesInFile(file: string) {
      if (file === target.filePath) return [target];
      if (file === related.filePath) return [related];
      return [];
    },
    getCallers: () => [], getCallees: () => [],
    getImpactRadius: (id: string) => ({ nodes: new Map([[id, id === target.id ? target : related]]), edges: [] }),
    findPath: (from: string, to: string) => from === target.id && to === related.id
      ? [{ node: target, edge: null }, { node: related, edge: { kind: "calls" } }]
      : null,
  };

  const output = runAnalyzeCode(selectorGraph as never, {
    target: { symbol: "execute", file: target.filePath, line: 8 },
    related: { symbol: "dispatch", file: related.filePath, line: 12 },
  });

  assert.equal(globalSearches, 0);
  assert.match(output, /Target: execute \(method\)/);
  assert.match(output, /Related: dispatch \(method\)/);
  assert.match(output, /--calls→ dispatch/);
});

test("returns exact file-local candidates without global search when a file selector does not resolve", () => {
  const first = node({ id: "first", name: "execute", kind: "method", filePath: "src/ports/primary/processEvent.ts", startLine: 8 });
  const second = node({ id: "second", name: "execute", kind: "method", filePath: "src/ports/primary/processEvent.ts", startLine: 20 });
  let globalSearches = 0;
  const selectorGraph = {
    searchNodes() { globalSearches++; return []; },
    getNodesInFile: () => [first, second],
    getCallers: () => { throw new Error("candidate output must not traverse"); },
    getCallees: () => { throw new Error("candidate output must not traverse"); },
    getImpactRadius: () => { throw new Error("candidate output must not traverse"); },
    findPath: () => { throw new Error("candidate output must not traverse"); },
  };

  const output = runAnalyzeCode(selectorGraph as never, {
    target: { symbol: "execute", file: first.filePath, line: 99 },
  });

  assert.equal(globalSearches, 0);
  assert.match(output, /No exact definition of "execute" matches the supplied selector/);
  assert.match(output, /"file": "src\/ports\/primary\/processEvent\.ts", "line": 8/);
  assert.match(output, /"file": "src\/ports\/primary\/processEvent\.ts", "line": 20/);
});

test("analyzes two symbols with both directed graph paths and normal no-path results", () => {
  const output = runAnalyzeCode(graph() as never, { target: { symbol: "handleSubmit" }, related: { symbol: "loginUser" } });
  assert.match(output, /## Related: loginUser/);
  assert.match(output, /### Target to Related \(1 edges\)/);
  assert.match(output, /--calls→ loginUser/);
  assert.match(output, /### Related to Target\nNo directed graph path found/);
});

test("caps graph sections and long graph paths", async () => {
  const target = node({ id: "target", name: "target" });
  const callers = Array.from({ length: 21 }, (_, index) => node({ id: `caller-${index}`, name: `caller${index}`, filePath: `src/${index}.ts`, startLine: index + 1 }));
  const longPath = [target, ...Array.from({ length: 21 }, (_, index) => node({ id: `path-${index}`, name: `path${index}`, filePath: `src/path-${index}.ts`, startLine: 1 }))];
  const cappedGraph = {
    getProjectRoot: () => "/indexed",
    searchNodes: (query: string) => query === "target" ? [{ node: target, score: 1 }] : query === "path20" ? [{ node: longPath.at(-1), score: 1 }] : [],
    getCallers: () => callers.map((item) => ({ node: item, edge: { kind: "calls" } })), getCallees: () => [],
    getImpactRadius: () => ({ nodes: new Map([[target.id, target]]), edges: [] }),
    findPath: (from: string, to: string) => from === "target" && to === "path-20" ? longPath.map((item, index) => ({ node: item, edge: index === 0 ? null : { kind: "calls" } })) : null,
  };
  const output = runAnalyzeCode(cappedGraph as never, { target: { symbol: "target" }, related: { symbol: "path20" } });
  assert.match(output, /## Incoming Relationships \(20 of 21\)/);
  assert.match(output, /Truncated after 20 entries/);
  assert.match(output, /Path truncated after 20 of 21 edges/);
  const structured = (await structuredAnalysis(cappedGraph, { target: { symbol: "target" }, related: { symbol: "path20" } })).structuredContent;
  assert.equal(structured.target.incoming.total, 21);
  assert.equal(structured.target.incoming.items.length, 20);
  assert.equal(structured.paths.targetToRelated.total, 21);
  assert.equal(structured.paths.targetToRelated.steps.length, 21);
  assert.equal(structured.paths.targetToRelated.steps[20].symbol.name, "path19");
  assert.equal(structured.paths.relatedToTarget, null);
});

test("runs real indexed one- and two-target analysis through public registration", async () => {
  const fixture = await createIndexedFixture();
  const activeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-analyze-active-"));
  try {
    const tool = registeredAnalyzeTool();
    const single = await tool.execute("call", { target: { symbol: "loginUser", file: "src/auth.ts", line: 2 }, projectPath: path.join(fixture.root, "src") }, new AbortController().signal, undefined, { cwd: activeCwd });
    const singleText = single.content[0]?.text ?? "";
    assert.equal(single.isError, undefined, singleText);
    assert.ok(Value.Check(tool.outputSchema, single.structuredContent));
    assert.deepEqual(JSON.parse(JSON.stringify(single.structuredContent)), single.structuredContent);
    assert.equal(single.structuredContent.projectRoot, fixture.root);
    assert.equal(single.structuredContent.target.symbol.file, "src/auth.ts");
    assert.equal(single.structuredContent.target.symbol.line, 2);
    assert.equal(single.structuredContent.status, "analyzed");
    assert.match(singleText, new RegExp(`^Indexed project: ${fixture.root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.match(singleText, /src\/auth\.ts/);
    assert.match(singleText, /handleSubmit/);
    assert.match(singleText, /createSession/);
    assert.doesNotMatch(singleText, /```/);
    assert.doesNotMatch(singleText, /ANALYZE_CODE_BODY_LITERAL/);

    const pair = await tool.execute("call", {
      target: { symbol: "handleSubmit", file: "src/auth.ts", line: 3 },
      related: { symbol: "loginUser", file: "src/auth.ts", line: 2 },
    }, new AbortController().signal, undefined, { cwd: fixture.root });
    const pairText = pair.content[0]?.text ?? "";
    assert.equal(pair.isError, undefined);
    assert.ok(Value.Check(tool.outputSchema, pair.structuredContent));
    assert.deepEqual(JSON.parse(JSON.stringify(pair.structuredContent)), pair.structuredContent);
    assert.equal(pair.structuredContent.projectRoot, fixture.root);
    assert.equal(pair.structuredContent.related.symbol.name, "loginUser");
    assert.equal(pair.structuredContent.paths.targetToRelated.steps[1].kind, "calls");
    assert.match(pairText, /Target to Related/);
    assert.match(pairText, /handleSubmit/);
    assert.match(pairText, /--calls→ loginUser/);
  } finally {
    fixture.cleanup();
    fs.rmSync(activeCwd, { recursive: true, force: true });
  }
});

function goldenGraph() {
  const a = node({ id: "a", name: "a", qualifiedName: "Service::a", signature: "a(): void", filePath: "src/a.ts", startLine: 1 });
  const b = node({ id: "b", name: "b", qualifiedName: "b", signature: "", filePath: "src/b.ts", startLine: 2 });
  return {
    getProjectRoot: () => "/indexed",
    searchNodes: (query: string) => (query === "partial" ? [a, b] : query === "missing" ? [] : [a, b].filter(item => item.name === query)).map(node => ({ node, score: 1 })),
    getCallers: (id: string) => id === "a" ? [{ node: b, edge: { kind: "calls" } }] : [],
    getCallees: (id: string) => id === "b" ? [{ node: a, edge: { kind: "calls" } }] : [],
    getImpactRadius: () => ({ nodes: new Map([[a.id, a], [b.id, b]]), edges: [] }),
    findPath: (from: string, to: string) => from === "a" ? [{ node: a, edge: null }, { node: b, edge: null }] : [{ node: b, edge: null }, { node: a, edge: { kind: "calls" } }],
  };
}

test("keeps exact Markdown for resolved, related, candidate, and missing results", () => {
  const cases = [
    { target: { symbol: "a" } },
    { target: { symbol: "a" }, related: { symbol: "b" } },
    { target: { symbol: "partial" } },
    { target: { symbol: "missing" } },
  ];
  const expected = [
    `## Code Analysis

## Target: a (function)
src/a.ts:1
Qualified: Service::a
Signature: \`a(): void\`
## Incoming Relationships (1 of 1)
- b (function) at src/b.ts:2 --calls→ a
## Outgoing Relationships (0 of 0)
## Wider Impact (0 of 0)
## Test Files Found in This Graph Neighborhood (0)
No test files found in this graph neighborhood.

Target selection uses exact matching within a bounded candidate search. Static graph relationships can omit unresolved, generated, dynamic, or runtime behavior and can contain ambiguous or incorrect resolutions. They are not runtime proof.`,
    `## Code Analysis

## Target: a (function)
src/a.ts:1
Qualified: Service::a
Signature: \`a(): void\`
## Incoming Relationships (1 of 1)
- b (function) at src/b.ts:2 --calls→ a
## Outgoing Relationships (0 of 0)
## Wider Impact (0 of 0)
## Test Files Found in This Graph Neighborhood (0)
No test files found in this graph neighborhood.

## Related: b (function)
src/b.ts:2
## Incoming Relationships (0 of 0)
## Outgoing Relationships (1 of 1)
- b --calls→ a (function) at src/a.ts:1
## Wider Impact (0 of 0)
## Test Files Found in This Graph Neighborhood (0)
No test files found in this graph neighborhood.

## Graph Paths
### Target to Related (1 edges)
- a (function) at src/a.ts:1
  --references→ b (function) at src/b.ts:2

### Related to Target (1 edges)
- b (function) at src/b.ts:2
  --calls→ a (function) at src/a.ts:1

Target selection uses exact matching within a bounded candidate search. Static graph relationships can omit unresolved, generated, dynamic, or runtime behavior and can contain ambiguous or incorrect resolutions. They are not runtime proof.`,
    `## Code Analysis

No exact definition matches "partial". Select a likely candidate before analysis.

## Candidates (2 of 2)

- Definition: a (function)
   Selector: { "symbol": "a", "file": "src/a.ts", "line": 1 }
   Qualified: Service::a
   Signature: \`a(): void\`
- Definition: b (function)
   Selector: { "symbol": "b", "file": "src/b.ts", "line": 2 }`,
    `## Code Analysis

No exact definition matches "missing". Select a likely candidate before analysis.

No likely code-symbol candidates found.`
  ];
  cases.forEach((params,index) => assert.equal(runAnalyzeCode(goldenGraph() as never,params), expected[index]));
});

async function structuredAnalysis(cg: unknown, params: Record<string, unknown>) {
  const tools: any[] = [];
  registerTools({ registerTool(tool: unknown) { tools.push(tool); } } as never, {
    ensureReady: async () => cg,
  } as never);
  const tool = tools.find(item => item.name === "analyze_code");
  const result = await tool.execute("call", params, undefined, undefined, { cwd: "/active" });
  assert.equal(result.isError, undefined, result.content[0]?.text);
  assert.ok(tool.outputSchema);
  assert.ok(Value.Check(tool.outputSchema, result.structuredContent));
  assert.deepEqual(JSON.parse(JSON.stringify(result.structuredContent)), result.structuredContent);
  return result;
}

test("registered analysis exposes schema-valid target data without changing text or details", async () => {
  const cg = goldenGraph();
  const result = await structuredAnalysis(cg, { target: { symbol: "a" } });
  const text = runAnalyzeCode(cg as never, { target: { symbol: "a" } });
  assert.deepEqual(result.content, [{ type: "text", text }]);
  assert.deepEqual(result.details, { tool: "analyze_code", projectRoot: "/indexed", value: text, truncated: false });
  assert.equal(result.structuredContent.projectRoot, "/indexed");
  assert.equal(result.structuredContent.status, "analyzed");
  assert.deepEqual(result.structuredContent.target.symbol, {
    name: "a", kind: "function", file: "src/a.ts", line: 1, qualifiedName: "Service::a", signature: "a(): void",
  });
  assert.deepEqual(result.structuredContent.target.incoming, {
    items: [{ symbol: { name: "b", kind: "function", file: "src/b.ts", line: 2 }, kinds: ["calls"] }], total: 1,
  });
  assert.deepEqual(result.structuredContent.target.outgoing, { items: [], total: 0 });
  assert.deepEqual(result.structuredContent.target.impact, { items: [], total: 0 });
  assert.deepEqual(result.structuredContent.target.testFiles, []);
  assert.equal(Object.hasOwn(result.structuredContent, "related"), false);
  assert.equal(Object.hasOwn(result.structuredContent, "paths"), false);
});

test("registered candidate results expose reasons and reusable selectors without traversal", async () => {
  const first = node({ id: "one", name: "execute", qualifiedName: "Service::execute", filePath: "src/a.ts", startLine: 2 });
  const second = node({ id: "two", name: "execute", qualifiedName: "Other::execute", filePath: "src/b.ts", startLine: 3 });
  const cg = {
    getProjectRoot: () => "/indexed",
    searchNodes: (query: string) => (query === "missing" ? [] : [second, first]).map(node => ({ node, score: 1 })),
    getNodesInFile: () => [second, first],
    getCallers: () => { throw new Error("candidates must not traverse"); },
    getCallees: () => { throw new Error("candidates must not traverse"); },
    getImpactRadius: () => { throw new Error("candidates must not traverse"); },
    findPath: () => { throw new Error("candidates must not traverse"); },
  };
  for (const [selector, reason, total] of [
    [{ symbol: "execute" }, "ambiguous", 2],
    [{ symbol: "execute", line: 99 }, "not_found", 2],
    [{ symbol: "execute", file: "src/a.ts", line: 99 }, "not_found", 2],
    [{ symbol: "partial" }, "not_found", 2],
    [{ symbol: "missing" }, "not_found", 0],
  ] as const) {
    const result = await structuredAnalysis(cg, { target: selector });
    assert.equal(result.content[0].text, runAnalyzeCode(cg as never, { target: selector }));
    assert.equal(result.structuredContent.status, "candidates");
    assert.equal(result.structuredContent.selector, "target");
    assert.equal(result.structuredContent.reason, reason);
    assert.equal(result.structuredContent.total, total);
    assert.equal(Object.hasOwn(result.structuredContent, "title"), false);
    assert.equal(Object.hasOwn(result.structuredContent, "target"), false);
    if (total) assert.deepEqual(result.structuredContent.candidates[0].selector, { symbol: "execute", file: "src/a.ts", line: 2 });
  }
  const result = await structuredAnalysis(cg, { target: { symbol: "execute", line: 2 }, related: { symbol: "execute" } });
  assert.equal(result.structuredContent.selector, "related");
  assert.equal(result.structuredContent.reason, "ambiguous");
});

test("registered paired analysis returns both path directions, missing paths, and zero-edge paths", async () => {
  const cg = goldenGraph();
  const result = await structuredAnalysis(cg, { target: { symbol: "a" }, related: { symbol: "b" } });
  const output = result.structuredContent;
  assert.equal(output.related.symbol.name, "b");
  assert.deepEqual(output.paths.targetToRelated, {
    steps: [{ symbol: output.target.symbol }, { symbol: output.related.symbol, kind: "references" }], total: 1,
  });
  assert.deepEqual(output.paths.relatedToTarget, {
    steps: [{ symbol: output.related.symbol }, { symbol: output.target.symbol, kind: "calls" }], total: 1,
  });
  assert.equal(result.content[0].text, runAnalyzeCode(cg as never, { target: { symbol: "a" }, related: { symbol: "b" } }));
  const missing = await structuredAnalysis({ ...cg, findPath: () => null }, { target: { symbol: "a" }, related: { symbol: "b" } });
  assert.deepEqual(missing.structuredContent.paths, { targetToRelated: null, relatedToTarget: null });
  const a = node({ id: "a", name: "a", qualifiedName: "a" });
  const zero = await structuredAnalysis({ ...cg, findPath: () => [{ node: a, edge: null }] }, { target: { symbol: "a" }, related: { symbol: "a" } });
  assert.equal(zero.structuredContent.paths.targetToRelated.total, 0);
  assert.equal(zero.structuredContent.paths.targetToRelated.steps.length, 1);
  assert.equal(Object.hasOwn(zero.structuredContent.paths.targetToRelated.steps[0], "kind"), false);
});


test("candidate totals retain resolver size and definition priority beyond the cap", async () => {
  const definitions = Array.from({ length: 21 }, (_, index) => node({
    id: `definition-${index}`, name: "execute", filePath: `src/${String(index).padStart(2, "0")}.ts`, startLine: index + 1,
  }));
  const cg = {
    getProjectRoot: () => "/indexed",
    searchNodes: () => [node({ id: "file", name: "execute", kind: "file", filePath: "src/0.ts" }),
      node({ id: "import", name: "execute", kind: "import", filePath: "src/0.ts" }), ...definitions].map(node => ({ node, score: 1 })),
    getCallers: () => { throw new Error("candidates must not traverse"); },
  };
  const output = (await structuredAnalysis(cg, { target: { symbol: "execute" } })).structuredContent;
  assert.equal(output.reason, "ambiguous");
  assert.equal(output.total, 23);
  assert.equal(output.candidates.length, 20);
  assert.ok(output.candidates.every((candidate: { kind: string }) => candidate.kind === "function"));
  assert.equal(output.candidates[19].selector.file, "src/19.ts");
});

test("neighborhood totals and test discovery precede structured section caps", async () => {
  const target = node({ id: "target", name: "target" });
  const callers = Array.from({ length: 21 }, (_, index) => node({
    id: `caller-${index}`, filePath: `src/a${index}.ts`, name: `caller${index}`,
  }));
  callers.push(node({ id: "last-caller", filePath: "test/z-caller.test.ts", name: "lastCaller" }));
  const residual = Array.from({ length: 21 }, (_, index) => node({ id: `impact-${index}`, filePath: `src/b${index}.ts` }));
  residual.push(node({ id: "last-impact", filePath: "test/z-impact.test.ts" }));
  const cg = {
    getProjectRoot: () => "/indexed", searchNodes: () => [{ node: target }],
    getCallers: () => callers.map(node => ({ node })), getCallees: () => callers.map(node => ({ node })),
    getImpactRadius: () => ({ nodes: new Map([target, ...callers, ...residual].map(node => [node.id, node])) }),
  };
  const output = (await structuredAnalysis(cg, { target: { symbol: "target" } })).structuredContent;
  for (const section of [output.target.incoming, output.target.outgoing, output.target.impact]) {
    assert.equal(section.total, 22);
    assert.equal(section.items.length, 20);
  }
  assert.deepEqual(output.target.testFiles, ["test/z-caller.test.ts", "test/z-impact.test.ts"]);
  assert.equal(output.target.incoming.items.some((item: any) => item.symbol.file.startsWith("test/")), false);
  assert.equal(output.target.impact.items.some((item: any) => item.file.startsWith("test/")), false);
});

test("structured signatures stay complete when model text reaches its 50 Ki-character cap", async () => {
  const signature = "x".repeat(60 * 1024);
  const cg = { ...goldenGraph(), searchNodes: () => [{ node: node({ signature }) }] };
  const result = await structuredAnalysis(cg, { target: { symbol: "loginUser" }, projectPath: "/indexed/src" });
  assert.equal(result.details.truncated, true);
  assert.match(result.content[0].text, /^Indexed project: \/indexed/);
  assert.match(result.content[0].text, /output truncated/);
  assert.equal(result.structuredContent.target.symbol.signature, signature);
});

test("candidate target does not suppress related-selector validation", () => {
  assert.throws(() => runAnalyzeCode(goldenGraph() as never, {
    target: { symbol: "missing" }, related: { symbol: "b", line: -1 },
  }), /related.line must be a positive integer/);
});
