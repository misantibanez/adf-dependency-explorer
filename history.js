(function (root) {
  "use strict";
  const activeStatuses = new Set(["queued", "inprogress", "canceling", "cancelling"]);
  const statuses = new Set([...activeStatuses, "succeeded", "failed", "cancelled", "canceled"]);
  function date(value, field) {
    const match = typeof value === "string" && /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/i.exec(value);
    if (!match || Number(match[2]) < 1 || Number(match[2]) > 12 || Number(match[3]) < 1 ||
        Number(match[3]) > new Date(Date.UTC(Number(match[1]), Number(match[2]), 0)).getUTCDate() ||
        Number(match[4]) > 23 || Number(match[5]) > 59 || Number(match[6]) > 59 || !Number.isFinite(Date.parse(value))) {
      throw new Error(`Fecha invalida en ${field}; usar ISO 8601 con zona horaria.`);
    }
    return Date.parse(value);
  }
  function factoryId(graph) {
    const m = graph.metadata;
    if (!m.subscriptionId || !m.resourceGroupName || !m.factoryName) {
      throw new Error("El inventario no identifica suscripcion/grupo/ADF. Carga un ADF real o importa el JSON generado por el extractor.");
    }
    return `/subscriptions/${m.subscriptionId}/resourceGroups/${m.resourceGroupName}/providers/Microsoft.DataFactory/factories/${m.factoryName}`;
  }
  function validate(history, expectedId) {
    if (!history || history.version !== 1 || typeof history.factoryId !== "string" ||
        history.factoryId.toLowerCase() !== expectedId.toLowerCase() ||
        !["api", "csv", "loganalytics"].includes(history.source) || typeof history.complete !== "boolean" ||
        !Array.isArray(history.pipelines)) throw new Error("Historial invalido o perteneciente a otro ADF.");
    const from = date(history.from, "cobertura desde"), to = date(history.to, "cobertura hasta");
    if (from >= to || to > Date.now() + 60000) throw new Error("Intervalo de cobertura invalido o futuro.");
    const seen = new Set();
    for (const row of history.pipelines) {
      if (typeof row.pipelineName !== "string" || !row.pipelineName.trim() || typeof row.active !== "boolean" ||
          typeof row.lastStatus !== "string" || !statuses.has(row.lastStatus.toLowerCase())) throw new Error("Resumen de pipeline invalido.");
      const key = row.pipelineName.toLowerCase();
      if (seen.has(key)) throw new Error("Pipeline duplicado en el resumen de ejecuciones.");
      seen.add(key);
      if (row.lastRunStart !== null && date(row.lastRunStart, "ultima ejecucion") > to) throw new Error("Ejecucion posterior a la cobertura.");
    }
    return history;
  }
  function fromRuns(runs, metadata) {
    if (!Array.isArray(runs)) throw new Error("El historial requiere una lista completa de ejecuciones.");
    const byRun = new Map();
    const to = date(metadata.to, "cobertura hasta");
    for (const row of runs) {
      if (typeof row.pipelineName !== "string" || !row.pipelineName.trim() || typeof row.runId !== "string" || !row.runId.trim() ||
          typeof row.status !== "string" || !statuses.has(row.status.toLowerCase())) throw new Error("Ejecucion invalida: requiere pipelineName, runId y status reconocido.");
      const start = row.runStart ? date(row.runStart, "runStart") : null;
      if (start === null && !activeStatuses.has(row.status.toLowerCase())) throw new Error("Una ejecucion terminada requiere runStart.");
      if (start !== null && start > to) throw new Error("runStart posterior al intervalo.");
      const updated = row.lastUpdated ? date(row.lastUpdated, "lastUpdated") : start;
      if (updated === null || updated > to) throw new Error("lastUpdated invalido o posterior al intervalo.");
      const key = JSON.stringify([row.pipelineName.toLowerCase(), row.runId]);
      const previous = byRun.get(key);
      if (previous && previous.updated === updated && previous.row.status.toLowerCase() !== row.status.toLowerCase()) {
        throw new Error("Estados contradictorios para la misma ejecucion y fecha.");
      }
      if (!previous || updated > previous.updated) byRun.set(key, { row, start, updated });
    }
    const pipelines = new Map();
    for (const { row, start, updated } of byRun.values()) {
      const key = row.pipelineName.toLowerCase();
      const active = activeStatuses.has(row.status.toLowerCase());
      const old = pipelines.get(key);
      if (!old) pipelines.set(key, { pipelineName: row.pipelineName, lastRunStart: start === null ? null : new Date(start).toISOString(),
        lastStatus: row.status, active, sortTime: start ?? updated });
      else {
        old.active ||= active;
        if (start !== null && (old.lastRunStart === null || start > Date.parse(old.lastRunStart)) ||
            start === null && old.lastRunStart === null && updated > old.sortTime) {
          old.lastRunStart = start === null ? null : new Date(start).toISOString();
          old.lastStatus = row.status; old.sortTime = start ?? updated;
        }
      }
    }
    const result = { version: 1, ...metadata, pipelines: [...pipelines.values()].map(({ sortTime, ...row }) => row) };
    return validate(result, metadata.factoryId);
  }
  function parseCsv(text, metadata) {
    const input = text.replace(/^\uFEFF/, "");
    const first = input.split(/\r?\n/, 1)[0];
    const delimiter = first.includes(";") && !first.includes(",") ? ";" : ",";
    const rows = [], fields = [];
    let field = "", quoted = false, closed = false;
    function pushField() { fields.push(field); field = ""; closed = false; }
    function pushRow() { pushField(); if (fields.some(value => value.trim())) rows.push(fields.splice(0)); else fields.length = 0; }
    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      if (quoted) {
        if (char === '"' && input[i + 1] === '"') { field += '"'; i++; }
        else if (char === '"') { quoted = false; closed = true; }
        else field += char;
      } else if (char === '"' && field === "" && !closed) quoted = true;
      else if (char === delimiter) pushField();
      else if (char === "\n" || char === "\r") { if (char === "\r" && input[i + 1] === "\n") i++; pushRow(); }
      else {
        if (closed || char === '"') throw new Error("CSV mal formado: comillas o caracteres inesperados.");
        field += char;
      }
    }
    if (quoted) throw new Error("CSV con comillas sin cerrar.");
    if (field || fields.length || closed) pushRow();
    if (!rows.length) throw new Error("El CSV requiere encabezados.");
    const header = rows.shift().map(value => value.trim());
    if (new Set(header).size !== header.length || ["pipelineName", "runId", "runStart", "status"].some(key => !header.includes(key))) {
      throw new Error("CSV: requiere columnas pipelineName, runId, runStart, status; lastUpdated es opcional.");
    }
    const runs = rows.map((values, index) => {
      if (values.length !== header.length) throw new Error(`CSV: numero de columnas invalido en fila ${index + 2}.`);
      const row = Object.fromEntries(header.map((name, i) => [name, values[i].trim()]));
      return { pipelineName: row.pipelineName, runId: row.runId, runStart: row.runStart, status: row.status, lastUpdated: row.lastUpdated };
    });
    return fromRuns(runs, { ...metadata, source: "csv" });
  }
  function cutoff(months, now) {
    if (!Number.isInteger(months) || months < 1 || months > 120) throw new Error("El umbral debe ser de 1 a 120 meses enteros.");
    const value = new Date(now);
    if (!Number.isFinite(value.getTime())) throw new Error("Fecha de evaluacion invalida.");
    const day = value.getUTCDate();
    value.setUTCDate(1); value.setUTCMonth(value.getUTCMonth() - months);
    const lastDay = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
    value.setUTCDate(Math.min(day, lastDay));
    return value.toISOString();
  }
  function evaluate(graph, metrics, history, months, now = new Date()) {
    const boundary = cutoff(months, now), boundaryTime = Date.parse(boundary);
    if (history) validate(history, factoryId(graph));
    const map = new Map((history?.pipelines || []).map(row => [row.pipelineName.toLowerCase(), row]));
    const sufficient = history?.complete === true && Date.parse(history.from) <= boundaryTime &&
      Date.parse(history.to) >= boundaryTime && new Date(now).getTime() - Date.parse(history.to) <= 86400000;
    const rows = metrics.rows.map(row => {
      const run = map.get(row.name.toLowerCase());
      const recent = run?.lastRunStart && Date.parse(run.lastRunStart) >= boundaryTime;
      const executionState = run?.active ? "active" : recent ? "recent" :
        !history ? "unknown" : !sufficient ? "insufficient" : "inactive";
      return { ...row, lastRunStart: run?.lastRunStart || null, lastStatus: run?.lastStatus || null,
        executionState, inactivityCandidate: row.status === "candidate" && executionState === "inactive" };
    });
    return { cutoff: boundary, sufficient: Boolean(sufficient), rows,
      candidates: rows.filter(row => row.inactivityCandidate).length };
  }
  const api = { factoryId, validate, fromRuns, parseCsv, cutoff, evaluate };
  if (typeof module !== "undefined" && module.exports) module.exports = api; else root.AdfHistory = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
