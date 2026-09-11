const test = require("node:test");
const assert = require("node:assert/strict");
const { elfFlashArgs, writeBinArgs } = require("../lib/espflashArgs");
const { buildCfgFlash, parseCfgFlash, CFG_PART_ADDR } = require("../lib/cfgFlashBlob");

// espflash 4.x: `write-bin` --flash-size nezná a skončí chybou
// "unexpected argument '--flash-size' found".
test("write-bin: bez --flash-size", () => {
  const args = writeBinArgs({ port: "COM3", address: CFG_PART_ADDR, file: "C:\\tmp\\klikac-cfg.bin" });
  assert.equal(args.includes("--flash-size"), false);
  assert.deepEqual(args, [
    "write-bin",
    "--port", "COM3",
    "--baud", "921600",
    "--skip-update-check",
    "0xa10000",
    "C:\\tmp\\klikac-cfg.bin",
  ]);
});

test("write-bin: odmítne nesmyslnou adresu", () => {
  assert.throws(() => writeBinArgs({ port: "COM3", address: "klikcfg", file: "cfg.bin" }), /adresa/);
});

test("flash ELF: pošle tabulku oddílů a cílový app slot", () => {
  const args = elfFlashArgs({
    port: "COM3",
    image: "C:\\fw\\firmware.elf",
    partitionTable: "C:\\fw\\klikac_16mb.csv",
  });
  assert.deepEqual(args, [
    "flash",
    "--port", "COM3",
    "--baud", "921600",
    "--skip-update-check",
    "--flash-size", "16mb",
    "--partition-table", "C:\\fw\\klikac_16mb.csv",
    "--target-app-partition", "app0",
    "--erase-data-parts", "ota,nvs",
    "C:\\fw\\firmware.elf",
  ]);
});

test("flash ELF: bez tabulky nechá espflash na jeho vlastní", () => {
  const args = elfFlashArgs({ port: "COM3", image: "firmware.elf" });
  assert.equal(args.includes("--partition-table"), false);
  assert.equal(args.includes("--bootloader"), false);
  assert.equal(args.at(-1), "firmware.elf");
});

test("flash ELF: bootloader z buildu jde před image", () => {
  const args = elfFlashArgs({ port: "COM3", image: "firmware.elf", bootloader: "bootloader.bin" });
  assert.deepEqual(args.slice(args.indexOf("--bootloader")), [
    "--bootloader", "bootloader.bin",
    "firmware.elf",
  ]);
});

test("cfg blob: 4 KB sektor, čte se stejně jako se zapsal", () => {
  const blob = buildCfgFlash({ wifiSsid: "J'cob Route", wifiPassword: "tajne123", mqttHost: "192.168.0.101" });
  assert.equal(blob.length, 4096);
  assert.deepEqual(parseCfgFlash(blob), {
    wifiSsid: "J'cob Route",
    wifiPassword: "tajne123",
    mqttHost: "192.168.0.101",
  });
});
