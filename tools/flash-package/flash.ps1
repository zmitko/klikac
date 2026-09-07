param(
    [Parameter(Position = 0)]
    [string]$Port,
    [switch]$ListPorts
)

$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$WorkDir = Join-Path $env:TEMP "esp32kbd-flash"
$Images = @(
    @{ Offset = "0x0000"; File = "bootloader.bin" }
    @{ Offset = "0x8000"; File = "partitions.bin" }
    @{ Offset = "0xe000"; File = "boot_app0.bin" }
    @{ Offset = "0x10000"; File = "firmware.bin" }
)
$Preferred = @(
    "CH343", "CH340", "CH341", "CP210", "CP2102", "FT232", "FTDI",
    "USB-SERIAL", "USB Serial", "USB JTAG", "Silicon Labs", "QinHeng", "WCH",
    "Espressif"
)

function Fail {
    param([string]$Message)
    Write-Host ""
    Write-Host $Message
    exit 1
}

function Get-ComPorts {
    $map = @{}
    try {
        $key = Get-ItemProperty -Path "HKLM:\HARDWARE\DEVICEMAP\SERIALCOMM" -ErrorAction SilentlyContinue
        if ($key) {
            $key.PSObject.Properties | Where-Object { $_.Name -notlike "PS*" } | ForEach-Object {
                $p = [string]$_.Value
                if ($p -match "^COM\d+$") { $map[$p] = $p }
            }
        }
    } catch {}
    try {
        [System.IO.Ports.SerialPort]::GetPortNames() | ForEach-Object {
            if ($_ -match "^COM\d+$") { $map[$_] = $_ }
        }
    } catch {}
    try {
        Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "\(COM\d+\)" } | ForEach-Object {
            if ($_.Name -match "(COM\d+)") { $map[$Matches[1]] = $_.Name }
        }
    } catch {}
    try {
        Get-PnpDevice -Class Ports -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.FriendlyName -match "(COM\d+)") { $map[$Matches[1]] = $_.FriendlyName }
        }
    } catch {}

    $list = @()
    foreach ($p in ($map.Keys | Sort-Object { [int]($_ -replace "\D", "") })) {
        $list += [pscustomobject]@{ Port = $p; Name = $map[$p] }
    }
    return @($list)
}

function Write-PortList {
    param($all)
    if ($all.Count -eq 0) {
        Write-Host "Windows ted nevidi zadny COM port."
        return
    }
    Write-Host "COM porty v systemu:"
    $all | ForEach-Object { Write-Host ("  {0,-8} {1}" -f $_.Port, $_.Name) }
}

function Test-PreferredPort($name) {
    foreach ($token in $Preferred) {
        if ($name -like "*$token*") { return $true }
    }
    return $false
}

function Resolve-Port {
    param([string]$Requested)
    $all = Get-ComPorts
    if ($ListPorts -or $Requested -eq "list") {
        Write-PortList $all
        exit 0
    }
    if ($Requested) {
        $norm = $Requested.ToUpperInvariant()
        if ($norm -notmatch "^COM") { $norm = "COM$norm" }
        $match = $all | Where-Object { $_.Port -eq $norm } | Select-Object -First 1
        if (-not $match) {
            Write-PortList $all
            Fail "Port $norm neni v systemu."
        }
        return $match
    }
    $usb = @($all | Where-Object { Test-PreferredPort $_.Name })
    if ($usb.Count -eq 1) { return $usb[0] }
    if ($usb.Count -gt 1) {
        $usb | ForEach-Object { Write-Host ("  nahrat-firmware.bat {0}     ({1})" -f $_.Port, $_.Name) }
        Fail "Vic USB serial portu, zadej konkretni COM."
    }
    $other = @($all | Where-Object { $_.Port -ne "COM1" })
    if ($other.Count -eq 1) { return $other[0] }
    if ($other.Count -gt 1) {
        $other | ForEach-Object { Write-Host ("  nahrat-firmware.bat {0}     ({1})" -f $_.Port, $_.Name) }
        Fail "Vic COM portu, zadej konkretni."
    }
    Write-PortList $all
    Fail "Nenasel se programovaci COM. Zapoj CH343, nebo BOOT+RESET na HID USB."
}

function Initialize-WorkDir {
    if (Test-Path $WorkDir) {
        Remove-Item $WorkDir -Recurse -Force
    }
    New-Item -ItemType Directory -Path $WorkDir | Out-Null
    $srcTool = Join-Path $Root "tools\esptool.exe"
    $srcFw = Join-Path $Root "firmware"
    if (-not (Test-Path $srcTool)) {
        Fail "Chybi tools\esptool.exe"
    }
    Copy-Item $srcTool (Join-Path $WorkDir "esptool.exe")
    foreach ($img in $Images) {
        $src = Join-Path $srcFw $img.File
        if (-not (Test-Path $src)) {
            Fail "Chybi firmware\$($img.File)"
        }
        Copy-Item $src (Join-Path $WorkDir $img.File)
    }
}

function Invoke-Esptool {
    param([string]$ComPort, [int]$Baud, [string]$Before)
    $exe = Join-Path $WorkDir "esptool.exe"
    $argList = @(
        "--chip", "esp32s3",
        "--port", $ComPort,
        "--baud", "$Baud",
        "--before", $Before,
        "--after", "hard_reset",
        "write_flash", "-z",
        "--flash_mode", "dio",
        "--flash_freq", "80m",
        "--flash_size", "16MB"
    )
    foreach ($img in $Images) {
        $argList += $img.Offset
        $argList += (Join-Path $WorkDir $img.File)
    }

    $stdout = Join-Path $WorkDir "esptool-out.txt"
    $stderr = Join-Path $WorkDir "esptool-err.txt"
    Remove-Item $stdout, $stderr -ErrorAction SilentlyContinue

    Write-Host ("esptool --port {0} --baud {1} --before {2}" -f $ComPort, $Baud, $Before)
    $proc = Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $WorkDir -Wait -PassThru -NoNewWindow -RedirectStandardOutput $stdout -RedirectStandardError $stderr
    if (Test-Path $stdout) { Get-Content $stdout | ForEach-Object { Write-Host $_ } }
    if (Test-Path $stderr) { Get-Content $stderr | ForEach-Object { Write-Host $_ } }
    return [int]$proc.ExitCode
}

Initialize-WorkDir
$chosen = Resolve-Port -Requested $Port
Write-Host ""
Write-Host "ESP32-S3 firmware nahravani"
Write-Host ("Port : {0}  ({1})" -f $chosen.Port, $chosen.Name)
Write-Host ("Work : {0}" -f $WorkDir)
Write-Host ""

$isCh343 = $chosen.Name -like "*CH34*"
if ($isCh343) {
    $attempts = @(
        @{ Baud = 460800; Before = "default_reset" },
        @{ Baud = 115200; Before = "default_reset" },
        @{ Baud = 115200; Before = "no_reset" }
    )
} else {
    $attempts = @(
        @{ Baud = 460800; Before = "usb_reset" },
        @{ Baud = 115200; Before = "no_reset" },
        @{ Baud = 115200; Before = "default_reset" }
    )
}

$exitCode = 1
foreach ($try in $attempts) {
    if ($try.Before -eq "no_reset") {
        Write-Host ""
        Write-Host "Ted drz BOOT, kratce stiskni RESET, BOOT drz dal, Enter v tomhle okne."
        Read-Host "Potvrd Enter az je deska v download mode"
    }
    $exitCode = Invoke-Esptool -ComPort $chosen.Port -Baud $try.Baud -Before $try.Before
    if ($exitCode -eq 0) { break }
    Write-Host ("Konec, exit code {0}" -f $exitCode)
    Write-Host ""
}

if ($exitCode -ne 0) {
    Write-Host "Nahrani selhalo, posledni kod $exitCode."
    Write-Host "Log je v $WorkDir"
    exit $exitCode
}

Write-Host ""
Write-Host "Hotovo. HID klavesnice se na chvili odpoji a zase pripoji."
Write-Host "Enter z HA ted uz deska umi."
exit 0
