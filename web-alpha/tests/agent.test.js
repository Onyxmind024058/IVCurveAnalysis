/* =============================================================================
   Checks for the AI analysis agent (pre-alpha): the tools on synthetic curves
   with known answers, and the agent loop against a scripted fake Mistral.

       node --test web-alpha/tests/agent.test.js
   ============================================================================= */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const N = require("../js/numerics.js");
const T = require("../js/agent-tools.js");
const Agent = require("../js/agent.js");

const e = N.E_CHARGE, me = N.M_E;
const AREA = Math.PI * 0.15e-3 * 10e-3;
const AR = 39.948;
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

/** Cylindrical OML probe curve with Maxwellian electrons (same as auto.test.js). */
function curve({ Te = 3, Vp = 10, n = 1e16, sigma = 2e-6, seed = 1, vmin = -60, vmax = 20, npts = 800 } = {}) {
  let s = seed;
  const g = () => { let t = 0; for (let k = 0; k < 12; k++) { s = (s * 1664525 + 1013904223) % 4294967296; t += s / 4294967296; } return t - 6; };
  const mi = AR * N.AMU, Ie0 = AREA * n * e * Math.sqrt((e * Te) / (2 * Math.PI * me));
  const V = N.linspace(vmin, vmax, npts);
  const I = V.map((v) => -AREA * n * e * (Math.SQRT2 / Math.PI) * Math.sqrt(Math.max((e * (Vp - v)) / mi, 0))
    + (v < Vp ? Ie0 * Math.exp((v - Vp) / Te) : Ie0 * (1 + 0.004 * (v - Vp))) + sigma * g());
  return { V, I };
}
const context = () => { const { V, I } = curve(); return T.makeContext({ V, I, area: AREA, massAmu: AR, species: "Ar⁺", file: "test.lda" }); };

test("overview and proposal give the known plasma", () => {
  const ctx = context();
  const ov = T.call(ctx, "get_curve_overview").content;
  assert.equal(ov.table.length, 60);
  assert.equal(ov.ion.mass_amu, 39.948);
  const pr = T.call(ctx, "propose_regions").content;
  assert.ok(rel(pr.Te_eV, 3) < 0.05, `Te ${pr.Te_eV}`);
  assert.ok(Math.abs(pr.Vp_dIdV_V - 10) < 1.5, `Vp ${pr.Vp_dIdV_V}`);  // smoothed dI/dV peak sits a little below Vp
  assert.ok(["good", "ok"].includes(pr.Vp_check), pr.Vp_check);
  assert.ok(pr.ni_over_ne > 0.5 && pr.ni_over_ne < 2, `ni/ne ${pr.ni_over_ne}`);
});

test("evaluate_regions applies the Vp rule in volts", () => {
  const ctx = context();
  const good = T.call(ctx, "evaluate_regions", { ion_vmin: -59, ion_vmax: -20, trans_min: -2, trans_max: 7, sat_min: 13, sat_max: 19 }).content;
  assert.equal(good.Vp_check, "good");
  assert.ok(rel(good.Te_eV, 3) < 0.05);
  // "saturation" window below the knee: the intersection Vp is far from the dI/dV peak
  const bad = T.call(ctx, "evaluate_regions", { ion_vmin: -59, ion_vmax: -20, trans_min: -2, trans_max: 7, sat_min: 4, sat_max: 9 }).content;
  assert.equal(bad.Vp_check, "review");
  assert.ok(bad.Vp_difference_V > 5);
  assert.equal(bad.status, "check");
});

test("tool errors come back as messages, not exceptions", () => {
  const ctx = context();
  assert.match(T.call(ctx, "evaluate_regions", { ion_vmin: 0 }).content.error, /Missing or invalid/);
  assert.match(T.call(ctx, "evaluate_regions", { ion_vmin: -10, ion_vmax: -20, trans_min: -2, trans_max: 7, sat_min: 13, sat_max: 19 }).content.error, /smaller/);
  assert.match(T.call(ctx, "nope").content.error, /Unknown tool/);
  const w = T.call(ctx, "inspect_window", { vmin: -2, vmax: 7 }).content;
  assert.ok(rel(w.Te_eV_from_slope, 3) < 0.05 && w.r2 > 0.99);
});

/** Fake Mistral: answers with the scripted tool calls, checks the requests. */
function fakeMistral(script, seen) {
  let i = 0;
  return async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, auth: init.headers.Authorization, body });
    const step = script[i++];
    if (step.status) return { ok: false, status: step.status, json: async () => ({ message: "nope" }) };
    return {
      ok: true, status: 200,
      json: async () => ({
        choices: [{ message: { role: "assistant", content: step.text || "", tool_calls: step.calls ? step.calls.map(([name, args], k) => ({ id: `c${i}${k}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) : undefined } }],
        usage: { prompt_tokens: 100, completion_tokens: 20 },
      }),
    };
  };
}

test("agent loop: tools, final result from the app, message format", async () => {
  const seen = [], events = [];
  const regions = { ion_vmin: -59, ion_vmax: -20, trans_min: -2, trans_max: 7, sat_min: 13, sat_max: 19 };
  const fetchImpl = fakeMistral([
    { calls: [["get_curve_overview", {}]] },
    { text: "Starting from the rules.", calls: [["propose_regions", {}]] },
    { calls: [["evaluate_regions", regions]] },
    { text: "Te says 999 eV", calls: [["submit_result", { ...regions, report: "Status: good." }]] },
  ], seen);
  const out = await Agent.run({ ctx: context(), apiKey: "k-123", model: "mistral-large-latest", skill: "SKILL TEXT", fetchImpl, onEvent: (ev) => events.push(ev) });
  assert.ok(out.final, "submitted");
  assert.equal(out.turns, 4);
  assert.ok(rel(out.final.results.Te_eV, 3) < 0.05, "numbers come from the app, not from the model text");
  assert.equal(out.final.report, "Status: good.");
  assert.equal(out.usage.prompt_tokens, 400);
  // requests
  assert.equal(seen[0].url, Agent.MISTRAL_URL);
  assert.equal(seen[0].auth, "Bearer k-123");
  assert.equal(seen[0].body.model, "mistral-large-latest");
  assert.equal(seen[0].body.tool_choice, "any");
  assert.deepEqual(seen[0].body.tools.map((t) => t.function.name), ["get_curve_overview", "propose_regions", "evaluate_regions", "inspect_window", "submit_result"]);
  assert.match(seen[0].body.messages[0].content, /--- SKILL ---\nSKILL TEXT$/);
  // each tool call is answered with a tool message carrying its id
  const second = seen[1].body.messages;
  assert.equal(second[2].role, "assistant");
  assert.equal(second[3].role, "tool");
  assert.equal(second[3].tool_call_id, second[2].tool_calls[0].id);
  assert.deepEqual(events.filter((ev) => ev.type === "tool").map((ev) => ev.name), ["get_curve_overview", "propose_regions", "evaluate_regions", "submit_result"]);
});

test("agent loop: clear errors for key, quota and network problems", async () => {
  const ctx = context();
  await assert.rejects(Agent.run({ ctx, apiKey: "", fetchImpl: async () => ({}) }), /No Mistral API key/);
  await assert.rejects(Agent.run({ ctx, apiKey: "k", fetchImpl: fakeMistral([{ status: 401 }], []) }), /rejected the API key/);
  await assert.rejects(Agent.run({ ctx, apiKey: "k", fetchImpl: fakeMistral([{ status: 429 }], []) }), /rate limit/);
  await assert.rejects(Agent.run({ ctx, apiKey: "k", fetchImpl: async () => { throw new TypeError("Failed to fetch"); } }), /Could not reach api\.mistral\.ai/);
});

test("agent loop: stops without a result if the model never submits", async () => {
  const fetchImpl = fakeMistral(Array(20).fill({ calls: [["get_curve_overview", {}]] }), []);
  const out = await Agent.run({ ctx: context(), apiKey: "k", fetchImpl, maxTurns: 5 });
  assert.equal(out.final, null);
  assert.equal(out.turns, 5);
});

test("the built-in skill is the maintained skill file", () => {
  const sync = require("../tools/sync-skill.js");
  const shipped = fs.readFileSync(sync.target, "utf8");
  assert.equal(shipped, sync.build(fs.readFileSync(sync.source, "utf8")), "run: node web-alpha/tools/sync-skill.js");
  assert.match(require("../js/agent-skill.js").text, /Vp check in volts/);
});
