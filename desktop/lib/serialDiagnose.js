const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

const WIFI_STA = {
  0: "idle",
  1: "síť v éteru není",
  2: "scan hotový",
  3: "připojená",
  4: "špatné heslo / odmítnuto",
  5: "spojení ztracené",
  6: "odpojená",
};

function lastMatch(text, re) {
  const all = [...String(text || "").matchAll(re)];
  if (!all.length) {
    return "";
  }
  return (all[all.length - 1][1] || "").trim();
}

function interpretDiagnose(lines) {
  const text = Array.isArray(lines) ? lines.join("\n") : String(lines || "");
  const firmware = lastMatch(text, /klikac firmware\s+(\S+)/g) || lastMatch(text, /KLOG fw=(\S+)/g);
  const wifi = lastMatch(text, /KLOG wifi=(.+)$/gm) || lastMatch(text, /KLOG cfg-(?:flash 0x\S+|part) wifi=(.+) mqtt=/gm);
  const mqtt = lastMatch(text, /KLOG mqtt=(.+)$/gm);
  const wifiSta = lastMatch(text, /KLOG wifi-sta=(\d+)/g);
  const wifiIp = lastMatch(text, /KLOG wifi-ip=(\S+)/g);
  const mqttRc = lastMatch(text, /(?:MQTT failed, rc=|KLOG mqtt-rc=)(-?\d+)/g);
  const mqttOk = /MQTT connected/.test(text);
  const cfgStore = lastMatch(text, /KLOG cfg-store (\S+)/g);
  // Destičky nahrané verzí do 1.1.3 mají tabulku oddílů bez klikcfg (a bez
  // slotů pro Wi-Fi OTA). Zachrání je jen jedno nahrání přes USB.
  const oldPartitions = /KLOG cfg-part-missing/.test(text);
  const emptyWifi = !wifi || wifi === "(empty)" || /Wi-Fi čeká na USB/.test(text);
  const noBanner = /KLOG no-banner/.test(text) || !/klikac firmware/.test(text);

  let hint;
  if (noBanner) {
    hint = "Destička na COM nemluví. Programovací USB (CH343), ne HID. Případně drž BOOT.";
  } else if (emptyWifi) {
    if (oldPartitions) {
      hint = "Destička má starou tabulku oddílů (chybí klikcfg), proto se Wi-Fi neuloží a Wi-Fi OTA nefunguje. Nech COM zapojený a dej USB inicializaci s Vynutit zápis — nahraje se firmware i tabulka oddílů.";
    } else if (/KLOG cfg-none|KLOG flash-try|KLOG cfg-part-read/.test(text)) {
      hint = "Firmware běží, ale cfg v oddílu klikcfg nenašel (wifi prázdná). Dej USB inicializaci s Vynutit zápis, COM nech zapojený.";
    } else {
      hint = "V destičce není Wi-Fi. Force zápis na COM a nech kabel, dokud v logu nebude „destička na brokeru“.";
    }
  } else if (oldPartitions) {
    hint = "Destička jede se starou tabulkou oddílů (chybí klikcfg i sloty pro Wi-Fi OTA). Wi-Fi má, ale příští firmware jí dej přes USB s Vynutit zápis.";
  } else if (wifiSta === "1") {
    hint = `SSID „${wifi}“ destička nevidí. Musí to být 2,4 GHz (ne 5 GHz, ne host), stejný název včetně apostrofu.`;
  } else if (wifiSta === "4") {
    hint = `Síť „${wifi}“ destičku odmítla — špatné heslo, nebo je to 5 GHz se stejným jménem.`;
  } else if (mqttOk) {
    hint = "Destička už je na MQTT. COM můžeš odpojit a HID dát do herního PC.";
  } else if (wifiSta === "3" || /Wi-Fi (boot|start|after-usb|reconnect) /.test(text)) {
    hint = `Wi-Fi bere, MQTT na ${mqtt || "?"} ne. Zkontroluj IP PC1 (ipconfig) a firewall port 1883.`;
  } else {
    hint = "Destička má cfg, ale na Wi-Fi/MQTT ještě nedorazila. Nech COM 20 s a čti znovu.";
  }

  return {
    firmware,
    wifi: emptyWifi ? "" : wifi,
    mqtt: mqtt === "(empty)" ? "" : mqtt,
    wifiSta,
    wifiStaLabel: WIFI_STA[wifiSta] || "",
    wifiIp: wifiIp && wifiIp !== "0.0.0.0" ? wifiIp : "",
    mqttRc,
    mqttOk,
    cfgStore,
    oldPartitions,
    emptyWifi,
    noBanner,
    hint,
  };
}

async function diagnoseSerial({ port, onLine }) {
  const dir = path.join(process.env.TEMP || ".", "klikac");
  fs.mkdirSync(dir, { recursive: true });
  const psFile = path.join(dir, "kdiag.ps1");
  const script = `
$ErrorActionPreference = "Stop"
$portName = "${port}"
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
$waitUntil = (Get-Date).AddSeconds(16)
while ((Get-Date) -lt $waitUntil) {
  try {
    $line = $p.ReadLine()
    if ($line) { Write-Output $line }
    if ($line -match "klikac firmware") { $ready = $true }
  } catch { }
}
if ($ready) {
  $p.WriteLine("KCFG STATUS")
  $tail = (Get-Date).AddSeconds(4)
  while ((Get-Date) -lt $tail) {
    try {
      $line = $p.ReadLine()
      if ($line) { Write-Output $line }
    } catch { }
  }
} else {
  Write-Output "KLOG no-banner"
}
$p.Close()
`;
  fs.writeFileSync(psFile, script, "utf8");
  const { stdout, stderr } = await execFileAsync("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy", "Bypass",
    "-File",
    psFile,
  ], {
    windowsHide: true,
    timeout: 40000,
  });
  const out = `${stdout || ""}\n${stderr || ""}`;
  const lines = out.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  lines.forEach((line) => {
    if (typeof onLine === "function") {
      onLine(line);
    }
  });
  return interpretDiagnose(lines);
}

module.exports = { diagnoseSerial, interpretDiagnose };
