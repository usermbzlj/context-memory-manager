# Disposable CLI/install checks only. Does not launch or certify a live coding agent.
[CmdletBinding()]
param([string]$Node = 'node')
$ErrorActionPreference = 'Stop'
$cli = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\dist\src\cli.js'))
if (-not (Test-Path -LiteralPath $cli)) { throw 'Prebuilt CLI missing. Run npm run build, or use the source-with-build ZIP.' }
$root = Join-Path ([IO.Path]::GetTempPath()) ('CMM smoke ' + [Guid]::NewGuid().ToString('N'))
$workspace = Join-Path $root 'project with spaces'
$storage = Join-Path $root 'isolated archive'
$cleanupSafe = $true
[void](New-Item -ItemType Directory -Path $workspace -Force)
# Kimi Code hooks are user-level. Point Kimi setup at a disposable home, never the real one.
$kimiHome = Join-Path $root 'kimi home'
$kimiConfig = Join-Path $kimiHome 'config.toml'
$kimiBefore = "default_model = `"fixture`"`n"
[void](New-Item -ItemType Directory -Path $kimiHome -Force)
[IO.File]::WriteAllText($kimiConfig, $kimiBefore)
$previousKimiHome = $env:KIMI_CODE_HOME
$env:KIMI_CODE_HOME = $kimiHome
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
    if (-not ([IO.File]::ReadAllText($kimiConfig)).Contains('PostToolUseFailure')) { throw 'Kimi hooks were not installed in the disposable home.' }
    # Run exactly the generated command through PowerShell, with stdin delivered
    # as UTF-8. A direct Node invocation cannot detect shell quoting failures.
    $hookFile = Join-Path $workspace '.codex\hooks.json'
    $hookCommand = (([IO.File]::ReadAllText($hookFile) | ConvertFrom-Json).hooks.PostToolUse[0].hooks[0]).command
    $observed = "Windows smoke exact evidence $([char]0x4e2d)$([char]::ConvertFromUtf32(0x1f680))`r`nsecond line`n"
    $hookInput = @{ hook_event_name = 'PostToolUse'; session_id = 'windows-smoke'; tool_use_id = 'smoke-call'; cwd = $workspace; tool_name = 'exec_command'; tool_input = @{ command = 'isolated fixture' }; tool_response = $observed } | ConvertTo-Json -Depth 4 -Compress
    $shellExecutable = (Get-Process -Id $PID).Path
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $shellExecutable
    $start.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($hookCommand))
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $hookProcess = [Diagnostics.Process]::new()
    $hookProcess.StartInfo = $start
    $hookStarted = $false
    $stdoutTask = $null
    $stderrTask = $null
    try {
        [void]$hookProcess.Start()
        $hookStarted = $true
        $stdoutTask = $hookProcess.StandardOutput.ReadToEndAsync()
        $stderrTask = $hookProcess.StandardError.ReadToEndAsync()
        $hookBytes = [Text.Encoding]::UTF8.GetBytes($hookInput)
        $hookProcess.StandardInput.BaseStream.Write($hookBytes, 0, $hookBytes.Length)
        $hookProcess.StandardInput.BaseStream.Flush()
        $hookProcess.StandardInput.Close()
        if (-not $hookProcess.WaitForExit(15000)) { throw 'Generated hook timed out.' }
        $hookStdout = $stdoutTask.GetAwaiter().GetResult()
        $hookStderr = $stderrTask.GetAwaiter().GetResult()
        if ($hookProcess.ExitCode -ne 0 -or $hookStdout -ne '' -or $hookStderr -ne '') { throw "Generated hook failed: $hookStderr" }
    } finally {
        if ($hookStarted -and -not $hookProcess.HasExited) {
            # Kill only this owned process and its descendants, while the parent
            # still exists so taskkill can identify the complete process tree.
            $cleanupSafe = $false
            & "$env:SystemRoot\System32\taskkill.exe" /PID $hookProcess.Id /T /F | Out-Null
            if ($LASTEXITCODE -eq 0 -and $hookProcess.WaitForExit(5000)) {
                $cleanupSafe = ($null -eq $stdoutTask -or $stdoutTask.Wait(5000)) -and ($null -eq $stderrTask -or $stderrTask.Wait(5000))
            }
        }
        $hookProcess.Dispose()
    }
    $found = (Invoke-Cmm -Arguments @('search','--agent','codex','--workspace',$workspace,'--storage',$storage)) | ConvertFrom-Json
    if ($found.results.Count -ne 1) { throw 'Generated hook did not archive exactly one result.' }
    $recalled = (Invoke-Cmm -Arguments @('recall',$found.results[0].eventId,'--agent','codex','--workspace',$workspace,'--storage',$storage)) | ConvertFrom-Json
    if ($recalled.text -cne $observed) { throw 'Generated hook did not preserve exact evidence.' }
    $verified = (Invoke-Cmm -Arguments @('verify','--agent','codex','--workspace',$workspace,'--storage',$storage)) | ConvertFrom-Json
    if ($verified.checked -ne 1 -or $verified.failed -ne 0) { throw 'Generated hook evidence failed verification.' }
    [void](Invoke-Cmm -Arguments @('uninstall','all','--workspace',$workspace,'--storage',$storage))
    if ([IO.File]::ReadAllText($kimiConfig) -ne $kimiBefore) { throw 'Kimi uninstall did not restore the disposable config exactly.' }
    [void](Invoke-Cmm -Arguments @('verify','--agent','opencode','--workspace',$workspace,'--storage',$storage))
    [ordered]@{ cli = $cli; node = (& $Node --version); isolatedCLI = $true; pathsWithSpaces = $true; demo = $demo; setupAndUninstall = $true; generatedHookCapture = $true; liveAgentTested = $false } | ConvertTo-Json -Depth 8
} finally {
    $env:KIMI_CODE_HOME = $previousKimiHome
    # Only the generated, disposable directory is removed. No personal configuration is touched.
    if (-not $cleanupSafe) {
        Write-Warning "Child closure unconfirmed; temporary directory retained: $root"
    } elseif (Test-Path -LiteralPath $root) {
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
