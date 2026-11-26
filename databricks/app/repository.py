"""Read published snapshots with the Databricks App service principal."""

import json
import re
from contextlib import closing
from urllib.parse import urlsplit
from uuid import UUID


class SnapshotRepository:
    def __init__(self, catalog: str, schema: str, connect):
        if (not all(re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", part) for part in (catalog, schema))
                or "CHANGE_ME" in (catalog, schema)):
            raise ValueError("Configurar ADF_CATALOG y ADF_SCHEMA con identificadores simples.")
        self.table = f"`{catalog}`.`{schema}`.`adf_snapshots`"
        self.connect = connect

    def _query(self, statement: str, parameters: list | None = None) -> list:
        with closing(self.connect()) as connection, closing(connection.cursor()) as cursor:
            cursor.execute(statement, parameters or [])
            names = [column[0] for column in cursor.description]
            return [dict(zip(names, row)) for row in cursor.fetchall()]

    def list_snapshots(self) -> list:
        rows = self._query(f"""
            SELECT snapshot_id, factory_id, factory_name, collected_at
            FROM (
                SELECT snapshot_id, factory_id, factory_name, collected_at,
                    row_number() OVER (PARTITION BY factory_id ORDER BY collected_at DESC, snapshot_id DESC) AS position
                FROM {self.table}
            ) WHERE position = 1 ORDER BY factory_name, factory_id LIMIT 1001
        """)
        if len(rows) > 1000:
            raise ValueError("Hay mas de 1000 factories; limitar el esquema de publicacion.")
        return rows

    def get_snapshot(self, snapshot_id: str) -> dict | None:
        snapshot_id = str(UUID(snapshot_id))
        rows = self._query(
            f"SELECT inventory_json, history_json FROM {self.table} WHERE snapshot_id = ? LIMIT 2",
            [snapshot_id],
        )
        if not rows:
            return None
        if len(rows) != 1:
            raise ValueError("Snapshot duplicado; revisar integridad de la tabla.")
        return {"inventory": json.loads(rows[0]["inventory_json"]),
                "history": json.loads(rows[0]["history_json"]) if rows[0]["history_json"] is not None else None}


def from_environment():
    import os
    from databricks import sql
    from databricks.sdk.core import Config

    catalog, schema = os.environ["ADF_CATALOG"], os.environ["ADF_SCHEMA"]
    warehouse = os.environ["DATABRICKS_WAREHOUSE_ID"]
    if not re.fullmatch(r"[a-zA-Z0-9-]+", warehouse):
        raise ValueError("DATABRICKS_WAREHOUSE_ID invalido.")
    config = Config()
    hostname = urlsplit(config.host if "://" in config.host else "https://" + config.host).hostname
    if not hostname:
        raise ValueError("DATABRICKS_HOST invalido.")

    def connect():
        return sql.connect(server_hostname=hostname, http_path=f"/sql/1.0/warehouses/{warehouse}",
                           credentials_provider=lambda: config.authenticate)

    return SnapshotRepository(catalog, schema, connect)
