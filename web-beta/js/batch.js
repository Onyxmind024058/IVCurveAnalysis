/* =============================================================================
   Assisted batch review (beta).

   1. Add a series of .lda/.csv files; give each one a parameter value.
   2. Every curve gets automatic fit-region proposals and a status:
      good / check (with reasons) / failed.
   3. Review the curves one after the other in the manual OML window,
      pre-filled with the proposal or with the previous accepted regions;
      "Accept & next" moves on.
   4. Summary plot against the parameter, CSV export, save/open batch.

   The list stays while the page is open (closing the window keeps it).
   Settings (probe, ion species, x axis, data range, smoothing) come from
   the main window.
   ============================================================================= */
(function (IV) {
  "use strict";
  const N = IV.num;
  const A = IV.auto;
  const { el, fmtG, fmtE } = IV.ui;

  const STATUS = {
    pending: { text: "…", title: "Not analysed yet" },
    good: { text: "✓ good", title: "Proposal passed all checks — still to be reviewed" },
    check: { text: "⚠ check", title: "Proposal has warnings — review carefully" },
    failed: { text: "✗ failed", title: "No automatic proposal — set the regions by hand" },
    accepted: { text: "✔ reviewed", title: "Reviewed and accepted in the manual window" },
    auto: { text: "✓ unreviewed", title: "Accepted with “Accept all good” without opening it" },
    rejected: { text: "— skipped", title: "Marked not analysable" },
  };
  const DONE = new Set(["accepted", "auto", "rejected"]);

  const VARIABLES = [
    ["Te_eV", "Te (eV)"], ["ne_m3", "ne (m⁻³)"], ["ni_m3", "ni (m⁻³)"], ["Vp", "Vp (V)"], ["Vf", "Vf (V)"],
    ["Te_VpVf_OML_eV", "Te from Vp − Vf, OML (eV)"], ["Iis_A", "Iis at Vf (A)"], ["Ies_A", "Ies (A)"],
  ];

  const batch = { paramName: "Parameter", items: [], csvMapping: null, startFrom: "proposal", variable: "Te_eV", selected: -1 };
  let nextId = 1;
  let ui = null;  // open window, if any

  // ---------------------------------------------------------------------------
  // Loading files
  // ---------------------------------------------------------------------------

  async function readScans(file) {
    const text = await file.text();
    const clean = text.replace(/^﻿/, "");
    if (/\.(lda|xml)$/i.test(file.name) || /^\s*</.test(clean)) return IV.lda.parseLDA(clean);
    if (batch.csvMapping) {
      try { return IV.csv.applyMapping(clean, batch.csvMapping); } catch (_) { /* different layout: ask */ }
    }
    const scans = await IV.csv.importCSV(clean, file.name);
    if (scans && scans.mapping) batch.csvMapping = scans.mapping;
    return scans;
  }

  async function addFiles(files) {
    const list = Array.from(files).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const file of list) {
      if (/\.ivbatch$/i.test(file.name)) { await openBatchFile(file); continue; }
      try {
        const scans = await readScans(file);
        if (!scans) continue;
        const item = { id: nextId++, name: file.name, scans: Array.from(scans), param: guessParam(file.name), status: "pending", reviewed: false };
        batch.items.push(item);
        analyse(item);
      } catch (e) {
        IV.ui.toast(`${file.name}: ${e.message}`, "error", "Could not read file");
      }
      render();
    }
  }

  /** A number in the file name is a good first guess for the parameter (e.g. "pos_12.5mm.lda"). */
  function guessParam(name) {
    const m = name.replace(/\.[^.]+$/, "").match(/-?\d+(?:[.,]\d+)?(?!.*\d)/);
    return m ? m[0].replace(",", ".") : "";
  }

  // ---------------------------------------------------------------------------
  // Proposal and review
  // ---------------------------------------------------------------------------

  /** Automatic proposal for one item (does not touch reviewed items' results). */
  function analyse(item) {
    try {
      const { x, imean } = IV.app.curveFor(item.scans);
      const area = IV.app.probeArea();
      const { params, results } = A.proposeOML(x, imean, area);
      IV.app.addDerived(results, area);
      item.proposal = params;
      item.proposalFlags = A.qualityFlags(results, results);
      item.error = null;
      if (!item.reviewed) {
        item.params = params;
        item.results = results;
        item.flags = item.proposalFlags;
        item.status = item.flags.length ? "check" : "good";
      }
    } catch (e) {
      item.proposal = null;
      item.error = e.message;
      if (!item.reviewed) {
        item.params = null;
        item.results = null;
        item.flags = [e.message];
        item.status = "failed";
      }
    }
  }

  /** Regions to start the review from: own reviewed ones, else the previous accepted curve's, else the proposal. */
  function startParams(index) {
    const item = batch.items[index];
    if (item.reviewed && item.params) return item.params;
    if (batch.startFrom === "previous") {
      for (let k = index - 1; k >= 0; k--) {
        const prev = batch.items[k];
        if (prev.status === "accepted" && prev.params && prev.params.analysable !== false) return prev.params;
      }
    }
    return item.proposal || undefined;
  }

  function review(index) {
    const item = batch.items[index];
    if (!item) return;
    select(index);
    let curve;
    try { curve = IV.app.curveFor(item.scans); } catch (e) { IV.ui.message("Cannot review", IV.escape(e.message)); return; }
    const area = IV.app.probeArea();
    const left = batch.items.filter((it) => !DONE.has(it.status)).length;
    IV.openManualOML({
      V: curve.x, I: curve.imean, probeArea: area, ionMass: IV.app.ionMass(),
      title: `Review ${index + 1} / ${batch.items.length} — ${item.name}${batch.paramName ? ` · ${batch.paramName} = ${item.param || "?"}` : ""}`,
      label: item.name,
      params: startParams(index),
      acceptLabel: left > 1 ? "Accept & next ▶" : "Accept",
      onSkip: () => setTimeout(() => reviewNext(index), 0),
      onResults(r) {
        IV.app.addDerived(r, area);
        let flags = [];
        if (r.params && r.params.analysable !== false) {
          try { flags = A.qualityFlags({ ...r, diag: A.runOMLSteps(curve.x, curve.imean, area, r.params).diag }, r); } catch (_) { /* keep empty */ }
        }
        Object.assign(item, {
          results: r, params: r.params, flags, reviewed: true,
          status: r.params && r.params.analysable === false ? "rejected" : "accepted",
        });
        render();
        setTimeout(() => reviewNext(index), 0);
      },
    });
  }

  /** Opens the next curve that still needs a human look (after `from`, wrapping around). */
  function reviewNext(from = -1) {
    const n = batch.items.length;
    for (let s = 1; s <= n; s++) {
      const k = (from + s + n) % n;
      if (!DONE.has(batch.items[k].status)) { review(k); return; }
    }
    if (n) IV.ui.toast("All curves are reviewed.");
  }

  async function acceptAllGood() {
    const good = batch.items.filter((it) => it.status === "good");
    if (!good.length) { IV.ui.toast("No curves with status “good” to accept."); return; }
    const ok = await IV.ui.message("Accept all good curves?",
      `<p>${good.length} curve${good.length > 1 ? "s" : ""} passed every automatic check. They will be accepted <b>without opening them</b> and marked “✓ unreviewed” in the table and the export.</p>
       <p class="muted">Curves with “⚠ check” or “✗ failed” still have to be reviewed.</p>`,
      [{ label: "Cancel" }, { label: "Accept without review", value: "yes", primary: true }]);
    if (ok !== "yes") return;
    for (const it of good) it.status = "auto";
    render();
  }

  // ---------------------------------------------------------------------------
  // Save / open / export
  // ---------------------------------------------------------------------------

  /** JSON-safe copy (typed arrays -> arrays, NaN -> null) and back. */
  function plain(v) {
    if (v === null || v === undefined) return null;
    if (ArrayBuffer.isView(v)) return Array.from(v, (x) => (Number.isFinite(x) ? x : null));
    if (Array.isArray(v)) return v.map(plain);
    if (typeof v === "number") return Number.isFinite(v) ? v : null;
    if (typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => k !== "diag").map(([k, x]) => [k, plain(x)]));
    return v;
  }
  function revive(v) {
    if (Array.isArray(v)) {
      const numeric = v.length > 0 && v.every((x) => x === null || typeof x === "number");
      return numeric ? Float64Array.from(v, (x) => (x === null ? NaN : x)) : v.map(revive);
    }
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, revive(x)]));
    return v === null ? NaN : v;
  }

  function saveBatch() {
    if (!batch.items.length) return;
    const data = {
      format: "ivcurve-batch", format_version: 1, app_version: IV.APP_VERSION, saved_at: new Date().toISOString(),
      settings: IV.app.settingsSnapshot(), param_name: batch.paramName, start_from: batch.startFrom,
      items: batch.items.map((it) => ({
        name: it.name, param: it.param, status: it.status, reviewed: it.reviewed, flags: it.flags || [],
        scans: it.scans.map((s) => plain({ id: s.id, label: s.label ?? null, VData: s.VData, RefData: s.RefData, IData: s.IData })),
        params: plain(it.params), results: plain(it.results), proposal: plain(it.proposal),
      })),
    };
    IV.ui.download(`batch_${new Date().toISOString().slice(0, 10)}.ivbatch`, JSON.stringify(data), "application/json");
  }

  async function openBatchFile(file) {
    let data;
    try { data = JSON.parse(await file.text()); } catch (_) { data = null; }
    if (!data || data.format !== "ivcurve-batch") { IV.ui.toast(`${file.name} is not a saved batch.`, "error"); return; }
    batch.paramName = data.param_name || "Parameter";
    batch.startFrom = data.start_from || "proposal";
    for (const it of data.items) {
      const scans = it.scans.map((s) => { const r = revive(s); if (typeof r.label !== "string") delete r.label; return r; });
      const toObj = (x) => (x && typeof x === "object" ? revive(x) : null);
      batch.items.push({
        id: nextId++, name: it.name, param: it.param ?? "", status: it.status, reviewed: !!it.reviewed, flags: it.flags || [],
        scans, params: toObj(it.params), results: toObj(it.results), proposal: toObj(it.proposal),
      });
    }
    IV.ui.toast(`Batch opened: ${data.items.length} files (saved ${new Date(data.saved_at).toLocaleString()}).`);
    render();
  }

  function exportCSV() {
    const cols = ["file", batch.paramName || "parameter", "status", "reviewed_by_human",
      "Te_eV", "Te_VpVf_OML_eV", "Te_VpVf_planar_eV", "Te_check", "ne_m3", "ni_m3", "ni_over_ne",
      "Vp", "Vp_dIdV", "Vp_intersection", "Vf", "Iis_A", "Ies_A", "flags"];
    const cell = (v) => {
      if (typeof v === "number") return Number.isFinite(v) ? (v !== 0 && Math.abs(v) < 1e-4 ? v.toExponential() : String(v)) : "nan";
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [`# ${IV.app.settingsSummary()}`, cols.map(cell).join(",")];
    for (const it of batch.items) {
      const r = it.results || {};
      lines.push([it.name, it.param, it.status, it.status === "accepted" || it.status === "rejected" ? "yes" : "no",
        r.Te_eV, r.Te_VpVf_OML_eV, r.Te_VpVf_planar_eV, r.Te_check, r.ne_m3, r.ni_m3, r.ni_m3 / r.ne_m3,
        r.Vp, r.Vp_dIdV, r.Vp_intersection, r.Vf, r.Iis_A, r.Ies_A, (it.flags || []).join("; ")].map(cell).join(","));
    }
    IV.ui.download(`batch_results_${new Date().toISOString().slice(0, 10)}.csv`, lines.join("\n") + "\n", "text/csv");
  }

  // ---------------------------------------------------------------------------
  // Window
  // ---------------------------------------------------------------------------

  function openBatch() {
    if (ui) return;
    const d = IV.ui.openDialog({ title: "Batch review (beta)", onClose: () => { ui = null; } });
    d.dlg.classList.add("batch");
    d.foot.remove();

    const fileInput = el("input", { type: "file", multiple: true, hidden: true,
      accept: ".lda,.xml,.csv,.tsv,.txt,.dat,.ivbatch,application/xml,text/csv,text/plain,application/json" });
    fileInput.addEventListener("change", async () => { const f = fileInput.files; await addFiles(f); fileInput.value = ""; });

    const paramName = el("input", { type: "text", value: batch.paramName, style: "width:150px", title: "Name of the quantity that changes between files" });
    paramName.addEventListener("change", () => { batch.paramName = paramName.value.trim(); render(); });
    const startFrom = el("select", { title: "Fit regions shown when a curve is opened for review" }, [
      el("option", { value: "proposal", text: "the automatic proposal" }),
      el("option", { value: "previous", text: "the previous accepted curve" }),
    ]);
    startFrom.value = batch.startFrom;
    startFrom.addEventListener("change", () => { batch.startFrom = startFrom.value; });

    const btn = (text, onclick, cls = "") => el(`button.btn${cls}`, { text, onclick });
    const reviewBtn = btn("Review next ▶", () => reviewNext(batch.selected), ".primary");
    const controls = el("div.controls", { style: "border-top:none;border-bottom:1px solid var(--border)" }, [
      btn("Add files…", () => fileInput.click()), fileInput,
      reviewBtn,
      btn("Accept all good…", acceptAllGood),
      btn("Re-propose unreviewed", () => { for (const it of batch.items) if (!it.reviewed) analyse(it); render(); IV.ui.toast("Proposals updated with the current settings."); }),
      el("span.sep-v"),
      el("div.field", {}, [el("label", { text: "Parameter name:" }), paramName]),
      el("div.field", {}, [el("label", { text: "Start review from:" }), startFrom]),
      el("span.spacer"),
      btn("Save batch", saveBatch), btn("Open batch…", () => fileInput.click()), btn("Export table CSV", exportCSV),
    ]);

    const settings = el("p.batch-settings");
    const tbody = el("tbody");
    const table = el("table.data.batch-table", {}, [el("thead"), tbody]);
    const empty = el("div.batch-empty", {}, [
      el("h3", { text: "Add a series of measurements" }),
      el("p", { text: "Select several .lda or .csv files at once (or drop them here). Each curve gets automatic fit regions and a status; you then review them one after the other." }),
      btn("Add files…", () => fileInput.click(), ".primary"),
    ]);

    const varSel = el("select", {}, VARIABLES.map(([k, l]) => el("option", { value: k, text: l })));
    varSel.value = batch.variable;
    varSel.addEventListener("change", () => { batch.variable = varSel.value; renderSummary(); });
    const summaryEl = el("div");
    const previewEl = el("div");
    const detail = el("div.batch-detail");
    const right = el("div.batch-right", {}, [
      el("div.plot-cell", {}, [el("div.controls", { style: "border-top:none;border-bottom:1px solid var(--border);padding:6px 10px" },
        [el("div.field", {}, [el("label", { text: "Summary:" }), varSel])]), summaryEl]),
      el("div.plot-cell", {}, [detail, previewEl]),
    ]);
    const left = el("div.batch-left", {}, [empty, el("div.batch-table-wrap", {}, [table])]);
    d.body.append(controls, settings, el("div.batch-grid", {}, [left, right]));

    const summary = new IV.Plot(summaryEl, { filename: "batch_summary" });
    const preview = new IV.Plot(previewEl, { filename: "batch_curve" });
    d.plots.push(summary, preview);

    // drop files onto the window
    d.dlg.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
    d.dlg.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); addFiles(e.dataTransfer.files); });

    ui = { d, tbody, table, empty, settings, summary, preview, detail, reviewBtn, paramName, startFrom };
    render();
  }

  function select(index) {
    batch.selected = index;
    if (ui) render();
  }

  function render() {
    if (!ui) return;
    const { tbody, table, empty, settings, reviewBtn } = ui;
    // a reopened batch brings its own parameter name and review mode
    if (document.activeElement !== ui.paramName) ui.paramName.value = batch.paramName;
    ui.startFrom.value = batch.startFrom;
    settings.textContent = `Settings from the main window: ${IV.app.settingsSummary()}`;
    const has = batch.items.length > 0;
    empty.classList.toggle("hidden", has);
    table.classList.toggle("hidden", !has);
    const remaining = batch.items.filter((it) => !DONE.has(it.status)).length;
    reviewBtn.disabled = !remaining;
    reviewBtn.textContent = remaining ? `Review next ▶ (${remaining} left)` : "All reviewed";

    table.querySelector("thead").replaceChildren(el("tr", {}, ["#", "File", batch.paramName || "Parameter", "Status", "Te (eV)", "ne (m⁻³)", "ni/ne", "Vp (V)", "Vf (V)", ""]
      .map((h) => el("th", { text: h }))));
    tbody.replaceChildren(...batch.items.map((it, k) => {
      const r = it.results || {};
      const param = el("input", { type: "text", value: it.param, class: "param-input", "aria-label": `${batch.paramName} for ${it.name}` });
      param.addEventListener("change", () => { it.param = param.value.trim(); renderSummary(); });
      param.addEventListener("click", (e) => e.stopPropagation());
      const st = STATUS[it.status] || STATUS.pending;
      const actions = el("td", {}, [el("div.row-actions", {}, [
        el("button.btn.small", { text: DONE.has(it.status) ? "Open" : "Review", onclick: (e) => { e.stopPropagation(); review(k); } }),
        el("button.btn.small.ghost", { text: "↗", title: "Open this file in the main window (EEPF, EPFL, export…)", "aria-label": "Open in main window",
          onclick: (e) => { e.stopPropagation(); IV.app.loadIntoMain(it); ui.d.close(); } }),
        el("button.btn.small.ghost", { text: "✕", title: "Remove from the batch", "aria-label": "Remove from the batch",
          onclick: (e) => { e.stopPropagation(); batch.items.splice(k, 1); if (batch.selected >= batch.items.length) batch.selected = batch.items.length - 1; render(); } }),
      ])]);
      const tr = el(`tr${k === batch.selected ? ".selected" : ""}`, {}, [
        el("td", { text: String(k + 1) }),
        el("td.file", { text: it.name, title: it.name }),
        el("td", {}, [param]),
        el("td", {}, [el(`span.status.${it.status}`, { text: st.text, title: it.flags && it.flags.length ? it.flags.join("\n") : st.title })]),
        el("td", { text: fmtG(r.Te_eV, 4) }),
        el("td", { text: fmtE(r.ne_m3, 2) }),
        el("td", { text: fmtG(r.ni_m3 / r.ne_m3, 3) }),
        el("td", { text: fmtG(r.Vp, 4) }),
        el("td", { text: fmtG(r.Vf, 4) }),
        actions,
      ]);
      tr.addEventListener("click", () => select(k));
      tr.addEventListener("dblclick", () => review(k));
      return tr;
    }));
    renderSummary();
    renderDetail();
  }

  function renderSummary() {
    if (!ui) return;
    const key = batch.variable;
    const label = (VARIABLES.find(([k]) => k === key) || [key, key])[1];
    const withValue = batch.items.map((it, k) => ({ it, k, y: it.results ? it.results[key] : NaN })).filter((p) => Number.isFinite(p.y));
    const numeric = withValue.length > 0 && withValue.every((p) => p.it.param !== "" && Number.isFinite(Number(p.it.param)));
    const xOf = (p) => (numeric ? Number(p.it.param) : p.k + 1);
    const group = (pred) => withValue.filter(pred).sort((a, b) => xOf(a) - xOf(b));
    const all = group((p) => p.it.status !== "rejected");
    const reviewed = group((p) => p.it.status === "accepted");
    const others = group((p) => p.it.status !== "accepted" && p.it.status !== "rejected");
    const traces = [];
    const lo = getComputedStyle(document.documentElement).getPropertyValue("--text-lo").trim();
    if (all.length > 1) traces.push({ x: all.map(xOf), y: all.map((p) => p.y), name: "all curves", mode: "lines", width: 1, dash: "dot", color: lo });
    if (reviewed.length) traces.push({ x: reviewed.map(xOf), y: reviewed.map((p) => p.y), name: "reviewed", mode: "markers", markerSize: 9 });
    if (others.length) traces.push({ x: others.map(xOf), y: others.map((p) => p.y), name: "not reviewed", mode: "markers", markerSize: 7, symbol: "circle-open" });
    ui.summary.render({
      title: label, xlabel: numeric ? (batch.paramName || "Parameter") : "File #", ylabel: label, traces,
      text: traces.length ? undefined : "Results appear here", uirevision: `${key}-${numeric}`,
    });
  }

  function renderDetail() {
    if (!ui) return;
    const it = batch.items[batch.selected];
    if (!it) {
      ui.preview.render({ traces: [], text: "Select a file to see its curve" });
      ui.detail.replaceChildren(el("p.muted", { text: "Click a row to see the curve and the reasons for its status; double-click to review it." }));
      return;
    }
    try {
      const { x, imean, xkey } = IV.app.curveFor(it.scans);
      const r = it.results || {};
      const p = it.params;
      const shades = p && p.log ? [{ x0: p.log.tmin, x1: p.log.tmax }, { x0: p.log.smin, x1: p.log.smax }] : [];
      ui.preview.render({
        title: it.name, xlabel: xkey, ylabel: "Current (A)",
        traces: [{ x, y: imean, name: "mean I", width: 1.8 }],
        vlines: [{ x: r.Vf, label: "Vf", dash: "dot" }, { x: r.Vp, label: "Vp" }],
        shades, uirevision: `prev-${it.id}`,
      });
    } catch (e) {
      ui.preview.render({ traces: [], text: e.message });
    }
    const st = STATUS[it.status] || STATUS.pending;
    const flags = it.flags || [];
    ui.detail.replaceChildren(
      el("p", {}, [el(`span.status.${it.status}`, { text: st.text }), " ", st.title]),
      flags.length ? el("ul", {}, flags.map((f) => el("li", { text: f }))) : el("p.muted", { text: "No warnings." }),
      el("p.muted", { text: "Shaded on the plot: transition (left) and saturation (right) fit regions." }),
    );
  }

  IV.openBatch = openBatch;
  IV.batch = batch;
})(window.IV = window.IV || {});
