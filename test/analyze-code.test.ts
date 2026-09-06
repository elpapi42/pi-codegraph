import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
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

test("groups repeated direct relationships by node and preserves distinct edge kinds", () => {
  const login = node({ id: "login" });
  const caller = node({ id: "caller", name: "handleSubmit", filePath: "src/ui.ts", startLine: 20 });
  const callee = node({ id: "callee", name: "createSession", filePath: "src/session.ts", startLine: 3 });
  const relationGraph = {
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
    searchNodes: () => [{ node: active, score: 1 }, { node: profile, score: 1 }], getCallers: () => [], getCallees: () => [],
    getImpactRadius: (id: string) => ({ nodes: new Map([[id, id === "active" ? active : profile]]), edges: [] }), findPath: () => null,
  };
  const output = runAnalyzeCode(selectionGraph as never, { target: { symbol: "registerTools", file: "agent/extensions/pi-codegraph/src/tools.ts", line: 100 } });
  assert.match(output, /Target: registerTools/);
  assert.match(output, /agent\/extensions\/pi-codegraph\/src\/tools\.ts:100/);
  assert.doesNotMatch(output, /profiles\/fork/);
  for (const file of ["/tmp/tools.ts", "../tools.ts", "src\\tools.ts", "src//tools.ts", "src/./tools.ts"]) assert.throws(() => runAnalyzeCode(selectionGraph as never, { target: { symbol: "registerTools", file } }), /safe project-relative path/);
  for (const line of [0, -1, 1.5, "1"]) assert.throws(() => runAnalyzeCode(selectionGraph as never, { target: { symbol: "registerTools", line } }), /positive integer/);
});

test("analyzes two symbols with both directed graph paths and normal no-path results", () => {
  const output = runAnalyzeCode(graph() as never, { target: { symbol: "handleSubmit" }, related: { symbol: "loginUser" } });
  assert.match(output, /## Related: loginUser/);
  assert.match(output, /### Target to Related \(1 edges\)/);
  assert.match(output, /--calls→ loginUser/);
  assert.match(output, /### Related to Target\nNo directed graph path found/);
});

test("caps graph sections and long graph paths", () => {
  const target = node({ id: "target", name: "target" });
  const callers = Array.from({ length: 21 }, (_, index) => node({ id: `caller-${index}`, name: `caller${index}`, filePath: `src/${index}.ts`, startLine: index + 1 }));
  const longPath = [target, ...Array.from({ length: 21 }, (_, index) => node({ id: `path-${index}`, name: `path${index}`, filePath: `src/path-${index}.ts`, startLine: 1 }))];
  const cappedGraph = {
    searchNodes: (query: string) => query === "target" ? [{ node: target, score: 1 }] : query === "path20" ? [{ node: longPath.at(-1), score: 1 }] : [],
    getCallers: () => callers.map((item) => ({ node: item, edge: { kind: "calls" } })), getCallees: () => [],
    getImpactRadius: () => ({ nodes: new Map([[target.id, target]]), edges: [] }),
    findPath: (from: string, to: string) => from === "target" && to === "path-20" ? longPath.map((item, index) => ({ node: item, edge: index === 0 ? null : { kind: "calls" } })) : null,
  };
  const output = runAnalyzeCode(cappedGraph as never, { target: { symbol: "target" }, related: { symbol: "path20" } });
  assert.match(output, /## Incoming Relationships \(20 of 21\)/);
  assert.match(output, /Truncated after 20 entries/);
  assert.match(output, /Path truncated after 20 of 21 edges/);
});

test("runs real indexed one- and two-target analysis through public registration", async () => {
  const fixture = await createIndexedFixture();
  try {
    const tool = registeredAnalyzeTool();
    const single = await tool.execute("call", { target: { symbol: "loginUser" } }, new AbortController().signal, undefined, { cwd: fixture.root });
    const singleText = single.content[0]?.text ?? "";
    assert.equal(single.isError, undefined);
    assert.match(singleText, /src\/auth\.ts/);
    assert.match(singleText, /handleSubmit/);
    assert.match(singleText, /createSession/);
    assert.doesNotMatch(singleText, /```/);
    assert.doesNotMatch(singleText, /ANALYZE_CODE_BODY_LITERAL/);

    const pair = await tool.execute("call", {
      target: { symbol: "handleSubmit" },
      related: { symbol: "loginUser" },
    }, new AbortController().signal, undefined, { cwd: fixture.root });
    const pairText = pair.content[0]?.text ?? "";
    assert.equal(pair.isError, undefined);
    assert.match(pairText, /Target to Related/);
    assert.match(pairText, /handleSubmit/);
    assert.match(pairText, /--calls→ loginUser/);
  } finally {
    fixture.cleanup();
  }
});
