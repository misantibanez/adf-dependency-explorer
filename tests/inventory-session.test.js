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
test("resource and possible matches survive same-tab graph handoff without target IDs, hostnames or raw URLs", () => {
  const data = new Map();
  const api = session({ getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) });
  const input = structuredClone(snapshot);
  const target = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-test/providers/Microsoft.Storage/storageAccounts/lake";
  input.collections.linkedservices = [
    { name: "LS", properties: { typeProperties: { resourceId: target } } },
    { name: "LS_Url", properties: { typeProperties: { url: "https://lake.dfs.core.windows.net/path?sig=DO_NOT_STORE" } } }
  ];
  input.collections.managedPrivateEndpoints = [{ name: "default/MPE", properties: { privateLinkResourceId: target } }];
  input.metadata.completeness.managedPrivateEndpoints = true;
  const graph = buildGraph(input);
  api.save(graph);
  const restored = api.read();
  assert.deepEqual(structuredClone(restored.edges), graph.edges);
  const edge = restored.edges.find(edge => edge.kind === "resourceMatch");
  assert.ok(edge);
  assert.equal(restored.incoming.get(edge.target)[0].source, edge.source);
  assert.ok(restored.edges.some(edge => edge.kind === "possibleNetwork"));
  assert.ok(!data.get("adf-current-graph").includes("lake.dfs.core.windows.net"));
  assert.ok(!data.get("adf-current-graph").includes("DO_NOT_STORE"));
  assert.ok(!data.get("adf-current-graph").includes(target));
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
