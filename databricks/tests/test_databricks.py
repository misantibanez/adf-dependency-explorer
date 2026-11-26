import io
import json
import sys
import unittest
from datetime import datetime, timedelta, timezone
from functools import partial
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "databricks"))
sys.path.insert(0, str(ROOT / "databricks" / "app"))

from adf_api import collection, factory_base
from export_adf_inventory import inventory
from pipeline_history import history
from analysis import analyze
from azure_rest import AzureRest, NoRedirect
from delta_store import publish
from prepare_app import prepare
from repository import SnapshotRepository, from_environment
from app import create_app

GUID = "11111111-1111-1111-1111-111111111111"
PARAMS = (GUID, "test-rg", "factory-test")


def fixture():
    snapshot = json.loads((ROOT / "tests" / "fixtures" / "valid-inventory.json").read_text(encoding="utf-8"))
    snapshot["metadata"].update(subscriptionId=GUID, resourceGroupName="test-rg",
                                exportedAt="2026-11-25T00:00:00+00:00")
    return snapshot


class TransportTests(unittest.TestCase):
    def test_oauth_audience_cache_and_sanitized_errors(self):
        client = AzureRest(GUID, GUID, "DO_NOT_EXPORT")
        responses = [
            {"access_token": "arm-token", "expires_in": 3600}, {"value": []}, {"value": []},
            {"access_token": "logs-token", "expires_in": 3600}, {"tables": []},
        ]
        client._opener.open = Mock(side_effect=[
            io.BytesIO(json.dumps(value).encode("utf-8")) for value in responses
        ])
        url = factory_base(*PARAMS) + "/pipelines?api-version=2018-06-01"
        for _ in range(2):
            self.assertEqual(client(["rest", "--method", "get", "--url", url]), {"value": []})
        client(["rest", "--method", "post", "--url",
                f"https://api.loganalytics.azure.com/v1/workspaces/{GUID}/query"], {"query": "safe"})
        calls = client._opener.open.call_args_list
        self.assertEqual(len(calls), 5)
        self.assertIn(b"management.azure.com", calls[0].args[0].data)
        self.assertIn(b"api.loganalytics.io", calls[3].args[0].data)
        self.assertEqual(calls[1].args[0].get_header("Authorization"), "Bearer arm-token")
        self.assertEqual(calls[4].args[0].get_header("Authorization"), "Bearer logs-token")

    def test_retry_exhaustion_network_and_redirect_errors_are_explicit(self):
        for status in (403, 302, 429):
            client = AzureRest(GUID, GUID, "secret")
            client._opener.open = Mock(side_effect=[
                HTTPError("https://management.azure.com", status, "DO_NOT_EXPORT", {}, io.BytesIO(b"secret"))
                for _ in range(4)
            ])
            with patch("azure_rest.time.sleep"):
                with self.assertRaisesRegex(RuntimeError, f"HTTP {status}") as caught:
                    client._json(Mock())
            self.assertNotIn("DO_NOT_EXPORT", str(caught.exception))
            self.assertEqual(client._opener.open.call_count, 4 if status == 429 else 1)
        client._opener.open = Mock(side_effect=URLError("DO_NOT_EXPORT"))
        with self.assertRaisesRegex(RuntimeError, "conectividad"):
            client._json(Mock())
        self.assertIsNone(NoRedirect().redirect_request(None, None, 302, "", {}, "https://example.com"))

    def test_disallows_foreign_hosts_and_mutations_before_authentication(self):
        client = AzureRest(GUID, GUID, "secret")
        with patch.object(client, "_token") as token:
            for url, method in (("http://management.azure.com/x", "get"),
                                ("https://example.com/x", "get"),
                                ("https://user@management.azure.com/x", "get"),
                                ("https://management.azure.com/x", "delete"),
                                ("https://management.azure.com/x", "post")):
                with self.subTest(url=url, method=method), self.assertRaises(ValueError):
                    client(["rest", "--method", method, "--url", url])
            token.assert_not_called()

    def test_shared_inventory_and_log_history_accept_rest_without_cli(self):
        def rest(args, body=None):
            url = args[args.index("--url") + 1]
            if "api.loganalytics" in url:
                return {"tables": [{"columns": [{"name": field} for field in
                    ("pipelineName", "runId", "runStart", "status", "lastUpdated")], "rows": []}]}
            return {"value": []}

        with patch("adf_api.azure_json", side_effect=AssertionError("Must not call Azure CLI")), \
                patch("pipeline_history.azure_json", side_effect=AssertionError("Must not call Azure CLI")):
            snapshot = inventory(*PARAMS, read_collection=partial(collection, request=rest))
            result = history(*PARAMS, "loganalytics", GUID,
                             (datetime.now(timezone.utc) - timedelta(days=365)).isoformat(), request=rest)
        self.assertTrue(all(not values for values in snapshot["collections"].values()))
        self.assertEqual(result["runs"], [])
        self.assertFalse(result["complete"])


class AnalysisTests(unittest.TestCase):
    def test_reuses_exact_graph_metrics_and_redacts_history(self):
        result = analyze(fixture())
        self.assertTrue(result["nodes"])
        self.assertTrue(result["relationships"])
        self.assertEqual({row["objectType"] for row in result["metrics"]}, {"pipeline", "dataset", "dataflow"})
        self.assertIsNone(result["history"])
        import subprocess
        code = """
const fs = require('node:fs'), g = require('./graph.js');
const graph = g.buildGraph(JSON.parse(fs.readFileSync(0, 'utf8')));
console.log(JSON.stringify({nodes:[...graph.nodes.values()], relationships:graph.edges, issues:graph.issues,
  metrics:['pipeline','dataset','dataflow'].flatMap(type => g.objectMetrics(graph,type).rows.map(row => ({objectType:type,...row}))),
  history:null}));
"""
        output = subprocess.run(["node", "-e", code], input=json.dumps(fixture()), capture_output=True,
                                encoding="utf-8", cwd=ROOT, timeout=30, check=True)
        self.assertEqual(result, json.loads(output.stdout))

    def test_rejects_history_from_different_factory_and_summarizes_runs(self):
        snapshot = fixture()
        meta = snapshot["metadata"]
        factory = f'/subscriptions/{meta["subscriptionId"]}/resourceGroups/{meta["resourceGroupName"]}/providers/Microsoft.DataFactory/factories/{meta["factoryName"]}'
        now = datetime.now(timezone.utc)
        raw = {"factoryId": factory, "source": "api", "from": (now - timedelta(days=45)).isoformat(),
               "to": now.isoformat(), "complete": True, "runs": [{
                   "pipelineName": "A", "runId": "id", "status": "Succeeded",
                   "runStart": (now - timedelta(days=2)).isoformat(), "parameters": "DO_NOT_EXPORT",
               }]}
        result = analyze(snapshot, raw)
        self.assertNotIn("DO_NOT_EXPORT", json.dumps(result))
        self.assertEqual(result["history"]["pipelines"][0]["pipelineName"], "A")
        raw["factoryId"] += "-other"
        with self.assertRaises(Exception) as caught:
            analyze(snapshot, raw)
        self.assertIn("otro ADF", str(caught.exception))


class FakeSpark:
    def __init__(self, fail_on=None):
        self.fail_on = fail_on
        self.writes = []

    def createDataFrame(self, rows, schema):
        width = len(schema.split(","))
        if any(len(row) != width for row in rows):
            raise AssertionError("Unexpected row width")
        writer = Mock()
        writer.format.return_value = writer
        writer.mode.return_value = writer

        def save(table):
            if self.fail_on and table.endswith(f"`adf_{self.fail_on}`"):
                raise RuntimeError("write denied")
            self.writes.append((table, rows, schema))

        writer.saveAsTable.side_effect = save
        return SimpleNamespace(write=writer)


class PublicationTests(unittest.TestCase):
    def test_complete_snapshot_is_last_and_empty_tables_have_explicit_schemas(self):
        spark = FakeSpark()
        snapshot = fixture()
        snapshot_id = publish(spark, "main", "adf", snapshot, analyze(snapshot))
        self.assertEqual(len(spark.writes), 7)
        self.assertTrue(spark.writes[-1][0].endswith("`adf_snapshots`"))
        for table, rows, schema in spark.writes:
            self.assertTrue(table.startswith("`main`.`adf`."))
            self.assertTrue(all(row[0] == snapshot_id for row in rows))
        self.assertEqual(json.loads(spark.writes[-1][1][0][4]), snapshot)

    def test_failure_does_not_publish_manifest_or_overwrite_previous_snapshots(self):
        spark = FakeSpark(fail_on="metrics")
        snapshot = fixture()
        with self.assertRaisesRegex(RuntimeError, "write denied"):
            publish(spark, "main", "adf", snapshot, analyze(snapshot))
        self.assertFalse(any(table.endswith("`adf_snapshots`") for table, _, _ in spark.writes))
        with self.assertRaises(ValueError):
            publish(spark, "main;DROP", "adf", snapshot, {})
        with patch("delta_store.MAX_INVENTORY_BYTES", 1):
            with self.assertRaisesRegex(ValueError, "30 MB"):
                publish(spark, "main", "adf", snapshot, {})


class AppTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        prepare()

    def test_html_assets_snapshot_api_and_errors_without_secrets(self):
        repository = Mock()
        repository.list_snapshots.return_value = [{"snapshot_id": GUID}]
        repository.get_snapshot.return_value = {"inventory": fixture(), "history": None}
        client = create_app(repository).test_client()
        with client.get("/") as response:
            self.assertEqual(response.status_code, 200)
        with client.get("/assets/graph.js") as response:
            self.assertEqual(response.status_code, 200)
        self.assertEqual(client.get("/assets/repository.py").status_code, 404)
        self.assertEqual(client.get("/api/snapshots").json["snapshots"][0]["snapshot_id"], GUID)
        response = client.get(f"/api/snapshots/{GUID}")
        self.assertEqual(response.json["inventory"], repository.get_snapshot.return_value["inventory"])
        self.assertIn("script-src 'self'", response.headers["Content-Security-Policy"])
        self.assertEqual(client.get("/api/snapshots/not-an-id").status_code, 400)
        repository.get_snapshot.return_value = None
        self.assertEqual(client.get(f"/api/snapshots/{GUID}").status_code, 404)
        repository.list_snapshots.side_effect = RuntimeError("DO_NOT_EXPORT")
        with self.assertLogs("app", level="ERROR") as logs:
            response = client.get("/api/snapshots")
        self.assertEqual(response.status_code, 503)
        self.assertNotIn("DO_NOT_EXPORT", response.text + str(logs.output))
        self.assertEqual(client.post("/api/snapshots").status_code, 405)

    def test_sql_values_are_bound_identifiers_validated_and_connections_closed(self):
        connection = Mock()
        cursor = connection.cursor.return_value
        cursor.description = [("inventory_json",), ("history_json",)]
        cursor.fetchall.return_value = [(json.dumps(fixture()), None)]
        repository = SnapshotRepository("main", "adf", lambda: connection)
        self.assertEqual(repository.get_snapshot(GUID)["inventory"], fixture())
        statement, parameters = cursor.execute.call_args.args
        self.assertIn("snapshot_id = ?", statement)
        self.assertNotIn(GUID, statement)
        self.assertEqual(parameters, [GUID])
        connection.close.assert_called_once()
        cursor.close.assert_called_once()
        with self.assertRaises(ValueError):
            SnapshotRepository("main", "adf`;DROP", Mock())
        cursor.fetchall.return_value *= 2
        with self.assertRaisesRegex(ValueError, "duplicado"):
            repository.get_snapshot(GUID)

    def test_latest_list_does_not_silently_truncate_factories(self):
        repository = SnapshotRepository("main", "adf", Mock())
        with patch.object(repository, "_query", return_value=[{}] * 1001):
            with self.assertRaisesRegex(ValueError, "1000"):
                repository.list_snapshots()

    def test_environment_uses_app_oauth_and_host_without_scheme(self):
        environment = {"ADF_CATALOG": "main", "ADF_SCHEMA": "adf", "DATABRICKS_WAREHOUSE_ID": "abc123"}
        with patch.dict("os.environ", environment), patch("databricks.sdk.core.Config") as config, \
                patch("databricks.sql.connect") as connect:
            config.return_value.host = "https://workspace.azuredatabricks.net"
            repository = from_environment()
            repository.connect()
            self.assertEqual(connect.call_args.kwargs["server_hostname"], "workspace.azuredatabricks.net")
            self.assertEqual(connect.call_args.kwargs["credentials_provider"](), config.return_value.authenticate)
            self.assertNotIn("access_token", connect.call_args.kwargs)


if __name__ == "__main__":
    unittest.main()
