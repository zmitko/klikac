#!/usr/bin/env python3
from pathlib import Path

text = """#pragma once

#define WIFI_SSID ""
#define WIFI_PASSWORD ""
#define MQTT_HOST ""
"""
Path("include/secrets.h").write_text(text, encoding="utf-8")
print("Wrote include/secrets.h (Wi-Fi + MQTT IP se nastaví z Klikače přes USB)")
