<#
.SYNOPSIS
    Measures what raising the published query-family count costs a database city page.

.DESCRIPTION
    The family count is the join key a live execution is matched against, so a small number leaves
    most of the live feed inert. The cost of raising it is plan hydration, which happens per page
    request. This script starts one API instance per candidate count against the same database and
    times the page, so the trade is measured rather than guessed.

    Query Store history is collected on a background cycle, so each instance is polled until it
    publishes families before any timing is taken -- otherwise the first count measured is really
    measuring an empty history.
#>
param(
    [int[]]$Counts = @(12, 48, 250, 1000),
    [string]$Database = 'SimCitySmall',
    [string]$Server = '127.0.0.1,11433',
    [int]$Port = 5081
)

$exe = Join-Path $env:TEMP 'sqlsimcity-measure\SqlSimCity.Api.exe'
$root = "http://127.0.0.1:$Port"
$page = "$root/api/v1/database-city/primary/database/$Database" + "?pageSize=50"

foreach ($count in $Counts) {
    $env:ConnectionStrings__SqlSimCity =
        "Server=$Server;Database=$Database;User Id=sqlsimcity_reader;Password=Reader!Local1;TrustServerCertificate=true"
    $env:Atlas__KnownDatabases__0 = $Database
    $env:Atlas__QueryStoreRefreshIntervalSeconds = '60'
    $env:DatabaseCity__TopQueryFamilyCount = "$count"

    $proc = Start-Process -FilePath $exe -ArgumentList '--urls', $root -PassThru -WindowStyle Hidden
    try {
        $body = $null
        for ($i = 0; $i -lt 40; $i++) {
            Start-Sleep 5
            try {
                $body = Invoke-RestMethod $page -TimeoutSec 300
                if ($body.topQueryFamilies.Count -gt 0) { break }
            } catch { }
        }

        $times = @()
        $error = $null
        for ($i = 0; $i -lt 3; $i++) {
            try {
                $sw = [Diagnostics.Stopwatch]::StartNew()
                $body = Invoke-RestMethod $page -TimeoutSec 300
                $sw.Stop()
                $times += [int]$sw.ElapsedMilliseconds
            } catch {
                $error = $_.Exception.Message
                break
            }
        }

        if ($error) {
            [pscustomobject]@{
                Requested = $count; Returned = 'ERR'; Mapped = ''; Unmapped = ''
                MedianMs = ''; AllMs = $error
            }
            continue
        }

        $families = $body.topQueryFamilies
        $mapped = ($families | Where-Object { $_.objectIds.Count -gt 0 }).Count
        [pscustomobject]@{
            Requested = $count
            Returned  = $families.Count
            Mapped    = $mapped
            Unmapped  = $families.Count - $mapped
            MedianMs  = ($times | Sort-Object)[1]
            AllMs     = ($times -join '/')
        }
    } finally {
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Start-Sleep 3
    }
}
