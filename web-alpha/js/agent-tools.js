/* =============================================================================
   Tools of the AI analysis agent (pre-alpha).

   The agent (a language model) never computes a physical quantity itself: it
   chooses fit regions and calls these tools, which run the app's own analysis
   (auto.js runOMLSteps, numerics.js checks). Every number it reports comes
   from here. The same quality rules as the manual window and the batch review
   apply (Vp check in volts, Te from Vp − Vf, quality flags).

   Pure functions (no DOM), so they also run under Node for the tests.
   ============================================================================= */
(function (root) {
  "use strict";
  const N = (root.IV && root.IV.num) || (typeof require !== "undefined" ? require("./numerics.js") : null);
  const A = (root.IV && root.IV.auto) || (typeof require !== "undefined" ? require("./auto.js") : null);

  /** Rounds to a few significant digits so the model gets short, readable numbers. */
  const sig = (x, d = 4) => (Number.isFinite(x) ? Number(x.toPrecision(d)) : null);

  // ---------------------------------------------------------------------------
  // Context: the curve and settings the agent works on
  // ---------------------------------------------------------------------------

  /**
   * ctx for one analysis. V, I: the mean curve of the main window; area in m²;
   * massAmu, species: ion; probe: {diameter_mm, length_mm}; file, xkey: labels.
   */
  function makeContext({ V, I, area, massAmu, species = "Ar⁺", probe = null, file = "", xkey = "VData" }) {
    const { V: v, I: cur } = N.sortedCurve(V, I);
    let proposal = null, proposalError = null;
    try { proposal = A.proposeOML(v, cur, area); } catch (e) { proposalError = e.message; }
    return { V: v, I: cur, area, massAmu, species, probe, file, xkey, proposal, proposalError, lastParams: null, calls: 0 };
  }

  /** Regions in the agent's vocabulary from manual-OML params. */
  function regionsOf(p) {
    return {
      ion_vmin: sig(p.ion.vmin), ion_vmax: sig(p.ion.vmax),
      trans_min: sig(p.log.tmin), trans_max: sig(p.log.tmax),
      sat_min: sig(p.log.smin), sat_max: sig(p.log.smax),
      vf: sig(p.ion.vf), vp_didv: sig(p.vp1),
    };
  }

  function defaultSmooth(ctx) {
    if (ctx.proposal) return ctx.proposal.params.smooth;
    const win = N.makeOdd(Math.min(21, Math.max(3, Math.floor(ctx.V.length / 10))));
    return { method: "Moving average", window: win, order: 2 };
  }

  function zeroCrossing(ctx, smooth) {
    if (ctx.proposal) return ctx.proposal.params.ion.vf;
    const Is = N.smoothSignal(ctx.I, smooth.method, smooth.window, smooth.order);
    return N.finiteCrossingX(ctx.V, Is);
  }

  /** Peak of the smoothed dIe/dV above Vf for a given ion fit (the dI/dV Vp). */
  function didvPeak(ctx, p) {
    const { Ie } = A.electronCurrent(ctx.V, ctx.I, p);
    const d = N.smoothSignal(N.gradient(Ie, ctx.V), p.didv.method, N.makeOdd(p.didv.window), p.didv.order);
    const n = ctx.V.length, margin = n > 10 ? 5 : 0;
    let best = -1;
    for (let k = margin; k < n - margin; k++) {
      if (ctx.V[k] > p.ion.vf && Number.isFinite(d[k]) && (best < 0 || d[k] > d[best])) best = k;
    }
    if (best < 0) throw new Error("No dIe/dV peak above Vf.");
    return ctx.V[best];
  }

  /** Manual-OML params from the agent's regions (missing vf / vp_didv are measured). */
  function paramsFrom(ctx, reg) {
    const need = ["ion_vmin", "ion_vmax", "trans_min", "trans_max", "sat_min", "sat_max"];
    for (const k of need) if (!Number.isFinite(Number(reg[k]))) throw new Error(`Missing or invalid region bound: ${k}.`);
    const num = (k) => Number(reg[k]);
    for (const [a, b] of [["ion_vmin", "ion_vmax"], ["trans_min", "trans_max"], ["sat_min", "sat_max"]]) {
      if (!(num(a) < num(b))) throw new Error(`${a} must be smaller than ${b}.`);
    }
    const smooth = defaultSmooth(ctx);
    const vf = Number.isFinite(Number(reg.vf)) && reg.vf !== null ? num("vf") : zeroCrossing(ctx, smooth);
    let p = {
      smooth, analysable: true, reached: 5,
      ion: { vf, vmin: num("ion_vmin"), vmax: num("ion_vmax") },
      didv: { ...smooth },
      vp1: NaN,
      log: { tmin: num("trans_min"), tmax: num("trans_max"), smin: num("sat_min"), smax: num("sat_max"), vp2: NaN },
    };
    p.vp1 = Number.isFinite(Number(reg.vp_didv)) && reg.vp_didv !== null ? num("vp_didv") : didvPeak(ctx, p);
    try { p = A.withIntersection(ctx.V, ctx.I, p); } catch (_) { /* no saturation fit: Vp from dI/dV only */ }
    return p;
  }

  /**
   * RF compensation check from the sharpness of the knee. Above the dIe/dV peak
   * (dI/dV Vp) a well-compensated probe drops quickly to the saturation slope;
   * RF ripple on the sheath voltage rounds the knee and stretches that drop.
   * Measure: distance from the peak to where dIe/dV has fallen halfway to the
   * saturation level, minus half the smoothing window, in units of Te.
   * Limits from simulated ripple (sharp knee ≈ 0.1–0.3): < 0.4 good,
   * 0.4–0.7 doubtful, > 0.7 poor (ripple of about Te or more).
   */
  const RF_LIMITS = { good: 0.4, poor: 0.7 };
  function rfCheck(ctx, p, Te) {
    try {
      const { Ie } = A.electronCurrent(ctx.V, ctx.I, p);
      const v = ctx.V, n = v.length;
      const d = N.smoothSignal(N.gradient(Ie, v), p.didv.method, N.makeOdd(p.didv.window), p.didv.order);
      const margin = n > 10 ? 5 : 0;
      let k = -1;
      for (let j = margin; j < n - margin; j++) if (v[j] > p.ion.vf && Number.isFinite(d[j]) && (k < 0 || d[j] > d[k])) k = j;
      if (k < 0 || !(Te > 0)) return null;
      const sat = [];
      for (let j = 0; j < n; j++) if (v[j] >= p.log.smin && v[j] <= p.log.smax && Number.isFinite(d[j])) sat.push(d[j]);
      const level = sat.length ? N.nanmedian(sat) : 0;
      let b = k;
      while (b < n - 1 && d[b] > (d[k] + level) / 2) b++;
      const step = (v[n - 1] - v[0]) / Math.max(n - 1, 1);
      const smoothing = N.makeOdd(p.didv.window) * step;
      const rounding = v[b] - v[k];
      const ratio = Math.max(rounding - smoothing / 2, 0) / Te;
      return {
        knee_rounding_V: sig(rounding, 3), smoothing_window_V: sig(smoothing, 3), knee_rounding_over_Te: sig(ratio, 3),
        rf_compensation: b >= n - 1 ? "not checked (knee at the end of the sweep)"
          : ratio < RF_LIMITS.good ? "good" : ratio <= RF_LIMITS.poor ? "doubtful" : "poor",
      };
    } catch (_) { return null; }
  }

  /** Full evaluation: app results + derived quantities + checks + flags. */
  function evaluate(ctx, p) {
    const r = A.runOMLSteps(ctx.V, ctx.I, ctx.area, p);
    r.ion_species = ctx.species;
    r.ion_mass_amu = ctx.massAmu;
    r.ni_m3 = N.ionDensityOML(r.ion_i2_a, ctx.area, ctx.massAmu);
    const t = N.teFromPotentials(r.Vp, r.Vf, ctx.massAmu);
    r.Te_VpVf_OML_eV = t.Te_OML_eV;
    r.Te_VpVf_planar_eV = t.Te_planar_eV;
    const tc = N.teConsistency(r.Te_eV, r.Te_VpVf_OML_eV, r.Te_VpVf_planar_eV);
    r.Te_check = tc.checked ? (tc.ok ? "ok" : "mismatch") : "n/a";
    const vc = N.vpCheck(r.Vp_dIdV, r.Vp_intersection, r.Te_eV, r.Te_VpVf_OML_eV, r.Te_VpVf_planar_eV);
    r.Vp_difference_V = vc.checked ? vc.diff : NaN;
    r.Vp_check = vc.checked ? vc.level : "n/a";
    const flags = A.qualityFlags(r, { ni_m3: r.ni_m3, Te_VpVf_OML_eV: r.Te_VpVf_OML_eV, Te_VpVf_planar_eV: r.Te_VpVf_planar_eV });
    if (!vc.checked) flags.push("Vp check not possible: no fit-intersection Vp (no usable saturation region)");
    const rf = rfCheck(ctx, p, r.Te_eV);
    if (rf && rf.rf_compensation === "poor") flags.push(`RF compensation looks poor: rounded knee above Vp (${rf.knee_rounding_over_Te} Te; sharp knee < 0.4 Te)`);
    return { results: r, flags, vpCheck: vc, factors: { OML: t.factorOML, planar: t.factorPlanar }, rf };
  }

  const VP_REASON = {
    large: "more than 5 V apart: the curve must be reviewed by eye",
    "no-te-check": "2–5 V apart and no Te cross-check possible",
    "te-mismatch": "2–5 V apart and Te from Vp − Vf does not confirm the fitted Te",
    "te-confirms": "2–5 V apart, confirmed by Te from Vp − Vf",
  };

  /** Short JSON summary of an evaluation for the model. */
  function summary(ctx, p, ev) {
    const r = ev.results, d = r.diag || {};
    return {
      regions: regionsOf(p),
      status: ev.flags.length ? "check" : "good",
      quality_flags: ev.flags,
      Vf_V: sig(r.Vf), Vp_dIdV_V: sig(r.Vp_dIdV), Vp_intersection_V: sig(r.Vp_intersection), Vp_final_V: sig(r.Vp),
      Vp_difference_V: sig(r.Vp_difference_V, 3),
      Vp_check: r.Vp_check,
      Vp_check_reason: ev.vpCheck.checked ? (ev.vpCheck.level === "good" ? "within 2 V" : VP_REASON[ev.vpCheck.reason]) : "not checked",
      Te_eV: sig(r.Te_eV), Te_VpVf_OML_eV: sig(r.Te_VpVf_OML_eV), Te_VpVf_planar_eV: sig(r.Te_VpVf_planar_eV),
      VpVf_factors: { OML: sig(ev.factors.OML, 3), planar: sig(ev.factors.planar, 3) },
      Te_check: r.Te_check,
      VpVf_over_expected_OML: sig((r.Vp - r.Vf) / (ev.factors.OML * r.Te_eV), 3),
      rf_check: ev.rf,
      ne_m3: sig(r.ne_m3, 3), ni_OML_m3: sig(r.ni_m3, 3), ni_over_ne: sig(r.ni_m3 / r.ne_m3, 3),
      Iis_at_Vf_A: sig(r.Iis_A, 3), Ies_A: sig(r.Ies_A, 3),
      fit_quality: {
        r2_transition: sig(d.r2Trans, 5), points_transition: d.nTrans,
        r2_ion: sig(d.r2Ion, 4),
        r2_saturation: sig(d.r2Sat, 4), points_saturation: d.nSat,
        saturation_slope_per_V: sig(d.satSlope, 3), transition_slope_per_V: sig(d.transSlope, 3),
      },
    };
  }

  // ---------------------------------------------------------------------------
  // The tools
  // ---------------------------------------------------------------------------

  const REGION_PROPS = {
    ion_vmin: { type: "number", description: "Lower bound (V) of the ion fit region (I² = aV + b), well below Vf." },
    ion_vmax: { type: "number", description: "Upper bound (V) of the ion fit region; keep it a few Te below Vf." },
    trans_min: { type: "number", description: "Lower bound (V) of the transition (electron retardation) region used for Te: straight part of ln(Ie) between Vf and Vp." },
    trans_max: { type: "number", description: "Upper bound (V) of the transition region, below the knee." },
    sat_min: { type: "number", description: "Lower bound (V) of the electron-saturation region, above the knee." },
    sat_max: { type: "number", description: "Upper bound (V) of the electron-saturation region." },
    vf: { type: "number", description: "Optional floating potential (V). Default: the zero crossing of the smoothed curve." },
    vp_didv: { type: "number", description: "Optional Vp from dI/dV (V). Default: the measured dIe/dV peak above Vf; only override with a clear reason." },
  };
  const REGION_REQUIRED = ["ion_vmin", "ion_vmax", "trans_min", "trans_max", "sat_min", "sat_max"];

  /** Tool definitions in the function-calling format (Mistral / OpenAI). */
  const TOOL_DEFS = [
    { type: "function", function: {
      name: "get_curve_overview",
      description: "Settings (probe, ion species and mass, area), voltage range and a down-sampled table of the mean I–V curve with ln(Ie) after subtracting the default ion fit. Call this first.",
      parameters: { type: "object", properties: {} } } },
    { type: "function", function: {
      name: "propose_regions",
      description: "The app's rule-based fit-region proposal (straightest ln(Ie) stretch for Te, saturation window above Vp, ion region a few Te below Vf), evaluated with all checks. A good starting point.",
      parameters: { type: "object", properties: {} } } },
    { type: "function", function: {
      name: "evaluate_regions",
      description: "Runs the full OML analysis of the app for the given fit regions and returns Vf, both Vp values, the Vp check, Te, Te from Vp − Vf, ne, ni, fit R² and quality flags. Use it to try and compare regions.",
      parameters: { type: "object", properties: REGION_PROPS, required: REGION_REQUIRED } } },
    { type: "function", function: {
      name: "inspect_window",
      description: "ln(Ie) points between vmin and vmax (electron current after the ion fit of the last evaluated regions) with a straight-line fit: slope, Te = 1/slope, R². Use it to look for the knee, curvature or a second electron temperature.",
      parameters: { type: "object", properties: {
        vmin: { type: "number", description: "Lower bound (V)." },
        vmax: { type: "number", description: "Upper bound (V)." },
      }, required: ["vmin", "vmax"] } } },
    { type: "function", function: {
      name: "submit_result",
      description: "Final step: the regions you choose and your report. The app evaluates them once more; the numbers shown to the user come from the app, not from your text.",
      parameters: { type: "object", properties: {
        ...REGION_PROPS,
        report: { type: "string", description: "Report for the user (plain text, short paragraphs or lists): status first, then the results, the checks and the caveats, following the skill." },
      }, required: [...REGION_REQUIRED, "report"] } } },
  ];

  function overview(ctx) {
    const v = ctx.V, n = v.length;
    const vMin = N.nanmin(v), vMax = N.nanmax(v);
    let lnIe = null, Vf = null, Vp = null;
    if (ctx.proposal) {
      const { Ie } = A.electronCurrent(v, ctx.I, ctx.proposal.params);
      lnIe = Ie;
      Vf = ctx.proposal.params.ion.vf;
      Vp = ctx.proposal.params.vp1;
    }
    const rows = [];
    const want = Math.min(60, n);
    for (let j = 0; j < want; j++) {
      const k = Math.round((j * (n - 1)) / Math.max(want - 1, 1));
      rows.push([sig(v[k]), sig(ctx.I[k], 4), lnIe && lnIe[k] > 0 ? sig(Math.log(lnIe[k]), 4) : null]);
    }
    return {
      file: ctx.file, x_axis: ctx.xkey,
      probe: ctx.probe, probe_area_m2: sig(ctx.area, 4),
      ion: { species: ctx.species, mass_amu: sig(ctx.massAmu, 5) },
      points: n, V_min: sig(vMin), V_max: sig(vMax), V_step: sig((vMax - vMin) / Math.max(n - 1, 1), 3),
      I_min_A: sig(N.nanmin(ctx.I), 3), I_max_A: sig(N.nanmax(ctx.I), 3),
      Vf_zero_crossing_V: sig(Vf), Vp_dIdV_peak_V: sig(Vp),
      proposal_available: !!ctx.proposal, proposal_error: ctx.proposalError,
      table_columns: ["V", "I_A", "ln_Ie (default ion fit subtracted; null if Ie <= 0)"],
      table: rows,
    };
  }

  function inspect(ctx, vmin, vmax) {
    const p = ctx.lastParams || (ctx.proposal && ctx.proposal.params);
    if (!p) throw new Error("Evaluate some regions first (no ion fit yet).");
    if (!(vmin < vmax)) throw new Error("vmin must be smaller than vmax.");
    const { Ie } = A.electronCurrent(ctx.V, ctx.I, p);
    const xs = [], ys = [];
    for (let k = 0; k < ctx.V.length; k++) if (ctx.V[k] >= vmin && ctx.V[k] <= vmax && Ie[k] > 0) { xs.push(ctx.V[k]); ys.push(Math.log(Ie[k])); }
    if (xs.length < 3) return { points: xs.length, note: "Fewer than 3 points with Ie > 0 in this window." };
    const c = N.polyfit(xs, ys, 1);
    const step = Math.max(1, Math.ceil(xs.length / 40));
    const pts = [];
    for (let k = 0; k < xs.length; k += step) pts.push([sig(xs[k]), sig(ys[k], 4)]);
    return {
      points: xs.length, slope_per_V: sig(c[0], 4), Te_eV_from_slope: c[0] > 0 ? sig(1 / c[0], 4) : null,
      r2: sig(A.rSquared(xs, ys, c), 5), ion_fit_from: ctx.lastParams ? "last evaluated regions" : "proposal",
      ln_Ie_points: pts,
    };
  }

  /**
   * Runs one tool call. Returns {content: object (sent back to the model),
   * final?: {params, results, flags, report}} — final only for submit_result.
   */
  function call(ctx, name, args = {}) {
    ctx.calls++;
    try {
      switch (name) {
        case "get_curve_overview":
          return { content: overview(ctx) };
        case "propose_regions": {
          if (!ctx.proposal) return { content: { error: `No rule-based proposal for this curve: ${ctx.proposalError}. Choose regions from the overview.` } };
          const p = ctx.proposal.params;
          ctx.lastParams = p;
          return { content: summary(ctx, p, evaluate(ctx, p)) };
        }
        case "evaluate_regions": {
          const p = paramsFrom(ctx, args);
          ctx.lastParams = p;
          return { content: summary(ctx, p, evaluate(ctx, p)) };
        }
        case "inspect_window":
          return { content: inspect(ctx, Number(args.vmin), Number(args.vmax)) };
        case "submit_result": {
          const p = paramsFrom(ctx, args);
          const ev = evaluate(ctx, p);
          const s = summary(ctx, p, ev);
          return {
            content: { accepted: true, status: s.status, quality_flags: s.quality_flags },
            final: { params: p, results: ev.results, flags: ev.flags, summary: s, report: String(args.report || "") },
          };
        }
        default:
          return { content: { error: `Unknown tool: ${name}` } };
      }
    } catch (e) {
      return { content: { error: e.message } };
    }
  }

  const api = { TOOL_DEFS, makeContext, call, paramsFrom, evaluate, summary, regionsOf, rfCheck, RF_LIMITS };
  if (root.IV) root.IV.agentTools = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
