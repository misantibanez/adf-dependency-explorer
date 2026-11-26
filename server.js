"use strict";
const http = require("node:http");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { execFile } = require("node:child_process");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { buildGraph } = require("./graph.js");
const { fromRuns, validate: validateHistory } = require("./history.js");

function queryCommand(operation, params = {}, backend = process.env.ADF_BACKEND || "powershell", python = process.env.PYTHON || "python") {
  if (!["powershell", "python"].includes(backend)) throw new Error("ADF_BACKEND debe ser powershell o python.");
  const isPython = backend === "python";
  const args = isPython ? [path.join(__dirname, "azure_portal_query.py"), "--operation", operation] :
    ["-NoProfile", "-NonInteractive", "-File", path.join(__dirname, "Azure-PortalQuery.ps1"), "-Operation", operation];
  const pythonFlags = { SubscriptionId: "--subscription-id", ResourceGroupName: "--resource-group-name",
    FactoryName: "--factory-name", Source: "--source", WorkspaceId: "--workspace-id",
    CoverageFrom: "--coverage-from", LogTable: "--log-table" };
  for (const [key, value] of Object.entries(params)) {
    if (!Object.hasOwn(pythonFlags, key)) throw new Error("Parametro de consulta no permitido.");
    args.push(isPython ? pythonFlags[key] : `-${key}`, value);
  }
  return { executable: isPython ? python : "pwsh", args, backend };
}
function queryAzure(operation, params = {}) {
  const { executable, args, backend } = queryCommand(operation, params);
  return new Promise((resolve, reject) => {
    execFile(executable, args, { windowsHide: true, timeout: 300000, maxBuffer: 40 * 1024 * 1024 }, (failure, stdout) => {
      let result;
      try { result = JSON.parse(stdout); }
      catch { reject(new Error(`No se pudo consultar Azure. Verifica ${backend === "python" ? "Python 3.10+ y PYTHON" : "PowerShell 7"}, Azure CLI y az login; la consulta puede haber excedido 5 minutos o 40 MB.`)); return; }
      if (failure || result.error) reject(new Error(result.error || "Fallo la consulta a Azure; no se cargo un inventario parcial."));
      else resolve(result);
    });
  });
}
const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function factoryParameters(id) {
  const match = /^\/subscriptions\/([^/]+)\/resourceGroups\/([^/]+)\/providers\/Microsoft\.DataFactory\/factories\/([a-z0-9]+(?:-[a-z0-9]+)*)$/i.exec(id);
  if (!match || !guid.test(match[1]) || match[2].length > 90 || !/^[\p{L}\p{N}_.() -]+$/u.test(match[2]) ||
      match[3].length < 3 || match[3].length > 63) throw new Error("Identificador de ADF invalido.");
  return { SubscriptionId: match[1], ResourceGroupName: match[2], FactoryName: match[3] };
}
const assets = { "/": ["index.html", "text/html"], "/index.html": ["index.html", "text/html"],
  "/styles.css": ["styles.css", "text/css"], "/app.js": ["app.js", "text/javascript"],
  "/graph.js": ["graph.js", "text/javascript"], "/demo.js": ["demo.js", "text/javascript"],
  "/metrics.html": ["metrics.html", "text/html"], "/metrics.js": ["metrics.js", "text/javascript"],
  "/history.js": ["history.js", "text/javascript"],
  "/inventory-session.js": ["inventory-session.js", "text/javascript"] };

function createServer(runQuery = queryAzure) {
  const token = randomBytes(32).toString("hex");
  let busy = false;
  return http.createServer(async (req, res) => {
    const origin = `http://127.0.0.1:${res.socket.localPort}`;
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
      res.end(JSON.stringify(data));
    };
    if (req.headers.host !== new URL(origin).host || (req.headers.origin && req.headers.origin !== origin) ||
        (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(req.headers["sec-fetch-site"]))) {
      send(403, { error: "Acceso permitido solo desde este portal local." }); return;
    }
    if (req.method !== "GET") { send(405, { error: "Solo se permiten consultas GET." }); return; }
    const url = new URL(req.url, origin);
    if (assets[url.pathname]) {
      try {
        const [file, mime] = assets[url.pathname];
        const content = await readFile(path.join(__dirname, file));
        res.writeHead(200, { "Content-Type": `${mime}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
        res.end(content);
      } catch { console.error("No se pudo leer un recurso del portal."); send(500, { error: "No se pudo leer el portal." }); }
      return;
    }
    if (!url.pathname.startsWith("/api/")) { send(404, { error: "Ruta no disponible." }); return; }
    if (req.headers["x-adf-client"] !== "portal") { send(403, { error: "Cliente no autorizado." }); return; }
    if (url.pathname === "/api/session") { send(200, { token }); return; }
    const supplied = req.headers["x-adf-token"];
    if (typeof supplied !== "string" || !/^[0-9a-f]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))) {
      send(403, { error: "Sesion del portal invalida. Recarga la pagina." }); return;
    }
    let operation, params = {};
    try {
      if (url.pathname === "/api/subscriptions") operation = "subscriptions";
      else if (url.pathname === "/api/factories") {
        const id = url.searchParams.get("subscriptionId") || "";
        if (!guid.test(id)) throw new Error("Suscripcion invalida.");
        operation = "factories"; params = { SubscriptionId: id };
      } else if (url.pathname === "/api/inventory") {
        params = factoryParameters(url.searchParams.get("factoryId") || ""); operation = "inventory";
      } else if (url.pathname === "/api/history") {
        params = factoryParameters(url.searchParams.get("factoryId") || ""); operation = "history";
        params.Source = url.searchParams.get("source") || "api";
        if (!["api", "loganalytics"].includes(params.Source)) throw new Error("Fuente de historial invalida.");
        if (params.Source === "loganalytics") {
          const workspace = url.searchParams.get("workspaceId") || "";
          const from = url.searchParams.get("from") || "";
          const table = url.searchParams.get("table") || "ADFPipelineRun";
          if (!guid.test(workspace) || !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(from) || !Number.isFinite(Date.parse(from)) ||
              Date.parse(from) >= Date.now() || Date.parse(from) < Date.now() - 3660 * 86400000 ||
              !["ADFPipelineRun", "AzureDiagnostics"].includes(table)) throw new Error("Workspace, cobertura o tabla Log Analytics invalidos.");
          params.WorkspaceId = workspace; params.CoverageFrom = new Date(from).toISOString(); params.LogTable = table;
        }
      } else { send(404, { error: "Ruta no disponible." }); return; }
    } catch (error) { send(400, { error: error.message }); return; }
    if (busy) { send(409, { error: "Hay otra consulta en curso. Espera a que termine." }); return; }
    busy = true;
    try {
      let result = await runQuery(operation, params);
      if (operation === "inventory") buildGraph(result);
      else if (operation === "history") {
        if (result.source !== params.Source) throw new Error("Fuente de historial inesperada.");
        result = fromRuns(result.runs, { factoryId: result.factoryId, source: result.source, from: result.from, to: result.to, complete: result.complete });
        validateHistory(result, url.searchParams.get("factoryId"));
      }
      else if (!Array.isArray(result[operation])) throw new Error("Azure devolvio una lista invalida.");
      send(200, result);
    } catch (error) {
      console.error(`Consulta ${operation} fallida.`);
      send(502, { error: error.message });
    } finally { busy = false; }
  });
}
if (require.main === module) {
  queryCommand("subscriptions");
  const port = Number(process.env.PORT || 8765);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("PORT debe ser un entero entre 1024 y 65535.");
  const server = createServer();
  server.on("error", error => { console.error(`No se pudo iniciar el servidor (${error.code}). Verifica si el puerto esta ocupado.`); process.exitCode = 1; });
  server.listen(port, "127.0.0.1", () => console.log(`Portal ADF: http://127.0.0.1:${port}\nUsa tu sesion de Azure CLI. Solo lectura. Ctrl+C para detener.`));
}
module.exports = { createServer, factoryParameters, queryAzure, queryCommand };
