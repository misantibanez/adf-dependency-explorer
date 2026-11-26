# Databricks notebook source
# MAGIC %md
# MAGIC # ADF Dependency Explorer -> Delta -> Databricks Apps
# MAGIC Ejecutar desde un Git folder que contenga el repositorio completo.
# MAGIC Los secretos se leen del scope; nunca se escriben en widgets ni tablas.
# MAGIC La app se despliega una vez por separado; cada ejecucion publica un nuevo snapshot.
# MAGIC Completar los widgets antes de continuar. Para preparar Secrets, esquema y permisos
# MAGIC usar setup_mode=true de forma interactiva; para ejecuciones normales o Jobs dejar false.

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

from adf_api import collection, factory_id, guid
from export_adf_inventory import inventory
from pipeline_history import history
from analysis import analyze
from azure_rest import AzureRest
from delta_store import namespace, publish
from prepare_app import prepare

for name, default in {
    "catalog": "", "schema": "", "subscription_id": "", "resource_group": "", "factory_name": "",
    "secret_scope": "", "tenant_key": "tenant-id", "client_key": "client-id", "secret_key": "client-secret",
    "workspace_id": "", "coverage_from": "", "app_name": "",
}.items():
    dbutils.widgets.text(name, default)
dbutils.widgets.dropdown("history_source", "none", ["none", "api", "loganalytics"])
dbutils.widgets.dropdown("log_table", "ADFPipelineRun", ["ADFPipelineRun", "AzureDiagnostics"])
dbutils.widgets.dropdown("setup_mode", "false", ["false", "true"])

# COMMAND ----------

# MAGIC %md
# MAGIC ## Preparacion opcional del workspace
# MAGIC Con setup_mode=true se crea el scope si falta y se solicitan solo las claves
# MAGIC ausentes mediante entrada oculta. Requiere permisos de creacion/escritura.
# MAGIC No pegar credenciales en el codigo ni habilitar este modo en Jobs.
# MAGIC Los scopes respaldados por Key Vault se administran desde Key Vault.

# COMMAND ----------

setup_mode = dbutils.widgets.get("setup_mode") == "true"
scope_name = dbutils.widgets.get("secret_scope").strip()

if setup_mode:
    from databricks.sdk import WorkspaceClient

    if not scope_name:
        raise ValueError("Completar secret_scope antes de preparar el workspace.")
    w = WorkspaceClient()
    existing_scopes = {scope.name.lower() for scope in w.secrets.list_scopes()}
    if scope_name.lower() not in existing_scopes:
        w.secrets.create_scope(scope=scope_name)
        print("Scope creado.")
    else:
        print("El scope ya existe; se conserva.")
else:
    print("Preparacion omitida: se usaran Secrets y esquema existentes.")

# COMMAND ----------

import getpass
import warnings


def registrar_claves_faltantes():
    keys = [dbutils.widgets.get(name).strip() for name in ("tenant_key", "client_key", "secret_key")]
    if not all(keys) or len({key.lower() for key in keys}) != 3:
        raise ValueError("Configurar tres nombres de clave distintos y no vacios.")
    existing = {secret.key.lower() for secret in w.secrets.list_secrets(scope=scope_name)}
    for key in keys:
        if key.lower() in existing:
            print(f"{key}: ya existe; no se modifica.")
            continue
        with warnings.catch_warnings():
            warnings.simplefilter("error", getpass.GetPassWarning)
            value = getpass.getpass(f"Introduce {key}: ")
        if not value:
            raise ValueError(f"No se guardo {key}: valor vacio.")
        try:
            w.secrets.put_secret(scope=scope_name, key=key, string_value=value)
        finally:
            value = None
        print(f"{key}: guardado.")


if setup_mode:
    registrar_claves_faltantes()

# COMMAND ----------

if setup_mode:
    print("Scopes disponibles:")
    for scope in dbutils.secrets.listScopes():
        print(scope.name)
    print("Claves disponibles:")
    for secret in dbutils.secrets.list(scope_name):
        print(secret.key)

# COMMAND ----------

if setup_mode:
    setup_target = namespace(dbutils.widgets.get("catalog").strip(), dbutils.widgets.get("schema").strip())
    spark.sql(f"CREATE SCHEMA IF NOT EXISTS {setup_target}").collect()
    display(spark.sql(f"DESCRIBE SCHEMA {setup_target}"))

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

# COMMAND ----------

# MAGIC %md
# MAGIC ## Permisos opcionales para la App
# MAGIC Despues de crear la App desde Compute > Apps, completar app_name y ejecutar
# MAGIC esta celda con setup_mode=true. Si se acaba de cambiar ese modo, ejecutar
# MAGIC primero la celda que inicializa WorkspaceClient.
# MAGIC Se usa service_principal_client_id obtenido de la App: no el OAuth App ID
# MAGIC ni el App ID mostrado en Overview. La App no recibe acceso a Secrets.

# COMMAND ----------

app_name = dbutils.widgets.get("app_name").strip()
if setup_mode and app_name:
    app_info = w.apps.get(app_name)
    if not app_info.service_principal_client_id:
        raise RuntimeError("La identidad de la App aun no esta disponible; esperar y reintentar.")
    app_principal = guid(app_info.service_principal_client_id)
    app_catalog = dbutils.widgets.get("catalog").strip()
    app_target = namespace(app_catalog, dbutils.widgets.get("schema").strip())
    for statement in (
        f"GRANT USE CATALOG ON CATALOG `{app_catalog}` TO `{app_principal}`",
        f"GRANT USE SCHEMA ON SCHEMA {app_target} TO `{app_principal}`",
        f"GRANT SELECT ON TABLE {app_target}.`adf_snapshots` TO `{app_principal}`",
    ):
        spark.sql(statement).collect()
    print("Permisos de lectura concedidos al service principal de la App.")
else:
    print("Permisos App no ejecutados: requieren setup_mode=true y app_name de una App existente.")
