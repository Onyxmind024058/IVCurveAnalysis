/* =============================================================================
   AI analysis agent (pre-alpha): a Mistral model that analyses one I–V curve
   with the app's tools (agent-tools.js), guided by a skill (agent/SKILL.md).

   The loop: system prompt (preamble + skill) → the model calls tools → the
   app runs them and returns JSON → … → the model calls submit_result. The
   key is the user's own Mistral API key; requests go straight from the
   browser to api.mistral.ai. No DOM here, so it also runs under Node.
   ============================================================================= */
(function (root) {
  "use strict";
  const T = (root.IV && root.IV.agentTools) || (typeof require !== "undefined" ? require("./agent-tools.js") : null);

  const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";
  const MODELS = [
    ["mistral-large-latest", "Mistral Large (best)"],
    ["mistral-medium-latest", "Mistral Medium"],
    ["mistral-small-latest", "Mistral Small (fast, cheap)"],
  ];
  const MAX_TURNS = 16;

  /** How the skill maps onto this app; sent before the skill text. */
  const PREAMBLE = `You are the analysis agent of the IV Analyser UB, a Langmuir probe I–V analysis app.
You analyse ONE mean I–V curve that is loaded in the app, for a cylindrical probe in the OML regime.

How you work here:
- You cannot run Python, read files or see plots. You work only through the tools, which run the app's own analysis (the same code as its manual OML window). Wherever the skill below says to run langmuir_pipeline.py, use the tools instead; their JSON fields have the same meaning (Te_eV is the single-temperature Te, Vp_dIdV_V and Vp_intersection_V are the two Vp values, Vp_check is the Vp check in volts, quality_flags and status as in the skill).
- Never compute, estimate or invent a physical value yourself. Report only numbers returned by the tools.
- Steps: (1) get_curve_overview; (2) propose_regions; (3) if the status is "check", try to fix the flags with evaluate_regions and inspect_window — move the transition window to the straight part of ln(Ie) between Vf and the knee, the saturation window above the knee, the ion region a few Te below Vf — at most about 8 evaluations; (4) submit_result with the best regions and your report. Always finish with submit_result.
- Do not hide a problem to get status "good": if the Vp check stays "review" (more than 5 V, or 2–5 V without Te confirmation), submit anyway and say clearly that the curve needs review by eye.
- Not available in the app: two-temperature fits, the Druyvesteyn EEDF, plots and npz files. Do not quote Tc, Th or EEDF numbers. You may mention signs of a second electron population seen with inspect_window (a clear change of slope of ln(Ie) between Vf and the knee) as something to check in the app's EEPF window.
- The report is plain text for a physicist: status first (good / check, with every flag), then the results with units, the cross-checks, the caveats, and which regions you chose and why (in one or two sentences). Be concise. Write in English unless the user's request is in another language.

The skill follows.
--- SKILL ---
`;

  function userPrompt(ctx, request) {
    const probe = ctx.probe ? `${ctx.probe.diameter_mm} mm × ${ctx.probe.length_mm} mm cylindrical probe` : "cylindrical probe";
    return `Analyse the mean I–V curve of "${ctx.file || "the loaded file"}" (${probe}, ${ctx.species}, ${ctx.massAmu} amu, x axis ${ctx.xkey}).`
      + (request ? `\nRequest from the user: ${request}` : "");
  }

  class AgentError extends Error {}

  /** One chat completion. Throws AgentError with a message for the user. */
  async function chat({ apiKey, model, messages, endpoint = MISTRAL_URL, fetchImpl, signal }) {
    let res;
    try {
      res = await fetchImpl(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model, messages, tools: T.TOOL_DEFS, tool_choice: "any", parallel_tool_calls: false, temperature: 0.2 }),
        signal,
      });
    } catch (e) {
      if (e && e.name === "AbortError") throw e;
      throw new AgentError("Could not reach api.mistral.ai (offline, or the request was blocked by the browser or a network filter).");
    }
    if (!res.ok) {
      let detail = "";
      try { const j = await res.json(); detail = (j && (j.message || (j.error && j.error.message) || j.detail)) || ""; } catch (_) { /* no JSON */ }
      if (typeof detail !== "string") detail = JSON.stringify(detail);
      if (res.status === 401) throw new AgentError("Mistral rejected the API key (401). Check it under “API key…”.");
      if (res.status === 429) throw new AgentError("Mistral rate limit or quota reached (429). Wait a moment or check your plan.");
      throw new AgentError(`Mistral error ${res.status}${detail ? `: ${detail}` : ""}`);
    }
    return res.json();
  }

  function parseArgs(raw) {
    if (raw && typeof raw === "object") return raw;
    try { return JSON.parse(raw || "{}"); } catch (_) { return null; }
  }

  /**
   * Runs the agent on ctx (from agentTools.makeContext). onEvent receives
   * {type: "text" | "tool" | "result" | "info", ...} for the step log.
   * Resolves to {final, turns, usage, messages}; final is null if the agent
   * did not submit a result.
   */
  async function run({ ctx, apiKey, model = MODELS[0][0], skill, request = "", onEvent = () => {}, signal,
    fetchImpl = (typeof fetch !== "undefined" ? fetch.bind(root) : null), endpoint = MISTRAL_URL, maxTurns = MAX_TURNS }) {
    if (!apiKey) throw new AgentError("No Mistral API key set.");
    const messages = [
      { role: "system", content: PREAMBLE + (skill || "") },
      { role: "user", content: userPrompt(ctx, request) },
    ];
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    let final = null, nudges = 0, turns = 0;
    while (turns < maxTurns && !final) {
      turns++;
      const resp = await chat({ apiKey, model, messages, endpoint, fetchImpl, signal });
      if (resp.usage) { usage.prompt_tokens += resp.usage.prompt_tokens || 0; usage.completion_tokens += resp.usage.completion_tokens || 0; }
      const msg = resp.choices && resp.choices[0] && resp.choices[0].message;
      if (!msg) throw new AgentError("Unexpected answer from Mistral (no message).");
      const calls = msg.tool_calls || [];
      messages.push({ role: "assistant", content: msg.content || "", ...(calls.length ? { tool_calls: calls } : {}) });
      const text = typeof msg.content === "string" ? msg.content.trim() : "";
      if (text) onEvent({ type: "text", text });
      if (!calls.length) {
        if (++nudges > 2) break;
        messages.push({ role: "user", content: "Continue with the tools and finish with submit_result." });
        continue;
      }
      for (const tc of calls) {
        const name = tc.function && tc.function.name;
        const args = parseArgs(tc.function && tc.function.arguments);
        onEvent({ type: "tool", name, args });
        const out = args === null ? { content: { error: "The arguments are not valid JSON." } } : T.call(ctx, name, args);
        onEvent({ type: "result", name, content: out.content });
        messages.push({ role: "tool", tool_call_id: tc.id, name, content: JSON.stringify(out.content) });
        if (out.final) { final = out.final; break; }
      }
    }
    if (!final) onEvent({ type: "info", text: `The agent stopped after ${turns} steps without submitting a result.` });
    return { final, turns, usage, messages };
  }

  const api = { run, chat, MODELS, MISTRAL_URL, PREAMBLE, userPrompt, AgentError };
  if (root.IV) root.IV.agent = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
