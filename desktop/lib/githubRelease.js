const fs = require("fs");
const https = require("https");
const path = require("path");
const { owner, repo } = require("./releaseMeta");

function requestJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        "User-Agent": "Klikac",
        Accept: "application/vnd.github+json",
      },
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        requestJson(res.headers.location).then(resolve, reject);
        res.resume();
        return;
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`GitHub ${res.statusCode}: ${body.slice(0, 180)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.setTimeout(20000, () => {
      req.destroy();
      reject(new Error("GitHub neodpověděl"));
    });
    req.on("error", reject);
  });
}

function downloadFile(url, dest, onProgress) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.part`;
    const follow = (target) => {
      const req = https.get(target, {
        headers: { "User-Agent": "Klikac" },
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          follow(res.headers.location);
          return;
        }
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Stažení selhalo (${res.statusCode})`));
          res.resume();
          return;
        }
        const total = Number(res.headers["content-length"] || 0);
        let got = 0;
        const out = fs.createWriteStream(tmp);
        res.on("data", (chunk) => {
          got += chunk.length;
          if (total && typeof onProgress === "function") {
            onProgress(got / total);
          }
        });
        res.pipe(out);
        out.on("finish", () => {
          out.close(() => {
            fs.renameSync(tmp, dest);
            resolve(dest);
          });
        });
        out.on("error", reject);
      });
      req.setTimeout(30000, () => {
        req.destroy();
        reject(new Error("Stahování z GitHubu vypršelo"));
      });
      req.on("error", reject);
    };
    follow(url);
  });
}

function assetUrl(release, names) {
  const wanted = names.map((n) => n.toLowerCase());
  const asset = (release.assets || []).find((item) => wanted.includes(String(item.name || "").toLowerCase()));
  return asset ? asset.browser_download_url : "";
}

function parseTag(tag) {
  return String(tag || "").replace(/^v/i, "");
}

async function fetchLatestRelease() {
  const data = await requestJson(`https://api.github.com/repos/${owner}/${repo}/releases/latest`);
  if (data && data.message) {
    throw new Error(data.message);
  }
  return {
    tag: data.tag_name || "",
    version: parseTag(data.tag_name),
    name: data.name || data.tag_name || "",
    notes: data.body || "",
    htmlUrl: data.html_url || `https://github.com/${owner}/${repo}/releases`,
    installerUrl: assetUrl(data, [
      `Klikac-Setup-${parseTag(data.tag_name)}.exe`,
      `Klikač-Setup-${parseTag(data.tag_name)}.exe`,
    ]) || (data.assets || []).find((a) => /\.exe$/i.test(a.name) && /setup|klikac/i.test(a.name))?.browser_download_url || "",
    latestYmlUrl: assetUrl(data, ["latest.yml"]),
    firmwareBinUrl: assetUrl(data, ["firmware.bin"]),
    firmwareElfUrl: assetUrl(data, ["firmware.elf"]),
    factoryUrl: assetUrl(data, ["firmware-factory.bin"]),
    espflashUrl: assetUrl(data, ["espflash.exe"]),
    manifestUrl: assetUrl(data, ["manifest.json"]),
    raw: data,
  };
}

function cmpVersion(a, b) {
  const pa = String(a || "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da > db) {
      return 1;
    }
    if (da < db) {
      return -1;
    }
  }
  return 0;
}

module.exports = {
  fetchLatestRelease,
  downloadFile,
  cmpVersion,
  parseTag,
};
