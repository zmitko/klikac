const mqtt = require("mqtt");
const { MQTT_PORT, MQTT_USER, MQTT_PASSWORD } = require("./mqttCreds");

const TOPIC_COMMAND = "esp32kbd/command";
const TOPIC_MACRO = "esp32kbd/macro";
const TOPIC_STATUS = "esp32kbd/status";
const TOPIC_USB = "esp32kbd/usb";
const TOPIC_ACK = "esp32kbd/ack";
const TOPIC_IP = "esp32kbd/ip";
const TOPIC_FW = "esp32kbd/fw";
const TOPIC_OTA_STATUS = "esp32kbd/ota_status";
const LIVE_MS = 25000;

class MqttBridge {
  constructor(opts, onChange, onLog) {
    this.opts = opts;
    this.onChange = onChange;
    this.onLog = onLog;
    this.client = null;
    this.device = {
      mqtt: "disconnected",
      status: "offline",
      usb: "unknown",
      ip: "",
      ack: "",
      ackAt: 0,
      lastLiveAt: 0,
      fw: "",
      otaStatus: "",
      health: "",
      healthAt: 0,
    };
  }

  start() {
    const host = this.opts.host || "127.0.0.1";
    const port = this.opts.port || MQTT_PORT;
    const url = `mqtt://${host}:${port}`;
    this.client = mqtt.connect(url, {
      username: this.opts.user || MQTT_USER,
      password: this.opts.password || MQTT_PASSWORD,
      clientId: `klikac-win-${Math.random().toString(16).slice(2, 8)}`,
      keepalive: 20,
      reconnectPeriod: 2000,
      clean: true,
      connectTimeout: 8000,
    });

    this.client.on("connect", () => {
      this.device.mqtt = "connected";
      this.log("app připojená na lokální broker");
      this.client.subscribe([TOPIC_STATUS, TOPIC_USB, TOPIC_ACK, TOPIC_IP, TOPIC_FW, TOPIC_OTA_STATUS], { qos: 0 });
      this.emit();
    });
    this.client.on("reconnect", () => {
      this.device.mqtt = "connecting";
      this.emit();
    });
    this.client.on("close", () => {
      this.device.mqtt = "disconnected";
      this.emit();
    });
    this.client.on("offline", () => {
      this.device.mqtt = "disconnected";
      this.emit();
    });
    this.client.on("error", (err) => {
      this.device.mqtt = "error";
      this.log(`chyba ${err.message}`);
      this.emit();
    });
    this.client.on("message", (topic, payload) => {
      const text = payload.toString("utf8").trim();
      if (topic === TOPIC_STATUS) {
        if (text) {
          this.device.status = text;
        }
        if (text === "online") {
          this.touchLive();
        }
      } else if (topic === TOPIC_USB) {
        this.device.usb = text || "unknown";
      } else if (topic === TOPIC_IP) {
        this.device.ip = text;
      } else if (topic === TOPIC_ACK) {
        this.device.ack = text;
        this.device.ackAt = Date.now();
        this.touchLive();
      } else if (topic === TOPIC_FW) {
        this.device.fw = text;
        this.touchLive();
      } else if (topic === TOPIC_OTA_STATUS) {
        this.device.otaStatus = text;
        this.touchLive();
      }
      this.emit();
    });
    setInterval(() => this.emit(), 4000);
  }

  log(msg) {
    if (typeof this.onLog === "function") {
      this.onLog("app", msg);
    }
  }

  touchLive() {
    this.device.lastLiveAt = Date.now();
  }

  isLive() {
    if (this.device.status === "online") {
      return true;
    }
    return !!(this.device.lastLiveAt && (Date.now() - this.device.lastLiveAt) < LIVE_MS);
  }

  emit() {
    if (typeof this.onChange === "function") {
      this.onChange(this.snapshot());
    }
  }

  snapshot() {
    return { ...this.device, live: this.isLive() };
  }

  isReady() {
    return !!(this.client && this.client.connected);
  }

  publishCommand(payload) {
    return this.publish(TOPIC_COMMAND, payload);
  }

  publishMacro(payload) {
    return this.publish(TOPIC_MACRO, payload);
  }

  publish(topic, payload) {
    if (!this.isReady()) {
      const err = new Error("MQTT není připojený");
      err.code = "MQTT_OFF";
      throw err;
    }
    const text = String(payload);
    this.client.publish(topic, text, { qos: 0, retain: false });
  }

  async ping(timeoutMs = 1800) {
    this.device.health = "checking";
    this.device.healthAt = Date.now();
    this.emit();
    if (!this.isReady()) {
      this.device.health = "timeout";
      this.log("healthcheck: MQTT broker není připojený");
      this.emit();
      return this.snapshot();
    }
    const startedAckAt = this.device.ackAt;
    this.publish(TOPIC_COMMAND, "PING");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 80));
      if (this.device.ackAt > startedAckAt && this.device.ack === "PONG") {
        this.device.health = "ok";
        this.device.healthAt = Date.now();
        this.touchLive();
        this.log("healthcheck: destička PONG");
        this.emit();
        return this.snapshot();
      }
    }
    this.device.health = "timeout";
    this.device.healthAt = Date.now();
    this.log("healthcheck: destička neodpověděla");
    this.emit();
    return this.snapshot();
  }
}

module.exports = { MqttBridge, TOPIC_COMMAND, TOPIC_MACRO, TOPIC_OTA: "esp32kbd/ota" };
