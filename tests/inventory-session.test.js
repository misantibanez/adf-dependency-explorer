"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { buildGraph, pipelineMetrics } = require("../graph.js");
const source = fs.readFileSync(path.join(__dirname, "..", "inventory-session.js"), "utf8");
const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "valid-inventory.json"), "utf8"));
function session(storage) {
  const context = { window: {}, sessionStorage: storage, console };
  vm.runInNewContext(source, context);
  return context.window.AdfSession;
}
test("same-tab graph handoff preserves metrics and does not persist raw definitions or credentials", () => {
  const data = new Map();
  const api = session({ getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) });
  assert.equal(api.read(), null);
  const input = structuredClone(snapshot);
  input.metadata.token = "DO_NOT_STORE";
  input.collections.pipelines[0].properties.parameters = { secret: "DO_NOT_STORE" };
  const graph = buildGraph(input);
  api.save(graph);
  assert.ok(!data.get("adf-current-graph").includes("DO_NOT_STORE"));
  assert.deepEqual(pipelineMetrics(api.read()), pipelineMetrics(graph));
});
test("failed storage write removes stale factory and surfaces the problem", () => {
  let stale = "old-factory";
  const api = session({
    getItem: () => stale, setItem() { throw new Error("Quota"); }, removeItem() { stale = null; }
  });
  assert.throws(() => api.save(buildGraph(snapshot)), /No se pudo compartir/);
  assert.equal(api.read(), null);
});
test("corrupt stored graphs cannot silently display another factory", () => {
  const api = session({ getItem: () => '{"version":2}' });
  assert.throws(() => api.read(), /formato valido/);
});
test("history handoff projects minimal fields, is inventory-scoped and removes stale history on failed writes", () => {
  const data = new Map();
  let fail = false;
  const api = session({
    getItem: key => data.get(key) || null,
    setItem(key, value) { if (fail) throw new Error("Quota"); data.set(key, value); },
    removeItem: key => data.delete(key)
  });
  const graph = buildGraph(snapshot);
  const history = { version: 1, factoryId: "test", source: "csv", from: "2024-01-01T00:00:00Z", to: "2025-01-01T00:00:00Z",
    complete: true, token: "DO_NOT_STORE", pipelines: [{ pipelineName: "A", lastRunStart: null, lastStatus: "Queued", active: true, parameters: "DO_NOT_STORE" }] };
  api.saveHistory(graph, history);
  assert.ok(!data.get("adf-pipeline-history").includes("DO_NOT_STORE"));
  assert.equal(api.readHistory(graph).pipelines[0].pipelineName, "A");
  assert.equal(api.readHistory({ ...graph, metadata: { ...graph.metadata, factoryName: "other" } }), null);
  assert.equal(api.readHistory({ ...graph, metadata: { ...graph.metadata, exportedAt: "new-date" } }), null);
  fail = true;
  assert.throws(() => api.saveHistory(graph, history), /compartir el historial/);
  assert.equal(api.readHistory(graph), null);
  data.set("adf-pipeline-history", '{"history":{}}');
  assert.throws(() => api.readHistory(graph), /formato valido/);
});
