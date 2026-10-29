/* =============================================================================
   Machine learning for fit-region proposals (beta).

   Idea: the rules (auto.js) propose fit regions; people then move some of
   them when they review a curve. The model learns those corrections from
   reviewed curves and applies them to new curves:

       boundary_model = boundary_rules + Te_rules × (w · features + b)

   one small ridge regression per boundary (Vf, ion range end, dI/dV Vp,
   transition and saturation windows). Corrections are measured in units of
   the rules' Te, so curves with different temperatures can be learned
   together. The physics (Te, ne, Vp…) is still computed by the normal
   analysis steps, and every curve is still reviewed.

   Pure functions (no DOM): used by the app and by ml/train.js under Node.
   ============================================================================= */
(function (root) {
  "use strict";
  const req = (p) => (typeof require !== "undefined" ? require(p) : null);
  const N = (root.IV && root.IV.num) || req("./numerics.js");
  const A = (root.IV && root.IV.auto) || req("./auto.js");

  const MODEL_FORMAT = "ivcurve-region-model";
  const MODEL_VERSION = 1;

  /** Boundaries the model corrects: [name, getter, setter]. */
  const TARGETS = [
    ["vf", (p) => p.ion.vf, (p, x) => { p.ion.vf = x; }],
    ["ion_vmax", (p) => p.ion.vmax, (p, x) => { p.ion.vmax = x; }],
    ["vp_didv", (p) => p.vp1, (p, x) => { p.vp1 = x; }],
    ["trans_min", (p) => p.log.tmin, (p, x) => { p.log.tmin = x; }],
    ["trans_max", (p) => p.log.tmax, (p, x) => { p.log.tmax = x; }],
    ["sat_min", (p) => p.log.smin, (p, x) => { p.log.smin = x; }],
    ["sat_max", (p) => p.log.smax, (p, x) => { p.log.smax = x; }],
  ];

  const FEATURES = [
    "log Te_rules", "(Vp_didv − Vf)/Te", "(Vmax − Vp_didv)/Te", "(Vp_didv − Vmin)/Te", "(Vp_int − Vp_didv)/Te",
    "voltage step/Te", "smoothing width/Te", "R² transition", "R² ion fit", "log10 noise", "transition width/Te",
    "(trans_min − Vf)/Te", "(Vp_didv − trans_max)/Te", "log10 |Iis/Ies|", "log ion mass (amu)",
  ];
  const DEFAULT_MASS = 39.948;  // Ar⁺, for samples without an ion mass

  const clone = (p) => JSON.parse(JSON.stringify(p));

  // ---------------------------------------------------------------------------
  // Features and targets
  // ---------------------------------------------------------------------------

  /** Rule proposal for a curve; returns {params, results} with results.diag, or throws. */
  const ruleProposal = (V, I, area) => A.proposeOML(V, I, area);

  /**
   * Dimensionless description of a curve and its rule proposal (same order as FEATURES).
   * Currents only enter as ratios, so the probe area drops out; the ion mass is
   * an input because it changes Vp − Vf and the ion/electron current ratio.
   */
  function featuresOf(V, I, rule, massAmu = DEFAULT_MASS) {
    const { V: v, I: cur } = N.sortedCurve(V, I);
    const r = rule.results, d = r.diag, p = rule.params;
    const Te = r.Te_eV;
    const step = (d.vMax - d.vMin) / (v.length - 1);
    const sm = N.movingAverage(cur, N.makeOdd(p.smooth.window));
    let ss = 0;
    for (let k = 0; k < cur.length; k++) ss += (cur[k] - sm[k]) ** 2;
    const noise = Math.sqrt(ss / cur.length) / Math.max(Math.abs(r.Ies_A), 1e-30);
    const f = [
      Math.log(Te),
      (p.vp1 - r.Vf) / Te,
      (d.vMax - p.vp1) / Te,
      (p.vp1 - d.vMin) / Te,
      Number.isFinite(r.Vp_intersection) ? (r.Vp_intersection - p.vp1) / Te : 0,
      step / Te,
      (p.smooth.window * step) / Te,
      d.r2Trans,
      Number.isFinite(d.r2Ion) ? d.r2Ion : 0,
      Math.log10(Math.max(noise, 1e-12)),
      (p.log.tmax - p.log.tmin) / Te,
      (p.log.tmin - r.Vf) / Te,
      (p.vp1 - p.log.tmax) / Te,
      Math.log10(Math.max(Math.abs(r.Iis_A / r.Ies_A), 1e-12)),
      Math.log(massAmu > 0 ? massAmu : DEFAULT_MASS),
    ];
    return f.map((x) => (Number.isFinite(x) ? x : 0));
  }

  /** Corrections a reviewer made to the rule proposal, in units of the rules' Te. */
  function targetsOf(rule, humanParams) {
    const Te = rule.results.Te_eV;
    return TARGETS.map(([, get]) => (get(humanParams) - get(rule.params)) / Te);
  }

  /** Turns stored training samples into rows {x, y, rule, sample}; skips curves the rules cannot handle. */
  function prepare(samples) {
    const rows = [], skipped = [];
    for (const s of samples) {
      try {
        if (!s.human || !s.human.params || s.human.params.analysable === false) throw new Error("not analysable");
        const V = Float64Array.from(s.curve.V), I = Float64Array.from(s.curve.I);
        const rule = ruleProposal(V, I, s.source.probe.area_m2);
        const mass = (s.source.ion && s.source.ion.mass_amu) || DEFAULT_MASS;
        rows.push({ x: featuresOf(V, I, rule, mass), y: targetsOf(rule, s.human.params), rule, sample: s, V, I });
      } catch (e) {
        skipped.push({ id: s.id, file: s.source && s.source.file, reason: e.message });
      }
    }
    return { rows, skipped };
  }

  // ---------------------------------------------------------------------------
  // Ridge regression (standardised features, one output per boundary)
  // ---------------------------------------------------------------------------

  function fitRidge(X, Y, lambda) {
    const n = X.length, m = X[0].length, k = Y[0].length;
    const mean = new Array(m).fill(0), std = new Array(m).fill(0);
    for (const x of X) x.forEach((v, j) => { mean[j] += v / n; });
    for (const x of X) x.forEach((v, j) => { std[j] += (v - mean[j]) ** 2 / n; });
    for (let j = 0; j < m; j++) std[j] = Math.sqrt(std[j]) || 1;
    const Z = X.map((x) => x.map((v, j) => (v - mean[j]) / std[j]));
    const weights = [], intercepts = [];
    for (let t = 0; t < k; t++) {
      const ybar = Y.reduce((s, y) => s + y[t], 0) / n;
      // least squares on [Z; sqrt(lambda) I] against [y - ybar; 0]  ==  ridge
      const rowsA = Z.map((z) => z.slice()), b = Y.map((y) => y[t] - ybar);
      for (let j = 0; j < m; j++) { const r = new Array(m).fill(0); r[j] = Math.sqrt(lambda); rowsA.push(r); b.push(0); }
      weights.push(Array.from(N.lstsq(rowsA, b)));
      intercepts.push(ybar);
    }
    return { mean, std, weights, intercepts, lambda };
  }

  function predictRidge(fit, x) {
    const z = x.map((v, j) => (v - fit.mean[j]) / fit.std[j]);
    return fit.weights.map((w, t) => fit.intercepts[t] + w.reduce((s, wj, j) => s + wj * z[j], 0));
  }

  // ---------------------------------------------------------------------------
  // Applying corrections (shared by evaluation and the app)
  // ---------------------------------------------------------------------------

  /** Rule params + predicted corrections, kept in a valid order and inside the data. */
  function correctedParams(rule, deltas) {
    const p = clone(rule.params);
    const Te = rule.results.Te_eV;
    TARGETS.forEach(([, get, set], t) => set(p, get(p) + deltas[t] * Te));
    const d = rule.results.diag;
    const lo = d.vMin, hi = d.vMax, gap = 0.02 * (hi - lo);
    const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
    p.ion.vmax = clamp(p.ion.vmax, p.ion.vmin + gap, hi - gap);
    p.ion.vf = clamp(p.ion.vf, lo + gap, hi - gap);
    p.vp1 = clamp(p.vp1, p.ion.vf + gap, hi - 2 * gap);        // leave room for a saturation window
    p.log.tmin = clamp(p.log.tmin, lo, p.vp1 - 2 * gap);
    p.log.tmax = clamp(p.log.tmax, p.log.tmin + gap, p.vp1);
    p.log.smin = clamp(p.log.smin, p.vp1, hi - gap);
    p.log.smax = clamp(p.log.smax, p.log.smin + 0.5 * gap, hi);
    return p;
  }

  /** Runs params on a curve with a recomputed intersection; returns results or null. */
  function evaluateParams(V, I, area, p) {
    try {
      const full = A.withIntersection(V, I, p);
      return A.runOMLSteps(V, I, area, full);
    } catch (_) {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Training with cross-validation
  // ---------------------------------------------------------------------------

  const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
  const median = (a) => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length ? (s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m])) : NaN; };

  /** Errors of rules and model against the reviewers on held-out rows. */
  function scoreRows(rows, predictFor) {
    const per = TARGETS.map(() => ({ rules: [], model: [] }));
    const res = { teRules: [], teModel: [], vpRules: [], vpModel: [], failedModel: 0 };
    for (const row of rows) {
      const Te = row.rule.results.Te_eV;
      const deltas = predictFor(row);
      row.y.forEach((yt, t) => {
        per[t].rules.push(Math.abs(yt) * Te);                    // rules: no correction
        per[t].model.push(Math.abs(yt - deltas[t]) * Te);        // volts
      });
      const human = row.sample.human.results;
      const mr = evaluateParams(row.V, row.I, row.sample.source.probe.area_m2, correctedParams(row.rule, deltas));
      res.teRules.push(Math.abs(row.rule.results.Te_eV / human.Te_eV - 1) * 100);
      res.vpRules.push(Math.abs(row.rule.results.Vp - human.Vp));
      if (mr) {
        res.teModel.push(Math.abs(mr.Te_eV / human.Te_eV - 1) * 100);
        res.vpModel.push(Math.abs(mr.Vp - human.Vp));
      } else {
        res.failedModel++;
      }
    }
    return {
      boundaries: TARGETS.map(([name], t) => ({ name, rules_mae_V: mean(per[t].rules), model_mae_V: mean(per[t].model) })),
      te_error_pct: { rules_median: median(res.teRules), model_median: median(res.teModel) },
      vp_error_V: { rules_median: median(res.vpRules), model_median: median(res.vpModel) },
      model_failed: res.failedModel,
      n: rows.length,
    };
  }

  /** Zero corrections for boundaries the model does not improve (use[t] === false). */
  const gate = (deltas, use) => (use ? deltas.map((d, t) => (use[t] ? d : 0)) : deltas);

  /** k-fold cross-validation for one lambda (deterministic fold assignment). */
  function crossValidate(rows, lambda, folds = 5, use = null) {
    const held = [];
    for (let f = 0; f < folds; f++) {
      const train = rows.filter((_, i) => i % folds !== f), test = rows.filter((_, i) => i % folds === f);
      if (train.length < 5 || !test.length) continue;
      const fit = fitRidge(train.map((r) => r.x), train.map((r) => r.y), lambda);
      for (const r of test) held.push({ row: r, deltas: gate(predictRidge(fit, r.x), use) });
    }
    const map = new Map(held.map((h) => [h.row, h.deltas]));
    const score = scoreRows(held.map((h) => h.row), (row) => map.get(row));
    // the same held-out predictions, split by ion species and by probe
    const groupBy = (key) => {
      const groups = new Map();
      for (const h of held) { const k = key(h.row.sample.source); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(h.row); }
      return [...groups].map(([name, rows]) => {
        const s = scoreRows(rows, (row) => map.get(row));
        return { name, n: rows.length, te_error_pct: s.te_error_pct, vp_error_V: s.vp_error_V };
      });
    };
    score.by_ion = groupBy((src) => (src.ion && src.ion.species) || "?");
    score.by_probe = groupBy((src) => (src.probe ? `${src.probe.diameter_mm} × ${src.probe.length_mm} mm` : "?"));
    return score;
  }

  /**
   * Trains on reviewed samples: picks lambda by cross-validation, fits on all
   * rows, and returns the model with its validation report.
   */
  function train(samples, { lambdas = [0.3, 1, 3, 10, 30, 100], folds = 5, note = "" } = {}) {
    const { rows, skipped } = prepare(samples);
    if (rows.length < 10) throw new Error(`Only ${rows.length} usable reviewed curves; at least 10 are needed (200 planned).`);
    let best = null;
    for (const lambda of lambdas) {
      const cv = crossValidate(rows, lambda, folds);
      const score = mean(cv.boundaries.map((b) => b.model_mae_V));
      if (!best || score < best.score) best = { lambda, cv, score };
    }
    // only correct the boundaries where the model beats the rules on held-out curves
    const use = best.cv.boundaries.map((b) => b.model_mae_V < 0.95 * b.rules_mae_V);
    const cv = crossValidate(rows, best.lambda, folds, use);
    const fit = fitRidge(rows.map((r) => r.x), rows.map((r) => r.y), best.lambda);
    fit.use = use;
    return {
      format: MODEL_FORMAT, format_version: MODEL_VERSION,
      created: new Date().toISOString(), note,
      trained_on: rows.length, skipped: skipped.length,
      features: FEATURES, targets: TARGETS.map(([n]) => n),
      fit,
      validation: { folds, lambda: best.lambda, ...cv, corrected: TARGETS.filter((_, t) => use[t]).map(([n]) => n) },
    };
  }

  // ---------------------------------------------------------------------------
  // Using a model
  // ---------------------------------------------------------------------------

  function checkModel(model) {
    if (!model || model.format !== MODEL_FORMAT) throw new Error("This is not a region model file.");
    if (model.format_version > MODEL_VERSION) throw new Error("This model was made by a newer version of the app.");
    if (model.features.length !== FEATURES.length || model.targets.length !== TARGETS.length) throw new Error("The model does not match this version of the app.");
    return model;
  }

  /**
   * Proposal from a model: the rule proposal corrected by the model. Falls back
   * to the rules if the corrected regions cannot be fitted.
   * Returns {params, results, source: "model" | "rules (model failed)"}.
   */
  function proposeWithModel(model, V, I, area, massAmu = DEFAULT_MASS) {
    const rule = ruleProposal(V, I, area);
    const deltas = gate(predictRidge(model.fit, featuresOf(V, I, rule, massAmu)), model.fit.use);
    const p = correctedParams(rule, deltas);
    try {
      const full = A.withIntersection(V, I, p);
      return { params: full, results: A.runOMLSteps(V, I, area, full), source: "model" };
    } catch (_) {
      return { ...rule, source: "rules (model failed)" };
    }
  }

  // ---------------------------------------------------------------------------
  // Training samples (shared by the in-app collection and the imports)
  // ---------------------------------------------------------------------------

  const round7 = (a) => Array.from(a, (v) => (Number.isFinite(v) ? Number(v.toPrecision(7)) : null));

  /** Content hash: the same curve from the same file gets the same id, so it is never counted twice. */
  function sampleId(file, V, I) {
    const text = `${file}|${V.join(",")}|${I.join(",")}`;
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = Math.imul(h2 + c, 2246822519); }
    return ((h1 >>> 0).toString(16) + (h2 >>> 0).toString(16)).padStart(16, "0");
  }

  const jsonSafe = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === "number" && !Number.isFinite(v) ? null : v)));

  /** A training sample from a reviewed curve: x/imean = the analysed mean curve. */
  function makeSample({ file, x, imean, params, results, area, xkey, scans, settings, appVersion, addedAt }) {
    const V = round7(x), I = round7(imean);
    const num = (v) => (v === null || v === undefined || v === "" ? NaN : Number(v));
    return {
      format: "ivcurve-training-sample", format_version: 1,
      id: sampleId(file, V, I),
      added_at: addedAt || new Date().toISOString(), app_version: appVersion,
      source: {
        file, xkey, scans: scans || null,
        probe: { diameter_mm: num(settings.diameter), length_mm: num(settings.length), area_m2: area },
        ion: { species: settings.ionGas, mass_amu: num(settings.ionMass) },
        data_range: settings.crop || null,
      },
      curve: { V, I },
      human: {
        params: jsonSafe(params),
        results: jsonSafe({ Te_eV: results.Te_eV, Vp: results.Vp, Vf: results.Vf, ne_m3: results.ne_m3, Vp_dIdV: results.Vp_dIdV, Vp_intersection: results.Vp_intersection }),
      },
    };
  }

  const reviveArray = (a) => Float64Array.from(a || [], (v) => (v === null ? NaN : v));

  /**
   * Training samples from a saved batch (.ivbatch): only curves a person
   * reviewed and accepted. Each curve is rebuilt with the settings it was
   * reviewed with (its own snapshot, or the batch's for older files), and the
   * stored regions must reproduce the stored results — otherwise it is skipped.
   * Returns {samples, skipped: [{file, reason}]}.
   */
  function samplesFromBatch(data) {
    if (!data || data.format !== "ivcurve-batch") throw new Error("This is not a saved batch (.ivbatch).");
    const samples = [], skipped = [];
    for (const it of data.items || []) {
      const skip = (reason) => skipped.push({ file: it.name, reason });
      if (it.status !== "accepted" || !it.reviewed) {
        skip({ auto: "accepted without review", check: "not reviewed (⚠ check)", good: "not reviewed", failed: "not reviewed (✗ failed)", rejected: "marked not analysable", pending: "not analysed" }[it.status] || `status “${it.status}”`);
        continue;
      }
      if (!it.params || it.params.analysable === false || !it.results) { skip("no reviewed regions"); continue; }
      const settings = it.settings || data.settings;
      if (!settings) { skip("no settings saved"); continue; }
      try {
        const scans = it.scans.map((s) => ({ id: s.id, label: typeof s.label === "string" ? s.label : undefined,
          VData: reviveArray(s.VData), RefData: reviveArray(s.RefData), IData: reviveArray(s.IData) }));
        const crop = settings.crop ? { ...settings.crop, from: num0(settings.crop.from, -Infinity), to: num0(settings.crop.to, Infinity) } : null;
        const curve = N.curveWith(scans, settings.xaxis || "VData", crop);
        const area = Math.PI * Number(settings.diameter) * 1e-3 * Number(settings.length) * 1e-3;
        // the stored regions must give the stored results on this curve
        const check = A.runOMLSteps(curve.x, curve.imean, area, it.params);
        const same = (a, b) => Math.abs(a - b) <= 1e-6 * Math.max(Math.abs(a), Math.abs(b), 1e-12);
        if (!same(check.Te_eV, it.results.Te_eV) || !same(check.Vp, it.results.Vp)) {
          skip("the saved regions do not reproduce the saved results (settings changed after the review?)");
          continue;
        }
        samples.push(makeSample({ file: it.name, x: curve.x, imean: curve.imean, params: it.params, results: it.results,
          area, xkey: curve.xkey, scans: scans.length, settings, appVersion: data.app_version, addedAt: data.saved_at }));
      } catch (e) {
        skip(e.message);
      }
    }
    return { samples, skipped };
  }
  const num0 = (v, dflt) => (v === null || v === undefined ? dflt : Number(v));

  const api = {
    MODEL_FORMAT, MODEL_VERSION, TARGETS: TARGETS.map(([n]) => n), FEATURES,
    featuresOf, targetsOf, prepare, fitRidge, predictRidge, correctedParams, evaluateParams,
    crossValidate, scoreRows, train, checkModel, proposeWithModel,
    sampleId, makeSample, samplesFromBatch,
  };
  if (root.IV) root.IV.ml = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
