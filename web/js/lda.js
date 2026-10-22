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

  function parseSeries(item, tag) {
    const node = child(item, tag);
    if (!node) throw new Error(`Missing tag: ${tag}`);
    return Float64Array.from(children(node, "Data"), (d) => parseFloat(d.textContent));
  }

  function parseLDA(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    const err = doc.querySelector("parsererror");
    if (err) throw new Error("File is not valid XML: " + err.textContent.split("\n")[0]);

    const dm = child(doc.documentElement, "DataManager");
    if (!dm) throw new Error("No <DataManager> found");

    const scans = children(dm, "DataItem").map((item) => {
      const idNode = child(item, "ID");
      return {
        id: parseInt(idNode ? idNode.textContent : "-1", 10),
        VData: parseSeries(item, "VData"),
        RefData: parseSeries(item, "RefData"),
        IData: parseSeries(item, "IData"),
      };
    });
    if (!scans.length) throw new Error("No scans found");
    scans.sort((a, b) => a.id - b.id);
    return scans;
  }

  /**
   * Synthetic Langmuir probe scans (Te = 3 eV, Vp = 10 V, cylindrical OML ion
   * branch) so the app can be explored without a measurement file.
   */
  function exampleScans(nScans = 5, nPts = 500) {
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
