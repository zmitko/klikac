const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function provisionSerial({ port, wifiSsid, wifiPassword, mqttHost, force, onLine }) {
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
    force ? "KCFG FORCE" : "KCFG APPLY",
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
$ready = $false
$waitUntil = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $waitUntil) {
  try {
    $line = $p.ReadLine()
    if ($line) { Write-Output $line }
    if ($line -match "klikac firmware") { $ready = $true }
    if ($ready -and $line -match "USB HID|Wi-Fi|KCFG") { break }
  } catch { }
}
if (-not $ready) {
  $p.Close()
  Write-Output "KLOG no-banner"
  exit 0
}
Get-Content -LiteralPath $cmdPath -Encoding UTF8 | ForEach-Object {
  $p.WriteLine($_)
  Start-Sleep -Milliseconds 300
}
$gotApply = $false
$gotSaved = $false
$nvsFail = $false
$emptyFail = $false
$end = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $end) {
  try {
    $line = $p.ReadLine()
    if ($line) { Write-Output $line }
    if ($line -match "klikac firmware") { $ready = $true }
    if ($line -match "KLOG apply") { $gotApply = $true }
    if ($line -match "KLOG apply-empty") { $emptyFail = $true; break }
    if ($line -match "KLOG apply-nvs-fail|KLOG nvs-save-fail|KLOG nvs-verify-fail") { $nvsFail = $true; break }
    if ($line -match "KLOG (flash-)?saved mqtt=" -and $line -notmatch "\\(empty\\)") { $gotSaved = $true }
    if ($line -match "abort\(\)") { $nvsFail = $true }
    if ($line -match "KLOG restart") { break }
  } catch { }
}
$p.Close()
if ($gotSaved) { $nvsFail = $false }
if ($emptyFail) { Write-Output "KLOG no-ssid" }
if ($nvsFail) { Write-Output "KLOG nvs-fail" }
if (-not $gotApply -and -not $gotSaved -and -not $nvsFail -and -not $emptyFail) { Write-Output "KLOG no-apply" }
if (-not $gotSaved -and -not $nvsFail -and -not $emptyFail) { Write-Output "KLOG no-persist" }
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
  if (/KLOG apply-empty|KLOG no-ssid/.test(out)) {
    throw new Error("SSID nebo IP se na destičku nedostaly. Zkontroluj Wi-Fi v GUI a zkus USB init znovu.");
  }
  if (/KLOG nvs-fail|KLOG apply-nvs-fail|KLOG nvs-save-fail|KLOG nvs-verify-fail/.test(out)) {
    const err = new Error("Destička nedokázala uložit Wi-Fi/MQTT do paměti.");
    err.code = "NVS_FAIL";
    throw err;
  }
  if (/KLOG no-apply/.test(out)) {
    if (/KLOG wifi-ok|flash-fallback|abort\(\)|KLOG saved wifi=\(empty\)/.test(out)) {
      const err = new Error("Destička nedokázala uložit Wi-Fi/MQTT do paměti.");
      err.code = "NVS_FAIL";
      throw err;
    }
    throw new Error("Destička nepřijala KCFG APPLY. Zkus USB init znovu.");
  }
  if (/KLOG no-persist/.test(out)) {
    const err = new Error("Wi-Fi/MQTT se do destičky nezapsalo. Zkus USB init znovu.");
    err.code = "NVS_FAIL";
    throw err;
  }
}

module.exports = { provisionSerial };
