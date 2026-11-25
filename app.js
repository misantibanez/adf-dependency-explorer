"use strict";
const $ = id => document.getElementById(id);
const names = { pipeline: "Pipeline", activity: "Actividad", dataset: "Dataset",
  linkedService: "Linked service", integrationRuntime: "Integration runtime", trigger: "Trigger", dataflow: "Data flow" };
const colors = { pipeline: "#77b9ff", activity: "#b199ef", dataset: "#56d3bb",
  linkedService: "#f0ba72", integrationRuntime: "#e988ac", trigger: "#f1dc7e", dataflow: "#65c7ed" };
let graph, focused, report, zoom = 1;
const selected = new Set();
function element(tag, text, className) {
  const el = document.createElement(tag);
  if (text !== undefined) el.textContent = text;
  if (className) el.className = className;
  return el;
}
function error(message) { $("error").textContent = message; $("error").hidden = !message; }
function label(node) { return node.label || node.name; }
function linkNode(id, text) {
  const button = element("button", text || label(graph.nodes.get(id)));
  button.addEventListener("click", () => focus(id));
  return button;
}
function load(snapshot) {
  displayGraph(AdfGraph.buildGraph(snapshot));
}
function displayGraph(next) {
  graph = next;
  selected.clear();
  $("search").value = ""; $("type").value = ""; $("batch").value = "";
  focused = [...graph.nodes.values()].find(n => n.type === "pipeline" && !n.missing)?.id || graph.nodes.keys().next().value;
  const meta = graph.metadata;
  $("factory").textContent = meta.factoryName || "Factory sin nombre";
  $("source").textContent = `${meta.source || "Inventario importado"} | Extraido: ${meta.exportedAt || "fecha desconocida"} | ${graph.nodes.size} nodos / ${graph.edges.length} relaciones`;
  $("stats").replaceChildren();
  for (const [title, value] of [["Pipelines", [...graph.nodes.values()].filter(n => n.type === "pipeline" && !n.missing).length],
    ["Relaciones", graph.edges.length], ["Advertencias", graph.issues.length]]) {
    const card = element("div", undefined, "stat");
    card.append(element("strong", String(value)), element("span", title)); $("stats").append(card);
  }
  $("legend").replaceChildren();
  for (const [type, name] of Object.entries(names)) {
    const item = element("span");
    item.append(element("i", undefined, `dot ${type}`), document.createTextNode(name)); $("legend").append(item);
  }
  $("warnings-title").textContent = `Advertencias del inventario (${graph.issues.length})`;
  const list = element("ul");
  for (const issue of graph.issues) {
    const item = element("li", `${issue.source ? graph.nodes.get(issue.source)?.name + ": " : ""}${issue.message}`);
    list.append(item);
  }
  $("warnings").replaceChildren(graph.issues.length ? list : element("p", "Sin advertencias detectadas. Persisten los limites del analisis estatico."));
  error(""); renderObjects(); renderGraph(); renderReport();
  try { AdfSession.save(graph); }
  catch (failure) { error(failure.message); }
}
function focus(id) {
  focused = id; zoom = 1;
  renderObjects(); renderGraph();
}
function renderObjects() {
  const query = $("search").value.toLocaleLowerCase(), type = $("type").value;
  const rows = [...graph.nodes.values()].filter(n => (!type || n.type === type) && n.name.toLocaleLowerCase().includes(query))
    .sort((a, b) => a.type.localeCompare(b.type) || a.name.localeCompare(b.name));
  $("count").textContent = String(rows.length); $("objects").replaceChildren();
  for (const node of rows) {
    const row = element("div", undefined, `object-row${node.id === focused ? " active" : ""}`);
    if (node.type === "pipeline" && !node.missing) {
      const checkbox = element("input"); checkbox.type = "checkbox"; checkbox.checked = selected.has(node.id);
      checkbox.setAttribute("aria-label", `Seleccionar ${node.name} para evaluar borrado`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) selected.add(node.id); else selected.delete(node.id);
        renderReport();
      });
      row.append(checkbox);
    }
    row.append(element("i", undefined, `dot ${node.type}`));
    const button = linkNode(node.id);
    button.append(element("small", `${names[node.type]}${node.subtype ? " / " + node.subtype : ""}${node.missing ? " / NO ENCONTRADO" : ""}`));
    row.append(button); $("objects").append(row);
  }
  if (!rows.length) $("objects").append(element("div", "No hay coincidencias.", "empty"));
}
function svg(tag, attrs = {}, text) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  if (text !== undefined) el.textContent = text;
  return el;
}
function renderGraph() {
  const canvas = $("graph"); canvas.replaceChildren();
  $("relations").replaceChildren();
  if (!focused) { $("focus-title").textContent = "Inventario vacio"; $("graph-info").textContent = "No hay objetos para explorar."; return; }
  const focusNode = graph.nodes.get(focused);
  $("focus-title").textContent = `${names[focusNode.type]} / ${label(focusNode)}`;
  const direction = $("direction").value;
  const maxDepth = $("depth").value === "all" ? Infinity : Number($("depth").value);
  const visible = new Set([focused]);
  const branches = direction === "both" ? ["incoming", "outgoing"] : [direction];
  for (const branch of branches) {
    for (const [id, path] of AdfGraph.traverse(graph, focused, branch)) if (path.length - 1 <= maxDepth) visible.add(id);
  }
  const total = visible.size, cap = 180;
  const ids = [...visible].slice(0, cap), shown = new Set(ids);
  $("graph-info").textContent = `${Math.min(total, cap)} de ${total} nodos del contexto. ${total > cap ? "Vista limitada a 180 nodos; enfoca otro objeto para explorar. El reporte usa todo el inventario." : "Clic en un nodo para enfocarlo. Desplaza el mapa para ver todas las columnas."}`;
  const kinds = ["trigger", "pipeline", "activity", "dataflow", "dataset", "linkedService", "integrationRuntime"];
  const columns = kinds.map(kind => ids.filter(id => graph.nodes.get(id).type === kind)).filter(col => col.length);
  const positions = new Map(), width = Math.max(620, columns.length * 262 + 40);
  const height = Math.max(280, Math.max(...columns.map(col => col.length)) * 102 + 65);
  canvas.setAttribute("viewBox", `0 0 ${width} ${height}`);
  canvas.setAttribute("width", String(width * zoom)); canvas.setAttribute("height", String(height * zoom));
  canvas.append(svg("title", {}, `Relaciones de ${focusNode.name}`));
  const defs = svg("defs"), marker = svg("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6, markerHeight: 6, orient: "auto-start-reverse" });
  marker.append(svg("path", { d: "M 0 0 L 10 5 L 0 10 z", fill: "#7196b6" })); defs.append(marker); canvas.append(defs);
  columns.forEach((col, column) => col.forEach((id, row) => positions.set(id, { x: column * 262 + 22, y: row * 102 + 42 })));
  for (const edge of graph.edges) {
    if (!shown.has(edge.source) || !shown.has(edge.target)) continue;
    const a = positions.get(edge.source), b = positions.get(edge.target), forward = b.x > a.x;
    const sx = forward ? a.x + 218 : a.x, tx = forward ? b.x : b.x + 218;
    const bend = forward ? Math.max(25, (tx - sx) / 2) : -35;
    const path = svg("path", { class: "edge", d: `M ${sx} ${a.y + 28} C ${sx + bend} ${a.y + 28}, ${tx - bend} ${b.y + 28}, ${tx} ${b.y + 28}`, "marker-end": "url(#arrow)" });
    path.append(svg("title", {}, `${label(graph.nodes.get(edge.source))} -> ${label(graph.nodes.get(edge.target))}\n${edge.evidence}`));
    canvas.append(path);
    if (forward && b.x - a.x === 262) canvas.append(svg("text", { class: "edge-label", x: sx + 4, y: (a.y + b.y) / 2 + 20 }, edge.kind === "contains" ? "contiene" : "usa"));
  }
  for (const id of ids) {
    const node = graph.nodes.get(id), pos = positions.get(id);
    const group = svg("g", { class: `node${id === focused ? " selected" : ""}`, transform: `translate(${pos.x},${pos.y})`, tabindex: 0, role: "button", "aria-label": `Explorar ${node.name}` });
    group.append(svg("title", {}, `${node.name}\n${names[node.type]} / ${node.subtype || ""}${node.missing ? "\nObjeto no encontrado" : ""}`));
    group.append(svg("rect", { width: 218, height: 62, rx: 9, stroke: colors[node.type], ...(node.missing ? { "stroke-dasharray": "4 3" } : {}) }));
    const text = label(node);
    group.append(svg("text", { x: 12, y: 24 }, text.length > 27 ? text.slice(0, 25) + "..." : text));
    group.append(svg("text", { x: 12, y: 44, class: "subtype" }, `${names[node.type]}${node.missing ? " / FALTA" : ""}`));
    group.addEventListener("click", () => focus(id));
    group.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); focus(id); } });
    canvas.append(group);
  }
  for (const [title, index, branch] of [["Lo usan (directo)", graph.incoming, "incoming"], ["Usa (directo)", graph.outgoing, "outgoing"]]) {
    const section = element("div"); section.append(element("h3", title));
    const edges = index.get(focused);
    for (const edge of edges) {
      const id = branch === "incoming" ? edge.source : edge.target;
      const node = graph.nodes.get(id);
      const button = linkNode(id, `${label(node)}${node.owner ? " [" + graph.nodes.get(node.owner).name + "]" : ""}`);
      button.className = "relation";
      button.append(element("small", `${edge.kind === "contains" ? "contiene" : "referencia"} / ${edge.evidence}`)); section.append(button);
    }
    if (!edges.length) section.append(element("p", "Sin relaciones directas conocidas."));
    $("relations").append(section);
  }
}
function renderReport() {
  $("selection").replaceChildren(); $("report").replaceChildren();
  $("export").disabled = !selected.size;
  if (!selected.size) { report = null; $("report").append(element("p", "Selecciona uno o varios pipelines para ver consumidores, impacto y advertencias.")); return; }
  const chips = element("div", undefined, "chips");
  for (const id of selected) {
    const chip = element("button", `${graph.nodes.get(id).name} x`, "chip");
    chip.setAttribute("aria-label", `Quitar ${graph.nodes.get(id).name} de la seleccion`);
    chip.addEventListener("click", () => { selected.delete(id); renderObjects(); renderReport(); }); chips.append(chip);
  }
  $("selection").append(chips);
  report = AdfGraph.evaluateDeletion(graph, selected);
  for (const result of report.results) {
    const card = element("article", undefined, `result ${result.status}`);
    const status = { blocked: "BLOQUEADO POR REFERENCIAS EXTERNAS", review: "REQUIERE REVISION", "no-static-blockers": "SIN BLOQUEOS ESTATICOS DETECTADOS" };
    card.append(element("div", status[result.status], "status"), element("h3", result.name));
    if (result.callers.length) {
      const list = element("ul");
      for (const caller of result.callers) {
        const item = element("li");
        item.append(linkNode(caller.callerId, caller.name), document.createTextNode(
          `${caller.activity ? " / actividad " + caller.activity : ""} - ${caller.internal ? "dentro de la seleccion" : "FUERA de la seleccion"} (${caller.evidence})`));
        list.append(item);
      }
      card.append(list);
    } else card.append(element("p", "No se encontraron consumidores directos en las definiciones importadas."));
    if (result.affected.length) {
      const detail = element("details"); detail.append(element("summary", `${result.affected.length} consumidores externos directos o indirectos`));
      const list = element("ul");
      for (const affected of result.affected) list.append(element("li", affected.path.map(id => label(graph.nodes.get(id))).join(" -> ")));
      detail.append(list); card.append(detail);
    }
    if (graph.issues.length) card.append(element("p", `Hay ${graph.issues.length} advertencias globales: no se puede acreditar ausencia de dependencias. Revisa el detalle del inventario.`));
    $("report").append(card);
  }
  if (report.cycle) $("report").append(element("p", "Ciclo entre pipelines seleccionados: no existe un orden simple de borrado. Retira o modifica las referencias circulares y vuelve a extraer el inventario.", "order"));
  else if (report.blocked) $("report").append(element("p", "No continuar con el borrado: primero retirar o modificar las referencias externas identificadas y volver a extraer el inventario.", "order"));
  else $("report").append(element("p", `Orden estructural candidato (no es autorizacion de borrado): ${report.order.map(id => graph.nodes.get(id).name).join(" -> ")}. Validar tambien llamadas externas, cambios recientes y ejecuciones activas.`, "order"));
}
$("search").addEventListener("input", renderObjects);
$("type").addEventListener("change", renderObjects);
$("direction").addEventListener("change", renderGraph);
$("depth").addEventListener("change", renderGraph);
$("zoom-in").addEventListener("click", () => { zoom = Math.min(2, zoom + .2); renderGraph(); });
$("zoom-out").addEventListener("click", () => { zoom = Math.max(.4, zoom - .2); renderGraph(); });
$("reset-zoom").addEventListener("click", () => { zoom = 1; renderGraph(); });
$("clear").addEventListener("click", () => { selected.clear(); error(""); renderObjects(); renderReport(); });
$("demo").addEventListener("click", () => load(AdfDemo));
$("add-batch").addEventListener("click", () => {
  const inputs = $("batch").value.split(/[\r\n,;]+/).map(name => name.trim()).filter(Boolean);
  if (!inputs.length) { error("Ingresa al menos un nombre de pipeline."); return; }
  const ids = inputs.map(name => AdfGraph.idFor("pipeline", name));
  const missing = inputs.filter((name, i) => !graph.nodes.has(ids[i]) || graph.nodes.get(ids[i]).missing);
  if (missing.length) { error(`No se agrego ningun pipeline. Nombres no encontrados: ${missing.join(", ")}`); return; }
  ids.forEach(id => selected.add(id)); error(""); renderObjects(); renderReport();
});
$("import").addEventListener("change", async event => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    if (file.size > 30 * 1024 * 1024) throw new Error("El JSON supera el limite de importacion de 30 MB.");
    load(JSON.parse((await file.text()).replace(/^\uFEFF/, "")));
  } catch (failure) { error(`No se pudo importar; se conserva el inventario anterior. ${failure.message}`); }
  finally { event.target.value = ""; }
});
$("export").addEventListener("click", () => {
  if (!report) return;
  const data = { ...report, inventory: graph.metadata, nodeNames: Object.fromEntries([...graph.nodes].map(([id, n]) => [id, n.name])) };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const anchor = element("a"); anchor.href = url; anchor.download = "adf-reporte-impacto.json";
  document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
try {
  const saved = AdfSession.read();
  if (saved) displayGraph(saved); else load(AdfDemo);
  const query = new URLSearchParams(location.search);
  const objectName = query.get("objectName") || query.get("pipeline");
  const objectType = query.get("objectName") ? query.get("objectType") : "pipeline";
  if (objectName) {
    if (!["pipeline", "dataset", "dataflow"].includes(objectType)) error("El tipo de objeto solicitado no es valido.");
    else {
      const id = AdfGraph.idFor(objectType, objectName);
      if (!graph.nodes.has(id) || graph.nodes.get(id).missing) error("El objeto solicitado no existe en el inventario cargado.");
      else {
        focus(id);
        if (objectType === "pipeline") selected.add(id);
        renderObjects(); renderReport();
      }
    }
  }
} catch (failure) {
  load(AdfDemo);
  error(`No se pudo restaurar el inventario de la pestana. Se muestra la DEMO. ${failure.message}`);
}

let azureToken, azureBusy = false;
const localServer = location.protocol === "http:" && location.hostname === "127.0.0.1";
function azureControls() {
  $("azure-connect").disabled = !localServer || azureBusy;
  $("azure-subscription").disabled = azureBusy || $("azure-subscription").options.length < 2;
  $("azure-factory").disabled = azureBusy || $("azure-factory").options.length < 2;
  $("azure-analyze").disabled = azureBusy || !$("azure-factory").value;
}
async function azureRequest(route) {
  const headers = { "X-Adf-Client": "portal" };
  if (azureToken) headers["X-Adf-Token"] = azureToken;
  const response = await fetch(route, { headers, cache: "no-store" });
  const data = await response.json();
  if (!response.ok) {
    if (response.status === 403) azureToken = undefined;
    throw new Error(data.error || `Error HTTP ${response.status}`);
  }
  return data;
}
async function azureAction(message, action) {
  if (azureBusy) return;
  azureBusy = true; azureControls(); error("");
  $("azure-status").textContent = message;
  try { await action(); }
  catch (failure) {
    $("azure-status").textContent = "La consulta no se completo. El grafo anterior se conserva.";
    error(`Azure: ${failure.message}`);
  } finally { azureBusy = false; azureControls(); }
}
function resetAzureSelect(id, placeholder) {
  const option = element("option", placeholder); option.value = "";
  $(id).replaceChildren(option);
}
$("azure-connect").addEventListener("click", () => azureAction("Consultando suscripciones de tu sesion de Azure CLI...", async () => {
  resetAzureSelect("azure-subscription", "Selecciona una suscripcion");
  resetAzureSelect("azure-factory", "Selecciona un ADF");
  azureToken = (await azureRequest("/api/session")).token;
  const data = await azureRequest("/api/subscriptions");
  for (const sub of data.subscriptions) {
    const option = element("option", `${sub.name} / ${sub.id}`); option.value = sub.id;
    $("azure-subscription").append(option);
  }
  $("azure-status").textContent = `${data.subscriptions.length} suscripciones disponibles. Selecciona la suscripcion donde esta tu ADF.`;
}));
$("azure-subscription").addEventListener("change", () => {
  resetAzureSelect("azure-factory", "Selecciona un ADF"); azureControls();
  const id = $("azure-subscription").value;
  if (!id) return;
  azureAction("Buscando Azure Data Factories en la suscripcion seleccionada...", async () => {
    const data = await azureRequest(`/api/factories?subscriptionId=${encodeURIComponent(id)}`);
    for (const factory of data.factories) {
      const group = factory.id.split("/")[4];
      const option = element("option", `${factory.name} / ${group} / ${factory.location || ""}`);
      option.value = factory.id; $("azure-factory").append(option);
    }
    $("azure-status").textContent = data.factories.length ?
      `${data.factories.length} ADF disponibles. Selecciona uno y pulsa Analizar ADF.` :
      "No se encontraron ADF visibles en esta suscripcion. Revisa la suscripcion, el tenant y los permisos.";
  });
});
$("azure-factory").addEventListener("change", azureControls);
$("azure-analyze").addEventListener("click", () => {
  const id = $("azure-factory").value;
  if (!id) return;
  const chosen = $("azure-factory").selectedOptions[0].textContent;
  azureAction(`Leyendo pipelines, datasets, servicios, runtimes, triggers y data flows de ${chosen}. Puede tardar varios minutos...`, async () => {
    const snapshot = await azureRequest(`/api/inventory?factoryId=${encodeURIComponent(id)}`);
    load(snapshot);
    $("azure-status").textContent = `Datos reales cargados: ${snapshot.metadata.factoryName}. Extraido: ${snapshot.metadata.exportedAt}. Pulsa Analizar ADF para actualizar.`;
  });
});
if (localServer) $("azure-status").textContent = "Ejecuta az login en la terminal y pulsa Cargar suscripciones. No se solicitan ni guardan credenciales en el portal.";
azureControls();
