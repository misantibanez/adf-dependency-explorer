function Get-AdfCollection {
    param([string]$Url, [string]$FactoryBase)
    $items = [System.Collections.Generic.List[object]]::new()
    $seen = [System.Collections.Generic.HashSet[string]]::new()
    while ($Url) {
        $uri = [uri]$Url
        $baseUri = [uri]$FactoryBase
        if ($uri.Scheme -ne 'https' -or $uri.Host -ne $baseUri.Host -or -not $uri.IsDefaultPort -or $uri.UserInfo -or
            -not $uri.AbsolutePath.StartsWith($baseUri.AbsolutePath + '/', [StringComparison]::OrdinalIgnoreCase)) {
            throw 'nextLink fuera del ambito solicitado. Lectura cancelada.'
        }
        if (-not $seen.Add($Url)) { throw 'nextLink circular. Lectura cancelada.' }
        $responseText = & az rest --method get --url $Url --only-show-errors --output json
        if ($LASTEXITCODE -ne 0) {
            throw "Fallo la lectura de Azure ($($uri.AbsolutePath)). Revisar az login, tenant y permisos Reader."
        }
        $response = ($responseText -join "`n") | ConvertFrom-Json -AsHashtable
        if (-not $response.ContainsKey('value') -or $response.value -isnot [array]) {
            throw 'Respuesta invalida: se esperaba una lista value.'
        }
        foreach ($item in $response.value) { $items.Add($item) }
        $Url = $response.nextLink
    }
    return ,$items.ToArray()
}
