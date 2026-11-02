/* =============================================================================
   Checks for the interface languages (pre-alpha): the dictionary is complete
   and consistent, and texts with numbers are translated through patterns.

       node --test web-alpha/tests/i18n.test.js
   ============================================================================= */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

// minimal browser stand-ins: the engine only needs them for the page, not for IV.t
global.window = { IV: {} };
global.localStorage = { getItem: () => null, setItem() {} };
Object.defineProperty(globalThis, "navigator", { value: { language: "en" }, configurable: true });
global.document = { documentElement: {}, title: "", body: {}, createTreeWalker: () => ({ nextNode: () => null }) };
global.NodeFilter = { SHOW_TEXT: 4, SHOW_ELEMENT: 1, FILTER_ACCEPT: 1, FILTER_REJECT: 2 };
require("../js/i18n-dict.js");
require("../js/i18n.js");
const IV = window.IV;
const DICT = IV.I18N_DICT;

test("every entry has German, French and Chinese, with the same placeholders", () => {
  for (const [en, tr] of Object.entries(DICT)) {
    assert.equal(tr.length, 3, en);
    const ph = (s) => (s.match(/\{\d\}/g) || []).sort().join();
    for (const t of tr) {
      assert.ok(t && t.trim(), `empty translation for “${en}”`);
      assert.equal(ph(t), ph(en), `placeholders of “${en}” → “${t}”`);
    }
  }
});

test("exact texts, patterns with numbers, nested patterns, line by line", () => {
  IV.i18n.setLang("de");
  assert.equal(IV.t("Batch review"), "Stapelprüfung");
  assert.equal(IV.t("  Cancel "), "  Abbrechen ", "surrounding spaces are kept");
  assert.equal(IV.t("Review next ▶ (12 left)"), "Nächste prüfen ▶ (12 übrig)");
  assert.equal(IV.t("Settings from the main window: Probe 0.15 × 10 mm · Ar⁺ (39.948 amu) · x axis VData · full data range"),
    "Einstellungen aus dem Hauptfenster: Sonde 0.15 × 10 mm · Ar⁺ (39.948 u) · X-Achse VData · ganzer Datenbereich");
  assert.equal(IV.t("Vp is at the end of the sweep\nNo warnings."), "Vp liegt am Ende des Sweeps\nKeine Warnungen.");
  assert.equal(IV.t("pos_5mm.lda"), "pos_5mm.lda", "data is not translated");
  IV.i18n.setLang("zh");
  assert.equal(IV.t("AI verdict: bad"), "AI 判定：不良");
  IV.i18n.setLang("fr");
  assert.equal(IV.t("Pre-reviewed by the AI: 3 of 4."), "Pré-vérifiées par l'IA : 3 sur 4.");
  IV.i18n.setLang("en");
  assert.equal(IV.t("Batch review"), "Batch review");
});
