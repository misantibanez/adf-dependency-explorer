"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { createServer, factoryParameters } = require("../server.js");
const subscriptionId = "11111111-1111-1111-1111-111111111111";
const factoryId = `/subscriptions/${subscriptionId}/resourceGroups/rg-test/providers/Microsoft.DataFactory/factories/adf-test`;
const snapshot = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "valid-inventory.json"), "utf8"));

async function fixture(t, query) {
  const server = createServer(query);
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const headers = { "X-Adf-Client": "portal" };
  const session = await fetch(`${base}/api/session`, { headers });
  headers["X-Adf-Token"] = (await session.json()).token;
  return { base, headers, get: route => fetch(`${base}${route}`, { headers }) };
}
test("subscription -> factory -> full inventory uses validated parameters without exposing arbitrary CLI", async t => {
  const calls = [];
  const { get } = await fixture(t, async (operation, params) => {
    calls.push({ operation, params });
    if (operation === "subscriptions") return { subscriptions: [{ id: subscriptionId, name: "Subscription" }] };
    if (operation === "factories") return { factories: [{ id: factoryId, name: "adf-test" }] };
    return snapshot;
  });
  assert.equal((await (await get("/api/subscriptions")).json()).subscriptions[0].id, subscriptionId);
  assert.equal((await (await get(`/api/factories?subscriptionId=${subscriptionId}`)).json()).factories[0].id, factoryId);
  assert.deepEqual(await (await get(`/api/inventory?factoryId=${encodeURIComponent(factoryId)}`)).json(), snapshot);
  assert.deepEqual(calls, [
    { operation: "subscriptions", params: {} },
    { operation: "factories", params: { SubscriptionId: subscriptionId } },
    { operation: "inventory", params: { SubscriptionId: subscriptionId, ResourceGroupName: "rg-test", FactoryName: "adf-test" } }
  ]);
});
test("rejects foreign origins, forged host, missing token, unsafe IDs, methods and non-allowlisted files", async t => {
  let calls = 0;
  const { base, headers, get } = await fixture(t, async () => { calls++; return {}; });
  for (const route of ["/api/subscriptions", "/api/session"]) {
    assert.equal((await fetch(`${base}${route}`)).status, 403);
    assert.equal((await fetch(`${base}${route}`, { headers: { ...headers, Origin: "https://example.invalid" } })).status, 403);
  }
  const forgedStatus = await new Promise((resolve, reject) => {
    http.get(`${base}/api/subscriptions`, { headers: { ...headers, Host: "example.invalid" } }, response => {
      response.resume(); resolve(response.statusCode);
    }).on("error", reject);
  });
  assert.equal(forgedStatus, 403);
  assert.equal((await fetch(`${base}/api/subscriptions`, { headers: { ...headers, "X-Adf-Token": "é".repeat(64) } })).status, 403);
  assert.equal((await fetch(`${base}/api/subscriptions`, { method: "POST", headers })).status, 405);
  assert.equal((await get("/api/factories?subscriptionId=x%3BRemove-Item")).status, 400);
  assert.equal((await get("/api/inventory?factoryId=https%3A%2F%2Fexample.invalid")).status, 400);
  assert.equal((await get("/Export-AdfInventory.ps1")).status, 404);
  assert.equal((await get("/server.js")).status, 404);
  assert.equal(calls, 0);
});
test("Azure failures and invalid inventory do not return success-shaped partial data", async t => {
  const { get } = await fixture(t, async operation => {
    if (operation === "inventory") return { schemaVersion: 1, collections: { pipelines: [{ name: "Broken" }] } };
    throw new Error("Revisar az login y permisos Reader.");
  });
  const response = await get("/api/subscriptions");
  assert.equal(response.status, 502);
  assert.match((await response.json()).error, /az login/);
  const inventory = await get(`/api/inventory?factoryId=${encodeURIComponent(factoryId)}`);
  assert.equal(inventory.status, 502);
  assert.match((await inventory.json()).error, /Objeto invalido/);
});
test("one query at a time; releases busy state when a query finishes", async t => {
  let finish;
  const { get } = await fixture(t, () => new Promise(resolve => { finish = resolve; }));
  const first = get("/api/subscriptions");
  while (!finish) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await get("/api/subscriptions")).status, 409);
  finish({ subscriptions: [] });
  assert.equal((await first).status, 200);
});
test("only explicit portal assets are served; scoped factory IDs preserve group names", async t => {
  const { get } = await fixture(t, async () => { throw new Error("Unexpected Azure call"); });
  const response = await get("/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Seleccionar Azure Data Factory/);
  const metricsPage = await get("/metrics.html");
  assert.equal(metricsPage.status, 200);
  assert.match(await metricsPage.text(), /Metricas de objetos/);
  assert.equal((await get("/metrics.js")).status, 200);
  assert.equal((await get("/inventory-session.js")).status, 200);
  assert.equal(factoryParameters(factoryId.replace("rg-test", "Grupo (PE)")).ResourceGroupName, "Grupo (PE)");
  assert.throws(() => factoryParameters(factoryId + "/pipelines"), /invalido/);
  assert.throws(() => factoryParameters(factoryId.replace("rg-test", "rg-test;echo")), /invalido/);
});
test("history validates scope/source, summarizes runs and does not expose run IDs or parameters", async t => {
  const to = new Date().toISOString(), from = new Date(Date.now() - 45 * 86400000).toISOString();
  let wrongFactory = false;
  const { get } = await fixture(t, async (operation, params) => {
    assert.equal(operation, "history");
    return { factoryId: wrongFactory ? factoryId + "-other" : factoryId, source: params.Source, from, to,
      complete: params.Source === "api", runs: [{ pipelineName: "A", runId: "SECRET_RUN_ID", runStart: from, lastUpdated: from,
        status: "Failed", parameters: { password: "DO_NOT_EXPORT" } }] };
  });
  const route = `/api/history?factoryId=${encodeURIComponent(factoryId)}`;
  const response = await get(route);
  assert.equal(response.status, 200);
  const text = await response.text();
  assert.ok(!text.includes("DO_NOT_EXPORT") && !text.includes("SECRET_RUN_ID"));
  assert.equal(JSON.parse(text).pipelines[0].lastStatus, "Failed");
  assert.equal((await get(route + "&source=databricks")).status, 400);
  assert.equal((await get(route + "&source=loganalytics&workspaceId=unsafe")).status, 400);
  const logs = await get(route + `&source=loganalytics&workspaceId=${subscriptionId}&from=${encodeURIComponent(from)}&table=ADFPipelineRun`);
  assert.equal(logs.status, 200);
  assert.equal((await logs.json()).complete, false);
  assert.equal((await get(route + `&source=loganalytics&workspaceId=${subscriptionId}&from=${encodeURIComponent(from)}&table=ADFPipelineRun%3Bprint`)).status, 400);
  wrongFactory = true;
  assert.equal((await get(route)).status, 502);
  assert.equal((await get("/Pipeline-History.ps1")).status, 404);
  assert.equal((await get("/history.js")).status, 200);
});
