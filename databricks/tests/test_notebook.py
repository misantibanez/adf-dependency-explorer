import io
import sys
import unittest
import warnings
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "databricks"))

from adf_api import guid
from delta_store import namespace

NOTEBOOK = ROOT / "databricks" / "01_collect_adf.py"
PRINCIPAL = "11111111-1111-1111-1111-111111111111"


class NotebookSetupTests(unittest.TestCase):
    def context(self, **overrides):
        widgets = {
            "setup_mode": "true", "secret_scope": "test-scope", "tenant_key": "tenant-id",
            "client_key": "client-id", "secret_key": "client-secret",
            "catalog": "test_catalog", "schema": "test_schema", "app_name": "test-app",
        }
        widgets.update(overrides)
        dbutils = Mock()
        dbutils.widgets.get.side_effect = widgets.__getitem__
        workspace = Mock()
        workspace.secrets.list_scopes.return_value = []
        workspace.secrets.list_secrets.return_value = []
        return {
            "dbutils": dbutils, "spark": Mock(), "display": Mock(),
            "namespace": namespace, "guid": guid, "w": workspace,
        }

    def run_cell(self, marker, context):
        cells = NOTEBOOK.read_text(encoding="utf-8").split("# COMMAND ----------")
        matches = [cell for cell in cells if marker in cell]
        self.assertEqual(len(matches), 1, marker)
        with patch("sys.stdout", new_callable=io.StringIO) as output:
            exec(compile(matches[0], str(NOTEBOOK), "exec"), context)
        return output.getvalue()

    def initialize(self, context):
        factory = Mock(return_value=context["w"])
        with patch.dict(sys.modules, {"databricks.sdk": SimpleNamespace(WorkspaceClient=factory)}):
            self.run_cell('setup_mode = dbutils.widgets.get("setup_mode")', context)
        return factory

    def test_normal_execution_never_uses_setup_sdk_prompts_or_writes(self):
        context = self.context(setup_mode="false")
        factory = self.initialize(context)
        with patch("getpass.getpass", side_effect=AssertionError("Interactive input is forbidden")):
            self.run_cell("def registrar_claves_faltantes", context)
        self.run_cell('print("Scopes disponibles:")', context)
        self.run_cell("setup_target = namespace", context)
        self.run_cell('app_name = dbutils.widgets.get("app_name")', context)
        factory.assert_not_called()
        context["w"].assert_not_called()
        self.assertEqual(context["w"].mock_calls, [])
        context["spark"].sql.assert_not_called()
        context["dbutils"].secrets.listScopes.assert_not_called()

    def test_missing_scope_is_created_and_existing_keys_are_preserved(self):
        context = self.context()
        self.initialize(context)
        context["w"].secrets.create_scope.assert_called_once_with(scope="test-scope")
        context["w"].secrets.list_secrets.return_value = [
            SimpleNamespace(key=key) for key in ("TENANT-ID", "client-id", "client-secret")
        ]
        with patch("getpass.getpass", side_effect=AssertionError("Existing secrets must not be prompted")):
            self.run_cell("def registrar_claves_faltantes", context)
        context["w"].secrets.put_secret.assert_not_called()

        context = self.context()
        context["w"].secrets.list_scopes.return_value = [SimpleNamespace(name="TEST-SCOPE")]
        self.initialize(context)
        context["w"].secrets.create_scope.assert_not_called()

    def test_custom_keys_are_stored_without_values_in_output_and_without_echo_fallback(self):
        context = self.context(tenant_key="custom-tenant", client_key="custom-client", secret_key="custom-secret")
        self.initialize(context)
        context["w"].secrets.list_secrets.return_value = [
            SimpleNamespace(key="custom-tenant"), SimpleNamespace(key="custom-client"),
        ]
        with patch("getpass.getpass", return_value="DO_NOT_EXPORT"):
            output = self.run_cell("def registrar_claves_faltantes", context)
        context["w"].secrets.put_secret.assert_called_once_with(
            scope="test-scope", key="custom-secret", string_value="DO_NOT_EXPORT",
        )
        self.assertNotIn("DO_NOT_EXPORT", output)
        context["w"].secrets.put_secret.reset_mock()

        def unsafe_prompt(_):
            import getpass
            warnings.warn("Cannot hide input", getpass.GetPassWarning)
            return "MUST_NOT_BE_STORED"

        import getpass
        with patch("getpass.getpass", side_effect=unsafe_prompt), self.assertRaises(getpass.GetPassWarning):
            self.run_cell("def registrar_claves_faltantes", context)
        context["w"].secrets.put_secret.assert_not_called()
        with patch("getpass.getpass", return_value=""), self.assertRaisesRegex(ValueError, "valor vacio"):
            self.run_cell("def registrar_claves_faltantes", context)
        context["w"].secrets.put_secret.assert_not_called()

    def test_schema_is_created_and_checked_using_validated_widgets(self):
        context = self.context()
        self.initialize(context)
        self.run_cell("setup_target = namespace", context)
        self.assertEqual([call.args[0] for call in context["spark"].sql.call_args_list], [
            "CREATE SCHEMA IF NOT EXISTS `test_catalog`.`test_schema`",
            "DESCRIBE SCHEMA `test_catalog`.`test_schema`",
        ])
        context = self.context(catalog="bad`;DROP")
        self.initialize(context)
        with self.assertRaises(ValueError):
            self.run_cell("setup_target = namespace", context)
        context["spark"].sql.assert_not_called()

    def test_grants_use_app_service_principal_and_fail_before_sql_for_invalid_identity(self):
        context = self.context()
        self.initialize(context)
        context["w"].apps.get.return_value = SimpleNamespace(
            service_principal_client_id=PRINCIPAL, oauth_app_id="DO_NOT_USE_OAUTH_ID",
        )
        self.run_cell('app_name = dbutils.widgets.get("app_name")', context)
        context["w"].apps.get.assert_called_once_with("test-app")
        self.assertEqual([call.args[0] for call in context["spark"].sql.call_args_list], [
            f"GRANT USE CATALOG ON CATALOG `test_catalog` TO `{PRINCIPAL}`",
            f"GRANT USE SCHEMA ON SCHEMA `test_catalog`.`test_schema` TO `{PRINCIPAL}`",
            f"GRANT SELECT ON TABLE `test_catalog`.`test_schema`.`adf_snapshots` TO `{PRINCIPAL}`",
        ])
        for value, error in ((None, RuntimeError), ("bad`principal", ValueError)):
            context["spark"].sql.reset_mock()
            context["w"].apps.get.return_value.service_principal_client_id = value
            with self.subTest(value=value), self.assertRaises(error):
                self.run_cell('app_name = dbutils.widgets.get("app_name")', context)
            context["spark"].sql.assert_not_called()


if __name__ == "__main__":
    unittest.main()
