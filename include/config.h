#pragma once

#define BOOT_BUTTON_PIN 0
#define BUTTON_DEBOUNCE_MS 40

#define USB_DEVICE_VID 0x303A
#define USB_DEVICE_PID 0x40C3
#define USB_DEVICE_MANUFACTURER "USB"
#define USB_DEVICE_PRODUCT "USB Input"
#define USB_DEVICE_SERIAL "0001"
#define USB_DEVICE_POWER_MA 500

#define MQTT_CLIENT_ID_PREFIX "esp32kbd-"
#define MQTT_BROKER_PORT 1883
#define MQTT_USER "klikac"
#define MQTT_PASSWORD "klikac"
#define OTA_PASSWORD "klikac-ota"
#define MQTT_TOPIC_COMMAND "esp32kbd/command"
#define MQTT_TOPIC_MACRO "esp32kbd/macro"
#define MQTT_TOPIC_STATUS "esp32kbd/status"
#define MQTT_TOPIC_USB "esp32kbd/usb"
#define MQTT_TOPIC_ACK "esp32kbd/ack"
#define MQTT_TOPIC_IP "esp32kbd/ip"
#define MQTT_TOPIC_FW "esp32kbd/fw"
#define MQTT_TOPIC_OTA "esp32kbd/ota"
#define MQTT_TOPIC_OTA_STATUS "esp32kbd/ota_status"
#define OTA_HOSTNAME "esp32-keyboard"
#define OTA_UDP_PORT 3232
#define HTTP_OTA_URL_MAX 512

#define MACRO_SEQ_MAX 768
#define MACRO_SLOTS 5
#define MACRO_START_MAX 2048

#define MQTT_RECONNECT_MS 4000
#define MQTT_SETTLE_MS 400
#define MQTT_KEEPALIVE_S 20
#define MQTT_HEARTBEAT_MS 10000
#define WIFI_RECONNECT_MS 12000
#define WIFI_GIVEUP_MS 20000
#define WIFI_START_DELAY_MS 12000
#define WIFI_AFTER_USB_MS 4000
#define HID_KEEPALIVE_MS 2000
#define OTA_AFTER_MQTT_MS 3000

// Human-like key hold. Typical finger tap is ~60-140 ms, most often ~80-110 ms.
#define KEY_HOLD_MIN_MS 55
#define KEY_HOLD_MAX_MS 140
