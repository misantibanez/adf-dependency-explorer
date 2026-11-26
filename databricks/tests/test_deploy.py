import base64
import io
import json
import subprocess
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch
from urllib.parse import parse_qs, urlsplit

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "databricks"))

import deploy

HOST = "https://adb-1234567890123456.1.azuredatabricks.net"
WAREHOUSE = "1234567890abcdef"
PRINCIPAL = "11111111-1111-1111-1111-111111111111"
ARGS = ["--host", HOST, "--warehouse-id", WAREHOUSE, "--catalog", "main", "--schema", "adf"]


class FakeClient:
    def __init__(self, *, existing=False, remote=None, deployment_state="SUCCEEDED"):
        self.calls = []
        self.statements = []
        self.remote = remote or {}
        self.exists = existing
        self.principal_reads = 0
        self.deployment_state = deployment_state

    def api(self, path, method="GET", data=None, missing_ok=False):
        self.calls.append((path, method, data))
        if path.startswith("/api/2.1/unity-catalog/tables/"):
            if not self.exists:
                return None
            suffix = path.rsplit("adf_", 1)[1]
            return {
                "data_source_format": "DELTA",
                "columns": [{"name": field.strip().split()[0],
                             "type_name": field.strip().split()[1].upper()}
                            for field in deploy.SCHEMAS[suffix].split(",")],
            }
        if "/workspace/get-status?" in path:
            remote = parse_qs(urlsplit(path).query)["path"][0]
            if remote in self.remote:
                return {"object_type": "NOTEBOOK" if remote.endswith(deploy.NOTEBOOK) else "FILE",
                        "object_id": 42}
            return None
        if "/workspace/export?" in path:
            remote = parse_qs(urlsplit(path).query)["path"][0]
            return {"content": base64.b64encode(self.remote[remote].encode()).decode()}
        if path.endswith("/workspace/import"):
            self.remote[data["path"]] = base64.b64decode(data["content"]).decode()
            return {}
        if "/deployments/" in path:
            return {"status": {"state": self.deployment_state}}
        if path.endswith("/deployments"):
            return {"deployment_id": "deployment-id"}
        if path == "/api/2.0/apps" and method == "POST":
            self.exists = True
            return {}
        if path == "/api/2.0/apps/adf-dependency-explorer":
            if not self.exists:
                return None
            self.principal_reads += 1
            return {
                "resources": [{"name": "sql-warehouse",
                               "sql_warehouse": {"id": WAREHOUSE, "permission": "CAN_USE"}}],
                "compute_status": {"state": "ACTIVE"}, "app_status": {"state": "RUNNING"},
                "service_principal_client_id": PRINCIPAL if self.principal_reads > 1 else None,
                "url": "https://app.example",
            }
        return {}

    def sql(self, statement):
        self.statements.append(statement)
        return {}


class DeploymentTests(unittest.TestCase):
    def options(self, *extra):
        return deploy.arguments(ARGS + list(extra))

    def test_preview_runs_without_sdk_authentication_or_generated_assets(self):
        result = subprocess.run(
            [sys.executable, "-B", str(ROOT / "databricks" / "deploy.py"), *ARGS],
            cwd=ROOT.parent, capture_output=True, encoding="utf-8", timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("LOCAL_PREVIEW", result.stdout)
        with patch.object(deploy, "Client") as client, patch("sys.stdout", new_callable=io.StringIO):
            self.assertEqual(deploy.main(ARGS), 0)
        client.assert_not_called()
        options = self.options()
        files = deploy.sources(options)
        self.assertEqual(files["databricks/app/static/graph.js"], files["graph.js"])
        self.assertEqual(files["databricks/app/static/history.js"], files["history.js"])
        self.assertIn('"catalog": "main", "schema": "adf"', files[deploy.NOTEBOOK])
        self.assertIn('value: "main"', files["databricks/app/app.yaml"])
        self.assertNotIn("CHANGE_ME", files["databricks/app/app.yaml"])
        self.assertFalse(any("secret" in name or ".azure" in name for name in files))
        self.assertIn('"catalog": "", "schema": ""',
                      (ROOT / "databricks" / "01_collect_adf.py").read_text(encoding="utf-8"))

    def test_rejects_unsafe_targets_before_loading_sdk(self):
        bad_arguments = (
            ["--host", "http://workspace.azuredatabricks.net"],
            ["--host", "https://workspace.azuredatabricks.net.evil.example"],
            ["--host", "https://user@workspace.azuredatabricks.net"],
            ["--workspace-path", "/"],
            ["--workspace-path", "/Shared/../Users/someone"],
            ["--workspace-path", "/Shared/app//nested"],
            ["--app-name", "bad/app"],
            ["--warehouse-id", "../warehouse"],
            ["--timeout-seconds", "0"],
        )
        for extra in bad_arguments:
            with self.subTest(extra=extra), patch("sys.stderr", new_callable=io.StringIO):
                with self.assertRaises(SystemExit):
                    self.options(*extra)
        with self.assertRaises(ValueError):
            self.options("--catalog", "main`;DROP")

    def test_create_waits_for_identity_and_reuses_schemas_without_reading_secrets(self):
        options = self.options("--apply")
        client = FakeClient()
        files = deploy.sources(options)
        with patch("deploy.time.sleep"), patch("sys.stdout", new_callable=io.StringIO):
            result = deploy.deploy(client, options, files)
        self.assertEqual(result["app_state"], "RUNNING")
        self.assertEqual(result["notebook_url"], HOST + "/editor/notebooks/42")
        self.assertEqual(result["uploaded_files"], len(files))
        self.assertGreaterEqual(client.principal_reads, 2)
        ddl = client.statements[:8]
        self.assertTrue(all("IF NOT EXISTS" in statement for statement in ddl))
        self.assertEqual(len([s for s in ddl if s.startswith("CREATE TABLE")]), 7)
        self.assertEqual(client.statements[8:], [
            f"GRANT USE CATALOG ON CATALOG `main` TO `{PRINCIPAL}`",
            f"GRANT USE SCHEMA ON SCHEMA `main`.`adf` TO `{PRINCIPAL}`",
            f"GRANT SELECT ON TABLE `main`.`adf`.`adf_snapshots` TO `{PRINCIPAL}`",
        ])
        uploads = [data for path, method, data in client.calls if path.endswith("/workspace/import")]
        notebook = next(item for item in uploads if item["path"].endswith(deploy.NOTEBOOK))
        self.assertEqual((notebook["format"], notebook["language"]), ("SOURCE", "PYTHON"))
        self.assertTrue(all(not item["overwrite"] for item in uploads))
        deployment = next(data for path, method, data in client.calls if path.endswith("/deployments"))
        self.assertEqual(deployment, {
            "source_code_path": "/Workspace/Shared/adf-dependency-explorer/databricks/app",
            "mode": "SNAPSHOT",
        })
        self.assertFalse(any("/secrets" in path or method == "DELETE"
                             for path, method, _ in client.calls))

    def test_remote_notebook_edits_abort_before_any_write_unless_overwrite(self):
        options = self.options("--apply")
        remote = options.workspace_path + "/" + deploy.NOTEBOOK
        files = {deploy.NOTEBOOK: "new notebook"}
        client = FakeClient(existing=True, remote={remote: "user diagnostic cell"})
        with self.assertRaisesRegex(ValueError, "--overwrite"):
            deploy.deploy(client, options, files)
        self.assertFalse(client.statements)
        self.assertTrue(all(method == "GET" for _, method, _ in client.calls))
        options.overwrite = True
        with patch("deploy.time.sleep"), patch("sys.stdout", new_callable=io.StringIO):
            deploy.deploy(client, options, files)
        uploads = [data for path, _, data in client.calls if path.endswith("/workspace/import")]
        self.assertEqual(len(uploads), 1)
        self.assertTrue(uploads[0]["overwrite"])
        self.assertFalse(any(path == "/api/2.0/apps" and method == "POST"
                             for path, method, _ in client.calls))

    def test_identical_sources_are_skipped_and_existing_snapshots_not_overwritten(self):
        options = self.options("--apply")
        files = deploy.sources(options)
        client = FakeClient(existing=True, remote={
            options.workspace_path + "/" + name: content.replace("\n", "\r\n")
            for name, content in files.items()
        })
        with patch("deploy.time.sleep"), patch("sys.stdout", new_callable=io.StringIO):
            result = deploy.deploy(client, options, files)
        self.assertEqual(result["uploaded_files"], 0)
        self.assertFalse(any(path.endswith("/workspace/import") for path, _, _ in client.calls))
        self.assertFalse(any(word in statement for statement in client.statements
                             for word in ("DROP", "TRUNCATE", "REPLACE", "INSERT", "DELETE")))

    def test_incompatible_tables_or_app_resource_fail_before_writes(self):
        options = self.options("--apply")
        client = FakeClient(existing=True)
        original_api = client.api

        def incompatible(path, *args, **kwargs):
            response = original_api(path, *args, **kwargs)
            if "/unity-catalog/tables/" in path:
                response["columns"] = []
            return response

        client.api = Mock(side_effect=incompatible)
        with self.assertRaisesRegex(ValueError, "Tabla existente incompatible"):
            deploy.deploy(client, options, {})
        self.assertFalse(client.statements)
        client = FakeClient(existing=True)
        options.warehouse_id = "ffffffffffffffff"
        with self.assertRaisesRegex(ValueError, "otro recurso sql-warehouse"):
            deploy.deploy(client, options, {})
        self.assertFalse(client.statements)

    def test_failed_deployment_and_timeouts_are_never_reported_as_success(self):
        options = self.options("--apply")
        client = FakeClient(deployment_state="FAILED")
        with patch("deploy.time.sleep"), patch("sys.stdout", new_callable=io.StringIO):
            with self.assertRaisesRegex(RuntimeError, "Despliegue FAILED"):
                deploy.deploy(client, options, {deploy.NOTEBOOK: "notebook"})
        with patch("deploy.time.monotonic", side_effect=[0, 2]):
            with self.assertRaisesRegex(RuntimeError, "Timeout esperando"):
                deploy.wait_for(lambda: {}, lambda _: False, "App", 1)

    def test_sql_polling_and_failure_keep_statement_id_without_raw_error_body(self):
        client = deploy.Client.__new__(deploy.Client)
        client._warehouse = WAREHOUSE
        client._timeout = 60
        client.api = Mock(side_effect=[
            {"statement_id": "id", "status": {"state": "PENDING"}},
            {"statement_id": "id", "status": {"state": "SUCCEEDED"}},
        ])
        with patch("deploy.time.sleep"):
            self.assertEqual(client.sql("SELECT 1")["status"]["state"], "SUCCEEDED")
        client.api = Mock(return_value={
            "statement_id": "id", "status": {"state": "FAILED", "error": {"message": "DO_NOT_EXPORT"}},
        })
        with self.assertRaisesRegex(RuntimeError, "SQL FAILED.*id") as caught:
            client.sql("SELECT 1")
        self.assertNotIn("DO_NOT_EXPORT", str(caught.exception))

    def test_sdk_configuration_and_errors_do_not_disclose_response_or_credentials(self):
        class DatabricksError(Exception):
            pass

        class NotFound(DatabricksError):
            pass

        workspace = Mock()
        config_factory = Mock(return_value=object())

        def workspace_factory(*, config):
            self.assertIs(config, config_factory.return_value)
            return workspace

        modules = {
            "databricks.sdk": SimpleNamespace(WorkspaceClient=workspace_factory),
            "databricks.sdk.core": SimpleNamespace(Config=config_factory),
            "databricks.sdk.errors": SimpleNamespace(DatabricksError=DatabricksError, NotFound=NotFound),
        }
        with patch.dict(sys.modules, modules):
            client = deploy.Client(self.options("--profile", "test-profile"))
        config_factory.assert_called_once_with(host=HOST, profile="test-profile", http_timeout_seconds=90)
        workspace.api_client.do.return_value = {"ok": True}
        self.assertEqual(client.api("/api/test", "POST", {"safe": True}), {"ok": True})
        workspace.api_client.do.assert_called_once_with(
            method="POST", path="/api/test", body={"safe": True},
        )
        workspace.api_client.do.side_effect = NotFound("DO_NOT_EXPORT")
        self.assertIsNone(client.api("/api/missing", missing_ok=True))
        workspace.api_client.do.side_effect = DatabricksError("DO_NOT_EXPORT")
        with self.assertRaises(RuntimeError) as caught:
            client.api("/api/denied", missing_ok=True)
        self.assertNotIn("DO_NOT_EXPORT", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
