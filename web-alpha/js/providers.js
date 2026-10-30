/* =============================================================================
   AI providers for the agent (pre-alpha): where requests go and how they are
   written. The agent keeps one conversation format (OpenAI-style chat
   messages with tool_calls); each provider turns it into its own request and
   its answer back into that format.

   - "openai" format: Mistral, ChatGPT (OpenAI), Groq, Gemini (Google's
     OpenAI-compatible endpoint) and any other OpenAI-compatible server
     (cortecs.ai, Kimi/Moonshot, OpenRouter, a local Ollama/LM Studio…).
   - "anthropic" format: Claude (Messages API, called directly from the
     browser). Claude's own content blocks are kept with each assistant
     message (_raw) and sent back unchanged, as the API requires.

   Pure functions (no DOM), so it also runs under Node for the tests.
   ============================================================================= */
(function (root) {
  "use strict";

  /**
   * required: how "the model must call a tool" is written (or "auto" where
   * forcing is not supported; the agent then reminds the model instead).
   * parallel: whether to send parallel_tool_calls: false. temperature: sent
   * only where every model accepts it.
   */
  const PROVIDERS = [
    { id: "mistral", label: "Mistral", format: "openai", url: "https://api.mistral.ai/v1/chat/completions",
      keyUrl: "https://console.mistral.ai/api-keys", required: "any", parallel: true, temperature: 0.2,
      models: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"] },
    { id: "openai", label: "ChatGPT (OpenAI)", format: "openai", url: "https://api.openai.com/v1/chat/completions",
      keyUrl: "https://platform.openai.com/api-keys", required: "required", parallel: true,
      models: ["gpt-5", "gpt-5-mini", "gpt-4.1"] },
    { id: "anthropic", label: "Claude (Anthropic)", format: "anthropic", url: "https://api.anthropic.com/v1/messages",
      keyUrl: "https://platform.claude.com/settings/keys",
      models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] },
    { id: "gemini", label: "Gemini (Google)", format: "openai", url: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
      keyUrl: "https://aistudio.google.com/apikey", required: "auto", parallel: false,
      models: ["gemini-2.5-flash", "gemini-2.5-pro"] },
    { id: "groq", label: "Groq", format: "openai", url: "https://api.groq.com/openai/v1/chat/completions",
      keyUrl: "https://console.groq.com/keys", required: "required", parallel: true, temperature: 0.2,
      models: ["openai/gpt-oss-120b", "llama-3.3-70b-versatile", "moonshotai/kimi-k2-instruct"] },
    { id: "custom", label: "Other (OpenAI-compatible address)", format: "openai", url: "", custom: true,
      required: "auto", parallel: false, optionalKey: true,
      models: [] },
  ];
  const byId = (id) => PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];

  /** Full chat-completions URL from what the user typed (a base URL ending in /v1 is completed). */
  function customEndpoint(address) {
    let u = String(address || "").trim().replace(/\/+$/, "");
    if (!u) return "";
    if (!/\/chat\/completions$/.test(u)) u += "/chat/completions";
    return u;
  }

  const hostOf = (url) => { try { return new URL(url).host; } catch (_) { return url; } };

  // Claude: the Messages API version, and models that support server-side refusal fallbacks
  const ANTHROPIC_VERSION = "2026-10-21";
  const FALLBACK_BETA = "server-side-fallback-2026-07-01";
  const hasFallbacks = (model) => /^claude-(opus|sonnet|fable)-/.test(model) && !/^claude-sonnet-5$/.test(model);

  /** Only the fields every OpenAI-compatible server accepts (drops _raw and the like). */
  function openaiMessage(m) {
    const out = { role: m.role, content: m.content ?? "" };
    if (m.tool_calls && m.tool_calls.length) out.tool_calls = m.tool_calls;
    if (m.role === "tool") { out.tool_call_id = m.tool_call_id; if (m.name) out.name = m.name; }
    return out;
  }

  const textBlocks = (content) => {
    const t = typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c === "string" ? c : c && c.text) || "").join("") : "";
    return t.trim() ? [{ type: "text", text: t }] : [];
  };

  /** OpenAI-style history → Claude's system prompt and messages (tool results go in user turns; same-role turns merged). */
  function toAnthropic(messages) {
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const out = [];
    const push = (role, blocks) => {
      const last = out[out.length - 1];
      if (last && last.role === role) last.content.push(...blocks);
      else out.push({ role, content: [...blocks] });
    };
    for (const m of messages) {
      if (m.role === "system") continue;
      if (m.role === "user") push("user", textBlocks(m.content).length ? textBlocks(m.content) : [{ type: "text", text: "…" }]);
      else if (m.role === "tool") push("user", [{ type: "tool_result", tool_use_id: m.tool_call_id, content: String(m.content ?? "") }]);
      else if (m.role === "assistant") {
        if (Array.isArray(m._raw) && m._raw.length) { push("assistant", m._raw); continue; }  // Claude's own blocks, unchanged
        const blocks = textBlocks(m.content);
        for (const tc of m.tool_calls || []) {
          let input = {};
          try { input = typeof tc.function.arguments === "string" ? JSON.parse(tc.function.arguments || "{}") : tc.function.arguments || {}; } catch (_) { /* keep {} */ }
          blocks.push({ type: "tool_use", id: tc.id, name: tc.function.name, input });
        }
        push("assistant", blocks.length ? blocks : [{ type: "text", text: "…" }]);
      }
    }
    return { system, messages: out };
  }

  /**
   * The HTTP request for one chat turn. cfg: {provider, model, apiKey, endpoint?};
   * toolChoice: "required" | "auto" | "none"; tools: OpenAI-style tool list or null.
   */
  function buildRequest(cfg, { messages, tools, toolChoice = "required" }) {
    const p = byId(cfg.provider);
    const url = cfg.endpoint || (p.custom ? customEndpoint(cfg.address) : p.url);
    if (!url) throw new Error("Enter the address of the AI server (OpenAI-compatible).");
    if (p.format === "anthropic") {
      const { system, messages: msgs } = toAnthropic(messages);
      const body = { model: cfg.model, max_tokens: 16000, messages: msgs };
      if (system) body.system = system;
      if (tools) {
        body.tools = tools.map((t) => ({ name: t.function.name, description: t.function.description, input_schema: t.function.parameters }));
        // current Claude models reject forced tool use: "auto" + the agent's reminder instead
        body.tool_choice = toolChoice === "none" ? { type: "none" } : { type: "auto", disable_parallel_tool_use: true };
      }
      const headers = {
        "Content-Type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      };
      if (hasFallbacks(cfg.model)) { body.fallbacks = "default"; headers["anthropic-beta"] = FALLBACK_BETA; }
      return { url, headers, body };
    }
    const body = { model: cfg.model, messages: messages.map(openaiMessage) };
    if (p.temperature !== undefined) body.temperature = p.temperature;
    if (tools) {
      body.tools = tools;
      body.tool_choice = toolChoice === "required" ? p.required : toolChoice;
      if (p.parallel) body.parallel_tool_calls = false;
    }
    const headers = { "Content-Type": "application/json" };
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    return { url, headers, body };
  }

  /** Answer → {message: {content, tool_calls, _raw?}, usage: {prompt_tokens, completion_tokens}}; throws on a refusal. */
  function parseResponse(cfg, json) {
    const p = byId(cfg.provider);
    if (p.format === "anthropic") {
      if (json.stop_reason === "refusal") {
        const why = json.stop_details && (json.stop_details.explanation || json.stop_details.category);
        throw new Error(`Claude declined this request${why ? ` (${why})` : ""}.`);
      }
      const blocks = Array.isArray(json.content) ? json.content : [];
      const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      const calls = blocks.filter((b) => b.type === "tool_use")
        .map((b) => ({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input || {}) } }));
      const u = json.usage || {};
      return {
        message: { role: "assistant", content: text, ...(calls.length ? { tool_calls: calls } : {}), _raw: blocks },
        usage: { prompt_tokens: u.input_tokens || 0, completion_tokens: u.output_tokens || 0 },
      };
    }
    const msg = json.choices && json.choices[0] && json.choices[0].message;
    if (!msg) return { message: null, usage: {} };
    const u = json.usage || {};
    return { message: msg, usage: { prompt_tokens: u.prompt_tokens || 0, completion_tokens: u.completion_tokens || 0 } };
  }

  /** Error text from a failed answer's JSON (each provider nests it differently). */
  function errorDetail(json) {
    if (!json) return "";
    const d = json.message || (json.error && (json.error.message || json.error)) || json.detail || "";
    return typeof d === "string" ? d : JSON.stringify(d);
  }

  const api = { PROVIDERS, byId, customEndpoint, hostOf, buildRequest, parseResponse, toAnthropic, errorDetail, ANTHROPIC_VERSION };
  if (root.IV) root.IV.providers = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
