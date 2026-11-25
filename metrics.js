"use strict";
const $ = id => document.getElementById(id);
const states = { referenced: "Con consumidores", review: "Sin consumidores / requiere revision", candidate: "Candidato sin bloqueos estaticos" };
const typeNames = { pipeline: "Pipelines", dataset: "Datasets", dataflow: "Data flows" };
let metrics, graph, history, inactivity, historyBusy = false;
const executionNames = { unknown: "Historial no cargado", insufficient: "Historial insuficiente / desactualizado",
  recent: "Ejecucion reciente", active: "Ejecucion activa o en cola", inactive: "Sin ejecuciones observadas desde el corte" };
function showError(message) { $("error").hidden = !message; $("error").textContent = message; }
function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function renderRows() {
  if (!metrics) return;
  const query = $("metrics-search").value.toLocaleLowerCase();
  const filter = $("metrics-filter").value;
  const rows = metrics.rows.filter(row => row.name.toLocaleLowerCase().includes(query) &&
    (filter === "all" || (filter === "inactive" ? row.inactivityCandidate : filter === "unreferenced" ? row.consumers === 0 : row.status === filter)));
  $("metrics-count").textContent = `${rows.length} de ${metrics.total} ${typeNames[$("metrics-type").value].toLowerCase()}. Los indicadores usan todos los objetos del tipo seleccionado, no el filtro de estado o busqueda.`;
  $("metrics-rows").replaceChildren();
  for (const row of rows) {
    const tr = element("tr");
    for (const value of [row.name, row.consumers, row.references, row.dependencies, states[row.status]]) {
      tr.append(element("td", String(value)));
    }
    if ($("metrics-type").value === "pipeline") {
      tr.append(element("td", row.lastRunStart || "Desconocida (sin registro observado)"),
        element("td", row.lastStatus || "Desconocido"),
        element("td", row.inactivityCandidate ? "CANDIDATO A REVISION POR INACTIVIDAD" : executionNames[row.executionState],
          row.inactivityCandidate ? "inactive-flag" : ""));
    }
    const cell = element("td"), link = element("a", "Ver dependencias", "button");
    link.href = `index.html?objectType=${$("metrics-type").value}&objectName=${encodeURIComponent(row.name)}`;
    cell.append(link); tr.append(cell); $("metrics-rows").append(tr);
  }
  if (!rows.length) {
    const cell = element("td", "No hay objetos que coincidan con el filtro."); cell.colSpan = $("metrics-type").value === "pipeline" ? 9 : 6;
    const tr = element("tr"); tr.append(cell); $("metrics-rows").append(tr);
  }
}
function renderMetrics() {
  if (!graph) return;
  const type = $("metrics-type").value;
  const name = typeNames[type];
  metrics = AdfGraph.objectMetrics(graph, type);
  const pipeline = type === "pipeline";
  $("history-panel").hidden = !pipeline;
  $("copy-inactive").hidden = !pipeline;
  $("metrics-filter").querySelector('option[value="inactive"]').disabled = !pipeline;
  document.querySelectorAll(".execution-column").forEach(node => { node.hidden = !pipeline; });
  if (pipeline) {
    inactivity = AdfHistory.evaluate(graph, metrics, history, Number($("history-months").value));
    metrics.rows = inactivity.rows;
    $("history-cutoff").textContent = `Corte UTC: ${inactivity.cutoff}. Se marca si no hay consumidores ni advertencias y no se observa ejecucion desde ese corte, con cobertura completa y reciente.${
      history && !inactivity.sufficient ? " COBERTURA INSUFICIENTE: intervalo corto, completitud no confirmada o datos de mas de 24 horas; ningun candidato por inactividad." : ""}`;
    $("copy-inactive").disabled = inactivity.candidates === 0;
  } else inactivity = null;
  $("metrics-stats").replaceChildren();
  $("distribution").replaceChildren();
  $("copy-status").textContent = "";
  $("metrics-table-title").textContent = `${name} y candidatos`;
  for (const [title, count] of [[`Total ${name.toLowerCase()}`, metrics.total], ["Con consumidores", metrics.referenced],
    ["Sin consumidores conocidos", metrics.unreferenced], ["Candidatos sin bloqueos estaticos", metrics.candidates],
    ["Sin consumidores / revisar", metrics.review]]) {
    const card = element("div", undefined, "stat");
    card.append(element("strong", String(count)), element("span", title)); $("metrics-stats").append(card);
  }
  if (pipeline) {
    const card = element("div", undefined, "stat");
    card.append(element("strong", String(inactivity.candidates)), element("span", "Sin consumidores + inactividad"));
    $("metrics-stats").append(card);
  }
  $("metrics-quality").textContent = graph.issues.length ?
    `${graph.issues.length} advertencias globales: los objetos sin consumidores requieren revision. Las referencias dinamicas o externas pueden ocultar consumidores.` :
    "Sin advertencias estaticas detectadas. Aun se deben revisar llamadas externas, ejecuciones activas y propietarios.";
  const meter = element("meter"); meter.min = 0; meter.max = 100; meter.value = metrics.percentUnreferenced;
  meter.setAttribute("aria-label", `Porcentaje de ${name.toLowerCase()} sin consumidores conocidos`);
  $("distribution").append(element("p", `${metrics.percentUnreferenced.toFixed(1)}% sin consumidores conocidos (${metrics.unreferenced}/${metrics.total})`), meter);
  $("copy-candidates").disabled = metrics.unreferenced === 0;
  renderRows();
}
try {
  graph = AdfSession.read();
  if (graph) {
    $("factory").textContent = graph.metadata.factoryName || "Factory sin nombre";
    $("source").textContent = `${graph.metadata.source || "Inventario importado"} | Extraido: ${graph.metadata.exportedAt || "fecha desconocida"}`;
    $("warnings-title").textContent = `Advertencias del inventario (${graph.issues.length})`;
    for (const issue of graph.issues) $("warnings").append(element("li", `${issue.source ? graph.nodes.get(issue.source)?.name + ": " : ""}${issue.message}`));
    try {
      history = AdfSession.readHistory(graph);
      if (history) {
        AdfHistory.validate(history, AdfHistory.factoryId(graph));
        if (history.thresholdMonths !== undefined) {
          AdfHistory.cutoff(history.thresholdMonths, new Date());
          $("history-months").value = String(history.thresholdMonths);
        }
        $("history-source").value = history.source;
        historySummary();
      }
    } catch (failure) {
      history = null;
      showError(`Historial compartido invalido: ${failure.message} Carga nuevamente el historial.`);
    }
    renderMetrics();
  }
} catch (failure) {
  $("error").hidden = false;
  $("error").textContent = `No se pudieron cargar las metricas. Vuelve al explorador y carga el inventario. ${failure.message}`;
}
$("metrics-search").addEventListener("input", renderRows);
$("metrics-filter").addEventListener("change", renderRows);
$("metrics-type").addEventListener("change", () => {
  $("metrics-search").value = "";
  if ($("metrics-type").value !== "pipeline" && $("metrics-filter").value === "inactive") $("metrics-filter").value = "unreferenced";
  renderMetrics();
});
function historySummary() {
  const names = new Set(AdfGraph.objectMetrics(graph, "pipeline").rows.map(row => row.name.toLowerCase()));
  const unknown = history.pipelines.filter(row => !names.has(row.pipelineName.toLowerCase())).length;
  $("history-status").textContent = `Historial ${history.source} cargado: ${history.from} -> ${history.to}. ${
    history.complete ? "Cobertura declarada completa" : "Completitud no acreditada"}; ${history.pipelines.length} pipelines con registros (${unknown} no presentes en el inventario). Fechas son observadas, no necesariamente toda su vida util.`;
}
function sourceControls() {
  const source = $("history-source").value;
  $("history-csv").hidden = source !== "csv";
  $("history-la").hidden = source !== "loganalytics";
  $("history-coverage").hidden = source === "api";
  $("history-until").hidden = source !== "csv";
  $("history-load").disabled = historyBusy || !graph;
  document.querySelectorAll("#history-panel input, #history-panel select").forEach(node => { node.disabled = historyBusy; });
}
function localInput(value) {
  const date = new Date(value); date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}
$("history-from").value = localInput(history?.from || Date.now() - 45 * 86400000);
$("history-to").value = localInput(history?.to || Date.now());
$("history-complete").checked = history?.complete || false;
$("history-source").addEventListener("change", sourceControls);
for (const id of ["history-source", "history-file", "history-from", "history-to", "history-workspace", "history-table"]) {
  $(id).addEventListener("input", () => { $("history-complete").checked = false; });
  $(id).addEventListener("change", () => { $("history-complete").checked = false; });
}
$("history-months").addEventListener("input", () => {
  try {
    renderMetrics(); showError("");
    if (history) {
      history.thresholdMonths = Number($("history-months").value);
      try { AdfSession.saveHistory(graph, history); }
      catch (failure) { showError(failure.message); }
    }
  }
  catch (failure) {
    // Invalid thresholds must never leave old candidate flags visible.
    metrics = null; inactivity = null; $("metrics-rows").replaceChildren(); $("metrics-stats").replaceChildren();
    $("copy-inactive").disabled = true; $("copy-candidates").disabled = true;
    showError(failure.message);
  }
});
$("history-load").addEventListener("click", async () => {
  if (historyBusy || !graph) return;
  historyBusy = true; sourceControls(); showError("");
  history = null;
  if (Number.isInteger(Number($("history-months").value)) && Number($("history-months").value) >= 1 && Number($("history-months").value) <= 120) renderMetrics();
  $("history-status").textContent = "Leyendo historial. El inventario de objetos no cambia...";
  try {
    const id = AdfHistory.factoryId(graph), source = $("history-source").value;
    let next;
    if (source === "csv") {
      const file = $("history-file").files[0];
      if (!file) throw new Error("Selecciona un CSV de ejecuciones.");
      if (file.size > 30 * 1024 * 1024) throw new Error("CSV supera 30 MB.");
      next = AdfHistory.parseCsv(await file.text(), { factoryId: id,
        from: new Date($("history-from").value).toISOString(), to: new Date($("history-to").value).toISOString(),
        complete: $("history-complete").checked });
    } else {
      if (location.protocol !== "http:" || location.hostname !== "127.0.0.1") throw new Error("API y Log Analytics requieren abrir el portal en http://127.0.0.1:8765 y ejecutar az login.");
      const sessionResponse = await fetch("/api/session", { headers: { "X-Adf-Client": "portal" }, cache: "no-store" });
      const session = await sessionResponse.json();
      if (!sessionResponse.ok) throw new Error(session.error || "No se pudo obtener la sesion local.");
      const params = new URLSearchParams({ factoryId: id, source });
      if (source === "loganalytics") {
        params.set("workspaceId", $("history-workspace").value.trim());
        params.set("from", new Date($("history-from").value).toISOString());
        params.set("table", $("history-table").value);
      }
      const response = await fetch(`/api/history?${params}`, {
        headers: { "X-Adf-Client": "portal", "X-Adf-Token": session.token }, cache: "no-store"
      });
      next = await response.json();
      if (!response.ok) throw new Error(next.error || "No se pudo consultar el historial.");
      if (source === "loganalytics") next.complete = $("history-complete").checked;
    }
    AdfHistory.validate(next, id);
    AdfHistory.evaluate(graph, AdfGraph.objectMetrics(graph, "pipeline"), next, Number($("history-months").value));
    history = { ...next, thresholdMonths: Number($("history-months").value) };
    renderMetrics(); historySummary();
    try { AdfSession.saveHistory(graph, history); }
    catch (failure) { showError(`Historial cargado, pero no se pudo conservar en la pestana: ${failure.message}`); }
  } catch (failure) {
    // An unsuccessful refresh invalidates inactivity decisions, even when older data existed.
    history = null;
    try { sessionStorage.removeItem("adf-pipeline-history"); }
    catch (cleanupFailure) { console.error("No se pudo limpiar el historial anterior.", cleanupFailure); }
    if (Number.isInteger(Number($("history-months").value)) && Number($("history-months").value) >= 1 && Number($("history-months").value) <= 120) renderMetrics();
    $("history-status").textContent = "Historial no cargado: la consulta fallo. No se mantienen candidatos basados en datos anteriores.";
    showError(failure.message);
  } finally { historyBusy = false; sourceControls(); }
});
$("copy-inactive").addEventListener("click", async () => {
  try {
    renderMetrics();
    const names = inactivity.rows.filter(row => row.inactivityCandidate).map(row => row.name);
    await navigator.clipboard.writeText(names.join("\n"));
    $("copy-status").textContent = `${names.length} candidatos por inactividad copiados. Revisar propietarios y ejecuciones activas antes de tramitar el borrado.`;
  } catch (failure) { $("copy-status").textContent = `No se pudo copiar (${failure.name}).`; }
});
sourceControls();
setInterval(() => {
  if (!graph || historyBusy || !history) return;
  const months = Number($("history-months").value);
  if (Number.isInteger(months) && months >= 1 && months <= 120) renderMetrics();
}, 60000);
$("copy-candidates").addEventListener("click", async () => {
  const type = $("metrics-type").value;
  const names = metrics.rows.filter(row => row.consumers === 0).map(row => row.name);
  try {
    await navigator.clipboard.writeText(names.join("\n"));
    $("copy-status").textContent = `${names.length} nombres de ${typeNames[type].toLowerCase()} copiados. ${
      type === "pipeline" ? "Pegalos en la seleccion del explorador para revisar el conjunto." :
        "Revisa cada objeto en el grafo; la evaluacion de borrado por conjunto solo admite pipelines."}`;
  } catch (failure) {
    $("copy-status").textContent = `No se pudo copiar la lista (${failure.name}). Selecciona los nombres manualmente en la tabla.`;
  }
});
