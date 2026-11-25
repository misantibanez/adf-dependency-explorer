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

test("managed private endpoints appear as scoped network inventory without invented dependencies or deletion metrics", () => {
  const legacy = inventory([pipeline("A")]);
  const legacyGraph = buildGraph(legacy);
  const snapshot = structuredClone(legacy);
  snapshot.collections.managedPrivateEndpoints = ["default", "other"].map(network => ({
    name: `${network}/MPE_Test`, properties: { groupId: "blob", provisioningState: "Succeeded",
      connectionState: { status: "Approved" }, privateLinkResourceId: "DO_NOT_STORE",
      injected: ref("PipelineReference", "A") }
  }));
  snapshot.metadata.completeness.managedPrivateEndpoints = true;
  const graph = buildGraph(snapshot);
  assert.equal(graph.nodes.size, legacyGraph.nodes.size + 2);
  const node = graph.nodes.get(idFor("managedPrivateEndpoint", "default/MPE_Test"));
  assert.equal(node.state, "Approved");
  assert.equal(node.subtype, "blob");
  assert.equal(graph.incoming.get(node.id).length, 0);
  assert.equal(graph.outgoing.get(node.id).length, 0);
  assert.ok(!JSON.stringify([...graph.nodes.values()]).includes("DO_NOT_STORE"));
  assert.deepEqual(pipelineMetrics(graph), pipelineMetrics(legacyGraph));
  assert.throws(() => objectMetrics(graph, "managedPrivateEndpoint"), /no admitido/);
  assert.throws(() => evaluateDeletion(graph, [node.id]), /otro tipo/);
  snapshot.collections.managedPrivateEndpoints = {};
  assert.ok(buildGraph(snapshot).issues.some(issue => issue.message.includes("managedPrivateEndpoints")));
});

test("resource ID correlation connects linked services and transitive pipeline consumers to every matching endpoint", () => {
  const resourceId = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-test/providers/Microsoft.Storage/storageAccounts/lake";
  const snapshot = inventory([pipeline("A", [{ name: "Copy", type: "Copy", inputs: [ref("DatasetReference", "D")] }])], {
    datasets: [{ name: "D", properties: { linkedServiceName: ref("LinkedServiceReference", "LS") } }],
    linkedservices: [
      { name: "LS", properties: { typeProperties: { resourceId: ` ${resourceId.toUpperCase()}/ ` } } },
      { name: "LS_Top", properties: { resourceId } }
    ],
    managedPrivateEndpoints: ["default/blob", "default/dfs", "other/blob"].map(name => ({
      name, properties: { privateLinkResourceId: resourceId, groupId: name.endsWith("dfs") ? "dfs" : "blob" }
    }))
  });
  const graph = buildGraph(snapshot);
  const endpoint = idFor("managedPrivateEndpoint", "default/blob");
  assert.equal(graph.issues.length, 0);
  assert.equal(graph.incoming.get(endpoint).length, 2);
  assert.equal(graph.edges.filter(edge => edge.kind === "resourceMatch").length, 6);
  assert.ok(graph.incoming.get(endpoint).every(edge => edge.evidence.includes("privateLinkResourceId")));
  const consumers = traverse(graph, endpoint, "incoming");
  for (const id of [pid("A"), idFor("dataset", "D"), idFor("linkedService", "LS")]) assert.ok(consumers.has(id));
  assert.ok(traverse(graph, pid("A"), "outgoing").has(endpoint));
  assert.equal(pipelineMetrics(graph).rows[0].status, "candidate");
  assert.ok(!JSON.stringify(graph.edges).toLowerCase().includes(resourceId.toLowerCase()));
});

test("resource correlation rejects dynamic, malformed, missing, partial and different-resource IDs", () => {
  const resourceId = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-test/providers/Microsoft.Storage/storageAccounts/lake";
  const invalid = [undefined, "", "@pipeline().parameters.resourceId", { type: "Expression", value: resourceId },
    "https://lake.blob.core.windows.net", resourceId + "/child", resourceId + "/blobServices/default",
    resourceId.replace("11111111-", "22222222-"), resourceId.replace("rg-test", "another-rg"), resourceId + "?token=secret"];
  const snapshot = inventory([], {
    linkedservices: invalid.map((resourceId, index) => ({ name: `LS_${index}`, properties: { typeProperties: { resourceId } } })),
    managedPrivateEndpoints: [{ name: "default/blob", properties: { privateLinkResourceId: resourceId } }]
  });
  assert.equal(buildGraph(snapshot).edges.filter(edge => edge.kind === "resourceMatch").length, 0);
  snapshot.collections.linkedservices = [{ name: "LS", properties: { typeProperties: { resourceId } } }];
  for (const privateLinkResourceId of invalid) {
    snapshot.collections.managedPrivateEndpoints[0].properties.privateLinkResourceId = privateLinkResourceId;
    assert.equal(buildGraph(snapshot).edges.filter(edge => edge.kind === "resourceMatch").length, 0);
  }
});

test("possible linked services include ADLS URLs without Resource IDs and trace back to pipelines", () => {
  const target = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-test/providers/Microsoft.Storage/storageAccounts/lake";
  const snapshot = inventory([pipeline("A", [{ name: "Copy", type: "Copy", inputs: [ref("DatasetReference", "D")] }])], {
    datasets: [{ name: "D", properties: { linkedServiceName: ref("LinkedServiceReference", "LS_Lake") } }],
    linkedservices: [{ name: "LS_Lake", properties: { type: "AzureBlobFS", typeProperties: {
      url: "https://LAKE.dfs.core.windows.net/container?sig=DO_NOT_STORE"
    } } }],
    managedPrivateEndpoints: ["default/blob", "default/dfs"].map(name => ({
      name, properties: { privateLinkResourceId: target, groupId: name.split("/")[1], fqdns: [] }
    }))
  });
  const graph = buildGraph(snapshot);
  const matches = graph.edges.filter(edge => edge.kind === "possibleNetwork");
  assert.equal(matches.length, 2);
  assert.ok(matches.every(edge => edge.evidence.includes("groupId no verificado")));
  const incoming = traverse(graph, idFor("managedPrivateEndpoint", "default/dfs"), "incoming");
  assert.ok(incoming.has(pid("A")));
  assert.ok(incoming.has(idFor("dataset", "D")));
  assert.equal(pipelineMetrics(graph).rows[0].status, "candidate");
  assert.ok(!JSON.stringify([...graph.nodes.values(), ...graph.edges]).includes("DO_NOT_STORE"));
});

test("possible network matches use exact DNS names, SQL servers or sanitized host projections, not names or secrets", () => {
  const snapshot = inventory([], {
    linkedservices: [
      { name: "Custom", properties: { typeProperties: { serviceEndpoint: "https://custom.example.net:443/path?secret=DO_NOT_STORE" } } },
      { name: "SQL", properties: { typeProperties: { server: "tcp:sqltest.database.windows.net,1433" } } },
      { name: "Projected", properties: { networkHosts: ["SQLTEST.privatelink.database.windows.net."] } }
    ],
    managedPrivateEndpoints: [
      { name: "default/custom", properties: { fqdns: ["CUSTOM.example.net."] } },
      { name: "default/sql", properties: { privateLinkResourceId: "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-test/providers/Microsoft.Sql/servers/sqltest" } }
    ]
  });
  const graph = buildGraph(snapshot);
  assert.equal(graph.edges.filter(edge => edge.kind === "possibleNetwork").length, 3);
  const invalid = ["https://custom.example.net.evil.test", "https://notcustom.example.net", "@{linkedService().url}",
    { type: "Expression", value: "https://custom.example.net" }, { type: "SecureString", value: "https://custom.example.net" },
    "https://custom.example.net@evil.test", "https://evil.test/path/custom.example.net", "custom.privatelink.example.net", undefined];
  snapshot.collections.linkedservices = invalid.map((url, i) => ({ name: `custom.example.net_${i}`, properties: { typeProperties: { url } } }));
  assert.equal(buildGraph(snapshot).edges.filter(edge => edge.kind === "possibleNetwork").length, 0);
});

test("exact resource matches take precedence over hostname matches and conflicting resource IDs do not create possible links", () => {
  const target = "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-test/providers/Microsoft.Storage/storageAccounts/lake";
  const snapshot = inventory([], {
    linkedservices: [
      { name: "Exact", properties: { typeProperties: { resourceId: target, url: "https://lake.dfs.core.windows.net" } } },
      { name: "Conflict", properties: { typeProperties: { resourceId: target.replace("rg-test", "other-rg"), url: "https://lake.dfs.core.windows.net" } } }
    ],
    managedPrivateEndpoints: [{ name: "default/dfs", properties: { privateLinkResourceId: target, networkHosts: ["lake.dfs.core.windows.net"] } }]
  });
  const graph = buildGraph(snapshot);
  assert.equal(graph.edges.length, 1);
  assert.equal(graph.edges[0].kind, "resourceMatch");
  assert.equal(graph.edges[0].source, idFor("linkedService", "Exact"));
});

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
