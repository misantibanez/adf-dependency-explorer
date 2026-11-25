#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'Pipeline-History.ps1'
$global:AdfHistoryMock = @{ mode = 'api'; calls = [System.Collections.Generic.List[object]]::new(); tempPaths = [System.Collections.Generic.List[string]]::new() }
function Assert($Condition, [string]$Message) { if (-not $Condition) { throw "ASSERT: $Message" } }
function az {
    $method = $args[[array]::IndexOf($args, '--method') + 1]
    $url = $args[[array]::IndexOf($args, '--url') + 1]
    $file = $args[[array]::IndexOf($args, '--body') + 1].Substring(1)
    $body = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json -AsHashtable
    $global:AdfHistoryMock.calls.Add(@{ method = $method; url = $url; body = $body })
    $global:AdfHistoryMock.tempPaths.Add($file)
    $global:LASTEXITCODE = 0
    if ($global:AdfHistoryMock.mode -eq 'denied') { $global:LASTEXITCODE = 1; return }
    if ($url -like '*api.loganalytics.azure.com*') {
        if ($global:AdfHistoryMock.mode -eq 'partial') { return '{"error":{"code":"PartialError"},"tables":[]}' }
        $columns = @('pipelineName', 'runId', 'runStart', 'status', 'lastUpdated') | ForEach-Object { @{ name = $_; type = 'string' } }
        return (@{ tables = @(@{ columns = @($columns); rows = @(,@('Old', 'old1', '2024-01-01T12:00:00Z', 'Succeeded', '2024-01-01T13:00:00Z')) }) } | ConvertTo-Json -Depth 20)
    }
    $start = [DateTimeOffset]::UtcNow.AddDays(-2).ToString('o')
    $run = @{ pipelineName = 'A'; runId = 'run1'; runStart = $start; lastUpdated = $start; status = 'Failed'; parameters = @{ password = 'DO_NOT_EXPORT' } }
    if (-not $body.continuationToken) { return (@{ value = @($run); continuationToken = 'page2' } | ConvertTo-Json -Depth 20) }
    if ($global:AdfHistoryMock.mode -eq 'loop') { return '{"value":[],"continuationToken":"page2"}' }
    return '{"value":[]}'
}
$params = @{ SubscriptionId = '11111111-1111-1111-1111-111111111111'; ResourceGroupName = 'rg-test'; FactoryName = 'adf-test' }
try {
    $text = & $scriptPath -Source api @params
    $history = $text | ConvertFrom-Json -AsHashtable
    Assert ($history.runs.Count -eq 1) 'API aggregates pages.'
    Assert ($history.complete -eq $true) 'Native coverage is complete within retention.'
    Assert (-not $text.Contains('DO_NOT_EXPORT')) 'Raw parameters must never be exported.'
    Assert ($global:AdfHistoryMock.calls.Count -eq 2) 'Continuation token must be followed.'
    Assert (($global:AdfHistoryMock.calls | Where-Object method -ne post).Count -eq 0) 'History POSTs are query-only.'
    Assert ($global:AdfHistoryMock.calls[1].body.continuationToken -eq 'page2') 'Token passed in request body.'
    $workerPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'Azure-PortalQuery.ps1'
    $workerText = & $workerPath -Operation history -Source api @params
    $workerResult = $workerText | ConvertFrom-Json -AsHashtable
    Assert ($workerResult.source -eq 'api' -and $workerResult.runs.Count -eq 1) "Worker returns pure history JSON: $workerText"
    $global:AdfHistoryMock.calls.Clear()
    $global:AdfHistoryMock.mode = 'loganalytics'
    $text = & $scriptPath -Source loganalytics -WorkspaceId '22222222-2222-2222-2222-222222222222' -CoverageFrom '2024-01-01T00:00:00Z' @params
    $history = $text | ConvertFrom-Json -AsHashtable
    Assert ($history.runs.Count -eq 2) 'Logs merged with recent native runs.'
    Assert ($history.complete -eq $false) 'Diagnostics coverage requires user confirmation.'
    Assert ($global:AdfHistoryMock.calls[0].body.query.Contains("_ResourceId =~ '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-test/providers/Microsoft.DataFactory/factories/adf-test'")) 'KQL scoped to exact factory.'
    Assert ($global:AdfHistoryMock.calls[0].body.query.Contains('arg_max')) 'Latest event selected per run.'
    $global:AdfHistoryMock.calls.Clear()
    & $scriptPath -Source loganalytics -LogTable AzureDiagnostics -WorkspaceId '22222222-2222-2222-2222-222222222222' -CoverageFrom '2024-01-01T00:00:00Z' @params | Out-Null
    Assert ($global:AdfHistoryMock.calls[0].body.query.Contains('PipelineName_s')) 'Legacy schema uses explicit pipeline fields.'
    $workerText = & $workerPath -Operation history -Source loganalytics -WorkspaceId '22222222-2222-2222-2222-222222222222' -CoverageFrom '2024-01-01T00:00:00Z' @params
    $workerResult = $workerText | ConvertFrom-Json -AsHashtable
    Assert ($workerResult.source -eq 'loganalytics' -and $workerResult.runs.Count -eq 2) 'Worker forwards Log Analytics configuration.'
    foreach ($mode in @('loop', 'denied', 'partial')) {
        $global:AdfHistoryMock.mode = $mode
        $caught = $false
        try {
            if ($mode -eq 'partial') { & $scriptPath -Source loganalytics -WorkspaceId '22222222-2222-2222-2222-222222222222' -CoverageFrom '2024-01-01T00:00:00Z' @params | Out-Null }
            else { & $scriptPath -Source api @params | Out-Null }
        } catch { $caught = $true }
        Assert $caught "$mode must fail, never return partial success."
    }
    foreach ($file in $global:AdfHistoryMock.tempPaths) { Assert (-not (Test-Path -LiteralPath $file)) 'Request body file must be cleaned.' }
    Write-Host 'Pipeline history mock tests passed.'
} finally { Remove-Variable -Name AdfHistoryMock -Scope Global }
