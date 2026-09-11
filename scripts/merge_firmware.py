#!/usr/bin/env python3
import glob
import json
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BUILD = ROOT / ".pio" / "build" / "esp32-s3-n16r8"
OUT_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else BUILD
OUT_DIR.mkdir(parents=True, exist_ok=True)


def first_existing(paths):
    for item in paths:
        if item and Path(item).is_file():
            return Path(item)
    return None


def find_esptool():
    home = Path.home() / ".platformio" / "packages"
    matches = glob.glob(str(home / "tool-esptoolpy" / "esptool*.py"))
    matches += glob.glob(str(home / "tool-esptoolpy" / "esptool.py"))
    if matches:
        return matches[0]
    return "esptool.py"


def main():
    firmware = BUILD / "firmware.bin"
    elf = BUILD / "firmware.elf"
    if not firmware.is_file():
        raise SystemExit(f"Chybí {firmware}")
    bootloader = first_existing([
        BUILD / "bootloader.bin",
        BUILD / "bootloader" / "bootloader.bin",
    ])
    partitions = first_existing([
        BUILD / "partitions.bin",
        BUILD / "partitions" / "partitions.bin",
    ])
    dest_bin = OUT_DIR / "firmware.bin"
    dest_elf = OUT_DIR / "firmware.elf"
    dest_bin.write_bytes(firmware.read_bytes())
    if elf.is_file():
        dest_elf.write_bytes(elf.read_bytes())
    # Klikač posílá tuhle tabulku espflashi (--partition-table), aby destička
    # dostala app0/app1 pro Wi-Fi OTA a sektor klikcfg na Wi-Fi/MQTT.
    part_csv = ROOT / "partitions" / "klikac_16mb.csv"
    if part_csv.is_file():
        (OUT_DIR / part_csv.name).write_bytes(part_csv.read_bytes())
    # Bootloader z tohoto buildu. Bez něj by espflash zapsal svůj vlastní, z jiné
    # verze ESP-IDF než aplikace.
    if bootloader:
        (OUT_DIR / "bootloader.bin").write_bytes(bootloader.read_bytes())
    # boot_app0 nastaví otadata na app0. Bez něj by destička s app0/app1 mohla
    # po přeflashnutí bootovat starý obsah druhého slotu.
    boot_app0 = first_existing([
        Path.home() / ".platformio" / "packages" / "framework-arduinoespressif32"
        / "tools" / "partitions" / "boot_app0.bin",
    ])
    if bootloader and partitions:
        factory = OUT_DIR / "firmware-factory.bin"
        cmd = [
            sys.executable,
            find_esptool(),
            "--chip",
            "esp32s3",
            "merge_bin",
            "-o",
            str(factory),
            "--flash_mode",
            "qio",
            "--flash_freq",
            "80m",
            "--flash_size",
            "16MB",
            "0x0",
            str(bootloader),
            "0x8000",
            str(partitions),
        ]
        if boot_app0:
            cmd += ["0xe000", str(boot_app0)]
        cmd += [
            "0x10000",
            str(firmware),
        ]
        print(" ".join(cmd))
        subprocess.check_call(cmd)
    ver = (ROOT / "VERSION").read_text(encoding="utf-8").strip()
    manifest = {
        "version": ver,
        "firmware": ver,
        "assets": {
            "firmwareBin": "firmware.bin",
            "firmwareElf": "firmware.elf" if elf.is_file() else "",
            "factory": "firmware-factory.bin" if (OUT_DIR / "firmware-factory.bin").is_file() else "",
            "partitionCsv": part_csv.name if part_csv.is_file() else "",
            "bootloader": "bootloader.bin" if (OUT_DIR / "bootloader.bin").is_file() else "",
        },
    }
    (OUT_DIR / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Firmware artifacts in {OUT_DIR}")


if __name__ == "__main__":
    main()
