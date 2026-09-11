const KIND = "klikac-macro";
const FORMAT = 1;
const NAME_MAX = 40;
const SEQ_MAX = 768;
const PROGRAM_MAX = 8000;
const FILE_MAX = 200000;

function normalizeType(value) {
  return String(value || "").toUpperCase() === "COMPLEX" ? "COMPLEX" : "SIMPLE";
}

function clip(value, max) {
  return String(value == null ? "" : value).slice(0, max);
}

function fileNameFor(name) {
  const base = String(name || "makro")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "makro";
  return `${base}.klikac.json`;
}

function buildMacroPack(slot) {
  const type = normalizeType(slot && slot.type);
  return {
    kind: KIND,
    format: FORMAT,
    app: "Klikač",
    exportedAt: new Date().toISOString(),
    macro: {
      name: clip(slot && slot.name, NAME_MAX),
      type,
      seq: clip(slot && slot.seq, SEQ_MAX),
      program: clip(slot && slot.program, PROGRAM_MAX),
    },
  };
}

function readMacroFields(src) {
  if (!src || typeof src !== "object") {
    throw new Error("V souboru chybí makro.");
  }
  const type = String(src.type || "").toUpperCase();
  if (type !== "SIMPLE" && type !== "COMPLEX") {
    throw new Error("Soubor nemá typ SIMPLE nebo COMPLEX.");
  }
  return {
    name: clip(src.name, NAME_MAX),
    type,
    seq: clip(src.seq, SEQ_MAX),
    program: clip(src.program, PROGRAM_MAX),
  };
}

function parseMacroPack(raw) {
  if (typeof raw === "string" && raw.length > FILE_MAX) {
    throw new Error("Soubor makra je moc velký.");
  }
  let data;
  try {
    data = typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    throw new Error("Soubor není platný JSON.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Soubor není exportované makro Klikače.");
  }
  if (data.kind === KIND) {
    if (Number(data.format) !== FORMAT) {
      throw new Error("Tento formát makra Klikač nezná. Aktualizuj Klikač.");
    }
    return readMacroFields(data.macro);
  }
  if (data.name != null || data.program != null || data.seq != null) {
    return readMacroFields(data);
  }
  throw new Error("Soubor není exportované makro Klikače.");
}

module.exports = {
  KIND,
  FORMAT,
  buildMacroPack,
  parseMacroPack,
  fileNameFor,
};
