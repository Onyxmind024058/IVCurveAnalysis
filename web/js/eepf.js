/* =============================================================================
   EEPF / EEDF window (port of EEPFDialog)
   ============================================================================= */
(function (IV) {
  "use strict";
  const N = IV.num;
  const { el, numberField, checkField } = IV.ui;

  function openEEPF({ V, I, probeArea, oml, title, onData }) {
    const d = IV.ui.openDialog({ title, onClose: () => onData(current) });
    d.foot.remove();
    let current = null;

    const recompute = () => update();
    const distSmooth = numberField("EEDF/EEPF smoothing:", { value: 9, step: 2, min: 3, max: 501, decimals: 0, width: "80px", onChange: recompute });
    const logY = checkField("Log y-axis", { onChange: recompute });
    const d2Smooth = numberField("2nd-derivative smoothing:", { value: 31, step: 2, min: 3, max: 501, decimals: 0, width: "80px", onChange: recompute });
    const eMin = numberField("Min energy (eV):", { value: 0, step: 0.5, min: 0, max: 1e6, decimals: 3, width: "90px", onChange: recompute });
    const errorLine = el("span.hint", { style: "color:var(--red)" });
    const controls = el("div.controls", { style: "border-top:none;border-bottom:1px solid var(--border)" },
      [distSmooth.field, logY.field, d2Smooth.field, eMin.field, errorLine]);

    const grid = el("div.plot-grid.g2x2");
    const mk = (name) => {
      const cell = el("div.plot-cell");
      const p = el("div");
      cell.append(p);
      grid.append(cell);
      const plot = new IV.Plot(p, { filename: name });
      d.plots.push(plot);
      return plot;
    };
    const pIV = mk("eepf_current"), pEEDF = mk("eedf"), pEEPF = mk("eepf"), pD2 = mk("d2ie_dv2");
    d.body.append(controls, grid);

    function update() {
      let data;
      try {
        data = N.computeEEPF(V, I, probeArea, oml, d2Smooth.value, eMin.value, distSmooth.value);
        current = data;
        errorLine.textContent = "";
      } catch (exc) {
        // inline instead of a modal so typing into a field never stacks pop-ups
        errorLine.textContent = `EEPF calculation failed: ${exc.message}`;
        return;
      }
      const logy = logY.value;
      pIV.render({
        title: "Electron current used for derivatives", xlabel: "Probe voltage (V)", ylabel: "Current (A)",
        traces: [{ x: data.V, y: data.I, name: "raw I" }, { x: data.V, y: data.Ie_smooth, name: "smoothed Ie", width: 2.2 }],
        vlines: [{ x: data.Vp, label: "Vp" }],
      });
      // zeros cannot be shown on a log axis
      const pos = (a) => (logy ? Array.from(a, (x) => (x > 0 ? x : null)) : a);
      pEEDF.render({
        title: "EEDF", xlabel: "Energy (eV)", ylabel: "EEDF", logy, uirevision: `eedf-${logy}`,
        traces: [{ x: data.E_eV, y: pos(data.EEDF), name: "EEDF raw" }, { x: data.E_eV, y: pos(data.EEDF_smooth), name: "EEDF smoothed", width: 2.2 }],
      });
      pEEPF.render({
        title: "EEPF", xlabel: "Energy (eV)", ylabel: "EEPF", logy, uirevision: `eepf-${logy}`,
        traces: [{ x: data.E_eV, y: pos(data.EEPF), name: "EEPF raw" }, { x: data.E_eV, y: pos(data.EEPF_smooth), name: "EEPF smoothed", width: 2.2 }],
      });
      pD2.render({
        title: "Second derivative", xlabel: "Probe voltage (V)", ylabel: "d²Ie/dV²",
        traces: [{ x: data.V, y: data.d2Ie_dV2, name: "d²Ie/dV²" }],
        vlines: [{ x: data.Vp, label: "Vp" }],
      });
    }

    update();
  }

  IV.openEEPF = openEEPF;
})(window.IV = window.IV || {});
