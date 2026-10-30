/* =============================================================================
   Checks for the AI providers (pre-alpha): request format per provider, the
   Claude (Messages API) conversion, and an agent run against a fake Claude.

       node --test web-alpha/tests/providers.test.js
   ============================================================================= */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../js/providers.js");
const T = require("../js/agent-tools.js");
const Agent = require("../js/agent.js");
const N = require("../js/numerics.js");

Agent.pacing.minIntervalMs = 0;
Agent.pacing.retryDelaysMs = [0, 0, 0];

const tools = T.TOOL_DEFS;
const history = [
  { role: "system", content: "SYS" },
  { role: "user", content: "Analyse" },
  { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "get_curve_overview", arguments: "{}" } }], _raw: null },
  { role: "tool", tool_call_id: "c1", name: "get_curve_overview", content: "{\"points\":10}" },
];

test("OpenAI-compatible providers: endpoint, key, tool choice", () => {
  const req = (provider, extra = {}) => P.buildRequest({ provider, model: "m", apiKey: "k", ...extra }, { messages: history, tools });
  const mistral = req("mistral");
  assert.equal(mistral.url, "https://api.mistral.ai/v1/chat/completions");
  assert.equal(mistral.body.tool_choice, "any");
  assert.equal(mistral.body.parallel_tool_calls, false);
  assert.equal(mistral.headers.Authorization, "Bearer k");
  const openai = req("openai");
  assert.equal(openai.url, "https://api.openai.com/v1/chat/completions");
  assert.equal(openai.body.tool_choice, "required");
  assert.equal(openai.body.temperature, undefined, "not every OpenAI model accepts a temperature");
  assert.ok(openai.body.messages.every((m) => !("_raw" in m)), "only standard fields are sent");
  const gemini = req("gemini");
  assert.match(gemini.url, /generativelanguage\.googleapis\.com\/v1beta\/openai\/chat\/completions$/);
  assert.equal(gemini.body.tool_choice, "auto");
  assert.equal(gemini.body.parallel_tool_calls, undefined);
  assert.equal(req("groq").url, "https://api.groq.com/openai/v1/chat/completions");
  assert.equal(req("groq").body.tool_choice, "required");
  // "auto" and "none" are passed through everywhere
  assert.equal(P.buildRequest({ provider: "openai", model: "m", apiKey: "k" }, { messages: history, tools, toolChoice: "none" }).body.tool_choice, "none");
  // no tools: plain answer
  assert.equal(P.buildRequest({ provider: "mistral", model: "m", apiKey: "k" }, { messages: history, tools: null }).body.tools, undefined);
});

test("custom address: completed to /chat/completions, key optional", () => {
  assert.equal(P.customEndpoint("https://api.cortecs.ai/v1"), "https://api.cortecs.ai/v1/chat/completions");
  assert.equal(P.customEndpoint("https://api.moonshot.ai/v1/"), "https://api.moonshot.ai/v1/chat/completions");
  assert.equal(P.customEndpoint("http://localhost:11434/v1/chat/completions"), "http://localhost:11434/v1/chat/completions");
  const r = P.buildRequest({ provider: "custom", model: "kimi-k2", address: "https://api.moonshot.ai/v1" }, { messages: history, tools });
  assert.equal(r.url, "https://api.moonshot.ai/v1/chat/completions");
  assert.equal(r.headers.Authorization, undefined);
  assert.equal(r.body.tool_choice, "auto");
  assert.throws(() => P.buildRequest({ provider: "custom", model: "x" }, { messages: history, tools }), /address/);
});

test("Claude: headers, system prompt, tools, tool results and tool choice", () => {
  const r = P.buildRequest({ provider: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant" }, { messages: history, tools });
  assert.equal(r.url, "https://api.anthropic.com/v1/messages");
  assert.equal(r.headers["x-api-key"], "sk-ant");
  assert.equal(r.headers["anthropic-version"], P.ANTHROPIC_VERSION);
  assert.equal(r.headers["anthropic-dangerous-direct-browser-access"], "true");
  assert.equal(r.headers.Authorization, undefined);
  assert.equal(r.body.system, "SYS");
  assert.equal(r.body.temperature, undefined);
  assert.ok(r.body.max_tokens >= 4096);
  assert.deepEqual(r.body.tool_choice, { type: "auto", disable_parallel_tool_use: true }, "forced tool use is not supported on current Claude models");
  assert.equal(r.body.tools[0].name, "get_curve_overview");
  assert.ok(r.body.tools[0].input_schema);
  assert.deepEqual(r.body.messages.map((m) => m.role), ["user", "assistant", "user"]);
  assert.deepEqual(r.body.messages[1].content, [{ type: "tool_use", id: "c1", name: "get_curve_overview", input: {} }]);
  assert.deepEqual(r.body.messages[2].content, [{ type: "tool_result", tool_use_id: "c1", content: "{\"points\":10}" }]);
  // refusal fallbacks on Opus/Sonnet, not on Haiku
  assert.equal(r.body.fallbacks, "default");
  assert.equal(r.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  const haiku = P.buildRequest({ provider: "anthropic", model: "claude-haiku-5-5", apiKey: "k" }, { messages: history, tools });
  assert.equal(haiku.body.fallbacks, undefined);
  assert.equal(haiku.headers["anthropic-beta"], undefined);
  const none = P.buildRequest({ provider: "anthropic", model: "claude-opus-5-5", apiKey: "k" }, { messages: history, tools, toolChoice: "none" });
  assert.deepEqual(none.body.tool_choice, { type: "none" });
  // a user message after tool results joins the same user turn
  const more = P.toAnthropic([...history, { role: "user", content: "Next?" }]).messages;
  assert.deepEqual(more.at(-1).content.map((b) => b.type), ["tool_result", "text"]);
});

test("Claude: answers become tool calls; its own blocks are kept; refusals are errors", () => {
  const blocks = [
    { type: "thinking", thinking: "", signature: "sig" },
    { type: "text", text: "Let me look." },
    { type: "tool_use", id: "toolu_1", name: "inspect_window", input: { vmin: -2, vmax: 7 } },
  ];
  const out = P.parseResponse({ provider: "anthropic" }, { content: blocks, stop_reason: "tool_use", usage: { input_tokens: 10, output_tokens: 3 } });
  assert.equal(out.message.content, "Let me look.");
  assert.deepEqual(JSON.parse(out.message.tool_calls[0].function.arguments), { vmin: -2, vmax: 7 });
  assert.equal(out.message._raw, blocks);
  assert.deepEqual(out.usage, { prompt_tokens: 10, completion_tokens: 3 });
  // sent back unchanged
  const again = P.toAnthropic([{ role: "user", content: "x" }, { role: "assistant", content: "Let me look.", tool_calls: out.message.tool_calls, _raw: blocks }]);
  assert.equal(again.messages[1].content[0], blocks[0]);
  assert.throws(() => P.parseResponse({ provider: "anthropic" }, { content: [], stop_reason: "refusal", stop_details: { category: "cyber" } }), /declined.*cyber/);
});

test("agent run with Claude: native format both ways", async () => {
  const AREA = Math.PI * 0.15e-3 * 10e-3, e = N.E_CHARGE, me = N.M_E;
  const Ie0 = AREA * 1e16 * e * Math.sqrt((e * 3) / (2 * Math.PI * me));
  const V = N.linspace(-60, 20, 800);
  const I = V.map((v) => -AREA * 1e16 * e * (Math.SQRT2 / Math.PI) * Math.sqrt(Math.max((e * (10 - v)) / (39.948 * N.AMU), 0))
    + (v < 10 ? Ie0 * Math.exp((v - 10) / 3) : Ie0 * (1 + 0.004 * (v - 10))));
  const ctx = T.makeContext({ V, I, area: AREA, massAmu: 39.948 });
  const seen = [];
  const regions = { ion_vmin: -59, ion_vmax: -20, trans_min: -2, trans_max: 7, sat_min: 13, sat_max: 19 };
  const script = [
    [{ type: "thinking", thinking: "", signature: "s1" }, { type: "tool_use", id: "toolu_a", name: "get_curve_overview", input: {} }],
    [{ type: "text", text: "Plan: submit." }, { type: "tool_use", id: "toolu_b", name: "submit_result", input: { ...regions, report: "ok" } }],
  ];
  const fetchImpl = async (url, init) => {
    seen.push({ url, headers: init.headers, body: JSON.parse(init.body) });
    const content = script[seen.length - 1];
    return { ok: true, status: 200, json: async () => ({ content, stop_reason: "tool_use", usage: { input_tokens: 5, output_tokens: 1 } }) };
  };
  const out = await Agent.run({ ctx, provider: "anthropic", apiKey: "sk-ant", model: "claude-sonnet-5-5", skill: "S", fetchImpl });
  assert.ok(out.final);
  assert.equal(seen[0].url, "https://api.anthropic.com/v1/messages");
  assert.equal(seen[0].body.model, "claude-sonnet-5-5");
  const second = seen[1].body.messages;
  assert.deepEqual(second[1].content, script[0], "thinking and tool_use blocks sent back unchanged");
  assert.equal(second[2].content[0].type, "tool_result");
  assert.equal(second[2].content[0].tool_use_id, "toolu_a");
});

test("errors name the provider", async () => {
  const ctx = T.makeContext({ V: N.linspace(-10, 10, 50), I: N.linspace(-1e-4, 1e-3, 50), area: 1e-6, massAmu: 40 });
  const fail = (status) => async () => ({ ok: false, status, json: async () => ({ error: { message: "bad" } }) });
  await assert.rejects(Agent.run({ ctx, provider: "anthropic", apiKey: "k", fetchImpl: fail(401) }), /Claude \(Anthropic\) rejected the API key/);
  await assert.rejects(Agent.run({ ctx, provider: "groq", apiKey: "k", fetchImpl: fail(400) }), /Groq error 400: bad/);
  await assert.rejects(Agent.run({ ctx, provider: "custom", address: "https://api.cortecs.ai/v1", fetchImpl: async () => { throw new TypeError("x"); } }), /Could not reach api\.cortecs\.ai/);
  await assert.rejects(Agent.run({ ctx, provider: "openai", fetchImpl: fail(400) }), /No API key set for ChatGPT/);
});
