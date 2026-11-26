import contextlib
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

import adf_api
import azure_portal_query
import export_adf_inventory as export
import pipeline_history

SUBSCRIPTION = "11111111-1111-1111-1111-111111111111"
WORKSPACE = "22222222-2222-2222-2222-222222222222"
PARAMS = (SUBSCRIPTION, "rg-test", "adf-test")
BASE = adf_api.factory_base(*PARAMS)
RESOURCE = f"/subscriptions/{SUBSCRIPTION}/resourceGroups/rg-test/providers/Microsoft.Storage/storageAccounts/lake"
RUN = {"pipelineName": "A", "runId": "run1", "runStart": "2026-11-01T00:00:00Z",
       "status": "Failed", "lastUpdated": "2026-11-01T00:01:00Z", "parameters": {"password": "DO_NOT_EXPORT"}}


class TransportTests(unittest.TestCase):
    def test_collection_follows_pages_and_rejects_escape_loops_and_invalid_pages(self):
        url = f"{BASE}/pipelines?api-version=2018-06-01"
        with patch("adf_api.azure_json", side_effect=[
            {"value": [{"name": "A"}], "nextLink": url + "&page=2"}, {"value": [{"name": "B"}]}
        ]) as cli:
            self.assertEqual(adf_api.collection(url, BASE), [{"name": "A"}, {"name": "B"}])
            self.assertTrue(all(call.args[0][2] == "get" for call in cli.call_args_list))
        for next_url in ("https://example.invalid/leak", url, BASE + "-other/pipelines",
                         BASE + "/../other/pipelines", BASE + "/%2e%2e/other/pipelines",
                         BASE.replace("https://", "https://user@") + "/pipelines",
                         BASE.replace("azure.com", "azure.com:444") + "/pipelines"):
            with self.subTest(next_url=next_url), patch("adf_api.azure_json", return_value={
                "value": [], "nextLink": next_url
            }) as cli:
                with self.assertRaises(ValueError):
                    adf_api.collection(url, BASE)
                self.assertEqual(cli.call_count, 1)
        with patch("adf_api.azure_json", return_value={"value": None}):
            with self.assertRaises(ValueError):
                adf_api.collection(url, BASE)

    def test_transport_uses_body_file_and_cleans_it_on_every_outcome(self):
        for mode in ("success", "denied", "invalid", "timeout"):
            paths = []

            def execute(args, **kwargs):
                body = Path(args[args.index("--body") + 1][1:])
                paths.append(body)
                self.assertEqual(json.loads(body.read_text(encoding="utf-8")), {"query": "safe"})
                self.assertEqual(kwargs["encoding"], "utf-8")
                if mode == "timeout":
                    raise subprocess.TimeoutExpired(args, 290)
                return subprocess.CompletedProcess(args, 1 if mode == "denied" else 0,
                                                   "{}" if mode != "invalid" else "not JSON", "DO_NOT_EXPORT")

            with self.subTest(mode=mode), patch("adf_api.shutil.which", return_value="az.cmd"), \
                    patch("adf_api.subprocess.run", side_effect=execute):
                if mode == "success":
                    self.assertEqual(adf_api.azure_json(["rest"], {"query": "safe"}), {})
                else:
                    with self.assertRaises(RuntimeError) as caught:
                        adf_api.azure_json(["rest"], {"query": "safe"})
                    self.assertNotIn("DO_NOT_EXPORT", str(caught.exception))
                self.assertTrue(paths)
                self.assertTrue(all(not path.exists() for path in paths))
        with patch("adf_api.shutil.which", return_value=None):
            with self.assertRaisesRegex(RuntimeError, "Azure CLI"):
                adf_api.azure_json(["account", "list"])


class InventoryTests(unittest.TestCase):
    def mock_collection(self, url, scope):
        if "/pipelines?" in url:
            return [{"name": "A", "properties": {"activities": [
                {"name": "Loop", "type": "ForEach", "typeProperties": {"activities": [
                    {"name": "CallB", "type": "ExecutePipeline", "typeProperties": {
                        "pipeline": {"type": "PipelineReference", "referenceName": "B"}}}]}},
                {"name": "Dynamic", "type": "ExecutePipeline", "typeProperties": {
                    "pipeline": {"type": "PipelineReference", "referenceName": "@DO_NOT_EXPORT"}}},
            ], "parameters": {"password": {"defaultValue": "DO_NOT_EXPORT"}}}},
                    {"name": "B", "properties": {"activities": []}}]
        if "/linkedservices?" in url:
            return [{"name": "LS", "properties": {"type": "AzureBlobFS", "typeProperties": {
                "resourceId": RESOURCE, "url": "https://LAKE.dfs.core.windows.net/path?sig=DO_NOT_EXPORT",
                "connectionString": {"type": "SecureString", "value": "DO_NOT_EXPORT"}}}}]
        if "/dataflows?" in url:
            return [{"name": "Flow", "properties": {"type": "MappingDataFlow",
                                                   "typeProperties": {"scriptLines": ["DO_NOT_EXPORT"]}}}]
        if "/managedVirtualNetworks?" in url:
            return [{"name": "default"}, {"name": "other"}]
        if "/managedPrivateEndpoints?" in url:
            return [{"name": "MPE", "properties": {
                "privateLinkResourceId": RESOURCE, "fqdns": ["lake.privatelink.dfs.core.windows.net"],
                "groupId": "dfs", "connectionState": {"status": "Approved", "description": "DO_NOT_EXPORT"}}}]
        return []

    def test_projection_preserves_graph_references_without_secrets_or_code(self):
        with patch("export_adf_inventory.collection", side_effect=self.mock_collection):
            snapshot = export.inventory(*PARAMS)
        self.assertNotIn("DO_NOT_EXPORT", json.dumps(snapshot))
        collections = snapshot["collections"]
        activities = collections["pipelines"][0]["properties"]["activities"]
        self.assertEqual(activities[0]["typeProperties"]["activities"][0]["typeProperties"]
                         ["pipeline"]["referenceName"], "B")
        self.assertEqual(activities[1]["typeProperties"]["pipeline"]["referenceName"], {"type": "Expression"})
        self.assertTrue(collections["dataflows"][0]["properties"]["typeProperties"]["uninspectedScript"])
        self.assertEqual(collections["linkedservices"][0]["properties"]["networkHosts"], ["lake.dfs.core.windows.net"])
        self.assertEqual(collections["linkedservices"][0]["properties"]["typeProperties"]["resourceId"], RESOURCE)
        endpoints = collections["managedPrivateEndpoints"]
        self.assertEqual([row["name"] for row in endpoints], ["default/MPE", "other/MPE"])
        self.assertEqual(endpoints[0]["properties"]["networkHosts"], ["lake.dfs.core.windows.net"])
        self.assertEqual(endpoints[0]["properties"]["connectionState"], {"status": "Approved"})
        self.assertTrue(all(snapshot["metadata"]["completeness"].values()))
        check = subprocess.run(["node", "-e", """
const fs = require('node:fs'), g = require('./graph.js');
const graph = g.buildGraph(JSON.parse(fs.readFileSync(0, 'utf8')));
const result = g.evaluateDeletion(graph, [g.idFor('pipeline', 'B')]);
if (result.results[0].blockers[0].name !== 'A') throw Error('Missing blocker');
if (!graph.edges.some(e => e.kind === 'resourceMatch')) throw Error('Missing resource match');
"""], input=json.dumps(snapshot), capture_output=True, encoding="utf-8",
                               cwd=Path(__file__).resolve().parent.parent, check=False)
        self.assertEqual(check.returncode, 0, check.stderr)

    def test_hosts_reject_credentials_expressions_and_nonhosts(self):
        for value in ("https://user:pass@lake.dfs.core.windows.net", "@{secret}",
                      {"type": "Expression"}, "not-a-host"):
            self.assertIsNone(export.network_host(value))
        self.assertEqual(export.network_host("tcp:sql.database.windows.net,1433"), "sql.database.windows.net")
        self.assertIsNone(export.resource_id("@DO_NOT_EXPORT"))

    def test_invalid_or_denied_collection_does_not_write_output(self):
        for response in ([{"name": "Broken"}], RuntimeError("denied")):
            with tempfile.TemporaryDirectory() as directory:
                output = Path(directory) / "inventory.json"
                with patch("export_adf_inventory.collection", side_effect=(
                    response if isinstance(response, RuntimeError) else lambda *args: response
                )), patch("sys.argv", ["export_adf_inventory.py", "--subscription-id", SUBSCRIPTION,
                                      "--resource-group-name", "rg-test", "--factory-name", "adf-test",
                                      "--output-path", str(output)]), contextlib.redirect_stderr(io.StringIO()):
                    self.assertEqual(export.main(), 1)
                    self.assertFalse(output.exists())

    def test_existing_output_is_not_overwritten(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "inventory.json"
            output.write_text("previous", encoding="utf-8")
            with self.assertRaises(FileExistsError):
                export.write_inventory({"new": True}, output)
            self.assertEqual(output.read_text(encoding="utf-8"), "previous")


class HistoryTests(unittest.TestCase):
    def test_api_pagination_projection_and_limit(self):
        with patch("pipeline_history.azure_json", side_effect=[
            {"value": [RUN], "continuationToken": "page2"}, {"value": []}
        ]) as cli:
            result = pipeline_history.history(*PARAMS)
        self.assertTrue(result["complete"])
        self.assertEqual(result["runs"], [{field: RUN[field] for field in pipeline_history.RUN_FIELDS}])
        self.assertNotIn("DO_NOT_EXPORT", json.dumps(result))
        self.assertEqual(cli.call_args_list[1].args[1]["continuationToken"], "page2")
        self.assertEqual((datetime.fromisoformat(result["to"]) - datetime.fromisoformat(result["from"])).days, 45)
        self.assertTrue(all(call.args[0][2] == "post" for call in cli.call_args_list))
        with patch("pipeline_history.azure_json", return_value={"value": [RUN, RUN]}), \
                patch("pipeline_history.MAX_RUNS", 1):
            with self.assertRaisesRegex(ValueError, "50000"):
                pipeline_history.history(*PARAMS)

    def test_api_rejects_cycles_invalid_responses_and_denied_requests(self):
        for response in ({"value": [], "continuationToken": "loop"},
                         {"value": [], "continuationToken": False}, {"value": None}):
            with patch("pipeline_history.azure_json", return_value=response):
                with self.assertRaises(ValueError):
                    pipeline_history.history(*PARAMS)
        with patch("pipeline_history.azure_json", side_effect=RuntimeError("denied")):
            with self.assertRaises(RuntimeError):
                pipeline_history.history(*PARAMS)

    def test_loganalytics_both_schemas_merge_native_history_and_keep_unconfirmed_coverage(self):
        for table in ("ADFPipelineRun", "AzureDiagnostics"):
            response = {"tables": [{"columns": [{"name": field} for field in pipeline_history.RUN_FIELDS],
                                    "rows": [[RUN[field] for field in pipeline_history.RUN_FIELDS]]}]}
            with self.subTest(table=table), patch("pipeline_history.azure_json", side_effect=[
                response, {"value": [RUN]}
            ]) as cli:
                start = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat()
                result = pipeline_history.history(*PARAMS, "loganalytics", WORKSPACE, start, table)
                self.assertFalse(result["complete"])
                self.assertEqual(len(result["runs"]), 2)
                query = cli.call_args_list[0].args[1]["query"]
                self.assertIn(f"_ResourceId =~ '{adf_api.factory_id(*PARAMS)}'", query)
                self.assertIn("arg_max", query)
                self.assertIn("PipelineName_s" if table == "AzureDiagnostics" else "PipelineName,", query)
                self.assertNotIn("DO_NOT_EXPORT", json.dumps(result))

    def test_logs_fail_without_partial_results_or_invalid_coverage(self):
        start = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat()
        for response in ({"error": {"code": "PartialError"}, "tables": []},
                         {"tables": [{"columns": [], "rows": []}]}):
            with patch("pipeline_history.azure_json", return_value=response):
                with self.assertRaises(ValueError):
                    pipeline_history.history(*PARAMS, "loganalytics", WORKSPACE, start)
        response = {"tables": [{"columns": [{"name": field} for field in pipeline_history.RUN_FIELDS],
                                "rows": []}]}
        with patch("pipeline_history.azure_json", side_effect=[response, RuntimeError("native denied")]):
            with self.assertRaisesRegex(RuntimeError, "native denied"):
                pipeline_history.history(*PARAMS, "loganalytics", WORKSPACE, start)
        for start in ("2024-01-01", "2000-01-01T00:00:00Z", "2999-01-01T00:00:00Z"):
            with patch("pipeline_history.azure_json") as cli:
                with self.assertRaises(ValueError):
                    pipeline_history.history(*PARAMS, "loganalytics", WORKSPACE, start)
                cli.assert_not_called()

    def test_loganalytics_rejects_malformed_column_names(self):
        start = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat()
        for name in (["invalid"], {"invalid": True}, None, ""):
            response = {"tables": [{"columns": [
                *({"name": field} for field in pipeline_history.RUN_FIELDS), {"name": name}
            ], "rows": []}]}
            with self.subTest(name=name), patch("pipeline_history.azure_json", return_value=response):
                with self.assertRaisesRegex(ValueError, "columnas"):
                    pipeline_history.history(*PARAMS, "loganalytics", WORKSPACE, start)

    def test_loganalytics_accepts_utc_z_coverage(self):
        start = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat().replace("+00:00", "Z")
        response = {"tables": [{"columns": [{"name": field} for field in pipeline_history.RUN_FIELDS],
                                "rows": []}]}
        with patch("pipeline_history.azure_json", side_effect=[response, {"value": []}]):
            result = pipeline_history.history(*PARAMS, "loganalytics", WORKSPACE, start)
        self.assertEqual(result["from"], start.replace("Z", "+00:00"))


class WorkerTests(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Verifies the Windows Azure CLI launcher boundary")
    def test_node_invokes_python_worker_with_mock_windows_azure_cli(self):
        expected = {"subscriptions": [{"id": SUBSCRIPTION, "name": "Test", "tenantId": WORKSPACE}]}
        accounts = [{"state": "Enabled", **expected["subscriptions"][0]}]
        with tempfile.TemporaryDirectory(prefix="adf python cli ") as directory:
            Path(directory, "az.cmd").write_text(
                "@echo off\n"
                "if not \"%~1 %~2\"==\"account list\" exit /b 9\n"
                f"echo {json.dumps(accounts)}\n", encoding="ascii"
            )
            environment = {**os.environ, "PATH": directory + os.pathsep + os.environ.get("PATH", ""),
                           "ADF_BACKEND": "python", "PYTHON": sys.executable,
                           "PYTHONDONTWRITEBYTECODE": "1"}
            result = subprocess.run(
                ["node", "-e", """
require('./server.js').queryAzure('subscriptions')
  .then(result => console.log(JSON.stringify(result)))
  .catch(error => { console.error(error.message); process.exitCode = 1; });
"""], env=environment, capture_output=True, encoding="utf-8", timeout=30, check=False,
                cwd=Path(__file__).resolve().parent.parent,
            )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), expected)

    def test_worker_projects_accounts_and_factories(self):
        with patch("azure_portal_query.azure_json", return_value=[
            {"id": SUBSCRIPTION, "name": "Test", "state": "Enabled", "tenantId": WORKSPACE,
             "user": {"name": "DO_NOT_EXPORT"}},
            {"state": "Disabled"},
        ]):
            result = azure_portal_query.query("subscriptions")
            self.assertEqual(len(result["subscriptions"]), 1)
            self.assertNotIn("DO_NOT_EXPORT", json.dumps(result))
        with patch("azure_portal_query.collection", return_value=[
            {"id": adf_api.factory_id(*PARAMS), "name": "adf-test", "location": "eastus", "identity": "DO_NOT_EXPORT"}
        ]):
            result = azure_portal_query.query("factories", SUBSCRIPTION)
            self.assertEqual(len(result["factories"]), 1)
            self.assertNotIn("DO_NOT_EXPORT", json.dumps(result))
        with patch("azure_portal_query.azure_json", return_value=[]):
            with self.assertRaisesRegex(ValueError, "habilitadas"):
                azure_portal_query.query("subscriptions")

    def test_worker_routes_inventory_and_history(self):
        with patch("azure_portal_query.inventory", return_value={"schemaVersion": 1}) as inventory:
            self.assertEqual(azure_portal_query.query("inventory", *PARAMS), {"schemaVersion": 1})
            inventory.assert_called_once_with(*PARAMS)
        with patch("azure_portal_query.history", return_value={"runs": []}) as history:
            azure_portal_query.query("history", *PARAMS, "loganalytics", WORKSPACE, "2024-01-01T00:00:00Z",
                                     "AzureDiagnostics")
            history.assert_called_once_with(*PARAMS, "loganalytics", WORKSPACE, "2024-01-01T00:00:00Z",
                                            "AzureDiagnostics")

    def test_worker_emits_only_json_and_nonzero_status_on_failure(self):
        for failure in (False, True):
            output = io.StringIO()
            with patch("sys.argv", ["azure_portal_query.py", "--operation", "subscriptions"]), \
                    patch("azure_portal_query.query", side_effect=RuntimeError("denied") if failure else None,
                          return_value={"subscriptions": []}), contextlib.redirect_stdout(output):
                code = azure_portal_query.main()
            self.assertEqual(code, int(failure))
            self.assertEqual(json.loads(output.getvalue()),
                             {"error": "denied"} if failure else {"subscriptions": []})


if __name__ == "__main__":
    unittest.main()
