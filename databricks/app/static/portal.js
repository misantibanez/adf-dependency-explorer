"use strict";
const $ = id => document.getElementById(id);
let graph, history, focused, report, busy = false;
const selected = new Set();
const stateNames = { referenced: "Con consumidores", review: "Requiere revision", candidate: "Sin bloqueos estaticos" };
const executionNames = { unknown: "Sin historial", insufficient: "Cobertura insuficiente", recent: "Reciente",
  active: "Activa / en cola", inactive: "Sin ejecuciones observadas desde el corte" };
function node(tag, text) {
  const result = document.createElement(tag);
  if (text !== undefined) result.textContent = text;
  return result;
}
function error(message) { $("error").textContent = message; $("error").hidden = !message; }
function controls() {
  $("refresh").disabled = busy;
  $("load").disabled = busy || !$("snapshot").value;
  $("snapshot").disabled = busy || !$("snapshot").options.length;
}
async function request(path) {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  if (response.redirected) throw new Error("La sesion cambio; recarga la pagina e inicia sesion en Databricks.");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
async function action(callback) {
  if (busy) return;
  busy = true; controls(); error("");
  try { await callback(); }
  catch (failure) {
    $("status").textContent = "La consulta no se completo.";
    error(`${failure.message} Se conserva el inventario anterior, si existe.`);
  }
  finally { busy = false; controls(); }
}
async function refresh() {
  await action(async () => {
    const data = await request("api/snapshots");
    const previous = $("snapshot").value, options = [];
    for (const row of data.snapshots) {
      const option = node("option", `${row.factory_name} | ${row.collected_at} | ${row.factory_id}`);
      option.value = row.snapshot_id; options.push(option);
    }
    $("snapshot").replaceChildren(...options);
    if (options.some(option => option.value === previous)) $("snapshot").value = previous;
    $("status").textContent = options.length ? `${options.length} factories publicadas. Elige un snapshot y pulsa Cargar.` :
      "No hay snapshots publicados. Ejecutar el notebook antes de usar la App.";
  });
}
function focus(id) { focused = id; renderGraph(); }
function showSnapshot(data) {
  const next = AdfGraph.buildGraph(data.inventory);
  const nextHistory = data.history === null ? null : AdfHistory.validate(data.history, AdfHistory.factoryId(next));
  graph = next; history = nextHistory; selected.clear(); report = null;
  $("batch").value = ""; $("search").value = ""; $("type").value = ""; $("months").value = "3";
  focused = [...graph.nodes.values()].find(row => row.type === "pipeline" && !row.missing)?.id || graph.nodes.keys().next().value;
  $("factory").textContent = graph.metadata.factoryName;
  $("metadata").textContent = `${AdfHistory.factoryId(graph)} | Extraido: ${graph.metadata.exportedAt}`;
  $("warnings-title").textContent = `Advertencias (${graph.issues.length})`;
  $("warnings").replaceChildren(...graph.issues.map(row => node("li", row.message)));
  renderObjects(); renderGraph(); renderReport();
}
function renderObjects() {
  if (!graph) return;
  const months = Number($("months").value);
  const pipelines = AdfGraph.pipelineMetrics(graph);
  const evaluation = AdfHistory.evaluate(graph, pipelines, history, months);
  const rows = new Map(evaluation.rows.map(row => [row.id, row]));
  const stats = [];
  for (const type of ["pipeline", "dataset", "dataflow"]) {
    const metrics = type === "pipeline" ? pipelines : AdfGraph.objectMetrics(graph, type);
    for (const row of metrics.rows) if (type !== "pipeline") rows.set(row.id, row);
    const card = node("div", `${type}: ${metrics.total} | sin consumidores: ${metrics.unreferenced} | candidatos estaticos: ${metrics.candidates}`);
    card.className = "stat"; stats.push(card);
  }
  $("stats").replaceChildren(...stats);
  $("history-status").textContent = history ?
    `${history.source} | ${history.from} -> ${history.to} | cobertura ${evaluation.sufficient ? "suficiente" : "INSUFICIENTE / no confirmada / desactualizada"} | corte: ${evaluation.cutoff} | candidatos por inactividad: ${evaluation.candidates}` :
    "Sin historial: no se acredita inactividad. Configurar history_source en el notebook.";
  const query = $("search").value.toLocaleLowerCase(), type = $("type").value;
  const elements = [];
  for (const item of [...graph.nodes.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if ((type && item.type !== type) || !item.name.toLocaleLowerCase().includes(query)) continue;
    const row = rows.get(item.id), tr = node("tr"), select = node("td"), name = node("td");
    if (item.type === "pipeline" && !item.missing) {
      const box = node("input"); box.type = "checkbox"; box.checked = selected.has(item.id);
      box.setAttribute("aria-label", `Seleccionar ${item.name}`);
      box.addEventListener("change", () => {
        if (box.checked) selected.add(item.id); else selected.delete(item.id);
        renderReport();
      }); select.append(box);
    }
    const button = node("button", item.name + (item.missing ? " / FALTA" : ""));
    button.addEventListener("click", () => focus(item.id)); name.append(button);
    tr.append(select, name);
    for (const value of [item.type, row?.consumers ?? "-", row?.references ?? "-", row?.dependencies ?? "-",
      row ? stateNames[row.status] : "-", row?.lastRunStart || "-", row?.executionState ?
        `${executionNames[row.executionState]}${row.inactivityCandidate ? " / CANDIDATO A REVISION" : ""}` : "-"]) {
      tr.append(node("td", String(value)));
    }
    elements.push(tr);
  }
  $("objects").replaceChildren(...elements);
}
function svg(tag, attrs, text) {
  const result = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) result.setAttribute(key, value);
  if (text !== undefined) result.textContent = text;
  return result;
}
function renderGraph() {
  const canvas = $("graph"); canvas.replaceChildren(); $("relations").replaceChildren();
  if (!graph || !focused) { $("focus").textContent = "Inventario vacio"; $("graph-status").textContent = ""; return; }
  const current = graph.nodes.get(focused);
  $("focus").textContent = `${current.type} / ${current.name}`;
  const visible = new Set([focused]), depth = Number($("depth").value);
  for (const branch of ["incoming", "outgoing"]) {
    for (const [id, path] of AdfGraph.traverse(graph, focused, branch)) if (path.length - 1 <= depth) visible.add(id);
  }
  const ids = [...visible].slice(0, 120), shown = new Set(ids);
  $("graph-status").textContent = `${ids.length} de ${visible.size} nodos del contexto (maximo visual: 120). El reporte usa todo el grafo.`;
  const types = [...new Set(ids.map(id => graph.nodes.get(id).type))];
  const columns = types.map(type => ids.filter(id => graph.nodes.get(id).type === type));
  const width = Math.max(600, columns.length * 255), height = Math.max(240, ...columns.map(col => col.length * 90 + 40));
  canvas.setAttribute("width", width); canvas.setAttribute("height", height);
  canvas.setAttribute("viewBox", `0 0 ${width} ${height}`);
  const defs = svg("defs", {}), marker = svg("marker", { id: "arrow", viewBox: "0 0 10 10", refX: "9", refY: "5", markerWidth: "6", markerHeight: "6", orient: "auto-start-reverse" });
  marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#96b3cb" })); defs.append(marker); canvas.append(defs);
  const positions = new Map();
  columns.forEach((column, x) => column.forEach((id, y) => positions.set(id, { x: 15 + x * 255, y: 20 + y * 90 })));
  for (const edge of graph.edges) {
    if (!shown.has(edge.source) || !shown.has(edge.target)) continue;
    const a = positions.get(edge.source), b = positions.get(edge.target);
    const path = svg("path", { class: `edge${edge.kind === "possibleNetwork" ? " possible" : ""}`,
      d: `M ${a.x + 110} ${a.y + 25} C ${a.x + 230} ${a.y + 65}, ${b.x - 20} ${b.y + 65}, ${b.x + 110} ${b.y + 25}`, "marker-end": "url(#arrow)" });
    path.append(svg("title", {}, `${edge.kind}: ${edge.evidence}`)); canvas.append(path);
  }
  for (const id of ids) {
    const item = graph.nodes.get(id), pos = positions.get(id), group = svg("g", {
      class: "node", transform: `translate(${pos.x},${pos.y})`, role: "button", tabindex: "0", "aria-label": `Explorar ${item.name}`,
    });
    group.append(svg("title", {}, item.name), svg("rect", { width: "220", height: "55", rx: "7" }),
      svg("text", { x: "8", y: "22" }, item.name.length > 28 ? item.name.slice(0, 26) + "..." : item.name),
      svg("text", { x: "8", y: "42" }, item.type));
    group.addEventListener("click", () => focus(id));
    group.addEventListener("keydown", event => {
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); focus(id); }
    });
    canvas.append(group);
  }
  for (const edge of graph.edges.filter(edge => edge.source === focused || edge.target === focused)) {
    const item = node("li", `${graph.nodes.get(edge.source).name} -> ${graph.nodes.get(edge.target).name} | ${edge.kind}: ${edge.evidence}`);
    $("relations").append(item);
  }
}
function renderReport() {
  $("report").replaceChildren(); $("export").disabled = !selected.size; report = null;
  if (!graph || !selected.size) { $("report").append(node("p", "Selecciona pipelines para simular su impacto.")); return; }
  report = AdfGraph.evaluateDeletion(graph, selected);
  for (const row of report.results) {
    const card = node("article"); card.className = "result";
    card.append(node("h3", `${row.name} / ${row.status}`));
    for (const caller of row.callers) card.append(node("p", `${caller.name} / ${caller.internal ? "dentro del lote" : "FUERA del lote"} / ${caller.evidence}`));
    for (const affected of row.affected) card.append(node("p", affected.path.map(id => graph.nodes.get(id).name).join(" -> ")));
    $("report").append(card);
  }
  $("report").append(node("p", report.cycle ? "Ciclo detectado: no existe orden simple." : report.blocked ?
    "BLOQUEADO: hay consumidores externos al lote." :
    `Orden estructural candidato (no autoriza borrado): ${report.order.map(id => graph.nodes.get(id).name).join(" -> ")}`));
  $("report").append(node("p", `${graph.issues.length} advertencias globales. Validar llamadas externas, ejecuciones activas y propietarios.`));
}
$("refresh").addEventListener("click", refresh);
$("snapshot").addEventListener("change", controls);
$("load").addEventListener("click", () => action(async () => {
  $("status").textContent = "Leyendo snapshot publicado...";
  const data = await request(`api/snapshots/${encodeURIComponent($("snapshot").value)}`);
  showSnapshot(data); $("status").textContent = "Snapshot cargado desde Delta. No se consulto Azure.";
}));
for (const id of ["search", "type", "months"]) $(id).addEventListener(id === "search" ? "input" : "change", () => {
  try { renderObjects(); error(""); } catch (failure) { error(failure.message); }
});
$("depth").addEventListener("change", renderGraph);
$("select").addEventListener("click", () => {
  if (!graph) { error("Cargar un snapshot antes de seleccionar."); return; }
  const names = $("batch").value.split(/[\r\n,;]+/).map(value => value.trim()).filter(Boolean);
  const ids = names.map(name => AdfGraph.idFor("pipeline", name));
  if (!ids.length || ids.some(id => !graph.nodes.has(id) || graph.nodes.get(id).missing)) {
    error("Ingresar nombres de pipelines existentes. No se cambio la seleccion."); return;
  }
  ids.forEach(id => selected.add(id)); error(""); renderObjects(); renderReport();
});
$("clear").addEventListener("click", () => { selected.clear(); renderObjects(); renderReport(); });
$("export").addEventListener("click", () => {
  if (!report) return;
  const payload = { ...report, inventory: graph.metadata, nodeNames: Object.fromEntries([...graph.nodes].map(([id, value]) => [id, value.name])) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
  const anchor = node("a"); anchor.href = url; anchor.download = "adf-databricks-impacto.json";
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
refresh();
