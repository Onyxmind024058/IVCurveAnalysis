/* =============================================================================
   Langmuir Probe IV Analyser UB — numerical core (browser port of main.py)

   Pure functions only: no DOM access, so this file also loads under Node for
   testing against the Python implementation. Formulas intentionally mirror
   main.py one-to-one so both versions give the same numbers.
   ============================================================================= */
(function (root) {
  "use strict";

  const E_CHARGE = 1.602176634e-19;
  const M_E = 9.10938356e-31;
  const AMU = 1.66053906660e-27;

  /** Singly charged ions; mass in amu. */
  const ION_SPECIES = {
    "Ar⁺": 39.948, "He⁺": 4.0026, "Ne⁺": 20.180, "Kr⁺": 83.798, "Xe⁺": 131.29,
    "H⁺": 1.0073, "H₂⁺": 2.0157, "H₃⁺": 3.0235, "N₂⁺": 28.014, "O₂⁺": 31.998,
  };

  // ---------------------------------------------------------------------------
  // Small array helpers (numpy equivalents)
  // ---------------------------------------------------------------------------

  const toF64 = (a) => Float64Array.from(a, Number);

  function argsort(a) {
    const idx = Array.from(a, (_, k) => k);
    idx.sort((i, j) => a[i] - a[j] || i - j);
    return idx;
  }

  const take = (a, idx) => Float64Array.from(idx, (k) => a[k]);
  const sign = (v) => (v > 0 ? 1 : v < 0 ? -1 : v === 0 ? 0 : NaN);

  function min(a) { let m = Infinity; for (const v of a) if (v < m) m = v; return m; }
  function max(a) { let m = -Infinity; for (const v of a) if (v > m) m = v; return m; }
  function nanmin(a) { let m = Infinity; for (const v of a) if (Number.isFinite(v) && v < m) m = v; return m === Infinity ? NaN : m; }
  function nanmax(a) { let m = -Infinity; for (const v of a) if (Number.isFinite(v) && v > m) m = v; return m === -Infinity ? NaN : m; }

  function argmax(a) {
    // np.argmax: first index of the maximum; NaN wins if present.
    let best = 0;
    for (let k = 0; k < a.length; k++) {
      if (Number.isNaN(a[k])) return k;
      if (a[k] > a[best]) best = k;
    }
    return best;
  }

  function nanargmax(a) {
    let best = -1;
    for (let k = 0; k < a.length; k++) {
      if (Number.isNaN(a[k])) continue;
      if (best < 0 || a[k] > a[best]) best = k;
    }
    if (best < 0) throw new Error("All-NaN slice encountered");
    return best;
  }

  function nanmedian(a) {
    const v = Array.from(a).filter((x) => !Number.isNaN(x)).sort((p, q) => p - q);
    if (!v.length) return NaN;
    const m = v.length >> 1;
    return v.length % 2 ? v[m] : 0.5 * (v[m - 1] + v[m]);
  }

  function nanmean(a) {
    let s = 0, n = 0;
    for (const v of a) if (!Number.isNaN(v)) { s += v; n++; }
    return n ? s / n : NaN;
  }

  function linspace(a, b, n) {
    const out = new Float64Array(n);
    if (n === 1) { out[0] = a; return out; }
    const step = (b - a) / (n - 1);
    for (let k = 0; k < n; k++) out[k] = a + k * step;
    out[n - 1] = b;
    return out;
  }

  /** np.interp for scalar or array xq; xp must be increasing. */
  function interp(xq, xp, fp) {
    const one = (x) => {
      const n = xp.length;
      if (Number.isNaN(x)) return NaN;
      if (x <= xp[0]) return fp[0];
      if (x >= xp[n - 1]) return fp[n - 1];
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (xp[mid] <= x) lo = mid; else hi = mid;
      }
      const dx = xp[hi] - xp[lo];
      if (dx === 0) return fp[hi];
      return fp[lo] + (fp[hi] - fp[lo]) * (x - xp[lo]) / dx;
    };
    if (typeof xq === "number") return one(xq);
    return Float64Array.from(xq, one);
  }

  /** np.gradient(y, x): second-order interior, first-order edges. */
  function gradient(y, x) {
    const n = y.length;
    const g = new Float64Array(n);
    if (n < 2) return g;
    g[0] = (y[1] - y[0]) / (x[1] - x[0]);
    g[n - 1] = (y[n - 1] - y[n - 2]) / (x[n - 1] - x[n - 2]);
    for (let i = 1; i < n - 1; i++) {
      const d1 = x[i] - x[i - 1];
      const d2 = x[i + 1] - x[i];
      const a = -d2 / (d1 * (d1 + d2));
      const b = (d2 - d1) / (d1 * d2);
      const c = d1 / (d2 * (d1 + d2));
      g[i] = a * y[i - 1] + b * y[i] + c * y[i + 1];
    }
    return g;
  }

  // ---------------------------------------------------------------------------
  // Least squares / polynomial fits
  // ---------------------------------------------------------------------------

  /** Solve min ||A c - b|| with Householder QR. A is an array of rows. */
  function lstsq(A, b) {
    const m = A.length, n = A[0].length;
    const R = A.map((row) => Float64Array.from(row));
    const y = Float64Array.from(b);
    for (let k = 0; k < n; k++) {
      let norm = 0;
      for (let i = k; i < m; i++) norm += R[i][k] * R[i][k];
      norm = Math.sqrt(norm);
      if (norm === 0) continue;
      const alpha = R[k][k] > 0 ? -norm : norm;
      const v = new Float64Array(m);
      v[k] = R[k][k] - alpha;
      for (let i = k + 1; i < m; i++) v[i] = R[i][k];
      let vnorm2 = 0;
      for (let i = k; i < m; i++) vnorm2 += v[i] * v[i];
      if (vnorm2 === 0) continue;
      for (let j = k; j < n; j++) {
        let s = 0;
        for (let i = k; i < m; i++) s += v[i] * R[i][j];
        s = (2 * s) / vnorm2;
        for (let i = k; i < m; i++) R[i][j] -= s * v[i];
      }
      let s = 0;
      for (let i = k; i < m; i++) s += v[i] * y[i];
      s = (2 * s) / vnorm2;
      for (let i = k; i < m; i++) y[i] -= s * v[i];
    }
    const c = new Float64Array(n);
    for (let k = n - 1; k >= 0; k--) {
      let s = y[k];
      for (let j = k + 1; j < n; j++) s -= R[k][j] * c[j];
      c[k] = R[k][k] !== 0 ? s / R[k][k] : 0;
    }
    return c;
  }

  /** np.polyfit: coefficients, highest power first. */
  function polyfit(x, y, deg) {
    const m = x.length;
    if (m <= deg) throw new Error("Not enough points for polynomial fit.");
    // Scale x like numpy does internally, for conditioning.
    let scale = 0;
    for (const v of x) scale = Math.max(scale, Math.abs(v));
    if (scale === 0) scale = 1;
    const A = new Array(m);
    for (let i = 0; i < m; i++) {
      const row = new Float64Array(deg + 1);
      const xs = x[i] / scale;
      for (let j = 0; j <= deg; j++) row[j] = Math.pow(xs, deg - j);
      A[i] = row;
    }
    const c = lstsq(A, y);
    for (let j = 0; j <= deg; j++) c[j] /= Math.pow(scale, deg - j);
    return c;
  }

  function polyval(c, x) {
    const one = (v) => { let s = 0; for (const ck of c) s = s * v + ck; return s; };
    if (typeof x === "number") return one(x);
    return Float64Array.from(x, one);
  }

  // ---------------------------------------------------------------------------
  // Smoothing
  // ---------------------------------------------------------------------------

  function makeOdd(n, minimum = 3) {
    n = Math.round(n);
    n = Math.max(minimum, n);
    if (n % 2 === 0) n += 1;
    return n;
  }

  /** Edge-padded centred moving average (same as main.py moving_average). */
  function movingAverage(y, w) {
    w = makeOdd(w);
    const n = y.length;
    const pad = w >> 1;
    const at = (k) => y[Math.min(n - 1, Math.max(0, k))];
    const out = new Float64Array(n);
    let s = 0;
    for (let k = -pad; k <= pad; k++) s += at(k);
    for (let i = 0; i < n; i++) {
      out[i] = s / w;
      s += at(i + pad + 1) - at(i - pad);
    }
    return out;
  }

  /** Local polynomial smoother (SciPy-free Savitzky-Golay-like). */
  function polynomialSmooth(y, window = 13, order = 2) {
    window = makeOdd(window);
    order = Math.trunc(Math.max(1, Math.min(order, window - 1)));
    const half = window >> 1;
    const n = y.length;
    const out = new Float64Array(n);
    for (let idx = 0; idx < n; idx++) {
      const lo = Math.max(0, idx - half);
      const hi = Math.min(n, idx + half + 1);
      const xx = [], yy = [];
      for (let k = lo; k < hi; k++) { xx.push(k - idx); yy.push(y[k]); }
      const deg = Math.min(order, yy.length - 1);
      const c = polyfit(xx, yy, deg);
      out[idx] = c[c.length - 1];
    }
    return out;
  }

  function smoothSignal(y, method = "Moving average", window = 21, order = 2) {
    if (method === "Polynomial / SG-like") return polynomialSmooth(y, window, order);
    return movingAverage(y, window);
  }

  // ---------------------------------------------------------------------------
  // Data helpers
  // ---------------------------------------------------------------------------

  /** Sort by x and average points that share the same x (np.interp needs unique, increasing xp). */
  function uniqueSorted(x, y) {
    const order = argsort(x);
    const xs = [], ys = [];
    let k = 0;
    while (k < order.length) {
      const xv = x[order[k]];
      let s = 0, n = 0;
      while (k < order.length && x[order[k]] === xv) { s += y[order[k]]; n++; k++; }
      if (Number.isFinite(xv) && Number.isFinite(s)) { xs.push(xv); ys.push(s / n); }
    }
    return { x: Float64Array.from(xs), y: Float64Array.from(ys) };
  }

  /**
   * A scan recorded as a triangular sweep (up then down, or down then up)
   * is split into its two branches so they are not mixed point-by-point.
   * Only one clear turning point is handled; noisy voltage read-back is
   * not mistaken for a turn because both branches must span >= 50 % of
   * the range and hold >= 20 % of the points.
   */
  function splitSweeps(scans, xkey) {
    const out = [];
    for (const s of scans) {
      const x = s[xkey], n = x.length;
      const label = s.label || `scan ${s.id}`;
      const lo = min(x), hi = max(x), span = hi - lo;
      let turn = -1;
      for (const k of [argmax(x), argmax(x.map((v) => -v))]) {
        const a = x.slice(0, k + 1), b = x.slice(k);
        const ok = k >= 0.2 * n && k <= 0.8 * n
          && max(a) - min(a) >= 0.5 * span && max(b) - min(b) >= 0.5 * span;
        if (ok) { turn = k; break; }
      }
      if (turn < 0) { out.push({ ...s, label }); continue; }
      const part = (a, b) => ({ VData: s.VData.slice(a, b), RefData: s.RefData.slice(a, b), IData: s.IData.slice(a, b) });
      const dir = (seg) => (seg[seg.length - 1] > seg[0] ? "up" : "down");
      out.push({ ...s, ...part(0, turn + 1), label: `${label} ${dir(x.slice(0, turn + 1))}` });
      out.push({ ...s, ...part(turn, n), label: `${label} ${dir(x.slice(turn))}` });
    }
    return out;
  }

  /** Data-range reduction per scan: drop the first/last N acquired points, then keep from <= x <= to. */
  function cropScans(raw, crop, xkey) {
    return raw.map((s) => {
      const n = s.IData.length;
      const keep = [];
      for (let k = crop.skipStart; k < n - crop.skipEnd; k++) {
        const x = s[xkey][k];
        if (!(x < crop.from) && !(x > crop.to)) keep.push(k);
      }
      const pick = (a) => Float64Array.from(keep, (k) => a[k]);
      return { ...s, VData: pick(s.VData), RefData: pick(s.RefData), IData: pick(s.IData) };
    });
  }

  /** Mean curve of raw scans for given settings (x axis, data range) — what the app analyses. */
  function curveWith(raw, xkey, crop) {
    const scans = crop && crop.enabled ? cropScans(raw, crop, xkey) : raw;
    if (Math.min(...scans.map((s) => s.IData.length)) < 10) throw new Error("The data range leaves fewer than 10 points.");
    const avg = averageScans(splitSweeps(scans, xkey), xkey);
    return { xkey, x: avg.x, imean: avg.imean };
  }

  /**
   * Average scans on a common, evenly spaced grid covering the voltage range
   * shared by all scans (no extrapolation; smoothing and derivatives assume
   * even spacing).
   */
  function averageScans(scans, xkey) {
    const curves = scans.map((s) => uniqueSorted(s[xkey], s.IData));
    const lo = Math.max(...curves.map((c) => c.x[0]));
    const hi = Math.min(...curves.map((c) => c.x[c.x.length - 1]));
    if (!(hi > lo)) throw new Error("The scans do not share a common voltage range.");
    const npts = Math.max(10, ...curves.map((c) => c.x.length));
    const xgrid = linspace(lo, hi, npts);
    const currents = curves.map((c) => interp(xgrid, c.x, c.y));
    const n = xgrid.length, m = currents.length;
    const imean = new Float64Array(n), istd = new Float64Array(n);
    for (let k = 0; k < n; k++) {
      let s = 0;
      for (const c of currents) s += c[k];
      imean[k] = s / m;
      if (m >= 2) {
        let v = 0;
        for (const c of currents) v += (c[k] - imean[k]) ** 2;
        istd[k] = Math.sqrt(v / (m - 1));
      }
    }
    return { x: xgrid, imean, istd, currents };
  }

  function finiteCrossingX(x, y) {
    for (let k = 0; k < y.length - 1; k++) {
      if (sign(y[k + 1]) !== sign(y[k])) {
        if (y[k + 1] === y[k]) return x[k];
        return x[k] - (y[k] * (x[k + 1] - x[k])) / (y[k + 1] - y[k]);
      }
    }
    return NaN;
  }

  function fitLineRegion(x, y, vmin, vmax, requirePositive = false, logY = false) {
    const lo = Math.min(vmin, vmax), hi = Math.max(vmin, vmax);
    const xs = [], ys = [];
    for (let k = 0; k < x.length; k++) {
      const ok = x[k] >= lo && x[k] <= hi && Number.isFinite(x[k]) && Number.isFinite(y[k])
        && (!requirePositive || y[k] > 0);
      if (ok) { xs.push(x[k]); ys.push(logY ? Math.log(y[k]) : y[k]); }
    }
    if (xs.length < 2) throw new Error("Not enough points in selected fit region.");
    return polyfit(xs, ys, 1);
  }

  function sortedCurve(V, I) {
    const order = argsort(V);
    return { V: take(V, order), I: take(I, order) };
  }

  /** Ion current from the I_i^2 = aV + b fit, evaluated at V (used at Vf for Iis). */
  function ionCurrentAt(V, a, b, signI) {
    if (!Number.isFinite(V)) return NaN;
    return signI * Math.sqrt(Math.max(a * V + b, 0));
  }

  /**
   * Ion density from the OML ion current of a cylindrical probe (Chen 2001):
   *   I_i = A n_i e (sqrt(2)/pi) sqrt(e (Vp - V) / m_i)
   *   =>  I_i^2 = a V + b  with  |a| = 2 A^2 n_i^2 e^3 / (pi^2 m_i)
   *   =>  n_i = (pi / (A e)) sqrt(m_i |a| / (2 e))
   * a is the slope of the I^2(V) fit (A^2/V); it must be negative.
   */
  function ionDensityOML(a, probeArea, massAmu) {
    if (!(a < 0) || !(probeArea > 0) || !(massAmu > 0)) return NaN;
    const mi = massAmu * AMU;
    return (Math.PI / (probeArea * E_CHARGE)) * Math.sqrt((mi * Math.abs(a)) / (2 * E_CHARGE));
  }

  /**
   * Te from the potential difference Vp - Vf (Maxwellian electrons, singly
   * charged ions). At Vf the ion and electron currents cancel; with
   * x = (Vp - Vf)/Te and mu = m_i/m_e:
   *   cylindrical OML (thick sheath, same ion model as the I^2 fit):
   *     (sqrt(2)/pi) sqrt(e dV/m_i) = sqrt(e Te/(2 pi m_e)) exp(-x)
   *     =>  exp(-x) = (2/sqrt(pi)) sqrt(x/mu)      (x ~ 4.7 for Ar)
   *   planar sheath with Bohm flux and 0.5 Te presheath (thin sheath):
   *     x = 1/2 + 1/2 ln(mu / (2 pi))                (x ~ 5.2 for Ar)
   * Returns the factors x and Te = dV / x for both; NaN if Vp <= Vf.
   */
  function teFromPotentials(Vp, Vf, massAmu) {
    const mu = (massAmu * AMU) / M_E;
    const planar = 0.5 + 0.5 * Math.log(mu / (2 * Math.PI));
    // solve x + ln(2/sqrt(pi)) + 0.5 ln(x/mu) = 0 by Newton, starting from the planar value
    let x = planar;
    for (let k = 0; k < 50; k++) {
      const g = x + Math.log(2 / Math.sqrt(Math.PI)) + 0.5 * Math.log(x / mu);
      const step = g / (1 + 0.5 / x);
      x -= step;
      if (Math.abs(step) < 1e-12) break;
    }
    const dV = Vp - Vf;
    const ok = Number.isFinite(dV) && dV > 0 && massAmu > 0;
    return {
      factorOML: x, factorPlanar: planar,
      Te_OML_eV: ok ? dV / x : NaN,
      Te_planar_eV: ok ? dV / planar : NaN,
    };
  }

  /**
   * Cross-check of a fitted Te against the Vp - Vf estimates: the fitted value
   * should lie in [min(OML, planar) * (1 - limit), max(OML, planar) * (1 + limit)].
   */
  function teConsistency(teFit, teOML, tePlanar, limit = 0.3) {
    if (![teFit, teOML, tePlanar].every(Number.isFinite)) return { checked: false, ok: true };
    const lo = Math.min(teOML, tePlanar) * (1 - limit);
    const hi = Math.max(teOML, tePlanar) * (1 + limit);
    return { checked: true, ok: teFit >= lo && teFit <= hi, lo, hi, limit };
  }
  /**
   * Validation of a manual analysis: compare Vp from the dI/dV peak with Vp
   * from the intersection of the ln(Ie) fits, in volts.
   *   dVp <= 2 V      "good"
   *   2 V < dVp <= 5 V  "ok" if Te from Vp - Vf confirms the fitted Te
   *                    (teConsistency), else "review"
   *   dVp > 5 V       "review" (check the curve by eye)
   */
  const VP_CHECK = { goodV: 2, okV: 5 };
  function vpCheck(vpDidv, vpIntersection, teFit, teOML, tePlanar) {
    if (!Number.isFinite(vpDidv) || !Number.isFinite(vpIntersection)) return { checked: false };
    const diff = Math.abs(vpDidv - vpIntersection);
    if (diff <= VP_CHECK.goodV) return { checked: true, diff, level: "good" };
    if (diff > VP_CHECK.okV) return { checked: true, diff, level: "review", reason: "large" };
    const te = teConsistency(teFit, teOML, tePlanar);
    if (!te.checked) return { checked: true, diff, level: "review", reason: "no-te-check" };
    return { checked: true, diff, level: te.ok ? "ok" : "review", reason: te.ok ? "te-confirms" : "te-mismatch" };
  }


  // ---------------------------------------------------------------------------
  // Automatic first-pass OML analysis
  // ---------------------------------------------------------------------------

  function analyseOML(xIn, iIn, probeArea, ionFraction = 0.2, smoothWindow = 21) {
    const { V: x, I: i } = sortedCurve(xIn, iIn);
    const n = x.length;

    const vf = finiteCrossingX(x, i);
    const ismooth = movingAverage(i, smoothWindow);
    const didv = gradient(ismooth, x);
    const vp = x[argmax(didv)];

    const nfit = Math.max(10, Math.trunc(n * ionFraction));

    // Linear fit of I_i^2(V), then signed sqrt reconstruction of I_i(V).
    let signI = sign(nanmedian(ismooth.slice(0, nfit)));
    if (signI === 0) signI = -1;
    const xi = x.slice(0, nfit);
    const i2 = Float64Array.from(ismooth.slice(0, nfit), (v) => v * v);
    const [a, b] = polyfit(xi, i2, 1);
    const iIon = Float64Array.from(x, (v) => signI * Math.sqrt(Math.max(a * v + b, 0)));
    const ie = Float64Array.from(ismooth, (v, k) => v - iIon[k]);

    const vmin = Number.isFinite(vf) ? vf : x[0];
    const vmax = vp - 0.2 * (vp - vmin);

    const fx = [], fy = [];
    for (let k = 0; k < n; k++) {
      if (x[k] >= vmin && x[k] <= vmax && ie[k] > 0) { fx.push(x[k]); fy.push(Math.log(ie[k])); }
    }
    if (fx.length < 10) throw new Error("Not enough points for ln(Ie) fit. Try manual mode.");
    const [m] = polyfit(fx, fy, 1);
    if (m <= 0) throw new Error("Bad ln(Ie) slope. Try manual mode.");

    const teEV = 1 / m;
    const ies = interp(vp, x, ie);
    const teJ = teEV * E_CHARGE;
    const ne = (ies / (E_CHARGE * probeArea)) * Math.sqrt((2 * Math.PI * M_E) / teJ);

    return {
      method: "Automatic OML",
      Vf: vf, Vp: vp, Te_eV: teEV, Ies_A: ies, ne_m3: ne,
      Iis_A: ionCurrentAt(vf, a, b, signI),
      ion_i2_a: a, ion_i2_b: b,
      x, I_raw: i, I_smooth: ismooth, Iion: iIon, Ie: ie,
    };
  }

  // ---------------------------------------------------------------------------
  // EEPF / EEDF (Druyvesteyn)
  //
  //   EEPF  g_p(eps) = 2*sqrt(2*m_e) / (e^3 * A) * d2Ie/dV2      [m^-3 J^-3/2]
  //   EEDF  g_e(eps) = g_p(eps) * sqrt(eps)                       [m^-3 J^-1]
  //   with eps = e * (Vp - V) and  n = integral g_e d(eps).
  //
  // Results are returned per eV (m^-3 eV^-3/2 and m^-3 eV^-1), the usual
  // plasma convention:  per eV = per J * e^(3/2)  (EEPF),  * e  (EEDF).
  // ---------------------------------------------------------------------------

  function trapz(y, x) {
    let s = 0;
    for (let k = 1; k < x.length; k++) s += 0.5 * (y[k] + y[k - 1]) * (x[k] - x[k - 1]);
    return s;
  }

  function computeEEPF(Vin, Iin, probeArea, oml, smoothWindow = 21, eMinEV = 0, distSmoothWindow = 9) {
    const { V, I } = sortedCurve(Vin, Iin);
    const Vp = Number(oml.Vp);
    if (!Number.isFinite(Vp)) throw new Error("A valid Vp is required before calculating EEPF/EEDF.");

    let Ie;
    if (oml.Ie && oml.x) {
      // Results carry their own (sorted) voltage grid; map onto V.
      Ie = interp(V, oml.x, oml.Ie);
    } else {
      const Ismooth = movingAverage(I, smoothWindow);
      let Iion;
      if (oml.Iion && oml.x) {
        Iion = interp(V, oml.x, oml.Iion);
      } else if (Number.isFinite(oml.ion_i2_a) && Number.isFinite(oml.ion_i2_b)) {
        // ion current is negative by convention
        Iion = Float64Array.from(V, (v) => ionCurrentAt(v, oml.ion_i2_a, oml.ion_i2_b, -1));
      } else {
        throw new Error("Ion-current fit is missing. Run automatic or manual OML first.");
      }
      Ie = Float64Array.from(Ismooth, (v, k) => v - Iion[k]);
    }

    const IeSmooth = movingAverage(Ie, smoothWindow);
    const d1 = gradient(IeSmooth, V);
    const d2 = gradient(d1, V);

    const k = (2 * Math.sqrt(2 * M_E)) / (E_CHARGE ** 3 * probeArea);
    const toEEPFperEV = E_CHARGE ** 1.5, toEEDFperEV = E_CHARGE;
    const rows = [];
    for (let j = 0; j < V.length; j++) {
      const E = Vp - V[j];                       // energy in eV
      if (!Number.isFinite(E) || E < eMinEV || E < 0) continue;
      const eepfJ = k * d2[j];                   // m^-3 J^-3/2
      const eedfJ = eepfJ * Math.sqrt(E * E_CHARGE);  // m^-3 J^-1
      if (Number.isFinite(eepfJ)) rows.push([E, eedfJ * toEEDFperEV, eepfJ * toEEPFperEV]);
    }
    rows.sort((p, q) => p[0] - q[0]);
    const E = Float64Array.from(rows, (r) => r[0]);
    const EEDF = Float64Array.from(rows, (r) => r[1]);
    const EEPF = Float64Array.from(rows, (r) => r[2]);
    // smooth first, then drop the non-physical negative part
    const smoothClip = (a) => (a.length ? movingAverage(a, distSmoothWindow).map((v) => Math.max(v, 0)) : a);
    const EEDF_smooth = smoothClip(EEDF), EEPF_smooth = smoothClip(EEPF);

    // density from the smoothed EEDF (consistency check against OML ne)
    const nEEDF = trapz(EEDF_smooth, E);

    return {
      E_eV: E, EEDF, EEPF, EEDF_smooth, EEPF_smooth,
      n_EEDF_m3: nEEDF,
      V, I, Ie, Ie_smooth: IeSmooth, d2Ie_dV2: d2, Vp,
    };
  }

  // ---------------------------------------------------------------------------
  // EPFL two-fluid model
  // ---------------------------------------------------------------------------

  function rebinCurve(Vin, Iin, npt = 1000) {
    const { V, I } = sortedCurve(Vin, Iin);
    const vmin = nanmin(V), vmax = nanmax(V);
    if (!(vmax > vmin)) throw new Error("Invalid voltage range for EPFL two-fluid analysis.");
    const bins = linspace(vmin, vmax, Math.trunc(npt) + 1);
    const sums = new Float64Array(npt), counts = new Int32Array(npt);
    for (let j = 0; j < V.length; j++) {
      // np.digitize(V, bins) - 1  ==  (number of bin edges <= v) - 1
      let lo = 0, hi = bins.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (bins[mid] <= V[j]) lo = mid + 1; else hi = mid; }
      const k = Math.min(lo - 1, npt - 1);  // the last edge (v == vmax) belongs to the last bin
      if (k >= 0 && k < npt && !Number.isNaN(I[j])) { sums[k] += I[j]; counts[k]++; }
    }
    const outV = [], outI = [];
    for (let k = 0; k < npt; k++) {
      if (counts[k]) { outV.push(0.5 * (bins[k] + bins[k + 1])); outI.push(sums[k] / counts[k]); }
    }
    return { V: Float64Array.from(outV), I: Float64Array.from(outI) };
  }

  /**
   * J = e*sqrt(e/me)*sqrt(Te)*ne*exp(-1/2) * (exp((V-Vp)/Te) - exp((Vf-Vp)/Te))
   * Written relative to Vp so the exponentials cannot overflow.
   */
  function epflModel(v, ne, Te, Vp, Vf) {
    Te = Math.max(Te, 1e-6);
    return E_CHARGE * Math.sqrt(E_CHARGE / M_E) * Math.sqrt(Te) * ne * Math.exp(-0.5)
      * (Math.exp((v - Vp) / Te) - Math.exp((Vf - Vp) / Te));
  }

  /** Solve a small dense linear system (Gaussian elimination, partial pivot). */
  function solveSmall(A, b) {
    const n = b.length;
    const M = A.map((r, i) => [...r, b[i]]);
    for (let c = 0; c < n; c++) {
      let p = c;
      for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
      [M[c], M[p]] = [M[p], M[c]];
      if (M[c][c] === 0) return null;
      for (let r = c + 1; r < n; r++) {
        const f = M[r][c] / M[c][c];
        for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
      }
    }
    const x = new Array(n).fill(0);
    for (let r = n - 1; r >= 0; r--) {
      let s = M[r][n];
      for (let k = r + 1; k < n; k++) s -= M[r][k] * x[k];
      x[r] = s / M[r][r];
    }
    return x;
  }

  /**
   * Bounded Levenberg–Marquardt least squares (stand-in for scipy curve_fit).
   * Columns are scaled so parameters of very different magnitude (ne ~ 1e16,
   * Te ~ 1) are handled together.
   */
  function curveFit(f, x, y, p0, lower, upper, maxIter = 400) {
    const n = p0.length;
    const clamp = (p) => p.map((v, j) => Math.min(upper[j], Math.max(lower[j], v)));
    const resid = (p) => Float64Array.from(x, (xv, k) => f(xv, ...p) - y[k]);
    const costOf = (r) => { let s = 0; for (const v of r) s += v * v; return Number.isFinite(s) ? s : Infinity; };

    let p = clamp(p0.slice());
    let r = resid(p);
    let cost = costOf(r);
    if (!Number.isFinite(cost)) throw new Error("Model is not finite at the initial guess.");
    let lambda = 1e-3;

    for (let it = 0; it < maxIter; it++) {
      // Numerical Jacobian
      const Jc = [];
      for (let j = 0; j < n; j++) {
        const h = 1.49e-8 * Math.max(Math.abs(p[j]), 1e-3);
        const pj = p.slice(); pj[j] += h;
        const rj = resid(pj);
        Jc.push(Float64Array.from(rj, (v, k) => (v - r[k]) / h));
      }
      const d = Jc.map((col) => Math.sqrt(col.reduce((s, v) => s + v * v, 0)) || 1);
      const JtJ = [], Jtr = [];
      for (let a = 0; a < n; a++) {
        JtJ.push([]);
        let s = 0;
        for (let k = 0; k < r.length; k++) s += (Jc[a][k] / d[a]) * r[k];
        Jtr.push(-s);
        for (let b = 0; b < n; b++) {
          let t = 0;
          for (let k = 0; k < r.length; k++) t += Jc[a][k] * Jc[b][k];
          JtJ[a].push(t / (d[a] * d[b]));
        }
      }

      let improved = false;
      for (let tries = 0; tries < 30; tries++) {
        const A = JtJ.map((row, a) => row.map((v, b) => (a === b ? v * (1 + lambda) : v)));
        const step = solveSmall(A, Jtr);
        if (!step) { lambda *= 10; continue; }
        const pNew = clamp(p.map((v, j) => v + step[j] / d[j]));
        const rNew = resid(pNew);
        const cNew = costOf(rNew);
        if (cNew < cost) {
          const rel = (cost - cNew) / Math.max(cost, 1e-300);
          const moved = pNew.some((v, j) => Math.abs(v - p[j]) > 1e-12 * Math.max(Math.abs(p[j]), 1e-12));
          p = pNew; r = rNew; cost = cNew;
          lambda = Math.max(lambda / 3, 1e-12);
          improved = true;
          if (rel < 1e-14 || !moved) return p;
          break;
        }
        lambda *= 4;
      }
      if (!improved) return p;
    }
    return p;
  }

  function fitEPFLTwoFluid(Vin, Jin, fitMode, ne0, Te0, Vp0, Vf0) {
    const V = [], J = [];
    for (let k = 0; k < Vin.length; k++) {
      if (Number.isFinite(Vin[k]) && Number.isFinite(Jin[k])) { V.push(Vin[k]); J.push(Jin[k]); }
    }
    if (V.length < 5) throw new Error("Not enough points for EPFL two-fluid fit.");
    const vlo = min(V) - 100, vhi = max(V) + 100;
    let ne, Te, Vp, Vf;

    if (fitMode === "all") {
      [ne, Te, Vp, Vf] = curveFit(epflModel, V, J,
        [Math.max(ne0, 1e12), Math.max(Te0, 0.05), Vp0, Vf0],
        [0, 1e-4, vlo, vlo], [Infinity, Infinity, vhi, vhi]);
    } else if (fitMode === "Vp, ne") {
      [ne, Vp] = curveFit((v, n_, vp) => epflModel(v, n_, Te0, vp, Vf0), V, J,
        [Math.max(ne0, 1e12), Vp0], [0, vlo], [Infinity, vhi]);
      Te = Te0; Vf = Vf0;
    } else {
      [ne] = curveFit((v, n_) => epflModel(v, n_, Te0, Vp0, Vf0), V, J,
        [Math.max(ne0, 1e12)], [0], [Infinity]);
      Te = Te0; Vp = Vp0; Vf = Vf0;
    }
    const Vfit = Float64Array.from(V);
    return {
      ne_m3: ne, Te_eV: Te, Vp, Vf,
      V_fit: Vfit, J_fit: Float64Array.from(Vfit, (v) => epflModel(v, ne, Te, Vp, Vf)),
    };
  }

  const api = {
    E_CHARGE, M_E, AMU, ION_SPECIES, ionDensityOML, teFromPotentials, teConsistency, vpCheck, VP_CHECK,
    argsort, take, sign, min, max, nanmin, nanmax, argmax, nanargmax, nanmedian, nanmean,
    linspace, interp, gradient, polyfit, polyval, lstsq,
    makeOdd, movingAverage, polynomialSmooth, smoothSignal,
    averageScans, cropScans, curveWith, finiteCrossingX, fitLineRegion, sortedCurve,
    analyseOML, ionCurrentAt, computeEEPF, trapz, uniqueSorted, splitSweeps, rebinCurve, epflModel, curveFit, fitEPFLTwoFluid,
  };

  root.IV = Object.assign(root.IV || {}, { num: api });
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
