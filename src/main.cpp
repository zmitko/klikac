#include <Arduino.h>

#ifndef ARDUINO_USB_MODE
#error This firmware requires an ESP32 with native USB (ESP32-S3).
#endif
#if ARDUINO_USB_MODE == 1
#error USB must be TinyUSB OTG (ARDUINO_USB_MODE=0). Check platformio.ini.
#endif

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPUpdate.h>
#include <ArduinoOTA.h>
#include <PubSubClient.h>
#include <stddef.h>
#include <nvs.h>
#include <nvs_flash.h>
#include <esp_flash.h>
#include <esp_ota_ops.h>
#include <esp_partition.h>
#include <esp_system.h>
#include "soc/soc.h"
#include "soc/rtc_cntl_reg.h"
#include "USB.h"
#include "USBHIDKeyboard.h"
#include "USBHIDMouse.h"
#include "config.h"
#include "secrets.h"
#include "version.h"

USBHIDKeyboard Keyboard;
USBHIDMouse Mouse;
WiFiClient wifi_client;
PubSubClient mqtt(wifi_client);

static volatile bool usb_mounted = false;
static volatile bool usb_needs_release = false;
static volatile bool keys_need_abort = false;
static volatile int pending_fn = 0;
static volatile int pending_mouse = 0;
static volatile bool pending_enter = false;
static volatile uint8_t pending_raw = 0;
static char pending_raw_label[12];
static volatile bool macro_stop_req = false;
static bool ota_ready = false;
static bool ota_started = false;
static uint32_t wifi_ok_since = 0;
static volatile bool macro_has_start = false;

struct MacroSlot {
    bool active;
    bool loop;
    uint32_t dmin;
    uint32_t dmax;
    uint32_t wait_until;
    size_t pos;
    char seq[MACRO_SEQ_MAX];
};

static MacroSlot macros[MACRO_SLOTS];
static char macro_pending_start[MACRO_START_MAX];

static bool last_usb_published = false;
static uint32_t mqtt_ready_at = 0;
static uint32_t last_mqtt_attempt = 0;
static uint32_t last_wifi_attempt = 0;
static uint32_t last_heartbeat = 0;
static uint32_t wifi_begin_at = 0;
static uint32_t wifi_start_at = 0;
static volatile uint32_t wifi_armed_at = 0;
static uint32_t last_hid_keep = 0;
static uint32_t mqtt_reannounce_at = 0;
static volatile bool usb_announce = false;
static volatile bool hid_holding = false;

static int last_button = HIGH;
static uint32_t last_button_ms = 0;
static char mqtt_client_id[24];
static char pending_ota_url[HTTP_OTA_URL_MAX];
static volatile bool http_ota_req = false;
static char wifi_ssid[33];
static char wifi_pass[65];
static char mqtt_host[48];
static char serial_line[220];
static size_t serial_len = 0;

#define CFG_FLASH_MAGIC 0x3146474Bu
#define CFG_FLASH_ADDR 0x200000u
#define CFG_FLASH_ADDR_ALT 0x3F0000u
#define CFG_FLASH_ADDR_LEGACY 0xFFF000u

struct CfgFlash {
    uint32_t magic;
    char wifi[36];
    char pass[68];
    char mqtt[48];
    uint32_t sum;
} __attribute__((packed));

static uint32_t cfg_flash_sum(const CfgFlash *blob) {
    uint32_t s = 2166136261u;
    const uint8_t *p = reinterpret_cast<const uint8_t *>(blob);
    const size_t n = offsetof(CfgFlash, sum);
    for (size_t i = 0; i < n; i++) {
        s ^= p[i];
        s *= 16777619u;
    }
    return s;
}

static const uint8_t kFnHid[13] = {
    0, KEY_F1, KEY_F2, KEY_F3, KEY_F4, KEY_F5, KEY_F6, KEY_F7, KEY_F8,
    KEY_F9, KEY_F10, KEY_F11, KEY_F12,
};

// TinyUSB HID usage: numpad 0–9, then number-row 0–9 (+ěščřžýáíé on Czech).
static const uint8_t kHidKeypad[10] = {
    0x62, 0x59, 0x5A, 0x5B, 0x5C, 0x5D, 0x5E, 0x5F, 0x60, 0x61,
};
static const uint8_t kHidDigitRow[10] = {
    0x27, 0x1E, 0x1F, 0x20, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26,
};

static void usb_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)data;
    switch (id) {
        case ARDUINO_USB_STARTED_EVENT:
        case ARDUINO_USB_RESUME_EVENT:
            usb_mounted = true;
            usb_announce = true;
            if (!wifi_armed_at) {
                wifi_armed_at = millis() + WIFI_AFTER_USB_MS;
            }
            break;
        case ARDUINO_USB_STOPPED_EVENT:
            usb_mounted = false;
            usb_needs_release = true;
            pending_fn = 0;
            pending_mouse = 0;
            pending_enter = false;
            pending_raw = 0;
            break;
        case ARDUINO_USB_SUSPEND_EVENT:
            break;
        default:
            break;
    }
}

static void idle_poll() {
    mqtt.loop();
    if (ota_ready) {
        ArduinoOTA.handle();
    }
    delay(4);
}

static uint32_t human_hold_ms() {
    const uint32_t span = (KEY_HOLD_MAX_MS - KEY_HOLD_MIN_MS) + 1;
    const uint32_t a = KEY_HOLD_MIN_MS + (esp_random() % span);
    const uint32_t b = KEY_HOLD_MIN_MS + (esp_random() % span);
    return (a + b) / 2;
}

static void human_key(uint8_t hid_key) {
    if (!usb_mounted) {
        return;
    }
    const uint32_t hold_ms = human_hold_ms();
    hid_holding = true;
    Keyboard.press(hid_key);
    const uint32_t start = millis();
    while ((millis() - start) < hold_ms) {
        if (!usb_mounted || keys_need_abort) {
            break;
        }
        idle_poll();
    }
    Keyboard.release(hid_key);
    Keyboard.releaseAll();
    hid_holding = false;
    Serial.print(" hold=");
    Serial.print(hold_ms);
    Serial.println("ms");
}

static void human_key_raw(uint8_t raw) {
    if (!usb_mounted || !raw) {
        return;
    }
    const uint32_t hold_ms = human_hold_ms();
    hid_holding = true;
    Keyboard.pressRaw(raw);
    const uint32_t start = millis();
    while ((millis() - start) < hold_ms) {
        if (!usb_mounted || keys_need_abort) {
            break;
        }
        idle_poll();
    }
    Keyboard.releaseRaw(raw);
    Keyboard.releaseAll();
    hid_holding = false;
    Serial.print(" hold=");
    Serial.print(hold_ms);
    Serial.println("ms");
}

static void send_fn(int n) {
    if (n < 1 || n > 12) {
        return;
    }
    if (!usb_mounted) {
        Serial.println("key ignored: USB not mounted");
        return;
    }
    Serial.print("HID F");
    Serial.print(n);
    human_key(kFnHid[n]);
    if (mqtt.connected()) {
        char ack[5];
        snprintf(ack, sizeof(ack), "F%d", n);
        mqtt.publish(MQTT_TOPIC_ACK, ack, false);
    }
}

static void human_click(uint8_t button) {
    if (!usb_mounted) {
        return;
    }
    const uint32_t hold_ms = human_hold_ms();
    hid_holding = true;
    Mouse.press(button);
    const uint32_t start = millis();
    while ((millis() - start) < hold_ms) {
        if (!usb_mounted || keys_need_abort) {
            break;
        }
        idle_poll();
    }
    Mouse.release(button);
    hid_holding = false;
    Serial.print(" hold=");
    Serial.print(hold_ms);
    Serial.println("ms");
}

static void mouse_release_all() {
    Mouse.release(MOUSE_LEFT);
    Mouse.release(MOUSE_RIGHT);
}

static void send_mouse(int which) {
    if (which != 1 && which != 2) {
        return;
    }
    if (!usb_mounted) {
        Serial.println("click ignored: USB not mounted");
        return;
    }
    const uint8_t button = (which == 1) ? MOUSE_LEFT : MOUSE_RIGHT;
    Serial.print(which == 1 ? "HID LC" : "HID RC");
    human_click(button);
    if (mqtt.connected()) {
        mqtt.publish(MQTT_TOPIC_ACK, which == 1 ? "LC" : "RC", false);
    }
}

static int parse_fn(const char *s) {
    if (!s || (s[0] != 'F' && s[0] != 'f') || s[1] < '0' || s[1] > '9') {
        return 0;
    }
    if (s[2] == '\0' && s[1] >= '1' && s[1] <= '9') {
        return s[1] - '0';
    }
    if (s[1] == '1' && s[2] >= '0' && s[2] <= '2' && s[3] == '\0') {
        return 10 + (s[2] - '0');
    }
    return 0;
}

static int parse_mouse(const char *s) {
    if (!s || !s[0]) {
        return 0;
    }
    char t[12];
    size_t i = 0;
    for (; s[i] && i + 1 < sizeof(t); i++) {
        const char c = s[i];
        t[i] = (c >= 'a' && c <= 'z') ? (char)(c - 32) : c;
    }
    t[i] = '\0';
    if (strcmp(t, "LC") == 0 || strcmp(t, "LCLICK") == 0 || strcmp(t, "LEFT") == 0 || strcmp(t, "LMB") == 0) {
        return 1;
    }
    if (strcmp(t, "RC") == 0 || strcmp(t, "RCLICK") == 0 || strcmp(t, "RIGHT") == 0 || strcmp(t, "RMB") == 0) {
        return 2;
    }
    return 0;
}

static void send_raw_key(uint8_t raw, const char *label) {
    if (!raw) {
        return;
    }
    if (!usb_mounted) {
        Serial.println("key ignored: USB not mounted");
        return;
    }
    Serial.print("HID ");
    Serial.print(label && label[0] ? label : "?");
    human_key_raw(raw);
    if (mqtt.connected() && label && label[0]) {
        mqtt.publish(MQTT_TOPIC_ACK, label, false);
    }
}

static bool parse_seq_key(const char *s, uint8_t *raw, char *label, size_t labellen) {
    if (!s || !s[0] || !raw || !label || labellen < 2) {
        return false;
    }
    if (s[0] >= '0' && s[0] <= '9' && s[1] == '\0') {
        *raw = kHidKeypad[s[0] - '0'];
        label[0] = s[0];
        label[1] = '\0';
        return true;
    }
    static const char *const czLo[] = {"+", "ě", "š", "č", "ř", "ž", "ý", "á", "í", "é"};
    static const char *const czHi[] = {"+", "Ě", "Š", "Č", "Ř", "Ž", "Ý", "Á", "Í", "É"};
    static const uint8_t czHid[] = {
        kHidDigitRow[1], kHidDigitRow[2], kHidDigitRow[3], kHidDigitRow[4], kHidDigitRow[5],
        kHidDigitRow[6], kHidDigitRow[7], kHidDigitRow[8], kHidDigitRow[9], kHidDigitRow[0],
    };
    for (size_t i = 0; i < 10; i++) {
        if (strcmp(s, czLo[i]) == 0 || strcmp(s, czHi[i]) == 0) {
            *raw = czHid[i];
            strncpy(label, czLo[i], labellen - 1);
            label[labellen - 1] = '\0';
            return true;
        }
    }
    return false;
}

static bool parse_enter(const char *s) {
    if (!s || !s[0]) {
        return false;
    }
    char t[12];
    size_t i = 0;
    for (; s[i] && i + 1 < sizeof(t); i++) {
        const char c = s[i];
        t[i] = (c >= 'a' && c <= 'z') ? (char)(c - 32) : c;
    }
    t[i] = '\0';
    return strcmp(t, "ENTER") == 0 || strcmp(t, "ENT") == 0 || strcmp(t, "RET") == 0 || strcmp(t, "RETURN") == 0;
}

static void send_enter() {
    if (!usb_mounted) {
        Serial.println("key ignored: USB not mounted");
        return;
    }
    Serial.print("HID ENTER");
    human_key(KEY_RETURN);
    if (mqtt.connected()) {
        mqtt.publish(MQTT_TOPIC_ACK, "ENTER", false);
    }
}

static void publish_usb() {
    if (!mqtt.connected()) {
        return;
    }
    const bool mounted = usb_mounted;
    mqtt.publish(MQTT_TOPIC_USB, mounted ? "connected" : "disconnected", true);
    last_usb_published = mounted;
}

static void publish_discovery() {
    const char *status_cfg =
        "{\"name\":\"ESP32 Keyboard Online\",\"uniq_id\":\"esp32kbd_online\","
        "\"stat_t\":\"esp32kbd/status\",\"pl_on\":\"online\",\"pl_off\":\"offline\","
        "\"dev_cla\":\"connectivity\","
        "\"dev\":{\"ids\":[\"esp32kbd\"],\"name\":\"ESP32 Keyboard\","
        "\"mf\":\"USB\",\"mdl\":\"ESP32-S3 N16R8\"}}";
    const char *usb_cfg =
        "{\"name\":\"ESP32 Keyboard USB\",\"uniq_id\":\"esp32kbd_usb\","
        "\"stat_t\":\"esp32kbd/usb\",\"pl_on\":\"connected\",\"pl_off\":\"disconnected\","
        "\"dev_cla\":\"connectivity\","
        "\"dev\":{\"ids\":[\"esp32kbd\"],\"name\":\"ESP32 Keyboard\","
        "\"mf\":\"USB\",\"mdl\":\"ESP32-S3 N16R8\"}}";
    mqtt.publish("homeassistant/binary_sensor/esp32kbd/online/config", status_cfg, true);
    mqtt.publish("homeassistant/binary_sensor/esp32kbd/usb/config", usb_cfg, true);
    const char *ip_cfg =
        "{\"name\":\"ESP32 Keyboard IP\",\"uniq_id\":\"esp32kbd_ip\","
        "\"stat_t\":\"esp32kbd/ip\",\"ent_cla\":\"info\","
        "\"dev\":{\"ids\":[\"esp32kbd\"],\"name\":\"ESP32 Keyboard\","
        "\"mf\":\"USB\",\"mdl\":\"ESP32-S3 N16R8\"}}";
    mqtt.publish("homeassistant/sensor/esp32kbd/ip/config", ip_cfg, true);
    const char *fw_cfg =
        "{\"name\":\"ESP32 Keyboard FW\",\"uniq_id\":\"esp32kbd_fw\","
        "\"stat_t\":\"esp32kbd/fw\",\"ent_cla\":\"info\","
        "\"dev\":{\"ids\":[\"esp32kbd\"],\"name\":\"ESP32 Keyboard\","
        "\"mf\":\"USB\",\"mdl\":\"ESP32-S3 N16R8\"}}";
    mqtt.publish("homeassistant/sensor/esp32kbd/fw/config", fw_cfg, true);
}

static void publish_ip() {
    if (!mqtt.connected()) {
        return;
    }
    mqtt.publish(MQTT_TOPIC_IP, WiFi.localIP().toString().c_str(), true);
}

static void publish_fw() {
    if (!mqtt.connected()) {
        return;
    }
    mqtt.publish(MQTT_TOPIC_FW, FIRMWARE_VERSION, true);
}

static void publish_ota_status(const char *msg) {
    if (!mqtt.connected()) {
        return;
    }
    mqtt.publish(MQTT_TOPIC_OTA_STATUS, msg, false);
}

static void run_http_ota(const char *url) {
    if (!url || !url[0]) {
        return;
    }
    keys_need_abort = true;
    macro_stop_req = true;
    Keyboard.releaseAll();
    mouse_release_all();
    publish_ota_status("start");
    Serial.print("HTTP OTA ");
    Serial.println(url);

    httpUpdate.setFollowRedirects(HTTPC_STRICT_FOLLOW_REDIRECTS);
    httpUpdate.rebootOnUpdate(true);
    t_httpUpdate_return ret = HTTP_UPDATE_FAILED;
    if (strncmp(url, "https://", 8) == 0) {
        WiFiClientSecure client;
        client.setInsecure();
        ret = httpUpdate.update(client, url);
    } else {
        WiFiClient client;
        ret = httpUpdate.update(client, url);
    }
    if (ret == HTTP_UPDATE_OK) {
        publish_ota_status("ok");
        return;
    }
    Serial.print("HTTP OTA fail ");
    Serial.println(httpUpdate.getLastError());
    publish_ota_status(httpUpdate.getLastErrorString().c_str());
}

static void macros_clear() {
    for (int i = 0; i < MACRO_SLOTS; i++) {
        macros[i].active = false;
        macros[i].loop = false;
        macros[i].pos = 0;
        macros[i].wait_until = 0;
        macros[i].seq[0] = '\0';
    }
}

static void macro_stop() {
    macros_clear();
    keys_need_abort = true;
}

static bool macros_any_active() {
    for (int i = 0; i < MACRO_SLOTS; i++) {
        if (macros[i].active) {
            return true;
        }
    }
    return false;
}

static bool parse_one_macro_line(const char *s, size_t len, MacroSlot *slot) {
    char line[MACRO_SEQ_MAX + 48];
    if (len == 0) {
        return false;
    }
    if (len >= sizeof(line)) {
        len = sizeof(line) - 1;
    }
    memcpy(line, s, len);
    line[len] = '\0';
    while (len > 0 && (line[len - 1] == ' ' || line[len - 1] == '\t')) {
        line[--len] = '\0';
    }

    const char *p1 = strchr(line, '|');
    const char *p2 = p1 ? strchr(p1 + 1, '|') : nullptr;
    const char *p3 = p2 ? strchr(p2 + 1, '|') : nullptr;
    if (!p1 || !p2 || !p3) {
        return false;
    }
    slot->loop = atoi(line) != 0;
    slot->dmin = (uint32_t)atoi(p1 + 1);
    slot->dmax = (uint32_t)atoi(p2 + 1);
    if (slot->dmin < 1) {
        slot->dmin = 1;
    }
    if (slot->dmax < 1) {
        slot->dmax = 1;
    }
    strncpy(slot->seq, p3 + 1, sizeof(slot->seq) - 1);
    slot->seq[sizeof(slot->seq) - 1] = '\0';
    slot->pos = 0;
    slot->wait_until = 0;
    slot->active = slot->seq[0] != '\0';
    return slot->active;
}

// Jeden řádek, nebo víc oddělených newline / ;;  (HA: 1,3,4).
static bool parse_macro_start(const char *s) {
    macros_clear();
    int n = 0;
    const char *p = s;
    while (*p && n < MACRO_SLOTS) {
        while (*p == '\n' || *p == '\r' || *p == ' ' || *p == '\t') {
            p++;
        }
        if (p[0] == ';' && p[1] == ';') {
            p += 2;
            continue;
        }
        if (!*p) {
            break;
        }
        const char *start = p;
        while (*p && *p != '\n' && *p != '\r' && !(p[0] == ';' && p[1] == ';')) {
            p++;
        }
        if (parse_one_macro_line(start, (size_t)(p - start), &macros[n])) {
            n++;
        }
        if (p[0] == ';' && p[1] == ';') {
            p += 2;
        }
    }
    return n > 0;
}

static uint32_t macro_delay_ms(const MacroSlot *slot) {
    const uint32_t lo = slot->dmin < slot->dmax ? slot->dmin : slot->dmax;
    const uint32_t hi = slot->dmin < slot->dmax ? slot->dmax : slot->dmin;
    if (hi <= lo) {
        return lo;
    }
    return lo + (esp_random() % (hi - lo + 1));
}

// D = jen RNG (dmin..dmax ms). D5 / D100 / D234 = N sekund + RNG.
// Vrací true u platného D tokenu. extra_sec je 0 u holého D.
static bool parse_macro_d(const char *s, uint32_t *extra_sec) {
    if (!s || s[0] != 'D') {
        return false;
    }
    if (s[1] == '\0') {
        *extra_sec = 0;
        return true;
    }
    uint32_t sec = 0;
    for (size_t i = 1; s[i]; i++) {
        if (s[i] < '0' || s[i] > '9') {
            return false;
        }
        if (sec > 86400) {
            return false;
        }
        sec = sec * 10 + (uint32_t)(s[i] - '0');
    }
    if (sec > 86400) {
        return false;
    }
    *extra_sec = sec;
    return true;
}

static bool next_macro_token(MacroSlot *slot, char *out, size_t outlen) {
    while (slot->seq[slot->pos] == ' ' || slot->seq[slot->pos] == '\t' || slot->seq[slot->pos] == ',') {
        slot->pos++;
    }
    if (slot->seq[slot->pos] == '\0') {
        out[0] = '\0';
        return false;
    }
    size_t i = 0;
    while (slot->seq[slot->pos] != '\0' && slot->seq[slot->pos] != ',') {
        const char c = slot->seq[slot->pos++];
        if (c == ' ' || c == '\t') {
            continue;
        }
        if (i + 1 < outlen) {
            out[i++] = (c >= 'a' && c <= 'z') ? (char)(c - 32) : c;
        }
    }
    out[i] = '\0';
    return i > 0;
}

static void macro_step(MacroSlot *slot, int idx) {
    if (!slot->active) {
        return;
    }
    if ((int32_t)(millis() - slot->wait_until) < 0) {
        return;
    }
    char token[16];
    if (!next_macro_token(slot, token, sizeof(token))) {
        if (slot->loop && slot->seq[0] != '\0') {
            slot->pos = 0;
            Serial.print("macro ");
            Serial.print(idx + 1);
            Serial.println(" loop");
        } else {
            slot->active = false;
            Serial.print("macro ");
            Serial.print(idx + 1);
            Serial.println(" done");
        }
        return;
    }
    uint32_t extra_sec = 0;
    if (parse_macro_d(token, &extra_sec)) {
        const uint32_t rng_ms = macro_delay_ms(slot);
        const uint32_t ms = (extra_sec * 1000u) + rng_ms;
        slot->wait_until = millis() + ms;
        Serial.print("macro ");
        Serial.print(idx + 1);
        Serial.print(' ');
        Serial.print(token);
        Serial.print(' ');
        Serial.print(ms);
        Serial.println("ms");
        return;
    }
    Serial.print("macro ");
    Serial.print(idx + 1);
    Serial.print(' ');
    const int fn = parse_fn(token);
    if (fn != 0) {
        send_fn(fn);
        return;
    }
    const int mouse = parse_mouse(token);
    if (mouse != 0) {
        send_mouse(mouse);
        return;
    }
    if (parse_enter(token)) {
        send_enter();
        return;
    }
    uint8_t raw = 0;
    char label[12];
    if (parse_seq_key(token, &raw, label, sizeof(label))) {
        send_raw_key(raw, label);
        return;
    }
    Serial.print("skip: ");
    Serial.println(token);
}

static void mqtt_callback(char *topic, byte *payload, unsigned int len) {
    char buf[MACRO_START_MAX];
    unsigned int n = len < sizeof(buf) - 1 ? len : sizeof(buf) - 1;
    memcpy(buf, payload, n);
    buf[n] = '\0';
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == '\r' || buf[n - 1] == ' ')) {
        buf[--n] = '\0';
    }

    if (strcmp(topic, MQTT_TOPIC_OTA) == 0) {
        if (!buf[0]) {
            return;
        }
        strncpy(pending_ota_url, buf, sizeof(pending_ota_url) - 1);
        pending_ota_url[sizeof(pending_ota_url) - 1] = '\0';
        http_ota_req = true;
        Serial.print("OTA url queued ");
        Serial.println(pending_ota_url);
        return;
    }

    if (strcmp(topic, MQTT_TOPIC_MACRO) == 0) {
        if (millis() < mqtt_ready_at) {
            Serial.println("macro ignored: mqtt settle");
            return;
        }
        if (strcasecmp(buf, "STOP") == 0) {
            Serial.println("macro STOP");
            macro_stop_req = true;
            return;
        }
        strncpy(macro_pending_start, buf, sizeof(macro_pending_start) - 1);
        macro_pending_start[sizeof(macro_pending_start) - 1] = '\0';
        macro_has_start = true;
        return;
    }

    if (strcmp(topic, MQTT_TOPIC_COMMAND) != 0) {
        return;
    }

    if (strcmp(buf, "PING") == 0 || strcmp(buf, "HB") == 0) {
        mqtt.publish(MQTT_TOPIC_ACK, "PONG", false);
        mqtt.publish(MQTT_TOPIC_STATUS, "online", true);
        publish_usb();
        publish_ip();
        publish_fw();
        Serial.println("PING");
        return;
    }

    if (millis() < mqtt_ready_at) {
        Serial.println("command ignored: mqtt settle");
        return;
    }

    const int fn = parse_fn(buf);
    if (fn != 0) {
        pending_fn = fn;
        return;
    }
    const int mouse = parse_mouse(buf);
    if (mouse != 0) {
        pending_mouse = mouse;
        return;
    }
    if (parse_enter(buf)) {
        pending_enter = true;
        return;
    }
    uint8_t raw = 0;
    char label[12];
    if (parse_seq_key(buf, &raw, label, sizeof(label))) {
        strncpy(pending_raw_label, label, sizeof(pending_raw_label) - 1);
        pending_raw_label[sizeof(pending_raw_label) - 1] = '\0';
        pending_raw = raw;
        return;
    }
    Serial.print("command ignored: ");
    Serial.println(buf);
}

static void mqtt_disconnect_cleanup() {
    pending_fn = 0;
    pending_mouse = 0;
    pending_enter = false;
    pending_raw = 0;
    macro_stop_req = true;
    keys_need_abort = true;
    mqtt_ready_at = 0;
}

static void wifi_begin_now(const char *why);

static void copy_cfg_arg(char *dst, size_t dstlen, const char *src) {
    while (*src == ' ' || *src == '\t') {
        src++;
    }
    strncpy(dst, src, dstlen - 1);
    dst[dstlen - 1] = 0;
    size_t n = strlen(dst);
    while (n > 0 && (dst[n - 1] == ' ' || dst[n - 1] == '\t')) {
        dst[--n] = 0;
    }
}

static void cfg_fill_blob(CfgFlash *blob) {
    memset(blob, 0, sizeof(*blob));
    blob->magic = CFG_FLASH_MAGIC;
    strncpy(blob->wifi, wifi_ssid, sizeof(blob->wifi) - 1);
    strncpy(blob->pass, wifi_pass, sizeof(blob->pass) - 1);
    strncpy(blob->mqtt, mqtt_host, sizeof(blob->mqtt) - 1);
    blob->sum = cfg_flash_sum(blob);
}

static bool cfg_apply_blob(const CfgFlash *blob) {
    if (blob->magic != CFG_FLASH_MAGIC || blob->sum != cfg_flash_sum(blob) || !blob->wifi[0] || !blob->mqtt[0]) {
        return false;
    }
    strncpy(wifi_ssid, blob->wifi, sizeof(wifi_ssid) - 1);
    strncpy(wifi_pass, blob->pass, sizeof(wifi_pass) - 1);
    strncpy(mqtt_host, blob->mqtt, sizeof(mqtt_host) - 1);
    wifi_ssid[sizeof(wifi_ssid) - 1] = 0;
    wifi_pass[sizeof(wifi_pass) - 1] = 0;
    mqtt_host[sizeof(mqtt_host) - 1] = 0;
    return true;
}

static const uint32_t kCfgFlashAddrs[] = {
    CFG_FLASH_ADDR,
    CFG_FLASH_ADDR_ALT,
    CFG_FLASH_ADDR_LEGACY,
};

static uint32_t cfg_flash_used_end() {
    const uint32_t sketch = (ESP.getSketchSize() + 4095u) & ~4095u;
    return 0x10000u + sketch + 4096u;
}

static bool cfg_addr_after_app(uint32_t addr) {
    return addr >= cfg_flash_used_end();
}

static uint32_t cfg_safe_flash_addr() {
    uint32_t size = 0;
    if (esp_flash_get_size(NULL, &size) != ESP_OK || size < 8192) {
        size = 0x1000000u;
    }
    const uint32_t used = cfg_flash_used_end();
    Serial.print("KLOG flash-size 0x");
    Serial.print(size, HEX);
    Serial.print(" used-end 0x");
    Serial.println(used, HEX);
    for (size_t i = 0; i < sizeof(kCfgFlashAddrs) / sizeof(kCfgFlashAddrs[0]); i++) {
        const uint32_t addr = kCfgFlashAddrs[i];
        if (addr + 4096u <= size && cfg_addr_after_app(addr)) {
            return addr;
        }
    }
    Serial.println("KLOG flash-no-addr");
    return 0;
}

static bool cfg_nvs_init() {
    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        err = nvs_flash_init();
    }
    return err == ESP_OK;
}

static bool cfg_nvs_write_and_verify() {
    if (!cfg_nvs_init()) {
        Serial.println("KLOG nvs-init-fail");
        return false;
    }
    nvs_handle_t handle;
    esp_err_t err = nvs_open("klikac", NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        Serial.print("KLOG nvs-open ");
        Serial.println((int)err);
        return false;
    }
    CfgFlash blob;
    cfg_fill_blob(&blob);
    const esp_err_t e1 = nvs_set_blob(handle, "cfg", &blob, sizeof(blob));
    const esp_err_t ec = nvs_commit(handle);
    CfgFlash readback;
    memset(&readback, 0, sizeof(readback));
    size_t n = sizeof(readback);
    const esp_err_t gw = nvs_get_blob(handle, "cfg", &readback, &n);
    nvs_close(handle);
    Serial.print("KLOG nvs-blob set=");
    Serial.print((int)e1);
    Serial.print(" c=");
    Serial.print((int)ec);
    Serial.print(" get=");
    Serial.println((int)gw);
    const bool ok = e1 == ESP_OK && ec == ESP_OK && gw == ESP_OK && cfg_apply_blob(&readback)
        && strcmp(readback.wifi, wifi_ssid) == 0 && strcmp(readback.mqtt, mqtt_host) == 0;
    Serial.print("KLOG saved wifi=");
    Serial.println(ok ? readback.wifi : "(empty)");
    Serial.print("KLOG saved mqtt=");
    Serial.println(ok ? readback.mqtt : "(empty)");
    return ok;
}

static bool cfg_flash_matches() {
    const uint32_t addr = cfg_safe_flash_addr();
    if (!addr) {
        return false;
    }
    CfgFlash blob;
    memset(&blob, 0, sizeof(blob));
    if (esp_flash_read(NULL, &blob, addr, sizeof(blob)) != ESP_OK) {
        return false;
    }
    return cfg_apply_blob(&blob)
        && strcmp(blob.wifi, wifi_ssid) == 0
        && strcmp(blob.mqtt, mqtt_host) == 0;
}

static bool cfg_flash_write_and_verify() {
    const uint32_t addr = cfg_safe_flash_addr();
    if (!addr) {
        Serial.println("KLOG flash-no-addr");
        return false;
    }
    if (cfg_flash_matches()) {
        Serial.println("KLOG flash-already");
        return true;
    }
    Serial.print("KLOG flash-addr 0x");
    Serial.println(addr, HEX);
    Serial.print("KLOG flash-write n=");
    Serial.print((int)strlen(wifi_ssid));
    Serial.print("/");
    Serial.println((int)strlen(mqtt_host));
    CfgFlash blob;
    cfg_fill_blob(&blob);
    esp_err_t err = esp_flash_erase_region(NULL, addr, 4096);
    if (err != ESP_OK) {
        Serial.print("KLOG flash-erase ");
        Serial.println((int)err);
        return false;
    }
    err = esp_flash_write(NULL, &blob, addr, sizeof(blob));
    if (err != ESP_OK) {
        Serial.print("KLOG flash-write ");
        Serial.println((int)err);
        return false;
    }
    CfgFlash readback;
    memset(&readback, 0, sizeof(readback));
    err = esp_flash_read(NULL, &readback, addr, sizeof(readback));
    if (err != ESP_OK || !cfg_apply_blob(&readback)) {
        Serial.print("KLOG flash-read ");
        Serial.println((int)err);
        return false;
    }
    Serial.print("KLOG flash-saved wifi=");
    Serial.println(readback.wifi);
    Serial.print("KLOG flash-saved mqtt=");
    Serial.println(readback.mqtt);
    return strcmp(readback.wifi, wifi_ssid) == 0 && strcmp(readback.mqtt, mqtt_host) == 0;
}

static bool cfg_flash_load_at(uint32_t addr) {
    CfgFlash blob;
    memset(&blob, 0, sizeof(blob));
    const esp_err_t err = esp_flash_read(NULL, &blob, addr, sizeof(blob));
    Serial.print("KLOG flash-try 0x");
    Serial.print(addr, HEX);
    Serial.print(" e=");
    Serial.print((int)err);
    Serial.print(" mag=0x");
    Serial.println(blob.magic, HEX);
    if (err != ESP_OK || !cfg_apply_blob(&blob)) {
        return false;
    }
    Serial.print("KLOG cfg-flash 0x");
    Serial.print(addr, HEX);
    Serial.print(" wifi=");
    Serial.print(wifi_ssid);
    Serial.print(" mqtt=");
    Serial.println(mqtt_host);
    return true;
}

static bool cfg_flash_load() {
    uint32_t size = 0;
    if (esp_flash_get_size(NULL, &size) != ESP_OK || size < 8192) {
        size = 0x1000000u;
    }
    for (size_t i = 0; i < sizeof(kCfgFlashAddrs) / sizeof(kCfgFlashAddrs[0]); i++) {
        const uint32_t addr = kCfgFlashAddrs[i];
        if (addr + 4096u > size) {
            continue;
        }
        if (cfg_flash_load_at(addr)) {
            return true;
        }
    }
    return false;
}

static bool cfg_nvs_load() {
    if (!cfg_nvs_init()) {
        return false;
    }
    nvs_handle_t handle;
    if (nvs_open("klikac", NVS_READONLY, &handle) != ESP_OK) {
        return false;
    }
    CfgFlash blob;
    memset(&blob, 0, sizeof(blob));
    size_t n = sizeof(blob);
    if (nvs_get_blob(handle, "cfg", &blob, &n) == ESP_OK && cfg_apply_blob(&blob)) {
        nvs_close(handle);
        Serial.print("KLOG cfg-nvs wifi=");
        Serial.print(wifi_ssid);
        Serial.print(" mqtt=");
        Serial.println(mqtt_host);
        return true;
    }
    char w[33] = {0};
    char p[65] = {0};
    char m[48] = {0};
    size_t lw = sizeof(w);
    size_t lp = sizeof(p);
    size_t lm = sizeof(m);
    const bool okW = nvs_get_str(handle, "wifi", w, &lw) == ESP_OK && w[0];
    const bool okP = nvs_get_str(handle, "pass", p, &lp) == ESP_OK;
    const bool okM = nvs_get_str(handle, "mqtt", m, &lm) == ESP_OK && m[0];
    nvs_close(handle);
    if (!okW || !okM) {
        return false;
    }
    strncpy(wifi_ssid, w, sizeof(wifi_ssid) - 1);
    if (okP) {
        strncpy(wifi_pass, p, sizeof(wifi_pass) - 1);
    }
    strncpy(mqtt_host, m, sizeof(mqtt_host) - 1);
    Serial.print("KLOG cfg-nvs wifi=");
    Serial.print(wifi_ssid);
    Serial.print(" mqtt=");
    Serial.println(mqtt_host);
    return true;
}

static bool cfg_save(bool force_flash) {
    if (!wifi_ssid[0] || !mqtt_host[0]) {
        Serial.print("KLOG apply-empty wifi=");
        Serial.print(wifi_ssid[0] ? wifi_ssid : "(empty)");
        Serial.print(" mqtt=");
        Serial.println(mqtt_host[0] ? mqtt_host : "(empty)");
        return false;
    }
    if (force_flash) {
        Serial.println("KLOG force-flash");
        if (cfg_flash_matches()) {
            Serial.println("KLOG flash-already");
            return true;
        }
        if (cfg_flash_write_and_verify()) {
            cfg_nvs_write_and_verify();
            return true;
        }
    }
    if (cfg_nvs_write_and_verify()) {
        if (!cfg_flash_matches()) {
            Serial.println("KLOG flash-mirror");
            cfg_flash_write_and_verify();
        }
        return true;
    }
    Serial.println("KLOG flash-fallback");
    if (cfg_flash_write_and_verify()) {
        return true;
    }
    Serial.println("KLOG nvs-erase");
    nvs_flash_erase();
    nvs_flash_init();
    return cfg_nvs_write_and_verify();
}

static void cfg_load() {
    wifi_ssid[0] = 0;
    wifi_pass[0] = 0;
    mqtt_host[0] = 0;
    if (cfg_flash_load() || cfg_nvs_load()) {
        return;
    }
    Serial.println("KLOG cfg-none");
    strncpy(wifi_ssid, WIFI_SSID, sizeof(wifi_ssid) - 1);
    strncpy(wifi_pass, WIFI_PASSWORD, sizeof(wifi_pass) - 1);
    strncpy(mqtt_host, MQTT_HOST, sizeof(mqtt_host) - 1);
}

static void cfg_handle_line(char *line) {
    if (strncmp(line, "KCFG WIFI ", 10) == 0) {
        copy_cfg_arg(wifi_ssid, sizeof(wifi_ssid), line + 10);
        Serial.print("KLOG wifi-ok n=");
        Serial.println(strlen(wifi_ssid));
        return;
    }
    if (strncmp(line, "KCFG PASS ", 10) == 0) {
        copy_cfg_arg(wifi_pass, sizeof(wifi_pass), line + 10);
        Serial.print("KLOG pass-ok n=");
        Serial.println(strlen(wifi_pass));
        return;
    }
    if (strncmp(line, "KCFG MQTT ", 10) == 0) {
        copy_cfg_arg(mqtt_host, sizeof(mqtt_host), line + 10);
        Serial.print("KLOG mqtt-ok n=");
        Serial.println(strlen(mqtt_host));
        return;
    }
    if (strcmp(line, "KCFG STATUS") == 0) {
        Serial.print("KLOG fw=");
        Serial.println(FIRMWARE_VERSION);
        Serial.print("KLOG wifi=");
        Serial.println(wifi_ssid[0] ? wifi_ssid : "(empty)");
        Serial.print("KLOG mqtt=");
        Serial.println(mqtt_host[0] ? mqtt_host : "(empty)");
        Serial.print("KLOG wifi-sta=");
        Serial.println((int)WiFi.status());
        Serial.print("KLOG wifi-ip=");
        Serial.println(WiFi.localIP());
        Serial.print("KLOG mqtt-rc=");
        Serial.println(mqtt.state());
        return;
    }
    if (strcmp(line, "KCFG APPLY") == 0 || strcmp(line, "KCFG FORCE") == 0) {
        const bool force_flash = strcmp(line, "KCFG FORCE") == 0;
        const bool ok = cfg_save(force_flash);
        Serial.print("KLOG apply wifi=");
        Serial.print(wifi_ssid[0] ? wifi_ssid : "(empty)");
        Serial.print(" mqtt=");
        Serial.println(mqtt_host[0] ? mqtt_host : "(empty)");
        if (!ok) {
            Serial.println("KLOG apply-nvs-fail");
            return;
        }
        Serial.println("KLOG restart");
        delay(300);
        ESP.restart();
    }
}

static void serial_poll() {
    while (Serial.available() > 0) {
        const char c = (char)Serial.read();
        if (c == '\r') {
            continue;
        }
        if (c == '\n') {
            serial_line[serial_len] = 0;
            if (serial_len > 0) {
                cfg_handle_line(serial_line);
            }
            serial_len = 0;
            continue;
        }
        if (serial_len + 1 < sizeof(serial_line)) {
            serial_line[serial_len++] = c;
        } else {
            serial_len = 0;
        }
    }
}

static bool mqtt_connect() {
    if (!mqtt_host[0]) {
        Serial.println("MQTT skipped: no host (USB init)");
        return false;
    }
    mqtt.setServer(mqtt_host, MQTT_BROKER_PORT);
    mqtt.setCallback(mqtt_callback);
    mqtt.setBufferSize(MACRO_START_MAX);
    mqtt.setKeepAlive(MQTT_KEEPALIVE_S);

    const bool ok = mqtt.connect(mqtt_client_id, MQTT_USER, MQTT_PASSWORD, MQTT_TOPIC_STATUS, 1, true, "offline");
    if (!ok) {
        Serial.print("MQTT failed, rc=");
        Serial.print(mqtt.state());
        Serial.print(" host=");
        Serial.println(mqtt_host);
        return false;
    }

    mqtt.subscribe(MQTT_TOPIC_COMMAND, 0);
    mqtt.subscribe(MQTT_TOPIC_MACRO, 0);
    mqtt.subscribe(MQTT_TOPIC_OTA, 0);
    mqtt.publish(MQTT_TOPIC_STATUS, "online", true);
    last_heartbeat = millis();
    mqtt_reannounce_at = millis() + 400;
    publish_discovery();
    publish_usb();
    publish_ip();
    publish_fw();
    mqtt_ready_at = millis() + MQTT_SETTLE_MS;
    pending_fn = 0;
    pending_mouse = 0;
    pending_enter = false;
    pending_raw = 0;
    Serial.println("MQTT connected");
    return true;
}

static void ota_setup() {
    if (ota_started) {
        return;
    }
    ArduinoOTA.setHostname(OTA_HOSTNAME);
    ArduinoOTA.setPassword(OTA_PASSWORD);
    ArduinoOTA.setMdnsEnabled(false);
    ArduinoOTA.onStart([]() {
        keys_need_abort = true;
        macro_stop_req = true;
        Keyboard.releaseAll();
        mouse_release_all();
        Serial.println("OTA start");
    });
    ArduinoOTA.onEnd([]() {
        Serial.println("OTA end");
    });
    ArduinoOTA.onError([](ota_error_t error) {
        Serial.print("OTA error ");
        Serial.println((unsigned)error);
    });
    ArduinoOTA.begin();
    ota_started = true;
    ota_ready = true;
    Serial.print("OTA ready ");
    Serial.println(WiFi.localIP());
}

static void wifi_begin_now(const char *why) {
    if (!wifi_ssid[0]) {
        Serial.println("Wi-Fi čeká na USB KCFG");
        return;
    }
    Serial.print("Wi-Fi ");
    Serial.print(why);
    Serial.print(" ");
    Serial.println(wifi_ssid);
    WiFi.persistent(false);
    WiFi.mode(WIFI_STA);
    WiFi.setHostname(OTA_HOSTNAME);
    WiFi.setSleep(false);
    WiFi.setAutoReconnect(true);
    WiFi.setTxPower(WIFI_POWER_19_5dBm);
    if (wifi_begin_at) {
        WiFi.disconnect(false, false);
        delay(50);
    }
    WiFi.begin(wifi_ssid, wifi_pass);
    wifi_begin_at = millis();
    last_wifi_attempt = wifi_begin_at;
}

static void wifi_mqtt_loop() {
    const uint32_t now = millis();

    if (WiFi.status() != WL_CONNECTED) {
        wifi_ok_since = 0;
        ota_ready = false;
        if (ota_started) {
            ArduinoOTA.end();
            ota_started = false;
        }
        if (mqtt.connected()) {
            mqtt.disconnect();
            mqtt_disconnect_cleanup();
        }
        if (!wifi_ssid[0]) {
            return;
        }
        if (!wifi_begin_at) {
            const uint32_t armed = wifi_armed_at;
            const bool after_usb = armed && now >= armed;
            const bool fallback = !wifi_start_at || now >= wifi_start_at;
            if (after_usb || fallback) {
                wifi_begin_now(after_usb ? "after-usb" : "start");
            }
            return;
        }
        if ((now - wifi_begin_at) < WIFI_GIVEUP_MS) {
            if (now - last_wifi_attempt >= 5000) {
                last_wifi_attempt = now;
                Serial.print("KLOG wifi-sta=");
                Serial.println((int)WiFi.status());
            }
            return;
        }
        wifi_begin_now("reconnect");
        return;
    }

    if (wifi_ok_since == 0) {
        wifi_ok_since = millis();
    }

    if (!mqtt.connected()) {
        if (!mqtt_host[0]) {
            return;
        }
        if (now - last_mqtt_attempt >= MQTT_RECONNECT_MS) {
            last_mqtt_attempt = now;
            mqtt_connect();
        }
    } else {
        mqtt.loop();
        if (mqtt_reannounce_at && now >= mqtt_reannounce_at) {
            mqtt_reannounce_at = 0;
            mqtt.publish(MQTT_TOPIC_STATUS, "online", true);
            publish_usb();
            publish_ip();
            publish_fw();
        }
        if (now - last_heartbeat >= MQTT_HEARTBEAT_MS) {
            last_heartbeat = now;
            mqtt.publish(MQTT_TOPIC_STATUS, "online", true);
            publish_fw();
        }
    }

    if (!ota_started && mqtt.connected() && (millis() - wifi_ok_since) >= OTA_AFTER_MQTT_MS) {
        ota_setup();
    }
    if (ota_ready) {
        ArduinoOTA.handle();
    }
}

void setup() {
#ifdef RTC_CNTL_BROWN_OUT_REG
    WRITE_PERI_REG(RTC_CNTL_BROWN_OUT_REG, 0);
#endif
    pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);

    Serial.begin(115200);
    delay(200);
    Serial.println();
    Serial.print("klikac firmware ");
    Serial.println(FIRMWARE_VERSION);
    cfg_load();
    Serial.print("KLOG wifi=");
    Serial.println(wifi_ssid[0] ? wifi_ssid : "(empty)");
    Serial.print("KLOG mqtt=");
    Serial.println(mqtt_host[0] ? mqtt_host : "(empty)");

    snprintf(mqtt_client_id, sizeof(mqtt_client_id), MQTT_CLIENT_ID_PREFIX "%04X", (uint16_t)(ESP.getEfuseMac() & 0xFFFF));
    wifi_start_at = millis() + WIFI_START_DELAY_MS;
    last_wifi_attempt = 0;
    wifi_begin_at = 0;
    wifi_armed_at = 0;
    if (wifi_ssid[0]) {
        wifi_begin_now("boot");
    } else {
        Serial.println("Wi-Fi čeká na USB inicializaci (KCFG)");
    }

    USB.onEvent(usb_event);
    USB.VID(USB_DEVICE_VID);
    USB.PID(USB_DEVICE_PID);
    USB.manufacturerName(USB_DEVICE_MANUFACTURER);
    USB.productName(USB_DEVICE_PRODUCT);
    USB.serialNumber(USB_DEVICE_SERIAL);
    USB.usbPower(USB_DEVICE_POWER_MA);

    Keyboard.begin();
    Mouse.begin();
    USB.begin();
    Serial.println("USB HID keyboard+mouse started");
}

void loop() {
    if (usb_needs_release || keys_need_abort || macro_stop_req) {
        const bool hid_ok = usb_mounted && !usb_needs_release;
        usb_needs_release = false;
        keys_need_abort = false;
        macro_stop_req = false;
        pending_fn = 0;
        pending_mouse = 0;
        pending_enter = false;
        pending_raw = 0;
        macros_clear();
        if (hid_ok) {
            Keyboard.releaseAll();
            mouse_release_all();
        }
    }

    serial_poll();
    wifi_mqtt_loop();

    if (usb_announce) {
        usb_announce = false;
        if (mqtt.connected()) {
            mqtt.publish(MQTT_TOPIC_STATUS, "online", true);
            publish_usb();
        }
    }

    if (usb_mounted && (millis() - last_hid_keep) >= HID_KEEPALIVE_MS) {
        last_hid_keep = millis();
        if (!hid_holding && !macros_any_active() && !pending_fn && !pending_mouse && !pending_enter && !pending_raw) {
            Keyboard.releaseAll();
        }
    }

    if (http_ota_req) {
        http_ota_req = false;
        run_http_ota(pending_ota_url);
        pending_ota_url[0] = '\0';
        return;
    }

    if (macro_has_start) {
        macro_has_start = false;
        if (parse_macro_start(macro_pending_start)) {
            int started = 0;
            for (int i = 0; i < MACRO_SLOTS; i++) {
                if (!macros[i].active) {
                    continue;
                }
                started++;
                Serial.print("macro start ");
                Serial.print(i + 1);
                Serial.print(" loop=");
                Serial.print(macros[i].loop ? 1 : 0);
                Serial.print(" D=");
                Serial.print(macros[i].dmin);
                Serial.print("-");
                Serial.print(macros[i].dmax);
                Serial.print(" seq=");
                Serial.println(macros[i].seq);
            }
            if (mqtt.connected()) {
                char ack[16];
                snprintf(ack, sizeof(ack), "MACROS:%d", started);
                mqtt.publish(MQTT_TOPIC_ACK, ack, false);
            }
        } else {
            Serial.print("macro bad payload: ");
            Serial.println(macro_pending_start);
            if (mqtt.connected()) {
                mqtt.publish(MQTT_TOPIC_ACK, "MACROS:0", false);
            }
        }
    }

    if (mqtt.connected() && last_usb_published != (bool)usb_mounted) {
        publish_usb();
    }

    const int fn = pending_fn;
    if (fn != 0) {
        pending_fn = 0;
        if (usb_mounted) {
            send_fn(fn);
        } else {
            Serial.println("pending key dropped: USB not mounted");
        }
    }

    const int mouse = pending_mouse;
    if (mouse != 0) {
        pending_mouse = 0;
        if (usb_mounted) {
            send_mouse(mouse);
        } else {
            Serial.println("pending click dropped: USB not mounted");
        }
    }

    if (pending_enter) {
        pending_enter = false;
        if (usb_mounted) {
            send_enter();
        } else {
            Serial.println("pending key dropped: USB not mounted");
        }
    }

    const uint8_t raw = pending_raw;
    if (raw != 0) {
        pending_raw = 0;
        if (usb_mounted) {
            send_raw_key(raw, pending_raw_label);
        } else {
            Serial.println("pending key dropped: USB not mounted");
        }
    }

    if (usb_mounted && macros_any_active()) {
        for (int i = 0; i < MACRO_SLOTS; i++) {
            if (macros[i].active) {
                macro_step(&macros[i], i);
            }
        }
    }

    const int button = digitalRead(BOOT_BUTTON_PIN);
    const uint32_t now = millis();
    if (button != last_button && (now - last_button_ms) >= BUTTON_DEBOUNCE_MS) {
        last_button_ms = now;
        last_button = button;
        if (button == LOW && usb_mounted) {
            Serial.print("HID F1 (BOOT)");
            human_key(KEY_F1);
        }
    }
}
