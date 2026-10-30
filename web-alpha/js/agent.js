/* =============================================================================
   AI analysis agent (pre-alpha): a Mistral model that analyses one I–V curve
   with the app's tools (agent-tools.js), guided by a skill (agent-skill.js).

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

  /** Follow-up questions about one curve (chat). */
  const CHAT_PREAMBLE = `You are the analysis assistant of the IV Analyser UB, a Langmuir probe I–V analysis app.
The user asks questions about ONE mean I–V curve loaded in the app (cylindrical probe, OML regime).

- Use the tools to check before you answer: get_curve_overview, propose_regions, evaluate_regions, inspect_window. They run the app's own analysis. You cannot run Python, read files or see plots.
- Never compute, estimate or invent a physical value yourself. Quote only numbers returned by the tools, with units.
- If the user asks to try other regions, evaluate them and report the checks (Vp check in volts, Te from Vp − Vf, quality flags). Call submit_result only when the user asks to use or keep regions as the result.
- Apply the rules of the skill below, in particular: ΔVp ≤ 2 V good; 2–5 V ok only if Te from Vp − Vf confirms the fitted Te; more than 5 V means review by eye.
- Answer briefly in plain text (no Markdown tables). Answer in the language of the question.

The skill follows.
--- SKILL ---
`;

  /** Summary of a batch (series of curves) from the app's results; no tools. */
  const SERIES_PREAMBLE = `You summarise a series of Langmuir probe I–V analyses (one curve per file, cylindrical probe, OML) for a physicist.
The table below was produced by the IV Analyser UB app. Use only its numbers; never invent or recompute values.

- Start with the status of the series: how many curves were reviewed by a person, analysed by the AI only, or still need review, and list the files that need review by eye (Vp check "review", quality flags).
- Then describe the trends of Te, ne, ni/ne, Vp and Vf against the parameter, leaving out the curves that need review (say so).
- Point out outliers and inconsistencies (Te vs Te from Vp − Vf, ni/ne far from 1).
- Plain text, short paragraphs or lists, no Markdown tables. Write in English unless asked otherwise.

The skill the analyses follow:
--- SKILL ---
`;

  class AgentError extends Error {}

  /**
   * Request pacing: Mistral's free tier allows about one request per second.
   * A 429 (rate limit) is retried after these delays before giving up.
   */
  const pacing = { minIntervalMs: 1100, retryDelaysMs: [2000, 5000, 10000] };
  let lastRequestAt = 0;
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (!(ms > 0)) { resolve(); return; }
    const t = setTimeout(resolve, ms);
    if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(Object.assign(new Error("Aborted"), { name: "AbortError" })); }, { once: true });
  });

  /**
   * One chat completion. tools: tool definitions or null (plain answer);
   * toolChoice: "any" (must call a tool) or "auto". Throws AgentError with a
   * message for the user.
   */
  async function chat({ apiKey, model, messages, tools = T.TOOL_DEFS, toolChoice = "any", endpoint = MISTRAL_URL, fetchImpl, signal }) {
    const body = { model, messages, temperature: 0.2 };
    if (tools) Object.assign(body, { tools, tool_choice: toolChoice, parallel_tool_calls: false });
    for (let attempt = 0; ; attempt++) {
      await sleep(lastRequestAt + pacing.minIntervalMs - Date.now(), signal);
      lastRequestAt = Date.now();
      let res;
      try {
        res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e) {
        if (e && e.name === "AbortError") throw e;
        throw new AgentError("Could not reach api.mistral.ai (offline, or the request was blocked by the browser or a network filter).");
      }
      if (res.ok) return res.json();
      if (res.status === 429 && attempt < pacing.retryDelaysMs.length) {
        await sleep(pacing.retryDelaysMs[attempt], signal);
        continue;
      }
      let detail = "";
      try { const j = await res.json(); detail = (j && (j.message || (j.error && j.error.message) || j.detail)) || ""; } catch (_) { /* no JSON */ }
      if (typeof detail !== "string") detail = JSON.stringify(detail);
      if (res.status === 401) throw new AgentError("Mistral rejected the API key (401). Check it under “API key…”.");
      if (res.status === 429) throw new AgentError("Mistral rate limit or quota reached (429), also after waiting. Wait a minute or check your plan.");
      throw new AgentError(`Mistral error ${res.status}${detail ? `: ${detail}` : ""}`);
    }
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
      addUsage(usage, resp);
      const msg = resp.choices && resp.choices[0] && resp.choices[0].message;
      if (!msg) throw new AgentError("Unexpected answer from Mistral (no message).");
      const calls = msg.tool_calls || [];
      messages.push({ role: "assistant", content: msg.content || "", ...(calls.length ? { tool_calls: calls } : {}) });
      const text = textOf(msg.content);
      if (text) onEvent({ type: "text", text });
      if (!calls.length) {
        if (++nudges > 2) break;
        messages.push({ role: "user", content: "Continue with the tools and finish with submit_result." });
        continue;
      }
      final = runTools(ctx, calls, messages, onEvent) || final;
    }
    if (!final) onEvent({ type: "info", text: `The agent stopped after ${turns} steps without submitting a result.` });
    return { final, turns, usage, messages };
  }

  /** Runs the tool calls of one answer and appends the tool messages; returns a submitted result, if any. */
  function runTools(ctx, calls, messages, onEvent) {
    let final = null;
    for (const tc of calls) {
      const name = tc.function && tc.function.name;
      if (final) {  // every call needs an answer, also after a submit
        messages.push({ role: "tool", tool_call_id: tc.id, name, content: JSON.stringify({ skipped: "a result was already submitted" }) });
        continue;
      }
      const args = parseArgs(tc.function && tc.function.arguments);
      onEvent({ type: "tool", name, args });
      const out = args === null ? { content: { error: "The arguments are not valid JSON." } } : T.call(ctx, name, args);
      onEvent({ type: "result", name, content: out.content });
      messages.push({ role: "tool", tool_call_id: tc.id, name, content: JSON.stringify(out.content) });
      if (out.final) final = out.final;
    }
    return final;
  }

  const addUsage = (usage, resp) => {
    if (resp.usage) { usage.prompt_tokens += resp.usage.prompt_tokens || 0; usage.completion_tokens += resp.usage.completion_tokens || 0; }
  };

  /**
   * One chat exchange about the curve in ctx. messages: the conversation so
   * far (empty to start one; after run() it continues the analysis). The
   * model may use the tools before it answers. Resolves to {reply, final,
   * usage, messages}; final is set if it submitted new regions.
   */
  async function converse({ ctx, messages = [], text, apiKey, model = MODELS[0][0], skill, onEvent = () => {}, signal,
    fetchImpl = (typeof fetch !== "undefined" ? fetch.bind(root) : null), endpoint = MISTRAL_URL, maxTurns = 8 }) {
    if (!apiKey) throw new AgentError("No Mistral API key set.");
    const convo = messages.length ? messages : [
      { role: "system", content: CHAT_PREAMBLE + (skill || "") },
      { role: "user", content: `${userPrompt(ctx, "")} The questions follow.` },
      { role: "assistant", content: "Ready. What would you like to know about this curve?" },
    ];
    const afterAnalysis = messages.length && convo[0].content.startsWith(PREAMBLE.slice(0, 40));
    convo.push({ role: "user", content: afterAnalysis
      ? `(Follow-up question. Answer in text; use the tools if needed; call submit_result only if I ask to change the result.)\n\n${text}`
      : text });
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    let final = null;
    for (let turn = 0; turn < maxTurns; turn++) {
      // the last turn must answer in text
      const resp = await chat({ apiKey, model, messages: convo, endpoint, fetchImpl, signal,
        tools: T.TOOL_DEFS, toolChoice: turn < maxTurns - 1 ? "auto" : "none" });
      addUsage(usage, resp);
      const msg = resp.choices && resp.choices[0] && resp.choices[0].message;
      if (!msg) throw new AgentError("Unexpected answer from Mistral (no message).");
      const calls = msg.tool_calls || [];
      convo.push({ role: "assistant", content: msg.content || "", ...(calls.length ? { tool_calls: calls } : {}) });
      if (!calls.length) return { reply: textOf(msg.content), final, usage, messages: convo };
      final = runTools(ctx, calls, convo, onEvent) || final;
    }
    return { reply: "(No answer: the assistant kept calling tools.)", final, usage, messages: convo };
  }

  /** Text of a message content (a string, or a list of text chunks). */
  function textOf(content) {
    if (typeof content === "string") return content.trim();
    if (Array.isArray(content)) return content.map((c) => (typeof c === "string" ? c : c && c.text) || "").join("").trim();
    return "";
  }

  /**
   * Summary of a series from rows of app results ({file, param, status, Te_eV, …}).
   * One request, no tools. Resolves to {text, usage}.
   */
  async function summarizeSeries({ rows, paramName = "Parameter", settings = "", apiKey, model = MODELS[0][0], skill, request = "", signal,
    fetchImpl = (typeof fetch !== "undefined" ? fetch.bind(root) : null), endpoint = MISTRAL_URL }) {
    if (!apiKey) throw new AgentError("No Mistral API key set.");
    const messages = [
      { role: "system", content: SERIES_PREAMBLE + (skill || "") },
      { role: "user", content: `Series of ${rows.length} curves; parameter: ${paramName}. Settings: ${settings}.`
        + `${request ? `\nRequest from the user: ${request}` : ""}\n\nResults (JSON, one object per file):\n${JSON.stringify(rows)}` },
    ];
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    const resp = await chat({ apiKey, model, messages, tools: null, endpoint, fetchImpl, signal });
    addUsage(usage, resp);
    const msg = resp.choices && resp.choices[0] && resp.choices[0].message;
    if (!msg) throw new AgentError("Unexpected answer from Mistral (no message).");
    return { text: textOf(msg.content), usage };
  }

  const api = { run, converse, summarizeSeries, chat, pacing, MODELS, MISTRAL_URL, PREAMBLE, CHAT_PREAMBLE, SERIES_PREAMBLE, userPrompt, textOf, AgentError };
  if (root.IV) root.IV.agent = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
