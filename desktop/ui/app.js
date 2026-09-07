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
    <span class="n">${i + 1}</span>
    <div>
      <input class="name" data-slot="${i}" data-field="name" placeholder="volitelný název">
      <input class="seq" data-slot="${i}" data-field="seq" placeholder="např. F1,D,F2">
    </div>`;
  slotsRoot.appendChild(wrap);
}

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
  if (ae !== $("macro-active")) {
    $("macro-active").value = ui.macroActive || "";
  }
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
    const name = document.querySelector(`input[data-slot="${i}"][data-field="name"]`);
    const seq = document.querySelector(`input[data-slot="${i}"][data-field="seq"]`);
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
  $("esp-dot").className = `dot ${mqttOk && live ? "on" : mqttOk ? "warn" : ""}`;
  $("esp-status").textContent = !mqttOk
    ? "MQTT odpojeno"
    : live
      ? "Destička připojena"
      : "Destička offline";
  $("esp-ip").textContent = device.ip || "—";
  const bits = [
    mqttOk ? "MQTT OK" : "MQTT —",
    usbOk ? "USB připojeno" : `USB ${device.usb || "?"}`,
  ];
  if (device.ack) {
    bits.push(`ack ${device.ack}${device.ackAt ? " · " + ago(device.ackAt) : ""}`);
  }
  $("esp-meta").textContent = bits.join(" · ");

  const fw = snap.firmware || {};
  const deviceFw = device.fw || fw.current || "—";
  const latestFw = fw.latest || "";
  $("fw-meta").textContent = latestFw
    ? `firmware ${deviceFw}${deviceFw !== latestFw ? ` → ${latestFw}` : ""}`
    : `firmware ${deviceFw}`;
  $("fw-log").textContent = fw.error || fw.log || "";
  const flashing = fw.status === "preparing" || fw.status === "downloading" || fw.status === "uploading";
  $("flash-fw").disabled = flashing;
  $("flash-fw").textContent = flashing ? "Nahrávám…" : "Nahrát firmware";

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
}

function collectUiPatch() {
  const slots = [...document.querySelectorAll(".slot")].map((_, i) => ({
    name: document.querySelector(`input[data-slot="${i}"][data-field="name"]`).value,
    seq: document.querySelector(`input[data-slot="${i}"][data-field="seq"]`).value,
  }));
  return {
    controllerEnabled: true,
    macroActive: $("macro-active").value,
    macroLoop: $("macro-loop").checked,
    delayMin: Number($("delay-min").value),
    delayMax: Number($("delay-max").value),
    macroRunning: $("macro-run").getAttribute("aria-pressed") === "true",
    mouseBridge: $("mouse-bridge").checked,
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
$("macro-active").addEventListener("change", scheduleSave);
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
    apply(await window.ovladac.getState());
    const snap = await window.ovladac.flashFirmware();
    apply(await window.ovladac.getState());
    toast(snap.log || "Firmware odeslán");
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

window.ovladac.onState(apply);
window.ovladac.getState().then(apply).catch((err) => toast(err.message));
