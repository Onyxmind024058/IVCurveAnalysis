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

  /** Simple content hash, so the same curve reviewed twice replaces the older sample. */
  function hash(text) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 + c, 2246822519); }
    return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, "0");
  }

  const round = (a) => Array.from(a, (v) => (Number.isFinite(v) ? Number(v.toPrecision(7)) : null));
  const plain = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v)));

  /**
   * Adds a reviewed curve. review = {file, x, imean, params, results, area, xkey}.
   * Skipped when collecting is off or the curve was marked not analysable.
   */
  async function addReview(review) {
    if (!collecting() || !review.params || review.params.analysable === false) return false;
    const snap = IV.app.settingsSnapshot();
    const V = round(review.x), I = round(review.imean);
    const r = review.results;
    const sample = {
      format: "ivcurve-training-sample", format_version: 1,
      id: hash(`${review.file}|${V.join(",")}|${I.join(",")}`),
      added_at: new Date().toISOString(), app_version: IV.APP_VERSION,
      source: {
        file: review.file, xkey: review.xkey, scans: review.scans || null,
        probe: { diameter_mm: Number(snap.diameter), length_mm: Number(snap.length), area_m2: review.area },
        ion: { species: snap.ionGas, mass_amu: Number(snap.ionMass) },
        data_range: snap.crop,
      },
      curve: { V, I },
      human: {
        params: plain(review.params),
        results: plain({ Te_eV: r.Te_eV, Vp: r.Vp, Vf: r.Vf, ne_m3: r.ne_m3, Vp_dIdV: r.Vp_dIdV, Vp_intersection: r.Vp_intersection }),
      },
    };
    await put(sample);
    return true;
  }

  async function exportFile() {
    const samples = await all();
    if (!samples.length) return 0;
    const data = { format: "ivcurve-training-set", format_version: 1, exported_at: new Date().toISOString(), app_version: IV.APP_VERSION, samples };
    IV.ui.download(`training_${samples.length}curves_${new Date().toISOString().slice(0, 10)}.ivtrain`, JSON.stringify(data), "application/json");
    return samples.length;
  }

  /** Adds the samples of an .ivtrain file (same curves are not duplicated). */
  async function importText(text) {
    const data = JSON.parse(text);
    if (!data || data.format !== "ivcurve-training-set") throw new Error("This is not a training set (.ivtrain).");
    for (const s of data.samples) await tx("readwrite", (st) => (st ? st.put(s) : memory.set(s.id, s)));
    changed();
    return data.samples.length;
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
