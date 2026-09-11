// Argumenty pro espflash 4.x. `flash` bere --flash-size, `write-bin` ne —
// když se mu podstrčí, spadne na "unexpected argument '--flash-size'".
const FLASH_SIZE = "16mb";
const FLASH_BAUD = "921600";

function commonArgs(port, baud) {
  return ["--port", port, "--baud", String(baud || FLASH_BAUD), "--skip-update-check"];
}

// Nahrání ELF: espflash z něj udělá app image a zapíše bootloader, tabulku
// oddílů a aplikaci. Bez --partition-table si espflash vyrobí vlastní tabulku
// jen s jedním oddílem factory — pak nemá Wi-Fi OTA kam zapisovat. Bez
// --bootloader použije svůj vlastní (jiná verze ESP-IDF než aplikace).
function elfFlashArgs({ port, image, baud, partitionTable, appPartition, bootloader }) {
  if (!port || !image) {
    throw new Error("elfFlashArgs: chybí port nebo image");
  }
  const args = ["flash", ...commonArgs(port, baud), "--flash-size", FLASH_SIZE];
  if (bootloader) {
    args.push("--bootloader", bootloader);
  }
  if (partitionTable) {
    args.push("--partition-table", partitionTable);
    args.push("--target-app-partition", appPartition || "app0");
    // otadata rozhoduje, ze kterého slotu se boot bere, nvs bývá na starých
    // destičkách rozbitá. Oba oddíly mažeme, cfg si píšeme zvlášť do klikcfg.
    args.push("--erase-data-parts", "ota,nvs");
  }
  args.push(image);
  return args;
}

// Zápis hotového binárního obrazu (factory bin, cfg sektor) na danou adresu.
function writeBinArgs({ port, address, file, baud }) {
  if (!port || !file) {
    throw new Error("writeBinArgs: chybí port nebo file");
  }
  const addr = typeof address === "number" ? `0x${address.toString(16)}` : String(address || "");
  if (!/^0x[0-9a-f]+$/i.test(addr)) {
    throw new Error(`writeBinArgs: neplatná adresa ${addr}`);
  }
  return ["write-bin", ...commonArgs(port, baud), addr, file];
}

module.exports = { elfFlashArgs, writeBinArgs, FLASH_SIZE, FLASH_BAUD };
