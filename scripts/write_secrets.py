#!/usr/bin/env python3
import os
from pathlib import Path

def c_string(name, default=""):
    value = os.environ.get(name, default)
    return value.replace("\\", "\\\\").replace('"', '\\"')


def main():
    ssid = os.environ.get("WIFI_SSID", "").strip()
    if not ssid:
        raise SystemExit("Chybí GitHub secret WIFI_SSID (a další WIFI/MQTT/OTA secrets).")
    port = os.environ.get("MQTT_PORT", "1883").strip() or "1883"
    text = "\n".join([
        "#pragma once",
        "",
        f'#define WIFI_SSID "{c_string("WIFI_SSID")}"',
        f'#define WIFI_PASSWORD "{c_string("WIFI_PASSWORD")}"',
        "",
        f'#define MQTT_HOST "{c_string("MQTT_HOST", "192.168.1.134")}"',
        f"#define MQTT_PORT {port}",
        f'#define MQTT_USER "{c_string("MQTT_USER")}"',
        f'#define MQTT_PASSWORD "{c_string("MQTT_PASSWORD")}"',
        "",
        f'#define OTA_PASSWORD "{c_string("OTA_PASSWORD", "esp32kbd-ota")}"',
        "",
    ])
    Path("include/secrets.h").write_text(text, encoding="utf-8")
    print("Wrote include/secrets.h")


if __name__ == "__main__":
    main()
