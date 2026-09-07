# Klikač

Windows tray aplikace + firmware ESP32-S3 (USB HID klávesnice/myš) přes MQTT.

Releasy: [github.com/zmitko/klikac](https://github.com/zmitko/klikac)

## Verze

Zdroj pravdy je soubor `VERSION` (teď `1.0.0`). Stejné číslo mají Klikač i firmware destičky.

Nový release:

1. Změň `VERSION` (např. `1.0.1`).
2. V GitHub repu nastav secrets pro stavbu firmware:
   `WIFI_SSID`, `WIFI_PASSWORD`, `MQTT_HOST`, `MQTT_PORT`, `MQTT_USER`, `MQTT_PASSWORD`, `OTA_PASSWORD`
3. `git tag v1.0.1 && git push origin v1.0.1`  
   nebo v Actions spusť workflow **Release**.

V releasu je instalátor `Klikac-Setup-x.y.z.exe`, `firmware.bin` (Wi-Fi OTA), `firmware.elf` / `firmware-factory.bin` (první USB flash) a `espflash.exe`.

## Aktualizace aplikace

Klikač po startu zkontroluje GitHub. Když je novější verze, vpravo dole je **Aktualizovat** — stáhne instalátor a spustí ho.

## Firmware destičky

V kartě **Destička** je **Nahrát firmware**:

1. **USB (první nahrání)** — destičku zapoj flash kabelem (COM / CH343) do PC1, případně drž BOOT. Klikač najde port a nahraje image.
2. **Wi-Fi** — když USB není, pošle firmware na IP destičky (ArduinoOTA). Novější firmware umí i stáhnout binárku sám (MQTT `esp32kbd/ota`).

Do `desktop/config.json` dej stejné `otaPassword` jako v `include/secrets.h`.
