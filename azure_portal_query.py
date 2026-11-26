"""JSON-only worker used by the local Node.js portal."""

import argparse
import json
import sys

from adf_api import API_VERSION, azure_json, collection, guid
from export_adf_inventory import inventory
from pipeline_history import add_history_arguments, history


def query(operation: str, subscription_id: str | None = None, resource_group: str | None = None,
          factory: str | None = None, source: str = "api", workspace_id: str | None = None,
          coverage_from: str | None = None, log_table: str = "ADFPipelineRun") -> dict:
    if operation == "subscriptions":
        accounts = azure_json(["account", "list", "--all"])
        if not isinstance(accounts, list):
            raise ValueError("Respuesta de suscripciones invalida.")
        rows = []
        for account in accounts:
            if not isinstance(account, dict):
                raise ValueError("Suscripcion invalida.")
            if account.get("state") == "Enabled":
                if not account.get("id") or not account.get("name"):
                    raise ValueError("Suscripcion sin identificador o nombre.")
                rows.append({field: account.get(field) for field in ("id", "name", "tenantId")})
        if not rows:
            raise ValueError("No hay suscripciones habilitadas. Ejecutar az login --tenant <tenant-id>.")
        return {"subscriptions": rows}
    subscription_id = guid(subscription_id or "")
    if operation == "factories":
        base = f"https://management.azure.com/subscriptions/{subscription_id}"
        rows = []
        for factory_row in collection(f"{base}/providers/Microsoft.DataFactory/factories?api-version={API_VERSION}", base):
            if not isinstance(factory_row, dict) or not factory_row.get("id") or not factory_row.get("name"):
                raise ValueError("Factory sin identificador o nombre.")
            rows.append({field: factory_row.get(field) for field in ("id", "name", "location")})
        return {"factories": rows}
    if not resource_group or not factory:
        raise ValueError("ResourceGroupName y FactoryName son obligatorios.")
    if operation == "inventory":
        return inventory(subscription_id, resource_group, factory)
    if operation == "history":
        return history(subscription_id, resource_group, factory, source, workspace_id, coverage_from, log_table)
    raise ValueError("Operacion invalida.")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--operation", required=True, choices=("subscriptions", "factories", "inventory", "history"))
    parser.add_argument("--subscription-id", type=guid)
    parser.add_argument("--resource-group-name")
    parser.add_argument("--factory-name")
    add_history_arguments(parser)
    args = parser.parse_args()
    try:
        result = query(args.operation, args.subscription_id, args.resource_group_name, args.factory_name,
                       args.source, args.workspace_id, args.coverage_from, args.log_table)
        print(json.dumps(result, ensure_ascii=True))
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=True))
        return 1


if __name__ == "__main__":
    sys.exit(main())
