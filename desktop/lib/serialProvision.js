const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function provisionSerial({ port, wifiSsid, wifiPassword, mqttHost, onLine }) {
  const ssid = String(wifiSsid || "").replace(/[\r\n]/g, "");
  const pass = String(wifiPassword || "").replace(/[\r\n]/g, "");
  const mqtt = String(mqttHost || "").replace(/[\r\n]/g, "");
  if (!ssid || !mqtt) {
    throw new Error("Chybí Wi-Fi SSID nebo IP tohoto PC");
  }
  const dir = path.join(process.env.TEMP || ".", "klikac");
  fs.mkdirSync(dir, { recursive: true });
  const cmdFile = path.join(dir, "kcfg.txt");
  const psFile = path.join(dir, "kcfg.ps1");
  const lines = [
    `KCFG WIFI ${ssid}`,
    `KCFG PASS ${pass}`,
    `KCFG MQTT ${mqtt}`,
    "KCFG APPLY",
  ];
  fs.writeFileSync(cmdFile, `${lines.join("\n")}\n`, "utf8");
  const script = `
$ErrorActionPreference = "Stop"
$portName = "${port}"
$cmdPath = "${cmdFile.replace(/\\/g, "\\\\")}"
$p = New-Object System.IO.Ports.SerialPort $portName, 115200, None, 8, One
$p.NewLine = "\`n"
$p.ReadTimeout = 400
$p.WriteTimeout = 2000
$p.DtrEnable = $false
$p.RtsEnable = $true
$p.Open()
Start-Sleep -Milliseconds 120
$p.RtsEnable = $false
Start-Sleep -Milliseconds 1500
$deadline = (Get-Date).AddSeconds(16)
$ready = $false
while ((Get-Date) -lt $deadline) {
  try {
    $line = $p.ReadLine()
    if ($line) { Write-Output $line }
    if ($line -match "klikac firmware") { $ready = $true }
    if ($ready -and $line -match "KLOG mqtt=|Wi-Fi") { break }
  } catch { }
}
Get-Content -LiteralPath $cmdPath | ForEach-Object {
  $p.WriteLine($_)
  Start-Sleep -Milliseconds 200
}
$gotApply = $false
$end = (Get-Date).AddSeconds(8)
while ((Get-Date) -lt $end) {
  try {
    $line = $p.ReadLine()
    if ($line) { Write-Output $line }
    if ($line -match "KLOG apply") { $gotApply = $true; break }
  } catch { }
}
$p.Close()
if (-not $ready) { Write-Output "KLOG no-banner" }
if (-not $gotApply) { Write-Output "KLOG no-apply" }
`;
  fs.writeFileSync(psFile, script, "utf8");
  const { stdout, stderr } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", psFile,
  ], {
    windowsHide: true,
    timeout: 35000,
  });
  const out = `${stdout || ""}\n${stderr || ""}`;
  out.split(/\r?\n/).forEach((line) => {
    if (line.trim() && typeof onLine === "function") {
      onLine(line.trim());
    }
  });
  await sleep(200);
}

module.exports = { provisionSerial };
