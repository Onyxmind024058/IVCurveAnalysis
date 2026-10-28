/* =============================================================================
   Training set (pre-alpha): reviewed curves kept in this browser (IndexedDB)
   until they are exported as one .ivtrain file for training.

   Sample = the analysed mean curve + the regions the reviewer chose (manual
   OML params) + the reviewer's results + where it came from (probe, ion,
   data range). Only curves a person reviewed and accepted are added.
   ============================================================================= */
(function (IV) {
  "use strict";
  const DB = "ivcurve-alpha-training", STORE = "samples", GOAL = 200;
  const COLLECT_KEY = "ivcurve-alpha.collect";

  let memory = null;  // fallback when IndexedDB is unavailable (then nothing survives a reload)
  const listeners = new Set();

  function open() {
    return new Promise((resolve, reject) => {
      if (!("indexedDB" in window)) { reject(new Error("IndexedDB unavailable")); return; }
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function tx(mode, fn) {
    if (memory) return fn(null);
    let db;
    try { db = await open(); } catch (_) { memory = new Map(); return fn(null); }
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const result = fn(t.objectStore(STORE));
      t.oncomplete = () => { db.close(); resolve(result && result.result !== undefined ? result.result : result); };
      t.onerror = () => { db.close(); reject(t.error); };
    });
  }

  const changed = async () => { const n = await count(); for (const f of listeners) f(n); };

  async function put(sample) {
    await tx("readwrite", (s) => (s ? s.put(sample) : memory.set(sample.id, sample)));
    changed();
  }
  async function all() {
    const r = await tx("readonly", (s) => (s ? s.getAll() : [...memory.values()]));
    return (r || []).sort((a, b) => a.added_at.localeCompare(b.added_at));
  }
  async function count() { return tx("readonly", (s) => (s ? s.count() : memory.size)); }
  async function remove(id) { await tx("readwrite", (s) => (s ? s.delete(id) : memory.delete(id))); changed(); }
  async function clear() { await tx("readwrite", (s) => (s ? s.clear() : memory.clear())); changed(); }

  /**
   * Adds a reviewed curve. review = {file, x, imean, params, results, area, xkey, scans}.
   * Skipped when collecting is off or the curve was marked not analysable.
   * The same curve reviewed again replaces the older sample (same id).
   */
  async function addReview(review) {
    if (!collecting() || !review.params || review.params.analysable === false) return false;
    await put(IV.ml.makeSample({ ...review, settings: IV.app.settingsSnapshot(), appVersion: IV.APP_VERSION }));
    return true;
  }

  async function exportFile() {
    const samples = await all();
    if (!samples.length) return 0;
    const data = { format: "ivcurve-training-set", format_version: 1, exported_at: new Date().toISOString(), app_version: IV.APP_VERSION, samples };
    IV.ui.download(`training_${samples.length}curves_${new Date().toISOString().slice(0, 10)}.ivtrain`, JSON.stringify(data), "application/json");
    return samples.length;
  }

  /**
   * Imports an .ivtrain file (all its samples) or an .ivbatch file (only the
   * curves a person reviewed and accepted). Same curves are not duplicated.
   * Returns {added, skipped: [{file, reason}], kind}.
   */
  async function importText(text) {
    let data;
    try { data = JSON.parse(text); } catch (_) { throw new Error("This file is not a training set (.ivtrain) or a saved batch (.ivbatch)."); }
    let samples, skipped = [], kind;
    if (data && data.format === "ivcurve-training-set") {
      samples = data.samples; kind = "training set";
    } else if (data && data.format === "ivcurve-batch") {
      ({ samples, skipped } = IV.ml.samplesFromBatch(data)); kind = "batch";
    } else {
      throw new Error("This file is not a training set (.ivtrain) or a saved batch (.ivbatch).");
    }
    const before = await count();
    for (const s of samples) await tx("readwrite", (st) => (st ? st.put(s) : memory.set(s.id, s)));
    changed();
    const after = await count();
    return { added: after - before, already: samples.length - (after - before), skipped, kind };
  }

  function collecting() {
    try { return localStorage.getItem(COLLECT_KEY) !== "off"; } catch (_) { return true; }
  }
  function setCollecting(on) {
    try { localStorage.setItem(COLLECT_KEY, on ? "on" : "off"); } catch (_) { /* ignore */ }
  }

  IV.training = {
    GOAL, addReview, all, count, remove, clear, exportFile, importText, collecting, setCollecting,
    onChange: (f) => listeners.add(f), persistent: () => !memory,
  };
})(window.IV = window.IV || {});
