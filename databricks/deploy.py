"""Deploy the notebook, Delta tables and App; preview locally unless --apply is given."""

import argparse
import base64
import json
import re
import sys
import time
from pathlib import Path
from typing import Literal, overload
from urllib.parse import quote, urlsplit
from uuid import UUID

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from delta_store import SCHEMAS, namespace

SOURCES = (
    "adf_api.py", "export_adf_inventory.py", "pipeline_history.py", "graph.js", "history.js",
    "databricks/01_collect_adf.py", "databricks/azure_rest.py", "databricks/analysis.py",
    "databricks/delta_store.py", "databricks/prepare_app.py",
    "databricks/requirements-notebook.txt", "databricks/README.md",
    "databricks/app/app.py", "databricks/app/app.yaml", "databricks/app/repository.py",
    "databricks/app/requirements.txt", "databricks/app/static/index.html",
    "databricks/app/static/portal.js", "databricks/app/static/portal.css",
)
NOTEBOOK = "databricks/01_collect_adf.py"


def arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", required=True, help="URL HTTPS del workspace Azure Databricks.")
    parser.add_argument("--profile", help="Perfil de autenticacion de Databricks CLI/SDK.")
    parser.add_argument("--warehouse-id", required=True, help="SQL warehouse existente; puede iniciarse.")
    parser.add_argument("--catalog", required=True, help="Catalogo existente de Unity Catalog.")
    parser.add_argument("--schema", required=True, help="Esquema a crear o reutilizar.")
    parser.add_argument("--app-name", default="adf-dependency-explorer")
    parser.add_argument("--workspace-path", help="Carpeta dedicada /Shared/... o /Users/...")
    parser.add_argument("--timeout-seconds", type=int, default=1200, help="Espera maxima por operacion.")
    parser.add_argument("--apply", action="store_true", help="Crear/actualizar recursos; genera costos.")
    parser.add_argument("--overwrite", action="store_true", help="Permitir reemplazar fuentes distintas.")
    options = parser.parse_args(argv)
    parsed = urlsplit(options.host)
    if (parsed.scheme != "https" or not parsed.hostname
            or not parsed.hostname.endswith(".azuredatabricks.net")
            or parsed.port not in (None, 443) or parsed.username or parsed.password
            or parsed.query or parsed.fragment or parsed.path not in ("", "/")):
        parser.error("--host debe ser la URL HTTPS de un workspace Azure Databricks publico.")
    options.host = options.host.rstrip("/")
    namespace(options.catalog, options.schema)
    if not re.fullmatch(r"[a-z][a-z0-9-]{0,28}[a-z0-9]", options.app_name):
        parser.error("--app-name requiere 2-30 caracteres: letras minusculas, numeros y guiones.")
    if not re.fullmatch(r"[a-fA-F0-9]{16}", options.warehouse_id):
        parser.error("--warehouse-id debe tener 16 caracteres hexadecimales.")
    options.workspace_path = options.workspace_path or f"/Shared/{options.app_name}"
    path = options.workspace_path
    if (not path.startswith(("/Shared/", "/Users/")) or path.endswith("/")
            or any(part in ("", ".", "..") for part in path.split("/")[1:])
            or "\\" in path or any(ord(char) < 32 for char in path)):
        parser.error("--workspace-path requiere una carpeta dedicada, sin segmentos . o ..")
    if options.timeout_seconds <= 0:
        parser.error("--timeout-seconds debe ser positivo.")
    return options


def sources(options: argparse.Namespace, root: Path = ROOT) -> dict[str, str]:
    result = {}
    for relative in SOURCES:
        source = root.joinpath(*relative.split("/"))
        if not source.resolve().is_relative_to(root.resolve()):
            raise ValueError(f"Fuente fuera del repositorio: {relative}")
        result[relative] = source.read_text(encoding="utf-8")
    # Ship the canonical engines, never ignored or stale generated copies.
    for name in ("graph.js", "history.js"):
        result[f"databricks/app/static/{name}"] = result[name]
    config = result["databricks/app/app.yaml"]
    for name, value in (("ADF_CATALOG", options.catalog), ("ADF_SCHEMA", options.schema)):
        config, count = re.subn(
            rf'(?m)(^  - name: {name}\n    value: )"[^"\n]*"$',
            lambda match: match[1] + json.dumps(value), config,
        )
        if count != 1:
            raise ValueError(f"Plantilla app.yaml no reconocida para {name}.")
    result["databricks/app/app.yaml"] = config
    notebook = result[NOTEBOOK]
    marker = '"catalog": "", "schema": ""'
    if notebook.count(marker) != 1:
        raise ValueError("Defaults de catalog/schema no reconocidos en el notebook.")
    result[NOTEBOOK] = notebook.replace(
        marker, f'"catalog": "{options.catalog}", "schema": "{options.schema}"',
    )
    return result


class Client:
    def __init__(self, options: argparse.Namespace):
        try:
            from databricks.sdk import WorkspaceClient
            from databricks.sdk.core import Config
            from databricks.sdk.errors import DatabricksError, NotFound
        except ImportError:
            raise RuntimeError("Instalar dependencias de databricks/requirements-deploy.txt.") from None
        self._errors = (DatabricksError, NotFound)
        try:
            self._workspace = WorkspaceClient(
                config=Config(host=options.host, profile=options.profile, http_timeout_seconds=90),
            )
        except ValueError:
            raise RuntimeError("No se pudo autenticar; revisar el perfil Databricks CLI/SDK.") from None
        self._warehouse = options.warehouse_id
        self._timeout = options.timeout_seconds

    @overload
    def api(self, path: str, method: str = "GET", data: dict | None = None, *,
            missing_ok: Literal[False] = False) -> dict: ...

    @overload
    def api(self, path: str, method: str = "GET", data: dict | None = None, *,
            missing_ok: Literal[True]) -> dict | None: ...

    def api(self, path: str, method: str = "GET", data: dict | None = None, *,
            missing_ok: bool = False) -> dict | None:
        error_type, not_found = self._errors
        try:
            result = self._workspace.api_client.do(method=method, path=path, body=data)
        except not_found:
            if missing_ok:
                return None
            raise RuntimeError(f"Databricks: recurso no encontrado en {path.split('?')[0]}.") from None
        except error_type as error:
            raise RuntimeError(
                f"Databricks {type(error).__name__} en {path.split('?')[0]}; revisar permisos y recursos."
            ) from None
        if result is None:
            return {}
        if not isinstance(result, dict):
            raise ValueError("Databricks no devolvio un objeto JSON.")
        return result

    def sql(self, statement: str) -> dict:
        response = self.api("/api/2.0/sql/statements", "POST", {
            "warehouse_id": self._warehouse, "statement": statement, "wait_timeout": "50s",
            "on_wait_timeout": "CONTINUE", "disposition": "INLINE", "format": "JSON_ARRAY",
        })
        statement_id = response["statement_id"]
        deadline = time.monotonic() + self._timeout
        while True:
            state = response["status"]["state"]
            if state == "SUCCEEDED":
                return response
            if state not in ("PENDING", "RUNNING"):
                raise RuntimeError(f"SQL {state}; revisar statement {statement_id} en Query History.")
            if time.monotonic() >= deadline:
                raise RuntimeError(f"Timeout SQL; statement {statement_id} puede seguir ejecutandose.")
            time.sleep(5)
            response = self.api(f"/api/2.0/sql/statements/{quote(statement_id, safe='')}")


def normalized(text: str) -> str:
    return text.replace("\r\n", "\n").rstrip() + "\n"


def wait_for(read, ready, description: str, timeout: int) -> dict:
    deadline = time.monotonic() + timeout
    while True:
        value = read()
        if ready(value):
            return value
        if time.monotonic() >= deadline:
            raise RuntimeError(f"Timeout esperando {description}; revisar estado antes de reintentar.")
        time.sleep(5)


def validate_table(table: dict, definition: str, name: str):
    actual = [(column["name"], column["type_name"].lower()) for column in table["columns"]]
    expected = [tuple(field.strip().split()) for field in definition.split(",")]
    if actual != expected or table.get("data_source_format") != "DELTA":
        raise ValueError(f"Tabla existente incompatible: {name}; no se modifica ni se elimina.")


def deploy(client: Client, options: argparse.Namespace, files: dict[str, str]) -> dict:
    target = namespace(options.catalog, options.schema)
    app_path = "/api/2.0/apps/" + options.app_name
    app = client.api(app_path, missing_ok=True)
    if app is not None:
        resource = next((item.get("sql_warehouse") for item in app.get("resources", [])
                         if item["name"] == "sql-warehouse"), None)
        if (not resource or resource.get("id") != options.warehouse_id
                or resource.get("permission") != "CAN_USE"):
            raise ValueError("La App existente tiene otro recurso sql-warehouse; no se reconfigura.")
        if app.get("pending_deployment"):
            raise RuntimeError("La App tiene otro despliegue pendiente; esperar antes de continuar.")
    client.api("/api/2.0/sql/warehouses/" + options.warehouse_id)
    client.api("/api/2.1/unity-catalog/catalogs/" + quote(options.catalog, safe=""))
    for suffix, definition in SCHEMAS.items():
        name = f"{options.catalog}.{options.schema}.adf_{suffix}"
        table = client.api("/api/2.1/unity-catalog/tables/" + quote(name, safe=""), missing_ok=True)
        if table is not None:
            validate_table(table, definition, name)
    changes = []
    for relative, content in files.items():
        remote = options.workspace_path + "/" + relative
        query = "?path=" + quote(remote, safe="")
        info = client.api("/api/2.0/workspace/get-status" + query, missing_ok=True)
        if info is not None:
            expected_type = "NOTEBOOK" if relative == NOTEBOOK else "FILE"
            if info.get("object_type") != expected_type:
                raise ValueError(f"Tipo de objeto remoto incompatible: {remote}")
            export_format = "SOURCE" if relative == NOTEBOOK else "AUTO"
            exported = client.api("/api/2.0/workspace/export" + query + "&format=" + export_format)
            actual = base64.b64decode(exported["content"], validate=True).decode("utf-8")
            if normalized(actual) == normalized(content):
                continue
            if not options.overwrite:
                raise ValueError(f"Fuente remota distinta: {remote}; requiere --overwrite.")
        changes.append((relative, remote, content, info is not None))

    client.sql(f"CREATE SCHEMA IF NOT EXISTS {target}")
    for suffix, definition in SCHEMAS.items():
        client.sql(f"CREATE TABLE IF NOT EXISTS {target}.`adf_{suffix}` ({definition}) USING DELTA")
    for relative, remote, content, exists in changes:
        client.api("/api/2.0/workspace/mkdirs", "POST", {"path": remote.rsplit("/", 1)[0]})
        payload = {
            "path": remote, "format": "SOURCE" if relative == NOTEBOOK else "AUTO",
            "content": base64.b64encode(content.encode("utf-8")).decode("ascii"),
            "overwrite": exists and options.overwrite,
        }
        if relative == NOTEBOOK:
            payload["language"] = "PYTHON"
        client.api("/api/2.0/workspace/import", "POST", payload)
        print(f"Fuente publicada: {relative}", flush=True)

    if app is None:
        app = client.api("/api/2.0/apps", "POST", {
            "name": options.app_name,
            "description": "ADF Dependency Explorer: published Delta snapshots, read-only portal",
            "resources": [{"name": "sql-warehouse", "description": "Read ADF snapshots",
                           "sql_warehouse": {"id": options.warehouse_id, "permission": "CAN_USE"}}],
        })
    elif app.get("compute_status", {}).get("state") == "STOPPED":
        client.api(app_path + "/start", "POST", {})

    def app_ready(value):
        if value.get("compute_status", {}).get("state") == "ERROR":
            raise RuntimeError("Error de compute de la App; revisar Compute > Apps.")
        return (value.get("compute_status", {}).get("state") == "ACTIVE"
                and bool(value.get("service_principal_client_id")))

    app = wait_for(lambda: client.api(app_path), app_ready, "compute e identidad de la App",
                   options.timeout_seconds)
    principal = str(UUID(app["service_principal_client_id"]))
    for statement in (
        f"GRANT USE CATALOG ON CATALOG `{options.catalog}` TO `{principal}`",
        f"GRANT USE SCHEMA ON SCHEMA {target} TO `{principal}`",
        f"GRANT SELECT ON TABLE {target}.`adf_snapshots` TO `{principal}`",
    ):
        client.sql(statement)
    deployment = client.api(app_path + "/deployments", "POST", {
        "source_code_path": "/Workspace" + options.workspace_path + "/databricks/app",
        "mode": "SNAPSHOT",
    })
    deployment_id = deployment["deployment_id"]
    print(f"Despliegue enviado: {deployment_id}", flush=True)

    def deployed(value):
        state = value["status"]["state"]
        if state not in ("IN_PROGRESS", "SUCCEEDED"):
            raise RuntimeError(f"Despliegue {state}: {deployment_id}; revisar logs de la App.")
        return state == "SUCCEEDED"

    wait_for(lambda: client.api(app_path + "/deployments/" + quote(deployment_id, safe="")),
             deployed, f"despliegue {deployment_id}", options.timeout_seconds)

    def running(value):
        state = value.get("app_status", {}).get("state")
        if state in ("CRASHED", "FAILED") or value.get("compute_status", {}).get("state") == "ERROR":
            raise RuntimeError("La App no esta operativa; revisar logs de la App.")
        return state == "RUNNING" and value.get("compute_status", {}).get("state") == "ACTIVE"

    app = wait_for(lambda: client.api(app_path), running, "App RUNNING", options.timeout_seconds)
    notebook = client.api("/api/2.0/workspace/get-status?path="
                          + quote(options.workspace_path + "/" + NOTEBOOK, safe=""))
    if notebook.get("object_type") != "NOTEBOOK":
        raise RuntimeError("La fuente de extraccion no fue reconocida como notebook.")
    return {
        "app_url": app["url"], "deployment_id": deployment_id,
        "notebook_url": options.host + "/editor/notebooks/" + str(notebook["object_id"]),
        "tables": f"{options.catalog}.{options.schema}", "deployment_state": "SUCCEEDED",
        "app_state": "RUNNING", "uploaded_files": len(changes),
    }


def main(argv: list[str] | None = None) -> int:
    try:
        options = arguments(argv)
        files = sources(options)
        print(json.dumps({
            "mode": "APPLY" if options.apply else "LOCAL_PREVIEW",
            "host": options.host, "app": options.app_name, "warehouse": options.warehouse_id,
            "target": f"{options.catalog}.{options.schema}",
            "workspace_path": options.workspace_path, "overwrite": options.overwrite,
            "files": sorted(files), "tables": ["adf_" + suffix for suffix in SCHEMAS],
        }, indent=2))
        if not options.apply:
            print("Vista previa local: sin conexion ni validacion remota. Agregar --apply para desplegar.")
            return 0
        print("APPLY: puede iniciar el warehouse y la App, generar costos y conceder permisos.", flush=True)
        result = deploy(Client(options), options, files)
        print(json.dumps(result, indent=2))
        print("Abrir la App y cargar un snapshot para verificar SQL con la identidad de la App.")
        return 0
    except (ValueError, RuntimeError, OSError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
