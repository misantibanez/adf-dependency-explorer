(function (root) {
  "use strict";
  const collections = {
    pipelines: "pipeline", datasets: "dataset", linkedservices: "linkedService",
    integrationRuntimes: "integrationRuntime", triggers: "trigger", dataflows: "dataflow",
    managedPrivateEndpoints: "managedPrivateEndpoint"
  };
  const referenceTypes = {
    PipelineReference: "pipeline", DatasetReference: "dataset",
    LinkedServiceReference: "linkedService", IntegrationRuntimeReference: "integrationRuntime",
    DataFlowReference: "dataflow", TriggerReference: "trigger"
  };
  const idFor = (type, name) => JSON.stringify([type, name.toLowerCase()]);
  const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
  function resourceKey(value) {
    if (typeof value !== "string") return null;
    const id = value.trim().replace(/\/$/, "");
    return /^\/subscriptions\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/resourceGroups\/[^/?#@]+\/providers\/[^/?#@\s]+(?:\/[^/?#@]+\/[^/?#@]+)+$/i.test(id) ?
      id.toLowerCase() : null;
  }
  function hostKey(value) {
    if (typeof value !== "string" || value.includes("@{")) return null;
    const match = /^(?:https?:\/\/)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)\.?(?::\d+|,\d+)?(?:[/?#].*)?$/i.exec(value.trim().replace(/^tcp:/i, ""));
    return match ? match[1].toLowerCase().replace(/\.privatelink\.(?=(?:blob|dfs|file|queue|table|web)\.core\.windows\.net$|database\.windows\.net$)/, ".") : null;
  }
  function linkedHosts(properties) {
    const values = Array.isArray(properties.networkHosts) ? [...properties.networkHosts] : [];
    for (const field of ["url", "serviceEndpoint", "baseUrl", "server", "host", "endpoint", "accountEndpoint", "sasUri"]) {
      values.push(properties.typeProperties?.[field]);
    }
    return [...new Set(values.map(hostKey).filter(Boolean))];
  }
  function endpointHosts(properties) {
    const result = new Map();
    for (const value of [...(Array.isArray(properties.networkHosts) ? properties.networkHosts : []),
      ...(Array.isArray(properties.fqdns) ? properties.fqdns : [])]) {
      const host = hostKey(value);
      if (host) result.set(host, "hostname del linked service = FQDN del endpoint");
    }
    const target = resourceKey(properties.privateLinkResourceId);
    const storage = /\/providers\/microsoft\.storage\/storageaccounts\/([a-z0-9]{3,24})$/.exec(target || "");
    if (storage) {
      for (const service of ["blob", "dfs", "file", "queue", "table", "web"]) {
        const host = `${storage[1]}.${service}.core.windows.net`;
        if (!result.has(host)) result.set(host, "hostname de Azure Storage = cuenta del Resource ID del endpoint (groupId no verificado)");
      }
    }
    const sql = /\/providers\/microsoft\.sql\/servers\/([a-z0-9-]+)$/.exec(target || "");
    if (sql && !result.has(`${sql[1]}.database.windows.net`)) {
      result.set(`${sql[1]}.database.windows.net`, "servidor SQL = recurso del Resource ID del endpoint");
    }
    return result;
  }

  function buildGraph(snapshot) {
    if (!isObject(snapshot) || snapshot.schemaVersion !== 1 || !isObject(snapshot.collections)) {
      throw new Error("Formato no valido: se requiere schemaVersion: 1 y collections.");
    }
    const nodes = new Map(), edges = [], issues = [], edgeKeys = new Set();
    const issue = (source, message) => issues.push({ source, message });
    function addNode(type, name, extra = {}) {
      const id = idFor(type, name);
      if (!nodes.has(id)) nodes.set(id, { id, type, name, ...extra });
      return id;
    }
    function edge(source, target, kind, evidence) {
      const key = JSON.stringify([source, target, kind, evidence]);
      if (!edgeKeys.has(key)) {
        edgeKeys.add(key);
        edges.push({ source, target, kind, evidence });
      }
    }
    const resources = [], networkTargets = new Map(), linkedTargets = [], hostTargets = new Map(), linkedNetworks = [];
    for (const [key, type] of Object.entries(collections)) {
      const raw = snapshot.collections[key];
      // Older inventories did not collect network objects; preserve their dependency analysis.
      if (key === "managedPrivateEndpoints" && raw === undefined && snapshot.metadata?.completeness?.[key] === undefined) continue;
      const rows = Array.isArray(raw) ? raw : isObject(raw) ? raw.value : undefined;
      if (!Array.isArray(rows)) {
        issue(null, `Inventario ausente o invalido: ${key}.`);
        continue;
      }
      if (raw.nextLink) issue(null, `Inventario paginado incompleto: ${key}.`);
      if (snapshot.metadata?.completeness?.[key] !== true) {
        issue(null, `Completitud no acreditada: ${key}.`);
      }
      for (const resource of rows) {
        if (!isObject(resource) || typeof resource.name !== "string" || !resource.name.trim() ||
            !isObject(resource.properties)) {
          throw new Error(`Objeto invalido en ${key}: requiere name y properties.`);
        }
        const id = idFor(type, resource.name);
        if (nodes.has(id)) throw new Error(`Objeto duplicado: ${type} / ${resource.name}.`);
        if (type === "managedPrivateEndpoint") {
          addNode(type, resource.name, {
            subtype: typeof resource.properties.groupId === "string" ? resource.properties.groupId : "",
            state: typeof resource.properties.connectionState?.status === "string" ? resource.properties.connectionState.status : "",
            provisioningState: typeof resource.properties.provisioningState === "string" ? resource.properties.provisioningState : ""
          });
          const target = resourceKey(resource.properties.privateLinkResourceId);
          if (target) {
            if (!networkTargets.has(target)) networkTargets.set(target, []);
            networkTargets.get(target).push(id);
          }
          for (const [host, evidence] of endpointHosts(resource.properties)) {
            if (!hostTargets.has(host)) hostTargets.set(host, []);
            hostTargets.get(host).push({ id, target, evidence });
          }
        } else {
          addNode(type, resource.name, { subtype: resource.properties.type || "", state: resource.properties.runtimeState || "" });
          resources.push({ id, type, resource });
          if (type === "linkedService") {
            const targets = [];
            for (const [path, value] of [
              ["properties.resourceId", resource.properties.resourceId],
              ["properties.typeProperties.resourceId", resource.properties.typeProperties?.resourceId]
            ]) {
              const target = resourceKey(value);
              if (target) { linkedTargets.push({ id, target, path }); targets.push(target); }
            }
            linkedNetworks.push({ id, targets, hosts: linkedHosts(resource.properties) });
          }
        }
      }
    }
    const matchedPairs = new Set();
    for (const { id, target, path } of linkedTargets) {
      for (const endpoint of networkTargets.get(target) || []) {
        edge(id, endpoint, "resourceMatch", `${path} = properties.privateLinkResourceId (Resource ID)`);
        matchedPairs.add(JSON.stringify([id, endpoint]));
      }
    }
    for (const { id, targets, hosts } of linkedNetworks) {
      for (const host of hosts) {
        for (const endpoint of hostTargets.get(host) || []) {
          if (targets.length && endpoint.target && !targets.includes(endpoint.target)) continue;
          const pair = JSON.stringify([id, endpoint.id]);
          if (matchedPairs.has(pair)) continue;
          edge(id, endpoint.id, "possibleNetwork", endpoint.evidence);
          matchedPairs.add(pair);
        }
      }
    }
    function reference(value, source, path) {
      const type = Object.hasOwn(referenceTypes, value.type) ? referenceTypes[value.type] : undefined;
      if (!type) {
        issue(source, `Tipo de referencia no soportado en ${path}: ${value.type}.`);
        return;
      }
      const name = value.referenceName;
      if (typeof name !== "string" || !name.trim() || name.startsWith("@") || name.includes("@{")) {
        issue(source, `Referencia dinamica o vacia en ${path}; resolver manualmente.`);
        return;
      }
      const id = idFor(type, name);
      if (!nodes.has(id)) {
        if (type === "integrationRuntime" && name.toLowerCase() === "autoresolveintegrationruntime") {
          addNode(type, name, { implicit: true, subtype: "Azure (predeterminado)" });
        } else {
          addNode(type, name, { missing: true });
          issue(source, `Referencia a objeto no encontrado: ${type} / ${name}.`);
        }
      }
      edge(source, id, "reference", value.path || path);
    }
    for (const { id, type, resource } of resources) {
      function walk(value, source, path) {
        const activityPath = type === "pipeline" && /(?:activities|ifTrueActivities|ifFalseActivities)\[\d+\]$/.test(path);
        if (activityPath && !isObject(value)) {
          issue(source, `Actividad invalida en ${path}.`);
          return;
        }
        if (Array.isArray(value)) {
          value.forEach((item, index) => walk(item, source, `${path}[${index}]`));
          return;
        }
        if (!isObject(value)) return;
        if (Object.hasOwn(value, "referenceName") || (typeof value.type === "string" && value.type.endsWith("Reference"))) {
          reference(value, source, path);
          return;
        }
        let current = source;
        if (activityPath) {
          if (typeof value.name !== "string" || typeof value.type !== "string") {
            issue(source, `Actividad invalida en ${path}.`);
          } else {
            current = addNode("activity", `${resource.name} / ${path} / ${value.name}`, {
              label: value.name, subtype: value.type, owner: id
            });
            edge(source, current, "contains", path);
            if (["WebActivity", "WebHook", "AzureFunctionActivity", "DatabricksNotebook",
              "DatabricksSparkPython", "DatabricksSparkJar", "Custom", "Script"].includes(value.type)) {
              issue(current, `Actividad ${value.type}: llamadas o codigo externo no analizados.`);
            }
            if (value.type === "ExecutePipeline" && value.typeProperties?.pipeline?.type !== "PipelineReference" &&
                !value.references?.some(ref => ref.type === "PipelineReference")) {
              issue(current, "ExecutePipeline sin referencia de pipeline identificable.");
            }
          }
        }
        for (const [key, child] of Object.entries(value)) {
          if (type === "pipeline" && ["activities", "ifTrueActivities", "ifFalseActivities"].includes(key) && !Array.isArray(child)) {
            issue(current, `Lista de actividades invalida en ${path}.${key}.`);
            continue;
          }
          if ((key === "script" || key === "scriptLines" || key === "uninspectedScript") && child) {
            issue(current, `Codigo o script no analizado en ${path}.${key}.`);
          }
          if (key === "linkedInfo" || key === "uninspectedLinkedInfo") {
            issue(current, "Integration runtime compartido: relacion entre factories no analizada.");
          }
          walk(child, current, `${path}.${key}`);
        }
      }
      walk(resource.properties, id, "properties");
    }
    const outgoing = new Map(), incoming = new Map();
    for (const node of nodes.values()) { outgoing.set(node.id, []); incoming.set(node.id, []); }
    for (const item of edges) { outgoing.get(item.source).push(item); incoming.get(item.target).push(item); }
    return { nodes, edges, issues, outgoing, incoming, metadata: snapshot.metadata || {} };
  }

  function traverse(graph, start, direction) {
    const index = direction === "incoming" ? graph.incoming : graph.outgoing;
    const paths = new Map([[start, [start]]]), queue = [start];
    for (let i = 0; i < queue.length; i++) {
      for (const edge of index.get(queue[i]) || []) {
        const next = direction === "incoming" ? edge.source : edge.target;
        if (!paths.has(next)) { paths.set(next, [...paths.get(queue[i]), next]); queue.push(next); }
      }
    }
    paths.delete(start);
    return paths;
  }

  function evaluateDeletion(graph, selectedIds) {
    const selected = new Set(selectedIds);
    for (const id of selected) {
      const node = graph.nodes.get(id);
      if (!node || node.type !== "pipeline" || node.missing) {
        throw new Error("La seleccion contiene un pipeline inexistente o un objeto de otro tipo.");
      }
    }
    const internalEdges = new Map([...selected].map(id => [id, new Set()]));
    const results = [...selected].map(id => {
      const callers = [];
      for (const edge of graph.incoming.get(id)) {
        if (edge.kind !== "reference") continue;
        const source = graph.nodes.get(edge.source);
        const callerId = source.owner || source.id;
        const caller = graph.nodes.get(callerId);
        const internal = selected.has(callerId);
        callers.push({ callerId, name: caller.name, type: caller.type, internal,
          activity: source.type === "activity" ? source.label : null, evidence: edge.evidence });
        if (internal) internalEdges.get(callerId).add(id);
      }
      const affected = [...traverse(graph, id, "incoming")]
        .filter(([ancestor]) => ["pipeline", "trigger"].includes(graph.nodes.get(ancestor).type) && !selected.has(ancestor))
        .map(([ancestor, path]) => ({ id: ancestor, name: graph.nodes.get(ancestor).name, path: [...path].reverse() }));
      const blockers = callers.filter(caller => !caller.internal);
      return { id, name: graph.nodes.get(id).name, callers, blockers, affected,
        status: blockers.length ? "blocked" : graph.issues.length ? "review" : "no-static-blockers" };
    });
    // A caller must disappear before its callee; the order is intentionally not execution order.
    const indegree = new Map([...selected].map(id => [id, 0]));
    for (const targets of internalEdges.values()) for (const id of targets) indegree.set(id, indegree.get(id) + 1);
    const order = [...selected].filter(id => indegree.get(id) === 0);
    for (let i = 0; i < order.length; i++) {
      for (const target of internalEdges.get(order[i])) {
        indegree.set(target, indegree.get(target) - 1);
        if (indegree.get(target) === 0) order.push(target);
      }
    }
    const cycle = order.length !== selected.size;
    return { results, issues: graph.issues, cycle, order: cycle ? null : order,
      blocked: results.some(result => result.blockers.length > 0), generatedAt: new Date().toISOString(),
      scope: "Analisis estatico de una factory; no autoriza ni ejecuta borrados." };
  }
  function objectMetrics(graph, type) {
    if (!["pipeline", "dataset", "dataflow"].includes(type)) throw new Error("Tipo de objeto no admitido para metricas.");
    const rows = [...graph.nodes.values()].filter(node => node.type === type && !node.missing).map(node => {
      const references = graph.incoming.get(node.id).filter(edge => edge.kind === "reference");
      const consumers = new Set(references.map(edge => graph.nodes.get(edge.source).owner || edge.source));
      const dependencies = new Set(traverse(graph, node.id, "outgoing").keys());
      for (const id of [...dependencies]) if (graph.nodes.get(id).type === "activity") dependencies.delete(id);
      return { id: node.id, name: node.name, consumers: consumers.size, references: references.length,
        dependencies: dependencies.size,
        status: references.length ? "referenced" : graph.issues.length ? "review" : "candidate" };
    }).sort((a, b) => a.name.localeCompare(b.name));
    const unreferenced = rows.filter(row => row.consumers === 0).length;
    return { rows, total: rows.length, referenced: rows.length - unreferenced, unreferenced,
      candidates: rows.filter(row => row.status === "candidate").length,
      review: rows.filter(row => row.status === "review").length,
      percentUnreferenced: rows.length ? unreferenced * 100 / rows.length : 0 };
  }
  function pipelineMetrics(graph) { return objectMetrics(graph, "pipeline"); }
  const api = { buildGraph, traverse, evaluateDeletion, objectMetrics, pipelineMetrics, idFor };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.AdfGraph = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
