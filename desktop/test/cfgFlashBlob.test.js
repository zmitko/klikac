const test = require("node:test");
const assert = require("node:assert/strict");
const { buildCfgFlash, parseCfgFlash, CFG_FLASH_MAGIC, BLOB_SIZE } = require("../lib/cfgFlashBlob");

test("cfg blob: stejný layout jako firmware, apostrof v SSID", () => {
  const blob = buildCfgFlash({
    wifiSsid: "J'cob Route",
    wifiPassword: "secret12",
    mqttHost: "192.168.0.101",
  });
  assert.equal(blob.length, 4096);
  assert.equal(blob.readUInt32LE(0), CFG_FLASH_MAGIC);
  const parsed = parseCfgFlash(blob);
  assert.deepEqual(parsed, {
    wifiSsid: "J'cob Route",
    wifiPassword: "secret12",
    mqttHost: "192.168.0.101",
  });
});

test("cfg blob: špatný checksum se odmítne", () => {
  const blob = buildCfgFlash({
    wifiSsid: "home",
    wifiPassword: "x",
    mqttHost: "10.0.0.2",
  });
  blob.writeUInt32LE(1, BLOB_SIZE - 4);
  assert.equal(parseCfgFlash(blob), null);
});
