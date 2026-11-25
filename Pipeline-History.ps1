#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('api', 'loganalytics')][string]$Source,
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][string]$ResourceGroupName,
    [Parameter(Mandatory)][string]$FactoryName,
    [guid]$WorkspaceId,
    [string]$CoverageFrom,
    [ValidateSet('ADFPipelineRun', 'AzureDiagnostics')][string]$LogTable = 'ADFPipelineRun'
)
$ErrorActionPreference = 'Stop'
$factoryId = "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroupName/providers/Microsoft.DataFactory/factories/$FactoryName"
$to = [DateTimeOffset]::UtcNow
$from = $to.AddDays(-45)
if ($Source -eq 'loganalytics') {
    $from = [DateTimeOffset]::Parse($CoverageFrom).ToUniversalTime()
    if ($from -ge $to -or $from -lt $to.AddYears(-10)) { throw 'Cobertura Log Analytics fuera del intervalo permitido (hasta 10 anos).' }
    if ($WorkspaceId -eq [guid]::Empty) { throw 'Workspace ID requerido.' }
}
$temp = Join-Path ([IO.Path]::GetTempPath()) ('adf-history-' + [guid]::NewGuid() + '.json')
$rows = [System.Collections.Generic.List[object]]::new()
try {
    if ($Source -eq 'api') {
        $url = 'https://management.azure.com/subscriptions/{0}/resourceGroups/{1}/providers/Microsoft.DataFactory/factories/{2}/queryPipelineRuns?api-version=2018-06-01' -f `
            $SubscriptionId, [uri]::EscapeDataString($ResourceGroupName), [uri]::EscapeDataString($FactoryName)
        $seen = [System.Collections.Generic.HashSet[string]]::new()
        $continuation = $null
        do {
            $body = @{ lastUpdatedAfter = $from.ToString('o'); lastUpdatedBefore = $to.ToString('o') }
            if ($continuation) { $body.continuationToken = $continuation }
            $body | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $temp -Encoding utf8NoBOM
            $text = & az rest --method post --url $url --headers 'Content-Type=application/json' --body "@$temp" --only-show-errors --output json
            if ($LASTEXITCODE -ne 0) { throw 'Fallo queryPipelineRuns. Revisar autenticacion y permiso Microsoft.DataFactory/factories/queryPipelineRuns/action.' }
            $response = ($text -join "`n") | ConvertFrom-Json -AsHashtable
            if ($response.value -isnot [array]) { throw 'Respuesta de ejecuciones invalida.' }
            foreach ($run in $response.value) {
                $rows.Add(@{ pipelineName = $run.pipelineName; runId = $run.runId; runStart = $run.runStart; status = $run.status; lastUpdated = $run.lastUpdated })
            }
            if ($rows.Count -gt 50000) { throw 'Historial supera 50000 ejecuciones. No se devuelve un historial parcial.' }
            $continuation = $response.continuationToken
            if ($continuation -and -not $seen.Add($continuation)) { throw 'Paginacion de ejecuciones circular.' }
        } while ($continuation)
    } else {
        # Values are validated by the local server; escaping also protects a quoted resource-group name.
        $resource = $factoryId.Replace("'", "''")
        $projection = if ($LogTable -eq 'ADFPipelineRun') {
            '| project pipelineName=PipelineName, runId=RunId, runStart=Start, status=Status, lastUpdated=TimeGenerated'
        } else {
            '| where Category == "PipelineRuns" | project pipelineName=PipelineName_s, runId=tostring(RunId_g), runStart=todatetime(Start_t), status=Status_s, lastUpdated=TimeGenerated'
        }
        $query = "$LogTable | where _ResourceId =~ '$resource' | where TimeGenerated between (datetime($($from.ToString('o'))) .. datetime($($to.ToString('o')))) $projection | summarize arg_max(lastUpdated, *) by pipelineName, runId | take 50001"
        @{ query = $query } | ConvertTo-Json | Set-Content -LiteralPath $temp -Encoding utf8NoBOM
        $url = "https://api.loganalytics.azure.com/v1/workspaces/$WorkspaceId/query"
        $text = & az rest --method post --url $url --resource 'https://api.loganalytics.io' --headers 'Content-Type=application/json' --body "@$temp" --only-show-errors --output json
        if ($LASTEXITCODE -ne 0) { throw 'Fallo Log Analytics. Revisar Workspace ID, tabla, tenant y permisos de consulta.' }
        $response = ($text -join "`n") | ConvertFrom-Json -AsHashtable
        if ($response.error -or -not $response.tables -or $response.tables.Count -ne 1) { throw 'Log Analytics devolvio un error o resultado parcial.' }
        $table = $response.tables[0]
        $columns = @($table.columns | ForEach-Object { $_.name })
        foreach ($name in @('pipelineName', 'runId', 'runStart', 'status', 'lastUpdated')) {
            if ($name -notin $columns) { throw "Log Analytics no devolvio la columna $name." }
        }
        if ($table.rows.Count -ge 50001) { throw 'Log Analytics supera 50000 ejecuciones. Consulta cancelada, sin resultados parciales.' }
        foreach ($values in $table.rows) {
            $run = @{}
            for ($i = 0; $i -lt $columns.Count; $i++) { $run[$columns[$i]] = $values[$i] }
            $rows.Add($run)
        }
        # Native history fills the ingestion-delay window and checks queued/running attempts.
        $recentText = & $PSCommandPath -Source api -SubscriptionId $SubscriptionId -ResourceGroupName $ResourceGroupName -FactoryName $FactoryName
        $recent = ($recentText -join "`n") | ConvertFrom-Json -AsHashtable
        foreach ($run in $recent.runs) { $rows.Add($run) }
        $to = [DateTimeOffset]::Parse($recent.to)
    }
    @{ factoryId = $factoryId; source = $Source; from = $from.ToString('o'); to = $to.ToString('o');
        complete = ($Source -eq 'api'); runs = $rows.ToArray() } | ConvertTo-Json -Depth 20 -WarningAction Stop
} finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
}
