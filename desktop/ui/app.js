const $ = (id) => document.getElementById(id);

const fkeys = $("fkeys");
for (let i = 1; i <= 8; i++) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "pad-btn";
  btn.dataset.cmd = `F${i}`;
  btn.innerHTML = `<span class="ico key"></span><span>F${i}</span>`;
  fkeys.appendChild(btn);
}

const slotsRoot = $("slots");
for (let i = 0; i < 5; i++) {
  const wrap = document.createElement("div");
  wrap.className = "slot";
  wrap.innerHTML = `
    <label class="slot-on" title="Aktivní v makru">
      <input type="checkbox" data-slot="${i}" data-field="enabled">
    </label>
    <span class="n">${i + 1}</span>
    <div>
      <input class="name" data-slot="${i}" data-field="name" placeholder="volitelný název">
      <input class="seq" data-slot="${i}" data-field="seq" placeholder="např. F1,D,2,ě">
    </div>`;
  slotsRoot.appendChild(wrap);
}

const tokenInsert = $("token-insert");
let lastSeqInput = null;
[
  ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"],
  ["+", "ě", "š", "č", "ř", "ž", "ý", "á", "í", "é"],
].forEach((row) => {
  const wrap = document.createElement("div");
  wrap.className = "token-insert-row";
  row.forEach((tok) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "token-chip";
    btn.dataset.insert = tok;
    btn.textContent = tok;
    wrap.appendChild(btn);
  });
  tokenInsert.appendChild(wrap);
});
slotsRoot.addEventListener("focusin", (ev) => {
  if (ev.target.matches("input[data-field=\"seq\"]")) {
    lastSeqInput = ev.target;
  }
});
tokenInsert.addEventListener("click", (ev) => {
  const btn = ev.target.closest("[data-insert]");
  if (!btn) {
    return;
  }
  const el = lastSeqInput || slotsRoot.querySelector("input[data-field=\"seq\"]");
  if (!el) {
    return;
  }
  const tok = btn.dataset.insert;
  const cur = el.value.trim();
  el.value = cur ? `${cur},${tok}` : tok;
  el.focus();
  lastSeqInput = el;
  scheduleSave();
});

let saveTimer = 0;

function toast(msg) {
  const el = $("toast");
  el.hidden = false;
  el.textContent = msg;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    el.hidden = true;
  }, 2800);
}

function ago(ts) {
  if (!ts) {
    return "";
  }
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) {
    return "právě teď";
  }
  if (sec < 3600) {
    return `před ${Math.floor(sec / 60)} min`;
  }
  const h = Math.floor(sec / 3600);
  return `před ${h} h`;
}

function apply(snap) {
  if (!snap || !snap.ui) {
    return;
  }
  const ui = snap.ui;
  const device = snap.device || {};

  const ae = document.activeElement;
  $("macro-loop").checked = !!ui.macroLoop;
  if (ae !== $("delay-min")) {
    $("delay-min").value = ui.delayMin;
  }
  if (ae !== $("delay-max")) {
    $("delay-max").value = ui.delayMax;
  }
  $("dmin-val").textContent = $("delay-min").value;
  $("dmax-val").textContent = $("delay-max").value;
  $("macro-run").classList.toggle("is-on", !!ui.macroRunning);
  $("macro-run").setAttribute("aria-pressed", ui.macroRunning ? "true" : "false");
  $("macro-run").querySelector(".run-label").textContent = ui.macroRunning ? "Zastavit makro" : "Spustit makro";
  $("mouse-bridge").checked = !!ui.mouseBridge;
  if (document.activeElement !== $("wifi-ssid")) {
    $("wifi-ssid").value = ui.wifiSsid || "";
  }
  if (document.activeElement !== $("wifi-pass")) {
    $("wifi-pass").value = ui.wifiPassword || "";
  }
  const lanIp = (snap.net && snap.net.lanIp) || "";
  if (document.activeElement !== $("mqtt-host")) {
    $("mqtt-host").value = ui.mqttHost || lanIp || "";
  }
  const hostLabel = ($("mqtt-host").value || "").trim();
  const warn = $("mqtt-host-warn");
  if (warn) {
    const mismatch = hostLabel && lanIp && hostLabel !== lanIp;
    warn.hidden = !mismatch;
    warn.textContent = mismatch
      ? `Toto PC má teď ${lanIp}. V jiné síti doplň tu IP a znovu inicializuj přes USB.`
      : "";
  }
  $("wifi-fold-label").textContent = ui.wifiSsid
    ? (hostLabel ? `Síť pro USB init · ${ui.wifiSsid} · ${hostLabel}` : `Síť pro USB init · ${ui.wifiSsid}`)
    : "Síť pro USB init";
  const mouse = snap.mouse || {};
  if (!ui.mouseBridge) {
    $("mouse-meta").textContent = "vypnuto";
  } else if (!mouse.running) {
    $("mouse-meta").textContent = mouse.lastError || "hook nespí";
  } else if (mouse.lastClickAt) {
    $("mouse-meta").textContent = `poslední ${mouse.lastClick} · ${ago(mouse.lastClickAt)}`;
  } else {
    $("mouse-meta").textContent = "čekám na klik mimo Klikač";
  }

  (ui.slots || []).forEach((slot, i) => {
    const enabled = document.querySelector(`input[data-slot="${i}"][data-field="enabled"]`);
    const name = document.querySelector(`input[data-slot="${i}"][data-field="name"]`);
    const seq = document.querySelector(`input[data-slot="${i}"][data-field="seq"]`);
    const row = enabled && enabled.closest(".slot");
    if (enabled && document.activeElement !== enabled) {
      enabled.checked = !!slot.enabled;
    }
    if (row) {
      row.classList.toggle("is-on", !!slot.enabled);
    }
    if (name && document.activeElement !== name) {
      name.value = slot.name || "";
    }
    if (seq && document.activeElement !== seq) {
      seq.value = slot.seq || "";
    }
  });

  const mqttOk = device.mqtt === "connected";
  const live = !!device.live;
  const usbOk = device.usb === "connected";
  const checking = device.health === "checking";
  $("esp-dot").className = `dot ${checking ? "warn" : mqttOk && live ? "on" : mqttOk ? "warn" : ""}`;
  $("esp-status").textContent = checking
    ? "Kontroluji…"
    : !mqttOk
      ? "Klikač se nepřipojuje k brokeru"
      : live
        ? "Destička připojena"
        : "Destička není na MQTT";
  const healthBtn = $("health-check");
  if (healthBtn) {
    healthBtn.disabled = checking;
    healthBtn.textContent = checking ? "…" : "Obnovit";
  }
  $("esp-ip").textContent = device.ip || "—";
  const bits = [
    mqttOk ? "MQTT OK" : "MQTT —",
    usbOk ? "USB připojeno" : `USB ${device.usb || "?"}`,
  ];
  if (device.ack) {
    bits.push(`ack ${device.ack}${device.ackAt ? " · " + ago(device.ackAt) : ""}`);
  }
  $("esp-meta").textContent = bits.join(" · ");
  const net = snap.net || {};
  $("broker-meta").textContent = net.lanIp
    ? `broker ${net.lanIp}:${net.port || 1883}${net.clients ? ` · ${net.clients} klient` : ""}${net.devices ? " · destička ano" : ""}`
    : "broker —";

  const fw = snap.firmware || {};
  const deviceFw = device.fw || fw.current || "—";
  const latestFw = fw.latest || "";
  $("fw-meta").textContent = latestFw
    ? `firmware ${deviceFw}${deviceFw !== latestFw ? ` → ${latestFw}` : ""}`
    : `firmware ${deviceFw}`;
  $("fw-log").textContent = fw.error || fw.log || "";
  const flashing = fw.status === "preparing" || fw.status === "downloading" || fw.status === "uploading";
  $("flash-fw").disabled = flashing;
  $("flash-fw").textContent = flashing && fw.method === "usb" ? "Inicializuji…" : "Inicializovat přes USB";
  $("ota-fw").disabled = flashing || !device.ip;
  $("ota-fw").textContent = flashing && fw.method === "wifi" ? "Nahrávám přes Wi-Fi…" : "Aktualizovat firmware (Wi-Fi)";

  const upd = snap.update || {};
  $("app-ver").textContent = upd.current ? `v${upd.current}` : "";
  const updBtn = $("app-update");
  if (upd.available) {
    $("upd-meta").textContent = `nová verze ${upd.latest}`;
    updBtn.hidden = false;
    updBtn.disabled = upd.status === "downloading" || upd.status === "installing";
    updBtn.textContent = upd.status === "downloading" ? "Stahuji…" : "Aktualizovat";
  } else if (upd.status === "checking") {
    $("upd-meta").textContent = "kontrola verze…";
    updBtn.hidden = true;
  } else if (upd.error) {
    $("upd-meta").textContent = upd.error;
    updBtn.hidden = true;
  } else {
    $("upd-meta").textContent = "aktuální";
    updBtn.hidden = true;
  }

  const logEl = $("proto-log");
  if (logEl) {
    const lines = snap.log || [];
    const text = lines.length ? lines.join("\n") : "čekám…";
    if (logEl.textContent !== text) {
      logEl.textContent = text;
      logEl.scrollTop = logEl.scrollHeight;
    }
  }
}

function collectUiPatch() {
  const slots = [...document.querySelectorAll(".slot")].map((_, i) => ({
    name: document.querySelector(`input[data-slot="${i}"][data-field="name"]`).value,
    seq: document.querySelector(`input[data-slot="${i}"][data-field="seq"]`).value,
    enabled: document.querySelector(`input[data-slot="${i}"][data-field="enabled"]`).checked,
  }));
  return {
    controllerEnabled: true,
    macroLoop: $("macro-loop").checked,
    delayMin: Number($("delay-min").value),
    delayMax: Number($("delay-max").value),
    macroRunning: $("macro-run").getAttribute("aria-pressed") === "true",
    mouseBridge: $("mouse-bridge").checked,
    wifiSsid: $("wifi-ssid").value,
    wifiPassword: $("wifi-pass").value,
    mqttHost: $("mqtt-host").value.trim(),
    slots,
  };
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      apply(await window.ovladac.setState(collectUiPatch()));
    } catch (err) {
      toast(err.message);
    }
  }, 250);
}

$("macro-loop").addEventListener("change", scheduleSave);
$("macro-run").addEventListener("click", () => {
  const running = $("macro-run").getAttribute("aria-pressed") === "true";
  $("macro-run").setAttribute("aria-pressed", running ? "false" : "true");
  $("macro-run").classList.toggle("is-on", !running);
  $("macro-run").querySelector(".run-label").textContent = running ? "Spustit makro" : "Zastavit makro";
  scheduleSave();
});
$("mouse-bridge").addEventListener("change", scheduleSave);
$("wifi-fold-btn").addEventListener("click", () => {
  const open = $("wifi-fold").classList.toggle("open");
  $("wifi-fold-btn").setAttribute("aria-expanded", open ? "true" : "false");
});
$("wifi-ssid").addEventListener("input", scheduleSave);
$("wifi-pass").addEventListener("input", scheduleSave);
$("mqtt-host").addEventListener("input", scheduleSave);
$("wifi-ssid").addEventListener("change", scheduleSave);
$("wifi-pass").addEventListener("change", scheduleSave);
$("mqtt-host").addEventListener("change", scheduleSave);
$("mqtt-host-fill").addEventListener("click", async () => {
  try {
    const snap = await window.ovladac.getState();
    const ip = (snap.net && snap.net.lanIp) || "";
    if (!ip) {
      toast("Toto PC nemá LAN IP. Připoj ho na Wi-Fi nebo kabel.");
      return;
    }
    $("mqtt-host").value = ip;
    scheduleSave();
  } catch (err) {
    toast(err.message);
  }
});
$("delay-min").addEventListener("input", () => {
  $("dmin-val").textContent = $("delay-min").value;
});
$("delay-max").addEventListener("input", () => {
  $("dmax-val").textContent = $("delay-max").value;
});
$("delay-min").addEventListener("change", scheduleSave);
$("delay-max").addEventListener("change", scheduleSave);
slotsRoot.addEventListener("change", scheduleSave);

document.body.addEventListener("click", async (ev) => {
  const btn = ev.target.closest("[data-cmd]");
  if (!btn) {
    return;
  }
  try {
    apply(await window.ovladac.command(btn.dataset.cmd));
  } catch (err) {
    toast(err.message);
  }
});

$("flash-fw").addEventListener("click", async () => {
  $("flash-fw").disabled = true;
  try {
    apply(await window.ovladac.setState(collectUiPatch()));
    const ssid = $("wifi-ssid").value.trim();
    const mqttHost = $("mqtt-host").value.trim();
    if (!ssid || !mqttHost) {
      $("wifi-fold").classList.add("open");
      $("wifi-fold-btn").setAttribute("aria-expanded", "true");
      $("flash-fw").disabled = false;
      toast(!ssid ? "Nejdřív vyplň Wi-Fi pod tlačítkem." : "Vyplň IP Klikače (tohoto PC).");
      return;
    }
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(mqttHost)) {
      $("wifi-fold").classList.add("open");
      $("wifi-fold-btn").setAttribute("aria-expanded", "true");
      $("flash-fw").disabled = false;
      toast("IP Klikače musí být IPv4, třeba 192.168.0.101.");
      return;
    }
    const snap = await window.ovladac.flashFirmware();
    apply(await window.ovladac.getState());
    toast(snap.log || "Destička nastavená");
  } catch (err) {
    toast(err.message);
    apply(await window.ovladac.getState());
  }
});

$("ota-fw").addEventListener("click", async () => {
  $("ota-fw").disabled = true;
  try {
    const snap = await window.ovladac.otaFirmware();
    apply(await window.ovladac.getState());
    toast(snap.log || "Firmware odeslán přes Wi-Fi");
  } catch (err) {
    toast(err.message);
    apply(await window.ovladac.getState());
  }
});

$("app-update").addEventListener("click", async () => {
  try {
    await window.ovladac.installUpdate();
  } catch (err) {
    toast(err.message);
  }
});

$("clear-log").addEventListener("click", async () => {
  try {
    apply(await window.ovladac.clearLog());
  } catch (err) {
    toast(err.message);
  }
});

$("health-check").addEventListener("click", async () => {
  $("health-check").disabled = true;
  $("esp-status").textContent = "Kontroluji…";
  try {
    const snap = await window.ovladac.healthCheck();
    apply(snap);
    const device = snap.device || {};
    const net = snap.net || {};
    if (device.health === "ok") {
      toast("Destička živá");
    } else if ((net.clients || 0) >= 2) {
      toast("Na brokeru je klient, ping bez odpovědi");
    } else {
      toast("Destička neodpověděla");
    }
  } catch (err) {
    toast(err.message);
    apply(await window.ovladac.getState());
  }
});

window.ovladac.onState(apply);
window.ovladac.getState().then(apply).catch((err) => toast(err.message));
