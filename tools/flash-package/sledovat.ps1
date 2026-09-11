param(
    [Parameter(Position = 0)]
    [string]$Port
)

$ErrorActionPreference = "Stop"

function Get-MonitorPort {
    param([string]$Requested)
    $all = @()
    Get-CimInstance Win32_PnPEntity -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "\(COM\d+\)" } | ForEach-Object {
        if ($_.Name -match "(COM\d+)") {
            $all += [pscustomobject]@{ Port = $Matches[1]; Name = $_.Name }
        }
    }
    if ($Requested) {
        $norm = $Requested.ToUpperInvariant()
        if ($norm -notmatch "^COM") { $norm = "COM$norm" }
        $hit = $all | Where-Object { $_.Port -eq $norm } | Select-Object -First 1
        if (-not $hit) { throw "Port $norm neni." }
        return $hit
    }
    $usb = @($all | Where-Object { $_.Name -match "CH34|CP210|FTDI|USB-SERIAL|USB Serial|WCH" })
    if ($usb.Count -ge 1) { return $usb[0] }
    if ($all.Count -ge 1) { return $all[0] }
    throw "Zadny COM."
}

$chosen = Get-MonitorPort -Requested $Port
Write-Host ("Sleduji {0} ({1})" -f $chosen.Port, $chosen.Name)
$serial = New-Object System.IO.Ports.SerialPort $chosen.Port, 115200, None, 8, One
$serial.NewLine = "`n"
$serial.ReadTimeout = 1000
$serial.DtrEnable = $false
$serial.RtsEnable = $false
$serial.Open()
try {
    while ($true) {
        try {
            $line = $serial.ReadLine()
            if ($line) { Write-Host $line }
        } catch {}
    }
} finally {
    $serial.DtrEnable = $false
    $serial.RtsEnable = $false
    if ($serial.IsOpen) { $serial.Close() }
}
