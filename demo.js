window.AdfDemo = {
  schemaVersion: 1,
  metadata: {
    factoryName: "adf-demo-dependencias", source: "DEMO - datos ficticios",
    exportedAt: "2026-11-25T17:00:00Z",
    completeness: { pipelines: true, datasets: true, linkedservices: true,
      integrationRuntimes: true, triggers: true, dataflows: true, managedPrivateEndpoints: true }
  },
  collections: {
    managedPrivateEndpoints: [
      { name: "default/MPE_Lake_Blob", properties: { managedVirtualNetworkName: "default", groupId: "blob",
        privateLinkResourceId: "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-demo/providers/Microsoft.Storage/storageAccounts/lakedemo",
        provisioningState: "Succeeded", connectionState: { status: "Approved" } } },
      { name: "default/MPE_SQL", properties: { managedVirtualNetworkName: "default", groupId: "sqlServer",
        privateLinkResourceId: "/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-demo/providers/Microsoft.Sql/servers/sqldemo",
        provisioningState: "Succeeded", connectionState: { status: "Pending" } } }
    ],
    pipelines: [
      { name: "Pipeline_A", properties: { activities: [
        { name: "Copiar_clientes", type: "Copy",
          inputs: [{ type: "DatasetReference", referenceName: "DS_Clientes_SQL" }],
          outputs: [{ type: "DatasetReference", referenceName: "DS_Clientes_Lake" }] },
        { name: "Ejecutar_B", type: "ExecutePipeline", typeProperties: {
          pipeline: { type: "PipelineReference", referenceName: "Pipeline_B" } } }
      ] } },
      { name: "Pipeline_B", properties: { activities: [
        { name: "Transformar", type: "ExecuteDataFlow", typeProperties: {
          dataflow: { type: "DataFlowReference", referenceName: "DF_Clientes" },
          integrationRuntime: { type: "IntegrationRuntimeReference", referenceName: "IR_Azure" } } }
      ] } },
      { name: "Pipeline_C", properties: { activities: [
        { name: "Procesar_lotes", type: "ForEach", typeProperties: { activities: [
          { name: "Ejecutar_B_anidado", type: "ExecutePipeline", typeProperties: {
            pipeline: { type: "PipelineReference", referenceName: "Pipeline_B" } } }
        ] } }
      ] } },
      { name: "Pipeline_Independiente", properties: { activities: [{ name: "Pausa", type: "Wait" }] } },
      { name: "Pipeline_Dinamico", properties: { activities: [
        { name: "Elegir_pipeline", type: "ExecutePipeline", typeProperties: {
          pipeline: { type: "PipelineReference", referenceName: { type: "Expression", value: "@pipeline().parameters.destino" } } } }
      ] } }
    ],
    datasets: [
      { name: "DS_Clientes_SQL", properties: { type: "AzureSqlTable", linkedServiceName: {
        type: "LinkedServiceReference", referenceName: "LS_SQL" } } },
      { name: "DS_Clientes_Lake", properties: { type: "Parquet", linkedServiceName: {
        type: "LinkedServiceReference", referenceName: "LS_Lake" } } }
    ],
    linkedservices: [
      { name: "LS_SQL", properties: { type: "AzureSqlDatabase", typeProperties: {
        server: "tcp:sqldemo.database.windows.net,1433" }, connectVia: {
        type: "IntegrationRuntimeReference", referenceName: "IR_OnPrem" } } },
      { name: "LS_Lake", properties: { type: "AzureBlobFS", typeProperties: {
        url: "https://lakedemo.dfs.core.windows.net" }, connectVia: {
        type: "IntegrationRuntimeReference", referenceName: "AutoResolveIntegrationRuntime" } } }
    ],
    integrationRuntimes: [
      { name: "IR_OnPrem", properties: { type: "SelfHosted" } },
      { name: "IR_Azure", properties: { type: "Managed" } }
    ],
    triggers: [{ name: "TR_Diario", properties: { type: "ScheduleTrigger", runtimeState: "Started",
      pipelines: [{ pipelineReference: { type: "PipelineReference", referenceName: "Pipeline_A" } }] } }],
    dataflows: [{ name: "DF_Clientes", properties: { type: "MappingDataFlow", typeProperties: {
      sources: [{ dataset: { type: "DatasetReference", referenceName: "DS_Clientes_Lake" } }],
      sinks: [{ dataset: { type: "DatasetReference", referenceName: "DS_Clientes_Lake" } }]
    } } }]
  }
};
