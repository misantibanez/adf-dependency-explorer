# Databricks notebook source
# MAGIC %md
# MAGIC # ADF Dependency Explorer -> Delta -> Databricks Apps
# MAGIC Ejecutar desde un Git folder que contenga el repositorio completo.
# MAGIC Los secretos se leen del scope; nunca se escriben en widgets ni tablas.
# MAGIC La app se despliega una vez por separado; cada ejecucion publica un nuevo snapshot.

# COMMAND ----------

# MAGIC %pip install -r requirements-notebook.txt

# COMMAND ----------

dbutils.library.restartPython()

# COMMAND ----------

import sys
from functools import partial
from pathlib import Path

HERE = Path.cwd()
if not (HERE / "azure_rest.py").exists():
    raise RuntimeError("Ejecutar este notebook desde la carpeta databricks del Git folder.")
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(HERE))

from adf_api import collection, factory_id
from export_adf_inventory import inventory
from pipeline_history import history
from analysis import analyze
from azure_rest import AzureRest
from delta_store import namespace, publish
from prepare_app import prepare

for name, default in {
    "catalog": "", "schema": "", "subscription_id": "", "resource_group": "", "factory_name": "",
    "secret_scope": "", "tenant_key": "tenant-id", "client_key": "client-id", "secret_key": "client-secret",
    "workspace_id": "", "coverage_from": "",
}.items():
    dbutils.widgets.text(name, default)
dbutils.widgets.dropdown("history_source", "none", ["none", "api", "loganalytics"])
dbutils.widgets.dropdown("log_table", "ADFPipelineRun", ["ADFPipelineRun", "AzureDiagnostics"])

# COMMAND ----------

params = {name: dbutils.widgets.get(name).strip() for name in (
    "catalog", "schema", "subscription_id", "resource_group", "factory_name", "secret_scope",
    "tenant_key", "client_key", "secret_key", "history_source", "workspace_id", "coverage_from", "log_table",
)}
for name in ("catalog", "schema", "subscription_id", "resource_group", "factory_name", "secret_scope",
             "tenant_key", "client_key", "secret_key"):
    if not params[name]:
        raise ValueError(f"Completar el widget {name} antes de continuar.")
target = namespace(params["catalog"], params["schema"])
factory_id(params["subscription_id"], params["resource_group"], params["factory_name"])
spark.sql(f"DESCRIBE SCHEMA {target}").collect()

client = AzureRest(
    dbutils.secrets.get(scope=params["secret_scope"], key=params["tenant_key"]),
    dbutils.secrets.get(scope=params["secret_scope"], key=params["client_key"]),
    dbutils.secrets.get(scope=params["secret_scope"], key=params["secret_key"]),
)
factory_args = (params["subscription_id"], params["resource_group"], params["factory_name"])
snapshot = inventory(*factory_args, read_collection=partial(collection, request=client))
raw_history = None
if params["history_source"] != "none":
    raw_history = history(
        *factory_args, params["history_source"], params["workspace_id"] or None,
        params["coverage_from"] or None, params["log_table"], request=client,
    )
result = analyze(snapshot, raw_history)
snapshot_id = publish(spark, params["catalog"], params["schema"], snapshot, result, raw_history)
print(f"Snapshot publicado: {snapshot_id}")

# COMMAND ----------

from pyspark.sql import functions as F

for suffix in ("metrics", "issues"):
    display(spark.table(f"{target}.`adf_{suffix}`").where(F.col("snapshot_id") == snapshot_id))

# COMMAND ----------

app_source = prepare()
print(f"Codigo de Databricks Apps preparado en: {app_source}")
print("Configurar catalogo/esquema en app.yaml y desplegar esta carpeta desde Compute > Apps.")
print("La app lee snapshots publicados; para actualizar ADF, volver a ejecutar este notebook como Job.")
