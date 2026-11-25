"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildGraph, evaluateDeletion, traverse, objectMetrics, pipelineMetrics, idFor } = require("../graph.js");
function inventory(pipelines = [], others = {}) {
  const collections = { pipelines, datasets: [], linkedservices: [], integrationRuntimes: [], triggers: [], dataflows: [], ...others };
  return { schemaVersion: 1, metadata: { completeness: Object.fromEntries(Object.keys(collections).map(key => [key, true])) }, collections };
}
const ref = (type, name) => ({ type, referenceName: name });
const execute = (name, target) => ({ name, type: "ExecutePipeline", typeProperties: { pipeline: ref("PipelineReference", target) } });
const pipeline = (name, activities = []) => ({ name, properties: { activities } });
const pid = name => idFor("pipeline", name);

test("Copy -> dataset -> linked service -> IR and nested ExecutePipeline retain exact activity evidence", () => {
  const snapshot = inventory([
    pipeline("A", [
      { name: "Copy", type: "Copy", inputs: [ref("DatasetReference", "D")] },
      { name: "Condition", type: "IfCondition", typeProperties: { ifTrueActivities: [
        { name: "Loop", type: "ForEach", typeProperties: { activities: [execute("CallB", "B")] } }
      ] } }
    ]), pipeline("B")
  ], {
    datasets: [{ name: "D", properties: { linkedServiceName: ref("LinkedServiceReference", "LS") } }],
    linkedservices: [{ name: "LS", properties: { connectVia: ref("IntegrationRuntimeReference", "IR") } }],
    integrationRuntimes: [{ name: "IR", properties: { type: "SelfHosted" } }]
  });
  const graph = buildGraph(snapshot);
  assert.equal(graph.issues.length, 0);
  assert.ok(traverse(graph, pid("A"), "outgoing").has(idFor("integrationRuntime", "IR")));
  const result = evaluateDeletion(graph, [pid("B")]).results[0];
  assert.equal(result.status, "blocked");
  assert.equal(result.blockers[0].name, "A");
  assert.equal(result.blockers[0].activity, "CallB");
  assert.match(result.blockers[0].evidence, /ifTrueActivities\[0\].typeProperties.activities\[0\]/);
});

test("batch removes internal blockers, reports external ones and orders callers before callees", () => {
  const graph = buildGraph(inventory([pipeline("A", [execute("CallB", "B")]), pipeline("B"), pipeline("C", [execute("CallB", "B")])]));
  const partial = evaluateDeletion(graph, [pid("A"), pid("B")]);
  assert.equal(partial.blocked, true);
  assert.deepEqual(partial.results[1].blockers.map(c => c.name), ["C"]);
  assert.equal(partial.results[1].callers.find(c => c.name === "A").internal, true);
  const all = evaluateDeletion(graph, [pid("B"), pid("C"), pid("A")]);
  assert.equal(all.blocked, false);
  assert.ok(all.order.indexOf(pid("A")) < all.order.indexOf(pid("B")));
  assert.ok(all.order.indexOf(pid("C")) < all.order.indexOf(pid("B")));
});

test("stopped triggers are blockers; indirect consumers carry paths, not direct blocker status", () => {
  const graph = buildGraph(inventory([pipeline("Root", [execute("CallA", "A")]), pipeline("A", [execute("CallB", "B")]), pipeline("B")], {
    triggers: [{ name: "Stopped", properties: { runtimeState: "Stopped",
      pipelines: [{ pipelineReference: ref("PipelineReference", "Root") }] } }]
  }));
  const b = evaluateDeletion(graph, [pid("B")]).results[0];
  assert.deepEqual(b.blockers.map(c => c.name), ["A"]);
  assert.ok(b.affected.find(c => c.name === "Root").path.length > 2);
  assert.ok(b.affected.some(c => c.name === "Stopped"));
  const all = evaluateDeletion(graph, [pid("Root"), pid("A"), pid("B")]);
  assert.equal(all.results.find(r => r.name === "Root").blockers[0].type, "trigger");
});

test("global dynamic and missing references never produce an all-clear for disconnected pipelines", () => {
  const graph = buildGraph(inventory([
    pipeline("Dynamic", [execute("Choose", { type: "Expression", value: "@pipeline().parameters.p" })]),
    pipeline("Missing", [execute("Unknown", "NotFound")]),
    pipeline("Independent")
  ]));
  assert.equal(graph.issues.length, 2);
  assert.equal(graph.nodes.get(pid("NotFound")).missing, true);
  assert.equal(evaluateDeletion(graph, [pid("Independent")]).results[0].status, "review");
  assert.throws(() => evaluateDeletion(graph, [pid("NotFound")]), /inexistente/);
});

test("cycles and self-invocations terminate traversal and prevent a simple deletion order", () => {
  for (const rows of [
    [pipeline("A", [execute("CallB", "B")]), pipeline("B", [execute("CallA", "A")])],
    [pipeline("A", [execute("Self", "A")])]
  ]) {
    const graph = buildGraph(inventory(rows));
    const result = evaluateDeletion(graph, rows.map(row => pid(row.name)));
    assert.equal(result.cycle, true);
    assert.equal(result.order, null);
    assert.ok(traverse(graph, pid("A"), "incoming").size <= graph.nodes.size);
  }
});

test("Switch cases, Until, data flows and direct linked-service references are traversed", () => {
  const graph = buildGraph(inventory([
    pipeline("A", [{ name: "Switch", type: "Switch", typeProperties: { cases: [{ value: "x", activities: [
      { name: "Until", type: "Until", typeProperties: { activities: [
        execute("RunB", "B"), { name: "Flow", type: "ExecuteDataFlow", typeProperties: { dataflow: ref("DataFlowReference", "Flow") } }
      ] } }
    ] }] } }]), pipeline("B")
  ], {
    dataflows: [{ name: "Flow", properties: { typeProperties: { sources: [{ linkedService: ref("LinkedServiceReference", "LS") }] } } }],
    linkedservices: [{ name: "LS", properties: { connectVia: ref("IntegrationRuntimeReference", "AutoResolveIntegrationRuntime") } }]
  }));
  assert.equal(graph.issues.length, 0);
  assert.equal(evaluateDeletion(graph, [pid("B")]).results[0].blockers[0].name, "A");
  assert.ok(traverse(graph, pid("A"), "outgoing").has(idFor("integrationRuntime", "AutoResolveIntegrationRuntime")));
});

test("unknown coverage, unconsumed nextLink, unknown reference types and external code are explicit", () => {
  const snapshot = inventory([pipeline("A", [{ name: "Web", type: "WebActivity" }])]);
  delete snapshot.collections.triggers;
  delete snapshot.metadata.completeness.datasets;
  snapshot.collections.pipelines = { value: snapshot.collections.pipelines, nextLink: "another-page" };
  snapshot.collections.dataflows = [{ name: "D", properties: { scriptLines: ["opaque code"], target: ref("NewReference", "X") } }];
  const graph = buildGraph(snapshot);
  assert.ok(graph.issues.some(i => i.message.includes("Inventario ausente")));
  assert.ok(graph.issues.some(i => i.message.includes("Completitud")));
  assert.ok(graph.issues.some(i => i.message.includes("paginado")));
  assert.ok(graph.issues.some(i => i.message.includes("no soportado")));
  assert.ok(graph.issues.some(i => i.message.includes("externo")));
  assert.equal(evaluateDeletion(graph, [pid("A")]).results[0].status, "review");
});

test("invalid formats and duplicates fail; case-insensitive references resolve without phantom nodes", () => {
  assert.throws(() => buildGraph({}), /Formato no valido/);
  assert.throws(() => buildGraph(inventory([{ name: "A" }])), /Objeto invalido/);
  assert.throws(() => buildGraph(inventory([pipeline("A"), pipeline("a")])), /duplicado/);
  const graph = buildGraph(inventory([pipeline("A", [execute("B", "b")]), pipeline("B")]));
  assert.equal(graph.issues.length, 0);
  assert.equal(evaluateDeletion(graph, [pid("B")]).results[0].blockers[0].name, "A");
  assert.throws(() => evaluateDeletion(graph, [idFor("dataset", "D")]), /inexistente/);
});

test("dependsOn does not invent object dependencies, empty complete inventories are supported", () => {
  const graph = buildGraph(inventory([pipeline("A", [
    { name: "Pipeline_B", type: "Wait" }, { name: "Wait", type: "Wait", dependsOn: [{ activity: "Pipeline_B" }] }
  ]), pipeline("Pipeline_B")]));
  assert.equal(evaluateDeletion(graph, [pid("Pipeline_B")]).results[0].status, "no-static-blockers");
  assert.equal(buildGraph(inventory()).nodes.size, 0);
});

test("browser import fixtures cover a clean batch and a rejected malformed inventory", () => {
  const read = name => JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", name), "utf8"));
  const graph = buildGraph(read("valid-inventory.json"));
  assert.equal(evaluateDeletion(graph, [pid("B")]).blocked, true);
  const batch = evaluateDeletion(graph, [pid("A"), pid("B")]);
  assert.equal(batch.blocked, false);
  assert.deepEqual(batch.order, [pid("A"), pid("B")]);
  assert.ok(batch.results.every(result => result.status === "no-static-blockers"));
  assert.throws(() => buildGraph(read("invalid-inventory.json")), /Objeto invalido/);
});

test("malformed reference objects and activity collections cannot silently grant a clean result", () => {
  for (const activity of [
    { name: "MissingType", type: "ExecutePipeline", typeProperties: { pipeline: { referenceName: "B" } } },
    { name: "EmptyRef", type: "ExecutePipeline", typeProperties: { pipeline: {} } },
    { name: "BadContainer", type: "ForEach", typeProperties: { activities: "invalid" } },
    null
  ]) {
    const graph = buildGraph(inventory([pipeline("A", [activity]), pipeline("B")]));
    assert.ok(graph.issues.length > 0);
    assert.equal(evaluateDeletion(graph, [pid("B")]).results[0].status, "review");
  }
});

test("metrics count consumers, not activities, and separate outgoing dependencies from incoming references", () => {
  const graph = buildGraph(inventory([
    pipeline("A", [execute("CallB1", "B"), execute("CallB2", "B")]),
    pipeline("B"), pipeline("Independent")
  ], {
    triggers: [{ name: "Stopped", properties: { runtimeState: "Stopped", pipeline: ref("PipelineReference", "B") } }]
  }));
  const metrics = pipelineMetrics(graph);
  assert.equal(metrics.total, 3);
  assert.equal(metrics.referenced, 1);
  assert.equal(metrics.unreferenced, 2);
  assert.equal(metrics.candidates, 2);
  assert.equal(metrics.review, 0);
  const b = metrics.rows.find(row => row.name === "B");
  assert.equal(b.consumers, 2);
  assert.equal(b.references, 3);
  const a = metrics.rows.find(row => row.name === "A");
  assert.equal(a.status, "candidate");
  assert.equal(a.dependencies, 1);
  assert.equal(a.consumers, 0);
});

test("metrics do not qualify dynamic inventories, self references, cycles or missing pipeline placeholders as deletion candidates", () => {
  const graph = buildGraph(inventory([
    pipeline("Self", [execute("Self", "Self")]),
    pipeline("A", [execute("B", "B")]), pipeline("B", [execute("A", "A")]),
    pipeline("Dynamic", [execute("Choose", { type: "Expression" }), execute("Missing", "Missing")]),
    pipeline("Independent")
  ]));
  const metrics = pipelineMetrics(graph);
  assert.equal(metrics.total, 5);
  assert.equal(metrics.referenced, 3);
  assert.equal(metrics.unreferenced, 2);
  assert.equal(metrics.candidates, 0);
  assert.equal(metrics.review, 2);
  assert.equal(metrics.percentUnreferenced, 40);
  assert.equal(metrics.rows.find(row => row.name === "Self").status, "referenced");
  const empty = pipelineMetrics(buildGraph(inventory()));
  assert.equal(empty.total, 0);
  assert.equal(empty.percentUnreferenced, 0);
});

test("dataset and dataflow metrics detect pipeline and dataflow consumers across types", () => {
  const graph = buildGraph(inventory([
    pipeline("A", [
      { name: "Copy1", type: "Copy", inputs: [ref("DatasetReference", "UsedDataset")] },
      { name: "Copy2", type: "Copy", inputs: [ref("DatasetReference", "UsedDataset")] },
      { name: "Transform", type: "ExecuteDataFlow", typeProperties: { dataflow: ref("DataFlowReference", "UsedFlow") } }
    ])
  ], {
    datasets: [{ name: "UsedDataset", properties: {} }, { name: "UnusedDataset", properties: {
      linkedServiceName: ref("LinkedServiceReference", "LS")
    } }],
    linkedservices: [{ name: "LS", properties: {} }],
    dataflows: [
      { name: "UsedFlow", properties: { sources: [ref("DatasetReference", "UsedDataset")] } },
      { name: "UnusedFlow", properties: { sources: [ref("DatasetReference", "MissingDataset")] } }
    ]
  }));
  const datasets = objectMetrics(graph, "dataset");
  assert.equal(datasets.total, 2);
  assert.equal(datasets.unreferenced, 1);
  assert.equal(datasets.review, 1);
  const used = datasets.rows.find(row => row.name === "UsedDataset");
  assert.equal(used.consumers, 2);
  assert.equal(used.references, 3);
  assert.equal(datasets.rows.find(row => row.name === "UnusedDataset").dependencies, 1);
  const flows = objectMetrics(graph, "dataflow");
  assert.equal(flows.total, 2);
  assert.equal(flows.referenced, 1);
  assert.equal(flows.unreferenced, 1);
  assert.equal(flows.candidates, 0);
  assert.equal(flows.review, 1);
  assert.equal(flows.rows.find(row => row.name === "UsedFlow").consumers, 1);
  assert.equal(objectMetrics(buildGraph(inventory()), "dataset").percentUnreferenced, 0);
  assert.throws(() => objectMetrics(graph, "linkedService"), /no admitido/);
});
