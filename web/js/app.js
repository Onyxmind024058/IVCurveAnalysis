/* =============================================================================
   Main window (port of LDAApp)
   ============================================================================= */
(function (IV) {
  "use strict";
  const N = IV.num;
  const { el, fmtG, fmtE, toast } = IV.ui;

  const APP_VERSION = "0.9a";
  const GITHUB_OWNER = "Onyxmind024058";
  const GITHUB_REPO = "IVcurveAnalysis";
  const SETTINGS_KEY = "ivcurve.settings.v1";

  IV.APP_VERSION = APP_VERSION;
  IV.escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const $ = (id) => document.getElementById(id);

  const state = {
    scans: null,
    fileName: null,
    omlResults: null,      // latest automatic or manual OML result (feeds EEPF)
    lastResults: null,     // latest result of any method (exported)
    lastEEPF: null,
  };

  // ---------------------------------------------------------------------------
  // Settings (per-browser convenience only)
  // ---------------------------------------------------------------------------

  const settingInputs = ["diameter", "length", "ionFraction", "smoothWindow", "xaxis"];

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

  function resultCard(title, rows, note) {
    $("log").querySelector(".empty-state")?.remove();
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    const dl = el("dl");
    for (const [k, v] of rows) dl.append(el("dt", { text: k }), el("dd", { text: v }));
    const card = el("section.result-card", {}, [
      el("header", {}, [el("h3", { text: title }), el("time", { text: time })]),
      dl,
      note ? el("p", { text: note }) : null,
    ]);
    $("log").append(card);
    card.scrollIntoView({ block: "nearest" });
  }

  const status = (text) => { $("statusText").textContent = text; };

  // ---------------------------------------------------------------------------
  // Data loading / plotting
  // ---------------------------------------------------------------------------

  function setScans(scans, name) {
    state.scans = scans;
    state.fileName = name;
    // new data invalidates every earlier analysis
    state.omlResults = state.lastResults = state.lastEEPF = null;
    $("fileName").textContent = name;
    $("fileName").title = name;
    $("welcome").classList.add("hidden");
    $("mainPlot").classList.remove("hidden");
    for (const b of document.querySelectorAll("[data-needs-data]")) b.disabled = false;
    log(`Loaded: ${name}`);
    log(`Number of scans: ${scans.length}`);
    log(`Points per scan: ${scans[0].IData.length}`);
    status(`Ready — ${scans.length} scans × ${scans[0].IData.length} points loaded`);
    plotData();
  }

  async function openFile(file) {
    try {
      const text = await file.text();
      setScans(IV.lda.parseLDA(text), file.name);
    } catch (e) {
      IV.ui.message("Error loading file", IV.escape(e.message));
    }
  }

  function meanCurve() {
    if (!state.scans) throw new Error("Please load a .lda file first.");
    const xkey = $("xaxis").value;
    return { xkey, ...N.averageScans(state.scans, xkey) };
  }

  function plotData() {
    if (!state.scans) return;
    const { xkey, x, imean, istd, currents } = meanCurve();
    const traces = [];
    if ($("showAll").checked) {
      state.scans.forEach((s, k) => traces.push({ x, y: currents[k], name: `scan ${s.id}`, width: 1 }));
    }
    if ($("showMean").checked) {
      traces.push({
        x, name: "±1σ",
        band: { lower: imean.map((m, k) => m - istd[k]), upper: imean.map((m, k) => m + istd[k]) },
      });
      traces.push({ x, y: imean, name: "mean", width: 2.6, color: getComputedStyle(document.documentElement).getPropertyValue("--plot-2").trim() });
    }
    mainPlot.render({ title: "Langmuir probe I-V curves", xlabel: xkey, ylabel: "Current (A)", traces, uirevision: xkey });
  }

  // ---------------------------------------------------------------------------
  // Analyses
  // ---------------------------------------------------------------------------

  function needData() {
    if (state.scans) return true;
    IV.ui.message("No data", "Please load a .lda file first.");
    return false;
  }

  function runAnalysis() {
    if (!needData()) return;
    try {
      const { xkey, x, imean } = meanCurve();
      const area = probeArea();
      const r = N.analyseOML(x, imean, area, numberValue("ionFraction"), numberValue("smoothWindow"));
      setOmlResults(r);
      resultCard("Automatic OML-style analysis", [
        ["X axis used", xkey],
        ["Probe area", `${fmtE(area)} m²`],
        ["Floating potential Vf", fmtG(r.Vf, 5)],
        ["Plasma potential Vp", fmtG(r.Vp, 5)],
        ["Electron temperature Te", `${fmtG(r.Te_eV, 5)} eV`],
        ["Electron saturation current Ies", `${fmtE(r.Ies_A, 5)} A`],
        ["Electron density ne", `${fmtE(r.ne_m3, 5)} m⁻³`],
        ["Ion fit Iion² slope a", `${fmtE(r.ion_i2_a)} A²/V`],
        ["Ion fit Iion² offset b", `${fmtE(r.ion_i2_b)} A²`],
      ], "Ion current fit: Iion² = a·V + b. First-pass estimate; use manual mode to check fit regions.");
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

  function openManual() {
    if (!needData()) return;
    try {
      const { xkey, x, imean } = meanCurve();
      IV.openManualOML({
        V: x, I: imean, probeArea: probeArea(), label: `Manual OML on averaged I-V (${xkey})`,
        onResults(r) {
          setOmlResults(r);
          resultCard("Manual OML analysis", [
            ["Floating potential Vf", fmtG(r.Vf, 5)],
            ["Vp from dI/dV", fmtG(r.Vp_dIdV, 5)],
            ["Vp from log-fit intersection", fmtG(r.Vp_intersection, 5)],
            ["Final plasma potential Vp", fmtG(r.Vp, 5)],
            ["Electron temperature Te", `${fmtG(r.Te_eV, 5)} eV`],
            ["Ion saturation current Iis", `${fmtE(r.Iis_A, 5)} A`],
            ["Electron saturation current Ies", `${fmtE(r.Ies_A, 5)} A`],
            ["Electron density ne", `${fmtE(r.ne_m3, 5)} m⁻³`],
            ["Ion fit Iion² slope a", `${fmtE(r.ion_i2_a)} A²/V`],
            ["Ion fit Iion² offset b", `${fmtE(r.ion_i2_b)} A²`],
          ], "Ion current fit: Iion² = a·V + b.");
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
        onData(data) { if (data) state.lastEEPF = data; },
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
        onResults(r) {
          state.lastResults = r;
          resultCard("EPFL two-fluid model", [
            ["Fit mode", r.fit_mode],
            ["Floating potential Vf", fmtG(r.Vf, 5)],
            ["Plasma potential Vp", fmtG(r.Vp, 5)],
            ["Electron temperature Te", `${fmtG(r.Te_eV, 5)} eV`],
            ["Electron density ne", `${fmtE(r.ne_m3, 5)} m⁻³`],
          ]);
          status("EPFL two-fluid results received");
        },
      });
    } catch (e) {
      IV.ui.message("EPFL two-fluid model failed", IV.escape(e.message));
    }
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
        state.lastEEPF = N.computeEEPF(x, imean, area, state.omlResults, numberValue("smoothWindow"), 0, 9);
      }
      const out = [];
      out.push(csvRow(["Langmuir probe full export"]));
      out.push(csvRow(["x axis", xkey]));
      out.push(csvRow(["probe area m2", area]));
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
      out.push(csvRow([xkey, "I_mean_A", "I_std_A", ...state.scans.map((s) => `scan_${s.id}_I_A`)]));
      for (let n = 0; n < x.length; n++) out.push(csvRow([x[n], imean[n], istd[n], ...currents.map((c) => c[n])]));
      out.push("");
      out.push(csvRow(["EEDF / EEPF"]));
      if (state.lastEEPF) {
        const e = state.lastEEPF;
        out.push(csvRow(["E_eV", "EEDF_raw", "EEDF_smooth", "EEPF_raw", "EEPF_smooth"]));
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
  // Updates / about
  // ---------------------------------------------------------------------------

  async function checkForUpdates(silent) {
    let release;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const resp = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json" }, signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!resp.ok) throw new Error(`GitHub returned an error: HTTP ${resp.status}`);
      release = await resp.json();
    } catch (e) {
      if (!silent) IV.ui.message("Update check failed", IV.escape(e.message || "Could not reach GitHub."));
      return;
    }
    const tag = String(release.tag_name || "").trim();
    if (!tag) {
      if (!silent) IV.ui.message("Updates", "No valid release tag found on GitHub.");
      return;
    }
    if (!N.isNewerVersion(tag, APP_VERSION)) {
      if (!silent) IV.ui.message("No update available", `You already have the latest version (${APP_VERSION}).`);
      return;
    }
    const notes = String(release.body || "").trim().slice(0, 3000);
    const choice = await IV.ui.message("Update available",
      `<p>A newer version is available.</p><p>Current version: <b>${IV.escape(APP_VERSION)}</b><br>Latest version: <b>${IV.escape(N.normalizeVersion(tag))}</b></p>`
      + (release.name ? `<p>${IV.escape(release.name)}</p>` : "")
      + (notes ? `<details><summary>Release notes</summary><pre style="white-space:pre-wrap;font-size:12px">${IV.escape(notes)}</pre></details>` : ""),
      [{ label: "Close" }, { label: "Open release page", value: "open", primary: true }]);
    if (choice === "open" && release.html_url) window.open(release.html_url, "_blank", "noopener");
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
    loadSettings();
    mainPlot = new IV.Plot($("mainPlot"), { filename: "iv_curves" });

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
    $("updatesBtn").addEventListener("click", () => checkForUpdates(false));
    $("aboutBtn").addEventListener("click", showAbout);
    $("clearLog").addEventListener("click", () => $("log").replaceChildren(el("div.empty-state", { text: "Log cleared." })));

    for (const id of ["xaxis", "showAll", "showMean"]) $(id).addEventListener("change", () => { saveSettings(); plotData(); });
    for (const id of ["diameter", "length", "ionFraction", "smoothWindow"]) {
      $(id).addEventListener("change", () => { try { numberValue(id); saveSettings(); } catch (_) { /* flagged red */ } });
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
    });

    $("version").textContent = `v${APP_VERSION}`;
    status("Ready — open a .lda file or drop it on the window");
    setTimeout(() => checkForUpdates(true), 1500);
  }

  document.addEventListener("DOMContentLoaded", init);
  IV.state = state;
})(window.IV = window.IV || {});
