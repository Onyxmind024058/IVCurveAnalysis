/* =============================================================================
   "Training data α" window and the active fit-region model (pre-alpha).
   ============================================================================= */
(function (IV) {
  "use strict";
  const { el, fmtG } = IV.ui;

  // ---------------------------------------------------------------------------
  // Active model: the one shipped with the app, or one loaded for testing
  // ---------------------------------------------------------------------------

  let testModel = null;  // loaded from a file for this page session only

  function shippedModel() {
    try { return IV.REGION_MODEL ? IV.ml.checkModel(IV.REGION_MODEL) : null; } catch (_) { return null; }
  }
  function activeModel() { return testModel || shippedModel(); }
  function modelLabel(m) {
    if (!m) return "no model";
    return `${testModel ? "test model" : "shipped model"} · ${m.trained_on} curves · ${m.created.slice(0, 10)}`;
  }

  async function loadModelFile(file) {
    const text = await file.text();
    let model;
    if (/^\s*\{/.test(text)) {
      model = JSON.parse(text);
    } else {
      // a regions-model.js written by ml/train.js
      const m = text.match(/const model = (\{[\s\S]*?\});\n/);
      if (!m) throw new Error("No model found in this file.");
      model = JSON.parse(m[1]);
    }
    testModel = IV.ml.checkModel(model);
    IV.ui.toast(`Test model loaded (${model.trained_on} curves). It is used until the page is reloaded.`);
  }

  // ---------------------------------------------------------------------------
  // Window
  // ---------------------------------------------------------------------------

  let ui = null;

  async function openTraining() {
    if (ui) return;
    const d = IV.ui.openDialog({ title: "Training data α (pre-alpha)", onClose: () => { ui = null; } });
    d.dlg.classList.add("medium");
    d.body.classList.add("pad");
    d.body.style.overflow = "auto";

    const progress = el("div.train-progress", {}, [el("div.bar")]);
    const progressText = el("p", { style: "margin:6px 0 0" });
    const collect = IV.ui.checkField("Add every curve I review and accept (batch review and manual OML)", {
      checked: IV.training.collecting(), onChange: (on) => IV.training.setCollecting(on),
    });
    const fileInput = el("input", { type: "file", hidden: true, multiple: true, accept: ".ivtrain,.ivbatch,application/json" });
    fileInput.addEventListener("change", async () => {
      const files = Array.from(fileInput.files); fileInput.value = "";
      if (files.length) await importFiles(files);
      refresh();
    });
    const modelInput = el("input", { type: "file", hidden: true, accept: ".js,.json,application/json,text/javascript" });
    modelInput.addEventListener("change", async () => {
      const f = modelInput.files[0]; modelInput.value = "";
      if (!f) return;
      try { await loadModelFile(f); refresh(); } catch (e) { IV.ui.toast(e.message, "error"); }
    });
    const tbody = el("tbody");
    const table = el("table.data", {}, [el("thead", {}, [el("tr", {}, ["#", "File", "Added", "Te (eV)", "Vp (V)", "ΔVp (V)", ""].map((h) => el("th", { text: h })))]), tbody]);
    const modelBox = el("div.result-card", { style: "margin-top:14px" });
    const storageNote = el("p.muted", { style: "font-size:12px;margin:6px 0 0" });

    d.body.append(
      el("p", { style: "margin:0 0 10px", html:
        "Curves that <b>you reviewed and accepted</b> are collected here to train the fit-region model once. "
        + "Goal: <b>200 curves</b> from your measurements. Export them as one <span class=\"mono\">.ivtrain</span> file and send it to the maintainer." }),
      progress, progressText,
      el("div", { style: "margin:10px 0" }, [collect.field]),
      el("div.row-buttons", {}, [
        el("button.btn.primary", { text: "Export training data (.ivtrain)…", onclick: async () => { const n = await IV.training.exportFile(); IV.ui.toast(n ? `${n} curves exported.` : "Nothing to export yet."); } }),
        el("button.btn", { text: "Import .ivtrain / .ivbatch…", title: "Training sets, or saved batches: their reviewed and accepted curves are added", onclick: () => fileInput.click() }), fileInput,
        el("button.btn.destructive", { text: "Delete all…", onclick: clearAll }),
      ]),
      storageNote,
      el("div", { style: "max-height:260px;overflow:auto;margin-top:12px;border:1px solid var(--border);border-radius:6px" }, [table]),
      modelBox, modelInput,
    );
    d.foot.append(el("button.btn", { text: "Close", onclick: d.close }));
    ui = { d, progress, progressText, tbody, modelBox, storageNote, modelInput };
    refresh();
  }

  /** Imports several files and shows one summary (what was added, what was skipped and why). */
  async function importFiles(files) {
    let added = 0, already = 0;
    const lines = [], skippedAll = [];
    for (const f of files) {
      try {
        const r = await IV.training.importText(await f.text());
        added += r.added; already += r.already;
        lines.push(`<li><b>${IV.escape(f.name)}</b> (${r.kind}): ${r.added} added`
          + (r.already ? `, ${r.already} already there` : "") + (r.skipped.length ? `, ${r.skipped.length} skipped` : "") + "</li>");
        for (const s of r.skipped) skippedAll.push(`<li>${IV.escape(f.name)} → ${IV.escape(s.file)}: ${IV.escape(s.reason)}</li>`);
      } catch (e) {
        lines.push(`<li><b>${IV.escape(f.name)}</b>: ${IV.escape(e.message)}</li>`);
      }
    }
    IV.ui.message("Import to training data",
      `<p style="margin:0 0 6px"><b>${added}</b> curve${added === 1 ? "" : "s"} added${already ? `, ${already} already in the training data` : ""}.</p>
       <ul style="margin:0 0 8px;padding-left:18px">${lines.join("")}</ul>`
      + (skippedAll.length ? `<details><summary>${skippedAll.length} curve${skippedAll.length === 1 ? "" : "s"} not added</summary>
         <ul style="margin:6px 0 0;padding-left:18px;font-size:12px">${skippedAll.join("")}</ul></details>
         <p class="muted" style="font-size:12px;margin:8px 0 0">Only curves a person reviewed and accepted (“✔ reviewed”) are training data.</p>` : ""));
  }

  async function clearAll() {
    const n = await IV.training.count();
    if (!n) return;
    const ok = await IV.ui.message("Delete all training data?",
      `<p>This removes the ${n} collected curve${n > 1 ? "s" : ""} from this browser. Export them first if you want to keep them.</p>`,
      [{ label: "Cancel" }, { label: "Delete", value: "yes", primary: true }]);
    if (ok === "yes") { await IV.training.clear(); refresh(); }
  }

  async function refresh() {
    updateBadge();
    if (!ui) return;
    const samples = await IV.training.all();
    const goal = IV.training.GOAL;
    ui.progress.querySelector(".bar").style.width = `${Math.min(100, (samples.length / goal) * 100)}%`;
    ui.progressText.textContent = `${samples.length} of ${goal} curves collected`
      + (samples.length >= goal ? " — enough to train the model." : ".");
    ui.storageNote.textContent = IV.training.persistent()
      ? "Stored in this browser on this computer; nothing is uploaded."
      : "This browser does not allow storage here: the curves are lost when the page closes. Export them before closing.";
    ui.tbody.replaceChildren(...samples.slice().reverse().map((s, k) => {
      const r = s.human.results || {};
      return el("tr", {}, [
        el("td", { text: String(samples.length - k) }),
        el("td", { text: s.source.file, style: "font-family:var(--font)" }),
        el("td", { text: new Date(s.added_at).toLocaleString([], { dateStyle: "short", timeStyle: "short" }) }),
        el("td", { text: fmtG(r.Te_eV, 3) }),
        el("td", { text: fmtG(r.Vp, 4) }),
        el("td", { text: fmtG(Math.abs(r.Vp_dIdV - r.Vp_intersection), 2) }),
        el("td", {}, [el("button.btn.small.ghost", { text: "✕", title: "Remove this curve from the training data",
          onclick: async () => { await IV.training.remove(s.id); refresh(); } })]),
      ]);
    }));
    if (!samples.length) ui.tbody.replaceChildren(el("tr", {}, [el("td", { colspan: 7, text: "No curves yet. Review and accept curves in the batch review or the manual OML analysis.", style: "font-family:var(--font);color:var(--text-lo)" })]));

    const m = activeModel();
    const v = m && m.validation;
    ui.modelBox.replaceChildren(
      el("header", {}, [el("h3", { text: "Fit-region model" }), el("time", { text: modelLabel(m) })]),
      m ? el("p", { style: "padding-top:8px;color:var(--text)", text:
        `Corrects: ${v.corrected.length ? v.corrected.join(", ") : "nothing (the rules were as good)"}. `
        + `On held-out curves: Te error ${fmtG(v.te_error_pct.rules_median, 2)} % (rules) → ${fmtG(v.te_error_pct.model_median, 2)} % (model), `
        + `Vp error ${fmtG(v.vp_error_V.rules_median, 2)} V → ${fmtG(v.vp_error_V.model_median, 2)} V.`
        + (m.note ? ` ${m.note}` : "") })
        : el("p", { style: "padding-top:8px;color:var(--text)", text: "No model is shipped yet. Once enough curves are collected, it is trained once and delivered with the app; the batch review can then take its proposals from it." }),
      el("p", {}, [el("button.btn.small", { text: "Load model file for testing…", title: "For the maintainer: try a regions-model.js made by ml/train.js before shipping it", onclick: () => ui.modelInput.click() })]),
    );
  }

  async function updateBadge() {
    const badge = document.getElementById("trainingCount");
    if (badge) badge.textContent = String(await IV.training.count());
  }

  document.addEventListener("DOMContentLoaded", () => {
    document.getElementById("trainingBtn").addEventListener("click", openTraining);
    IV.training.onChange(() => refresh());
    updateBadge();
  });

  IV.openTraining = openTraining;
  IV.models = { active: activeModel, label: modelLabel };
})(window.IV = window.IV || {});
