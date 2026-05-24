import assert from "node:assert/strict";
import test from "node:test";
import piCodegraph from "../src/index.js";
import { registerCommands } from "../src/commands.js";
import { registerTools } from "../src/tools.js";
import { CodeGraphRuntime } from "../src/runtime.js";

interface RegisteredTool {
  name: string;
  parameters?: unknown;
}

interface RegisteredCommand {
  name: string;
}

function createFakePi() {
  const tools: RegisteredTool[] = [];
  const commands: RegisteredCommand[] = [];
  const events: string[] = [];

  return {
    tools,
    commands,
    events,
    pi: {
      registerTool(tool: RegisteredTool) {
        tools.push(tool);
      },
      registerCommand(name: string) {
        commands.push({ name });
      },
      on(event: string) {
        events.push(event);
      },
    },
  };
}

function containsKey(value: unknown, key: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Object.prototype.hasOwnProperty.call(value, key)) return true;
  return Object.values(value as Record<string, unknown>).some((child) => {
    if (Array.isArray(child)) return child.some((item) => containsKey(item, key));
    return containsKey(child, key);
  });
}

test("extension shell registers shutdown cleanup, commands, and tools", () => {
  const fake = createFakePi();

  piCodegraph(fake.pi as never);

  assert.deepEqual(fake.commands.map((command) => command.name).sort(), ["cg:status", "cg:uninit"]);
  assert.equal(fake.commands.some((command) => command.name === "cg:init"), false);
  assert.equal(fake.events.includes("session_shutdown"), true);
  assert.equal(fake.events.includes("session_start"), false);
  assert.deepEqual(fake.tools.map((tool) => tool.name).sort(), [
    "callees",
    "callers",
    "context",
    "explore",
    "files",
    "impact",
    "node",
    "search",
  ]);
});

test("tool schemas are active-path-only and do not expose projectPath", () => {
  const fake = createFakePi();
  registerTools(fake.pi as never, new CodeGraphRuntime());

  for (const tool of fake.tools) {
    assert.equal(
      containsKey(tool.parameters, "projectPath"),
      false,
      `${tool.name} schema must not expose projectPath`,
    );
  }
});

test("commands register status and uninit only", () => {
  const fake = createFakePi();
  registerCommands(fake.pi as never, new CodeGraphRuntime());

  assert.deepEqual(fake.commands.map((command) => command.name).sort(), ["cg:status", "cg:uninit"]);
});
