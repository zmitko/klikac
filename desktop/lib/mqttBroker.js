const net = require("net");
const { Aedes } = require("aedes");
const { execFile } = require("child_process");
const { MQTT_PORT, MQTT_USER, MQTT_PASSWORD } = require("./mqttCreds");
const { lanIPv4 } = require("./lan");

class MqttBroker {
  constructor({ onLog }) {
    this.onLog = onLog;
    this.broker = null;
    this.server = null;
    this.port = MQTT_PORT;
    this.lanIp = "";
  }

  log(msg) {
    if (typeof this.onLog === "function") {
      this.onLog("mqtt", msg);
    }
  }

  snapshot() {
    return {
      port: this.port,
      lanIp: this.lanIp || lanIPv4(),
      clients: this.broker ? this.broker.connectedClients : 0,
      listening: !!(this.server && this.server.listening),
    };
  }

  async start() {
    this.lanIp = lanIPv4();
    this.broker = await Aedes.createBroker({
      authenticate: (client, username, password, done) => {
        const user = String(username || "");
        const pass = password ? password.toString() : "";
        const ok = user === MQTT_USER && pass === MQTT_PASSWORD;
        if (!ok) {
          this.log(`auth fail ${user} (${client && client.id ? client.id : "?"})`);
        }
        done(null, ok);
      },
    });
    this.broker.on("clientReady", (client) => {
      this.log(`klient ${client.id}`);
    });
    this.broker.on("clientDisconnect", (client) => {
      this.log(`klient pryč ${client && client.id ? client.id : "?"}`);
    });
    this.broker.on("clientError", (client, err) => {
      this.log(`klient chyba ${client && client.id ? client.id : "?"}: ${err.message}`);
    });
    this.broker.on("connectionError", (_client, err) => {
      this.log(`spojení chyba: ${err.message}`);
    });
    this.broker.on("publish", (packet, client) => {
      if (!client || !packet || !packet.topic) {
        return;
      }
      const topic = String(packet.topic);
      if (topic.startsWith("$SYS/")) {
        return;
      }
      const payload = packet.payload ? packet.payload.toString("utf8").slice(0, 80) : "";
      this.log(`${client.id} → ${topic} ${payload}`);
    });
    this.server = net.createServer(this.broker.handle);
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "0.0.0.0", () => {
        this.server.removeListener("error", reject);
        resolve();
      });
    });
    this.log(`broker ${this.lanIp || "0.0.0.0"}:${this.port}`);
    this.openFirewall();
  }

  openFirewall() {
    execFile("netsh", [
      "advfirewall", "firewall", "add", "rule",
      "name=Klikac MQTT",
      "dir=in",
      "action=allow",
      "protocol=TCP",
      `localport=${this.port}`,
      "profile=any",
    ], { windowsHide: true }, (err, _stdout, stderr) => {
      const text = `${err ? err.message : ""} ${stderr || ""}`;
      if (/already exists|již existuje/i.test(text)) {
        return;
      }
      if (err) {
        this.log("firewall 1883 se nepodařilo přidat (nejsem správce). Povol port ručně, pokud destička neuvidí PC1.");
      } else {
        this.log("firewall 1883 povolen");
      }
    });
  }

  async stop() {
    if (this.broker) {
      await new Promise((resolve) => this.broker.close(resolve));
      this.broker = null;
    }
    if (this.server) {
      await new Promise((resolve) => this.server.close(resolve));
      this.server = null;
    }
  }
}

module.exports = { MqttBroker };
