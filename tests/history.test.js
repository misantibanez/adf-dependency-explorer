"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { buildGraph, pipelineMetrics } = require("../graph.js");
const H = require("../history.js");
const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "valid-inventory.json"), "utf8"));
const graph = buildGraph(snapshot);
Object.assign(graph.metadata, { subscriptionId: "11111111-1111-1111-1111-111111111111", resourceGroupName: "rg-test", factoryName: "adf-test" });
const now = new Date("2025-03-31T12:00:00Z");
const metadata = { factoryId: H.factoryId(graph), source: "api", from: "2025-02-14T12:00:00Z", to: now.toISOString(), complete: true };
function run(pipelineName, runStart, status = "Succeeded", runId = pipelineName, lastUpdated = runStart) {
  return { pipelineName, runStart, status, runId, lastUpdated };
}
function evaluate(runs, changes = {}, months = 1, input = graph) {
  return H.evaluate(input, pipelineMetrics(input), H.fromRuns(runs, { ...metadata, ...changes }), months, now);
}
test("calendar months clamp month ends and retain UTC time; rejects invalid thresholds", () => {
  assert.equal(H.cutoff(1, now), "2025-02-28T12:00:00.000Z");
  assert.equal(H.cutoff(1, "2024-03-31T12:00:00Z"), "2024-02-29T12:00:00.000Z");
  for (const months of [0, -1, 1.5, 121, NaN]) assert.throws(() => H.cutoff(months, now), /umbral/);
});
test("qualifies only clean unreferenced pipelines with complete sufficient history; exact cutoff is recent", () => {
  const result = evaluate([run("A", "2025-02-20T12:00:00Z", "Failed"), run("B", "2025-02-20T12:00:00Z")]);
  assert.equal(result.candidates, 1);
  assert.equal(result.rows.find(row => row.name === "A").inactivityCandidate, true);
  assert.equal(result.rows.find(row => row.name === "B").inactivityCandidate, false);
  const recent = evaluate([run("A", "2025-02-28T12:00:00Z", "Failed")]);
  assert.equal(recent.candidates, 0);
  assert.equal(recent.rows[0].executionState, "recent");
  const warned = { ...graph, issues: [{ message: "Dynamic reference" }] };
  assert.equal(evaluate([], {}, 1, warned).candidates, 0);
});
test("no rows is unknown last date, not never executed; missing, stale, incomplete and 45-day/3-month histories cannot qualify", () => {
  const absent = H.evaluate(graph, pipelineMetrics(graph), null, 1, now);
  assert.equal(absent.rows[0].executionState, "unknown");
  assert.equal(absent.candidates, 0);
  const empty = evaluate([]);
  assert.equal(empty.candidates, 1);
  assert.equal(empty.rows[0].lastRunStart, null);
  assert.equal(empty.rows[0].executionState, "inactive");
  assert.equal(evaluate([], {}, 3).candidates, 0);
  assert.equal(evaluate([], { complete: false }).candidates, 0);
  assert.equal(evaluate([], { to: "2025-03-29T12:00:00Z" }).candidates, 0);
});
test("deduplicates run events by last update and excludes active runs even if their start is old", () => {
  const old = "2025-01-20T12:00:00Z";
  const runs = [run("A", old, "InProgress", "run1", "2025-03-30T12:00:00Z"),
    run("A", old, "Failed", "run1", "2025-03-31T11:00:00Z")];
  assert.equal(evaluate(runs).candidates, 1);
  assert.equal(evaluate(runs.slice(0, 1)).rows[0].executionState, "active");
  const queued = H.fromRuns([...runs, run("A", null, "Queued", "run2", "2025-03-31T11:30:00Z")], metadata);
  assert.equal(queued.pipelines[0].lastRunStart, old.replace("Z", ".000Z"));
  assert.equal(queued.pipelines[0].active, true);
  assert.equal(H.evaluate(graph, pipelineMetrics(graph), queued, 1, now).candidates, 0);
});
test("CSV supports BOM, semicolon, quoted delimiters/quotes and empty history; projects only history fields", () => {
  const csv = '\uFEFFpipelineName;runId;runStart;status;lastUpdated;password\r\n"A; ""quoted""";1;2025-02-20T12:00:00Z;Failed;2025-02-20T12:01:00Z;DO_NOT_STORE\r\n';
  const history = H.parseCsv(csv, metadata);
  assert.equal(history.source, "csv");
  assert.equal(history.pipelines[0].pipelineName, 'A; "quoted"');
  assert.ok(!JSON.stringify(history).includes("DO_NOT_STORE"));
  assert.equal(H.parseCsv("pipelineName,runId,runStart,status\n", metadata).pipelines.length, 0);
  for (const bad of ['pipelineName,runId,runStart,status\n"A,1,2025-02-20T12:00:00Z,Failed',
    "pipelineName,runId,runStart,status\nA,1,bad,Failed",
    "pipelineName,runId,runStart,status\nA,1,2025-02-30T12:00:00Z,Failed",
    "pipelineName,runId,runStart,status\nA,1,2025-02-20T12:00:00Z,Failed,extra",
    "pipelineName,status\nA,Failed"]) assert.throws(() => H.parseCsv(bad, metadata));
});
test("rejects unknown statuses, contradictory duplicate events, unzoned dates, another factory and future runs", () => {
  assert.throws(() => H.fromRuns([run("A", "2025-02-20T12:00:00", "Failed")], metadata), /zona/);
  assert.throws(() => H.fromRuns([run("A", "2025-02-20T12:00:00Z", "Unknown")], metadata), /reconocido/);
  assert.throws(() => H.fromRuns([run("A", "2025-04-01T12:00:00Z")], metadata), /posterior/);
  assert.throws(() => H.fromRuns([run("A", "2025-02-20T12:00:00Z"), run("A", "2025-02-20T12:00:00Z", "Failed")], metadata), /contradictorios/);
  assert.throws(() => H.validate(H.fromRuns([], metadata), metadata.factoryId + "-other"), /otro ADF/);
});
