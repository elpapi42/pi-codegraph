import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodeGraph } from "../src/codegraph-sdk.js";
import { buildExploreCodeCommand, runExploreCode } from "../src/explore-code.js";

const graph = { getProjectRoot: () => "/project" } as never;

async function createIndexedFixture(): Promise<{ root: string; cleanup: () => void }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-explore-code-"));
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "auth.ts"), "export function loginUser() { return 'ok'; }\n");
  const cg = await CodeGraph.init(root, { index: false });
  await cg.indexAll();
  cg.close();
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("builds root-pinned commands with literal queries and a restricted child environment", () => {
  const previous = {
    downloadBase: process.env.CODEGRAPH_DOWNLOAD_BASE,
    mcpTools: process.env.CODEGRAPH_MCP_TOOLS,
  };
  process.env.CODEGRAPH_DOWNLOAD_BASE = "https://untrusted.invalid";
  process.env.CODEGRAPH_MCP_TOOLS = "node,search";
  try {
    const command = buildExploreCodeCommand("/project", { query: "--path=/tmp", maxFiles: 99 }, new AbortController().signal);
    assert.equal(command.file, process.execPath);
    assert.match(command.args[0]!, /@colbymchenry[\\/]codegraph[\\/]npm-shim\.js$/);
    assert.deepEqual(command.args.slice(1), ["--no-color", "explore", "--path", "/project", "--max-files", "20", "--", "--path=/tmp"]);
    assert.equal(command.options.cwd, "/project");
    assert.equal(command.options.shell, undefined);
    assert.equal(command.options.env?.CODEGRAPH_MCP_TOOLS, undefined);
    assert.equal(command.options.env?.CODEGRAPH_DOWNLOAD_BASE, undefined);
    assert.equal(command.options.env?.CODEGRAPH_NO_DOWNLOAD, "1");
  } finally {
    if (previous.downloadBase === undefined) delete process.env.CODEGRAPH_DOWNLOAD_BASE;
    else process.env.CODEGRAPH_DOWNLOAD_BASE = previous.downloadBase;
    if (previous.mcpTools === undefined) delete process.env.CODEGRAPH_MCP_TOOLS;
    else process.env.CODEGRAPH_MCP_TOOLS = previous.mcpTools;
  }
});

test("uses adaptive maxFiles or clamps explicit maxFiles", () => {
  assert.deepEqual(buildExploreCodeCommand("/project", { query: "loginUser" }).args.slice(1), ["--no-color", "explore", "--path", "/project", "--", "loginUser"]);
  assert.deepEqual(buildExploreCodeCommand("/project", { query: "loginUser", maxFiles: 0 }).args.slice(1), ["--no-color", "explore", "--path", "/project", "--max-files", "1", "--", "loginUser"]);
});

test("treats option-looking queries as literals for the active root", async () => {
  const fixture = await createIndexedFixture();
  try {
    const output = await runExploreCode({ getProjectRoot: () => fixture.root } as never, { query: "--path=/tmp" }, new AbortController().signal);
    assert.equal(output, "No relevant code found for \"--path=/tmp\"");
    assert.doesNotMatch(output, /No CodeGraph index found at \/tmp/);
  } finally {
    fixture.cleanup();
  }
});

test("forwards CLI output and preserves the abort signal", async () => {
  const controller = new AbortController();
  let received: ReturnType<typeof buildExploreCodeCommand> | undefined;
  const output = await runExploreCode(graph, { query: "loginUser", maxFiles: 4 }, controller.signal, async (command) => {
    received = command;
    return { stdout: "## Exploration\n\nsource", stderr: "" };
  });

  assert.equal(output, "## Exploration\n\nsource");
  assert.equal(received?.options.signal, controller.signal);
});

test("rejects empty output and injected CLI failures", async () => {
  await assert.rejects(
    () => runExploreCode(graph, { query: "loginUser" }, new AbortController().signal, async () => ({ stdout: "", stderr: "no indexed code" })),
    /CodeGraph explore returned no output: no indexed code/,
  );
  await assert.rejects(
    () => runExploreCode(graph, { query: "loginUser" }, new AbortController().signal, async () => { throw new Error("CodeGraph explore failed: exit 1"); }),
    /CodeGraph explore failed: exit 1/,
  );
});

test("translates real CLI failures for unindexed roots", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-codegraph-unindexed-"));
  try {
    await assert.rejects(
      () => runExploreCode({ getProjectRoot: () => root } as never, { query: "loginUser" }, new AbortController().signal),
      /CodeGraph explore failed: .{1,2000}/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
