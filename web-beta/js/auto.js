/* =============================================================================
   Automatic fit-region proposal and quality check (beta, "Level 1").

   - runOMLSteps(): the manual OML analysis without its window: the same
     smoothing, ion fit, dIe/dV, log(Ie) fits and final formulas, driven by a
     params object in the format the manual window saves (results.params).
   - proposeOML(): chooses those params automatically the way one does by eye:
     the straightest stretch of ln(Ie) between Vf and Vp for Te, a saturation
     window above Vp, and an ion region that stays a few Te below Vf.
   - qualityFlags(): plain-language reasons why a curve should be looked at.

   Every proposal is meant to be reviewed in the manual window; nothing here
   replaces that review. Pure functions (no DOM), so it also runs under Node.
   ============================================================================= */
(function (root) {
  "use strict";
  const N = (root.IV && root.IV.num) || (typeof require !== "undefined" ? require("./numerics.js") : null);

  const DEFAULT_METHOD = "Moving average";

  /** R² of a straight-line fit. */
  function rSquared(x, y, coeff) {
    let mean = 0;
    for (const v of y) mean += v;
    mean /= y.length;
    let ssRes = 0, ssTot = 0;
    for (let k = 0; k < y.length; k++) {
      ssRes += (y[k] - (coeff[0] * x[k] + coeff[1])) ** 2;
      ssTot += (y[k] - mean) ** 2;
    }
    return ssTot > 0 ? 1 - ssRes / ssTot : 1;
  }

  /** Points of ln(Ie) (Ie > 0) inside [lo, hi]. */
  function logWindow(v, Ie, lo, hi) {
    const xs = [], ys = [];
    for (let k = 0; k < v.length; k++) {
      if (v[k] >= lo && v[k] <= hi && Ie[k] > 0) { xs.push(v[k]); ys.push(Math.log(Ie[k])); }
    }
    return { xs, ys };
  }

  /**
   * The manual OML analysis for given params (same order and formulas as the
   * manual window). Returns results in the format the manual window sends,
   * plus diagnostics used by the quality check. Throws if a step fails.
   */
  function runOMLSteps(V, I, probeArea, p) {
    const { V: v, I: cur } = N.sortedCurve(V, I);
    const n = v.length;
    const vMin = N.nanmin(v), vMax = N.nanmax(v);
    const nan = { Vp: NaN, Vf: NaN, Te_eV: NaN, ne_m3: NaN, Iis_A: NaN, Ies_A: NaN, ion_i2_a: NaN, ion_i2_b: NaN, Vp_dIdV: NaN, Vp_intersection: NaN };
    if (p.analysable === false) return { method: "Manual OML", ...nan, params: p, diag: { analysable: false } };

    const Ismooth = N.smoothSignal(cur, p.smooth.method, N.makeOdd(p.smooth.window), p.smooth.order);
    const Vf = p.ion.vf;

    // ion fit: I_i^2 = aV + b in the ion region, signed sqrt reconstruction
    const lo = Math.min(p.ion.vmin, p.ion.vmax), hi = Math.max(p.ion.vmin, p.ion.vmax);
    const xi = [], yi = [], is = [];
    for (let k = 0; k < n; k++) {
      if (v[k] >= lo && v[k] <= hi && Number.isFinite(Ismooth[k])) { xi.push(v[k]); is.push(Ismooth[k]); yi.push(Ismooth[k] ** 2); }
    }
    if (xi.length < 2) throw new Error("Not enough points in the ion fit region.");
    let signI = N.sign(N.nanmedian(is));
    if (signI === 0) signI = -1;
    const ionCoeff = N.polyfit(xi, yi, 1);
    const Iion = Float64Array.from(v, (x) => signI * Math.sqrt(Math.max(N.polyval(ionCoeff, x), 0)));
    const Iis = N.ionCurrentAt(Vf, ionCoeff[0], ionCoeff[1], signI);

    const Ie = Float64Array.from(Ismooth, (x, k) => x - Iion[k]);
    const dIdV = N.gradient(Ie, v);
    const dIdVs = N.smoothSignal(dIdV, p.didv.method, N.makeOdd(p.didv.window), p.didv.order);
    const Vp1 = p.vp1;

    const trans = N.fitLineRegion(v, Ie, p.log.tmin, p.log.tmax, true, true);
    let sat = null;
    try { sat = N.fitLineRegion(v, Ie, p.log.smin, p.log.smax, true, true); } catch (_) { /* reported below */ }
    const Vp2 = p.log.vp2;

    const slope = trans[0];
    if (!(slope > 0)) throw new Error("The transition fit slope is not positive (Te = 1/slope).");
    const Te = 1 / slope;
    let Vp;
    if (Number.isFinite(Vp1) && Number.isFinite(Vp2)) Vp = 0.5 * (Vp1 + Vp2);
    else Vp = Number.isFinite(Vp1) ? Vp1 : Vp2;
    const Ies = Number.isFinite(Vp) ? N.interp(Vp, v, Ie) : NaN;
    const ne = Ies > 0 && probeArea > 0
      ? (Ies / (N.E_CHARGE * probeArea)) * Math.sqrt((2 * Math.PI * N.M_E) / (Te * N.E_CHARGE)) : NaN;

    const tw = logWindow(v, Ie, p.log.tmin, p.log.tmax);
    const sw = logWindow(v, Ie, p.log.smin, p.log.smax);
    const diag = {
      analysable: true,
      vMin, vMax,
      r2Ion: rSquared(xi, yi, ionCoeff),
      r2Trans: rSquared(tw.xs, tw.ys, trans),
      nTrans: tw.xs.length,
      r2Sat: sat ? rSquared(sw.xs, sw.ys, sat) : NaN,
      nSat: sw.xs.length,
      satSlope: sat ? sat[0] : NaN,
      transSlope: slope,
      dIdVpeak: N.nanmax(dIdVs),
    };
    return {
      method: "Manual OML",
      Vp, Vf, Te_eV: Te, ne_m3: ne, Iis_A: Iis, Ies_A: Ies,
      ion_i2_a: ionCoeff[0], ion_i2_b: ionCoeff[1],
      Vp_dIdV: Vp1, Vp_intersection: Vp2,
      params: p,
      diag,
    };
  }

  /** Most linear stretch of ln(Ie) in [a, b]: maximises R², slightly favouring longer windows. */
  function straightestWindow(v, Ie, a, b, { edges = 24, minFrac = 0.25, minPts = 8 } = {}) {
    const grid = N.linspace(a, b, edges);
    let best = null;
    for (let i = 0; i < edges - 1; i++) {
      for (let j = i + 1; j < edges; j++) {
        if (grid[j] - grid[i] < minFrac * (b - a)) continue;
        const w = logWindow(v, Ie, grid[i], grid[j]);
        if (w.xs.length < minPts) continue;
        const c = N.polyfit(w.xs, w.ys, 1);
        if (!(c[0] > 0)) continue;
        const score = rSquared(w.xs, w.ys, c) + 0.002 * ((grid[j] - grid[i]) / (b - a));
        if (!best || score > best.score) best = { lo: grid[i], hi: grid[j], score, slope: c[0] };
      }
    }
    return best;
  }

  /**
   * Proposes manual-OML params for one curve and runs them.
   * Returns { params, results } (results include .diag) or throws.
   */
  function proposeOML(V, I, probeArea) {
    const { V: v, I: cur } = N.sortedCurve(V, I);
    const n = v.length;
    const vMin = N.nanmin(v), vMax = N.nanmax(v), span = vMax - vMin;
    const win = N.makeOdd(Math.min(21, Math.max(3, Math.floor(n / 10))));
    const smooth = { method: DEFAULT_METHOD, window: win, order: 2 };
    const Ismooth = N.smoothSignal(cur, smooth.method, win, 2);

    // floating potential: zero crossing of the smoothed curve (as in the manual window)
    let Vf = N.finiteCrossingX(v, Ismooth);
    if (!Number.isFinite(Vf)) {
      let best = 0;
      for (let k = 1; k < n; k++) if (Math.abs(Ismooth[k]) < Math.abs(Ismooth[best])) best = k;
      Vf = v[best];
    }
    const vmin0 = v[Math.min(5, n - 1)];
    let ionMax = Math.min(Vf, vmin0 + 0.25 * (vMax - vmin0));
    if (ionMax <= vmin0) ionMax = vmin0 + 0.1 * (vMax - vmin0);

    const build = (ionHi) => {
      // dIe/dV peak (same margin rule as the manual window)
      const p0 = { smooth, analysable: true, ion: { vf: Vf, vmin: vmin0, vmax: ionHi } };
      const lo = Math.min(vmin0, ionHi), hi = Math.max(vmin0, ionHi);
      const xi = [], yi = [], is = [];
      for (let k = 0; k < n; k++) if (v[k] >= lo && v[k] <= hi) { xi.push(v[k]); is.push(Ismooth[k]); yi.push(Ismooth[k] ** 2); }
      let signI = N.sign(N.nanmedian(is));
      if (signI === 0) signI = -1;
      const c = N.polyfit(xi, yi, 1);
      const Ie = Float64Array.from(Ismooth, (x, k) => x - signI * Math.sqrt(Math.max(N.polyval(c, v[k]), 0)));
      const dIdVs = N.smoothSignal(N.gradient(Ie, v), smooth.method, win, 2);
      const margin = n > 10 ? 5 : 0;
      const Vp1 = v[N.nanargmax(dIdVs.slice(margin, n - margin)) + margin];
      if (!(Vp1 > Vf)) throw new Error("The dIe/dV peak is not above the floating potential.");

      // transition: straightest ln(Ie) stretch between Vf and Vp
      const tr = straightestWindow(v, Ie, Vf, Vp1 - 0.02 * (Vp1 - Vf));
      if (!tr) throw new Error("No straight ln(Ie) region found between Vf and Vp.");
      const Te0 = 1 / tr.slope;

      // saturation: a window starting a little above Vp
      let smin = Vp1 + Math.max(0.05 * span, 2 * Te0);
      let smax = Math.min(vMax, smin + 0.25 * span);
      if (logWindow(v, Ie, smin, smax).xs.length < 5) {
        smin = Vp1 + 0.02 * span;
        smax = vMax;
      }
      const tw = logWindow(v, Ie, tr.lo, tr.hi);
      const trans = N.polyfit(tw.xs, tw.ys, 1);
      let vp2 = NaN;
      try {
        const sat = N.fitLineRegion(v, Ie, smin, smax, true, true);
        // intersection as in the manual window: closest approach on a 1000-point grid
        const xfit = N.linspace(vMin, vMax, 1000);
        let best = 0, bestD = Infinity;
        for (let k = 0; k < xfit.length; k++) {
          const dd = Math.abs(N.polyval(sat, xfit[k]) - N.polyval(trans, xfit[k]));
          if (dd < bestD) { bestD = dd; best = k; }
        }
        vp2 = xfit[best];
      } catch (_) { /* no saturation region: Vp from dI/dV only */ }

      return {
        ...p0,
        reached: 5,
        didv: { method: smooth.method, window: win, order: 2 },
        vp1: Vp1,
        log: { tmin: tr.lo, tmax: tr.hi, smin, smax, vp2 },
        _Te0: Te0,
      };
    };

    // pass 1 with the default ion region; pass 2 keeps the ion fit ~3 Te below Vf
    let p = build(ionMax);
    const refined = Math.max(vmin0 + 0.1 * (Vf - vmin0), Math.min(Vf, Vf - 3 * p._Te0));
    if (refined > vmin0 && Math.abs(refined - ionMax) > 1e-9) {
      try { p = build(refined); } catch (_) { /* keep pass 1 */ }
    }
    delete p._Te0;
    return { params: p, results: runOMLSteps(V, I, probeArea, p) };
  }

  /**
   * Reasons to look at a curve. r: results with .diag; extra: {ni_m3, Te_VpVf_OML_eV, Te_VpVf_planar_eV}.
   * Thresholds are deliberately simple (beta) and listed here so they can be tuned.
   */
  // Vp agreement (dI/dV vs intersection) uses N.VP_AGREEMENT: flagged above 10 %.
  const LIMITS = { r2Trans: 0.995, r2Ion: 0.9, minSatPts: 5, edgeFrac: 0.03, teMin: 0.2, teMax: 30, niRatio: [0.2, 5] };

  function qualityFlags(r, extra = {}) {
    const d = r.diag || {};
    if (d.analysable === false) return [];
    const f = [];
    if (d.r2Trans < LIMITS.r2Trans) f.push(`Transition region not straight on ln(Ie) (R² = ${d.r2Trans.toFixed(4)})`);
    if (d.r2Ion < LIMITS.r2Ion) f.push(`Ion fit of I² is poor (R² = ${d.r2Ion.toFixed(3)})`);
    if (!(d.nSat >= LIMITS.minSatPts)) f.push("No usable electron-saturation region above Vp");
    else if (d.satSlope >= d.transSlope) f.push("No clear knee: saturation is as steep as the transition");
    if (Number.isFinite(d.vMax) && r.Vp_dIdV > d.vMax - LIMITS.edgeFrac * (d.vMax - d.vMin)) f.push("Vp is at the end of the sweep");
    if (!(r.Te_eV >= LIMITS.teMin && r.Te_eV <= LIMITS.teMax)) f.push(`Te = ${r.Te_eV.toFixed(2)} eV is outside ${LIMITS.teMin}–${LIMITS.teMax} eV`);
    const va = N.vpAgreement(r.Vp_dIdV, r.Vp_intersection);
    if (va.checked && va.level === "poor") {
      f.push(`Vp from dI/dV and from the fit intersection differ by ${va.pct.toFixed(1)} % (more than ${N.VP_AGREEMENT.fair} %)`);
    }
    const c = N.teConsistency(r.Te_eV, extra.Te_VpVf_OML_eV, extra.Te_VpVf_planar_eV);
    if (c.checked && !c.ok) f.push("Te differs by more than 30 % from Te from Vp − Vf");
    const ratio = extra.ni_m3 / r.ne_m3;
    if (Number.isFinite(ratio) && (ratio < LIMITS.niRatio[0] || ratio > LIMITS.niRatio[1])) f.push(`ni / ne = ${ratio.toFixed(2)} is far from 1`);
    return f;
  }

  const api = { rSquared, runOMLSteps, straightestWindow, proposeOML, qualityFlags, LIMITS };
  if (root.IV) root.IV.auto = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
