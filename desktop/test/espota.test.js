const test = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("dgram");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { pushFirmware } = require("../lib/espota");
const { OTA_HTTP_PORT, OTA_ESPOTA_PORT } = require("../lib/klikacPorts");

test("OTA porty jsou pevné", () => {
  assert.equal(OTA_HTTP_PORT, 18080);
  assert.equal(OTA_ESPOTA_PORT, 18232);
});

test("espota: po OK bez TCP spojení skončí timeoutem", { timeout: 25000 }, async () => {
  const udp = dgram.createSocket("udp4");
  try {
    await new Promise((resolve, reject) => {
      udp.once("error", reject);
      udp.bind(3232, "127.0.0.1", resolve);
    });
  } catch (err) {
    udp.close();
    if (err && (err.code === "EADDRINUSE" || err.code === "EACCES")) {
      return;
    }
    throw err;
  }
  udp.on("message", (msg, rinfo) => {
    udp.send(Buffer.from("OK\n"), rinfo.port, rinfo.address);
  });
  const tmp = path.join(os.tmpdir(), "klikac-ota-timeout.bin");
  fs.writeFileSync(tmp, Buffer.alloc(2048, 1));
  await assert.rejects(
    () => pushFirmware({
      host: "127.0.0.1",
      password: "klikac-ota",
      filePath: tmp,
      listenPort: 18239,
    }),
    /firewall|nepřipojila/,
  );
  udp.close();
});
