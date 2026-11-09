# Install the Rooks setup silently, start the app, stop it, uninstall it, and check that nothing is left
# (design 0011, sections 4 and 5.4). Runs on the windows-2022 runner after the installers are built (desktop.yml).
#
#   pwsh desktop/scripts/check_windows_install.ps1 -Setup <...-setup.exe> -Icon <icon.ico> -Shots <folder>
#
# Every check is run and printed, then the script fails if any of them failed, so one run shows them all.
# What it checks:
#   1. A silent per-user install (/S): the program folder under %LOCALAPPDATA%\Rooks, a Start menu entry named Rooks
#      that opens the app and shows the Rooks icon, the uninstall entry, the aiworkspace link handler, no desktop
#      shortcut (only when the person ticks it), and no autostart value.
#   2. The app opens its own window titled Rooks, and its sidecar answers /healthz.
#   3. Killing the app (as Task Manager's End task does) ends the sidecar within 10 seconds.
#   4. A silent uninstall removes the program, the Start menu entry, the uninstall entry, the link handler, the
#      install location key and the app's window data, and keeps the person's chats, keys and Room.
#   5. Installed again, an uninstall with /S /CLEANDATA also removes the chats, keys, the Room and the app's
#      Credential Manager entries.
param(
  [Parameter(Mandatory = $true)][string]$Setup,
  [Parameter(Mandatory = $true)][string]$Icon,
  [Parameter(Mandatory = $true)][string]$Shots
)
$ErrorActionPreference = "Stop"
New-Item -ItemType Directory -Force -Path $Shots | Out-Null

$script:failed = @()
function Check([string]$what, [bool]$ok, [string]$detail = "") {
  if ($ok) { Write-Host "ok   $what" } else { Write-Host "FAIL $what $detail"; $script:failed += $what }
}

$Product = "Rooks"
$BundleId = "com.inclined88888.aiworkspace"
$InstDir = Join-Path $env:LOCALAPPDATA $Product
$Exe = Join-Path $InstDir "ai-workspace-desktop.exe"
$StartLink = Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs\$Product.lnk"
$DesktopLink = Join-Path ([Environment]::GetFolderPath("Desktop")) "$Product.lnk"
$UninstKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\$Product"
$LinkKey = "HKCU:\Software\Classes\aiworkspace"
$ManuKey = "HKCU:\Software\Inclined88888\$Product"
$RunKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$DataDir = Join-Path $env:APPDATA $BundleId           # chats, keys (encrypted in the database), settings
$WindowData = Join-Path $env:LOCALAPPDATA $BundleId   # the window's WebView2 data and the app's logs
$LinkFile = Join-Path $env:APPDATA "ai-workspace"     # app.json: how the terminal and helpers reach the app
$RoomDir = Join-Path $env:USERPROFILE ".ai-workspace"  # the Room (try-room) and the theme; bin is other installers.

function Ours-Extracted {
  # The one-file sidecar unpacks itself into %TEMP%\_MEI*; ours are the ones holding the app's own pack folder.
  @(Get-ChildItem -Directory -Path $env:TEMP -Filter "_MEI*" -ErrorAction SilentlyContinue |
      Where-Object { Test-Path (Join-Path $_.FullName "app\packs\bundles") })
}

function Run-Value {
  $props = Get-ItemProperty -Path $RunKey -ErrorAction SilentlyContinue
  if (-not $props) { return $null }
  foreach ($p in $props.PSObject.Properties) {
    if ($p.Name -eq $Product -or "$($p.Value)" -like "*ai-workspace-desktop*") { return "$($p.Name)=$($p.Value)" }
  }
  return $null
}

function Our-Credentials {
  # keyring stores "ai-workspace" or "<name>@ai-workspace" as a generic credential's target
  @(cmdkey /list | Select-String -Pattern "target=(LegacyGeneric:target=)?([^ ]*@)?ai-workspace\s*$")
}

function Wait-Uninstalled([int]$seconds = 120) {
  # The NSIS uninstaller copies itself to %TEMP% and returns at once; wait for its work to be done.
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) {
    if (-not (Test-Path $UninstKey) -and -not (Test-Path $Exe) -and -not (Get-Process -Name "Un_*", "Au_" -ErrorAction SilentlyContinue)) { return $true }
    Start-Sleep -Milliseconds 500
  }
  return $false
}

function Install {
  $p = Start-Process -FilePath $Setup -ArgumentList "/S" -PassThru -Wait
  Check "the setup ran silently (exit code $($p.ExitCode))" ($p.ExitCode -eq 0)
}

function Uninstall([string[]]$flags) {
  $p = Start-Process -FilePath (Join-Path $InstDir "uninstall.exe") -ArgumentList $flags -PassThru -Wait
  Check "the uninstaller ran ($($flags -join ' '), exit code $($p.ExitCode))" ($p.ExitCode -eq 0)
  Check "the uninstaller finished within 2 minutes" (Wait-Uninstalled)
}

function Shot([string]$name) {
  try {
    Add-Type -AssemblyName System.Windows.Forms, System.Drawing
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)
    $bmp.Save((Join-Path $Shots $name), [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose()
    Write-Host "     screenshot: $name"
  } catch { Write-Host "     (no screenshot: $($_.Exception.Message))" }
}

function Same-Icon([string]$exe, [string]$ico) {
  # The icon Windows shows for the program (what the Start menu entry shows) against the app's own icon.ico, at 32 px.
  Add-Type -AssemblyName System.Drawing
  $a = [System.Drawing.Icon]::ExtractAssociatedIcon($exe).ToBitmap()
  $b = (New-Object System.Drawing.Icon $ico, 32, 32).ToBitmap()
  $a.Save((Join-Path $Shots "start-menu-icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
  if ($a.Width -ne $b.Width -or $a.Height -ne $b.Height) { return $false }
  $diff = 0
  for ($x = 0; $x -lt $a.Width; $x++) { for ($y = 0; $y -lt $a.Height; $y++) {
    $p = $a.GetPixel($x, $y); $q = $b.GetPixel($x, $y)
    if ([Math]::Abs($p.R - $q.R) + [Math]::Abs($p.G - $q.G) + [Math]::Abs($p.B - $q.B) + [Math]::Abs($p.A - $q.A) -gt 48) { $diff++ }
  } }
  Write-Host "     icon: $diff of $($a.Width * $a.Height) pixels differ"
  return ($diff -le ($a.Width * $a.Height / 20))
}

# --- 0. a clean runner ---------------------------------------------------------------------------------------------------
Check "nothing of Rooks is installed before the test" (-not (Test-Path $InstDir) -and -not (Test-Path $UninstKey))
Remove-Item -Recurse -Force $DataDir, $WindowData, $LinkFile -ErrorAction SilentlyContinue

# --- 1. install ------------------------------------------------------------------------------------------------------------
Install
Check "the program is in %LOCALAPPDATA%\Rooks (per user, no administrator)" (Test-Path $Exe)
Check "the sidecar is installed beside it" (Test-Path (Join-Path $InstDir "workbench-server.exe"))
$hasStart = Test-Path $StartLink
Check "the Start menu has an entry named Rooks" $hasStart
if ($hasStart) {
  $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($StartLink)
  Check "the Start menu entry opens the app" ($lnk.TargetPath -eq $Exe) $lnk.TargetPath
  Check "the Start menu entry shows the Rooks icon" (Same-Icon $Exe $Icon)
}
Check "no desktop shortcut unless the person asks for one" (-not (Test-Path $DesktopLink))
$u = Get-ItemProperty -Path $UninstKey -ErrorAction SilentlyContinue
Check "the uninstall entry is there, named Rooks" ($u -and $u.DisplayName -eq $Product)
Check "the aiworkspace link handler is registered for this user" (Test-Path $LinkKey)
Check "Rooks does not start by itself with Windows (no Run value)" ($null -eq (Run-Value)) "$(Run-Value)"

# --- 2. start ----------------------------------------------------------------------------------------------------------------
$extractedBefore = (Ours-Extracted).Count
$app = Start-Process -FilePath $Exe -PassThru
$window = $false; $port = $null; $healthy = $false
$deadline = (Get-Date).AddSeconds(150)
while ((Get-Date) -lt $deadline -and -not ($window -and $healthy)) {
  Start-Sleep -Seconds 1
  $w = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
  if ($w) { $w.Refresh(); if ($w.MainWindowTitle -eq $Product) { $window = $true } }
  $side = @(Get-Process -Name "workbench-server" -ErrorAction SilentlyContinue | ForEach-Object Id)
  if ($side.Count -gt 0 -and -not $healthy) {
    $listen = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $side -contains $_.OwningProcess -and $_.LocalAddress -eq "127.0.0.1" }
    foreach ($l in $listen) {
      try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$($l.LocalPort)/healthz"
        if ($r.StatusCode -eq 200) { $healthy = $true; $port = $l.LocalPort }
      } catch { }
    }
  }
}
Check "the app opened its own window titled Rooks" $window
Check "the app's sidecar answers /healthz (port $port)" $healthy
Start-Sleep -Seconds 6  # let the window leave the splash
Shot "rooks-window.png"

# --- 3. killed, the sidecar goes too -------------------------------------------------------------------------------------
$side = @(Get-Process -Name "workbench-server" -ErrorAction SilentlyContinue | ForEach-Object Id)
Write-Host "     sidecar processes: $($side -join ', ')"
Stop-Process -Id $app.Id -Force
$gone = $false
$deadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $deadline) {
  if (-not (Get-Process -Name "workbench-server" -ErrorAction SilentlyContinue)) { $gone = $true; break }
  Start-Sleep -Milliseconds 250
}
Check "killing the app ends its sidecar within 10 seconds" $gone "$(@(Get-Process -Name workbench-server -ErrorAction SilentlyContinue | ForEach-Object Id) -join ', ')"
Get-Process -Name "workbench-server", "ai-workspace-desktop" -ErrorAction SilentlyContinue | Stop-Process -Force
Write-Host "     the sidecar's unpacked copies in %TEMP%: $extractedBefore before, $((Ours-Extracted).Count) after"
Check "the app left its data folder (chats, keys)" (Test-Path (Join-Path $DataDir "workbench.db"))

# The person's things, and a Credential Manager entry as an older build left it, to see what each uninstall keeps.
New-Item -ItemType Directory -Force -Path (Join-Path $RoomDir "try-room") | Out-Null
Set-Content -Path (Join-Path $RoomDir "try-room\keep.txt") -Value "the Room"
New-Item -ItemType Directory -Force -Path (Join-Path $RoomDir "bin") | Out-Null  # a tool another installer put there
Set-Content -Path (Join-Path $RoomDir "bin\other-tool.txt") -Value "not the app's"
cmdkey /generic:ai-workspace /user:APP_SECRET /pass:not-a-real-secret | Out-Null
cmdkey "/generic:TOOLS_API_KEY@ai-workspace" /user:TOOLS_API_KEY /pass:not-a-real-secret | Out-Null
Check "a Credential Manager entry of the app is there to be removed" ((Our-Credentials).Count -ge 1)

# --- 4. uninstall, keeping the person's things ---------------------------------------------------------------------------
Uninstall @("/S")
Check "the program folder is gone" (-not (Test-Path $InstDir)) "$(Get-ChildItem -Recurse $InstDir -ErrorAction SilentlyContinue | ForEach-Object FullName)"
Check "the Start menu entry is gone" (-not (Test-Path $StartLink))
Check "no desktop shortcut is left" (-not (Test-Path $DesktopLink))
Check "the uninstall entry is gone" (-not (Test-Path $UninstKey))
Check "the aiworkspace link handler is gone" (-not (Test-Path $LinkKey))
Check "the install location key is gone" (-not (Test-Path $ManuKey))
Check "no Run value is left" ($null -eq (Run-Value))
Check "the window's data and the logs are gone" (-not (Test-Path $WindowData)) "$(Get-ChildItem $WindowData -ErrorAction SilentlyContinue | ForEach-Object Name)"
Check "no unpacked copy of the sidecar is left in %TEMP%" ((Ours-Extracted).Count -eq 0) "$((Ours-Extracted) | ForEach-Object FullName)"
Check "the person's chats and keys are kept" (Test-Path (Join-Path $DataDir "workbench.db"))
Check "the Room is kept" (Test-Path (Join-Path $RoomDir "try-room\keep.txt"))
Check "the Credential Manager entries are kept" ((Our-Credentials).Count -ge 1)

# --- 5. install again, uninstall removing everything ----------------------------------------------------------------------
Install
Uninstall @("/S", "/CLEANDATA")
Check "the program folder is gone (clean)" (-not (Test-Path $InstDir))
Check "the chats, keys and settings are gone" (-not (Test-Path $DataDir)) "$(Get-ChildItem $DataDir -ErrorAction SilentlyContinue | ForEach-Object Name)"
Check "the window's data is gone (clean)" (-not (Test-Path $WindowData))
Check "the app's link file is gone" (-not (Test-Path $LinkFile))
Check "the Room is gone" (-not (Test-Path (Join-Path $RoomDir "try-room")))
Check "tools another installer put beside it are kept" (Test-Path (Join-Path $RoomDir "bin\other-tool.txt"))
Check "the app's Credential Manager entries are gone" ((Our-Credentials).Count -eq 0) "$((Our-Credentials) -join '; ')"
Check "the uninstall entry is gone (clean)" (-not (Test-Path $UninstKey))
Check "the install location key is gone (clean)" (-not (Test-Path $ManuKey))

# tidy whatever a failed run left, then say how it went
cmdkey /delete:ai-workspace 2>$null | Out-Null
cmdkey "/delete:TOOLS_API_KEY@ai-workspace" 2>$null | Out-Null
Remove-Item -Recurse -Force (Join-Path $RoomDir "bin") -ErrorAction SilentlyContinue
if ($script:failed.Count -gt 0) {
  Write-Host ""
  Write-Host "$($script:failed.Count) check(s) failed:"
  $script:failed | ForEach-Object { Write-Host "  - $_" }
  exit 1
}
Write-Host ""
Write-Host "Every install, start, stop and uninstall check passed."
