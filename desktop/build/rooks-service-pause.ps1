# Pauses the Rooks background service while the installer replaces its files.
# Run by installer.nsh (rooksPauseService), never by hand: elevated when
# Windows grants it, and once more without elevation when it does not.
#
# Why elevated: the service runs under a Task Scheduler S4U logon, in session 0.
# The per-user installer sees those Rooks.exe processes (same user) but cannot
# end them, and looped on "Rooks cannot be closed" (0.1.2-rc.2 update,
# 27/09/2026). The task is disabled first: its 5-minute repeating trigger would
# otherwise start the daemon again from half-replaced files.
#
# Why it also runs unelevated: an account Windows refuses S4U for (a standard
# account on an Entra-joined PC) gets an Interactive task, which runs the daemon
# in the user's own session; that user may disable the task and end the daemon
# without elevation. Left running, the daemon kept its files open while the
# installer replaced them, and the next launch failed on a missing `ffmpeg.dll`
# (0.1.5 update, 21/10/2026).
#
# The first run (stop phase) ends the service and starts a detached copy of
# itself (resume phase), which waits for the installer to exit and then enables
# and starts the task again if it still exists: an uninstall deletes it.
param(
  [Parameter(Mandatory = $true)][int]$InstallerPid,
  [Parameter(Mandatory = $true)][string]$User,
  [Parameter(Mandatory = $true)][string]$Exe,
  # The application directory: what remains of this installation is found by
  # the paths under it on a command line. Empty: only the daemon is ended.
  [string]$InstallDir = '',
  [switch]$Resume
)
$ErrorActionPreference = 'SilentlyContinue'
$task = 'RooksOrchestrator'

if ($Resume) {
  Wait-Process -Id $InstallerPid
  if (Get-ScheduledTask -TaskName $task -TaskPath '\') {
    Enable-ScheduledTask -TaskName $task -TaskPath '\' | Out-Null
    Start-ScheduledTask -TaskName $task -TaskPath '\'
  }
  Remove-Item -LiteralPath $PSCommandPath -Force
  exit 0
}

Disable-ScheduledTask -TaskName $task -TaskPath '\' | Out-Null
Stop-ScheduledTask -TaskName $task -TaskPath '\'
# Stop-ScheduledTask ends the launcher and leaves its daemon orphaned: end the
# launcher's tree, then every daemon Rooks.exe of this user it left behind, in
# whatever session it runs (session 0 for S4U, the user's own for an
# Interactive task). The daemon names its entry point on its command line; the
# window (no boot.js) is left to the installer's own "close the application".
$mine = { param($process) (Invoke-CimMethod -InputObject $process -MethodName GetOwner).User -eq $User }
# The daemon runs on the Node the package ships (resources\node\node.exe);
# a package before it ran it on $Exe as Node. An update from one to the other
# finds either, so both are ours — only with this user's Rooks command line.
$runtimes = @($Exe, 'node.exe')
Get-CimInstance Win32_Process | Where-Object {
  $_.Name -eq 'cmd.exe' -and $_.CommandLine -and
  $_.CommandLine.ToLowerInvariant().Contains('\run\rooks-service.cmd') -and (& $mine $_)
} | ForEach-Object { & taskkill.exe /F /T /PID $_.ProcessId | Out-Null }
Get-CimInstance Win32_Process | Where-Object {
  $runtimes -contains $_.Name -and $_.CommandLine -and
  $_.CommandLine.ToLowerInvariant().Contains('\dist\boot.js') -and (& $mine $_)
} | ForEach-Object { & taskkill.exe /F /T /PID $_.ProcessId | Out-Null }

# What no tree reaches once the daemon is gone: its web server
# (resources\app\...\server.cjs), the browser helper of a mission
# (bin\browser-mcp.mjs), the terminal host (detached on purpose). They kept
# the installer looping on "Rooks cannot be closed" after the user had quit
# the app (0.1.5 update, 22/10/2026). Every $Exe of this user that runs a file
# of THIS installation as Node is ended; the window and Electron's own helpers
# (--type=) carry none of these paths. Two passes: a child whose parent went
# first in a pass has no tree left to be ended with.
if ($InstallDir) {
  $root = $InstallDir.TrimEnd('\').ToLowerInvariant()
  $needles = @("$root\resources\orchestrator\", "$root\resources\app\")
  $leftovers = {
    Get-CimInstance Win32_Process | Where-Object {
      if ($runtimes -notcontains $_.Name -or -not $_.CommandLine -or $_.CommandLine.Contains('--type=')) { return $false }
      $line = $_.CommandLine.ToLowerInvariant()
      foreach ($needle in $needles) { if ($line.Contains($needle)) { return (& $mine $_) } }
      $false
    }
  }
  foreach ($pass in 1..2) {
    $found = @(& $leftovers)
    if ($found.Count -eq 0) { break }
    $found | ForEach-Object { & taskkill.exe /F /T /PID $_.ProcessId | Out-Null }
    Start-Sleep -Seconds 1
  }
}

# The installer deletes its plugins directory on exit: the resume phase runs
# from its own copy.
$copy = Join-Path ([IO.Path]::GetTempPath()) ("rooks-service-resume-{0}.ps1" -f $InstallerPid)
Copy-Item -LiteralPath $PSCommandPath -Destination $copy -Force
Start-Process -WindowStyle Hidden -FilePath (Join-Path $PSHOME 'powershell.exe') -ArgumentList @(
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', "`"$copy`"", '-Resume',
  '-InstallerPid', $InstallerPid, '-User', "`"$User`"", '-Exe', "`"$Exe`""
)
exit 0
