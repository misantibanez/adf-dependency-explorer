"""Shared read-only Azure CLI transport for the Python ADF scripts."""

import json
import re
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import Protocol
from urllib.parse import quote, unquote, urlsplit
from uuid import UUID

API_VERSION = "2018-06-01"


class AzureRequest(Protocol):
    def __call__(self, args: list[str], body: dict | None = None) -> object: ...


def azure_json(args: list[str], body: dict | None = None) -> object:
    executable = shutil.which("az")
    if not executable:
        raise RuntimeError("Azure CLI no esta instalado. Instalarlo y ejecutar az login.")
    body_path = None
    try:
        if body is not None:
            with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", suffix=".json", delete=False) as stream:
                body_path = Path(stream.name)
                json.dump(body, stream, ensure_ascii=True)
            args = [*args, "--headers", "Content-Type=application/json", "--body", f"@{body_path}"]
        result = subprocess.run(
            [executable, *args, "--only-show-errors", "--output", "json"],
            capture_output=True, encoding="utf-8", timeout=290, check=False,
        )
        if result.returncode:
            # CLI diagnostics can contain raw response bodies; do not forward them to the portal.
            raise RuntimeError("Fallo Azure CLI. Revisar az login, tenant y permisos de consulta.")
        return json.loads(result.stdout)
    except subprocess.TimeoutExpired as error:
        raise RuntimeError("Azure CLI excedio el tiempo permitido.") from error
    except json.JSONDecodeError as error:
        raise RuntimeError("Azure CLI no devolvio JSON valido.") from error
    finally:
        if body_path is not None:
            body_path.unlink()


def guid(value: str) -> str:
    if not re.fullmatch(r"[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}", value):
        raise ValueError("Identificador GUID invalido.")
    return str(UUID(value))


def factory_id(subscription_id: str, resource_group: str, factory: str) -> str:
    subscription_id = guid(subscription_id)
    if not resource_group.strip() or not factory.strip():
        raise ValueError("ResourceGroupName y FactoryName son obligatorios.")
    return f"/subscriptions/{subscription_id}/resourceGroups/{resource_group}/providers/Microsoft.DataFactory/factories/{factory}"


def factory_base(subscription_id: str, resource_group: str, factory: str) -> str:
    return "https://management.azure.com" + factory_id(
        subscription_id, quote(resource_group, safe=""), quote(factory, safe="")
    )


def collection(url: str, scope: str, *, request: AzureRequest | None = None) -> list:
    request = request or azure_json
    items: list = []
    seen: set[str] = set()
    base = urlsplit(scope)
    while url:
        uri = urlsplit(url)
        if (uri.scheme != "https" or uri.hostname != base.hostname or uri.port not in (None, 443)
                or uri.username is not None or uri.password is not None
                or not uri.path.lower().startswith(base.path.lower() + "/")
                or any(segment in (".", "..") for segment in unquote(uri.path).split("/"))
                or uri.fragment):
            raise ValueError("nextLink fuera del ambito solicitado. Lectura cancelada.")
        if url in seen:
            raise ValueError("nextLink circular. Lectura cancelada.")
        seen.add(url)
        response = request(["rest", "--method", "get", "--url", url])
        if not isinstance(response, dict) or not isinstance(response.get("value"), list):
            raise ValueError("Respuesta invalida: se esperaba una lista value.")
        items.extend(response["value"])
        url = response.get("nextLink")
        if url is not None and not isinstance(url, str):
            raise ValueError("nextLink invalido.")
    return items


def add_factory_arguments(parser) -> None:
    parser.add_argument("--subscription-id", required=True, type=guid)
    parser.add_argument("--resource-group-name", required=True)
    parser.add_argument("--factory-name", required=True)
