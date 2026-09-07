const os = require("os");

function lanIPv4() {
  const nics = os.networkInterfaces();
  for (const rows of Object.values(nics)) {
    for (const row of rows || []) {
      if ((row.family === "IPv4" || row.family === 4) && !row.internal) {
        return row.address;
      }
    }
  }
  return "";
}

module.exports = { lanIPv4 };
