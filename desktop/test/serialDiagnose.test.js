const test = require("node:test");
const assert = require("node:assert/strict");
const { interpretDiagnose } = require("../lib/serialDiagnose");

test("diagnose: prázdná cfg", () => {
  const r = interpretDiagnose([
    "klikac firmware 1.1.1",
    "KLOG wifi=(empty)",
    "KLOG mqtt=(empty)",
    "Wi-Fi čeká na USB inicializaci (KCFG)",
  ]);
  assert.equal(r.emptyWifi, true);
  assert.match(r.hint, /není Wi-Fi|Force/i);
});

test("diagnose: SSID v éteru není", () => {
  const r = interpretDiagnose([
    "klikac firmware 1.1.1",
    "KLOG wifi=J'cob Route",
    "KLOG mqtt=192.168.0.101",
    "KLOG wifi-sta=1",
  ]);
  assert.match(r.hint, /2,4|nevidí/);
});

test("diagnose: Wi-Fi je, MQTT ne", () => {
  const r = interpretDiagnose([
    "klikac firmware 1.1.1",
    "KLOG wifi=home",
    "KLOG mqtt=192.168.0.101",
    "Wi-Fi boot home",
    "KLOG wifi-sta=3",
    "MQTT failed, rc=-2",
  ]);
  assert.match(r.hint, /1883|firewall|IP/);
});

test("diagnose: cfg-none s prázdným oddílem klikcfg", () => {
  const r = interpretDiagnose([
    "klikac firmware 1.1.4",
    "KLOG cfg-part 0xA10000",
    "KLOG cfg-part-read e=0 mag=0xFFFFFFFF",
    "KLOG cfg-none",
    "KLOG wifi=(empty)",
    "KLOG mqtt=(empty)",
    "Wi-Fi čeká na USB inicializaci (KCFG)",
  ]);
  assert.equal(r.oldPartitions, false);
  assert.match(r.hint, /klikcfg|Vynutit zápis/);
});

test("diagnose: stará tabulka oddílů bez klikcfg", () => {
  const r = interpretDiagnose([
    "klikac firmware 1.1.4",
    "KLOG cfg-part-missing",
    "KLOG cfg-none",
    "KLOG wifi=(empty)",
    "KLOG mqtt=(empty)",
    "Wi-Fi čeká na USB inicializaci (KCFG)",
  ]);
  assert.equal(r.oldPartitions, true);
  assert.match(r.hint, /starou tabulku oddílů/);
});

test("diagnose: KCFG STATUS řekne, kde cfg leží", () => {
  const r = interpretDiagnose([
    "klikac firmware 1.1.4",
    "KLOG cfg-part 0xA10000",
    "KLOG cfg-part wifi=home mqtt=192.168.0.101",
    "KLOG fw=1.1.4",
    "KLOG cfg-store part",
    "KLOG wifi=home",
    "KLOG mqtt=192.168.0.101",
    "MQTT connected",
  ]);
  assert.equal(r.cfgStore, "part");
  assert.equal(r.mqttOk, true);
});

test("diagnose: MQTT connected", () => {
  const r = interpretDiagnose([
    "klikac firmware 1.1.1",
    "KLOG wifi=home",
    "KLOG mqtt=192.168.0.101",
    "MQTT connected",
  ]);
  assert.equal(r.mqttOk, true);
  assert.match(r.hint, /HID|herního/);
});
