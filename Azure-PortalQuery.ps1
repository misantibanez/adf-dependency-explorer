#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('subscriptions', 'factories', 'inventory', 'history')][string]$Operation,
    [guid]$SubscriptionId,
    [string]$ResourceGroupName,
    [string]$FactoryName,
    [ValidateSet('api', 'loganalytics')][string]$Source = 'api',
    [guid]$WorkspaceId,
    [string]$CoverageFrom,
    [ValidateSet('ADFPipelineRun', 'AzureDiagnostics')][string]$LogTable = 'ADFPipelineRun'
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'AdfApi.ps1')
try {
    if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
        throw 'Azure CLI no esta instalado. Instalarlo y ejecutar az login.'
    }
    if ($Operation -eq 'subscriptions') {
        $text = & az account list --all --only-show-errors --output json
        if ($LASTEXITCODE -ne 0) { throw 'No se pudieron listar suscripciones. Ejecutar az login en el tenant correcto.' }
        $accounts = ($text -join "`n") | ConvertFrom-Json -AsHashtable -NoEnumerate
        if ($accounts -isnot [array]) { throw 'Respuesta de suscripciones invalida.' }
        $rows = @($accounts | Where-Object { $_.state -eq 'Enabled' } | ForEach-Object {
            if (-not $_.id -or -not $_.name) { throw 'Suscripcion sin identificador o nombre.' }
            @{ id = $_.id; name = $_.name; tenantId = $_.tenantId }
        })
        if (-not $rows.Count) { throw 'No hay suscripciones habilitadas en la sesion. Ejecutar az login --tenant <tenant-id>.' }
        @{ subscriptions = $rows } | ConvertTo-Json -Depth 10
    } elseif ($Operation -eq 'factories') {
        $base = "https://management.azure.com/subscriptions/$SubscriptionId"
        $rows = Get-AdfCollection -Url "$base/providers/Microsoft.DataFactory/factories?api-version=2018-06-01" -FactoryBase $base
        $factories = @($rows | ForEach-Object {
            if (-not $_.id -or -not $_.name) { throw 'Factory sin identificador o nombre.' }
            @{ id = $_.id; name = $_.name; location = $_.location }
        })
        @{ factories = $factories } | ConvertTo-Json -Depth 10
    } elseif ($Operation -eq 'history') {
        $historyParams = @{ Source = $Source; SubscriptionId = $SubscriptionId; ResourceGroupName = $ResourceGroupName; FactoryName = $FactoryName }
        if ($Source -eq 'loganalytics') {
            $historyParams.WorkspaceId = $WorkspaceId
            $historyParams.CoverageFrom = $CoverageFrom
            $historyParams.LogTable = $LogTable
        }
        & (Join-Path $PSScriptRoot 'Pipeline-History.ps1') @historyParams
    } else {
        & (Join-Path $PSScriptRoot 'Export-AdfInventory.ps1') -SubscriptionId $SubscriptionId `
            -ResourceGroupName $ResourceGroupName -FactoryName $FactoryName -AsJson 6>$null
    }
} catch {
    @{ error = $_.Exception.Message } | ConvertTo-Json -Compress
    exit 1
}
