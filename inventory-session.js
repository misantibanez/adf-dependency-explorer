"use strict";
window.AdfSession = {
  historyKey(graph) {
    return JSON.stringify(["subscriptionId", "resourceGroupName", "factoryName", "exportedAt"].map(key => graph.metadata[key] || ""));
  },
  saveHistory(graph, history) {
    const clean = {};
    for (const key of ["version", "factoryId", "source", "from", "to", "complete", "thresholdMonths"]) clean[key] = history[key];
    clean.pipelines = history.pipelines.map(({ pipelineName, lastRunStart, lastStatus, active }) => ({ pipelineName, lastRunStart, lastStatus, active }));
    try { sessionStorage.setItem("adf-pipeline-history", JSON.stringify({ inventory: this.historyKey(graph), history: clean })); }
    catch (failure) {
      try { sessionStorage.removeItem("adf-pipeline-history"); }
      catch (cleanupFailure) { console.error("No se pudo limpiar el historial anterior.", cleanupFailure); }
      throw new Error(`No se pudo compartir el historial con la pestana (${failure.name}).`);
    }
  },
  readHistory(graph) {
    const text = sessionStorage.getItem("adf-pipeline-history");
    if (!text) return null;
    const saved = JSON.parse(text);
    if (!saved || typeof saved.inventory !== "string" || !saved.history || !Array.isArray(saved.history.pipelines)) {
      throw new Error("El historial compartido no tiene un formato valido.");
    }
    return saved.inventory === this.historyKey(graph) ? saved.history : null;
  },
  save(graph) {
    const metadata = {};
    for (const key of ["factoryName", "source", "exportedAt", "subscriptionId", "resourceGroupName"]) {
      if (typeof graph.metadata[key] === "string") metadata[key] = graph.metadata[key];
    }
    try {
      sessionStorage.setItem("adf-current-graph", JSON.stringify({
        version: 1, nodes: [...graph.nodes.values()], edges: graph.edges, issues: graph.issues, metadata
      }));
    } catch (failure) {
      // Do not leave an older factory available to the metrics page after a failed save.
      try { sessionStorage.removeItem("adf-current-graph"); }
      catch (cleanupFailure) { console.error("No se pudo limpiar el inventario de la pestana.", cleanupFailure); }
      throw new Error(`No se pudo compartir el inventario con la pagina de metricas (${failure.name}). Usa el portal por HTTP y revisa el almacenamiento de la pestana.`);
    }
  },
  read() {
    const raw = sessionStorage.getItem("adf-current-graph");
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (data.version !== 1 || !Array.isArray(data.nodes) || !Array.isArray(data.edges) || !Array.isArray(data.issues)) {
      throw new Error("El inventario compartido no tiene un formato valido. Vuelve a cargar el ADF.");
    }
    const nodes = new Map(data.nodes.map(node => [node.id, node]));
    const outgoing = new Map(), incoming = new Map();
    for (const id of nodes.keys()) { outgoing.set(id, []); incoming.set(id, []); }
    for (const edge of data.edges) {
      if (!nodes.has(edge.source) || !nodes.has(edge.target)) throw new Error("El inventario compartido contiene relaciones invalidas.");
      outgoing.get(edge.source).push(edge); incoming.get(edge.target).push(edge);
    }
    return { nodes, edges: data.edges, issues: data.issues, metadata: data.metadata || {}, outgoing, incoming };
  }
};
