/* =============================================================================
   EPFL two-fluid model window (port of EPFLTwoFluidDialog)
   ============================================================================= */
(function (IV) {
  "use strict";
  const N = IV.num;
  const { el, numberField, selectField, fmtG } = IV.ui;

  function openEPFL({ V, I, probeArea, title, onResults }) {
    const raw = N.sortedCurve(V, I);
    const rb = N.rebinCurve(raw.V, raw.I, raw.I.length);
    const v = rb.V, cur = rb.I;
    const vMin = N.nanmin(v), vMax = N.nanmax(v);

    const s = {
      Ismooth: Float64Array.from(cur), J: null, dIdV: null, dIdVsmooth: null,
      Vp: NaN, Vf: NaN, Te_eV: NaN, ne_m3: NaN,
      EfVa: null, EfJa: null, fit: null, transLine: null, teLine: null,
    };

    const d = IV.ui.openDialog({ title });
    const recalc = () => recalculateAll();

    const smooth = numberField("Smooth window:", { value: 11, step: 2, min: 3, max: 501, decimals: 0, width: "80px", odd: true, onChange: recalc });
    const vpSpin = numberField("Vp:", { value: 0, step: 0.1, min: vMin - 100, max: vMax + 100, decimals: 2, width: "100px", onChange: recalc });
    const halfPts = numberField("Transition fit half-width points:", { value: 5, step: 1, min: 2, max: 500, decimals: 0, width: "80px", onChange: recalc });
    const vaSpin = numberField("Va upper limit for Te fit:", { value: 0, step: 0.1, min: vMin - 1000, max: vMax + 1000, decimals: 4, width: "110px", onChange: recalc });
    const offset = numberField("Log offset factor:", { value: 1, step: 0.1, min: 0, max: 1e6, decimals: 4, width: "90px", onChange: recalc });
    const fitMode = selectField("Exponential fitting:", ["ne", "Vp, ne", "all"], { onChange: recalc });
    const errorLine = el("span.hint", { style: "color:var(--red)" });

    d.body.append(el("div.controls", { style: "border-top:none;border-bottom:1px solid var(--border)" },
      [smooth.field, vpSpin.field, halfPts.field, vaSpin.field, offset.field, fitMode.field, errorLine]));

    const grid = el("div.plot-grid.g2x3");
    const mk = (name) => {
      const cell = el("div.plot-cell");
      const p = el("div");
      cell.append(p);
      grid.append(cell);
      const plot = new IV.Plot(p, { filename: name });
      d.plots.push(plot);
      return plot;
    };
    const pIV = mk("epfl_iv"), pDidv = mk("epfl_didv"), pTrans = mk("epfl_transition"), pTe = mk("epfl_te"), pExp = mk("epfl_fit");
    const tbody = el("tbody");
    grid.append(el("div.plot-cell.table-cell", {}, [
      el("h3", { text: "Results", style: "font-size:14px;margin-bottom:8px" }),
      el("table.data", {}, [el("thead", {}, [el("tr", {}, ["Vp", "Vf", "Te_eV", "ne_m^-3"].map((c) => el("th", { text: c })))]), tbody]),
    ]));
    d.body.append(grid);

    pDidv.onDrag = (id, x, final) => { vpSpin.set(x); if (final) recalculateAll(); };
    pTe.onDrag = (id, x, final) => { vaSpin.set(x); if (final) recalculateAll(); };

    const runBtn = el("button.btn", { text: "Run EPFL nonlinear fit", onclick: runNonlinearFit });
    d.foot.append(
      el("button.btn", { text: "Reset automatic guesses", onclick: resetGuesses }),
      runBtn,
      el("span", { style: "flex:1" }),
      el("button.btn.primary", { text: "Send results to main window and close", onclick: sendResults }),
    );

    function resetGuesses() {
      s.Ismooth = N.movingAverage(cur, smooth.value);
      const dd = N.movingAverage(N.gradient(s.Ismooth, v), smooth.value);
      s.Vp = v[N.nanargmax(dd)];
      vpSpin.set(s.Vp);
      vaSpin.set(s.Vp);
      recalculateAll();
    }

    function recalculateAll() {
      try {
        s.Ismooth = N.movingAverage(cur, smooth.value);
        s.J = s.Ismooth.map((x) => x / probeArea);
        s.dIdV = N.gradient(s.Ismooth, v);
        s.dIdVsmooth = N.movingAverage(s.dIdV, smooth.value);
        s.Vp = vpSpin.value;
        s.fit = null;
        transitionLinearEstimate();
        teLogEstimate();
        errorLine.textContent = "";
        updateTable();
        drawAll();
      } catch (exc) {
        errorLine.textContent = `EPFL two-fluid calculation failed: ${exc.message}`;
      }
    }

    function transitionLinearEstimate() {
      let idx = 0;
      for (let k = 1; k < v.length; k++) if (Math.abs(v[k] - s.Vp) < Math.abs(v[idx] - s.Vp)) idx = k;
      const half = halfPts.value;
      const lo = Math.max(0, idx - half), hi = Math.min(v.length, idx + half + 1);
      if (hi - lo < 3) throw new Error("Transition fit window is too small.");
      const Vfit = v.slice(lo, hi), Jfit = s.J.slice(lo, hi);
      const [kp, offp] = N.polyfit(Vfit, Jfit, 1);
      const Jap = N.interp(s.Vp, v, s.J);
      if (kp === 0) throw new Error("Transition slope is zero; cannot estimate Te.");
      s.Te_eV = Math.abs(Jap / kp);
      s.ne_m3 = (Math.exp(0.5) * Jap) / N.E_CHARGE / Math.sqrt((N.E_CHARGE * s.Te_eV) / N.M_E);
      s.transLine = [Vfit, Vfit.map((x) => kp * x + offp)];
    }

    function teLogEstimate() {
      let p0 = -1;
      for (let k = 0; k < s.J.length; k++) if (s.J[k] > 0) { p0 = k; break; }
      if (p0 < 0) throw new Error("No positive current-density region for Te log fit.");
      let p1 = 0;
      for (let k = 1; k < v.length; k++) if (Math.abs(v[k] - vaSpin.value) < Math.abs(v[p1] - vaSpin.value)) p1 = k;
      if (p1 <= p0 + 2) p1 = Math.min(v.length - 1, p0 + 10);
      s.EfVa = v.slice(p0, p1 + 1);
      s.EfJa = s.J.slice(p0, p1 + 1);
      s.Vf = v[p0];

      const offJ = Math.abs(N.nanmin(s.J) * offset.value);
      const xs = [], ys = [];
      s.EfVa.forEach((x, k) => {
        const y = Math.log(s.EfJa[k] + offJ);
        if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
      });
      if (xs.length >= 3) {
        const [slope, intercept] = N.polyfit(xs, ys, 1);
        if (slope > 0) s.Te_eV = 1 / slope;
        s.teLine = { x: xs, fit: xs.map((x) => slope * x + intercept), y: ys };
      } else {
        s.teLine = null;
      }
    }

    function exponentialFit() {
      if (!s.EfVa) return;
      let vf = [], jf = [];
      s.EfVa.forEach((x, k) => {
        if (Number.isFinite(x) && Number.isFinite(s.EfJa[k]) && s.EfJa[k] > 0) { vf.push(x); jf.push(s.EfJa[k]); }
      });
      if (vf.length < 5) throw new Error("Not enough positive current-density points for EPFL nonlinear fit.");
      if (vf.length > 300) {
        const take = N.linspace(0, vf.length - 1, 300).map((x) => Math.trunc(x));
        vf = take.map((k) => vf[k]);
        jf = take.map((k) => jf[k]);
      }
      s.fit = N.fitEPFLTwoFluid(vf, jf, fitMode.value,
        Math.max(Math.abs(s.ne_m3), 1e12), Math.max(Math.abs(s.Te_eV), 0.05), s.Vp, s.Vf);
      s.ne_m3 = s.fit.ne_m3;
      s.Te_eV = s.fit.Te_eV;
      s.Vp = s.fit.Vp;
      s.Vf = s.fit.Vf;
    }

    function runNonlinearFit() {
      runBtn.disabled = true;
      runBtn.textContent = "Fitting…";
      // let the button repaint before the (synchronous) fit runs
      setTimeout(() => {
        try {
          exponentialFit();
          errorLine.textContent = "";
          updateTable();
          drawAll();
        } catch (exc) {
          IV.ui.message("EPFL nonlinear fit failed", IV.escape(exc.message));
        } finally {
          runBtn.textContent = "Run EPFL nonlinear fit";
          runBtn.disabled = false;
        }
      }, 20);
    }

    function updateTable() {
      tbody.replaceChildren(el("tr", {}, [s.Vp, s.Vf, s.Te_eV, s.ne_m3].map((x) => el("td", { text: fmtG(x) }))));
    }

    function drawAll() {
      pIV.render({
        title: "I-V curve", xlabel: "V (V)", ylabel: "I (A)",
        traces: [{ x: v, y: cur, name: "rebinned raw" }, { x: v, y: s.Ismooth, name: "smoothed", width: 2.2 }],
        vlines: [{ x: s.Vp, label: "Vp" }, { x: s.Vf, label: "Vf", dash: "dot" }],
      });
      pDidv.render({
        title: "dI/dV and Vp", xlabel: "V (V)", ylabel: "dI/dV (A/V)",
        traces: [{ x: v, y: s.dIdV, name: "dI/dV" }, { x: v, y: s.dIdVsmooth, name: "smoothed dI/dV", width: 2.2 }],
        vlines: [{ x: s.Vp, label: "Vp (drag)", drag: "vp" }],
      });
      const trans = [{ x: v, y: s.J, name: "J" }];
      if (s.transLine) trans.push({ x: s.transLine[0], y: s.transLine[1], name: "linear transition fit", width: 2.4 });
      pTrans.render({
        title: "Transition-region linear estimate", xlabel: "V (V)", ylabel: "J (A/m²)",
        traces: trans, vlines: [{ x: s.Vp, label: "Vp" }],
      });
      pTe.render({
        title: "Exponential-growth Te fit", xlabel: "V (V)", ylabel: "log(J + offset)",
        traces: s.teLine ? [{ x: s.teLine.x, y: s.teLine.y, name: "log(J + offset)" },
          { x: s.teLine.x, y: s.teLine.fit, name: "Te log fit", width: 2.2, dash: "dash" }] : [],
        vlines: [{ x: vaSpin.value, label: "Va (drag)", drag: "va" }],
      });
      const exp = [{ x: s.EfVa || [], y: s.EfJa || [], name: "J measured" }];
      if (s.fit) exp.push({ x: s.fit.V_fit, y: s.fit.J_fit, name: "EPFL TF fit", width: 2.2, dash: "dash" });
      pExp.render({
        title: "EPFL two-fluid exponential fit", xlabel: "V (V)", ylabel: "J (A/m²)",
        traces: exp, text: s.fit ? undefined : "Click “Run EPFL nonlinear fit”",
      });
    }

    function sendResults() {
      onResults({ method: "EPFL two-fluid", Vp: s.Vp, Vf: s.Vf, Te_eV: s.Te_eV, ne_m3: s.ne_m3, fit_mode: fitMode.value });
      d.close();
    }

    resetGuesses();
  }

  IV.openEPFL = openEPFL;
})(window.IV = window.IV || {});
