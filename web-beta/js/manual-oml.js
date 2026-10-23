/* =============================================================================
   Manual OML analysis window (port of ManualOMLDialog)
   ============================================================================= */
(function (IV) {
  "use strict";
  const N = IV.num;
  const { el, numberField, sliderField, checkField, selectField, fmtG } = IV.ui;
  const SMOOTH_METHODS = ["Moving average", "Polynomial / SG-like"];

  /**
   * params (optional): settings returned by an earlier run (results.params);
   * the window then replays those steps and opens on the last one reached.
   */
  /**
   * Batch review options: acceptLabel replaces the send button text, onSkip
   * adds a "Skip" button (close without a result), title replaces the window title.
   */
  function openManualOML({ V, I, probeArea, ionMass, label = "Mean curve", params, onResults,
    acceptLabel = "Send results to main window and close", onSkip, title, onClose }) {
    const { V: v, I: cur } = N.sortedCurve(V, I);
    const n = v.length;
    const vMin = N.nanmin(v), vMax = N.nanmax(v);

    const s = {
      Ismooth: Float64Array.from(cur), dIdV: null, dIdVsmooth: null,
      Vf: N.finiteCrossingX(v, cur), Vp1: NaN, Vp2: NaN, Vp: NaN,
      Te_eV: NaN, ne_m3: NaN, Iis_A: NaN, Ies_A: NaN,
      ionCoeff: null, Iion: null, Ie: null, transCoeff: null, satCoeff: null,
      reached: 0,  // furthest step completed with "Next" (5 = finished)
    };

    const d = IV.ui.openDialog({ title: title || `Manual OML analysis — ${label}`, onClose });
    d.foot.remove();
    const tabs = IV.ui.tabs(["Smooth IV", "Vf + ion fit", "dI/dV smooth", "dI/dV Vp", "log(Ie) fits", "Results"],
      (i) => requestAnimationFrame(() => {
        for (const node of tabs.panels[i].querySelectorAll(".plot")) Plotly.Plots.resize(node);
      }));
    d.body.append(tabs.strip, ...tabs.panels);

    const voltSpin = (lbl, onChange) => numberField(lbl, {
      value: 0, step: 0.1, decimals: 4, min: vMin - 1000, max: vMax + 1000, onChange,
    });

    function plotPanel(panel, filename) {
      const holder = el("div.single-plot");
      const plotEl = el("div");
      holder.append(plotEl);
      const controls = el("div.controls");
      panel.append(holder, controls);
      const plot = new IV.Plot(plotEl, { filename });
      d.plots.push(plot);
      return { plot, controls };
    }

    /** Hook a plot's draggable lines to spin boxes: live value while dragging, recompute on release. */
    function bindDrag(plot, spins, onRelease) {
      plot.onDrag = (id, x, final) => {
        spins[id].set(x);
        if (final) onRelease(id);
      };
    }

    const nextBtn = (text, fn, primary = true) =>
      el(`button.btn${primary ? ".primary" : ""}`, { text, onclick: fn });

    // ----- Tab 1: smooth IV --------------------------------------------------
    const t1 = plotPanel(tabs.panels[0], "smooth_iv");
    const smoothMethod = selectField("Smooth method:", SMOOTH_METHODS, { onChange: updateSmoothIV });
    const winCap = Math.max(5, Math.min(n, 501));
    const winMax = winCap % 2 ? winCap : winCap - 1;  // odd, like every smoothing window
    const startWin = N.makeOdd(Math.min(21, Math.max(3, Math.floor(n / 10))));
    const smoothWindow = sliderField("Window:", { value: startWin, min: 3, max: winMax, step: 2, onChange: updateSmoothIV });
    const smoothOrder = numberField("Poly order:", { value: 2, step: 1, min: 1, max: 7, decimals: 0, width: "64px", onChange: updateSmoothIV });
    const analysable = checkField("Analysable", { checked: true });
    const startOver = el("button.btn.hidden", { text: "Start over", title: "Back to the default settings", onclick: resetAll });
    t1.controls.append(smoothMethod.field, smoothWindow.field, smoothOrder.field, analysable.field, startOver, nextBtn("Next", nextFromSmooth));

    function updateSmoothIV() {
      s.Ismooth = N.smoothSignal(cur, smoothMethod.value, N.makeOdd(smoothWindow.value), smoothOrder.value);
      t1.plot.render({
        title: label, xlabel: "Potential (V)", ylabel: "Current (A)",
        traces: [{ x: v, y: cur, name: "raw" }, { x: v, y: s.Ismooth, name: "smoothed", width: 2.2 }],
      });
    }

    function nextFromSmooth() {
      s.reached = Math.max(s.reached, 1);
      if (!analysable.value) {
        s.Vp = s.Vf = s.Te_eV = s.ne_m3 = s.Iis_A = s.Ies_A = NaN;
        updateResultsTable();
        tabs.select(5);
        return;
      }
      s.Vf = N.finiteCrossingX(v, s.Ismooth);
      if (!Number.isFinite(s.Vf)) {
        let best = 0;
        for (let k = 1; k < n; k++) if (Math.abs(s.Ismooth[k]) < Math.abs(s.Ismooth[best])) best = k;
        s.Vf = v[best];
      }
      const vminDefault = v[Math.min(5, n - 1)];
      let vmaxDefault = Math.min(s.Vf, vminDefault + 0.25 * (vMax - vminDefault));
      if (vmaxDefault <= vminDefault) vmaxDefault = vminDefault + 0.1 * (vMax - vminDefault);
      ion.vf.set(s.Vf);
      ion.vmin.set(vminDefault);
      ion.vmax.set(vmaxDefault);
      updateIonFit();
      tabs.select(1);
    }

    // ----- Tab 2: Vf + ion fit -----------------------------------------------
    const t2 = plotPanel(tabs.panels[1], "ion_fit");
    const ion = {
      vf: voltSpin("Vf:", updateIonFit),
      vmin: voltSpin("Ion Vmin:", updateIonFit),
      vmax: voltSpin("Ion Vmax:", updateIonFit),
    };
    t2.controls.append(ion.vf.field, ion.vmin.field, ion.vmax.field,
      el("span.hint", { text: "Drag the lines on the plot to adjust." }), el("span.spacer"), nextBtn("Next", nextFromIon));
    bindDrag(t2.plot, ion, updateIonFit);

    function updateIonFit() {
      s.Vf = ion.vf.value;
      try {
        // Basel OML style for a cylindrical probe: fit I_i^2 versus V in the
        // ion-current region, then reconstruct I_i(V) with the region's sign.
        const lo = Math.min(ion.vmin.value, ion.vmax.value), hi = Math.max(ion.vmin.value, ion.vmax.value);
        const xs = [], ys = [], is = [];
        for (let k = 0; k < n; k++) {
          if (v[k] >= lo && v[k] <= hi && Number.isFinite(s.Ismooth[k])) {
            xs.push(v[k]); is.push(s.Ismooth[k]); ys.push(s.Ismooth[k] ** 2);
          }
        }
        if (xs.length < 2) throw new Error("Not enough points in selected ion fit region.");
        let signI = N.sign(N.nanmedian(is));
        if (signI === 0) signI = -1;
        const coeff = N.polyfit(xs, ys, 1);
        s.ionCoeff = coeff;
        s.Iion = Float64Array.from(v, (x) => signI * Math.sqrt(Math.max(N.polyval(coeff, x), 0)));
        s.Iis_A = N.ionCurrentAt(s.Vf, coeff[0], coeff[1], signI);  // ion current at Vf
      } catch (_) {
        s.ionCoeff = null;
        s.Iion = new Float64Array(n).fill(NaN);
        s.Iis_A = NaN;
      }

      const idx = [];
      for (let k = 0; k < n; k++) if (!Number.isFinite(s.Vf) || v[k] <= s.Vf) idx.push(k);
      const pick = (a, f = (x) => x) => idx.map((k) => f(a[k]));
      const sq = (x) => x * x;
      const traces = [
        { x: pick(v), y: pick(cur, sq), name: "raw I²" },
        { x: pick(v), y: pick(s.Ismooth, sq), name: "smoothed I²", width: 2 },
      ];
      if (s.ionCoeff) traces.push({ x: pick(v), y: pick(s.Iion, sq), name: "linear fit on I²", width: 2.2, dash: "dash" });
      const xr = idx.length ? [v[idx[0]], s.Vf] : undefined;
      t2.plot.render({
        title: "Floating potential and ion-current fit", xlabel: "Potential (V)", ylabel: "Current squared (A²)",
        traces, xrange: xr && xr[1] > xr[0] ? xr : undefined, uirevision: `ion-${s.Vf}`,
        vlines: [
          { x: ion.vf.value, label: "Vf", drag: "vf", dash: "dash" },
          { x: ion.vmin.value, label: "ion min", drag: "vmin", dash: "dot" },
          { x: ion.vmax.value, label: "ion max", drag: "vmax", dash: "dot" },
        ],
      });
    }

    /** Electron current after ion-current subtraction, and its derivative. */
    function electronCurrent() {
      s.Ie = Float64Array.from(s.Ismooth, (x, k) => x - s.Iion[k]);
      s.dIdV = N.gradient(s.Ie, v);
    }

    function nextFromIon() {
      if (!s.ionCoeff) {
        IV.ui.message("Missing fit", "Please choose a valid ion fit region first.");
        return;
      }
      s.reached = Math.max(s.reached, 2);
      electronCurrent();
      updateDidvSmooth();
      tabs.select(2);
    }

    // ----- Tab 3: dI/dV smoothing --------------------------------------------
    const t3 = plotPanel(tabs.panels[2], "didv_smooth");
    const dMethod = selectField("dI/dV smooth method:", SMOOTH_METHODS, { onChange: updateDidvSmooth });
    const dWindow = sliderField("Window:", { value: startWin, min: 3, max: winMax, step: 2, onChange: updateDidvSmooth });
    const dOrder = numberField("Poly order:", { value: 2, step: 1, min: 1, max: 7, decimals: 0, width: "64px", onChange: updateDidvSmooth });
    t3.controls.append(dMethod.field, dWindow.field, dOrder.field, nextBtn("Next", nextFromDidvSmooth));

    function updateDidvSmooth() {
      if (!s.dIdV) return;
      s.dIdVsmooth = N.smoothSignal(s.dIdV, dMethod.value, N.makeOdd(dWindow.value), dOrder.value);
      t3.plot.render({
        title: "Derivative smoothing", xlabel: "Potential (V)", ylabel: "dIe/dV (A/V)",
        traces: [{ x: v, y: s.dIdV, name: "raw dIe/dV" }, { x: v, y: s.dIdVsmooth, name: "smoothed dIe/dV", width: 2.2 }],
        vlines: Number.isFinite(s.Vp1) ? [{ x: s.Vp1, label: "current Vp", drag: "vp1" }] : [],
      });
    }

    function nextFromDidvSmooth() {
      if (!s.dIdVsmooth) return;
      s.reached = Math.max(s.reached, 3);
      let margin = n > 10 ? 5 : 0;
      let local = s.dIdVsmooth.slice(margin, n - margin);
      if (!local.length) { local = s.dIdVsmooth; margin = 0; }
      s.Vp1 = v[N.nanargmax(local) + margin];
      vp.vp1.set(s.Vp1);
      updateDidvSmooth();
      updateVpPlot();
      tabs.select(3);
    }

    // ----- Tab 4: Vp from dI/dV ----------------------------------------------
    const t4 = plotPanel(tabs.panels[3], "vp_didv");
    const vp = { vp1: voltSpin("Vp from dI/dV:", updateVpPlot) };
    t4.controls.append(vp.vp1.field, el("span.hint", { text: "Drag the Vp line on the plot." }), el("span.spacer"), nextBtn("Next", nextFromVp));
    bindDrag(t4.plot, vp, updateVpPlot);
    bindDrag(t3.plot, vp, () => { s.Vp1 = vp.vp1.value; updateDidvSmooth(); });

    function updateVpPlot() {
      if (!s.dIdVsmooth) return;
      s.Vp1 = vp.vp1.value;
      t4.plot.render({
        title: "Manual plasma potential from derivative", xlabel: "Potential (V)", ylabel: "dIe/dV (A/V)",
        traces: [{ x: v, y: s.dIdVsmooth, name: "smoothed dIe/dV", width: 2 }],
        vlines: [{ x: s.Vp1, label: "Vp from dI/dV", drag: "vp1" }],
      });
    }

    function nextFromVp() {
      s.reached = Math.max(s.reached, 4);
      s.Vp1 = vp.vp1.value;
      const span = vMax - vMin;
      const clip = (x) => Math.min(vMax, Math.max(vMin, x));
      lf.tmin.set(clip(s.Vp1 - 0.30 * span));
      lf.tmax.set(clip(s.Vp1 - 0.10 * span));
      lf.smin.set(clip(s.Vp1 + 0.05 * span));
      lf.smax.set(clip(s.Vp1 + 0.25 * span));
      lf.vp2.set(s.Vp1);
      updateLogFit();
      tabs.select(4);
    }

    // ----- Tab 5: log(Ie) fits -----------------------------------------------
    const t5 = plotPanel(tabs.panels[4], "log_ie_fits");
    const lf = {
      tmin: voltSpin("Transition min:", updateLogFit),
      tmax: voltSpin("Transition max:", updateLogFit),
      smin: voltSpin("Saturation min:", updateLogFit),
      smax: voltSpin("Saturation max:", updateLogFit),
      vp2: voltSpin("Vp intersection:", () => { s.Vp2 = lf.vp2.value; updateLogFitPreserveVp2(); }),
    };
    t5.controls.append(lf.tmin.field, lf.tmax.field, lf.smin.field, lf.smax.field, lf.vp2.field,
      el("span.spacer"), nextBtn("Finish", finishAnalysis));
    bindDrag(t5.plot, lf, (id) => (id === "vp2" ? updateLogFitPreserveVp2() : updateLogFit()));

    const xfit = N.linspace(vMin, vMax, 1000);

    function fitBoth() {
      s.transCoeff = N.fitLineRegion(v, s.Ie, lf.tmin.value, lf.tmax.value, true, true);
      s.satCoeff = N.fitLineRegion(v, s.Ie, lf.smin.value, lf.smax.value, true, true);
      return [N.polyval(s.transCoeff, xfit), N.polyval(s.satCoeff, xfit)];
    }

    function updateLogFit() {
      if (!s.Ie) return;
      let yT = null, yS = null;
      try {
        [yT, yS] = fitBoth();
        let best = 0;
        for (let k = 1; k < xfit.length; k++) if (Math.abs(yS[k] - yT[k]) < Math.abs(yS[best] - yT[best])) best = k;
        s.Vp2 = xfit[best];
        lf.vp2.set(s.Vp2);
      } catch (_) {
        s.transCoeff = s.satCoeff = null;
      }
      drawLogFit(yT, yS);
    }

    function updateLogFitPreserveVp2() {
      if (!s.Ie) return;
      let yT = null, yS = null;
      try { [yT, yS] = fitBoth(); } catch (_) { /* keep previous coefficients, draw data only */ }
      drawLogFit(yT, yS);
    }

    function drawLogFit(yT, yS) {
      s.Vp2 = lf.vp2.value;
      const xs = [], ys = [];
      for (let k = 0; k < n; k++) if (s.Ie[k] > 0) { xs.push(v[k]); ys.push(Math.log(s.Ie[k])); }
      const traces = [{ x: xs, y: ys, name: "log(Ie)" }];
      if (yS) traces.push({ x: xfit, y: yS, name: "saturation fit", width: 2, dash: "dash" });
      if (yT) traces.push({ x: xfit, y: yT, name: "transition fit", width: 2, dash: "dash" });
      // keep the y-range on the data so the extrapolated fits don't flatten it
      const lo = N.nanmin(ys), hi = N.nanmax(ys), pad = 0.08 * (hi - lo || 1);
      t5.plot.render({
        title: "Transition and saturation fits", xlabel: "Potential (V)", ylabel: "ln(Ie [A])",
        traces, yrange: ys.length ? [lo - pad, hi + pad] : undefined,
        vlines: [
          { x: lf.tmin.value, label: "transition", drag: "tmin", dash: "dot" },
          { x: lf.tmax.value, drag: "tmax", dash: "dot" },
          { x: lf.smin.value, label: "saturation", drag: "smin", dash: "dash" },
          { x: lf.smax.value, drag: "smax", dash: "dash" },
          { x: s.Vp1, label: "Vp dI/dV", dash: "dashdot" },
          { x: s.Vp2, label: "Vp intersection", drag: "vp2", dash: "solid" },
        ],
      });
    }

    function finishAnalysis() {
      if (!s.transCoeff) {
        IV.ui.message("Missing transition fit", "Please choose a valid transition fit region.");
        return;
      }
      const slope = s.transCoeff[0];
      if (slope <= 0) {
        IV.ui.message("Invalid Te", "Transition fit slope must be positive for Te = 1/slope.");
        return;
      }
      s.Te_eV = 1 / slope;
      s.reached = 5;
      s.Vp2 = lf.vp2.value;
      if (Number.isFinite(s.Vp1) && Number.isFinite(s.Vp2)) s.Vp = 0.5 * (s.Vp1 + s.Vp2);
      else s.Vp = Number.isFinite(s.Vp1) ? s.Vp1 : s.Vp2;

      s.Ies_A = s.Ie && Number.isFinite(s.Vp) ? N.interp(s.Vp, v, s.Ie) : NaN;
      if (s.Ies_A > 0 && probeArea > 0 && s.Te_eV > 0) {
        const teJ = s.Te_eV * N.E_CHARGE;
        s.ne_m3 = (s.Ies_A / (N.E_CHARGE * probeArea)) * Math.sqrt((2 * Math.PI * N.M_E) / teJ);
      } else {
        s.ne_m3 = NaN;
      }
      updateResultsTable();
      tabs.select(5);
    }

    // ----- Tab 6: results ----------------------------------------------------
    const cols = ["Vp", "ΔVp check", "Vf", "Te_eV", "Te Vp−Vf OML", "Te Vp−Vf planar", "ne_m^-3", "Iis_A (at Vf)", "Ies_A"];
    const tbody = el("tbody");
    const table = el("table.data", {}, [el("thead", {}, [el("tr", {}, cols.map((c) => el("th", { text: c })))]), tbody]);
    const teWarningLine = el("p.te-warning");
    const vpWarningLine = el("p.te-warning");
    // overview: ln(Ie) with both fits and the potentials, so the result can be judged at a glance
    const overviewEl = el("div");
    tabs.panels[5].append(
      el("div", { style: "padding:14px 14px 0;overflow:auto" }, [table, vpWarningLine, teWarningLine]),
      el("div.single-plot", {}, [overviewEl]),
      el("div.controls", {}, [
        el("span.spacer"),
        onSkip ? el("button.btn", { text: "Skip for now", onclick: () => { d.close(); onSkip(); } }) : null,
        nextBtn(acceptLabel, sendResults),
      ]),
    );

    const overview = new IV.Plot(overviewEl, { filename: "overview" });
    d.plots.push(overview);

    function updateResultsTable() {
      // cross-check of Te from the potential difference (same rule as the results cards)
      const t = N.teFromPotentials(s.Vp, s.Vf, ionMass);
      // validation: the two Vp values within 2 V (good) or 5 V with a Te cross-check (ok)
      const vc = Number.isFinite(s.Te_eV)
        ? IV.ui.vpCheckInfo(s.Vp1, s.Vp2, s.Te_eV, t.Te_OML_eV, t.Te_planar_eV) : { level: "", label: "", text: "" };
      const agree = vc.label;
      tbody.replaceChildren(el("tr", {}, [s.Vp, agree, s.Vf, s.Te_eV, t.Te_OML_eV, t.Te_planar_eV, s.ne_m3, s.Iis_A, s.Ies_A]
        .map((x) => el("td", { text: typeof x === "string" ? x : fmtG(x) }))));
      teWarningLine.textContent = IV.ui.teWarning(s.Te_eV, t.Te_OML_eV, t.Te_planar_eV);
      vpWarningLine.textContent = vc.text;
      vpWarningLine.classList.toggle("fair", vc.level === "ok");
      drawOverview();
    }

    function drawOverview() {
      if (!s.Ie || !Number.isFinite(s.Te_eV)) {
        overview.render({ traces: [], text: analysable.value ? "Finish the analysis to see the overview" : "Marked as not analysable" });
        return;
      }
      const xs = [], ys = [];
      for (let k = 0; k < n; k++) if (s.Ie[k] > 0) { xs.push(v[k]); ys.push(Math.log(s.Ie[k])); }
      const traces = [{ x: xs, y: ys, name: "ln(Ie)" }];
      if (s.transCoeff) traces.push({ x: xfit, y: N.polyval(s.transCoeff, xfit), name: `transition fit (Te = ${fmtG(s.Te_eV, 3)} eV)`, width: 2, dash: "dash" });
      if (s.satCoeff) traces.push({ x: xfit, y: N.polyval(s.satCoeff, xfit), name: "saturation fit", width: 2, dash: "dash" });
      const lo = N.nanmin(ys), hi = N.nanmax(ys), pad = 0.08 * (hi - lo || 1);
      overview.render({
        title: "Overview: ln(Ie) and fits", xlabel: "Potential (V)", ylabel: "ln(Ie [A])", traces,
        yrange: ys.length ? [lo - pad, hi + pad] : undefined,
        shades: [{ x0: lf.tmin.value, x1: lf.tmax.value }, { x0: lf.smin.value, x1: lf.smax.value }],
        vlines: [{ x: s.Vf, label: "Vf", dash: "dot" }, { x: s.Vp, label: "Vp", dash: "solid" }],
      });
    }

    function sendResults() {
      onResults({
        method: "Manual OML",
        Vp: s.Vp, Vf: s.Vf, Te_eV: s.Te_eV, ne_m3: s.ne_m3, Iis_A: s.Iis_A, Ies_A: s.Ies_A,
        ion_i2_a: s.ionCoeff ? s.ionCoeff[0] : NaN,
        ion_i2_b: s.ionCoeff ? s.ionCoeff[1] : NaN,
        Vp_dIdV: s.Vp1, Vp_intersection: s.Vp2,
        params: getParams(),
      });
      d.close();
    }

    // ----- remember / replay settings ----------------------------------------
    function getParams() {
      return {
        reached: s.reached,
        smooth: { method: smoothMethod.value, window: smoothWindow.value, order: smoothOrder.value },
        analysable: analysable.value,
        ion: { vf: ion.vf.value, vmin: ion.vmin.value, vmax: ion.vmax.value },
        didv: { method: dMethod.value, window: dWindow.value, order: dOrder.value },
        vp1: s.Vp1,
        log: { tmin: lf.tmin.value, tmax: lf.tmax.value, smin: lf.smin.value, smax: lf.smax.value, vp2: lf.vp2.value },
      };
    }

    /** Replays the saved steps; stops where the saved analysis stopped (or where a step fails). */
    function restore(p) {
      startOver.classList.remove("hidden");
      smoothMethod.set(p.smooth.method);
      smoothWindow.set(p.smooth.window);
      smoothOrder.set(p.smooth.order);
      analysable.set(p.analysable !== false);
      updateSmoothIV();
      s.reached = p.reached || 0;
      if (s.reached < 1) return tabs.select(0);
      if (p.analysable === false) return nextFromSmooth();

      ion.vf.set(p.ion.vf); ion.vmin.set(p.ion.vmin); ion.vmax.set(p.ion.vmax);
      updateIonFit();
      if (s.reached < 2 || !s.ionCoeff) return tabs.select(1);

      electronCurrent();
      dMethod.set(p.didv.method); dWindow.set(p.didv.window); dOrder.set(p.didv.order);
      if (s.reached >= 3 && Number.isFinite(p.vp1)) { s.Vp1 = p.vp1; vp.vp1.set(p.vp1); }
      updateDidvSmooth();
      if (s.reached < 3) return tabs.select(2);

      updateVpPlot();
      if (s.reached < 4) return tabs.select(3);

      lf.tmin.set(p.log.tmin); lf.tmax.set(p.log.tmax); lf.smin.set(p.log.smin); lf.smax.set(p.log.smax);
      lf.vp2.set(p.log.vp2);
      updateLogFitPreserveVp2();
      if (s.reached < 5) return tabs.select(4);
      finishAnalysis();
    }

    function resetAll() {
      Object.assign(s, { Vp1: NaN, Vp2: NaN, Vp: NaN, Te_eV: NaN, ne_m3: NaN, Iis_A: NaN, Ies_A: NaN,
        ionCoeff: null, Iion: null, Ie: null, dIdV: null, dIdVsmooth: null, transCoeff: null, satCoeff: null, reached: 0 });
      smoothMethod.set(SMOOTH_METHODS[0]); smoothWindow.set(startWin); smoothOrder.set(2); analysable.set(true);
      dMethod.set(SMOOTH_METHODS[0]); dWindow.set(startWin); dOrder.set(2);
      startOver.classList.add("hidden");
      updateResultsTable();
      tabs.select(0);
      updateSmoothIV();
    }

    updateResultsTable();
    if (params) {
      try { restore(params); } catch (_) { resetAll(); }
    } else {
      tabs.select(0);
      updateSmoothIV();
    }
  }

  IV.openManualOML = openManualOML;
})(window.IV = window.IV || {});
