/* =============================================================================
   Assisted batch review.

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
    // AI pre-review (pre-alpha)
    aiqueued: { text: "AI … queued", title: "Waiting for the AI pre-review" },
    airunning: { text: "AI ⏳ working", title: "The AI agent is analysing this curve" },
    aigood: { text: "✓ AI pre-reviewed", title: "Pre-reviewed by the AI, all checks passed — still to be reviewed by a person" },
    aicheck: { text: "⚠ AI: check", title: "Pre-reviewed by the AI: usable with caveats — review carefully" },
    aibad: { text: "✗ AI: bad curve", title: "Pre-reviewed by the AI: the results are not trustworthy as they are (re-analyse by hand or re-measure)" },
    aifailed: { text: "✗ AI no result", title: "The AI pre-review gave no result for this curve" },
    ainone: { text: "— AI: not analysable", title: "The AI judges this curve not analysable — confirm it (untick “Analysable”) or analyse it yourself" },
  };
  const AI_STATES = new Set(["aiqueued", "airunning", "aigood", "aicheck", "aibad", "aifailed", "ainone"]);
  const AI_DONE = ["aigood", "aicheck", "aibad", "ainone"];  // curves with an AI result
  const VERDICT_STATUS = { good: "aigood", check: "aicheck", bad: "aibad" };
  const DONE = new Set(["accepted", "auto", "rejected"]);

  const VARIABLES = [
    ["Te_eV", "Te (eV)"], ["ne_m3", "ne (m⁻³)"], ["ni_m3", "ni (m⁻³)"], ["Vp", "Vp (V)"], ["Vf", "Vf (V)"],
    ["Te_VpVf_OML_eV", "Te from Vp − Vf, OML (eV)"], ["Iis_A", "Iis at Vf (A)"], ["Ies_A", "Ies (A)"],
  ];

  /** <p> with one sentence, translated here as a whole (the page translator leaves it alone). */
  const para = (english, style = "margin:0 0 8px", cls = "") => `<p data-no-i18n${cls ? ` class="${cls}"` : ""} style="${style}">${IV.escape(IV.t(english))}</p>`;

  const batch = { paramName: "Parameter", items: [], csvMapping: null, startFrom: "proposal", proposalSource: "rules", variable: "Te_eV", selected: -1,
    aiSummary: null, aiRun: null };
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
      // proposals from the trained model when chosen (beta), else from the rules;
      // if the model's proposal looks worse (more warnings) than the rules', keep the rules'
      const fromRules = () => {
        const prop = { ...A.proposeOML(x, imean, area), source: "rules" };
        IV.app.addDerived(prop.results, area);
        return { ...prop, flags: A.qualityFlags(prop.results, prop.results) };
      };
      const model = batch.proposalSource === "model" ? IV.models.active() : null;
      let chosen = fromRules();
      if (model) {
        const prop = IV.ml.proposeWithModel(model, x, imean, area, IV.app.ionMass());
        IV.app.addDerived(prop.results, area);
        const flags = A.qualityFlags(prop.results, prop.results);
        chosen = flags.length <= chosen.flags.length ? { ...prop, flags }
          : { ...chosen, source: "rules (the model's proposal had more warnings)" };
      }
      const { params, results, source } = chosen;
      item.proposal = params;
      item.proposalSource = source;
      item.proposalFlags = chosen.flags;
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
          // the settings this curve was reviewed with (probe, ion, x axis, data range)
          settings: IV.app.settingsSnapshot(),
          results: r, params: r.params, flags, reviewed: true,
          status: r.params && r.params.analysable === false ? "rejected" : "accepted",
        });
        // a curve reviewed and accepted by a person is training data (beta)
        if (item.status === "accepted") {
          IV.training.addReview({ file: item.name, x: curve.x, imean: curve.imean, xkey: curve.xkey,
            params: r.params, results: r, area, scans: item.scans.length });
        }
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
    const good = batch.items.filter((it) => it.status === "good" || it.status === "aigood");
    if (!good.length) { IV.ui.toast("No curves with status “good” to accept."); return; }
    const ok = await IV.ui.message("Accept all good curves?",
      para(`Curves that passed every check: ${good.length}. They will be accepted without opening them and marked “✓ unreviewed” in the table and the export.`)
      + para("Curves with “⚠ check”, “✗ failed” or “✗ AI: bad curve” still have to be reviewed.", "margin:0", "muted"),
      [{ label: "Cancel" }, { label: "Accept without review", value: "yes", primary: true }]);
    if (ok !== "yes") return;
    for (const it of good) it.status = "auto";
    render();
  }

  // ---------------------------------------------------------------------------
  // AI pre-review (pre-alpha): the AI agent analyses each curve
  // ---------------------------------------------------------------------------

  /** The agent's result becomes the curve's proposal (and its result until a person reviews it). */
  function applyAI(item, final, model, area) {
    if (final.analysable === false) {
      // the AI's verdict; the rules' proposal stays so a person can still try the curve
      item.ai = { status: "not analysable", analysable: false, reason: final.reason, report: final.report, model, at: new Date().toISOString() };
      item._aiFinal = { ...final, model };
      if (!item.reviewed) { item.status = "ainone"; item.flags = [`AI: not analysable — ${final.reason}`]; }
      return;
    }
    const r = final.results;
    IV.app.addDerived(r, area);
    item.proposal = final.params;
    item.proposalSource = `AI agent (${model})`;
    item.proposalFlags = final.flags;
    const verdict = final.verdict || (final.flags.length ? "check" : "good");
    item.ai = { status: final.summary.status, verdict, verdict_reasons: final.verdict_reasons || [], report: final.report, model, at: new Date().toISOString() };
    item._aiFinal = { ...final, model };  // kept while the page is open (shown in the AI window)
    item.error = null;
    if (!item.reviewed) {
      item.params = final.params;
      item.results = r;
      item.flags = final.flags;
      item.status = VERDICT_STATUS[verdict];
    }
  }

  /** The curve's AI result in the form the AI window shows (rebuilt from the saved regions after reopening a batch). */
  function aiFinalOf(item) {
    if (item._aiFinal) return item._aiFinal;
    if (item.ai && item.ai.analysable === false) return { analysable: false, reason: item.ai.reason, report: item.ai.report, model: item.ai.model, flags: [item.ai.reason], summary: { status: "not analysable" } };
    if (!item.ai || !item.proposal || !(item.proposalSource || "").startsWith("AI")) return null;
    try {
      const ctx = IV.agentTools.makeContext(IV.app.agentInput(IV.app.curveFor(item.scans), item.name));
      const ev = IV.agentTools.evaluate(ctx, item.proposal);
      return { params: item.proposal, results: ev.results, flags: ev.flags, summary: IV.agentTools.summary(ctx, item.proposal, ev), report: item.ai.report, model: item.ai.model,
        verdict: item.ai.verdict, verdict_reasons: item.ai.verdict_reasons };
    } catch (_) { return null; }
  }

  /** AI window for one curve of the batch: its AI result, the chat, a new AI run. */
  function openAIFor(index, { focusChat = true } = {}) {
    const item = batch.items[index];
    if (!item) { IV.ui.toast("Select a curve in the table first."); return; }
    let input;
    try { input = IV.app.agentInput(IV.app.curveFor(item.scans), item.name); } catch (e) { IV.ui.message("Cannot open the AI", IV.escape(e.message)); return; }
    const area = IV.app.probeArea();
    IV.openAgent({
      input, title: `AI α — ${item.name}${batch.paramName ? ` · ${batch.paramName} = ${item.param || "?"}` : ""}`,
      final: aiFinalOf(item), messages: item._aiMessages || [], focusChat,
      onConversation: (messages) => { item._aiMessages = messages; },
      onUse: (final) => { applyAI(item, final, final.model || IV.agentUI.connection().label, area); render(); },
    });
  }

  async function aiPreReview() {
    if (batch.aiRun) { batch.aiRun.abort(); return; }
    const open = batch.items.filter((it) => !DONE.has(it.status) && !it.reviewed);
    if (!open.length) { IV.ui.toast("No curves left to pre-review: all are reviewed, accepted or skipped."); return; }
    let ready = await IV.agentUI.prepare();
    if (!ready) return;
    const withoutAI = open.filter((it) => !AI_DONE.includes(it.status));
    const flagged = open.filter((it) => !["good", "aigood"].includes(it.status));  // ⚠, ✗ and bad curves
    const excluded = batch.items.length - open.length;
    let choice;
    for (;;) {
      choice = await IV.ui.message("AI pre-review of the batch",
        `<p style="margin:0 0 8px">AI: <b>${IV.escape(ready.label)}</b> · skill ${IV.escape(ready.skill.name)}</p>`
        + para("The agent analyses the curves one after the other, like the single-curve AI analysis. Each curve then shows the AI's verdict (✓ good, ⚠ check, ✗ bad curve, — not analysable, or ✗ no result), and the AI's regions become its proposal: “Review next” opens the curves with them, and nothing counts as reviewed until a person accepts it. A curve whose analysis fails is marked and the run goes on.")
        + para("About 5–10 requests per curve; at most one request per second. At the end you get a report and the agent writes a summary of the series.")
        + para(`Curves not reviewed yet: ${open.length}; without an AI result: ${withoutAI.length}; with ⚠/✗: ${flagged.length}.`, "margin:0", "muted")
        + (excluded ? para(`Left out (reviewed, accepted without review, or skipped): ${excluded}.`, "margin:0", "muted") : ""),
        [{ label: "Cancel" }, { label: "AI settings…", value: "settings" },
          ...(withoutAI.length && withoutAI.length < open.length ? [{ label: `Only without AI result (${withoutAI.length})`, value: "missing" }] : []),
          ...(flagged.length && flagged.length < open.length ? [{ label: `Only ⚠ / ✗ (${flagged.length})`, value: "flagged" }] : []),
          { label: `All ${open.length} not reviewed`, value: "all", primary: true }]);
      if (choice !== "settings") break;
      await IV.agentUI.settingsDialog();
      ready = await IV.agentUI.prepare();
      if (!ready) return;
      render();
    }
    if (!["all", "missing", "flagged"].includes(choice)) return;
    const list = choice === "missing" ? withoutAI : choice === "flagged" ? flagged : open;

    const abort = new AbortController();
    batch.aiRun = abort;
    const area = IV.app.probeArea();
    const before = new Map(list.map((it) => [it, it.status]));
    for (const it of list) it.status = "aiqueued";
    const failures = [];
    let done = 0, stopped = false, fatal = null, inARow = 0;
    // a curve that already had an AI result keeps it; others are marked "no result"
    const fail = (item, why) => {
      failures.push([item.name, why]);
      if (AI_DONE.includes(before.get(item))) { item.status = before.get(item); return; }
      item.status = "aifailed";
      item.ai = { status: "no result", report: why, model: ready.label, at: new Date().toISOString() };
      item.flags = [why];
    };
    render();
    const removed = (item) => !batch.items.includes(item);  // taken out of the batch during the run
    for (const [n, item] of list.entries()) {
      if (abort.signal.aborted) { stopped = true; break; }
      if (removed(item)) continue;
      item.status = "airunning";
      batch.aiProgress = `AI: ${n + 1} / ${list.length} — ${item.name}`;
      select(batch.items.indexOf(item));
      try {
        const ctx = IV.agentTools.makeContext(IV.app.agentInput(IV.app.curveFor(item.scans), item.name));
        const out = await IV.agent.run({ ctx, ...ready.conn, skill: ready.skill.text, signal: abort.signal });
        if (removed(item)) { render(); continue; }
        item._aiMessages = out.messages;
        if (out.final) { applyAI(item, out.final, ready.label, area); done++; inARow = 0; }
        else { fail(item, `The agent did not submit a result within ${out.turns} steps.`); inARow++; }
      } catch (e) {
        if (e && e.name === "AbortError") { item.status = before.get(item); stopped = true; break; }
        if (removed(item)) { render(); continue; }
        // the same error would come for every curve (key, address, network): stop; this curve is not to blame
        if (e.fatal) { item.status = before.get(item); fatal = e.message; break; }
        fail(item, e.message);
        inARow++;
      }
      if (inARow >= 3) { fatal = `${inARow} curves in a row without result — stopped to save requests. Last: ${failures[failures.length - 1][1]}`; break; }
      render();
    }
    // curves the run did not reach go back to their previous status
    for (const it of list) if (it.status === "aiqueued" || it.status === "airunning") it.status = before.get(it);
    const gone = list.filter(removed).length;
    batch.aiRun = null;
    batch.aiProgress = "";
    render();

    await IV.ui.message(stopped ? "AI pre-review stopped" : fatal ? "AI pre-review interrupted" : "AI pre-review finished",
      para(`Pre-reviewed by the AI: ${done} of ${list.length}.`)
      + (failures.length ? para(`Without result: ${failures.length}.`) : "")
      + (list.length - done - failures.length - gone > 0 ? para(`Not reached: ${list.length - done - failures.length - gone}.`) : "")
      + (gone ? para(`Removed from the batch during the run: ${gone}.`) : "")
      + (fatal ? `<p style="margin:0 0 8px;color:var(--red)">${IV.escape(IV.t(fatal))}</p>` : "")
      + (failures.length ? `<ul style="margin:0 0 8px;padding-left:18px">${failures.map(([name, why]) => `<li data-no-i18n><b>${IV.escape(name)}</b>: ${IV.escape(IV.t(why))}</li>`).join("")}</ul>` : "")
      + (failures.length || fatal || stopped ? para(fatal ? "Fix the problem (AI settings…), then run the pre-review again with “Only without AI result” to retry the missing curves." : "Run the pre-review again with “Only without AI result” to retry the missing curves.", "margin:0", "muted") : "")
      + (list.some((it) => it.status === "ainone") ? para("Curves marked “— AI: not analysable” are left out of the plot and the summary; confirm or overrule the verdict when you review them.", "margin:6px 0 0", "muted") : ""));
    // written in the background: no window pops up over the table; “AI summary α ✓” opens it
    if (!stopped && !fatal && done > 0 && batch.items.filter((it) => it.results).length >= 2) aiSummary(ready, { open: false });
  }

  /** Table of app results for the series summary. */
  function summaryRows() {
    const r3 = (x) => (Number.isFinite(x) ? Number(x.toPrecision(4)) : null);
    return batch.items.map((it) => {
      const r = it.results || {};
      return {
        file: it.name, param: it.param,
        status: it.status === "accepted" ? "reviewed by a person" : it.status === "rejected" ? "skipped (not analysable)"
          : it.status === "auto" ? "accepted without review" : it.status === "aigood" ? "pre-reviewed by the AI, no warning"
          : it.status === "aicheck" ? "pre-reviewed by the AI, usable with caveats"
          : it.status === "aibad" ? `BAD CURVE according to the AI (${((it.ai && it.ai.verdict_reasons) || []).join("; ")}); results not trustworthy, leave out of trends`
          : it.status === "aifailed" ? "AI gave no result (rules proposal or none)"
          : it.status === "ainone" ? `judged NOT ANALYSABLE by the AI (${it.ai && it.ai.reason}); ignore its numbers` : `rules proposal only (${it.status})`,
        quality_flags: it.flags || [],
        Te_eV: r3(r.Te_eV), Te_VpVf_OML_eV: r3(r.Te_VpVf_OML_eV), Te_VpVf_planar_eV: r3(r.Te_VpVf_planar_eV),
        ne_m3: r3(r.ne_m3), ni_m3: r3(r.ni_m3), ni_over_ne: r3(r.ni_m3 / r.ne_m3),
        Vp_V: r3(r.Vp), Vp_dIdV_V: r3(r.Vp_dIdV), Vp_intersection_V: r3(r.Vp_intersection), Vp_difference_V: r3(r.Vp_difference_V), Vp_check: r.Vp_check ?? null,
        Vf_V: r3(r.Vf),
      };
    });
  }

  async function aiSummary(prepared, { open = true } = {}) {
    if (!batch.items.some((it) => it.results)) { IV.ui.toast("No results to summarise yet."); return; }
    const ready = prepared || await IV.agentUI.prepare();
    if (!ready) return;
    batch.aiProgress = "AI: writing the summary of the series…";
    render();
    try {
      const out = await IV.agent.summarizeSeries({
        rows: summaryRows(), paramName: batch.paramName, settings: IV.app.settingsSummary(),
        ...ready.conn, skill: ready.skill.text,
      });
      batch.aiSummary = { text: out.text, model: ready.label, at: new Date().toISOString() };
      render();
      if (open) showSummary();
      else IV.ui.toast("AI summary of the series ready — open it with “AI summary α ✓”.");
    } catch (e) {
      IV.ui.message("AI summary failed", IV.escape(e.message));
    } finally {
      batch.aiProgress = "";
      render();
    }
  }

  function showSummary() {
    const s = batch.aiSummary;
    if (!s) return;
    const d = IV.ui.openDialog({ title: "AI summary of the series", padded: true });
    d.dlg.classList.add("medium");
    d.body.style.overflow = "auto";
    d.body.append(
      el("p.muted", { style: "margin:0 0 8px;font-size:12px", text: `${s.model} · ${new Date(s.at).toLocaleString()} · from the table of app results; the text is the AI's own.` }),
      el("div.agent-report", { text: s.text || "(empty)" }),
    );
    d.foot.append(
      el("button.btn", { text: "Copy", onclick: () => navigator.clipboard.writeText(s.text).then(() => IV.ui.toast("Summary copied.")) }),
      el("button.btn", { text: "Write again", onclick: () => { d.close(); aiSummary(); } }),
      el("span.spacer"),
      el("button.btn.primary", { text: "Close", onclick: () => d.close() }),
    );
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
      settings: IV.app.settingsSnapshot(), param_name: batch.paramName, start_from: batch.startFrom, ai_summary: batch.aiSummary,
      items: batch.items.map((it) => ({
        name: it.name, param: it.param, status: it.status, reviewed: it.reviewed, flags: it.flags || [],
        scans: it.scans.map((s) => plain({ id: s.id, label: s.label ?? null, VData: s.VData, RefData: s.RefData, IData: s.IData })),
        params: plain(it.params), results: plain(it.results), proposal: plain(it.proposal),
        settings: it.settings ? plain(it.settings) : null,
        proposal_source: it.proposalSource || null, ai: it.ai || null,
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
    if (data.ai_summary) batch.aiSummary = data.ai_summary;
    for (const it of data.items) {
      const scans = it.scans.map((s) => { const r = revive(s); if (typeof r.label !== "string") delete r.label; return r; });
      const toObj = (x) => (x && typeof x === "object" ? revive(x) : null);
      batch.items.push({
        id: nextId++, name: it.name, param: it.param ?? "", status: it.status, reviewed: !!it.reviewed, flags: it.flags || [],
        scans, params: toObj(it.params), results: toObj(it.results), proposal: toObj(it.proposal),
        settings: it.settings || null,
        proposalSource: it.proposal_source || undefined, ai: it.ai || undefined,
      });
    }
    IV.ui.toast(`Batch opened: ${data.items.length} files (saved ${new Date(data.saved_at).toLocaleString()}).`);
    render();
  }

  function exportCSV() {
    const cols = ["file", batch.paramName || "parameter", "status", "reviewed_by_human", "proposal_from",
      "Te_eV", "Te_VpVf_OML_eV", "Te_VpVf_planar_eV", "Te_check", "ne_m3", "ni_m3", "ni_over_ne",
      "Vp", "Vp_dIdV", "Vp_intersection", "Vp_difference_V", "Vp_check", "Vf", "Iis_A", "Ies_A", "flags"];
    const cell = (v) => {
      if (typeof v === "number") return Number.isFinite(v) ? (v !== 0 && Math.abs(v) < 1e-4 ? v.toExponential() : String(v)) : "nan";
      const s = String(v ?? "");
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [`# ${IV.app.settingsSummary()}`, cols.map(cell).join(",")];
    for (const it of batch.items) {
      const r = it.results || {};
      lines.push([it.name, it.param, it.status, it.status === "accepted" || it.status === "rejected" ? "yes" : "no", it.proposalSource || "rules",
        r.Te_eV, r.Te_VpVf_OML_eV, r.Te_VpVf_planar_eV, r.Te_check, r.ne_m3, r.ni_m3, r.ni_m3 / r.ne_m3,
        r.Vp, r.Vp_dIdV, r.Vp_intersection, r.Vp_difference_V, r.Vp_check, r.Vf, r.Iis_A, r.Ies_A, (it.flags || []).join("; ")].map(cell).join(","));
    }
    IV.ui.download(`batch_results_${new Date().toISOString().slice(0, 10)}.csv`, lines.join("\n") + "\n", "text/csv");
  }

  // ---------------------------------------------------------------------------
  // Window
  // ---------------------------------------------------------------------------

  function openBatch() {
    if (ui) return;
    const d = IV.ui.openDialog({ title: "Batch review", onClose: () => { ui = null; if (batch.aiRun) batch.aiRun.abort(); } });
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
    const hasModel = !!IV.models.active();
    const source = el("select", { title: "Where the automatic fit regions come from" }, [
      el("option", { value: "rules", text: "rules" }),
      el("option", { value: "model", text: hasModel ? `model (${IV.models.label(IV.models.active())})` : "model (none shipped yet)", disabled: !hasModel }),
    ]);
    if (!hasModel) batch.proposalSource = "rules";
    source.value = batch.proposalSource;
    source.addEventListener("change", () => {
      batch.proposalSource = source.value;
      for (const it of batch.items) if (!it.reviewed) analyse(it);
      render();
      IV.ui.toast(`Proposals now from the ${source.value}.`);
    });

    const btn = (text, onclick, cls = "") => el(`button.btn${cls}`, { text, onclick });
    const reviewBtn = btn("Review next ▶", () => reviewNext(batch.selected), ".primary");
    const aiBtn = btn("AI pre-review α…", aiPreReview, ".ai");
    aiBtn.title = "The AI agent analyses every curve not yet reviewed; its regions become the proposals you review";
    const aiSumBtn = btn("AI summary α", () => (batch.aiSummary ? showSummary() : aiSummary()), ".ai");
    aiSumBtn.title = "Summary of the series written by the AI agent from the table of results";
    const aiChatBtn = btn("AI chat α…", () => openAIFor(batch.selected), ".ai");
    aiChatBtn.title = "Open the AI window for the selected curve: its AI result, a chat about it, or a new AI analysis";
    const aiSetBtn = btn("AI settings…", async () => { await IV.agentUI.settingsDialog(); render(); }, ".ai");
    aiSetBtn.title = "AI provider, model and API key";
    const controls = el("div.controls", { style: "border-top:none;border-bottom:1px solid var(--border)" }, [
      btn("Add files…", () => fileInput.click()), fileInput,
      reviewBtn,
      btn("Accept all good…", acceptAllGood),
      btn("Re-propose unreviewed", () => { for (const it of batch.items) if (!it.reviewed) analyse(it); render(); IV.ui.toast("Proposals updated with the current settings."); }),
      el("span.sep-v"),
      aiBtn, aiChatBtn, aiSumBtn, aiSetBtn,
      el("span.sep-v"),
      el("div.field", {}, [el("label", { text: "Parameter name:" }), paramName]),
      el("div.field", {}, [el("label", { text: "Start review from:" }), startFrom]),
      el("div.field", {}, [el("label", { text: "Proposals from:" }), source]),
      el("span.spacer"),
      btn("Save batch…", saveBatch), btn("Open batch…", () => fileInput.click()), btn("Export table CSV…", exportCSV),
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
    // three sections on the right, each can be hidden and shown again (remembered in this browser)
    const secParam = el("div.plot-cell.batch-sec", {}, [el("div.controls", { style: "border-top:none;border-bottom:1px solid var(--border);padding:6px 10px" },
      [el("div.field", {}, [el("label", { text: "Summary:" }), varSel])]), summaryEl]);
    const secReport = el("div.plot-cell.batch-sec.batch-report-cell", {}, [detail]);
    const secCurve = el("div.plot-cell.batch-sec", {}, [previewEl]);
    const right = el("div.batch-right", {}, [secParam, secReport, secCurve]);
    const left = el("div.batch-left", {}, [empty, el("div.batch-table-wrap", {}, [table])]);
    const grid = el("div.batch-grid", {}, [left, right]);
    const view = loadView();
    const sections = [["param", "Parameter graph", secParam], ["report", "Report", secReport], ["curve", "Curve", secCurve]];
    const applyView = () => {
      for (const [key, , sec] of sections) sec.classList.toggle("hidden", !view[key]);
      grid.classList.toggle("no-right", !sections.some(([key]) => view[key]));
      saveView(view);
      window.dispatchEvent(new Event("resize"));  // let the graphs take the new size
    };
    const viewBar = el("div.batch-view", {}, [el("span.muted", { text: "Show:" }), ...sections.map(([key, label]) => {
      const box = el("input", { type: "checkbox" });
      box.checked = view[key];
      box.addEventListener("change", () => { view[key] = box.checked; applyView(); });
      return el("label.check", {}, [box, label]);
    })]);
    d.body.append(controls, el("div.batch-settings-row", {}, [settings, viewBar]), grid);
    applyView();

    const summary = new IV.Plot(summaryEl, { filename: "batch_summary" });
    const preview = new IV.Plot(previewEl, { filename: "batch_curve" });
    d.plots.push(summary, preview);

    // drop files onto the window
    d.dlg.addEventListener("dragover", (e) => { e.preventDefault(); e.stopPropagation(); });
    d.dlg.addEventListener("drop", (e) => { e.preventDefault(); e.stopPropagation(); addFiles(e.dataTransfer.files); });

    ui = { d, tbody, table, empty, settings, summary, preview, detail, reviewBtn, paramName, startFrom, aiBtn, aiSumBtn, aiChatBtn };
    render();
  }

  const VIEW_KEY = "ivcurve-alpha.batchView";
  function loadView() {
    const dflt = { param: true, report: true, curve: true };
    try { return { ...dflt, ...JSON.parse(localStorage.getItem(VIEW_KEY) || "{}") }; } catch (_) { return dflt; }
  }
  function saveView(v) { try { localStorage.setItem(VIEW_KEY, JSON.stringify(v)); } catch (_) { /* private mode */ } }

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
    settings.textContent = `Settings from the main window: ${IV.app.settingsSummary()} · AI: ${IV.agentUI.connection().label}${batch.aiProgress ? ` · ${batch.aiProgress}` : ""}`;
    ui.aiBtn.textContent = batch.aiRun ? "Stop AI" : "AI pre-review α…";
    ui.aiSumBtn.textContent = batch.aiSummary ? "AI summary α ✓" : "AI summary α";
    ui.aiSumBtn.disabled = !!batch.aiRun;
    ui.aiChatBtn.disabled = !batch.items[batch.selected];
    const ai = IV.agentUI.connection();
    ui.settings.title = `AI: ${ai.label}${IV.agentUI.missing(ai) ? ` (${IV.agentUI.missing(ai)} not set)` : ""}`;
    const has = batch.items.length > 0;
    empty.classList.toggle("hidden", has);
    table.classList.toggle("hidden", !has);
    const remaining = batch.items.filter((it) => !DONE.has(it.status)).length;
    reviewBtn.disabled = !remaining;
    reviewBtn.textContent = remaining ? `Review next ▶ (${remaining} left)` : "All reviewed";

    table.querySelector("thead").replaceChildren(el("tr", {}, ["#", "File", batch.paramName || "Parameter", "Status", "Te (eV)", "ne (m⁻³)", "ni/ne", "Vp (V)", "ΔVp", "Vf (V)", ""]
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
        el("td", {}, [el(`span.status.${it.status}`, { text: st.text, title: it.flags && it.flags.length ? it.flags.join("\n") : st.title }),
          !AI_STATES.has(it.status) && it.proposalSource && it.proposalSource.startsWith("AI") ? el("span.ai-tag", { text: "AI", title: `Proposal from the ${it.proposalSource}` }) : null]),
        el("td", { text: fmtG(r.Te_eV, 4) }),
        el("td", { text: fmtE(r.ne_m3, 2) }),
        el("td", { text: fmtG(r.ni_m3 / r.ne_m3, 3) }),
        el("td", { text: fmtG(r.Vp, 4) }),
        el("td", { text: Number.isFinite(r.Vp_difference_V) ? `${fmtG(r.Vp_difference_V, 2)} V` : "—",
          title: "Vp from dI/dV vs from the fit intersection: ≤ 2 V good, ≤ 5 V ok if the Te cross-check agrees, otherwise review",
          class: r.Vp_check === "review" ? "vp-poor" : "" }),
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
    const all = group((p) => !["rejected", "ainone", "aibad"].includes(p.it.status));
    const reviewed = group((p) => p.it.status === "accepted");
    const others = group((p) => !["accepted", "rejected", "ainone", "aibad"].includes(p.it.status));
    const bad = group((p) => p.it.status === "aibad");
    const traces = [];
    const lo = getComputedStyle(document.documentElement).getPropertyValue("--text-lo").trim();
    if (all.length > 1) traces.push({ x: all.map(xOf), y: all.map((p) => p.y), name: "all curves", mode: "lines", width: 1, dash: "dot", color: lo });
    if (reviewed.length) traces.push({ x: reviewed.map(xOf), y: reviewed.map((p) => p.y), name: "reviewed", mode: "markers", markerSize: 9 });
    if (others.length) traces.push({ x: others.map(xOf), y: others.map((p) => p.y), name: "not reviewed", mode: "markers", markerSize: 7, symbol: "circle-open" });
    if (bad.length) traces.push({ x: bad.map(xOf), y: bad.map((p) => p.y), name: "AI: bad curve (not trusted)", mode: "markers", markerSize: 8, symbol: "x", color: getComputedStyle(document.documentElement).getPropertyValue("--red").trim() });
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
    ui.detail.replaceChildren(...[
      el("p", {}, [el(`span.status.${it.status}`, { text: st.text }), " ", st.title,
        it.proposalSource ? el("span.muted", { text: ` · proposal from the ${it.proposalSource}` }) : null]),
      flags.length ? el("ul", {}, flags.map((f) => el("li", { text: f }))) : el("p.muted", { text: "No warnings." }),
      it.ai && it.ai.verdict && it.ai.verdict !== "good" && it.ai.verdict_reasons && it.ai.verdict_reasons.length
        ? el("p", { style: `margin:4px 0;color:${it.ai.verdict === "bad" ? "var(--red)" : "inherit"}` }, [el("b", { text: `AI verdict: ${it.ai.verdict}` }),
          el("span", { "data-no-i18n": true, text: ` — ${it.ai.verdict_reasons.map((x) => IV.t(x)).join("; ")}` })]) : null,
      it.ai ? el("details.ai-report", {}, [el("summary", { text: `AI report (${it.ai.model})` }), el("div.agent-report", { text: it.ai.report || "(none)" })]) : null,
      el("button.btn.small.ai", { text: it.ai ? "Chat with the AI about this curve…" : "AI analysis / chat for this curve…", onclick: () => openAIFor(batch.selected) }),
      el("p.muted", { text: "Shaded on the plot: transition (left) and saturation (right) fit regions." }),
    ].filter(Boolean));
  }

  IV.openBatch = openBatch;
  IV.batch = batch;
})(window.IV = window.IV || {});
