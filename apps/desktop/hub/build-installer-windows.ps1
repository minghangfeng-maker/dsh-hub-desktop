<#
  Compile the NSIS installer interface on the Windows build host.

  `hub-build.sh --installer` runs this from WSL so its electron-builder run can
  embed the MSVC-built `window-frame.dll` and the GDI+-rendered setup bitmaps.
  The assets land in the target build directory of the checkout this script is
  run from, which a WSL build reaches over its UNC path.
#>
[CmdletBinding()]
param([string]$OutputDirectory)
$ErrorActionPreference = 'Stop'
$desktopRoot = Split-Path -Parent $PSScriptRoot
if (-not $OutputDirectory) {
  $OutputDirectory = Join-Path $desktopRoot '.desktop-build/targets/win-x64/installer-ui'
}
$output = [IO.Path]::GetFullPath($OutputDirectory)
& (Join-Path $desktopRoot 'scripts/prepare-windows-installer.ps1') -OutputDirectory $output
foreach ($asset in @('window-frame.dll', 'brand.bmp', 'brand-2x.bmp', 'brand-dark.bmp', 'brand-dark-2x.bmp', 'uninstaller-sidebar.bmp')) {
  $path = Join-Path $output $asset
  if (-not (Test-Path -LiteralPath $path)) { throw "Installer interface asset is missing: $path" }
  Write-Output ("hub-installer-ui: {0} {1} bytes" -f $asset, (Get-Item -LiteralPath $path).Length)
}
