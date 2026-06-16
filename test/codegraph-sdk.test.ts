import assert from "node:assert/strict";
import test from "node:test";
import { CodeGraph, findNearestCodeGraphRoot, isInitialized } from "../src/codegraph-sdk.js";

test("CodeGraph SDK adapter exposes the full static runtime API", () => {
  assert.equal(typeof CodeGraph, "function");
  assert.equal(typeof CodeGraph.init, "function");
  assert.equal(typeof CodeGraph.open, "function");
  assert.equal(typeof findNearestCodeGraphRoot, "function");
  assert.equal(typeof isInitialized, "function");
});
