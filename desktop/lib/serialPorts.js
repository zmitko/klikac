const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileAsync = promisify(execFile);

function parseJson(raw) {
  const text = String(raw || "").trim();
  if (!text) {
    return [];
  }
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

async function listSerialPorts() {
  const script = [
    "$ports = @()",
    "$ports += Get-CimInstance Win32_SerialPort -ErrorAction SilentlyContinue | ForEach-Object {",
    "  [pscustomobject]@{ path = $_.DeviceID; name = $_.Name; hint = $_.Description }",
    "}",
    "Get-PnpDevice -Class Ports -Status OK -ErrorAction SilentlyContinue | ForEach-Object {",
    "  if ($_.Name -match '(COM\\d+)') {",
    "    $ports += [pscustomobject]@{ path = $Matches[1]; name = $_.Name; hint = $_.InstanceId }",
    "  }",
    "}",
    "$ports | Sort-Object path -Unique | ConvertTo-Json -Compress",
  ].join("; ");
  try {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-Command",
      script,
    ], {
      windowsHide: true,
      timeout: 12000,
    });
    return parseJson(stdout).map((row) => ({
      path: String(row.path || "").toUpperCase(),
      name: String(row.name || ""),
      hint: String(row.hint || ""),
    })).filter((row) => /^COM\d+$/i.test(row.path));
  } catch {
    return [];
  }
}

function pickFlashPort(ports) {
  const ranked = [...ports].sort((a, b) => {
    const score = (p) => {
      const hay = `${p.name} ${p.hint} ${p.path}`.toUpperCase();
      if (hay.includes("CH343") || hay.includes("CH340") || hay.includes("CH910")) {
        return 0;
      }
      if (hay.includes("CP210") || hay.includes("SILICON") || hay.includes("USB-SERIAL")) {
        return 1;
      }
      return 5;
    };
    return score(a) - score(b);
  });
  return ranked[0] || null;
}

module.exports = { listSerialPorts, pickFlashPort };
