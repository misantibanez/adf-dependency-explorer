#requires -Version 7.0
[CmdletBinding()]
param(
    [Parameter(Mandatory)][guid]$SubscriptionId,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$ResourceGroupName,
    [Parameter(Mandatory)][ValidateNotNullOrEmpty()][string]$FactoryName,
    [string]$OutputPath = (Join-Path $PSScriptRoot 'adf-inventory.json'),
    [switch]$AsJson
)
$ErrorActionPreference = 'Stop'

. (Join-Path $PSScriptRoot 'AdfApi.ps1')

function Select-DependencyMetadata {
    param($Value)
    if ($null -eq $Value) { return $null }
    if ($Value -is [System.Collections.IDictionary]) {
        if ($Value.type -is [string] -and $Value.type.EndsWith('Reference')) {
            $name = $Value.referenceName
            if ($name -isnot [string] -or $name.StartsWith('@') -or $name.Contains('@{')) {
                $name = @{ type = 'Expression' }
            }
            return @{ type = $Value.type; referenceName = $name }
        }
        $clean = [ordered]@{}
        foreach ($key in $Value.Keys) {
            if ($key -in @('script', 'scriptLines')) {
                $clean.uninspectedScript = $true
            } elseif ($key -eq 'linkedInfo') {
                $clean.uninspectedLinkedInfo = $true
            } elseif ($key -in @('name', 'type', 'activity', 'runtimeState') -and $Value[$key] -is [string]) {
                $clean[$key] = $Value[$key]
            } elseif ($Value[$key] -is [System.Collections.IDictionary] -or $Value[$key] -is [array]) {
                $child = Select-DependencyMetadata $Value[$key]
                if ($null -ne $child) { $clean[$key] = $child }
            }
        }
        if ($clean.Count) { return $clean }
        return $null
    }
    if ($Value -is [array]) {
        $clean = [System.Collections.Generic.List[object]]::new()
        foreach ($child in $Value) {
            $result = Select-DependencyMetadata $child
            if ($null -ne $result) { $clean.Add($result) }
        }
        return ,$clean.ToArray()
    }
    return $null
}

if (-not (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI no esta instalado. Instalarlo y ejecutar az login antes de exportar.'
}
$factoryBase = 'https://management.azure.com/subscriptions/{0}/resourceGroups/{1}/providers/Microsoft.DataFactory/factories/{2}' -f `
    $SubscriptionId, [uri]::EscapeDataString($ResourceGroupName), [uri]::EscapeDataString($FactoryName)
$endpoints = [ordered]@{
    pipelines = 'pipelines'; datasets = 'datasets'; linkedservices = 'linkedservices'
    integrationRuntimes = 'integrationRuntimes'; triggers = 'triggers'; dataflows = 'dataflows'
}
$inventory = [ordered]@{}
$completeness = [ordered]@{}
$startedAt = [DateTime]::UtcNow.ToString('o')
foreach ($key in $endpoints.Keys) {
    Write-Host "Leyendo $key..."
    $url = "$factoryBase/$($endpoints[$key])?api-version=2018-06-01"
    $rows = Get-AdfCollection -Url $url -FactoryBase $factoryBase
    $cleanRows = [System.Collections.Generic.List[object]]::new()
    foreach ($row in $rows) {
        if ($row.name -isnot [string] -or -not $row.name.Trim() -or
            $row.properties -isnot [System.Collections.IDictionary]) {
            throw "Objeto invalido en $key. Exportacion cancelada."
        }
        $properties = Select-DependencyMetadata $row.properties
        if ($null -eq $properties) { $properties = @{} }
        $cleanRows.Add(@{ name = $row.name; properties = $properties })
    }
    $inventory[$key] = $cleanRows.ToArray()
    $completeness[$key] = $true
}
$snapshot = [ordered]@{
    schemaVersion = 1
    metadata = [ordered]@{
        factoryName = $FactoryName; subscriptionId = $SubscriptionId.ToString()
        resourceGroupName = $ResourceGroupName; source = 'ADF REST API / definiciones publicadas'
        collectionStartedAt = $startedAt; exportedAt = [DateTime]::UtcNow.ToString('o')
        apiVersion = '2018-06-01'; completeness = $completeness
        projection = 'Nombres, tipos, estructura de actividades y referencias. Sin configuracion de conexiones ni codigo.'
    }
    collections = $inventory
}
$json = $snapshot | ConvertTo-Json -Depth 100 -WarningAction Stop
if ($AsJson) { Write-Output $json; return }
$resolvedOutput = [IO.Path]::GetFullPath($OutputPath)
if (Test-Path -LiteralPath $resolvedOutput) {
    throw "El archivo ya existe: $resolvedOutput. Elegir otro OutputPath para preservar el inventario anterior."
}
# CreateNew also protects an existing file if another process creates it after the check.
$stream = [IO.File]::Open($resolvedOutput, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
$writer = [IO.StreamWriter]::new($stream, [Text.UTF8Encoding]::new($false))
try { $writer.Write($json) } finally { $writer.Dispose() }
Write-Host "Inventario exportado: $resolvedOutput"
