<#
  Installs the admin-site Jobs runner on this Windows machine.

  Run in PowerShell **as Administrator**, from the runner folder:
      .\install.ps1 -CareerOpsRoot C:\career-ops
  Remove it again:
      .\install.ps1 -Uninstall

  What it does:
    1. Asks for the runner token and Cloudflare Access service token (first run
       only) and writes them to .env, readable only by your Windows account.
    2. Runs one sync to prove the connection works.
    3. Registers a scheduled task that starts the runner at boot (signed in or
       not) and restarts it if it ever stops.
#>
param(
    [string]$CareerOpsRoot = 'C:\career-ops',
    [string]$WorkerUrl = 'https://admin.samarthvmurthy.dev',
    [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'AdminSite Jobs Runner'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path

if ($Uninstall) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Host "Removed the '$TaskName' task."
    } else {
        Write-Host 'The runner task is not installed.'
    }
    return
}

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) { throw 'Run this from PowerShell opened with "Run as administrator".' }

$node = (Get-Command node -ErrorAction Stop).Source
$nodeVersion = (& $node --version)
Write-Host "Using Node $nodeVersion at $node"

if (-not (Test-Path (Join-Path $CareerOpsRoot 'AGENTS.md'))) {
    throw "career-ops not found at $CareerOpsRoot (pass -CareerOpsRoot <folder>)."
}

# ---------------------------------------------------------------- .env ----
$envFile = Join-Path $here '.env'
if (-not (Test-Path $envFile)) {
    function Read-Secret([string]$prompt) {
        $s = Read-Host -Prompt $prompt -AsSecureString
        [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))
    }
    Write-Host ''
    Write-Host 'First-time setup. Values are saved to .env next to this script.'
    $runnerToken = Read-Secret 'RUNNER_TOKEN (same value as the worker secret)'
    $accessId = Read-Host -Prompt 'Cloudflare Access service token Client ID'
    $accessSecret = Read-Secret 'Cloudflare Access service token Client Secret'
    @(
        "WORKER_URL=$WorkerUrl",
        "RUNNER_TOKEN=$runnerToken",
        "CF_ACCESS_CLIENT_ID=$accessId",
        "CF_ACCESS_CLIENT_SECRET=$accessSecret",
        "CAREER_OPS_ROOT=$CareerOpsRoot",
        'POLL_SECONDS=15',
        'CLAUDE_CODE_OAUTH_TOKEN='
    ) | Set-Content -Path $envFile -Encoding UTF8
    # Only this Windows account (and SYSTEM) can read the secrets.
    icacls $envFile /inheritance:r /grant:r "$($env:USERNAME):(M)" /grant:r 'SYSTEM:(R)' | Out-Null
    Write-Host "Saved $envFile"
}

# ------------------------------------------------------------ smoke test ----
Write-Host ''
Write-Host 'Checking the connection with one sync...'
& $node (Join-Path $here 'runner.mjs') --sync
if ($LASTEXITCODE -ne 0) { throw 'The test sync failed; see the message above (and runner.log).' }

# ------------------------------------------------------------------ task ----
$action = New-ScheduledTaskAction -Execute $node -Argument "`"$(Join-Path $here 'runner.mjs')`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtStartup
# S4U: runs whether or not you're signed in, without storing your password.
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType S4U -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) `
    -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Principal $principal `
    -Settings $settings -Description 'Runs career-ops jobs queued from the admin site Jobs page.' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName

Start-Sleep -Seconds 3
$state = (Get-ScheduledTask -TaskName $TaskName).State
Write-Host ''
Write-Host "Installed '$TaskName' (state: $state). It starts at every boot."
Write-Host "Log: $(Join-Path $here 'runner.log')"
Write-Host 'Open the Jobs page: it should say "Dell online" within a minute.'
