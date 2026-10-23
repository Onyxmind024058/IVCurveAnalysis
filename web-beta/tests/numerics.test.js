/* =============================================================================
   Physics checks for web/js/numerics.js on synthetic curves with known answers.

   Run from the repository root (Node 18 or newer, nothing to install):
       node --test web/tests/
   ============================================================================= */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const N = require("../js/numerics.js");

const e = N.E_CHARGE, me = N.M_E;
const AREA = Math.PI * 0.15e-3 * 10e-3;  // 0.15 mm x 10 mm cylinder
const AR = 39.948;

/** Relative difference |a - b| / |b|. */
const rel = (a, b) => Math.abs(a - b) / Math.abs(b);

/** Deterministic Gaussian noise. */
function noise(seed) {
  return () => {
    let s = 0;
    for (let k = 0; k < 12; k++) { seed = (seed * 1664525 + 1013904223) % 4294967296; s += seed / 4294967296; }
    return s - 6;
  };
}

/**
 * Cylindrical probe in OML theory: ion current I_i = -A n e (sqrt2/pi) sqrt(e(Vp-V)/m_i),
 * Maxwellian electron current below Vp, saturated above.
 */
function omlCurve({ Te = 3, Vp = 10, n = 1e16, massAmu = AR, vmin = -60, vmax = 20, npts = 1200, sigma = 0, seed = 1 } = {}) {
  const mi = massAmu * N.AMU;
  const Ie0 = AREA * n * e * Math.sqrt((e * Te) / (2 * Math.PI * me));
  const g = noise(seed);
  const V = N.linspace(vmin, vmax, npts);
  const Ii = (v) => -AREA * n * e * (Math.SQRT2 / Math.PI) * Math.sqrt(Math.max((e * (Vp - v)) / mi, 0));
  const Ie = (v) => (v < Vp ? Ie0 * Math.exp((v - Vp) / Te) : Ie0);
  const I = V.map((v) => Ii(v) + Ie(v) + sigma * g());
  return { V, I, Ii, Ie, Ie0 };
}

/** Floating potential of omlCurve by bisection (current crosses zero). */
function floatingPotential(c, lo, hi) {
  const f = (v) => c.Ii(v) + c.Ie(v);
  for (let k = 0; k < 200; k++) { const m = (lo + hi) / 2; if (f(m) < 0) lo = m; else hi = m; }
  return lo;
}

test("automatic OML recovers Te on a noisy curve", () => {
  const c = omlCurve({ Te: 3, sigma: 2e-6 });
  const r = N.analyseOML(c.V, c.I, AREA, 0.2, 21);
  assert.ok(rel(r.Te_eV, 3) < 0.05, `Te = ${r.Te_eV}`);
});

test("ion density from the slope of the I² fit (OML)", () => {
  const c = omlCurve({ n: 2e16 });
  const r = N.analyseOML(c.V, c.I, AREA, 0.2, 5);
  assert.ok(rel(N.ionDensityOML(r.ion_i2_a, AREA, AR), 2e16) < 1e-3);
  assert.ok(Number.isNaN(N.ionDensityOML(+1e-10, AREA, AR)), "a positive slope is not physical");
});

test("Te from Vp - Vf: textbook factors and exact recovery for OML ions", () => {
  const t = N.teFromPotentials(10, 0, AR);
  assert.ok(Math.abs(t.factorOML - 4.703) < 1e-3, `OML factor ${t.factorOML}`);
  assert.ok(Math.abs(t.factorPlanar - 5.179) < 1e-3, `planar factor ${t.factorPlanar}`);
  for (const Te of [1.5, 3, 6]) {
    const c = omlCurve({ Te });
    const vf = floatingPotential(c, -60, 10);
    assert.ok(rel(N.teFromPotentials(10, vf, AR).Te_OML_eV, Te) < 1e-6, `Te = ${Te}`);
  }
  assert.ok(Number.isNaN(N.teFromPotentials(0, 5, AR).Te_OML_eV), "Vp below Vf gives NaN");
});

test("Te consistency check flags a mismatch beyond 30 %", () => {
  assert.equal(N.teConsistency(3.0, 2.8, 2.5).ok, true);
  assert.equal(N.teConsistency(5.0, 2.8, 2.5).ok, false);
  assert.equal(N.teConsistency(NaN, 2.8, 2.5).checked, false);
});

test("Iis is the ion current at Vf", () => {
  const c = omlCurve({ sigma: 0 });
  const r = N.analyseOML(c.V, c.I, AREA, 0.2, 5);
  assert.ok(rel(r.Iis_A, c.Ii(r.Vf)) < 0.02, `Iis ${r.Iis_A} vs ${c.Ii(r.Vf)}`);
});

test("EEDF integrates to the electron density and the EEPF slope gives Te", () => {
  const Te = 3, Vp = 10, n = 1e16;
  const c = omlCurve({ Te, Vp, n, vmin: -40, npts: 3000 });
  const V = c.V, Ie = V.map(c.Ie);
  const d = N.computeEEPF(V, Ie, AREA, { Vp, Ie, x: V }, 3, 0, 3);
  assert.ok(rel(d.n_EEDF_m3, n) < 0.03, `n = ${d.n_EEDF_m3}`);
  const xs = [], ys = [];
  d.E_eV.forEach((E, k) => { if (E > 2 && E < 15 && d.EEPF_smooth[k] > 0) { xs.push(E); ys.push(Math.log(d.EEPF_smooth[k])); } });
  assert.ok(rel(-1 / N.polyfit(xs, ys, 1)[0], Te) < 0.03);
});

test("averaging scans on a shared grid and splitting up/down sweeps", () => {
  const V = N.linspace(-40, 20, 300);
  const scans = [1, 2].map((id) => ({ id, VData: V, RefData: V, IData: V.map((v) => v * id) }));
  const a = N.averageScans(scans, "VData");
  assert.equal(a.x.length, 300);
  assert.ok(Math.abs(a.imean[150] - 1.5 * a.x[150]) < 1e-9);

  const tri = Float64Array.from([...N.linspace(-40, 20, 200), ...N.linspace(20, -40, 200)]);
  const split = N.splitSweeps([{ id: 1, VData: tri, RefData: tri, IData: tri }], "VData");
  assert.deepEqual(split.map((s) => s.label), ["scan 1 up", "scan 1 down"]);
  const jitter = noise(3);
  const noisy = Float64Array.from(V, (v) => v + 0.05 * jitter());
  assert.equal(N.splitSweeps([{ id: 2, VData: noisy, RefData: noisy, IData: noisy }], "VData").length, 1);
});

test("EPFL: rebinning keeps every point, model does not overflow", () => {
  const V = N.linspace(-40, 20, 1000);
  assert.equal(N.rebinCurve(V, V, 1000).V.length, 1000);
  const j = N.epflModel(810, 1e16, 0.5, 809, 797);
  assert.ok(Number.isFinite(j), "large absolute bias with small Te");
});
