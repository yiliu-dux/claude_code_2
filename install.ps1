# Packages this folder into claude-lite.vsix (no node/vsce needed) and installs it into VS Code.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$pkg = Get-Content "$root\package.json" -Raw | ConvertFrom-Json
$vsix = Join-Path $root "claude-lite-$($pkg.version).vsix"

$manifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="$($pkg.name)" Version="$($pkg.version)" Publisher="$($pkg.publisher)" />
    <DisplayName>$($pkg.displayName)</DisplayName>
    <Description xml:space="preserve">$($pkg.description)</Description>
    <Icon>extension/icon.png</Icon>
    <Categories>Other</Categories>
    <Properties><Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($pkg.engines.vscode)" /></Properties>
  </Metadata>
  <Installation><InstallationTarget Id="Microsoft.VisualStudio.Code" /></Installation>
  <Dependencies />
  <Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" /><Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/icon.png" Addressable="true" /></Assets>
</PackageManifest>
"@
$types = '<?xml version="1.0" encoding="utf-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".vsixmanifest" ContentType="text/xml" /><Default Extension=".md" ContentType="text/markdown" /><Default Extension=".html" ContentType="text/html" /><Default Extension=".css" ContentType="text/css" /><Default Extension=".png" ContentType="image/png" /></Types>'

Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
if (Test-Path $vsix) { Remove-Item $vsix }
$zip = [System.IO.Compression.ZipFile]::Open($vsix, 'Create')
function Add-Text($name, $text) {
  $w = New-Object System.IO.StreamWriter($zip.CreateEntry($name).Open(), (New-Object System.Text.UTF8Encoding($false)))
  $w.Write($text); $w.Dispose()
}
try {
  Add-Text 'extension.vsixmanifest' $manifest
  Add-Text '[Content_Types].xml' $types
  foreach ($f in 'package.json', 'icon.png', 'extension.js', 'README.md', 'media/webview.html', 'media/webview.css', 'media/webview.js') {
    if (Test-Path "$root\$f") { [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, "$root\$f", "extension/$f") }
  }
} finally { $zip.Dispose() }

Write-Host "Built $vsix"
code --install-extension $vsix --force
Write-Host 'Installed. Run "Developer: Reload Window" in VS Code, then "Claude Lite: New Chat" (Ctrl+Alt+N).'
