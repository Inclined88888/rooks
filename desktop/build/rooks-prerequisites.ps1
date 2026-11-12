# Installs the prerequisites Rooks needs on Windows, Node.js and Git, while the
# Rooks installer runs. Run elevated by installer.nsh (customInstall), never by
# hand. The onboarding screen still offers them if this fails.
#
# Why here: the onboarding's Install buttons run winget from the daemon, and
# once the service runs it in session 0 (Task Scheduler S4U) no permission
# prompt can reach the user, while the Node.js MSI is machine-wide
# (27/09/2026). The installer runs in the user's session and can ask once.
#
# Exit codes: 0 all installed, 1 at least one failed, 3 winget unavailable.
param([switch]$Node, [switch]$Git, [Parameter(Mandatory = $true)][string]$Log)
$ErrorActionPreference = 'Continue'

function Write-Log([string]$line) { Add-Content -LiteralPath $Log -Value $line -Encoding UTF8 }

$winget = (Get-Command winget.exe -ErrorAction SilentlyContinue).Source
if (-not $winget) {
  $alias = Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'
  if (Test-Path -LiteralPath $alias) { $winget = $alias }
}
if (-not $winget) { Write-Log 'winget is not available on this Windows.'; exit 3 }

# Same ids as the onboarding (host/machine.ts). Node.js LTS and current are
# two MSIs that refuse each other (1603), so one id for the whole product: the
# LTS, since native modules failed to build against Node 26.
# A package already on disk is skipped: its MSI would fail the same way.
$packages = @()
if ($Node -and -not (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'nodejs\node.exe'))) { $packages += 'OpenJS.NodeJS.LTS' }
if ($Git -and -not (Test-Path -LiteralPath (Join-Path $env:ProgramFiles 'Git\cmd\git.exe'))) { $packages += 'Git.Git' }

$failed = $false
foreach ($id in $packages) {
  Write-Log "Installing $id..."
  # `--source winget`: the msstore source asks for its own agreement first
  # and fails unattended (TIM-0022).
  $output = & $winget install -e --id $id --source winget --scope machine --silent `
    --accept-source-agreements --accept-package-agreements --disable-interactivity 2>&1 | Out-String
  Write-Log $output.Trim()
  # APPINSTALLER_CLI_ERROR_PACKAGE_ALREADY_INSTALLED: nothing to do.
  if ($LASTEXITCODE -ne 0 -and $LASTEXITCODE -ne -1978335189) {
    Write-Log "$id failed (exit $LASTEXITCODE)."
    $failed = $true
  }
}
if ($failed) { exit 1 }
exit 0
