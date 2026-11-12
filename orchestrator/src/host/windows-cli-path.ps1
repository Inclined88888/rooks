param(
    [Parameter(Mandatory=$true)][ValidateSet('install','remove')][string]$Action,
    [Parameter(Mandatory=$true)][string]$InstallDirectory,
    [Parameter(Mandatory=$true)][ValidateSet('all','CurrentUser')][string]$Scope
)
$ErrorActionPreference = 'Stop'
try {
    $directory = [IO.Path]::Combine($InstallDirectory, 'cli')
    if ($directory.Contains(';')) { throw 'The installation path must not contain a semicolon.' }
    $root = if ($Scope -eq 'all') { [Microsoft.Win32.Registry]::LocalMachine } else { [Microsoft.Win32.Registry]::CurrentUser }
    $subkey = if ($Scope -eq 'all') { 'SYSTEM\CurrentControlSet\Control\Session Manager\Environment' } else { 'Environment' }
    $key = $root.OpenSubKey($subkey, $true)
    try {
        # Read without expanding %SystemRoot% and without NSIS's string-size limit.
        $previous = $key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
        $parts = if ($previous -eq '') { @() } else { @($previous.Split(';')) }
        # Not $matches: PowerShell's automatic variable, which every -match overwrites.
        $existing = @($parts | Where-Object { $_.Trim().Trim('"').TrimEnd('\') -ieq $directory.TrimEnd('\') })
        if ($Action -eq 'install') {
            if ($existing.Count -gt 0) { exit 0 }
            $parts += $directory
        } else {
            if ($existing.Count -eq 0) { exit 0 }
            $parts = @($parts | Where-Object { $_.Trim().Trim('"').TrimEnd('\') -ine $directory.TrimEnd('\') })
        }
        $kind = if ($previous -eq '') { [Microsoft.Win32.RegistryValueKind]::ExpandString } else { $key.GetValueKind('Path') }
        $key.SetValue('Path', ($parts -join ';'), $kind)
    } finally { if ($key) { $key.Dispose() } }
} catch {
    Write-Error $_
    exit 1
}
