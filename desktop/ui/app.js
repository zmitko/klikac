const $ = (id) => document.getElementById(id);

function addPadButtons(root, tokens, extraClass) {
  tokens.forEach((tok) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = extraClass ? `pad-btn compact ${extraClass}` : "pad-btn compact";
    btn.dataset.cmd = tok;
    btn.textContent = tok;
    root.appendChild(btn);
  });
}

addPadButtons($("fkeys"), Array.from({ length: 12 }, (_, i) => `F${i + 1}`));
addPadButtons($("numkeys"), ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"]);
addPadButtons($("czkeys"), ["+", "ě", "š", "č", "ř", "ž", "ý", "á", "í", "é"]);

const MACRO_TYPE = window.KlikacMacro.ast.MACRO_TYPE;

// Typ a program komplexního makra drží renderer ve vlastní kopii — stav z main
// procesu je zdroj pravdy, tady se jen nepřepisuje to, co uživatel zrovna edituje.
const slotDraft = Array.from({ length: 5 }, () => ({ type: MACRO_TYPE.SIMPLE, program: "" }));

const slotsRoot = $("slots");
for (let i = 0; i < 5; i++) {
  const wrap = document.createElement("div");
  wrap.className = "slot";
  wrap.innerHTML = `
    <label class="slot-on" title="Aktivní v makru">
      <input type="checkbox" data-slot="${i}" data-field="enabled">
    </label>
    <span class="n">${i + 1}</span>
    <div class="slot-fields">
      <div class="slot-top">
        <input class="name" data-slot="${i}" data-field="name" placeholder="volitelný název">
        <div class="seg tiny" role="group" aria-label="Typ makra ${i + 1}">
          <button type="button" data-type-slot="${i}" data-type="SIMPLE">SIMPLE</button>
          <button type="button" data-type-slot="${i}" data-type="COMPLEX">COMPLEX</button>
        </div>
      </div>
      <div class="seq-row" data-simple="${i}">
        <textarea class="seq" data-slot="${i}" data-field="seq" rows="1" maxlength="768" placeholder="např. F1,D,2,ě"></textarea>
        <button type="button" class="seq-expand" data-expand="${i}" title="Zvětšit sekvenci">⤢</button>
      </div>
      <div class="complex-row" data-complex="${i}" hidden>
        <button type="button" class="complex-open" data-edit="${i}">Otevřít editor V2</button>
        <span class="complex-state" data-state="${i}"></span>
      </div>
    </div>`;
  slotsRoot.appendChild(wrap);
}

function openEditor(index) {
  const name = document.querySelector(`input[data-slot="${index}"][data-field="name"]`).value;
  const seq = document.querySelector(`[data-slot="${index}"][data-field="seq"]`).value;
  window.MacroEditor.open(
    { index, name, seq, type: slotDraft[index].type, program: slotDraft[index].program },
    {
      onSave: (patch) => {
        slotDraft[patch.index].type = patch.type;
        slotDraft[patch.index].program = patch.program;
        document.querySelector(`input[data-slot="${patch.index}"][data-field="name"]`).value = patch.name;
        document.querySelector(`[data-slot="${patch.index}"][data-field="seq"]`).value = patch.seq;
        renderSlotType(patch.index);
        scheduleSave();
      },
      onToast: toast,
    },
  );
}

function renderSlotType(index) {
  const complex = slotDraft[index].type === MACRO_TYPE.COMPLEX;
  const row = document.querySelector(`input[data-slot="${index}"][data-field="enabled"]`).closest(".slot");
  row.classList.toggle("is-complex", complex);
  row.querySelector(`[data-simple="${index}"]`).hidden = complex;
  row.querySelector(`[data-complex="${index}"]`).hidden = !complex;
  row.querySelectorAll(`[data-type-slot="${index}"]`).forEach((btn) => {
    btn.classList.toggle("is-on", (btn.dataset.type === MACRO_TYPE.COMPLEX) === complex);
  });
  const stateEl = row.querySelector(`[data-state="${index}"]`);
  if (!complex) {
    stateEl.textContent = "";
    stateEl.className = "complex-state";
    return;
  }
  const info = window.MacroEditor.summary({ type: MACRO_TYPE.COMPLEX, program: slotDraft[index].program });
  stateEl.textContent = info.label;
  stateEl.className = `complex-state ${info.ok ? "is-ok" : "is-bad"}`;
  stateEl.title = info.detail || "";
}

slotsRoot.addEventListener("click", (ev) => {
  const edit = ev.target.closest("[data-edit]");
  if (edit) {
    openEditor(Number(edit.dataset.edit));
    return;
  }
  const typeBtn = ev.target.closest("[data-type-slot]");
  if (typeBtn) {
    const index = Number(typeBtn.dataset.typeSlot);
    if (slotDraft[index].type !== typeBtn.dataset.type) {
      slotDraft[index].type = typeBtn.dataset.type;
      renderSlotType(index);
      scheduleSave();
    }
    return;
  }
  const btn = ev.target.closest("[data-expand]");
  if (!btn) {
    return;
  }
  const slot = btn.closest(".slot");
  const open = slot.classList.toggle("is-wide");
  const seq = slot.querySelector(".seq");
  btn.setAttribute("aria-pressed", open ? "true" : "false");
  btn.title = open ? "Zmenšit sekvenci" : "Zvětšit sekvenci";
  if (seq) {
    seq.rows = open ? 6 : 1;
  }
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
  if (!toggleLock.macro || Date.now() > toggleLock.macro) {
    $("macro-run").classList.toggle("is-on", !!ui.macroRunning);
    $("macro-run").setAttribute("aria-pressed", ui.macroRunning ? "true" : "false");
    $("macro-run").querySelector(".run-label").textContent = ui.macroRunning ? "Zastavit makro" : "Spustit makro";
  }
  if (!toggleLock.mouse || Date.now() > toggleLock.mouse) {
    $("mouse-bridge").checked = !!ui.mouseBridge;
  }
  if (document.activeElement !== $("mouse-lmb")) {
    $("mouse-lmb").checked = ui.mouseLmb !== false;
  }
  if (document.activeElement !== $("mouse-rmb")) {
    $("mouse-rmb").checked = ui.mouseRmb !== false;
  }
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
  const lmbOn = ui.mouseLmb !== false;
  const rmbOn = ui.mouseRmb !== false;
  const btnHint = !lmbOn && !rmbOn ? "žádné tlačítko" : lmbOn && rmbOn ? "" : (lmbOn ? "jen LMB" : "jen RMB");
  if (!ui.mouseBridge) {
    $("mouse-meta").textContent = btnHint ? `vypnuto · ${btnHint}` : "vypnuto";
  } else if (!mouse.running) {
    $("mouse-meta").textContent = mouse.lastError || "hook nespí";
  } else if (mouse.lastClickAt) {
    $("mouse-meta").textContent = `poslední ${mouse.lastClick} · ${ago(mouse.lastClickAt)}${btnHint ? ` · ${btnHint}` : ""}`;
  } else {
    $("mouse-meta").textContent = btnHint ? `čekám · ${btnHint}` : "čekám na klik mimo Klikač";
  }

  (ui.slots || []).forEach((slot, i) => {
    const enabled = document.querySelector(`input[data-slot="${i}"][data-field="enabled"]`);
    const name = document.querySelector(`input[data-slot="${i}"][data-field="name"]`);
    const seq = document.querySelector(`[data-slot="${i}"][data-field="seq"]`);
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
    const editing = window.MacroEditor.isOpen() && window.MacroEditor.slotIndex() === i;
    if (!editing) {
      slotDraft[i].type = slot.type === MACRO_TYPE.COMPLEX ? MACRO_TYPE.COMPLEX : MACRO_TYPE.SIMPLE;
      slotDraft[i].program = slot.program || "";
    }
    renderSlotType(i);
  });

  const macro = snap.macro || {};
  const langBadge = $("lang-badge");
  if (langBadge) {
    const running = (macro.slots || []).filter((job) => job.state === "running");
    langBadge.textContent = running.length
      ? `jazyk V2 · běží ${running.map((job) => job.index + 1).join(", ")}`
      : `jazyk V${macro.lang || "2"}`;
  }

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
    ? `broker ${net.lanIp}:${net.port || 1883} · ${net.clients || 0} klient · destička ${net.devices ? "ano" : "ne"}`
    : "broker —";

  const fw = snap.firmware || {};
  const deviceFw = device.fw || fw.current || "";
  const appVer = (snap.update && snap.update.current) || fw.latest || "";
  const fwInline = $("fw-inline");
  const fwBehind = !!(deviceFw && appVer && cmpVer(appVer, deviceFw) > 0);
  fwInline.textContent = deviceFw ? `(firmware ${deviceFw})` : "(firmware —)";
  fwInline.classList.toggle("is-behind", fwBehind);
  $("fw-log").textContent = fw.error || fw.log || "";
  const flashing = fw.status === "preparing" || fw.status === "downloading" || fw.status === "uploading";
  $("flash-fw").disabled = flashing;
  $("flash-fw").textContent = flashing && fw.method === "usb" ? "Inicializuji…" : "Inicializovat přes USB";
  $("flash-fw-force").disabled = flashing;
  $("flash-fw-force").textContent = flashing && fw.method === "usb" ? "Zapisuji…" : "Vynutit zápis";
  $("board-diag").disabled = flashing;
  $("board-diag").textContent = flashing && fw.method === "com" ? "Čtu destičku…" : "Číst destičku (COM)";
  $("ota-fw").disabled = flashing || !device.ip;
  $("ota-fw").textContent = flashing && fw.method === "wifi" ? "Nahrávám přes Wi-Fi…" : "Aktualizovat firmware (Wi-Fi)";
  const quickOta = $("fw-quick-ota");
  quickOta.hidden = !fwBehind;
  quickOta.disabled = flashing || !device.ip;
  quickOta.textContent = flashing && fw.method === "wifi" ? "Nahrávám…" : "Nahrát firmware (Wi-Fi)";

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
    seq: document.querySelector(`[data-slot="${i}"][data-field="seq"]`).value,
    enabled: document.querySelector(`input[data-slot="${i}"][data-field="enabled"]`).checked,
    type: slotDraft[i].type,
    program: slotDraft[i].program,
  }));
  return {
    controllerEnabled: true,
    macroLoop: $("macro-loop").checked,
    delayMin: Number($("delay-min").value),
    delayMax: Number($("delay-max").value),
    mouseLmb: $("mouse-lmb").checked,
    mouseRmb: $("mouse-rmb").checked,
    wifiSsid: $("wifi-ssid").value,
    wifiPassword: $("wifi-pass").value,
    mqttHost: $("mqtt-host").value.trim(),
    slots,
  };
}

const toggleLock = { macro: 0, mouse: 0 };

function cmpVer(a, b) {
  const pa = String(a || "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => Number.parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) {
      return da > db ? 1 : -1;
    }
  }
  return 0;
}

async function commitPatch(patch) {
  apply(await window.ovladac.setState(patch));
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
$("macro-run").addEventListener("click", async () => {
  if (Date.now() < toggleLock.macro) {
    return;
  }
  const running = $("macro-run").getAttribute("aria-pressed") === "true";
  const next = !running;
  toggleLock.macro = Date.now() + 700;
  $("macro-run").setAttribute("aria-pressed", next ? "true" : "false");
  $("macro-run").classList.toggle("is-on", next);
  $("macro-run").querySelector(".run-label").textContent = next ? "Zastavit makro" : "Spustit makro";
  try {
    await commitPatch({ macroRunning: next });
  } catch (err) {
    toggleLock.macro = 0;
    toast(err.message);
    apply(await window.ovladac.getState());
  }
});
$("mouse-bridge").addEventListener("change", async () => {
  if (Date.now() < toggleLock.mouse) {
    $("mouse-bridge").checked = !$("mouse-bridge").checked;
    return;
  }
  toggleLock.mouse = Date.now() + 700;
  try {
    await commitPatch({ mouseBridge: $("mouse-bridge").checked });
  } catch (err) {
    toggleLock.mouse = 0;
    toast(err.message);
    apply(await window.ovladac.getState());
  }
});
$("mouse-lmb").addEventListener("change", scheduleSave);
$("mouse-rmb").addEventListener("change", scheduleSave);
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
slotsRoot.addEventListener("input", (ev) => {
  if (ev.target.matches("[data-field=\"seq\"], [data-field=\"name\"]")) {
    scheduleSave();
  }
});

function setGearOpen(open) {
  $("gear-menu").hidden = !open;
  $("gear-btn").setAttribute("aria-expanded", open ? "true" : "false");
}

function setKbOpen(open) {
  $("kb-panel").hidden = !open;
  $("kb-btn").setAttribute("aria-expanded", open ? "true" : "false");
}

function setHelpOpen(open) {
  $("help-modal").hidden = !open;
  $("help-btn").setAttribute("aria-expanded", open ? "true" : "false");
}

$("gear-btn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  const next = $("gear-menu").hidden;
  setGearOpen(next);
  if (next) {
    setKbOpen(false);
  }
});
$("kb-btn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  const next = $("kb-panel").hidden;
  setKbOpen(next);
  if (next) {
    setGearOpen(false);
  }
});
$("gear-menu").addEventListener("click", (ev) => ev.stopPropagation());
$("help-btn").addEventListener("click", (ev) => {
  ev.stopPropagation();
  const next = $("help-modal").hidden;
  setHelpOpen(next);
  if (next) {
    setGearOpen(false);
    setKbOpen(false);
  }
});
$("help-close").addEventListener("click", () => setHelpOpen(false));
$("help-backdrop").addEventListener("click", () => setHelpOpen(false));
document.addEventListener("click", (ev) => {
  if (!ev.target.closest(".gear-wrap")) {
    setGearOpen(false);
  }
  if (!ev.target.closest(".kb-dock")) {
    setKbOpen(false);
  }
});
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") {
    if (!$("help-modal").hidden) {
      setHelpOpen(false);
      return;
    }
    setGearOpen(false);
    setKbOpen(false);
  }
});

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

async function runUsbInit(force) {
  $("flash-fw").disabled = true;
  $("flash-fw-force").disabled = true;
  try {
    apply(await window.ovladac.setState(collectUiPatch()));
    const ssid = $("wifi-ssid").value.trim();
    const mqttHost = $("mqtt-host").value.trim();
    if (!ssid || !mqttHost) {
      setGearOpen(true);
      $("wifi-fold").classList.add("open");
      $("wifi-fold-btn").setAttribute("aria-expanded", "true");
      $("flash-fw").disabled = false;
      $("flash-fw-force").disabled = false;
      toast(!ssid ? "Nejdřív vyplň Wi-Fi pod tlačítkem." : "Vyplň IP (PC1 kde běží Klikač).");
      return;
    }
    if (!/^(?:\d{1,3}\.){3}\d{1,3}$/.test(mqttHost)) {
      setGearOpen(true);
      $("wifi-fold").classList.add("open");
      $("wifi-fold-btn").setAttribute("aria-expanded", "true");
      $("flash-fw").disabled = false;
      $("flash-fw-force").disabled = false;
      toast("IP (PC1 kde běží Klikač) musí být IPv4, třeba 192.168.0.101.");
      return;
    }
    const snap = await window.ovladac.flashFirmware({ force: !!force });
    apply(await window.ovladac.getState());
    toast(snap.log || (force ? "Vynucený zápis hotový" : "Destička nastavená"));
  } catch (err) {
    toast(err.message);
    apply(await window.ovladac.getState());
  }
}

$("flash-fw").addEventListener("click", () => runUsbInit(false));
$("flash-fw-force").addEventListener("click", () => runUsbInit(true));

$("board-diag").addEventListener("click", async () => {
  $("board-diag").disabled = true;
  setGearOpen(true);
  try {
    const snap = await window.ovladac.diagnoseBoard();
    apply(await window.ovladac.getState());
    toast((snap.diagnosis && snap.diagnosis.hint) || snap.log || "Čtení destičky hotové");
  } catch (err) {
    toast(err.message);
    apply(await window.ovladac.getState());
  }
});

async function runOta() {
  $("ota-fw").disabled = true;
  $("fw-quick-ota").disabled = true;
  try {
    const snap = await window.ovladac.otaFirmware();
    apply(await window.ovladac.getState());
    toast(snap.log || "Firmware odeslán přes Wi-Fi");
  } catch (err) {
    toast(err.message);
    apply(await window.ovladac.getState());
  }
}

$("ota-fw").addEventListener("click", runOta);
$("fw-quick-ota").addEventListener("click", runOta);

$("app-update").addEventListener("click", async () => {
  try {
    await window.ovladac.installUpdate();
  } catch (err) {
    toast(err.message);
  }
});

$("ver-check").addEventListener("click", async () => {
  if ($("ver-check").disabled) {
    return;
  }
  $("ver-check").disabled = true;
  $("upd-meta").textContent = "kontrola verze…";
  try {
    const upd = await window.ovladac.checkUpdate();
    apply(await window.ovladac.getState());
    if (upd && upd.available) {
      toast(`Nová verze ${upd.latest}`);
    } else if (upd && upd.error) {
      toast(upd.error);
    } else {
      toast("Klikač je aktuální");
    }
  } catch (err) {
    toast(err.message);
    apply(await window.ovladac.getState());
  } finally {
    $("ver-check").disabled = false;
  }
});

$("copy-log").addEventListener("click", async () => {
  const text = $("proto-log").textContent || "";
  try {
    if (window.ovladac && window.ovladac.copyText) {
      await window.ovladac.copyText(text);
    } else if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      throw new Error("Schránka není dostupná");
    }
    toast("Log je v paměti");
  } catch (err) {
    toast(err.message || "Kopírování selhalo");
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
    } else if (device.health === "missing" || !(net.devices)) {
      toast("Destička není na brokeru. Zapoj COM na PC1 a Číst destičku.");
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
