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

function Select-ResourceId {
    param($Value)
    if ($Value -is [string]) {
        $id = $Value.Trim().TrimEnd('/')
        if ($id -match '^/subscriptions/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/resourceGroups/[^/?#@]+/providers/[^/?#@\s]+(?:/[^/?#@]+/[^/?#@]+)+$') {
            return $id
        }
    }
}

function Select-NetworkHost {
    param($Value)
    if ($Value -is [string] -and -not $Value.Contains('@{')) {
        $text = $Value.Trim() -replace '^tcp:', ''
        if ($text -match '^(?:https?://)?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)\.?(?::\d+|,\d+)?(?:[/?#].*)?$') {
            return $Matches[1].ToLowerInvariant() -replace '\.privatelink\.(?=(?:blob|dfs|file|queue|table|web)\.core\.windows\.net$|database\.windows\.net$)', '.'
        }
    }
}

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
        if ($key -eq 'linkedservices') {
            $hosts = @(
                if ($row.properties.typeProperties -is [System.Collections.IDictionary]) {
                    foreach ($field in @('url', 'serviceEndpoint', 'baseUrl', 'server', 'host', 'endpoint', 'accountEndpoint', 'sasUri')) {
                        Select-NetworkHost $row.properties.typeProperties[$field]
                    }
                }
            ) | Select-Object -Unique
            $properties.networkHosts = @($hosts | Where-Object { $_ -is [string] })
            $resourceId = Select-ResourceId $row.properties.resourceId
            if ($resourceId) { $properties.resourceId = $resourceId }
            $resourceId = Select-ResourceId $row.properties.typeProperties.resourceId
            if ($resourceId) {
                if (-not $properties.Contains('typeProperties')) { $properties.typeProperties = @{} }
                $properties.typeProperties.resourceId = $resourceId
            }
        }
        $cleanRows.Add(@{ name = $row.name; properties = $properties })
    }
    $inventory[$key] = $cleanRows.ToArray()
    $completeness[$key] = $true
}
$privateEndpoints = [System.Collections.Generic.List[object]]::new()
Write-Host 'Leyendo managedVirtualNetworks y managedPrivateEndpoints...'
$networks = Get-AdfCollection -Url "$factoryBase/managedVirtualNetworks?api-version=2018-06-01" -FactoryBase $factoryBase
foreach ($network in $networks) {
    if ($network.name -isnot [string] -or $network.name -notmatch '^[_A-Za-z0-9][-_\w]{0,126}$') {
        throw 'Managed virtual network invalida. Exportacion cancelada.'
    }
    $networkBase = "$factoryBase/managedVirtualNetworks/$([uri]::EscapeDataString($network.name))"
    $rows = Get-AdfCollection -Url "$networkBase/managedPrivateEndpoints?api-version=2018-06-01" -FactoryBase $networkBase
    foreach ($row in $rows) {
        if ($row.name -isnot [string] -or -not $row.name.Trim() -or $row.properties -isnot [System.Collections.IDictionary]) {
            throw 'Managed private endpoint invalido. Exportacion cancelada.'
        }
        $properties = @{ managedVirtualNetworkName = $network.name }
        $hosts = @(foreach ($fqdn in $row.properties.fqdns) { Select-NetworkHost $fqdn }) | Select-Object -Unique
        $properties.networkHosts = @($hosts | Where-Object { $_ -is [string] })
        $resourceId = Select-ResourceId $row.properties.privateLinkResourceId
        if ($resourceId) { $properties.privateLinkResourceId = $resourceId }
        foreach ($field in @('groupId', 'provisioningState')) {
            if ($row.properties[$field] -is [string]) { $properties[$field] = $row.properties[$field] }
        }
        if ($row.properties.connectionState.status -is [string]) {
            $properties.connectionState = @{ status = $row.properties.connectionState.status }
        }
        $privateEndpoints.Add(@{ name = "$($network.name)/$($row.name)"; properties = $properties })
    }
}
$inventory.managedPrivateEndpoints = $privateEndpoints.ToArray()
$completeness.managedPrivateEndpoints = $true
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
