# Disposable CLI/install checks only. Does not launch or certify a live coding agent.
[CmdletBinding()]
param([string]$Node = 'node')
$ErrorActionPreference = 'Stop'
$cli = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist\src\cli.js'))
if (-not (Test-Path -LiteralPath $cli)) { throw 'Prebuilt CLI missing. Run npm run build, or use the source-with-build ZIP.' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('CMM smoke ' + [Guid]::NewGuid().ToString('N'))
$workspace = Join-Path $root 'project with spaces'
$storage = Join-Path $root 'isolated archive'
[void](New-Item -ItemType Directory -Path $workspace -Force)
function Invoke-Cmm {
    param([string[]]$Arguments)
    $captured = & $Node $cli @Arguments
    if ($LASTEXITCODE -ne 0) { throw "CMM exited with code $LASTEXITCODE" }
    return ($captured -join "`n")
}
try {
    $help = Invoke-Cmm -Arguments @('--help')
    if (-not $help.Contains('Keep the evidence')) { throw 'Unexpected CLI help.' }
    $demo = (Invoke-Cmm -Arguments @('demo')) | ConvertFrom-Json
    if (-not ($demo.exactRecallVerified -and $demo.firstUsePreserved -and $demo.stableProjection)) { throw 'Lifecycle demo failed.' }
    $preview = (Invoke-Cmm -Arguments @('setup','all','--dry-run','--workspace',$workspace,'--storage',$storage)) | ConvertFrom-Json
    if (-not $preview.dryRun) { throw 'Setup preview did not report dry-run.' }
    if (Test-Path -LiteralPath $storage) { throw 'Preview unexpectedly created storage.' }
    [void](Invoke-Cmm -Arguments @('setup','all','--workspace',$workspace,'--storage',$storage))
    [void](Invoke-Cmm -Arguments @('uninstall','all','--workspace',$workspace,'--storage',$storage))
    [void](Invoke-Cmm -Arguments @('verify','--agent','opencode','--workspace',$workspace,'--storage',$storage))
    [ordered]@{ cli = $cli; node = (& $Node --version); isolatedCLI = $true; pathsWithSpaces = $true; demo = $demo; setupAndUninstall = $true; liveAgentTested = $false } | ConvertTo-Json -Depth 8
} finally {
    # Only the generated, disposable directory is removed. No personal configuration is touched.
    if (Test-Path -LiteralPath $root) {
        $resolvedRoot = [IO.Path]::GetFullPath($root)
        $temporaryParent = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\','/')
        if ([IO.Path]::GetDirectoryName($resolvedRoot) -ne $temporaryParent -or
            -not [IO.Path]::GetFileName($resolvedRoot).StartsWith('CMM smoke ') -or
            ((Get-Item -LiteralPath $resolvedRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw 'Refusing cleanup outside the generated smoke directory.'
        }
        Remove-Item -LiteralPath $resolvedRoot -Recurse -Force
    }
}
