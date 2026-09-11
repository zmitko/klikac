// Nápověda ke konstrukcím. Je v aplikaci, aby uživatel nemusel hledat dokumentaci.
(function (root, factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory({ ast: require("./ast"), keymap: require("./keymap") });
  } else {
    root.KlikacMacro = root.KlikacMacro || {};
    root.KlikacMacro.help = factory(root.KlikacMacro);
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function (dep) {
  const ast = dep.ast;
  const keymap = dep.keymap;

  const HELP = {
    press: {
      title: "STISK",
      summary: "Stiskne jednu klávesu na herním PC.",
      when: "Kdykoli potřebuješ poslat klávesu — základní stavební kámen makra.",
      syntax: "STISK <klávesa>",
      example: "STISK F1\nCEKEJ 2s\nSTISK 3",
      params: "Klávesa. Destička umí F1–F12, numpad 0–9, horní řadu +ěščřžýáíé, ENTER, LC a RC.",
      limits: `Jiné klávesy (mezerník, písmena) destička neumí. Dostupné: ${keymap.supportedList().join(" ")}`,
    },
    wait: {
      title: "CEKEJ",
      summary: "Pozastaví běh makra na zadanou dobu.",
      when: "Mezi stisky, aby hra stihla zareagovat, nebo pro pauzy mezi cykly.",
      syntax: "CEKEJ <doba>\nCEKEJ NAHODNE <od>-<do>\nCEKEJ DO HH:MM",
      example: "CEKEJ 500ms\nCEKEJ 3s\nCEKEJ 2min\nCEKEJ 1h\nCEKEJ NAHODNE 2s-5s\nCEKEJ DO 18:00",
      params: "Doba vždy s jednotkou: ms, s, min, h.",
      limits: "Bez jednotky to není platné — „CEKEJ 5xyz“ nebo „CEKEJ 500“ je chyba.",
    },
    repeat: {
      title: "OPAKUJ",
      summary: "Opakuje obsah bloku zadaný početkrát.",
      when: "Když víš, kolikrát se má něco provést.",
      syntax: "OPAKUJ <počet>x\n    …\nKONEC",
      example: "OPAKUJ 5x\n    STISK F1\n    CEKEJ 2s\nKONEC",
      params: "Počet opakování. Celé číslo větší než 0, nebo proměnná (třeba OPAKUJ POCET x).",
      limits: "Do bloku se dá vnořit cokoli, i další OPAKUJ nebo POKUD.",
    },
    forever: {
      title: "DOKOLA",
      summary: "Nekonečný cyklus — blok se opakuje, dokud makro nezastavíš.",
      when: "Klasické „AFK“ makro, které má běžet pořád.",
      syntax: "DOKOLA\n    …\nKONEC",
      example: "DOKOLA\n    STISK F1\n    CEKEJ 3s\nKONEC",
      params: "Žádný.",
      limits: "Ukončí ho jen BREAK, STOP nebo tlačítko Zastavit makro.",
    },
    during: {
      title: "PO DOBU",
      summary: "Opakuje blok, dokud neuplyne zadaná doba.",
      when: "Časově omezená činnost, třeba „bij dvacet minut“.",
      syntax: "PO DOBU <doba>\n    …\nKONEC",
      example: "PO DOBU 30s\n    STISK F1\n    CEKEJ 2s\nKONEC",
      params: "Doba s jednotkou (30s, 5min, 1h).",
      limits: "Čas se kontroluje před každým průchodem, běžící čekání se nepřeruší.",
    },
    every: {
      title: "KAZDYCH",
      summary: "Spouští blok periodicky — každých N sekund jeden průchod.",
      when: "Pravidelné akce, třeba buff každých 10 minut.",
      syntax: "KAZDYCH <perioda>\n    …\nKONEC",
      example: "MAKRO M2\n    STISK F1\nKONEC\n\nKAZDYCH 10s\n    SPUST M2\nKONEC",
      params: "Perioda s jednotkou.",
      limits: "Když je blok delší než perioda, další průchod začne hned po dokončení.",
    },
    if: {
      title: "POKUD",
      summary: "Podmíněně provede obsah bloku.",
      when: "Rozhodování podle proměnné, času nebo čítače.",
      syntax: "POKUD <podmínka>\n    …\nJINAK\n    …\nKONEC",
      example: "NASTAV POCET = 5\nPOKUD POCET >= 5\n    STISK F1\nJINAK\n    STISK F2\nKONEC",
      params: "Podmínka může používat = != > < >= <= a spojky A, NEBO, NE.",
      limits: "Podmínka vidí jen vlastní proměnné, čas a náhodu — nikdy obsah obrazovky.",
    },
    set: {
      title: "NASTAV",
      summary: "Nastaví proměnnou na hodnotu.",
      when: "Čítače, přepínače, uložení času startu.",
      syntax: "NASTAV <proměnná> = <hodnota>",
      example: "NASTAV POCET = 0\nNASTAV X = NAHODNE 1-100\nNASTAV START = TED",
      params: "Hodnota: číslo, jiná proměnná, TED, CAS nebo NAHODNE od-do.",
      limits: "Názvy A, NEBO a NE jsou vyhrazené pro logiku.",
    },
    inc: {
      title: "ZVYS",
      summary: "Zvýší proměnnou o zadanou hodnotu.",
      when: "Počítání průchodů cyklem.",
      syntax: "ZVYS <proměnná> O <hodnota>",
      example: "NASTAV POCET = 0\nDOKOLA\n    ZVYS POCET O 1\n    POKUD POCET >= 10\n        BREAK\n    KONEC\nKONEC",
      params: "Hodnota, o kterou se přičte. Výchozí 1.",
      limits: "Proměnná musí být někde nastavená přes NASTAV.",
    },
    dec: {
      title: "SNIZ",
      summary: "Sníží proměnnou o zadanou hodnotu.",
      when: "Odpočítávání.",
      syntax: "SNIZ <proměnná> O <hodnota>",
      example: "NASTAV X = 10\nSNIZ X O 2",
      params: "Hodnota, o kterou se odečte.",
      limits: "Proměnná musí být někde nastavená přes NASTAV.",
    },
    choice: {
      title: "NAHODNE",
      summary: "Provede jednu z variant — buď rovnoměrně, nebo podle procent.",
      when: "Aby makro nebylo pořád stejné.",
      syntax: "NAHODNE\n    …\nNEBO\n    …\nKONEC",
      example: "NAHODNE\n    70%:\n        STISK F2\n    20%:\n        STISK F3\n    10%:\n        STISK F4\nKONEC",
      params: "Volitelná procenta u každé varianty. Buď u všech, nebo u žádné.",
      limits: "Součet procent nesmí přesáhnout 100 %.",
    },
    call: {
      title: "SPUST",
      summary: "Spustí pojmenované makro definované v tomhle programu.",
      when: "Když se stejná část opakuje na víc místech.",
      syntax: "SPUST <makro>\nSPUST <makro>(<parametry>)",
      example: "MAKRO M1(POCET)\n    OPAKUJ POCET x\n        STISK F1\n        CEKEJ 2s\n    KONEC\nKONEC\n\nSPUST M1(5)",
      params: "Počet parametrů musí odpovídat definici.",
      limits: "Rekurze (M1 → M2 → M1) není dovolená, validace ji najde.",
    },
    macroDef: {
      title: "MAKRO",
      summary: "Definuje pojmenovaný blok, který jde spouštět přes SPUST.",
      when: "Rozdělení dlouhého programu na pojmenované části.",
      syntax: "MAKRO <název>(<parametry>)\n    …\nKONEC",
      example: "MAKRO M1\n    STISK F1\n    CEKEJ 3s\nKONEC",
      params: "Název a volitelné parametry, oddělené čárkou.",
      limits: "Definice patří na nejvyšší úroveň, ne dovnitř cyklu.",
    },
    break: {
      title: "BREAK",
      summary: "Okamžitě ukončí nejbližší cyklus.",
      when: "Vyskočení z DOKOLA po splnění podmínky.",
      syntax: "BREAK",
      example: "DOKOLA\n    ZVYS POCET O 1\n    POKUD POCET >= 10\n        BREAK\n    KONEC\nKONEC",
      params: "Žádný.",
      limits: "Mimo cyklus je to chyba.",
    },
    continue: {
      title: "CONTINUE",
      summary: "Přeskočí zbytek průchodu a jde na další kolo cyklu.",
      when: "Když se má zbytek bloku za určité situace vynechat.",
      syntax: "CONTINUE",
      example: "NASTAV X = 1\nOPAKUJ 5x\n    POKUD X = 1\n        CONTINUE\n    KONEC\n    STISK F1\nKONEC",
      params: "Žádný.",
      limits: "Mimo cyklus je to chyba.",
    },
    stop: {
      title: "STOP",
      summary: "Ukončí celý program makra.",
      when: "Definitivní konec, třeba po dosažení limitu.",
      syntax: "STOP",
      example: "POKUD CAS >= 18:00\n    STOP\nKONEC",
      params: "Žádný.",
      limits: "Zastaví i všechny nadřazené cykly.",
    },
    print: {
      title: "VYPIS",
      summary: "Zapíše text nebo hodnotu proměnné do Protokolu.",
      when: "Ladění — zjistit, kde makro je a co má v proměnných.",
      syntax: "VYPIS \"text\"\nVYPIS <proměnná>",
      example: "VYPIS \"Start makra\"\nNASTAV POCET = 3\nVYPIS POCET",
      params: "Text v uvozovkách nebo název proměnné.",
      limits: "Nic nemačká, jen loguje.",
    },
    comment: {
      title: "KOMENTÁŘ",
      summary: "Poznámka pro člověka, běh ji ignoruje.",
      when: "Vysvětlení, co která část dělá.",
      syntax: "# text",
      example: "# tady začíná rebuff\nSTISK F3",
      params: "Libovolný text.",
      limits: "Musí být na vlastním řádku.",
    },
  };

  const INTRO = {
    title: "Jazyk V2",
    summary: "Makro je „slepé“ — nevidí obrazovku ani hru. Rozhoduje se jen podle vlastních proměnných, času, čítačů a náhody.",
    when: "Vyber konstrukci vpravo, klikni na ni a vloží se do programu.",
    syntax: "Bloky se ukončují slovem KONEC. Příkazy nejsou citlivé na velká a malá písmena.",
    example: "DOKOLA\n    STISK F1\n    CEKEJ NAHODNE 2s-5s\nKONEC",
    params: "Odsazení je jen pro čitelnost.",
    limits: "V2 neumí čtení obrazovky, OCR, pixely, aktivní okno ani reakci na stisky uživatele.",
  };

  function helpFor(constructId) {
    if (!constructId) {
      return { id: "", ...INTRO };
    }
    const entry = HELP[constructId];
    if (!entry) {
      return { id: constructId, ...INTRO };
    }
    const spec = ast.constructById(constructId);
    return { id: constructId, icon: spec ? spec.icon : "", ...entry };
  }

  function helpForKind(kind) {
    const spec = ast.constructByKind(kind);
    return helpFor(spec ? spec.id : "");
  }

  return { helpFor, helpForKind, INTRO, HELP };
});
