/* =============================================================================
   Checks for the automatic fit-region proposals and quality flags (beta).

   Run from the repository root (Node 18 or newer, nothing to install):
       node --test web-beta/tests/auto.test.js
   ============================================================================= */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../js/numerics.js");
const A = require("../js/auto.js");

const e = N.E_CHARGE, me = N.M_E;
const AREA = Math.PI * 0.15e-3 * 10e-3;
const AR = 39.948;
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

/** Cylindrical OML probe curve with Maxwellian electrons and a slightly rising saturation. */
function curve({ Te = 3, Vp = 10, n = 1e16, sigma = 2e-6, seed = 1, vmin = -60, vmax = 20, npts = 800 } = {}) {
  let s = seed;
  const g = () => { let t = 0; for (let k = 0; k < 12; k++) { s = (s * 1664525 + 1013904223) % 4294967296; t += s / 4294967296; } return t - 6; };
  const mi = AR * N.AMU, Ie0 = AREA * n * e * Math.sqrt((e * Te) / (2 * Math.PI * me));
  const V = N.linspace(vmin, vmax, npts);
  const I = V.map((v) => -AREA * n * e * (Math.SQRT2 / Math.PI) * Math.sqrt(Math.max((e * (Vp - v)) / mi, 0))
    + (v < Vp ? Ie0 * Math.exp((v - Vp) / Te) : Ie0 * (1 + 0.004 * (v - Vp))) + sigma * g());
  return { V, I };
}

const derived = (r) => {
  const t = N.teFromPotentials(r.Vp, r.Vf, AR);
  return { ni_m3: N.ionDensityOML(r.ion_i2_a, AREA, AR), Te_VpVf_OML_eV: t.Te_OML_eV, Te_VpVf_planar_eV: t.Te_planar_eV };
};

test("proposals recover Te on clean curves and raise no flags", () => {
  for (const [Te, vmin] of [[1.5, -60], [3, -60], [6, -80]]) {
    const c = curve({ Te, vmin });
    const { params, results } = A.proposeOML(c.V, c.I, AREA);
    assert.ok(rel(results.Te_eV, Te) < 0.03, `Te ${results.Te_eV} for ${Te}`);
    assert.equal(params.reached, 5);
    assert.ok(params.log.tmin >= results.Vf - 1e-9 && params.log.tmax <= params.vp1, "transition between Vf and Vp");
    assert.deepEqual(A.qualityFlags(results, derived(results)), [], `flags for Te = ${Te}`);
  }
});

test("runOMLSteps reproduces a proposal from its saved params", () => {
  const c = curve({ Te: 3 });
  const { params, results } = A.proposeOML(c.V, c.I, AREA);
  const again = A.runOMLSteps(c.V, c.I, AREA, JSON.parse(JSON.stringify(params)));
  for (const k of ["Te_eV", "Vp", "Vf", "ne_m3", "Iis_A", "Ies_A"]) assert.ok(rel(again[k], results[k]) < 1e-12, k);
});

test("problem curves are flagged", () => {
  const c1 = curve({ Te: 3, Vp: 19.5 });
  const vpAtEnd = A.proposeOML(c1.V, c1.I, AREA).results;
  assert.ok(A.qualityFlags(vpAtEnd, derived(vpAtEnd)).some((f) => /end of the sweep|saturation/.test(f)));

  const c2 = curve({ Te: 3, sigma: 4e-4 });
  const noisy = A.proposeOML(c2.V, c2.I, AREA).results;
  assert.ok(A.qualityFlags(noisy, derived(noisy)).length > 0, "very noisy curve");
});

test("a not-analysable review gives no flags and NaN results", () => {
  const c = curve();
  const { params } = A.proposeOML(c.V, c.I, AREA);
  const r = A.runOMLSteps(c.V, c.I, AREA, { ...params, analysable: false });
  assert.ok(Number.isNaN(r.Te_eV));
  assert.deepEqual(A.qualityFlags(r, {}), []);
});
