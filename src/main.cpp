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
#include <esp_system.h>
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

static int last_button = HIGH;
static uint32_t last_button_ms = 0;
static char mqtt_client_id[24];
static char pending_ota_url[HTTP_OTA_URL_MAX];
static volatile bool http_ota_req = false;

static const uint8_t kFnHid[9] = {
    0, KEY_F1, KEY_F2, KEY_F3, KEY_F4, KEY_F5, KEY_F6, KEY_F7, KEY_F8,
};

static void usb_event(void *arg, esp_event_base_t base, int32_t id, void *data) {
    (void)arg;
    (void)base;
    (void)data;
    switch (id) {
        case ARDUINO_USB_STARTED_EVENT:
        case ARDUINO_USB_RESUME_EVENT:
            usb_mounted = true;
            break;
        case ARDUINO_USB_STOPPED_EVENT:
        case ARDUINO_USB_SUSPEND_EVENT:
            usb_mounted = false;
            usb_needs_release = true;
            pending_fn = 0;
            pending_mouse = 0;
            pending_enter = false;
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
    Serial.print(" hold=");
    Serial.print(hold_ms);
    Serial.println("ms");
}

static void send_fn(int n) {
    if (n < 1 || n > 8) {
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
        char ack[3] = {'F', (char)('0' + n), 0};
        mqtt.publish(MQTT_TOPIC_ACK, ack, false);
    }
}

static void human_click(uint8_t button) {
    if (!usb_mounted) {
        return;
    }
    const uint32_t hold_ms = human_hold_ms();
    Mouse.press(button);
    const uint32_t start = millis();
    while ((millis() - start) < hold_ms) {
        if (!usb_mounted || keys_need_abort) {
            break;
        }
        idle_poll();
    }
    Mouse.release(button);
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
    if ((s[0] == 'F' || s[0] == 'f') && s[1] >= '1' && s[1] <= '8' && s[2] == '\0') {
        return s[1] - '0';
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
    Serial.print("command ignored: ");
    Serial.println(buf);
}

static void mqtt_disconnect_cleanup() {
    pending_fn = 0;
    pending_mouse = 0;
    pending_enter = false;
    macro_stop_req = true;
    keys_need_abort = true;
    mqtt_ready_at = 0;
}

static bool mqtt_connect() {
    mqtt.setServer(MQTT_HOST, MQTT_PORT);
    mqtt.setCallback(mqtt_callback);
    mqtt.setBufferSize(MACRO_START_MAX);
    mqtt.setKeepAlive(MQTT_KEEPALIVE_S);

    const bool ok = mqtt.connect(mqtt_client_id, MQTT_USER, MQTT_PASSWORD, MQTT_TOPIC_STATUS, 1, true, "offline");
    if (!ok) {
        Serial.print("MQTT failed, rc=");
        Serial.println(mqtt.state());
        return false;
    }

    mqtt.subscribe(MQTT_TOPIC_COMMAND, 0);
    mqtt.subscribe(MQTT_TOPIC_MACRO, 0);
    mqtt.subscribe(MQTT_TOPIC_OTA, 0);
    mqtt.publish(MQTT_TOPIC_STATUS, "online", true);
    last_heartbeat = millis();
    publish_discovery();
    publish_usb();
    publish_ip();
    publish_fw();
    mqtt_ready_at = millis() + MQTT_SETTLE_MS;
    pending_fn = 0;
    pending_mouse = 0;
    pending_enter = false;
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

static void wifi_mqtt_loop() {
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
        const uint32_t now = millis();
        if (now - last_wifi_attempt >= WIFI_RECONNECT_MS) {
            last_wifi_attempt = now;
            Serial.println("Wi-Fi reconnect");
            WiFi.disconnect();
            WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
        }
        return;
    }

    if (wifi_ok_since == 0) {
        wifi_ok_since = millis();
    }

    if (!mqtt.connected()) {
        const uint32_t now = millis();
        if (now - last_mqtt_attempt >= MQTT_RECONNECT_MS) {
            last_mqtt_attempt = now;
            mqtt_connect();
        }
    } else {
        mqtt.loop();
        const uint32_t now_hb = millis();
        if (now_hb - last_heartbeat >= MQTT_HEARTBEAT_MS) {
            last_heartbeat = now_hb;
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
    pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);

    Serial.begin(115200);
    delay(200);
    Serial.println();
    Serial.print("klikac firmware ");
    Serial.println(FIRMWARE_VERSION);

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
    Keyboard.releaseAll();
    mouse_release_all();
    Serial.println("USB HID keyboard+mouse started");

    snprintf(mqtt_client_id, sizeof(mqtt_client_id), MQTT_CLIENT_ID_PREFIX "%04X", (uint16_t)(ESP.getEfuseMac() & 0xFFFF));

    WiFi.mode(WIFI_STA);
    WiFi.setHostname(OTA_HOSTNAME);
    WiFi.setAutoReconnect(true);
    WiFi.persistent(true);
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
    last_wifi_attempt = millis();
    Serial.print("Wi-Fi connecting to ");
    Serial.println(WIFI_SSID);
}

void loop() {
    if (usb_needs_release || keys_need_abort || macro_stop_req) {
        usb_needs_release = false;
        keys_need_abort = false;
        macro_stop_req = false;
        pending_fn = 0;
        pending_mouse = 0;
        pending_enter = false;
        macros_clear();
        Keyboard.releaseAll();
        mouse_release_all();
    }

    wifi_mqtt_loop();

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
