// Same packed layout as CfgFlash in src/main.cpp (little-endian).
const CFG_FLASH_MAGIC = 0x3146474b;
// Oddíl klikcfg z partitions/klikac_16mb.csv. Musí souhlasit s CSV, jinak
// zápis skončí mimo oddíl a firmware cfg nenajde.
const CFG_PART_LABEL = "klikcfg";
const CFG_PART_ADDR = 0xa10000;
// Adresy, kam cfg psaly verze do 1.1.3. Firmware je čte kvůli migraci.
const CFG_FLASH_ADDR = 0x200000;
const CFG_FLASH_ADDRS = [0x200000, 0x3f0000, 0xfff000];
const WIFI_LEN = 36;
const PASS_LEN = 68;
const MQTT_LEN = 48;
const BLOB_SIZE = 4 + WIFI_LEN + PASS_LEN + MQTT_LEN + 4;
const SUM_OFF = BLOB_SIZE - 4;

function writeCString(buf, offset, text, fieldLen) {
  const raw = Buffer.from(String(text || "").replace(/[\r\n]/g, ""), "utf8");
  const n = Math.min(raw.length, fieldLen - 1);
  raw.copy(buf, offset, 0, n);
}

function fnv1a32(buf, len) {
  let s = 2166136261 >>> 0;
  for (let i = 0; i < len; i += 1) {
    s = (s ^ buf[i]) >>> 0;
    s = Math.imul(s, 16777619) >>> 0;
  }
  return s;
}

function buildCfgFlash({ wifiSsid, wifiPassword, mqttHost }) {
  const wifi = String(wifiSsid || "").trim();
  const mqtt = String(mqttHost || "").trim();
  if (!wifi || !mqtt) {
    throw new Error("Chybí Wi-Fi SSID nebo IP tohoto PC");
  }
  const buf = Buffer.alloc(4096, 0xff);
  buf.fill(0, 0, BLOB_SIZE);
  buf.writeUInt32LE(CFG_FLASH_MAGIC, 0);
  writeCString(buf, 4, wifi, WIFI_LEN);
  writeCString(buf, 4 + WIFI_LEN, wifiPassword, PASS_LEN);
  writeCString(buf, 4 + WIFI_LEN + PASS_LEN, mqtt, MQTT_LEN);
  buf.writeUInt32LE(fnv1a32(buf, SUM_OFF), SUM_OFF);
  return buf;
}

function parseCfgFlash(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < BLOB_SIZE) {
    return null;
  }
  if (buf.readUInt32LE(0) !== CFG_FLASH_MAGIC) {
    return null;
  }
  if (buf.readUInt32LE(SUM_OFF) !== fnv1a32(buf, SUM_OFF)) {
    return null;
  }
  const wifi = buf.slice(4, 4 + WIFI_LEN).toString("utf8").replace(/\0.*$/, "");
  const pass = buf.slice(4 + WIFI_LEN, 4 + WIFI_LEN + PASS_LEN).toString("utf8").replace(/\0.*$/, "");
  const mqtt = buf.slice(4 + WIFI_LEN + PASS_LEN, SUM_OFF).toString("utf8").replace(/\0.*$/, "");
  if (!wifi || !mqtt) {
    return null;
  }
  return { wifiSsid: wifi, wifiPassword: pass, mqttHost: mqtt };
}

module.exports = {
  CFG_FLASH_MAGIC,
  CFG_PART_LABEL,
  CFG_PART_ADDR,
  CFG_FLASH_ADDR,
  CFG_FLASH_ADDRS,
  BLOB_SIZE,
  buildCfgFlash,
  parseCfgFlash,
};
