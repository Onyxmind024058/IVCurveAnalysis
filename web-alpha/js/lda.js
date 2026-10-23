/* =============================================================================
   .lda file loading (browser DOMParser port of load_lda / parse_series)
   ============================================================================= */
(function (IV) {
  "use strict";

  const child = (node, tag) => {
    for (const c of node.children) if (c.tagName === tag) return c;
    return null;
  };
  const children = (node, tag) => Array.from(node.children).filter((c) => c.tagName === tag);

  /** Values of <tag><Data>…</Data></tag>; empty or non-numeric values become NaN; null if the tag is missing. */
  function parseSeries(item, tag) {
    const node = child(item, tag);
    if (!node) return null;
    return Float64Array.from(children(node, "Data"), (d) => {
      const t = d.textContent.trim();
      return t === "" ? NaN : Number(t);
    });
  }

  /**
   * Returns the scans sorted by ID. VData and IData are required; RefData is
   * optional: when it is missing, empty or incomplete it is filled with NaN
   * and only VData can be used as x axis. Points with an empty voltage or
   * current are dropped. Notes about all this are in scans.notes.
   */
  function parseLDA(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const err = doc.querySelector("parsererror");
    if (err) throw new Error("File is not valid XML: " + err.textContent.split("\n")[0]);

    const dm = child(doc.documentElement, "DataManager");
    if (!dm) throw new Error("No <DataManager> found");

    let noRef = 0, dropped = 0;
    const scans = children(dm, "DataItem").map((item) => {
      const idNode = child(item, "ID");
      const id = parseInt(idNode ? idNode.textContent : "-1", 10);
      const V = parseSeries(item, "VData"), I = parseSeries(item, "IData");
      let R = parseSeries(item, "RefData");
      if (!V) throw new Error(`Scan ${id}: missing <VData>.`);
      if (!I) throw new Error(`Scan ${id}: missing <IData>.`);
      if (V.length !== I.length) {
        throw new Error(`Scan ${id}: VData and IData have different lengths (${V.length}, ${I.length}).`);
      }
      if (!R || R.length !== V.length || !R.every(Number.isFinite)) {
        noRef++;
        R = new Float64Array(V.length).fill(NaN);
      }
      const keep = [];
      for (let k = 0; k < V.length; k++) if (Number.isFinite(V[k]) && Number.isFinite(I[k])) keep.push(k);
      dropped += V.length - keep.length;
      if (keep.length < 10) throw new Error(`Scan ${id}: only ${keep.length} usable points.`);
      const pick = (a) => Float64Array.from(keep, (k) => a[k]);
      return { id, VData: pick(V), RefData: pick(R), IData: pick(I) };
    });
    if (!scans.length) throw new Error("No scans found");
    scans.sort((a, b) => a.id - b.id);
    scans.notes = [];
    if (noRef) {
      scans.notes.push(noRef === scans.length
        ? "RefData is empty in this file — VData is used as x axis."
        : `RefData is empty in ${noRef} of ${scans.length} scans — VData is used as x axis.`);
    }
    if (dropped) scans.notes.push(`${dropped} point${dropped === 1 ? "" : "s"} with an empty voltage or current skipped.`);
    return scans;
  }

  /**
   * Synthetic Langmuir probe scans (Te = 3 eV, Vp = 10 V, cylindrical OML ion
   * branch) so the app can be explored without a measurement file.
   */
  function exampleScans(nScans = 5, nPts = 1500) {
    let seed = 12345;
    const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
    const gauss = () => Math.sqrt(-2 * Math.log(rand() + 1e-12)) * Math.cos(2 * Math.PI * rand());
    const scans = [];
    for (let s = 0; s < nScans; s++) {
      const V = new Float64Array(nPts), R = new Float64Array(nPts), I = new Float64Array(nPts);
      const drift = 1 + 0.03 * (s - (nScans - 1) / 2) / nScans;
      for (let k = 0; k < nPts; k++) {
        const v = -40 + (60 * k) / (nPts - 1);
        const ie = v < 10 ? 1e-2 * Math.exp((v - 10) / 3) : 1e-2 * (1 + 0.01 * (v - 10));
        const ii = -1e-4 * Math.sqrt(Math.max(1 - 0.05 * v, 0));
        V[k] = v;
        R[k] = v * 1.002 + 0.05;
        I[k] = drift * ie + ii + 4e-6 * gauss();
      }
      scans.push({ id: s + 1, VData: V, RefData: R, IData: I });
    }
    return scans;
  }

  IV.lda = { parseLDA, exampleScans };
})(window.IV = window.IV || {});
