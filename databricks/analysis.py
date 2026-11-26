"""Run the existing JavaScript engines without Node.js on the Spark driver."""

import json
from pathlib import Path


def analyze(snapshot: dict, raw_history: dict | None = None, *, root: Path | None = None) -> dict:
    import quickjs

    root = root or Path(__file__).resolve().parent.parent
    context = quickjs.Context()
    context.set_memory_limit(512 * 1024 * 1024)
    context.set_time_limit(120)
    for name in ("graph.js", "history.js"):
        context.eval((root / name).read_text(encoding="utf-8"))
    context.set("inventoryInput", json.dumps(snapshot))
    context.set("historyInput", json.dumps(raw_history))
    return json.loads(context.eval("""
        (() => {
          const graph = AdfGraph.buildGraph(JSON.parse(inventoryInput));
          const raw = JSON.parse(historyInput);
          const history = raw === null ? null : AdfHistory.fromRuns(raw.runs, {
            factoryId: raw.factoryId, source: raw.source, from: raw.from, to: raw.to, complete: raw.complete
          });
          if (history) AdfHistory.validate(history, AdfHistory.factoryId(graph));
          return JSON.stringify({
            nodes: [...graph.nodes.values()], relationships: graph.edges, issues: graph.issues,
            metrics: ["pipeline", "dataset", "dataflow"].flatMap(type =>
              AdfGraph.objectMetrics(graph, type).rows.map(row => ({objectType: type, ...row}))),
            history
          });
        })()
    """))
