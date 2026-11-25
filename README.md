# Explorador local de dependencias ADF

Portal HTML offline y extractor de metadatos, solo lectura. No ejecuta borrados,
no envia datos a terceros y no requiere Databricks para comenzar.

## Seleccionar un ADF real desde el portal

Requisitos: **Node.js**, **PowerShell 7**, **Azure CLI** y permisos de lectura.
Desde la carpeta del proyecto:

```powershell
az login --tenant "<tenant-id-donde-esta-el-ADF>"
node .\server.js
```

Abrir **http://127.0.0.1:8765** (no el archivo HTML):

1. Pulsar **Cargar suscripciones**.
2. Elegir la suscripcion de la sesion de Azure CLI.
3. Elegir el **ADF**, identificado tambien por grupo de recursos y region.
4. Pulsar **Analizar ADF**. Al completar todas las lecturas, el grafo cambia
   de la demo al inventario real y muestra factory, origen y fecha de extraccion.
5. Buscar pipelines y evaluar su borrado como en la demo. Para actualizar,
   pulsar de nuevo **Analizar ADF**.

No hace login automaticamente ni cambia la suscripcion predeterminada de CLI.
Si falta el tenant del cliente, autenticarse en ese tenant desde la terminal y
volver a cargar suscripciones. Solo aparecen suscripciones habilitadas de esa
sesion y factories visibles con sus permisos. La demo permanece hasta analizar
un ADF; seleccionar un nombre no significa que el grafo ya corresponda a el.
Errores conservan el grafo anterior y muestran una advertencia explicita.

El navegador llama solo al servidor local. El servidor consulta Azure via
PowerShell/Azure CLI, reutiliza el mismo extractor y la misma proyeccion de
metadatos. No devuelve tokens Azure ni guarda inventarios en el servidor.
Se mantiene una sola consulta a la vez; limite de cinco minutos/40 MB por consulta.
No se instala ninguna dependencia npm ni se despliega nada en Azure.

El servidor escucha exclusivamente en `127.0.0.1`, verifica Host/origen y exige
un token efimero de sesion para consultas; no permite CORS, comandos arbitrarios,
rutas de archivos fuera del portal ni operaciones de escritura en Azure.
**Es una herramienta personal local**, no un servidor multiusuario: otros
procesos/usuarios del equipo pueden acceder al loopback. No exponerlo por
proxy, tuneles ni en un equipo compartido sin controles adicionales. Para
uso compartido se requiere autenticacion y autorizacion por usuario.
Detener con **Ctrl+C** al terminar.

Si el puerto esta ocupado, elegir otro antes de arrancar:

```powershell
$env:PORT = "8766"
node .\server.js
```

Abrir `http://127.0.0.1:8766`. No utilizar `localhost` como alias: la comprobacion
de Host acepta la direccion exacta anunciada por el servidor.

## Probar el portal

Abrir [index.html](index.html) con Edge o Chrome. No necesita servidor, npm ni
instalaciones. Arranca con una **demo ficticia**, no con datos reales.

1. Buscar `Pipeline_B` y hacer clic en su nombre.
2. Ver que `Pipeline_A` y `Pipeline_C` lo invocan; la llamada de C esta dentro
   de un ForEach. Explorar actividades, datasets, data flows, servicios e IR.
3. Marcar B: el reporte advierte que A y C estan fuera de la seleccion.
4. Marcar A y B: C sigue bloqueando B, y el trigger diario sigue referenciando A.
5. Seleccionar `Pipeline_Independiente`: aparece **requiere revision** porque
   hay una referencia dinamica en otra parte de la factory.

Las flechas representan `consumidor -> objeto utilizado`. No representan
`dependsOn` ni la secuencia de ejecucion de actividades. Buscar un objeto no
filtra el inventario utilizado para evaluar el borrado.

Se puede pegar una lista de nombres (lineas, comas o punto y coma), seleccionar
pipelines mediante casillas y exportar el reporte JSON para revision.
Los nombres se comparan sin distinguir mayusculas/minusculas.

## Pagina de metricas de objetos

Desde el explorador pulsar **Metricas de objetos**. La pagina
[metrics.html](metrics.html) muestra el **mismo inventario cargado**, sea demo,
JSON importado o ADF real:

- Filtro **Tipo de objeto**: pipelines, datasets o data flows.
- Total de objetos existentes del tipo seleccionado (excluye referencias a objetos no encontrados).
- Objetos con consumidores directos y sin consumidores conocidos, con porcentaje.
- Candidatos sin bloqueos estaticos y objetos sin consumidores que requieren
  revision por advertencias globales.
- Tabla filtrable: numero de consumidores distintos, numero de referencias
  entrantes y objetos utilizados transitivamente (sin contar actividades).
- **Ver dependencias** vuelve al explorador y enfoca el objeto. Si es un pipeline,
  tambien lo selecciona para evaluar su borrado individual.
- **Copiar nombres sin consumidores** copia toda esa lista del tipo seleccionado,
  no solo los resultados de busqueda/estado. Los nombres de pipelines pueden
  pegarse en la evaluacion de conjuntos; los datasets y data flows se revisan
  individualmente en el grafo (la evaluacion de conjuntos solo admite pipelines).

Los indicadores se recalculan al cambiar de tipo, considerando consumidores
de **cualquier tipo**: por ejemplo, un dataset utilizado por un data flow no es
un candidato sin consumidores, aunque ningun pipeline lo referencie directamente.
Cambiar el tipo limpia la busqueda y el mensaje de copia, pero mantiene el filtro
de estado. No cambia la factory ni consulta Azure de nuevo.

Un pipeline puede **usar** datasets u otros pipelines sin que ningun objeto
lo **use**. La candidatura se basa en no tener referencias **entrantes**.
Triggers detenidos, referencias de un pipeline a si mismo y ciclos tambien
cuentan como consumidores. Multiples actividades del mismo pipeline cuentan
como un consumidor, pero se muestran sus referencias por separado.
Las advertencias dinamicas/incompletas impiden clasificar como candidato sin
bloqueos estaticos cualquier objeto sin consumidores.

**No se garantiza que se pueda eliminar.** Los pipelines
de entrada pueden no tener consumidores ADF y aun ejecutarse manualmente o desde
aplicaciones externas. Validar uso, propietarios y ejecuciones antes de borrar.

El grafo reducido (nombres, relaciones, advertencias y origen/fecha, sin
definiciones crudas ni tokens) se comparte mediante `sessionStorage` de la
pestana. Se conserva al navegar entre paginas o recargar, no en el servidor.
Mantener la misma pestana y el mismo origen/puerto. Cerrar la pestana elimina
normalmente esa sesion; no abrir el portal con restauracion automatica de
sesiones en equipos compartidos. Si se supera la cuota o se bloquea el
almacenamiento, se muestra un error: recargar/importar desde el explorador.
El modo `file:` puede restringir compartir almacenamiento entre archivos;
para esta funcionalidad se recomienda el servidor local HTTP.

La pagina de metricas solo consulta Azure al cargar el historial. Para actualizar
las definiciones, regresar al explorador y pulsar **Analizar ADF**.

### Ultima ejecucion y umbral de inactividad

Seleccionar **Pipelines**, elegir una fuente y pulsar **Cargar historial**.
El parametro inicial es **1 mes**; admite 1 a 120 meses calendario, en UTC,
ajustando finales de mes (31 de marzo menos un mes = 28/29 de febrero).
La fecha igual al corte cuenta como reciente. Se cuentan todos los intentos,
incluidos fallidos y cancelados, no solo los exitosos.

La tabla muestra **ultima ejecucion observada** (inicio), estado y clasificacion:
historial no cargado, insuficiente/desactualizado, reciente, activo/en cola,
o sin ejecuciones observadas desde el corte. Un pipeline solo se marca como
**candidato a revision por inactividad** si no tiene consumidores ni advertencias
estaticas, no hay intentos activos observados, y el historial es completo,
cubre desde el corte hasta su fecha final y no tiene mas de 24 horas de antiguedad.
El contador, filtro y boton **Copiar candidatos por inactividad** usan ese
criterio combinado. No reemplazan la revision humana ni ejecutan borrados.

**Sin registros no significa "nunca ejecutado"**: la ultima fecha se mantiene
desconocida. Si hay cobertura completa suficiente, solo se afirma ausencia
de ejecuciones observadas en el periodo. Una fecha antigua con cobertura
insuficiente no alcanza para marcar un candidato. Los consumidores siguen
bloqueando aunque su pipeline tenga ejecuciones antiguas.

| Fuente | Requisitos y alcance |
| --- | --- |
| API de ADF | Servidor local, `az login` y permiso `Microsoft.DataFactory/factories/queryPipelineRuns/action` (Reader de definiciones puede no bastar). Consulta los ultimos **45 dias** mediante POST de solo lectura; recorre todos los continuationToken. Un umbral de 3 meses queda como historial insuficiente. |
| CSV | Archivo local; definir desde/hasta y confirmar que pertenece al ADF cargado e incluye todas las ejecuciones del intervalo, sin filtros ni huecos. No se envia el archivo a Azure. |
| Log Analytics | Workspace ID GUID, tabla ADFPipelineRun o AzureDiagnostics, fecha desde la cual diagnosticos/retencion conservan todo el historial, confirmacion de cobertura y permisos de consulta del workspace. Requiere tambien permiso de API ADF: se mezcla historial nativo reciente para cubrir hasta 15 minutos de demora de ingesta y detectar intentos activos/en cola. Si falla cualquiera de las consultas, no se marca con resultados parciales. |
| Tablas de Databricks | Visible pero **deshabilitada**, pendiente de implementar. |

Los diagnosticos deben haber estado habilitados durante el periodo requerido:
habilitarlos hoy **no recupera historia anterior**. No se habilitan diagnosticos
ni se crean recursos. Una consulta vacia no acredita por si sola completitud,
retencion ni ausencia de huecos: el usuario debe verificarlo y confirmar.
Sin confirmacion, CSV/Log Analytics muestran fechas pero no califican candidatos.
En modo legacy se requieren las columnas PipelineName_s, RunId_g, Start_t,
Status_s y _ResourceId; otro esquema devuelve un error explicito.

CSV con encabezados (coma o punto y coma, BOM/comillas permitidos):

```csv
pipelineName,runId,runStart,status,lastUpdated
Pipeline_A,run-001,2026-09-01T08:00:00Z,Failed,2026-09-01T08:04:00Z
Pipeline_B,run-002,2026-11-01T08:00:00Z,Succeeded,2026-11-01T08:05:00Z
```

Columnas obligatorias: pipelineName, runId, runStart, status. lastUpdated es
opcional para un registro por intento y se asume igual al inicio si falta.
Para multiples eventos del mismo intento, incluir lastUpdated: se conserva
el estado mas actualizado. Un intento Queued sin inicio requiere lastUpdated.
Fechas ISO 8601 con zona obligatoria; estados: Queued, InProgress, Succeeded,
Failed, Canceling/Cancelled (se admiten variantes Cancelling/Canceled).
Las filas pueden incluir ejecuciones anteriores al inicio de cobertura para
informar la ultima fecha conocida. No incluir parametros/secretos. Limite CSV:
30 MB; consultas Azure: 50000 ejecuciones, con error explicito si se excede.
Los pipelines historicos no presentes en el inventario se cuentan aparte.

La fuente se acota a la identidad completa del ADF del inventario:
suscripcion, grupo y factory. La demo o un JSON sin esa identidad no admiten
historial real; usar **Analizar ADF** o importar el JSON del extractor.
CSV no contiene identidad verificable: la confirmacion del usuario acredita
que corresponde a ese ADF. No combinar archivos de distintas factories.
Solo se conserva el resumen minimo por pipeline y el umbral elegido en sessionStorage, asociado
al inventario/fecha de extraccion; no los registros originales, run IDs,
parametros, workspace ni tokens. Recargar otra extraccion requiere nuevo
historial. Un error de actualizacion invalida los candidatos previos.

Las metricas de datasets/data flows conservan su analisis estatico. No se
inventan fechas de ejecucion para ellos; este historial solo aplica a pipelines.

## Extraer de las APIs propias de ADF

Requisitos: **PowerShell 7**, **Azure CLI**, sesion `az login` en el tenant
correcto y permisos de lectura de la factory y sus recursos hijos.
Reader en el ambito de la factory es una opcion; no se necesita Contributor.
El extractor admite Azure publico (`management.azure.com`), no nubes soberanas.

```powershell
az login
.\Export-AdfInventory.ps1 `
  -SubscriptionId "<GUID-de-la-suscripcion>" `
  -ResourceGroupName "<resource-group>" `
  -FactoryName "<nombre-adf>" `
  -OutputPath ".\adf-inventory-2026-11-25.json"
```

Luego usar **Importar inventario JSON** en el portal.

El script hace exclusivamente `az rest --method get`, con API `2018-06-01`:

| Coleccion | Ruta bajo `/factories/{factoryName}` |
| --- | --- |
| Pipelines | `/pipelines` |
| Datasets | `/datasets` |
| Linked services | `/linkedservices` |
| Integration runtimes | `/integrationRuntimes` |
| Triggers | `/triggers` |
| Data flows | `/dataflows` |

Recorre todas las paginas `nextLink`. Un error de permisos, de respuesta o de
paginacion cancela la exportacion; no convierte errores en listas vacias. Solo
guarda el archivo al completar las seis colecciones y no sobrescribe archivos.
Las lecturas son secuenciales, **no un snapshot transaccional**: conviene
extraer en una ventana sin publicaciones/cambios y repetir antes de un borrado.

La exportacion conserva nombres, tipos, estructura de actividades y referencias
tipadas. No conserva tokens, connection strings, passwords, bodies de Web
activities, parametros de negocio, codigo SQL/notebooks ni scripts de data
flows. Las expresiones de nombres dinamicos se sustituyen por un marcador de
revision. Los nombres de objetos, factory, suscripcion y grupo tambien pueden
ser informacion interna: guardar el JSON y los reportes en un lugar autorizado.
No importar definiciones crudas con secretos ni distribuir inventarios reales.

El repositorio contiene solo codigo, documentacion y pruebas ficticias.
Los inventarios/reportes JSON, CSV de ejecuciones, configuracion local y
credenciales se excluyen mediante `.gitignore`; las unicas excepciones JSON
son las dos fixtures de pruebas. Mantener los datos reales fuera del repositorio,
especialmente si es publico.

## Relaciones y alcance

- Pipeline -> actividad, incluyendo ForEach, Until, IfCondition y Switch.
- Actividad -> otro pipeline (ExecutePipeline).
- Actividad -> datasets (Copy, Lookup, GetMetadata, Delete, etc., cuando hay
  referencias tipadas), linked services, data flows e IR explicitos.
- Dataset -> linked service.
- Linked service -> IR cuando existe `connectVia`.
- Data flow -> datasets/linked services mediante referencias tipadas.
- Trigger -> pipeline, incluso triggers detenidos: el estado no elimina la referencia.
- Referencias no encontradas quedan como nodos punteados y generan advertencias.
- `AutoResolveIntegrationRuntime` se reconoce como runtime implicito si esta
  referenciado aunque no aparezca en la lista. **No** se inventa un IR para
  linked services sin `connectVia`, ni se afirma que este grafo identifique el
  runtime realmente utilizado por cada ejecucion de Copy.

Para el objeto enfocado se muestran consumidores y dependencias directos y
transitivos, con control de direccion y profundidad. El mapa limita la
visualizacion a 180 nodos para mantenerlo utilizable; **el reporte evalua todo
el inventario**, sin ese limite. Importacion limitada a 30 MB.

## Evaluacion de borrado por conjunto

- **Bloqueado**: hay una referencia directa desde un pipeline no seleccionado,
  un trigger u otro objeto fuera del conjunto. Muestra actividad y ruta JSON.
- **Dentro de la seleccion**: la referencia no bloquea por si sola el borrado
  conjunto; el consumidor debe retirarse primero.
- **Impacto transitivo**: muestra los pipelines/triggers que alcanzan el objeto,
  diferenciandolos de los bloqueos directos.
- **Requiere revision**: existen referencias dinamicas, tipos de referencia
  desconocidos, objetos faltantes, colecciones incompletas o codigo no analizado.
  Las advertencias son globales: un invocador dinamico podria usar cualquier
  pipeline, aunque no aparezca conectado al objeto enfocado.
- **Sin bloqueos estaticos detectados**: ausencia de bloqueos en estas definiciones,
  **nunca autorizacion de borrado**.
- Si no hay bloqueos externos, calcula orden estructural consumidor-antes-que-
  dependencia. Los ciclos impiden un orden simple y requieren retirar referencias.

No determina uso real ni inactividad. Quedan fuera llamadas desde otras factories,
REST/Web activities, Functions, notebooks, aplicaciones, Logic Apps, codigo,
scripts de data flows y ejecuciones en curso. Tampoco inspecciona borradores
no publicados en Git, endpoints privados, tablas/vistas fisicas de Databricks,
lineage de columnas ni dependencias SQL. La completitud declarada por un JSON
importado es informacion de su productor, no una comprobacion en Azure.

Antes de eliminar: actualizar el inventario, revisar los consumidores externos
y dinamicos, validar con propietarios, revisar ejecuciones, retirar referencias
y volver a extraer. Hacer backup/versionado y tramitar el cambio por el proceso
habitual. El portal deliberadamente no tiene boton de eliminacion.

## Formato y pruebas

Formato admitido: `schemaVersion: 1`, `metadata` y `collections` con las seis
colecciones. Cada coleccion es una lista de `{name, properties}` o una respuesta
REST `{value: [...]}` ya completa. `metadata.completeness` debe contener `true`
por coleccion para evitar la advertencia de completitud desconocida.
[demo.js](demo.js) ilustra las definiciones y referencias.

```powershell
node --test .\tests\graph.test.js .\tests\server.test.js .\tests\inventory-session.test.js .\tests\history.test.js
pwsh -NoProfile -File .\tests\export.test.ps1
pwsh -NoProfile -File .\tests\history.test.ps1
```

Las pruebas del extractor, historial y servidor simulan Azure CLI/las consultas: no acceden a Azure.
No se ha verificado conectividad ni permisos con una factory real.
La interfaz se valido con importacion valida/invalida, busqueda, seleccion por
lote, selector suscripcion/ADF, carga desde un backend simulado, conservacion
del grafo ante fallo de actualizacion y generacion del contenido del reporte.
Las metricas se validaron con demo e inventario importado, filtros por tipo y estado, recarga,
contenido de la lista copiada y retorno al pipeline sin perder la factory.
El historial incluye pruebas de meses calendario, cobertura, estados activos,
CSV, paginacion, proyeccion minima, errores parciales y aislamiento entre ADFs.
El navegador integrado no notifico
la descarga del archivo; probar **Exportar reporte** en Edge/Chrome normal.

## Referencias oficiales

- [Pipelines - List By Factory](https://learn.microsoft.com/en-us/rest/api/datafactory/pipelines/list-by-factory?view=rest-datafactory-2018-06-01)
- [Datasets - List By Factory](https://learn.microsoft.com/en-us/rest/api/datafactory/datasets/list-by-factory?view=rest-datafactory-2018-06-01)
- [Linked Services - List By Factory](https://learn.microsoft.com/en-us/rest/api/datafactory/linked-services/list-by-factory?view=rest-datafactory-2018-06-01)
- [Integration Runtimes - List By Factory](https://learn.microsoft.com/en-us/rest/api/datafactory/integration-runtimes/list-by-factory?view=rest-datafactory-2018-06-01)
- [Triggers - List By Factory](https://learn.microsoft.com/en-us/rest/api/datafactory/triggers/list-by-factory?view=rest-datafactory-2018-06-01)
- [Data Flows - List By Factory](https://learn.microsoft.com/en-us/rest/api/datafactory/data-flows/list-by-factory?view=rest-datafactory-2018-06-01)
- [Conceptos de integration runtime](https://learn.microsoft.com/en-us/azure/data-factory/concepts-integration-runtime)
- [Historial de ejecuciones y retencion de 45 dias](https://learn.microsoft.com/en-us/azure/data-factory/monitor-programmatically)
- [Pipeline Runs - Query By Factory](https://learn.microsoft.com/en-us/rest/api/datafactory/pipeline-runs/query-by-factory?view=rest-datafactory-2018-06-01)
- [Configurar diagnosticos ADF](https://learn.microsoft.com/en-us/azure/data-factory/monitor-configure-diagnostics)
- [Tabla ADFPipelineRun](https://learn.microsoft.com/en-us/azure/azure-monitor/reference/tables/adfpipelinerun)
