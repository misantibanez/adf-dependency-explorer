"""Export the same projected inventory as Export-AdfInventory.ps1."""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable
from urllib.parse import quote

from adf_api import API_VERSION, add_factory_arguments, collection, factory_base

COLLECTIONS = ("pipelines", "datasets", "linkedservices", "integrationRuntimes", "triggers", "dataflows")


def timestamp() -> str:
    return datetime.now(timezone.utc).isoformat()


def resource_id(value: object) -> str | None:
    if isinstance(value, str):
        value = value.strip().rstrip("/")
        if re.fullmatch(
            r"/subscriptions/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/resourceGroups/[^/?#@]+"
            r"/providers/[^/?#@\s]+(?:/[^/?#@]+/[^/?#@]+)+", value, re.I
        ):
            return value
    return None


def network_host(value: object) -> str | None:
    if not isinstance(value, str) or "@{" in value:
        return None
    text = re.sub(r"^tcp:", "", value.strip(), flags=re.I)
    match = re.fullmatch(
        r"(?:https?://)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?"
        r"(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)\.?(?::\d+|,\d+)?(?:[/?#].*)?", text, re.I
    )
    if not match:
        return None
    return re.sub(
        r"\.privatelink\.(?=(?:blob|dfs|file|queue|table|web)\.core\.windows\.net$|database\.windows\.net$)",
        ".", match[1].lower()
    )


def dependency_metadata(value: object) -> dict | list | None:
    if isinstance(value, dict):
        kind = value.get("type")
        if isinstance(kind, str) and kind.endswith("Reference"):
            name = value.get("referenceName")
            if not isinstance(name, str) or name.startswith("@") or "@{" in name:
                name = {"type": "Expression"}
            return {"type": kind, "referenceName": name}
        clean = {}
        for key, child in value.items():
            if key in ("script", "scriptLines"):
                clean["uninspectedScript"] = True
            elif key == "linkedInfo":
                clean["uninspectedLinkedInfo"] = True
            elif key in ("name", "type", "activity", "runtimeState") and isinstance(child, str):
                clean[key] = child
            elif isinstance(child, (dict, list)):
                projected = dependency_metadata(child)
                if projected is not None:
                    clean[key] = projected
        return clean or None
    if isinstance(value, list):
        return [projected for child in value if (projected := dependency_metadata(child)) is not None]
    return None


def valid_row(row: object, kind: str) -> dict:
    if (not isinstance(row, dict) or not isinstance(row.get("name"), str)
            or not row["name"].strip() or not isinstance(row.get("properties"), dict)):
        raise ValueError(f"Objeto invalido en {kind}. Exportacion cancelada.")
    return row


def hosts(values) -> list[str]:
    return list(dict.fromkeys(host for value in values if (host := network_host(value))))


def inventory(subscription_id: str, resource_group: str, factory: str, *,
              read_collection: Callable[[str, str], list] | None = None) -> dict:
    read_collection = read_collection or collection
    base = factory_base(subscription_id, resource_group, factory)
    started = timestamp()
    collections = {}
    for kind in COLLECTIONS:
        clean_rows = []
        for raw in read_collection(f"{base}/{kind}?api-version={API_VERSION}", base):
            row = valid_row(raw, kind)
            properties = dependency_metadata(row["properties"])
            if not isinstance(properties, dict):
                properties = {}
            if kind == "linkedservices":
                source = row["properties"]
                settings = source.get("typeProperties")
                settings = settings if isinstance(settings, dict) else {}
                properties["networkHosts"] = hosts(settings.get(field) for field in (
                    "url", "serviceEndpoint", "baseUrl", "server", "host", "endpoint", "accountEndpoint", "sasUri"
                ))
                if rid := resource_id(source.get("resourceId")):
                    properties["resourceId"] = rid
                if rid := resource_id(settings.get("resourceId")):
                    properties.setdefault("typeProperties", {})["resourceId"] = rid
            clean_rows.append({"name": row["name"], "properties": properties})
        collections[kind] = clean_rows
    endpoints = []
    for network in read_collection(f"{base}/managedVirtualNetworks?api-version={API_VERSION}", base):
        if (not isinstance(network, dict) or not isinstance(network.get("name"), str)
                or not re.fullmatch(r"[_A-Za-z0-9][-_\w]{0,126}", network["name"])):
            raise ValueError("Managed virtual network invalida. Exportacion cancelada.")
        network_base = f"{base}/managedVirtualNetworks/{quote(network['name'], safe='')}"
        for raw in read_collection(f"{network_base}/managedPrivateEndpoints?api-version={API_VERSION}", network_base):
            row = valid_row(raw, "managedPrivateEndpoints")
            source = row["properties"]
            fqdns = source.get("fqdns", [])
            if not isinstance(fqdns, list):
                raise ValueError("Lista fqdns invalida.")
            properties = {"managedVirtualNetworkName": network["name"], "networkHosts": hosts(fqdns)}
            if rid := resource_id(source.get("privateLinkResourceId")):
                properties["privateLinkResourceId"] = rid
            for field in ("groupId", "provisioningState"):
                if isinstance(source.get(field), str):
                    properties[field] = source[field]
            state = source.get("connectionState")
            if isinstance(state, dict) and isinstance(state.get("status"), str):
                properties["connectionState"] = {"status": state["status"]}
            endpoints.append({"name": f"{network['name']}/{row['name']}", "properties": properties})
    collections["managedPrivateEndpoints"] = endpoints
    return {
        "schemaVersion": 1,
        "metadata": {
            "factoryName": factory, "subscriptionId": subscription_id, "resourceGroupName": resource_group,
            "source": "ADF REST API / definiciones publicadas",
            "collectionStartedAt": started, "exportedAt": timestamp(), "apiVersion": API_VERSION,
            "completeness": dict.fromkeys(collections, True),
            "projection": "Nombres, tipos, estructura de actividades y referencias. Sin configuracion de conexiones ni codigo.",
        },
        "collections": collections,
    }


def write_inventory(snapshot: dict, output: Path) -> None:
    text = json.dumps(snapshot, ensure_ascii=True, indent=2)
    with output.open("x", encoding="utf-8") as stream:
        stream.write(text)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    add_factory_arguments(parser)
    parser.add_argument("--output-path", type=Path, default=Path(__file__).with_name("adf-inventory.json"))
    parser.add_argument("--as-json", action="store_true")
    args = parser.parse_args()
    try:
        snapshot = inventory(args.subscription_id, args.resource_group_name, args.factory_name)
        if args.as_json:
            print(json.dumps(snapshot, ensure_ascii=True))
        else:
            write_inventory(snapshot, args.output_path)
            print(f"Inventario exportado: {args.output_path.resolve()}")
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
