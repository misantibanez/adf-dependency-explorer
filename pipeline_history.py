"""Read ADF pipeline history from the API or Log Analytics without raw parameters."""

import argparse
import json
import sys
from datetime import datetime, timedelta, timezone

from adf_api import API_VERSION, AzureRequest, add_factory_arguments, azure_json, factory_base, factory_id, guid

RUN_FIELDS = ("pipelineName", "runId", "runStart", "status", "lastUpdated")
MAX_RUNS = 50000


def history(subscription_id: str, resource_group: str, factory: str, source: str = "api",
            workspace_id: str | None = None, coverage_from: str | None = None,
            log_table: str = "ADFPipelineRun", *, request: AzureRequest | None = None) -> dict:
    request = request or azure_json
    fid = factory_id(subscription_id, resource_group, factory)
    base = factory_base(subscription_id, resource_group, factory)
    to = datetime.now(timezone.utc)
    start = to - timedelta(days=45)
    rows = []
    if source == "api":
        seen = set()
        continuation = None
        while True:
            body = {"lastUpdatedAfter": start.isoformat(), "lastUpdatedBefore": to.isoformat()}
            if continuation:
                body["continuationToken"] = continuation
            response = request(
                ["rest", "--method", "post", "--url", f"{base}/queryPipelineRuns?api-version={API_VERSION}"], body
            )
            if not isinstance(response, dict) or not isinstance(response.get("value"), list):
                raise ValueError("Respuesta de ejecuciones invalida.")
            for run in response["value"]:
                if not isinstance(run, dict):
                    raise ValueError("Ejecucion invalida.")
                rows.append({field: run.get(field) for field in RUN_FIELDS})
            if len(rows) > MAX_RUNS:
                raise ValueError("Historial supera 50000 ejecuciones. No se devuelve un historial parcial.")
            continuation = response.get("continuationToken")
            if continuation is None or continuation == "":
                break
            if not isinstance(continuation, str) or continuation in seen:
                raise ValueError("Paginacion de ejecuciones circular o invalida.")
            seen.add(continuation)
    elif source == "loganalytics":
        workspace = guid(workspace_id or "")
        start = datetime.fromisoformat((coverage_from or "").replace("Z", "+00:00"))
        if start.tzinfo is None:
            raise ValueError("CoverageFrom requiere zona horaria.")
        start = start.astimezone(timezone.utc)
        oldest = to.replace(year=to.year - 10, day=min(to.day, 28)) if to.month == 2 else to.replace(year=to.year - 10)
        if not oldest <= start < to:
            raise ValueError("Cobertura Log Analytics fuera del intervalo permitido (hasta 10 anos).")
        if log_table not in ("ADFPipelineRun", "AzureDiagnostics"):
            raise ValueError("Tabla Log Analytics invalida.")
        resource = fid.replace("'", "''")
        projection = (
            "| project pipelineName=PipelineName, runId=RunId, runStart=Start, status=Status, lastUpdated=TimeGenerated"
            if log_table == "ADFPipelineRun" else
            '| where Category == "PipelineRuns" | project pipelineName=PipelineName_s, runId=tostring(RunId_g), '
            "runStart=todatetime(Start_t), status=Status_s, lastUpdated=TimeGenerated"
        )
        query = (
            f"{log_table} | where _ResourceId =~ '{resource}' "
            f"| where TimeGenerated between (datetime({start.isoformat()}) .. datetime({to.isoformat()})) "
            f"{projection} | summarize arg_max(lastUpdated, *) by pipelineName, runId | take 50001"
        )
        response = request(
            ["rest", "--method", "post", "--url",
             f"https://api.loganalytics.azure.com/v1/workspaces/{workspace}/query",
             "--resource", "https://api.loganalytics.io"], {"query": query}
        )
        if (not isinstance(response, dict) or response.get("error")
                or not isinstance(response.get("tables"), list) or len(response["tables"]) != 1):
            raise ValueError("Log Analytics devolvio un error o resultado parcial.")
        table = response["tables"][0]
        if (not isinstance(table, dict) or not isinstance(table.get("columns"), list)
                or not isinstance(table.get("rows"), list)):
            raise ValueError("Tabla Log Analytics invalida.")
        columns = [column.get("name") if isinstance(column, dict) else None for column in table["columns"]]
        if (not all(isinstance(name, str) and name for name in columns)
                or not all(field in columns for field in RUN_FIELDS) or len(set(columns)) != len(columns)):
            raise ValueError("Log Analytics no devolvio las columnas requeridas.")
        if len(table["rows"]) > MAX_RUNS:
            raise ValueError("Log Analytics supera 50000 ejecuciones. Consulta cancelada, sin resultados parciales.")
        for values in table["rows"]:
            if not isinstance(values, list) or len(values) != len(columns):
                raise ValueError("Fila Log Analytics invalida.")
            rows.append({field: values[columns.index(field)] for field in RUN_FIELDS})
        recent = history(subscription_id, resource_group, factory, request=request)
        rows.extend(recent["runs"])
        to = datetime.fromisoformat(recent["to"])
    else:
        raise ValueError("Fuente de historial invalida.")
    return {"factoryId": fid, "source": source, "from": start.isoformat(), "to": to.isoformat(),
            "complete": source == "api", "runs": rows}


def add_history_arguments(parser) -> None:
    parser.add_argument("--source", choices=("api", "loganalytics"), default="api")
    parser.add_argument("--workspace-id", type=guid)
    parser.add_argument("--coverage-from")
    parser.add_argument("--log-table", choices=("ADFPipelineRun", "AzureDiagnostics"), default="ADFPipelineRun")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    add_factory_arguments(parser)
    add_history_arguments(parser)
    args = parser.parse_args()
    try:
        print(json.dumps(history(args.subscription_id, args.resource_group_name, args.factory_name,
                                 args.source, args.workspace_id, args.coverage_from, args.log_table)))
        return 0
    except (OSError, ValueError, RuntimeError) as error:
        print(f"Error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
