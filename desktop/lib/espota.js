const crypto = require("crypto");
const dgram = require("dgram");
const fs = require("fs");
const net = require("net");
const path = require("path");

const { OTA_ESPOTA_PORT } = require("./klikacPorts");

const FLASH = 0;
const AUTH = 200;

function md5(buf) {
  return crypto.createHash("md5").update(buf).digest("hex");
}

function inviteOnce(espIp, espPort, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = dgram.createSocket("udp4");
    const timer = setTimeout(() => {
      sock.close();
      reject(new Error("timeout"));
    }, timeoutMs);
    sock.on("error", (err) => {
      clearTimeout(timer);
      sock.close();
      reject(err);
    });
    sock.on("message", (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve(msg.toString("utf8"));
    });
    sock.send(Buffer.from(message, "utf8"), espPort, espIp, (err) => {
      if (err) {
        clearTimeout(timer);
        sock.close();
        reject(err);
      }
    });
  });
}

async function invite(espIp, espPort, message, tries, timeoutMs) {
  let lastErr = new Error("No response from the ESP");
  for (let i = 0; i < tries; i += 1) {
    try {
      return await inviteOnce(espIp, espPort, message, timeoutMs);
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

function pushFirmware({ host, password, filePath, onProgress, listenPort }) {
  const filename = path.resolve(filePath);
  const bin = fs.readFileSync(filename);
  const fileMd5 = md5(bin);
  const localPort = listenPort || OTA_ESPOTA_PORT;
  const inviteMsg = `${FLASH} ${localPort} ${bin.length} ${fileMd5}\n`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let connectTimer;
    const server = net.createServer();
    const finish = (err) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(connectTimer);
      try {
        server.close();
      } catch {
        /* already closed */
      }
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    server.on("error", (err) => finish(err));
    server.listen(localPort, "0.0.0.0", async () => {
      try {
        let data = await invite(host, 3232, inviteMsg, 8, 1000);
        if (data.startsWith("AUTH")) {
          const nonce = data.trim().split(/\s+/)[1];
          const cnonceText = `${filename}${bin.length}${fileMd5}${host}`;
          const cnonce = md5(cnonceText);
          const passmd5 = md5(String(password || ""));
          const result = md5(`${passmd5}:${nonce}:${cnonce}`);
          const authMsg = `${AUTH} ${cnonce} ${result}\n`;
          data = await invite(host, 3232, authMsg, 1, 8000);
        }
        if (!data.includes("OK")) {
          throw new Error(`OTA invitation rejected: ${data.trim()}`);
        }
        connectTimer = setTimeout(() => {
          finish(new Error(`Destička OTA přijala, ale nepřipojila se na TCP ${localPort} (firewall).`));
        }, 12000);
      } catch (err) {
        finish(err);
      }
    });
    server.on("connection", (socket) => {
      clearTimeout(connectTimer);
      socket.setTimeout(120000);
      let offset = 0;
      const sendNext = () => {
        if (offset >= bin.length) {
          return;
        }
        const end = Math.min(offset + 1024, bin.length);
        socket.write(bin.subarray(offset, end));
        offset = end;
        if (typeof onProgress === "function") {
          onProgress(offset / bin.length);
        }
      };
      socket.on("data", (chunk) => {
        const text = chunk.toString("utf8");
        if (text.includes("OK") && offset >= bin.length) {
          socket.end();
          finish();
          return;
        }
        sendNext();
      });
      socket.on("timeout", () => {
        socket.destroy();
        finish(new Error("OTA přenos vypršel"));
      });
      socket.on("error", (err) => finish(err));
      sendNext();
    });
  });
}

module.exports = { pushFirmware };
