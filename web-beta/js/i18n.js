/* =============================================================================
   Interface languages: English (source), German, French, Simplified Chinese,
   Japanese, Dutch, Portuguese (Portugal), Hindi and Urdu (written right to left).

   The app is written in English; this module translates what is displayed:
   - IV.t(text): translation of one text (exact entry, or a pattern entry with
     {0}, {1}… placeholders for numbers and names);
   - the page is translated as it appears (text nodes and the title,
     placeholder, aria-label and data-tip attributes), also windows opened
     later, through a MutationObserver; switching the language re-translates
     from the English originals.
   Not translated: user data and file names, numbers, AI answers, the
   What's new history, and anything inside [data-no-i18n].
   Translations are in i18n-dict.js (IV.I18N_DICT: English → [de, fr, zh, ja, nl, pt, ur, hi]).
   ============================================================================= */
(function (IV) {
  "use strict";

  const LANGS = [["en", "English"], ["de", "Deutsch"], ["fr", "Français"], ["nl", "Nederlands"], ["pt", "Português"],
    ["zh", "简体中文"], ["ja", "日本語"], ["hi", "हिन्दी"], ["ur", "اردو"]];
  const COL = { de: 0, fr: 1, zh: 2, ja: 3, nl: 4, pt: 5, ur: 6, hi: 7 };
  const RTL = new Set(["ur"]);
  const HTML_LANG = { zh: "zh-Hans" };
  const KEY = "ivcurve.lang";
  const ATTRS = ["title", "placeholder", "aria-label", "data-tip"];
  const SKIP = "script, style, textarea, pre, code, [data-no-i18n], .js-plotly-plot, .agent-report, .chat-msg, .agent-steps, .agent-skill, td.file";

  function initialLang() {
    let saved = null;
    try { saved = localStorage.getItem(KEY); } catch (_) { /* private mode */ }
    if (saved && LANGS.some(([c]) => c === saved)) return saved;
    const nav = (navigator.language || "en").toLowerCase();
    const code = nav.split("-")[0];
    return COL[code] !== undefined ? code : "en";
  }

  let lang = initialLang();
  let exact = new Map(), patterns = [];
  const collect = (() => { try { return localStorage.getItem("ivcurve.i18n.collect") === "1"; } catch (_) { return false; } })();
  const seen = new Set();     // collect mode: every English text displayed (to complete the dictionary)
  const missing = new Set();  // collect mode: texts with no translation in the current language

  /** Builds the lookup for the current language from the dictionary. */
  function build() {
    exact = new Map(); patterns = [];
    if (lang === "en") return;
    const col = COL[lang];
    for (const [en, tr] of Object.entries(IV.I18N_DICT || {})) {
      const t = tr && tr[col];
      if (!t) continue;
      if (/\{\d\}/.test(en)) {
        const names = [];
        const rx = en.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{(\d)\}/g, (_, n) => { names.push(n); return "([\\s\\S]*?)"; });
        patterns.push({ rx: new RegExp(`^${rx}$`), names, t });
      } else exact.set(en, t);
    }
    // longer patterns first, so the most specific one wins
    patterns.sort((a, b) => b.rx.source.length - a.rx.source.length);
  }

  /** Translation of one text (leading/trailing spaces kept). */
  function t(text) {
    if (text == null) return text;
    const s = String(text);
    if (s.includes("\n")) return s.split("\n").map(t).join("\n");  // line by line (lists of warnings)
    if (collect) { const k = s.trim(); if (k && /[A-Za-z]/.test(k)) seen.add(k); }
    if (lang === "en") return s;
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    const core = m[2];
    if (!core || !/[A-Za-z]/.test(core)) return s;
    let out = exact.get(core);
    if (out === undefined) {
      for (const p of patterns) {
        const mm = core.match(p.rx);
        if (mm) { out = p.t.replace(/\{(\d)\}/g, (_, n) => { const i = p.names.indexOf(n); return i >= 0 ? t(mm[i + 1]) : ""; }); break; }
      }
    }
    if (out === undefined && collect) missing.add(core);
    return out === undefined ? s : m[1] + out + m[3];
  }

  // --- the page ---------------------------------------------------------------
  const original = new WeakMap();  // text node → English text
  const written = new WeakMap();   // text node → what we wrote (to ignore our own changes)

  function skipped(node) {
    const elmt = node.nodeType === 1 ? node : node.parentElement;
    return !elmt || !!elmt.closest(SKIP);
  }

  function translateText(node) {
    if (skipped(node)) return;
    const cur = node.data;
    if (written.get(node) === cur) return;
    if (!/[A-Za-z]/.test(cur)) return;
    original.set(node, cur);
    const out = t(cur);
    written.set(node, out);
    if (out !== cur) node.data = out;
  }

  function translateAttrs(elmt) {
    if (elmt.closest && elmt.closest(SKIP)) return;
    for (const a of ATTRS) {
      if (!elmt.hasAttribute(a)) continue;
      const cur = elmt.getAttribute(a);
      const store = `data-i18n-${a}`;
      if (elmt.getAttribute(`${store}-out`) === cur) continue;
      elmt.setAttribute(store, cur);
      const out = t(cur);
      elmt.setAttribute(`${store}-out`, out);
      if (out !== cur) elmt.setAttribute(a, out);
    }
  }

  function translateTree(root) {
    if (!root) return;
    if (root.nodeType === 3) { translateText(root); return; }
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) { if (skipped(root)) return; translateAttrs(root); }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: (n) => (n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) translateText(n); else translateAttrs(n);
    }
  }

  /** Back to English everywhere, then into the new language. */
  function retranslateAll() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (n.nodeType === 3) {
        if (original.has(n) && written.get(n) === n.data) { n.data = original.get(n); written.delete(n); }
      } else {
        for (const a of ATTRS) {
          const store = `data-i18n-${a}`;
          if (n.hasAttribute(store) && n.getAttribute(`${store}-out`) === n.getAttribute(a)) n.setAttribute(a, n.getAttribute(store));
          n.removeAttribute(`${store}-out`);
        }
      }
    }
    translateTree(document.body);
    document.title = t(IV.i18n.baseTitle);
  }

  /** lang and writing direction of the page (Urdu is written right to left). */
  function applyDocLang() {
    const html = document.documentElement;
    html.lang = HTML_LANG[lang] || lang;
    if (html.setAttribute) html.setAttribute("dir", RTL.has(lang) ? "rtl" : "ltr");
  }

  function setLang(code) {
    if (!LANGS.some(([c]) => c === code) || code === lang) return;
    lang = code;
    try { localStorage.setItem(KEY, code); } catch (_) { /* private mode */ }
    applyDocLang();
    build();
    retranslateAll();
    for (const fn of listeners) { try { fn(code); } catch (_) { /* keep going */ } }
  }

  const listeners = [];

  function start() {
    build();
    applyDocLang();
    IV.i18n.baseTitle = document.title;
    document.title = t(document.title);
    translateTree(document.body);
    new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "characterData") translateText(r.target);
        else if (r.type === "attributes") { if (r.target.nodeType === 1) translateAttrs(r.target); }
        else for (const n of r.addedNodes) translateTree(n);
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }

  /** Language selector for the title bar. */
  function selector() {
    const sel = document.createElement("select");
    sel.className = "lang-select";
    sel.setAttribute("aria-label", "Language");
    sel.setAttribute("data-no-i18n", "");
    for (const [code, name] of LANGS) { const o = document.createElement("option"); o.value = code; o.textContent = name; sel.append(o); }
    sel.value = lang;
    sel.addEventListener("change", () => setLang(sel.value));
    return sel;
  }

  /** Name of the interface language, in English (for the AI). */
  const languageName = () => ({ en: "English", de: "German", fr: "French", zh: "Simplified Chinese", ja: "Japanese", nl: "Dutch", pt: "European Portuguese (as written in Portugal)", ur: "Urdu", hi: "Hindi" })[lang];

  IV.i18n = { LANGS, get lang() { return lang; }, get rtl() { return RTL.has(lang); }, t, setLang, start, selector, languageName, onChange: (fn) => listeners.push(fn), seen, missing, baseTitle: "" };
  IV.t = t;
})(window.IV = window.IV || {});
