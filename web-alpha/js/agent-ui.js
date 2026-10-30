/* =============================================================================
   "AI analysis α" window (pre-alpha): AI provider, key and model, the skill, the
   agent's steps as they happen, and its result with the actions on it.
   ============================================================================= */
(function (IV) {
  "use strict";
  const { el, fmtG, fmtE } = IV.ui;

  const PROVIDER = "ivcurve-alpha.provider", ADDRESS = "ivcurve-alpha.customAddress";
  const keyName = (id) => `ivcurve-alpha.key.${id}`, modelName = (id) => `ivcurve-alpha.model.${id}`;
  const SKILL = "ivcurve-alpha.agentSkill", CONSENT = "ivcurve-alpha.agentConsent";
  const BUILTIN_SKILL = IV.AGENT_SKILL.name;
  const PV = IV.providers;

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return null; } },
    set(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch (_) { /* private mode */ } },
  };

  // ---------------------------------------------------------------------------
  // Skill: the built-in file, or one the user loaded (kept in this browser)
  // ---------------------------------------------------------------------------

  function customSkill() {
    try { const s = JSON.parse(store.get(SKILL) || "null"); return s && s.text ? s : null; } catch (_) { return null; }
  }
  async function skillText() {
    const custom = customSkill();
    if (custom) return { name: custom.name, text: custom.text };
    return { name: BUILTIN_SKILL, text: IV.AGENT_SKILL.text };
  }

  // ---------------------------------------------------------------------------
  // Provider settings (kept in this browser; one key and model per provider)
  // ---------------------------------------------------------------------------

  const providerId = () => PV.byId(store.get(PROVIDER) || "mistral").id;
  // keys and models saved by 2.6.0-alpha.1/.2 (Mistral only) still count
  const keyFor = (id) => store.get(keyName(id)) || (id === "mistral" ? store.get("ivcurve-alpha.mistralKey") : null);
  const modelFor = (id) => store.get(modelName(id)) || (id === "mistral" ? store.get("ivcurve-alpha.mistralModel") : null) || PV.byId(id).models[0] || "";

  /** Current connection: {provider, apiKey, model, address} plus a label for the user. */
  function connection() {
    const id = providerId(), p = PV.byId(id);
    const conn = { provider: id, apiKey: keyFor(id) || "", model: modelFor(id), address: p.custom ? store.get(ADDRESS) || "" : undefined };
    const url = p.custom ? PV.customEndpoint(conn.address) : p.url;
    return { conn, label: `${p.custom ? PV.hostOf(url) || "custom server" : p.label} · ${conn.model || "no model"}`, host: PV.hostOf(url), provider: p };
  }

  /** What is missing before a request can be sent (null if nothing). */
  function missing({ conn, provider }) {
    if (provider.custom && !conn.address) return "the server address";
    if (!conn.model) return "the model name";
    if (!conn.apiKey && !provider.optionalKey) return "the API key";
    return null;
  }

  function settingsDialog() {
    return new Promise((resolve) => {
      const d = IV.ui.openDialog({ title: "AI provider", small: true, padded: true, onClose: () => resolve() });
      let id = providerId();
      const sel = el("select", { style: "width:100%" }, PV.PROVIDERS.map((p) => el("option", { value: p.id, text: p.label })));
      const address = el("input", { type: "url", placeholder: "e.g. https://api.cortecs.ai/v1 or https://api.moonshot.ai/v1", spellcheck: "false", style: "width:100%" });
      const key = el("input", { type: "password", autocomplete: "off", spellcheck: "false", style: "width:100%" });
      const model = el("input", { type: "text", spellcheck: "false", list: "aiModelList", style: "width:100%" });
      const models = el("datalist", { id: "aiModelList" });
      const keyHelp = el("p.muted", { style: "margin:4px 0 0;font-size:12px" });
      const addressRow = el("div", {}, [el("label", { text: "Server address (OpenAI-compatible)" }), address,
        el("p.muted", { style: "margin:4px 0 0;font-size:12px", text: "For other providers with an OpenAI-compatible API (cortecs.ai, Kimi/Moonshot, OpenRouter, a local Ollama or LM Studio…). The base address ending in /v1 is enough. The server must accept requests from web pages (CORS)." })]);
      const fill = () => {
        const p = PV.byId(id);
        sel.value = id;
        addressRow.classList.toggle("hidden", !p.custom);
        address.value = store.get(ADDRESS) || "";
        key.value = keyFor(id) || "";
        key.placeholder = p.optionalKey ? "API key (leave empty if the server needs none)" : `Your ${p.label} API key`;
        model.value = modelFor(id);
        model.placeholder = p.custom ? "Model name as the server expects it, e.g. kimi-k2" : "";
        models.replaceChildren(...p.models.map((m) => el("option", { value: m })));
        keyHelp.innerHTML = p.keyUrl
          ? `Create a key at <a href="${p.keyUrl}" target="_blank" rel="noopener">${IV.escape(PV.hostOf(p.keyUrl))}</a>. Stored only in this browser and sent only to ${IV.escape(PV.hostOf(p.url))}; the provider bills the requests to your account.`
          : "Stored only in this browser and sent only to the address above.";
      };
      sel.addEventListener("change", () => { id = sel.value; fill(); });
      d.body.append(
        el("div", { style: "display:flex;flex-direction:column;gap:10px" }, [
          el("div", {}, [el("label", { text: "Provider" }), sel]),
          addressRow,
          el("div", {}, [el("label", { text: "API key" }), key, keyHelp]),
          el("div", {}, [el("label", { text: "Model" }), model, models,
            el("p.muted", { style: "margin:4px 0 0;font-size:12px", text: "Pick a suggestion or type any model name the provider offers. The model must support tool (function) calling." })]),
        ]),
      );
      const save = () => {
        store.set(PROVIDER, id);
        if (PV.byId(id).custom) store.set(ADDRESS, address.value.trim() || null);
        store.set(keyName(id), key.value.trim() || null);
        store.set(modelName(id), model.value.trim() || null);
        d.close();
      };
      d.foot.append(
        el("button.btn", { text: "Forget key", onclick: () => { store.set(keyName(id), null); if (id === "mistral") store.set("ivcurve-alpha.mistralKey", null); key.value = ""; } }),
        el("span.spacer"),
        el("button.btn", { text: "Cancel", onclick: () => d.close() }),
        el("button.btn.primary", { text: "Save", onclick: save }),
      );
      fill();
    });
  }

  async function confirmSending(host, label) {
    const k = `${CONSENT}.${host}`;
    if (store.get(k) === "yes" || (host === "api.mistral.ai" && store.get(CONSENT) === "yes")) return true;
    const choice = await IV.ui.message(`Send this curve to ${label}?`,
      `<p style="margin:0 0 8px">Everywhere else this app keeps your data on your computer. The AI analysis is the exception:
       to work, it sends to <b>${IV.escape(host)}</b> the mean I–V curve (as tables of numbers produced by the app's tools),
       the file name and the probe/gas settings, together with the skill text.</p>
       <p style="margin:0" class="muted">The provider processes the requests under the terms of your account with it. This is asked once per provider and browser.</p>`,
      [{ label: "Cancel" }, { label: "Send and analyse", value: "yes", primary: true }]);
    if (choice !== "yes") return false;
    store.set(k, "yes");
    return true;
  }

  /**
   * Connection (asks for missing settings), consent and skill; null if the user
   * cancels. Shared by the window, the chat and the batch review.
   * Resolves to {conn, label, skill}.
   */
  async function prepare() {
    let c = connection();
    if (missing(c)) { await settingsDialog(); c = connection(); }
    const gap = missing(c);
    if (gap) { IV.ui.toast(`AI provider: ${gap} is missing.`, "error"); return null; }
    if (!(await confirmSending(c.host, c.provider.custom ? c.host : c.provider.label))) return null;
    try {
      const skill = await skillText();
      return { conn: c.conn, label: c.label, skill };
    } catch (e) {
      IV.ui.message("Skill", IV.escape(e.message));
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Step log
  // ---------------------------------------------------------------------------

  const v = (x, unit = "V") => (x === null || x === undefined ? "–" : `${fmtG(x, 4)} ${unit}`);
  const range = (a, b) => `${fmtG(a, 4)}…${fmtG(b, 4)} V`;

  function describeCall(name, a) {
    if (!a) return name;
    if (name === "evaluate_regions" || name === "submit_result") {
      return `${name}: ion ${range(a.ion_vmin, a.ion_vmax)} · transition ${range(a.trans_min, a.trans_max)} · saturation ${range(a.sat_min, a.sat_max)}`
        + (a.vf !== undefined ? ` · Vf ${v(a.vf)}` : "") + (a.vp_didv !== undefined ? ` · Vp(dI/dV) ${v(a.vp_didv)}` : "");
    }
    if (name === "inspect_window") return `${name}: ${range(a.vmin, a.vmax)}`;
    return name;
  }

  function describeResult(name, c) {
    if (c.error) return { text: `Error: ${c.error}`, kind: "bad" };
    if (name === "get_curve_overview") return { text: `${c.points} points, ${range(c.V_min, c.V_max)} · Vf ≈ ${v(c.Vf_zero_crossing_V)} · ${c.ion.species} ${c.ion.mass_amu} amu` };
    if (name === "inspect_window") return { text: c.slope_per_V !== undefined ? `Te from slope ${v(c.Te_eV_from_slope, "eV")} · R² ${fmtG(c.r2, 5)} · ${c.points} points` : c.note };
    if (name === "submit_result") return { text: `Submitted · status ${c.status}`, kind: c.status === "good" ? "good" : "warn" };
    if (c.status) {
      const vp = `Vp ${v(c.Vp_dIdV_V)} / ${v(c.Vp_intersection_V)} (ΔVp ${v(c.Vp_difference_V)}, ${c.Vp_check})`;
      return {
        text: `${c.status} · Te ${v(c.Te_eV, "eV")} · ${vp} · ne ${fmtE(c.ne_m3, 2)} m⁻³`
          + (c.quality_flags.length ? `\n${c.quality_flags.map((f) => `– ${f}`).join("\n")}` : ""),
        kind: c.status === "good" ? "good" : "warn",
      };
    }
    return { text: "done" };
  }

  // ---------------------------------------------------------------------------
  // Window
  // ---------------------------------------------------------------------------

  let ui = null;

  function openAgent() {
    if (ui) return;
    let curve;
    try { curve = IV.app.agentCurve(); } catch (e) { IV.ui.message("No data", IV.escape(e.message)); return; }
    const d = IV.ui.openDialog({ title: "AI analysis α — AI agent (pre-alpha)", onClose: () => { if (ui && ui.abort) ui.abort.abort(); ui = null; } });
    d.dlg.classList.add("agent");
    ui = { d, abort: null, last: null, ctx: null, messages: [] };

    // --- side: settings and run --------------------------------------------
    const keyLine = el("div.agent-provider");
    const paintKey = () => {
      const c = connection(), gap = missing(c), k = c.conn.apiKey;
      keyLine.replaceChildren(
        el("div", { text: c.label }),
        el("div.muted", { style: "font-size:12px" }, [
          gap ? el("span.warn-text", { text: `${gap} not set` }) : k ? `key set (…${k.slice(-4)})` : "no key (none needed)",
          ` · ${c.host || "no address"}`]),
      );
    };

    const skillLine = el("span");
    const paintSkill = () => { const c = customSkill(); skillLine.textContent = c ? c.name : BUILTIN_SKILL; };
    const skillInput = el("input", { type: "file", hidden: true, accept: ".md,.txt,text/markdown,text/plain" });
    skillInput.addEventListener("change", async () => {
      const f = skillInput.files[0]; skillInput.value = "";
      if (!f) return;
      const text = await f.text();
      if (!text.trim()) { IV.ui.toast("That file is empty.", "error"); return; }
      store.set(SKILL, JSON.stringify({ name: f.name, text }));
      paintSkill();
      IV.ui.toast(`Skill “${f.name}” will be used for the next analyses.`);
    });
    const viewSkill = async () => {
      try {
        const s = await skillText();
        IV.ui.message(`Skill: ${s.name}`, `<pre class="agent-skill">${IV.escape(s.text)}</pre>`);
      } catch (e) { IV.ui.message("Skill", IV.escape(e.message)); }
    };

    const request = el("textarea", { rows: 3, placeholder: "Optional, e.g. “the plasma may be bi-Maxwellian” or “answer in French”" });
    const runBtn = el("button.btn.primary", { text: "Run AI analysis" });
    const stopBtn = el("button.btn", { text: "Stop", disabled: true });

    const side = el("div.agent-side", {}, [
      el("h3", { text: "Curve" }),
      el("p.muted", { style: "margin:0", text: `${curve.file || "loaded data"} · ${IV.app.settingsSummary()}` }),
      el("h3", { text: "AI provider" }),
      el("div.agent-row", {}, [keyLine, el("span.spacer"),
        el("button.btn.small", { text: "Provider & key…", onclick: async () => { await settingsDialog(); paintKey(); } })]),
      el("h3", { text: "Skill" }),
      el("div.agent-row", {}, [skillLine]),
      el("div.agent-row", {}, [
        el("button.btn.small", { text: "View", onclick: viewSkill }),
        el("button.btn.small", { text: "Load skill file…", onclick: () => skillInput.click() }),
        el("button.btn.small", { text: "Built-in", onclick: () => { store.set(SKILL, null); paintSkill(); } }),
        skillInput,
      ]),
      el("h3", { text: "Instructions for the agent" }),
      request,
      el("div.agent-row", { style: "margin-top:10px" }, [runBtn, stopBtn]),
      el("p.muted", { style: "margin:10px 0 0;font-size:12px", text: "Runs only when you click. The agent works through the app's own analysis, so every number comes from the app; it cannot change your data or files." }),
    ]);
    paintKey(); paintSkill();

    // --- main: result and steps --------------------------------------------
    const resultBox = el("div.agent-result", {}, [el("div.empty-state", { text: "The result appears here when the agent has finished." })]);
    const steps = el("ul.agent-steps");
    const stepsBox = el("details.agent-steps-box", { open: true }, [el("summary", { text: "Steps of the analysis" }), steps]);

    // chat about this curve (continues the analysis when there is one)
    const chatLog = el("div.agent-chat-log", {}, [el("p.muted", { text: "Ask about this curve, e.g. “Why is the Vp check only ok?”, “Try a transition from −1 to 6 V”, “Is there a second electron temperature?”. The assistant checks with the app's tools before answering." })]);
    const chatInput = el("textarea", { rows: 2, placeholder: "Your question… (Enter to send, Shift+Enter for a new line)" });
    const sendBtn = el("button.btn.primary", { text: "Send" });
    const newChatBtn = el("button.btn", { text: "New chat", title: "Forget the conversation (the result above stays)" });
    const chatBox = el("section.agent-chat", {}, [
      el("h3", { text: "Chat about this curve" }), chatLog,
      el("div.agent-chat-input", {}, [chatInput, el("div.agent-row", {}, [sendBtn, newChatBtn])]),
    ]);
    const main = el("div.agent-main", {}, [resultBox, chatBox, stepsBox]);
    d.body.append(el("div.agent-grid", {}, [side, main]));
    d.foot.append(el("span.spacer"), el("button.btn", { text: "Close", onclick: () => d.close() }));

    const addStep = (cls, text) => {
      const li = el(`li.${cls}`, { text });
      steps.append(li);
      li.scrollIntoView({ block: "nearest" });
      return li;
    };

    const onEvent = (ev) => {
      if (ev.type === "text") addStep("say", ev.text);
      else if (ev.type === "tool") addStep("call", `→ ${describeCall(ev.name, ev.args)}`);
      else if (ev.type === "result") { const r = describeResult(ev.name, ev.content); addStep(`res${r.kind ? `.${r.kind}` : ""}`, r.text); }
      else if (ev.type === "info") addStep("info", ev.text);
    };

    const busy = (on) => {
      runBtn.disabled = on; sendBtn.disabled = on; newChatBtn.disabled = on; stopBtn.disabled = !on;
    };

    runBtn.addEventListener("click", async () => {
      const ready = await prepare();
      paintKey();
      if (!ready) return;
      const skill = ready.skill;
      try { curve = IV.app.agentCurve(); } catch (e) { IV.ui.message("No data", IV.escape(e.message)); return; }
      steps.replaceChildren();
      resultBox.replaceChildren(el("div.empty-state", { text: "The agent is working…" }));
      busy(true);
      stepsBox.open = true;
      ui.abort = new AbortController();
      const started = Date.now();
      addStep("info", `${ready.label} · skill ${skill.name}`);
      try {
        const ctx = IV.agentTools.makeContext(curve);
        // a new analysis starts a new conversation for the chat
        ui.ctx = ctx; ui.messages = [];
        resetChatLog("The chat continues from this analysis.");
        const out = await IV.agent.run({
          ctx, ...ready.conn, skill: skill.text, request: request.value.trim(),
          onEvent, signal: ui.abort.signal,
        });
        if (ui) ui.messages = out.messages;
        const meta = `${out.turns} steps · ${Math.round((Date.now() - started) / 1000)} s · ${out.usage.prompt_tokens + out.usage.completion_tokens} tokens · ${ready.label}`;
        if (out.final) showResult(out.final, meta, skill.name);
        else resultBox.replaceChildren(el("div.empty-state", { text: "The agent did not submit a result. Run it again, or try another model." }));
      } catch (e) {
        if (e && e.name === "AbortError") addStep("info", "Stopped.");
        else { addStep("res.bad", e.message); IV.ui.toast(e.message, "error", "AI analysis"); }
        resultBox.replaceChildren(el("div.empty-state", { text: "No result." }));
      } finally {
        if (ui) { ui.abort = null; busy(false); }
      }
    });
    stopBtn.addEventListener("click", () => { if (ui && ui.abort) ui.abort.abort(); });

    // --- chat -------------------------------------------------------------
    function resetChatLog(note) {
      chatLog.replaceChildren(el("p.muted", { text: note }));
    }
    const chatLine = (cls, text) => {
      const line = el(`div.chat-msg.${cls}`, { text });
      chatLog.append(line);
      line.scrollIntoView({ block: "nearest" });
      return line;
    };

    async function sendChat() {
      const text = chatInput.value.trim();
      if (!text || sendBtn.disabled) return;
      const ready = await prepare();
      paintKey();
      if (!ready) return;
      if (!ui.ctx) {
        try { ui.ctx = IV.agentTools.makeContext(IV.app.agentCurve()); } catch (e) { IV.ui.message("No data", IV.escape(e.message)); return; }
      }
      chatInput.value = "";
      chatLine("user", text);
      const waiting = chatLine("tool", "…");
      busy(true);
      ui.abort = new AbortController();
      try {
        const out = await IV.agent.converse({
          ctx: ui.ctx, messages: ui.messages, text, ...ready.conn, skill: ready.skill.text,
          signal: ui.abort.signal,
          onEvent: (ev) => { if (ev.type === "tool") chatLog.insertBefore(el("div.chat-msg.tool", { text: `→ ${describeCall(ev.name, ev.args)}` }), waiting); },
        });
        waiting.remove();
        if (!ui) return;
        ui.messages = out.messages;
        chatLine("ai", out.reply || "(no answer)");
        if (out.final) {
          showResult(out.final, `updated from the chat · ${ready.label}`, ready.skill.name);
          chatLine("tool", "The result above was updated with the new regions.");
        }
      } catch (e) {
        waiting.remove();
        if (e && e.name === "AbortError") chatLine("tool", "Stopped.");
        else chatLine("err", e.message);
      } finally {
        if (ui) { ui.abort = null; busy(false); }
      }
    }
    sendBtn.addEventListener("click", sendChat);
    chatInput.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendChat(); } });
    newChatBtn.addEventListener("click", () => { ui.messages = []; ui.ctx = null; resetChatLog("New conversation."); });

    function showResult(final, meta, skillName) {
      const s = final.summary, r = final.results;
      ui.last = final;
      const good = s.status === "good";
      const rows = [
        ["Floating potential Vf", v(s.Vf_V)],
        ["Vp from dI/dV", v(s.Vp_dIdV_V)],
        ["Vp from fit intersection", v(s.Vp_intersection_V)],
        ["Vp check", `${s.Vp_check}${s.Vp_difference_V !== null ? ` (ΔVp ${v(s.Vp_difference_V)}, ${s.Vp_check_reason})` : ""}`],
        ["Final Vp", v(s.Vp_final_V)],
        ["Te", v(s.Te_eV, "eV")],
        ["Te from Vp − Vf (cyl. OML / planar)", `${v(s.Te_VpVf_OML_eV, "eV")} / ${v(s.Te_VpVf_planar_eV, "eV")} · ${s.Te_check}`],
        ["ne", `${fmtE(s.ne_m3, 3)} m⁻³`],
        ["ni (OML)", `${fmtE(s.ni_OML_m3, 3)} m⁻³ · ni/ne ${fmtG(s.ni_over_ne, 3)}`],
        ["Iis (at Vf)", `${fmtE(s.Iis_at_Vf_A, 3)} A`],
        ["Regions", `ion ${range(s.regions.ion_vmin, s.regions.ion_vmax)}, transition ${range(s.regions.trans_min, s.regions.trans_max)}, saturation ${range(s.regions.sat_min, s.regions.sat_max)}`],
      ];
      const reportText = () => [
        `AI analysis (${meta}; skill ${skillName}) — ${curve.file || "loaded data"}`,
        `Status: ${s.status}${s.quality_flags.length ? `\n${s.quality_flags.map((f) => `- ${f}`).join("\n")}` : ""}`,
        rows.map(([k, x]) => `${k}: ${x}`).join("\n"),
        "", final.report,
      ].join("\n");
      resultBox.replaceChildren(...[
        el("div.agent-status", {}, [
          el(`span.pill.${good ? "good" : "warn"}`, { text: good ? "✓ good" : "⚠ check" }),
          el("span.muted", { text: ` ${meta}` }),
        ]),
        s.quality_flags.length ? el("ul.agent-flags", {}, s.quality_flags.map((f) => el("li", { text: f }))) : null,
        el("table.results", {}, rows.map(([k, x]) => el("tr", {}, [el("th", { text: k }), el("td", { text: x })]))),
        el("h3", { text: "Report of the agent" }),
        el("div.agent-report", { text: final.report || "(no report)" }),
        el("p.muted", { style: "font-size:12px;margin:6px 0 0", text: "The numbers above are computed by the app for the agent's regions; the report is the agent's own text." }),
        el("div.agent-row", { style: "margin-top:10px" }, [
          el("button.btn.primary", { text: "Open in manual OML to check…", onclick: () => IV.app.openManualWith(final.params) }),
          el("button.btn", { text: "Show in main window", onclick: () => { IV.app.useAgentResult(JSON.parse(JSON.stringify(r))); IV.ui.toast("Result added to the main window (marked as not reviewed)."); } }),
          el("button.btn", { text: "Copy report", onclick: () => navigator.clipboard.writeText(reportText()).then(() => IV.ui.toast("Report copied.")) }),
        ]),
      ].filter(Boolean));
    }
  }

  IV.openAgent = openAgent;
  IV.agentUI = { prepare, connection, describeCall, describeResult };
})(window.IV = window.IV || {});
