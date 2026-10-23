/* =============================================================================
   Main window (port of LDAApp)
   ============================================================================= */
(function (IV) {
  "use strict";
  const N = IV.num;
  const { el, fmtG, fmtE, toast } = IV.ui;

  // Single source of the version shown in the app and in "What's new".
  const APP_VERSION = "2.5.0-alpha.1";
  const SETTINGS_KEY = "ivcurve.settings.v1";

  IV.APP_VERSION = APP_VERSION;
  IV.escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const $ = (id) => document.getElementById(id);

  const state = {
    rawScans: null,        // scans as loaded
    scans: null,           // scans after the data-range reduction (used everywhere)
    fileName: null,
    crop: { enabled: false, skipStart: 0, skipEnd: 0, from: NaN, to: NaN },
    omlResults: null,      // latest automatic or manual OML result (feeds EEPF)
    lastResults: null,     // latest result of any method (exported)
    lastEEPF: null,
    params: {},            // last settings of each analysis window: {manual, eepf, epfl}
    cards: [],             // results cards shown for the current data (saved with a session)
  };

  // ---------------------------------------------------------------------------
  // Settings (per-browser convenience only)
  // ---------------------------------------------------------------------------

  const settingInputs = ["diameter", "length", "ionFraction", "smoothWindow", "xaxis", "ionGas", "ionMass"];

  function loadSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}");
      for (const id of settingInputs) if (saved[id] !== undefined) $(id).value = saved[id];
      if (saved.showAll !== undefined) $("showAll").checked = saved.showAll;
      if (saved.showMean !== undefined) $("showMean").checked = saved.showMean;
    } catch (_) { /* storage unavailable: defaults stay */ }
  }

  function saveSettings() {
    try {
      const out = { showAll: $("showAll").checked, showMean: $("showMean").checked };
      for (const id of settingInputs) out[id] = $(id).value;
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(out));
    } catch (_) { /* ignore */ }
  }

  const numberValue = (id) => {
    const node = $(id);
    const v = parseFloat(node.value);
    const ok = Number.isFinite(v) && v >= parseFloat(node.min) && v <= parseFloat(node.max);
    node.classList.toggle("error", !ok);
    if (!ok) throw new Error(`Invalid value for ${node.dataset.label || id}.`);
    return v;
  };

  // ---------------------------------------------------------------------------
  // Ion species (for the ion density from the OML ion current)
  // ---------------------------------------------------------------------------

  function fillIonSpecies() {
    const sel = $("ionGas");
    for (const name of [...Object.keys(N.ION_SPECIES), "Custom"]) sel.append(el("option", { value: name, text: name }));
    sel.value = "Ar⁺";
  }

  function syncIonMass() {
    const custom = $("ionGas").value === "Custom";
    $("ionMass").disabled = !custom;
    if (!custom) $("ionMass").value = N.ION_SPECIES[$("ionGas").value];
  }

  /** Adds n_i (from the slope of the I^2 fit) and Te from Vp - Vf to an OML result. */
  function addDerived(r, area) {
    r.ion_species = $("ionGas").value;
    r.ion_mass_amu = numberValue("ionMass");
    r.ni_m3 = N.ionDensityOML(r.ion_i2_a, area, r.ion_mass_amu);
    const t = N.teFromPotentials(r.Vp, r.Vf, r.ion_mass_amu);
    r.Te_VpVf_OML_eV = t.Te_OML_eV;
    r.Te_VpVf_planar_eV = t.Te_planar_eV;
    r.Te_check = teCheck(r);
    // validation of a manual analysis: the two Vp values within 2 V, or 5 V with a Te cross-check
    const vc = N.vpCheck(r.Vp_dIdV, r.Vp_intersection, r.Te_eV, r.Te_VpVf_OML_eV, r.Te_VpVf_planar_eV);
    r.Vp_difference_V = vc.checked ? vc.diff : NaN;
    r.Vp_check = vc.checked ? vc.level : "n/a";
    return r;
  }

  /** "ok", "mismatch" or "n/a" — exported with the results. */
  function teCheck(r) {
    const c = N.teConsistency(r.Te_eV, r.Te_VpVf_OML_eV, r.Te_VpVf_planar_eV);
    return c.checked ? (c.ok ? "ok" : "mismatch") : "n/a";
  }

  const teWarn = (r) => IV.ui.teWarning(r.Te_eV, r.Te_VpVf_OML_eV, r.Te_VpVf_planar_eV);

  const vpInfo = (r) => IV.ui.vpCheckInfo(r.Vp_dIdV, r.Vp_intersection, r.Te_eV, r.Te_VpVf_OML_eV, r.Te_VpVf_planar_eV);
  /** Red warning text (Vp check says review, Te mismatch) for a manual result. */
  const manualWarn = (r) => [vpInfo(r).level === "review" ? vpInfo(r).text : "", teWarn(r)].filter(Boolean).join("\n\n");
  /** Note under a manual result; says when a 2–5 V Vp difference was confirmed by the Te cross-check. */
  const manualNote = (r) => ["Ion current fit: Iion² = a·V + b.", vpInfo(r).level === "ok" ? vpInfo(r).text : ""].filter(Boolean).join("\n");

  const tePotentialRows = (r) => [
    ["Te from Vp − Vf (cyl. OML)", `${fmtG(r.Te_VpVf_OML_eV, 4)} eV`],
    ["Te from Vp − Vf (planar)", `${fmtG(r.Te_VpVf_planar_eV, 4)} eV`],
  ];

  const ionRows = (r) => [
    [`Ion density ni (OML, ${r.ion_species})`, `${fmtE(r.ni_m3, 5)} m⁻³`],
    ["Ratio ni / ne", fmtG(r.ni_m3 / r.ne_m3, 3)],
  ];

  function probeArea() {
    // Cylindrical probe side area: A = pi d L
    return Math.PI * numberValue("diameter") * 1e-3 * numberValue("length") * 1e-3;
  }

  // ---------------------------------------------------------------------------
  // Theme
  // ---------------------------------------------------------------------------

  function currentTheme() {
    const t = document.documentElement.dataset.theme;
    if (t) return t;
    return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }

  function setTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem("ivcurve.theme", theme); } catch (_) { /* ignore */ }
    for (const b of document.querySelectorAll("#themeSwitch button")) b.setAttribute("aria-pressed", String(b.dataset.theme === theme));
    $("themeName").textContent = theme === "dark" ? "Dark" : "Light";
    // window title bar colour of the installed app
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#2D373C" : "#FFFFFF");
    IV.Plot.rerenderAll();
  }

  // ---------------------------------------------------------------------------
  // Log / results panel
  // ---------------------------------------------------------------------------

  function log(text) {
    $("log").querySelector(".empty-state")?.remove();
    $("log").append(el("div.log-line", { text }));
    $("log").scrollTop = $("log").scrollHeight;
  }

  function resultCard(title, rows, note, time, warning) {
    $("log").querySelector(".empty-state")?.remove();
    time = time || new Date().toLocaleString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    state.cards.push({ title, rows, note, time, warning });
    const dl = el("dl");
    for (const [k, v] of rows) dl.append(el("dt", { text: k }), el("dd", { text: v }));
    const card = el("section.result-card", {}, [
      el("header", {}, [el("h3", { text: title }), el("time", { text: time })]),
      dl,
      warning ? el("p.warn", { text: warning }) : null,
      note ? el("p", { text: note }) : null,
    ]);
    $("log").append(card);
    card.scrollIntoView({ block: "nearest" });
  }

  const status = (text) => { $("statusText").textContent = text; };

  // ---------------------------------------------------------------------------
  // Data loading / plotting
  // ---------------------------------------------------------------------------

  /** RefData can be the x axis only when every scan has a complete RefData series. */
  function updateAxisChoice(scans) {
    const ok = scans.every((s) => s.RefData && s.RefData.length === s.VData.length && s.RefData.every(Number.isFinite));
    const opt = Array.from($("xaxis").options).find((o) => o.value === "RefData");
    opt.disabled = !ok;
    opt.textContent = ok ? "RefData" : "RefData (empty in this file)";
    if (!ok && $("xaxis").value === "RefData") $("xaxis").value = "VData";
  }

  function setScans(scans, name) {
    updateAxisChoice(scans);
    state.rawScans = scans;
    state.scans = scans;
    state.fileName = name;
    // new data invalidates every earlier analysis
    state.omlResults = state.lastResults = state.lastEEPF = null;
    state.params = {};
    state.cards = [];
    $("cropEnable").checked = false;
    resetCropRange();
    applyCrop(false);
    $("fileName").textContent = name;
    $("fileName").title = name;
    $("welcome").classList.add("hidden");
    $("mainPlot").classList.remove("hidden");
    for (const b of document.querySelectorAll("[data-needs-data]")) b.disabled = false;
    log(`Loaded: ${name}`);
    log(`Number of scans: ${scans.length}`);
    log(`Points per scan: ${scans[0].IData.length}`);
    status(`Ready — ${scans.length} scan${scans.length === 1 ? "" : "s"} × ${scans[0].IData.length} points loaded`);
    plotData();
  }

  async function openFile(file) {
    try {
      const text = await file.text();
      const clean = text.replace(/^\uFEFF/, "");
      const looksXML = /^\s*</.test(clean);
      if (/\.ivsession$/i.test(file.name) || /^\s*\{/.test(clean)) {
        loadSession(JSON.parse(clean), file.name);
      } else if (/\.(lda|xml)$/i.test(file.name) || looksXML) {
        const scans = IV.lda.parseLDA(text);
        setScans(scans, file.name);
        for (const note of scans.notes) log(note);
      } else {
        const scans = await IV.csv.importCSV(text, file.name);
        if (scans) setScans(scans, file.name);
      }
    } catch (e) {
      IV.ui.message("Error loading file", IV.escape(e.message));
    }
  }

  // ---------------------------------------------------------------------------
  // Data range reduction (applied before every analysis)
  // ---------------------------------------------------------------------------

  function fullExtent() {
    const xkey = $("xaxis").value;
    let lo = Infinity, hi = -Infinity;
    for (const s of state.rawScans) for (const v of s[xkey]) if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    return [lo, hi];
  }

  function resetCropRange() {
    if (!state.rawScans) return;
    const [lo, hi] = fullExtent();
    const round = (v) => Number(v.toFixed(4));
    $("cropFrom").value = round(lo);
    $("cropTo").value = round(hi);
    $("skipStart").value = 0;
    $("skipEnd").value = 0;
  }

  function readCrop() {
    const int = (id) => Math.max(0, Math.trunc(Number($(id).value) || 0));
    const from = parseFloat($("cropFrom").value), to = parseFloat($("cropTo").value);
    return {
      enabled: $("cropEnable").checked,
      skipStart: int("skipStart"), skipEnd: int("skipEnd"),
      from: Math.min(from, to), to: Math.max(from, to),
    };
  }

  /** Per scan: drop the first/last N acquired points, then keep only from <= x <= to. */
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

  /** Recompute state.scans from the raw data and the Data range panel. */
  function applyCrop(userChange = true) {
    if (!state.rawScans) return;
    const crop = readCrop();
    for (const node of document.querySelectorAll("[data-crop]")) node.disabled = !crop.enabled;
    const info = $("cropInfo");
    const total = state.rawScans[0].IData.length;

    let scans = state.rawScans;
    const xkey = $("xaxis").value;
    if (crop.enabled) {
      const cropped = cropScans(state.rawScans, crop, xkey);
      const fewest = Math.min(...cropped.map((s) => s.IData.length));
      if (fewest < 10) {
        info.textContent = `Range too small: only ${fewest} points left in a scan (need ≥ 10). Not applied.`;
        info.classList.add("warn");
        return;
      }
      scans = cropped;
      info.textContent = `Using ${cropped[0].IData.length} of ${total} points per scan`
        + (state.rawScans.length > 1 ? ` (fewest: ${fewest})` : "") + ".";
    } else {
      info.textContent = `Full curve: ${total} points per scan. Tick the box to reduce it before analysis.`;
    }
    info.classList.remove("warn");

    const changed = JSON.stringify(crop) !== JSON.stringify(state.crop);
    state.crop = crop;
    // up/down branches of a triangular sweep are handled as separate scans
    state.scans = N.splitSweeps(scans, xkey);
    if (state.scans.length > scans.length && !userChange) {
      log(`Up/down sweeps detected: ${state.scans.length - scans.length} scan(s) split into separate branches.`);
    }
    if (userChange && changed && (state.omlResults || state.lastResults)) {
      state.omlResults = state.lastResults = state.lastEEPF = null;
      log("Data range changed — earlier results cleared; run the analysis again.");
    }
    if (userChange) {
      status(crop.enabled ? `Data range: ${info.textContent}` : "Data range reduction off");
      plotData();
    }
  }

  function meanCurve() {
    if (!state.scans) throw new Error("Please load a .lda or .csv file first.");
    const xkey = $("xaxis").value;
    return { xkey, ...N.averageScans(state.scans, xkey) };
  }

  function plotData() {
    if (!state.scans) return;
    const { xkey, x, imean, istd, currents } = meanCurve();
    const traces = [];
    const crop = state.crop;
    let vlines = [], shades = [];
    if (crop.enabled) {
      // faint full-range mean so the removed parts stay visible for reference
      const raw = N.averageScans(state.rawScans, xkey);
      const lo = N.nanmin(raw.x), hi = N.nanmax(raw.x);
      traces.push({ x: raw.x, y: raw.imean, name: "full curve (excluded parts)", width: 1.2, dash: "dot",
        color: getComputedStyle(document.documentElement).getPropertyValue("--text-lo").trim() });
      vlines = [
        { x: crop.from, label: "range start", drag: "cropFrom", dash: "dash" },
        { x: crop.to, label: "range end", drag: "cropTo", dash: "dash" },
      ];
      shades = [{ x0: lo, x1: crop.from }, { x0: crop.to, x1: hi }];
    }
    if ($("showAll").checked) {
      state.scans.forEach((s, k) => traces.push({ x, y: currents[k], name: s.label, width: 1 }));
    }
    if ($("showMean").checked) {
      traces.push({
        x, name: "±1σ",
        band: { lower: imean.map((m, k) => m - istd[k]), upper: imean.map((m, k) => m + istd[k]) },
      });
      traces.push({ x, y: imean, name: "mean", width: 2.6, color: getComputedStyle(document.documentElement).getPropertyValue("--plot-2").trim() });
    }
    mainPlot.render({ title: "Langmuir probe I-V curves", xlabel: xkey, ylabel: "Current (A)", traces, vlines, shades, uirevision: xkey });
  }

  // ---------------------------------------------------------------------------
  // Analyses
  // ---------------------------------------------------------------------------

  function needData() {
    if (state.scans) return true;
    IV.ui.message("No data", "Please load a .lda or .csv file first.");
    return false;
  }

  function runAnalysis() {
    if (!needData()) return;
    try {
      const { xkey, x, imean } = meanCurve();
      const area = probeArea();
      const r = addDerived(N.analyseOML(x, imean, area, numberValue("ionFraction"), numberValue("smoothWindow")), area);
      setOmlResults(r);
      resultCard("Automatic OML-style analysis", [
        ["X axis used", xkey],
        ["Probe area", `${fmtE(area)} m²`],
        ["Floating potential Vf", fmtG(r.Vf, 5)],
        ["Plasma potential Vp", fmtG(r.Vp, 5)],
        ["Electron temperature Te", `${fmtG(r.Te_eV, 5)} eV`],
        ...tePotentialRows(r),
        ["Electron saturation current Ies", `${fmtE(r.Ies_A, 5)} A`],
        ["Electron density ne", `${fmtE(r.ne_m3, 5)} m⁻³`],
        ["Ion current Iis (at Vf)", `${fmtE(r.Iis_A, 5)} A`],
        ...ionRows(r),
        ["Ion fit Iion² slope a", `${fmtE(r.ion_i2_a)} A²/V`],
        ["Ion fit Iion² offset b", `${fmtE(r.ion_i2_b)} A²`],
      ], "Ion current fit: Iion² = a·V + b. First-pass estimate; use manual mode to check fit regions.", undefined, teWarn(r));
      status("Automatic OML analysis done");
    } catch (e) {
      IV.ui.message("Analysis failed", IV.escape(e.message));
    }
  }

  function setOmlResults(r) {
    state.omlResults = r;
    state.lastResults = r;
    state.lastEEPF = null;  // derived from the previous OML result
  }

  function manualCard(r, title = "Manual OML analysis") {
    resultCard(title, [
      ["Floating potential Vf", fmtG(r.Vf, 5)],
      ["Vp from dI/dV", fmtG(r.Vp_dIdV, 5)],
      ["Vp from log-fit intersection", fmtG(r.Vp_intersection, 5)],
      ["Vp check (dI/dV vs intersection)", vpInfo(r).label],
      ["Final plasma potential Vp", fmtG(r.Vp, 5)],
      ["Electron temperature Te", `${fmtG(r.Te_eV, 5)} eV`],
      ...tePotentialRows(r),
      ["Ion current Iis (at Vf)", `${fmtE(r.Iis_A, 5)} A`],
      ...ionRows(r),
      ["Electron saturation current Ies", `${fmtE(r.Ies_A, 5)} A`],
      ["Electron density ne", `${fmtE(r.ne_m3, 5)} m⁻³`],
      ["Ion fit Iion² slope a", `${fmtE(r.ion_i2_a)} A²/V`],
      ["Ion fit Iion² offset b", `${fmtE(r.ion_i2_b)} A²`],
    ], manualNote(r), undefined, manualWarn(r));
  }

  function openManual() {
    if (!needData()) return;
    try {
      const { xkey, x, imean } = meanCurve();
      const area = probeArea();
      IV.openManualOML({
        V: x, I: imean, probeArea: area, ionMass: numberValue("ionMass"), label: `Manual OML on averaged I-V (${xkey})`,
        params: state.params.manual,
        onResults(r) {
          state.params.manual = r.params;
          addDerived(r, area);
          setOmlResults(r);
          manualCard(r);
          // accepted manual analyses are training data (pre-alpha)
          IV.training.addReview({ file: state.fileName, x, imean, xkey, params: r.params, results: r, area, scans: state.rawScans.length })
            .then((added) => { if (added) log("Curve added to the training data."); });
          status("Manual OML results received");
        },
      });
    } catch (e) {
      IV.ui.message("Manual analysis failed", IV.escape(e.message));
    }
  }

  function openEEPF() {
    if (!needData()) return;
    if (!state.omlResults) {
      IV.ui.message("No OML results", "Run automatic or manual OML analysis first.");
      return;
    }
    try {
      const { xkey, x, imean } = meanCurve();
      IV.openEEPF({
        V: x, I: imean, probeArea: probeArea(), oml: state.omlResults,
        title: `EEPF / EEDF from ${xkey} curve`,
        params: state.params.eepf,
        onData(data, params) {
          if (data) state.lastEEPF = data;
          state.params.eepf = params;
        },
      });
    } catch (e) {
      IV.ui.message("EEPF/EEDF failed", IV.escape(e.message));
    }
  }

  function openEPFL() {
    if (!needData()) return;
    try {
      const { xkey, x, imean } = meanCurve();
      IV.openEPFL({
        V: x, I: imean, probeArea: probeArea(), title: `EPFL two-fluid model from ${xkey} curve`,
        params: state.params.epfl,
        onResults(r) {
          state.params.epfl = r.params;
          const t = N.teFromPotentials(r.Vp, r.Vf, numberValue("ionMass"));
          r.Te_VpVf_OML_eV = t.Te_OML_eV;
          r.Te_VpVf_planar_eV = t.Te_planar_eV;
          r.Te_check = teCheck(r);
          state.lastResults = r;
          resultCard("EPFL two-fluid model", [
            ["Fit mode", r.fit_mode],
            ["Floating potential Vf", fmtG(r.Vf, 5)],
            ["Plasma potential Vp", fmtG(r.Vp, 5)],
            ["Electron temperature Te", `${fmtG(r.Te_eV, 5)} eV`],
            ...tePotentialRows(r),
            ["Electron density ne", `${fmtE(r.ne_m3, 5)} m⁻³`],
          ], undefined, undefined, teWarn(r));
          status("EPFL two-fluid results received");
        },
      });
    } catch (e) {
      IV.ui.message("EPFL two-fluid model failed", IV.escape(e.message));
    }
  }

  // ---------------------------------------------------------------------------
  // Saved analysis (.ivsession): data + settings + results in one JSON file
  // ---------------------------------------------------------------------------

  const SESSION_FORMAT = "ivcurve-session";
  const SESSION_VERSION = 1;

  /** JSON-safe copy: typed arrays -> arrays, NaN/Infinity -> null. */
  function plain(value) {
    if (value === null || value === undefined) return null;
    if (ArrayBuffer.isView(value)) return Array.from(value, (v) => (Number.isFinite(v) ? v : null));
    if (Array.isArray(value)) return value.map(plain);
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, plain(v)]));
    return value;
  }

  /** Inverse of plain(): numeric arrays -> Float64Array, null -> NaN. */
  function revive(value) {
    if (Array.isArray(value)) {
      const numeric = value.length > 0 && value.every((v) => v === null || typeof v === "number");
      return numeric ? Float64Array.from(value, (v) => (v === null ? NaN : v)) : value.map(revive);
    }
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, revive(v)]));
    return value === null ? NaN : value;
  }

  function saveSession() {
    if (!needData()) return;
    const settings = { showAll: $("showAll").checked, showMean: $("showMean").checked };
    for (const id of settingInputs) settings[id] = $(id).value;
    const session = {
      format: SESSION_FORMAT,
      format_version: SESSION_VERSION,
      app_version: APP_VERSION,
      saved_at: new Date().toISOString(),
      file_name: state.fileName,
      scans: state.rawScans.map((s) => plain({ id: s.id, label: s.label ?? null, VData: s.VData, RefData: s.RefData, IData: s.IData })),
      settings,
      crop: plain(state.crop),
      params: plain(state.params),
      oml_results: plain(state.omlResults),
      last_results: state.lastResults && state.lastResults === state.omlResults ? "oml" : plain(state.lastResults),
      cards: state.cards,
    };
    const name = `${baseName()}.ivsession`;
    IV.ui.download(name, JSON.stringify(session), "application/json");
    log(`Saved analysis: ${name}`);
    status(`Analysis saved as ${name}`);
  }

  function loadSession(session, fileName) {
    if (!session || session.format !== SESSION_FORMAT) throw new Error("This JSON file is not a saved IV analysis (.ivsession).");
    if (session.format_version > SESSION_VERSION) throw new Error("This analysis was saved by a newer version of the app.");
    const scans = session.scans.map((s) => {
      const r = revive(s);
      if (typeof r.label !== "string") delete r.label;
      return r;
    });

    $("log").replaceChildren();
    for (const [id, v] of Object.entries(session.settings || {})) {
      if (id === "showAll" || id === "showMean") $(id).checked = v;
      else if ($(id)) $(id).value = v;
    }
    syncIonMass();
    setScans(scans, session.file_name || fileName);

    const c = session.crop || {};
    if (c.enabled) {
      $("cropEnable").checked = true;
      $("skipStart").value = c.skipStart ?? 0;
      $("skipEnd").value = c.skipEnd ?? 0;
      if (c.from !== null && c.from !== undefined) $("cropFrom").value = c.from;
      if (c.to !== null && c.to !== undefined) $("cropTo").value = c.to;
    }
    applyCrop(false);
    plotData();

    state.params = revive(session.params || {});
    state.omlResults = session.oml_results ? revive(session.oml_results) : null;
    state.lastResults = session.last_results === "oml" ? state.omlResults
      : (session.last_results ? revive(session.last_results) : null);
    for (const card of session.cards || []) resultCard(card.title, card.rows, card.note, card.time, card.warning);

    log(`Opened saved analysis ${fileName} (saved ${new Date(session.saved_at).toLocaleString()} with app v${session.app_version}).`);
    status(`Saved analysis restored — ${scans.length} scan${scans.length === 1 ? "" : "s"}`);
    saveSettings();
  }

  // ---------------------------------------------------------------------------
  // Export
  // ---------------------------------------------------------------------------

  const csvCell = (v) => {
    if (typeof v === "number") {
      if (!Number.isFinite(v)) return "nan";
      return v !== 0 && Math.abs(v) < 1e-4 ? v.toExponential() : String(v);
    }
    const s = String(v ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csvRow = (cells) => cells.map(csvCell).join(",");
  const baseName = () => (state.fileName || "langmuir").replace(/\.[^.]+$/, "");

  function exportMeanCSV() {
    if (!needData()) return;
    const { xkey, x, imean, istd } = meanCurve();
    const lines = [`${xkey},I_mean_A,I_std_A`];
    for (let k = 0; k < x.length; k++) lines.push(csvRow([x[k], imean[k], istd[k]]));
    IV.ui.download(`${baseName()}_mean_iv.csv`, lines.join("\n") + "\n", "text/csv");
    log(`Saved mean curve: ${baseName()}_mean_iv.csv`);
  }

  function exportAllCSV() {
    if (!needData()) return;
    try {
      const { xkey, x, imean, istd, currents } = meanCurve();
      const area = probeArea();
      if (!state.lastEEPF && state.omlResults) {
        const p = state.params.eepf;  // same settings as last used in the EEPF window
        state.lastEEPF = p
          ? N.computeEEPF(x, imean, area, state.omlResults, p.d2Smooth, p.eMin, p.distSmooth)
          : N.computeEEPF(x, imean, area, state.omlResults, numberValue("smoothWindow"), 0, 9);
      }
      const out = [];
      out.push(csvRow(["Langmuir probe full export"]));
      out.push(csvRow(["x axis", xkey]));
      out.push(csvRow(["probe area m2", area]));
      const c = state.crop;
      out.push(csvRow(["data range reduction", c.enabled ? "on" : "off"]));
      if (c.enabled) {
        out.push(csvRow(["skipped first points", c.skipStart]));
        out.push(csvRow(["skipped last points", c.skipEnd]));
        out.push(csvRow([`${xkey} range from`, c.from]));
        out.push(csvRow([`${xkey} range to`, c.to]));
      }
      out.push("");
      out.push(csvRow(["Analysis results"]));
      if (state.lastResults) {
        for (const [k, v] of Object.entries(state.lastResults)) {
          if (typeof v === "number" || typeof v === "string") out.push(csvRow([k, v]));
        }
      } else {
        out.push(csvRow(["No OML / EPFL analysis results available"]));
      }
      out.push("");
      out.push(csvRow(["IV curve"]));
      out.push(csvRow([xkey, "I_mean_A", "I_std_A", ...state.scans.map((s) => `${s.label.replace(/\s+/g, "_")}_I_A`)]));
      for (let n = 0; n < x.length; n++) out.push(csvRow([x[n], imean[n], istd[n], ...currents.map((c) => c[n])]));
      out.push("");
      out.push(csvRow(["EEDF / EEPF"]));
      if (state.lastEEPF) {
        const e = state.lastEEPF;
        out.push(csvRow(["n from EEDF (m^-3)", e.n_EEDF_m3]));
        out.push(csvRow(["E_eV", "EEDF_raw_m-3_eV-1", "EEDF_smooth_m-3_eV-1", "EEPF_raw_m-3_eV-3/2", "EEPF_smooth_m-3_eV-3/2"]));
        for (let n = 0; n < e.E_eV.length; n++) out.push(csvRow([e.E_eV[n], e.EEDF[n], e.EEDF_smooth[n], e.EEPF[n], e.EEPF_smooth[n]]));
      } else {
        out.push(csvRow(["No EEDF / EEPF data available. Run OML then EEPF first."]));
      }
      IV.ui.download(`${baseName()}_full_analysis.csv`, out.join("\n") + "\n", "text/csv");
      log(`Saved full analysis CSV: ${baseName()}_full_analysis.csv`);
    } catch (e) {
      IV.ui.message("Export failed", IV.escape(e.message));
    }
  }

  // ---------------------------------------------------------------------------
  // What's new / about
  // ---------------------------------------------------------------------------

  /** Newest first. Add an entry (and bump APP_VERSION) for every release. */
  const CHANGELOG = [
    {
      version: "2.5.0-alpha.1",
      title: "Pre-alpha: training data for machine learning",
      items: [
        "Every curve you review and accept (batch review or manual OML) is added to a local training set; Training data α shows the progress towards 200 curves and exports it as one .ivtrain file.",
        "The batch review can take its proposals from a trained model (once one is shipped with the app); until then it uses the rules of the beta.",
        "This is a pre-alpha for collecting data and testing; use the stable version for your results.",
      ],
    },
    {
      version: "2.4.0-beta.4",
      title: "Vp check in volts",
      items: [
        "Vp check now in volts: Vp from the dI/dV peak and from the fit intersection within 2 V is ✓ good; 2–5 V is ok only if Te from Vp − Vf confirms the fitted Te; above 5 V (or 2–5 V without that confirmation) the curve should be reviewed by eye (red warning). Exported as Vp_difference_V and Vp_check (good / ok / review).",
        "Batch review: the ΔVp column is in volts; curves that need review by this rule are marked “⚠ check”.",
      ],
    },
    {
      version: "2.4.0-beta.3",
      title: "Vp check",
      items: [
        "Validation of the manual analysis: Vp from the dI/dV peak and Vp from the fit intersection should agree within 5–10 % of Vp. The agreement is shown in the results (✓ ≤ 5 %, acceptable 5–10 %), a red warning appears above 10 %, and it is exported (Vp_agreement_pct, Vp_check). Not checked when Vp is within 1 V of 0 V.",
        "Batch review: a ΔVp column, and curves with more than 10 % between the two Vp values are marked “⚠ check” (replaces the earlier rule based on Te).",
      ],
    },
    {
      version: "2.4.0-beta.2",
      title: "Fix",
      items: [
        "After an update, browsers could keep running an old copy of the program for a few minutes; every file now has the version in its address, so an update always loads completely.",
      ],
    },
    {
      version: "2.4.0-beta.1",
      title: "Beta: assisted batch review",
      items: [
        "Batch review: load a whole series of .lda/.csv files, give each a parameter (position, pressure, power…), and let the app propose fit regions for every curve.",
        "Each curve gets a status: ✓ good, ⚠ check (with the reasons) or ✗ failed. You review curves in the manual OML window, pre-filled with the proposal or with the regions of the previous accepted curve; “Accept & next” moves on.",
        "The Results tab of the manual OML window now shows an overview of ln(Ie) with both fits, to judge a curve at a glance.",
        "Summary plot of Te, ne, ni, Vp, Vf against your parameter, CSV export of the table, and Save/Open batch to continue later.",
        "This is a beta: the stable version stays at /web/.",
      ],
    },
    {
      version: "2.3.0",
      title: "Te from Vp − Vf",
      items: [
        "Cross-check of Te from the potential difference Vp − Vf, shown next to Te in the automatic, manual and EPFL results: once for a cylindrical probe in OML theory (thick sheath, same ion model as the ion fit; factor ≈ 4.7 for Ar) and once for a planar sheath with Bohm flux (thin sheath; factor ≈ 5.2 for Ar). It uses the ion species from Probe / OML settings.",
        "Red warning when the fitted Te is more than 30 % outside the Vp − Vf range (also on the Results tab of the manual analysis).",
        "Automatic physics tests (web/tests) and a README section on installing the app."
      ],
    },
    {
      version: "2.2.1",
      title: "Fix",
      items: [
        ".lda files with an empty or missing RefData load again (RefData is then unavailable as x axis; VData is used).",
        "Empty voltage or current values in an .lda file are skipped instead of blocking the import.",
      ],
    },
    {
      version: "2.2.0",
      title: "Ion density and saved analyses",
      items: [
        "Ion density nᵢ from the slope of the ion-current fit (OML, cylindrical probe), with the ratio nᵢ/nₑ. Choose the ion species (Ar⁺, He⁺, H₂⁺, …) or a custom mass in Probe / OML settings.",
        "Save analysis (Save / Export menu or Ctrl+S): one .ivsession file with the data, settings, data range, fit regions and results. Open it again like a data file to continue exactly where you stopped.",
        "Manual OML, EEPF and EPFL windows remember their last settings and fit regions for the current data; “Start over” returns to the defaults.",
      ],
    },
    {
      version: "2.1.0",
      title: "Install as an app, works offline",
      items: [
        "Install the analyser as an app (Chrome/Edge: “Install app” button or the icon in the address bar; Safari: Share → Add to Dock / Home Screen). It gets its own icon and window.",
        "Works without internet after the first visit; the status bar shows when the saved copy is used.",
        "When online, the newest version is always loaded and saved for offline use.",
        "Installed in Chrome/Edge, .lda and .csv files can be opened directly with “Open with → IV Analyser”.",
      ],
    },
    {
      version: "2.0.0",
      title: "Browser edition",
      items: [
        "Runs in the browser — nothing to install, files stay on your computer.",
        "University of Basel light and dark theme.",
        "CSV and text files can be imported next to .lda, with column, unit and preview selection.",
        "Data range panel: skip the first/last points of each sweep and/or keep a voltage window before analysis.",
        "EEDF and EEPF were swapped; both are now given per eV, and the EEPF window shows the density from the EEDF next to the OML ne.",
        "Iis is now the ion current at Vf (it was taken at 0 V).",
        "EPFL two-fluid model can no longer overflow; rebinning keeps the last point.",
        "Up/down sweeps are kept as separate curves instead of being mixed in the average.",
        "This “What’s new” window replaces the update check: the web version is always up to date.",
      ],
    },
  ];
  // separate from the stable app in /web/ (same origin), so switching between them does not re-announce
  const SEEN_KEY = "ivcurve-alpha.lastSeenVersion";

  function showWhatsNew() {
    const html = CHANGELOG.map((rel) =>
      `<h3 style="font-size:15px;margin:0 0 4px">Version ${IV.escape(rel.version)}`
      + (rel.title ? ` <span class="muted" style="font-family:var(--font);font-size:12px">· ${IV.escape(rel.title)}</span>` : "")
      + `</h3><ul style="margin:0 0 14px;padding-left:18px">`
      + rel.items.map((it) => `<li style="margin:3px 0">${IV.escape(it)}</li>`).join("")
      + "</ul>").join("");
    IV.ui.message("What’s new", html);
    try { localStorage.setItem(SEEN_KEY, APP_VERSION); } catch (_) { /* ignore */ }
  }

  /** Open "What's new" once after the app was updated (not on a first visit). */
  function announceUpdate() {
    let seen = null;
    try { seen = localStorage.getItem(SEEN_KEY); } catch (_) { return; }
    if (seen === APP_VERSION) return;
    if (seen === null) {
      try { localStorage.setItem(SEEN_KEY, APP_VERSION); } catch (_) { /* ignore */ }
      return;
    }
    showWhatsNew();
  }

  function showAbout() {
    IV.ui.message("About",
      `<p style="font-family:var(--font-heading);font-size:16px;margin:0 0 4px">Langmuir Probe IV Analyser UB</p>
       <p class="muted" style="margin:0 0 10px">Version ${IV.escape(APP_VERSION)} · browser edition</p>
       <p style="margin:0">by P. Hiret<br>Universität Basel<br><a href="mailto:paul.hiret@unibas.ch">paul.hiret@unibas.ch</a></p>
       <p class="muted" style="margin:12px 0 0;font-size:12px">Licensed under Creative Commons Attribution-NonCommercial 4.0 International.
       Runs entirely in your browser — files are never uploaded.</p>`);
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  let mainPlot;

  function init() {
    fillIonSpecies();
    loadSettings();
    syncIonMass();
    mainPlot = new IV.Plot($("mainPlot"), { filename: "iv_curves" });
    // dragging the range lines on the main plot edits the Data range fields
    mainPlot.onDrag = (id, x, final) => {
      $(id).value = Number(x.toFixed(4));
      if (final) applyCrop();
    };

    const fileInput = $("fileInput");
    $("openBtn").addEventListener("click", () => fileInput.click());
    $("welcomeOpen").addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => { if (fileInput.files[0]) openFile(fileInput.files[0]); fileInput.value = ""; });
    const loadExample = () => setScans(IV.lda.exampleScans(), "example (synthetic, Te = 3 eV, Vp = 10 V)");
    $("exampleBtn").addEventListener("click", loadExample);
    $("welcomeExample").addEventListener("click", loadExample);

    $("analyseBtn").addEventListener("click", runAnalysis);
    $("manualBtn").addEventListener("click", openManual);
    $("eepfBtn").addEventListener("click", openEEPF);
    $("epflBtn").addEventListener("click", openEPFL);
    $("exportMean").addEventListener("click", () => { closeMenus(); exportMeanCSV(); });
    $("exportAll").addEventListener("click", () => { closeMenus(); exportAllCSV(); });
    $("whatsNewBtn").addEventListener("click", showWhatsNew);
    $("batchBtn").addEventListener("click", () => IV.openBatch());
    $("aboutBtn").addEventListener("click", showAbout);
    $("clearLog").addEventListener("click", () => {
      state.cards = [];
      $("log").replaceChildren(el("div.empty-state", { text: "Log cleared." }));
    });
    $("saveSession").addEventListener("click", () => { closeMenus(); saveSession(); });

    for (const id of ["showAll", "showMean"]) $(id).addEventListener("change", () => { saveSettings(); plotData(); });
    $("xaxis").addEventListener("change", () => {
      saveSettings();
      // the voltage window is expressed on the selected axis, so start it afresh
      const from = $("cropFrom").value, to = $("cropTo").value;
      const [lo, hi] = state.rawScans ? fullExtent() : [NaN, NaN];
      if (state.rawScans) { $("cropFrom").value = Number(lo.toFixed(4)); $("cropTo").value = Number(hi.toFixed(4)); }
      if (state.crop.enabled && (from !== $("cropFrom").value || to !== $("cropTo").value)) log("X axis changed — voltage range reset to the full extent.");
      applyCrop();
    });
    $("cropEnable").addEventListener("change", () => applyCrop());
    for (const id of ["skipStart", "skipEnd", "cropFrom", "cropTo"]) $(id).addEventListener("change", () => applyCrop());
    $("cropReset").addEventListener("click", () => { resetCropRange(); applyCrop(); });
    $("ionGas").addEventListener("change", () => { syncIonMass(); saveSettings(); });
    for (const id of ["diameter", "length", "ionFraction", "smoothWindow", "ionMass"]) {
      $(id).addEventListener("change", () => {
        if (id === "smoothWindow" && Number.isFinite(parseFloat($(id).value))) {
          $(id).value = Math.min(501, N.makeOdd(parseFloat($(id).value)));  // the window actually used
        }
        try { numberValue(id); saveSettings(); } catch (_) { /* flagged red */ }
      });
    }

    // export dropdown
    const menuBtn = $("exportBtn"), menu = $("exportMenu");
    const closeMenus = () => { menu.classList.remove("open"); menuBtn.setAttribute("aria-expanded", "false"); };
    menuBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const open = !menu.classList.contains("open");
      menu.classList.toggle("open", open);
      menuBtn.setAttribute("aria-expanded", String(open));
      if (open) menu.querySelector("button").focus();
    });
    document.addEventListener("click", closeMenus);
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenus(); });

    // theme
    for (const b of document.querySelectorAll("#themeSwitch button")) b.addEventListener("click", () => setTheme(b.dataset.theme));
    setTheme(currentTheme());
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      let stored = null;
      try { stored = localStorage.getItem("ivcurve.theme"); } catch (_) { /* ignore */ }
      if (!stored) setTheme(currentTheme());
    });

    // drag & drop anywhere
    const drop = $("dropzone");
    let depth = 0;
    window.addEventListener("dragenter", (e) => { if ([...e.dataTransfer.types].includes("Files")) { depth++; drop.classList.add("show"); } });
    window.addEventListener("dragleave", () => { depth = Math.max(0, depth - 1); if (!depth) drop.classList.remove("show"); });
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => {
      e.preventDefault();
      depth = 0;
      drop.classList.remove("show");
      const f = e.dataTransfer.files[0];
      if (f) openFile(f);
    });

    // keyboard shortcuts
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") { e.preventDefault(); fileInput.click(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") { e.preventDefault(); if (state.scans) saveSession(); }
    });

    $("version").textContent = `v${APP_VERSION}`;
    status("Ready — open a .lda file or drop it on the window");
    setTimeout(announceUpdate, 800);
  }

  document.addEventListener("DOMContentLoaded", init);
  IV.state = state;
  IV.openFile = openFile;

  // ---------------------------------------------------------------------------
  // Helpers for the batch review window (same settings as the main window)
  // ---------------------------------------------------------------------------
  IV.app = {
    /** Mean curve of a file's scans with the main window's x axis and data range. */
    curveFor(rawScans) {
      const xkey = $("xaxis").value;
      const crop = readCrop();
      let scans = rawScans;
      if (crop.enabled) {
        scans = cropScans(rawScans, crop, xkey);
        if (Math.min(...scans.map((s) => s.IData.length)) < 10) throw new Error("The data range leaves fewer than 10 points.");
      }
      const avg = N.averageScans(N.splitSweeps(scans, xkey), xkey);
      return { xkey, x: avg.x, imean: avg.imean };
    },
    probeArea,
    ionMass: () => numberValue("ionMass"),
    /** Adds ni, Te from Vp − Vf and the Te check, as for the main window's results. */
    addDerived,
    settingsSummary() {
      const c = readCrop();
      return `Probe ${$("diameter").value} × ${$("length").value} mm · ${$("ionGas").value} (${$("ionMass").value} amu) · x axis ${$("xaxis").value}`
        + (c.enabled ? ` · data range: skip ${c.skipStart}/${c.skipEnd} pts, ${c.from}…${c.to} V` : " · full data range");
    },
    settingsSnapshot() {
      const out = { showAll: $("showAll").checked, showMean: $("showMean").checked, crop: readCrop() };
      for (const id of settingInputs) out[id] = $(id).value;
      return out;
    },
    /** Opens a batch item in the main window with its reviewed regions and results. */
    loadIntoMain(item) {
      setScans(item.scans, item.name);
      if (item.params) state.params.manual = item.params;
      if (item.results && (item.status === "accepted" || item.status === "auto")) {
        setOmlResults(item.results);
        manualCard(item.results, item.status === "accepted" ? "Batch review result" : "Batch result (accepted without review)");
      }
    },
    log,
  };
})(window.IV = window.IV || {});
