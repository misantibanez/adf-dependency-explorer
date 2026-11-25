#requires -Version 7.0
$ErrorActionPreference = 'Stop'
$scriptPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'Export-AdfInventory.ps1'
$temp = Join-Path ([IO.Path]::GetTempPath()) ('adf-export-test-' + [guid]::NewGuid())
$null = New-Item -ItemType Directory -Path $temp
$base = 'https://management.azure.com/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-test/providers/Microsoft.DataFactory/factories/adf-test'
$global:AdfExportMock = @{
    calls = [System.Collections.Generic.List[object]]::new()
    mode = 'success'
    base = $base
    resourceId = '/subscriptions/11111111-1111-1111-1111-111111111111/resourceGroups/rg-test/providers/Microsoft.Storage/storageAccounts/lake'
}
function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw "ASSERT: $Message" }
}
function az {
    if ($args[0] -eq 'account') {
        $global:LASTEXITCODE = 0
        return '[{"id":"11111111-1111-1111-1111-111111111111","name":"Subscription_Test","state":"Enabled","tenantId":"22222222-2222-2222-2222-222222222222","user":{"name":"DO_NOT_EXPORT"}}]'
    }
    $methodIndex = [array]::IndexOf($args, '--method')
    $urlIndex = [array]::IndexOf($args, '--url')
    $method = $args[$methodIndex + 1]
    $url = $args[$urlIndex + 1]
    $global:AdfExportMock.calls.Add(@{ method = $method; url = $url })
    $global:LASTEXITCODE = 0
    if ($global:AdfExportMock.mode -eq 'denied') { $global:LASTEXITCODE = 1; return }
    if ($global:AdfExportMock.mode -eq 'invalid') { return '{"value":null}' }
    if ($url -match '/providers/Microsoft\.DataFactory/factories\?') {
        if ($url -like '*skip=2*') { return '{"value":[]}' }
        return (@{ value = @(@{ id = $global:AdfExportMock.base.Replace('https://management.azure.com', ''); name = 'adf-test'; location = 'eastus' });
            nextLink = 'https://management.azure.com/subscriptions/11111111-1111-1111-1111-111111111111/providers/Microsoft.DataFactory/factories?api-version=2018-06-01&skip=2' } | ConvertTo-Json -Depth 10)
    }
    if ($url -match '/managedVirtualNetworks\?') {
        if ($global:AdfExportMock.mode -eq 'no-networks') { return '{"value":[]}' }
        return '{"value":[{"name":"default","properties":{}},{"name":"other","properties":{}}]}'
    }
    if ($url -match '/managedPrivateEndpoints\?') {
        if ($global:AdfExportMock.mode -eq 'mpe-denied') { $global:LASTEXITCODE = 1; return }
        if ($url -like '*skip=2*') { return '{"value":[]}' }
        return (@{ value = @(@{ name = 'MPE_Test'; properties = @{
            groupId = 'blob'; provisioningState = 'Succeeded'; connectionState = @{ status = 'Approved'; description = 'DO_NOT_EXPORT' }
            privateLinkResourceId = $global:AdfExportMock.resourceId; fqdns = @('lake.privatelink.dfs.core.windows.net', 'DO_NOT_EXPORT')
        } }); nextLink = "$($url)&skip=2" } | ConvertTo-Json -Depth 20)
    }
    if ($url -like '*/pipelines?*') {
        $next = if ($global:AdfExportMock.mode -eq 'escape') { 'https://example.invalid/leak' } else { "$($global:AdfExportMock.base)/pipelines?api-version=2018-06-01&skip=2" }
        if ($url -like '*skip=2*') {
            if ($global:AdfExportMock.mode -eq 'loop') { return (@{ value = @(); nextLink = $url } | ConvertTo-Json -Depth 50) }
            return '{"value":[{"name":"B","properties":{"activities":[]}}]}'
        }
        $pipeline = @{
            name = 'A'; properties = @{
                parameters = @{ secret = @{ type = 'String'; defaultValue = 'DO_NOT_EXPORT' } }
                activities = @(
                    @{ name = 'Loop'; type = 'ForEach'; typeProperties = @{ activities = @(
                        @{ name = 'CallB'; type = 'ExecutePipeline'; typeProperties = @{
                            pipeline = @{ type = 'PipelineReference'; referenceName = 'B' }
                        } }
                    ) } }
                    @{ name = 'Dynamic'; type = 'ExecutePipeline'; typeProperties = @{
                        pipeline = @{ type = 'PipelineReference'; referenceName = @{ type = 'Expression'; value = 'DO_NOT_EXPORT' } }
                    } }
                    @{ name = 'Web'; type = 'WebActivity'; typeProperties = @{
                        url = 'DO_NOT_EXPORT'; body = 'DO_NOT_EXPORT'; headers = @{ Authorization = 'DO_NOT_EXPORT' }
                    } }
                    @{ name = 'Copy'; type = 'Copy'; inputs = @(@{ type = 'DatasetReference'; referenceName = 'D' }) }
                )
            }
        }
        return (@{ value = @($pipeline); nextLink = $next } | ConvertTo-Json -Depth 50)
    }
    if ($url -like '*/linkedservices?*') {
        return (@{ value = @(
            @{ name = 'LS'; properties = @{ type = 'AzureBlobFS'; typeProperties = @{
                resourceId = $global:AdfExportMock.resourceId
                connectionString = @{ type = 'SecureString'; value = 'DO_NOT_EXPORT' }
            }; connectVia = @{ type = 'IntegrationRuntimeReference'; referenceName = 'IR' } } }
            @{ name = 'LS_Dynamic'; properties = @{ type = 'AzureBlobFS'; typeProperties = @{
                resourceId = @{ type = 'Expression'; value = 'DO_NOT_EXPORT' }
            } } }
            @{ name = 'LS_Invalid'; properties = @{ type = 'AzureBlobFS'; resourceId = 'DO_NOT_EXPORT' } }
            @{ name = 'LS_Top'; properties = @{ type = 'AzureBlobFS'; resourceId = $global:AdfExportMock.resourceId } }
            @{ name = 'LS_Url'; properties = @{ type = 'AzureBlobFS'; typeProperties = @{
                url = 'https://LAKE.dfs.core.windows.net/container?sig=DO_NOT_EXPORT'
                accountKey = @{ type = 'SecureString'; value = 'DO_NOT_EXPORT' }
            } } }
            @{ name = 'LS_SQL'; properties = @{ type = 'AzureSqlDatabase'; typeProperties = @{
                server = 'tcp:sqltest.database.windows.net,1433'; password = @{ type = 'SecureString'; value = 'DO_NOT_EXPORT' }
            } } }
            @{ name = 'LS_SecretUrl'; properties = @{ type = 'AzureBlobFS'; typeProperties = @{
                url = @{ type = 'AzureKeyVaultSecret'; store = @{ type = 'LinkedServiceReference'; referenceName = 'Vault' }; secretName = 'DO_NOT_EXPORT' }
            } } }
        ) } | ConvertTo-Json -Depth 20)
    }
    if ($url -match '/datasets\?') {
        return '{"value":[{"name":"D","properties":{"linkedServiceName":{"type":"LinkedServiceReference","referenceName":"LS_Url"}}}]}'
    }
    if ($url -like '*/integrationRuntimes?*') { return '{"value":[{"name":"IR","properties":{"type":"SelfHosted"}}]}' }
    if ($url -like '*/dataflows?*') { return '{"value":[{"name":"Flow","properties":{"type":"MappingDataFlow","typeProperties":{"scriptLines":["DO_NOT_EXPORT"]}}}]}' }
    return '{"value":[]}'
}
try {
    $output = Join-Path $temp 'inventory.json'
    & $scriptPath -SubscriptionId '11111111-1111-1111-1111-111111111111' -ResourceGroupName 'rg-test' -FactoryName 'adf-test' -OutputPath $output
    $text = Get-Content -LiteralPath $output -Raw
    $snapshot = $text | ConvertFrom-Json -AsHashtable
    Assert ($snapshot.collections.pipelines.Count -eq 2) 'Both pages must be present.'
    Assert ($global:AdfExportMock.calls.Count -eq 12) 'Six core collections plus continuation, network discovery and paginated endpoints per network.'
    Assert ($snapshot.collections.managedPrivateEndpoints.Count -eq 2) 'Endpoints from all managed networks collected.'
    Assert ($snapshot.collections.managedPrivateEndpoints[0].name -eq 'default/MPE_Test') 'Endpoint names scoped to network.'
    Assert ($snapshot.collections.managedPrivateEndpoints[1].name -eq 'other/MPE_Test') 'Same endpoint name in another network is distinct.'
    Assert ($snapshot.collections.managedPrivateEndpoints[0].properties.connectionState.status -eq 'Approved') 'Connection status retained.'
    Assert ($snapshot.collections.managedPrivateEndpoints[0].properties.privateLinkResourceId -eq $global:AdfExportMock.resourceId) 'Endpoint resource ID retained.'
    Assert ($snapshot.collections.linkedservices[0].properties.typeProperties.resourceId -eq $global:AdfExportMock.resourceId) 'Linked service resource ID retained.'
    $urlService = $snapshot.collections.linkedservices | Where-Object name -eq 'LS_Url'
    Assert ($urlService.properties.networkHosts.Count -eq 1 -and $urlService.properties.networkHosts[0] -eq 'lake.dfs.core.windows.net') 'URL projected to hostname only; no SAS, path or credentials.'
    Assert (-not $urlService.properties.typeProperties.url) 'Raw linked service URL must not be exported.'
    Assert ($snapshot.collections.managedPrivateEndpoints[0].properties.networkHosts[0] -eq 'lake.dfs.core.windows.net') 'Private endpoint FQDN normalized safely.'
    $sqlService = $snapshot.collections.linkedservices | Where-Object name -eq 'LS_SQL'
    Assert ($sqlService.properties.networkHosts[0] -eq 'sqltest.database.windows.net') 'SQL host extracted without port or password.'
    $secretService = $snapshot.collections.linkedservices | Where-Object name -eq 'LS_SecretUrl'
    Assert ($secretService.properties.networkHosts.Count -eq 0) 'Secret references produce an empty hostname array, not null placeholders.'
    Assert (@($global:AdfExportMock.calls | Where-Object method -ne 'get').Count -eq 0) 'Every API request must be GET.'
    Assert (-not $text.Contains('DO_NOT_EXPORT')) 'Secrets, expressions and code must not be persisted.'
    Assert ($snapshot.collections.pipelines[0].properties.activities[0].typeProperties.activities[0].typeProperties.pipeline.referenceName -eq 'B') 'Nested reference preserved.'
    Assert ($snapshot.collections.pipelines[0].properties.activities[1].typeProperties.pipeline.referenceName.type -eq 'Expression') 'Dynamic marker preserved.'
    Assert ($snapshot.collections.dataflows[0].properties.typeProperties.uninspectedScript) 'Script review marker preserved.'
    Assert (@($snapshot.metadata.completeness.Values | Where-Object { $_ -ne $true }).Count -eq 0) 'Complete collections declared.'
    $env:ADF_TEST_SNAPSHOT = $output
    & node -e 'const fs=require("node:fs"); const g=require("./graph.js"); const x=g.buildGraph(JSON.parse(fs.readFileSync(process.env.ADF_TEST_SNAPSHOT,"utf8"))); const r=g.evaluateDeletion(x,[g.idFor("pipeline","B")]); if(r.results[0].blockers[0].name!=="A" || x.issues.length<2) throw Error("Projection-to-engine integration failed"); const edges=x.edges.filter(e=>e.kind==="resourceMatch"); if(edges.length!==4 || !g.traverse(x,g.idFor("managedPrivateEndpoint","default/MPE_Test"),"incoming").has(g.idFor("linkedService","LS"))) throw Error("Resource correlation after projection failed"); const possible=x.edges.filter(e=>e.kind==="possibleNetwork"); if(possible.length!==2 || !g.traverse(x,g.idFor("managedPrivateEndpoint","default/MPE_Test"),"incoming").has(g.idFor("pipeline","A"))) throw Error("URL-to-endpoint-to-pipeline correlation after projection failed");'
    Assert ($LASTEXITCODE -eq 0) 'Projected export works end to end with graph engine.'
    $worker = Join-Path (Split-Path $PSScriptRoot -Parent) 'Azure-PortalQuery.ps1'
    $accounts = (& $worker -Operation subscriptions) | ConvertFrom-Json -AsHashtable
    Assert ($accounts.subscriptions.Count -eq 1) 'Worker subscriptions listed.'
    Assert (-not (($accounts | ConvertTo-Json -Depth 10).Contains('DO_NOT_EXPORT'))) 'Account user metadata not returned.'
    $factories = (& $worker -Operation factories -SubscriptionId '11111111-1111-1111-1111-111111111111') | ConvertFrom-Json -AsHashtable
    Assert ($factories.factories.Count -eq 1) 'Worker lists paginated factories.'
    $inMemory = (& $worker -Operation inventory -SubscriptionId '11111111-1111-1111-1111-111111111111' -ResourceGroupName 'rg-test' -FactoryName 'adf-test') | ConvertFrom-Json -AsHashtable
    Assert ($inMemory.collections.pipelines.Count -eq 2) 'Worker inventory returns pure JSON in memory.'
    Assert (-not (($inMemory | ConvertTo-Json -Depth 50).Contains('DO_NOT_EXPORT'))) 'Worker inventory strips secrets.'
    $global:AdfExportMock.mode = 'no-networks'
    $emptyNetworks = (& $worker -Operation inventory -SubscriptionId '11111111-1111-1111-1111-111111111111' -ResourceGroupName 'rg-test' -FactoryName 'adf-test') | ConvertFrom-Json -AsHashtable
    Assert ($emptyNetworks.collections.managedPrivateEndpoints.Count -eq 0 -and $emptyNetworks.metadata.completeness.managedPrivateEndpoints) 'Factory without managed networks has complete empty endpoint inventory.'
    $global:AdfExportMock.mode = 'success'
    $failed = $false
    try { & $scriptPath -SubscriptionId '11111111-1111-1111-1111-111111111111' -ResourceGroupName 'rg-test' -FactoryName 'adf-test' -OutputPath $output }
    catch { $failed = $true }
    Assert $failed 'Existing output must not be overwritten.'
    Assert ((Get-Content -LiteralPath $output -Raw) -eq $text) 'Previous inventory preserved.'
    foreach ($mode in @('denied', 'invalid', 'escape', 'loop', 'mpe-denied')) {
        $global:AdfExportMock.mode = $mode
        $failedOutput = Join-Path $temp "$mode.json"
        $failed = $false
        try { & $scriptPath -SubscriptionId '11111111-1111-1111-1111-111111111111' -ResourceGroupName 'rg-test' -FactoryName 'adf-test' -OutputPath $failedOutput }
        catch { $failed = $true }
        Assert $failed "Failure must be surfaced: $mode."
        Assert (-not (Test-Path -LiteralPath $failedOutput)) "No partial inventory on $mode."
    }
    Write-Host 'PASS: pagination, read-only, projection, engine integration, failure and overwrite protection.'
} finally {
    Remove-Item Env:\ADF_TEST_SNAPSHOT -ErrorAction SilentlyContinue
    Remove-Variable AdfExportMock -Scope Global
    Remove-Item -LiteralPath $temp -Recurse -Force
}
