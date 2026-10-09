[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Storage,
    [int]$Port = 0,
    [switch]$Open
)
$ErrorActionPreference = 'Stop'
$cli = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist\src\cli.js'))
if (-not (Test-Path -LiteralPath $cli)) { throw 'Run npm run build first.' }
if (-not (Test-Path -LiteralPath (Join-Path $Storage 'cmm.db'))) { throw 'Select an existing CMM storage.' }
$arguments = @($cli,'dashboard','--storage',$Storage,'--port',[string]$Port)
if ($Open) { $arguments += '--open' }
& node @arguments
if ($LASTEXITCODE -ne 0) { throw "Dashboard exited with code $LASTEXITCODE" }
