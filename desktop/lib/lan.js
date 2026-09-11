const os = require("os");

function isLanIPv4(addr) {
  if (!addr || addr.startsWith("127.") || addr.startsWith("169.254.")) {
    return false;
  }
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(addr)) {
    return false;
  }
  return true;
}

function scoreLan(addr) {
  if (addr.startsWith("192.168.")) {
    return 0;
  }
  if (addr.startsWith("10.")) {
    return 1;
  }
  return 2;
}

function lanIPv4() {
  const found = [];
  const nics = os.networkInterfaces();
  for (const rows of Object.values(nics)) {
    for (const row of rows || []) {
      if ((row.family === "IPv4" || row.family === 4) && !row.internal && isLanIPv4(row.address)) {
        found.push(row.address);
      }
    }
  }
  found.sort((a, b) => scoreLan(a) - scoreLan(b));
  return found[0] || "";
}

module.exports = { lanIPv4 };
