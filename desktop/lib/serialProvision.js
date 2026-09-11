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
Start-Sleep -Milliseconds 800
$ready = $false
$drainUntil = (Get-Date).AddSeconds(3)
while ((Get-Date) -lt $drainUntil) {
  try {
    $line = $p.ReadLine()
    if ($line) { Write-Output $line }
    if ($line -match "klikac firmware") { $ready = $true }
  } catch { }
}
Get-Content -LiteralPath $cmdPath | ForEach-Object {
  $p.WriteLine($_)
  Start-Sleep -Milliseconds 200
}
$gotApply = $false
$gotSaved = $false
$end = (Get-Date).AddSeconds(25)
while ((Get-Date) -lt $end) {
  try {
    $line = $p.ReadLine()
    if ($line) { Write-Output $line }
    if ($line -match "klikac firmware") { $ready = $true }
    if ($line -match "KLOG apply") { $gotApply = $true }
    if ($line -match "KLOG apply-nvs-fail") { Write-Output $line; break }
    if ($line -match "KLOG saved mqtt=" -and $line -notmatch "\(empty\)") { $gotSaved = $true; break }
  } catch { }
}
$p.Close()
if (-not $gotSaved -and -not $ready) { Write-Output "KLOG no-banner" }
if (-not $gotApply -and -not $gotSaved) { Write-Output "KLOG no-apply" }
if (-not $gotSaved) { Write-Output "KLOG no-persist" }
`;
  fs.writeFileSync(psFile, script, "utf8");
  const { stdout, stderr } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File", psFile,
  ], {
    windowsHide: true,
    timeout: 60000,
  });
  const out = `${stdout || ""}\n${stderr || ""}`;
  out.split(/\r?\n/).forEach((line) => {
    if (line.trim() && typeof onLine === "function") {
      onLine(line.trim());
    }
  });
  await sleep(200);
  if (/KLOG no-banner/.test(out)) {
    const err = new Error("Destička na COM neodpověděla. Zkontroluj programovací USB a že běží firmware.");
    err.code = "NO_BANNER";
    throw err;
  }
  if (/KLOG apply-nvs-fail|KLOG nvs-save-fail|KLOG nvs-verify-fail/.test(out)) {
    throw new Error("Destička nedokázala uložit Wi-Fi/MQTT do paměti.");
  }
  if (/KLOG no-apply/.test(out)) {
    throw new Error("Destička nepřijala KCFG APPLY. Zkus USB init znovu.");
  }
  if (/KLOG no-persist/.test(out)) {
    throw new Error("Wi-Fi/MQTT se do destičky nezapsalo. Zkus USB init znovu.");
  }
}

module.exports = { provisionSerial };
