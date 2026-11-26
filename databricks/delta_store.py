"""Append immutable snapshots; publish their manifest only after every table succeeds."""

import json
import re
from datetime import datetime, timezone
from uuid import uuid4

from adf_api import factory_id

SCHEMAS = {
    "objects": "snapshot_id string, factory_id string, object_type string, object_name string, properties_json string",
    "nodes": "snapshot_id string, factory_id string, node_id string, object_type string, object_name string, node_json string",
    "relationships": "snapshot_id string, factory_id string, source_id string, target_id string, kind string, evidence string",
    "metrics": ("snapshot_id string, factory_id string, object_type string, node_id string, object_name string, "
                "consumers int, reference_count int, dependencies int, status string"),
    "issues": "snapshot_id string, factory_id string, source_id string, message string",
    "runs": ("snapshot_id string, factory_id string, pipeline_name string, run_id string, run_start string, "
             "status string, last_updated string"),
    "snapshots": ("snapshot_id string, factory_id string, factory_name string, collected_at string, "
                  "inventory_json string, history_json string"),
}
MAX_INVENTORY_BYTES = 30 * 1024 * 1024


def namespace(catalog: str, schema: str) -> str:
    if not all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", part) for part in (catalog, schema)):
        raise ValueError("Catalogo y esquema requieren identificadores simples: letras, numeros y guion bajo.")
    return f"`{catalog}`.`{schema}`"


def publish(spark, catalog: str, schema: str, snapshot: dict, analysis: dict,
            raw_history: dict | None = None) -> str:
    target = namespace(catalog, schema)
    serialized = json.dumps(snapshot, ensure_ascii=True)
    if len(serialized.encode("utf-8")) > MAX_INVENTORY_BYTES:
        raise ValueError("Inventario supera 30 MB; no se publica una version parcial.")
    meta = snapshot["metadata"]
    fid = factory_id(meta["subscriptionId"], meta["resourceGroupName"], meta["factoryName"])
    snapshot_id = str(uuid4())
    prefix = (snapshot_id, fid)
    rows = {
        "objects": [(*prefix, kind, row["name"], json.dumps(row["properties"], ensure_ascii=True))
                    for kind, values in snapshot["collections"].items() for row in values],
        "nodes": [(*prefix, row["id"], row["type"], row["name"], json.dumps(row, ensure_ascii=True))
                  for row in analysis["nodes"]],
        "relationships": [(*prefix, row["source"], row["target"], row["kind"], row["evidence"])
                          for row in analysis["relationships"]],
        "metrics": [(*prefix, row["objectType"], row["id"], row["name"], row["consumers"],
                     row["references"], row["dependencies"], row["status"]) for row in analysis["metrics"]],
        "issues": [(*prefix, row["source"], row["message"]) for row in analysis["issues"]],
        "runs": [(*prefix, row["pipelineName"], row["runId"], row.get("runStart"), row["status"],
                  row.get("lastUpdated")) for row in (raw_history or {}).get("runs", [])],
        "snapshots": [(*prefix, meta["factoryName"], datetime.now(timezone.utc).isoformat(),
                       serialized, json.dumps(analysis["history"]) if analysis["history"] is not None else None)],
    }
    for suffix, definition in SCHEMAS.items():
        frame = spark.createDataFrame(rows[suffix], schema=definition)
        frame.write.format("delta").mode("append").saveAsTable(f"{target}.`adf_{suffix}`")
    return snapshot_id
