param(
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$EnvName = "esp32-s3-n16r8"
$EsptoolUrl = "https://github.com/espressif/esptool/releases/download/v4.8.1/esptool-v4.8.1-win64.zip"
$BuildDir = Join-Path $RepoRoot ".pio\build\$EnvName"
$OutDir = Join-Path $RepoRoot "dist\esp32-flash"
$CacheDir = Join-Path $RepoRoot "tools\cache"
$TemplateDir = Join-Path $RepoRoot "tools\flash-package"
$BootApp0 = Join-Path $env:USERPROFILE ".platformio\packages\framework-arduinoespressif32\tools\partitions\boot_app0.bin"

function Get-Pio {
    $cmd = Get-Command pio -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }
    $fallback = Join-Path $env:USERPROFILE ".platformio\penv\Scripts\pio.exe"
    if (Test-Path $fallback) {
        return $fallback
    }
    throw "PlatformIO (pio) neni v PATH. Nainstaluj PlatformIO a spust znovu."
}

function Invoke-PioBuild {
    param([string]$ProjectDir, [string]$PioExe)
    Write-Host "Sestavuji firmware ($EnvName)..."
    cmd.exe /c "pushd `"$ProjectDir`" && `"$PioExe`" run -e $EnvName"
    if ($LASTEXITCODE -ne 0) {
        throw "Build selhal. Kod: $LASTEXITCODE"
    }
}

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

if (-not $SkipBuild) {
    Invoke-PioBuild -ProjectDir $RepoRoot -PioExe (Get-Pio)
}

$required = @(
    (Join-Path $BuildDir "firmware.bin"),
    (Join-Path $BuildDir "bootloader.bin"),
    (Join-Path $BuildDir "partitions.bin")
)
foreach ($file in $required) {
    if (-not (Test-Path $file)) {
        throw "Chybi $file. Spust bez -SkipBuild."
    }
}
if (-not (Test-Path $BootApp0)) {
    throw "Chybi boot_app0.bin: $BootApp0"
}

$zipPath = Join-Path $CacheDir "esptool-v4.8.1-win64.zip"
if (-not (Test-Path $zipPath)) {
    Write-Host "Stahuji esptool (jednou, do tools\cache)..."
    Invoke-WebRequest -Uri $EsptoolUrl -OutFile $zipPath -UseBasicParsing
}

$extractDir = Join-Path $CacheDir "esptool-win64"
$cachedExe = Get-ChildItem -Path $extractDir -Recurse -Filter "esptool.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $cachedExe) {
    if (Test-Path $extractDir) {
        Remove-Item $extractDir -Recurse -Force
    }
    Expand-Archive -Path $zipPath -DestinationPath $extractDir -Force
}

$esptoolExe = Get-ChildItem -Path $extractDir -Recurse -Filter "esptool.exe" | Select-Object -First 1
if (-not $esptoolExe) {
    throw "V archivu esptool.exe neni."
}

if (Test-Path $OutDir) {
    Remove-Item $OutDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir "firmware") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutDir "tools") | Out-Null

Copy-Item (Join-Path $BuildDir "firmware.bin") (Join-Path $OutDir "firmware\firmware.bin")
Copy-Item (Join-Path $BuildDir "bootloader.bin") (Join-Path $OutDir "firmware\bootloader.bin")
Copy-Item (Join-Path $BuildDir "partitions.bin") (Join-Path $OutDir "firmware\partitions.bin")
Copy-Item $BootApp0 (Join-Path $OutDir "firmware\boot_app0.bin")
Copy-Item $esptoolExe.FullName (Join-Path $OutDir "tools\esptool.exe")
Copy-Item (Join-Path $TemplateDir "flash.ps1") (Join-Path $OutDir "flash.ps1") -Force
Copy-Item (Join-Path $TemplateDir "nahrat-firmware.bat") (Join-Path $OutDir "nahrat-firmware.bat") -Force

# PowerShell 5.1 on Czech Windows treats UTF-8 without BOM as CP1250 and breaks the script.
$utf8Bom = New-Object System.Text.UTF8Encoding $true
$ps1Dest = Join-Path $OutDir "flash.ps1"
[System.IO.File]::WriteAllText($ps1Dest, [System.IO.File]::ReadAllText($ps1Dest), $utf8Bom)

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
$fwSize = (Get-Item (Join-Path $OutDir "firmware\firmware.bin")).Length
@(
    "ESP32-S3 keyboard firmware",
    "Sestaveno: $stamp",
    "firmware.bin: $fwSize B",
    "",
    "Na cilovem PC:",
    "  1. Zapoj programovaci USB (CH343 / UART). HID muze zustat v hernim PC.",
    "  2. Spust nahrat-firmware.bat",
    "  3. Kdyz Windows nenasel port: nahrat-firmware.bat list",
    "     pak treba: nahrat-firmware.bat COM5",
    "",
    "Kdyz nahrani hlasi Failed to connect:",
    "  drz BOOT, kratce stiskni RESET, pust BOOT, spust znovu."
) | Set-Content -Path (Join-Path $OutDir "CTI_ME.txt") -Encoding UTF8

$zipOut = Join-Path $RepoRoot "dist\esp32-flash.zip"
if (Test-Path $zipOut) {
    Remove-Item $zipOut -Force
}
Compress-Archive -Path $OutDir -DestinationPath $zipOut -CompressionLevel Fastest

Write-Host ""
Write-Host "Balicek je hotovy:"
Write-Host "  $OutDir"
Write-Host "  $zipOut"
Write-Host ""
Write-Host "Zkopiruj slozku nebo ZIP na cilove PC a spust nahrat-firmware.bat"
