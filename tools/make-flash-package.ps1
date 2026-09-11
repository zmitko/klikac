param(
    [switch]$SkipBuild,
    [switch]$FromRelease
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
$Version = (Get-Content (Join-Path $RepoRoot "VERSION") -Raw).Trim()

function Get-Pio {
    $cmd = Get-Command pio -ErrorAction SilentlyContinue
    if ($cmd) {
        return $cmd.Source
    }
    $fallback = Join-Path $env:USERPROFILE ".platformio\penv\Scripts\pio.exe"
    if (Test-Path $fallback) {
        return $fallback
    }
    return $null
}

function Invoke-PioBuild {
    param([string]$ProjectDir, [string]$PioExe)
    Write-Host "Sestavuji firmware ($EnvName)..."
    cmd.exe /c "pushd `"$ProjectDir`" && `"$PioExe`" run -e $EnvName"
    if ($LASTEXITCODE -ne 0) {
        throw "Build selhal. Kod: $LASTEXITCODE"
    }
}

function Get-LanIPv4 {
    try {
        $row = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
            Where-Object { $_.IPAddress -like "192.168.*" -and -not $_.IPAddress.StartsWith("192.168.56.") } |
            Select-Object -First 1
        if ($row) { return $row.IPAddress }
    } catch {}
    return "192.168.1.109"
}

function Get-ReleaseFirmware {
    $fwDir = Join-Path $CacheDir "release-$Version"
    New-Item -ItemType Directory -Force -Path $fwDir | Out-Null
    $files = @("firmware.bin", "firmware-factory.bin")
    foreach ($name in $files) {
        $dest = Join-Path $fwDir $name
        if (Test-Path $dest) { continue }
        $url = "https://github.com/zmitko/klikac/releases/download/v$Version/$name"
        Write-Host "Stahuji $name z GitHub v$Version ..."
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    }
    return $fwDir
}

New-Item -ItemType Directory -Force -Path $CacheDir | Out-Null

$useRelease = [bool]$FromRelease
$pio = $null
if (-not $useRelease -and -not $SkipBuild) {
    $pio = Get-Pio
    if ($pio) {
        Invoke-PioBuild -ProjectDir $RepoRoot -PioExe $pio
    } else {
        Write-Host "PlatformIO neni, beru firmware z GitHub release v$Version."
        $useRelease = $true
    }
}

$factorySrc = $null
$firmwareSrc = $null
$bootloaderSrc = $null
$partitionsSrc = $null
$haveFour = $false

if (-not $useRelease) {
    $firmwareSrc = Join-Path $BuildDir "firmware.bin"
    $bootloaderSrc = Join-Path $BuildDir "bootloader.bin"
    $partitionsSrc = Join-Path $BuildDir "partitions.bin"
    $haveFour = (Test-Path $firmwareSrc) -and (Test-Path $bootloaderSrc) -and (Test-Path $partitionsSrc) -and (Test-Path $BootApp0)
    $merged = Join-Path $RepoRoot "dist-firmware\firmware-factory.bin"
    if (Test-Path $merged) { $factorySrc = $merged }
}

if (-not $haveFour -or $useRelease) {
    $rel = Get-ReleaseFirmware
    $factorySrc = Join-Path $rel "firmware-factory.bin"
    $firmwareSrc = Join-Path $rel "firmware.bin"
    $haveFour = $false
    if (-not (Test-Path $factorySrc)) {
        throw "Chybi firmware-factory.bin. Spust sestaveni nebo zkontroluj GitHub release v$Version."
    }
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

if ($haveFour) {
    Copy-Item $firmwareSrc (Join-Path $OutDir "firmware\firmware.bin")
    Copy-Item $bootloaderSrc (Join-Path $OutDir "firmware\bootloader.bin")
    Copy-Item $partitionsSrc (Join-Path $OutDir "firmware\partitions.bin")
    Copy-Item $BootApp0 (Join-Path $OutDir "firmware\boot_app0.bin")
}
if ($factorySrc -and (Test-Path $factorySrc)) {
    Copy-Item $factorySrc (Join-Path $OutDir "firmware\firmware-factory.bin")
}
Copy-Item $esptoolExe.FullName (Join-Path $OutDir "tools\esptool.exe")
Copy-Item (Join-Path $TemplateDir "flash.ps1") (Join-Path $OutDir "flash.ps1") -Force
Copy-Item (Join-Path $TemplateDir "nahrat-firmware.bat") (Join-Path $OutDir "nahrat-firmware.bat") -Force
Copy-Item (Join-Path $TemplateDir "klikac.cfg.example") (Join-Path $OutDir "klikac.cfg.example") -Force
if (Test-Path (Join-Path $TemplateDir "sledovat-desticku.bat")) {
    Copy-Item (Join-Path $TemplateDir "sledovat-desticku.bat") (Join-Path $OutDir "sledovat-desticku.bat") -Force
}
if (Test-Path (Join-Path $TemplateDir "sledovat.ps1")) {
    Copy-Item (Join-Path $TemplateDir "sledovat.ps1") (Join-Path $OutDir "sledovat.ps1") -Force
}

$utf8Bom = New-Object System.Text.UTF8Encoding $true
$ps1Dest = Join-Path $OutDir "flash.ps1"
[System.IO.File]::WriteAllText($ps1Dest, [System.IO.File]::ReadAllText($ps1Dest), $utf8Bom)

$mqtt = Get-LanIPv4
$cfgSrc = Join-Path $TemplateDir "klikac.cfg"
if (Test-Path $cfgSrc) {
    Copy-Item $cfgSrc (Join-Path $OutDir "klikac.cfg") -Force
} else {
    $cfgText = @"
# Wi-Fi desticky a IPv4 PC1, kde bezi Klikač.
WIFI=ZMITKOVI
PASS=
MQTT=$mqtt
"@
    [System.IO.File]::WriteAllText((Join-Path $OutDir "klikac.cfg"), $cfgText, $utf8Bom)
}

$stamp = Get-Date -Format "yyyy-MM-dd HH:mm"
@(
    "Klikač desticka $Version",
    "Sestaveno: $stamp",
    "",
    "Na hernim PC (nahore):",
    "  1. Uprav klikac.cfg - WIFI, heslo, MQTT = IP PC1 s Klikačem (ted $mqtt)",
    "  2. Klikač nech bezet na PC1",
    "  3. COM (CH343) zapoj do TOHOTO PC. HID muze zustat v hernim USB.",
    "  4. Spust nahrat-firmware.bat",
    "  5. Az napise, ze ma Wi-Fi v pameti: COM odpoj, HID nech v hernim PC",
    "",
    "Kdyz Windows nenasel port: nahrat-firmware.bat list",
    "pak treba: nahrat-firmware.bat COM5",
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
Write-Host "Dopln heslo v klikac.cfg, zkopiruj slozku nebo ZIP na herni PC, spust nahrat-firmware.bat"
