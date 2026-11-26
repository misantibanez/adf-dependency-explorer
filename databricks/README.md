# ADF Dependency Explorer en Azure Databricks

Variante independiente del servidor local: **notebook Python/Spark -> tablas
Delta en Unity Catalog -> portal HTML en Databricks Apps**. No requiere
PowerShell, Azure CLI ni Node.js en el compute o en la App.

El notebook extrae y publica; la App sirve HTML interactivo y consulta un SQL
warehouse. **No se inicia un servidor web dentro del cluster** ni se abre un
puerto del driver. El despliegue inicial de la App es un paso separado,
necesario para obtener una URL independiente y autenticada.

## 1. Preparar workspace e identidades

- Importar **el repositorio completo** a un Databricks Git folder. Esta carpeta
  reutiliza los extractores Python y los motores JavaScript de su carpeta padre.
  No copiar solo el notebook.
- Usar compute con Unity Catalog, Python 3.10+ y permiso para instalar las
  dependencias de [requirements-notebook.txt](requirements-notebook.txt).
  Se recomienda un Databricks Runtime LTS compatible con las politicas del workspace.
  QuickJS-NG ejecuta el motor JavaScript en Python; no se reimplementa el grafo.
- Preparar un catalogo y un esquema **existentes**; el notebook no los crea.
  Sus nombres deben usar letras ASCII, numeros y guion bajo, sin empezar por numero.
- Crear un service principal de Entra para extraer ADF. Darle acceso de lectura
  al ADF y permiso para consultar ejecuciones si se usa historial.
  Para Log Analytics tambien requiere acceso de consulta a las tablas del
  workspace correspondiente. No se asignan permisos automaticamente.
- Guardar en un scope de Databricks Secrets las claves `tenant-id`, `client-id`
  y `client-secret`. Los nombres de las claves son configurables.
  No introducir valores secretos en widgets, archivos, Git ni variables de la App.
- La identidad que ejecuta el notebook necesita `READ` sobre ese scope,
  `USE CATALOG`, `USE SCHEMA`, `CREATE TABLE`, y `SELECT`/`MODIFY` sobre las tablas
  ya existentes. Para un Job, revisar los permisos de su identidad **Run as**.
- Permitir salida HTTPS desde el compute a `login.microsoftonline.com`,
  `management.azure.com` y, si corresponde, `api.loganalytics.azure.com`.
  La implementacion corresponde a Azure publico, no a nubes soberanas.

## 2. Ejecutar el notebook

Abrir [01_collect_adf.py](01_collect_adf.py) como notebook Databricks en el Git
folder. Ejecutar las primeras celdas para instalar dependencias, reiniciar
Python y crear los widgets; completar sus valores antes de continuar.

| Widget | Valor |
| --- | --- |
| `catalog`, `schema` | Destino de tablas Delta, por ejemplo `main` / `adf_analysis` |
| `subscription_id` | GUID de la suscripcion de ADF |
| `resource_group`, `factory_name` | Un ADF por ejecucion; no se cambia ninguna suscripcion global |
| `secret_scope` | Scope existente con las credenciales de Entra |
| `tenant_key`, `client_key`, `secret_key` | Nombres de claves; nunca sus valores |
| `history_source` | `none` (predeterminado), `api` o `loganalytics` |
| `workspace_id` | GUID del workspace Log Analytics, no ID del workspace Databricks |
| `coverage_from` | Solo logs: fecha ISO con zona horaria, por ejemplo `2026-01-01T00:00:00Z` |
| `log_table` | `ADFPipelineRun` o `AzureDiagnostics` |

El inventario incluye pipelines, datasets, linked services, IR, triggers,
data flows y managed private endpoints de todas las redes administradas.
Se conserva la proyeccion del extractor original: referencias y metadatos de
red normalizados, **sin configuraciones de conexion, secretos ni codigo**.
Un fallo de extraccion o analisis aborta la publicacion.

La API nativa cubre los ultimos 45 dias. Logs se mezcla con la API reciente
y conserva `complete=false`: no se infiere que la retencion acredita cobertura
completa. La App no confirma esa cobertura automaticamente. El limite es
50000 registros por fuente; excederlo falla sin truncar resultados.

### Tablas generadas

Todas tienen `snapshot_id` y `factory_id`. Cada ejecucion agrega un snapshot
inmutable; no sobrescribe las ejecuciones anteriores.

| Tabla | Contenido |
| --- | --- |
| `adf_snapshots` | Manifiesto publicado, fecha UTC, inventario proyectado JSON y resumen de historial JSON |
| `adf_objects` | Objetos ADF con `object_type` igual a la coleccion original y `properties_json` proyectado |
| `adf_nodes` | Nodos del grafo, incluidas actividades y referencias faltantes |
| `adf_relationships` | Origen, destino, clase de relacion y evidencia |
| `adf_metrics` | Metricas por pipeline/dataset/dataflow: consumidores, referencias, dependencias y estado estatico |
| `adf_issues` | Advertencias de calidad, referencias dinamicas y limites del analisis |
| `adf_runs` | Eventos proyectados: pipeline, ID, inicio, estado y ultima actualizacion |

`adf_runs` conserva los eventos proyectados de ambas fuentes, que pueden
repetir una ejecucion. El resumen de historial del manifiesto los consolida
con el motor original. Los campos temporales se guardan como strings ISO UTC
para conservar el contrato JSON; usar `to_timestamp` al consultar en SQL.
Sin historial, se crea la tabla de ejecuciones vacia con esquema explicito.

**Publicacion consistente:** el manifiesto se escribe al final, solo si las
otras seis escrituras terminaron. La App solo descubre snapshots publicados.
Delta no ofrece aqui una transaccion unica entre las siete tablas: un fallo
de escritura puede dejar filas huerfanas sin manifiesto; no son visibles en
la App. Al consultar resultados, unir siempre con `adf_snapshots`.
Reintentar crea un ID nuevo. No se elimina nada automaticamente; definir la
retencion y limpieza con el administrador del esquema.

Ejemplo SQL, sustituyendo catalogo y esquema:

```sql
WITH latest AS (
  SELECT snapshot_id, factory_id,
         row_number() OVER (
           PARTITION BY factory_id ORDER BY collected_at DESC, snapshot_id DESC
         ) AS position
  FROM main.adf_analysis.adf_snapshots
)
SELECT m.*
FROM main.adf_analysis.adf_metrics m
JOIN latest l ON m.snapshot_id = l.snapshot_id AND l.position = 1
WHERE m.object_type = 'pipeline' AND m.consumers = 0;
```

Sin consumidores no autoriza borrados. Las metricas persistidas son estaticas;
el portal calcula inactividad con el historial y la fecha actual para no
mantener una calificacion de inactividad obsoleta en tablas.

## 3. Desplegar el portal HTML como Databricks App

### Despliegue automatizado desde Python

[deploy.py](deploy.py) prepara las fuentes, crea el esquema y las siete tablas
si faltan, importa el notebook y sus modulos, crea o reutiliza la App, concede
los tres permisos minimos de Unity Catalog y despliega el portal.
Requiere un **catalogo y SQL warehouse existentes**; no crea clusters, Jobs,
catalogos, scopes ni secretos, ni ejecuta la extraccion de ADF.

Desde la raiz local del repositorio, con Python 3.10+ y la CLI moderna de
Databricks instalada, autenticar al usuario que realizara el despliegue:

```powershell
python -m pip install -r .\databricks\requirements-deploy.txt
databricks auth login --host "https://adb-<workspace-id>.<region>.azuredatabricks.net" --profile adf-explorer
```

El SDK reutiliza ese perfil; no pasar PAT, tokens ni secretos como argumentos.
La identidad de despliegue es distinta de las credenciales de Entra para ADF.
Necesita crear archivos y Apps, usar el warehouse, crear el esquema/tablas en
el catalogo y conceder los permisos descritos abajo. En destinos existentes,
requiere los privilegios de propietario/MANAGE correspondientes. Compartir la
App y conceder permisos al usuario/Run as del notebook sigue siendo una tarea
del administrador.

Preparar argumentos para el destino elegido; estos valores no son secretos:

```powershell
$deployArgs = @(
    "--host", "https://adb-<workspace-id>.<region>.azuredatabricks.net",
    "--profile", "adf-explorer",
    "--warehouse-id", "<warehouse-id-hexadecimal-de-16-caracteres>",
    "--catalog", "<catalogo>",
    "--schema", "adf_dependency_explorer",
    "--app-name", "adf-dependency-explorer",
    "--workspace-path", "/Shared/adf-dependency-explorer"
)

# Vista previa local: no autentica, consulta ni modifica recursos.
python .\databricks\deploy.py @deployArgs

# Aplicar: puede iniciar el warehouse y la App y generar costos.
python .\databricks\deploy.py @deployArgs --apply
if ($LASTEXITCODE -ne 0) { throw "Fallo el despliegue; revisar el error anterior." }
```

El comando usa una lista explicita de 21 archivos. No sube el resto del
repositorio, inventarios, configuracion local, credenciales ni entornos
virtuales. Inyecta catalogo/esquema en las fuentes enviadas sin modificar los
archivos locales; copia los motores canonicos directamente en el payload.
La vista previa solo valida entradas y fuentes locales: **no acredita
permisos, disponibilidad ni ausencia de conflictos remotos**.

Al aplicar, revisa los tipos/esquemas de tablas existentes y compara todas las
fuentes remotas antes de escribir. Omite archivos identicos. Si encuentra
codigo distinto, aborta sin modificar recursos; revisar las diferencias y,
solo si se acepta reemplazarlo, ejecutar:

```powershell
python .\databricks\deploy.py @deployArgs --apply --overwrite
```

**`--overwrite` reemplaza tambien las celdas que se hayan agregado al notebook
remoto**, incluidas celdas de diagnostico. Guardar esos cambios primero o usar
otra carpeta dedicada. No cambia un recurso `sql-warehouse` incompatible en
una App existente: corregirlo manualmente o elegir otra App.
No elimina ni reemplaza tablas o snapshots. Las operaciones no son una
transaccion: un fallo puede dejar recursos creados o archivos actualizados.
Corregir la causa y reintentar con los mismos parametros; no ejecutar dos
despliegues simultaneos sobre el mismo destino. Si una consulta supera el
timeout, puede continuar en el warehouse; revisar Query History antes de
reintentar. `--timeout-seconds` controla la espera por operacion (1200 por
defecto), no la duracion total del comando.

Solo termina con exito despues de observar deployment `SUCCEEDED`, compute
`ACTIVE`, App `RUNNING` y el notebook reconocido como tal. Imprime las URL de
App y notebook. Abrir la App con una sesion autorizada y cargar un snapshot
para verificar la consulta SQL **con la identidad de la App**: los estados de
la plataforma no sustituyen esa prueba. Completar los widgets de ADF/Secrets
y ejecutar el notebook para crear el primer snapshot.

### Alternativa manual

1. La ultima celda del notebook ejecuta [prepare_app.py](prepare_app.py), que
   copia los motores canonicos `graph.js` e `history.js` dentro de
   [app/static/](app/static/). Ejecutarla tambien despues de actualizar esos motores.
   Alternativa desde la raiz local: `python .\databricks\prepare_app.py`.
2. Editar [app/app.yaml](app/app.yaml): reemplazar `CHANGE_ME` en `ADF_CATALOG`
   y `ADF_SCHEMA` por el mismo destino usado en el notebook.
3. En **Compute > Apps**, crear una App y agregar un recurso **SQL warehouse**,
   con permiso **Can use** y clave `sql-warehouse`. `valueFrom` inyectara su ID;
   no escribir PAT ni credenciales manualmente.
4. Copiar el service principal de la App desde su pestana **Authorization**.
   Es una identidad **distinta** del service principal de Entra usado por el notebook.
   Concederle unicamente lo necesario:

   ```sql
   GRANT USE CATALOG ON CATALOG main TO `<app-service-principal>`;
   GRANT USE SCHEMA ON SCHEMA main.adf_analysis TO `<app-service-principal>`;
   GRANT SELECT ON TABLE main.adf_analysis.adf_snapshots TO `<app-service-principal>`;
   ```

   Reemplazar los identificadores por los reales. La App solo necesita leer
   el manifiesto: alli estan el inventario proyectado y el historial resumido.
   No necesita permisos sobre los secretos de ADF ni escritura en tablas.
5. Desplegar usando **`databricks/app` como carpeta de codigo fuente**, no la
   raiz del repositorio. Databricks instala
   [app/requirements.txt](app/requirements.txt) y ejecuta
   [app/app.py](app/app.py) con el puerto asignado por Apps.
6. Abrir la URL HTTPS de la App, compartirla solo con los usuarios autorizados
   mediante los permisos de Databricks Apps y pulsar **Cargar snapshot**.

La App usa OAuth de su propia identidad mediante el SDK de Databricks y SQL
Connector, no la identidad del visitante. **Todos los usuarios autorizados
de esta App pueden ver todos los snapshots que su service principal puede
leer**. Usar esquemas/Apps separados si se requiere aislamiento entre equipos;
esta variante no implementa filtros por usuario ni autorizacion delegada.
No exponer el proceso Flask directamente fuera del proxy autenticado de Apps.

El portal permite explorar objetos y grafo, revisar evidencia y advertencias,
ver metricas e historial, seleccionar pipelines, simular impacto y descargar
el reporte JSON. No incluye selector Azure en vivo, carga de credenciales,
importacion local de inventarios ni operaciones de borrado.
El mapa limita la vista a 120 nodos; el analisis usa el inventario completo.
Limites explicitos: inventario hasta 30 MB y lista de hasta 1000 factories.

Para nuevas extracciones, programar el notebook como **Databricks Job**
con sus parametros. No se necesita redesplegar la App por cada snapshot;
solo actualizar la lista y cargar los nuevos datos. La App, el SQL warehouse
y el compute de Jobs pueden generar costos mientras esten activos.

## 4. Pruebas y limites de validacion

Desde la raiz del repositorio, en un entorno de pruebas:

```powershell
python -m pip install -r .\databricks\requirements-notebook.txt -r .\databricks\app\requirements.txt
python -B -m unittest discover -s .\databricks\tests -p "test_*.py" -v
python -B -m unittest discover -s .\tests -p "test_python.py" -v
```

Las pruebas usan HTTP, Spark y SQL simulados; comparan el motor embebido con
Node.js (solo requerido para esa prueba de paridad). No crean recursos ni
requieren secretos. Para probar solo la automatizacion, sin instalar las
dependencias del notebook ni de la App:

```powershell
python -B -m unittest discover -s .\databricks\tests -p "test_deploy.py" -v
```

Antes de produccion, verificar en el workspace real:
instalacion de dependencias en el Runtime elegido, permisos de ADF/Secrets/UC,
escritura Delta, conexion OAuth al warehouse y acceso al portal por usuarios
autorizados. Una validacion local no acredita esos permisos ni un despliegue.

Referencias oficiales:

- [Configurar Apps con app.yaml](https://learn.microsoft.com/azure/databricks/dev-tools/databricks-apps/app-runtime)
- [Autorizacion de Databricks Apps](https://learn.microsoft.com/azure/databricks/dev-tools/databricks-apps/auth)
- [Recurso SQL warehouse](https://learn.microsoft.com/azure/databricks/dev-tools/databricks-apps/sql-warehouse)
- [Databricks Secrets](https://learn.microsoft.com/azure/databricks/security/secrets/)
