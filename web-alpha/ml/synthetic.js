/* =============================================================================
   Synthetic training samples with a simulated reviewer (for testing the ML
   pipeline before real reviewed curves exist).

   Curves: cylindrical OML ions + Maxwellian electrons with known Te, Vp, n,
   random noise, sweep range and voltage step. The "reviewer" moves the rule
   proposal the way a careful person would:
     Vp line at the knee (true Vp), transition [Vf + Te/2, Vp − Te],
     saturation [Vp + 1.5 Te, Vp + 6 Te], ion fit up to Vf − 4 Te.
   A model trained on these samples should learn those habits.

       node web-beta/ml/synthetic.js 200 > synthetic.ivtrain     (demo file)
   ============================================================================= */
"use strict";
const path = require("node:path");
const N = require(path.join(__dirname, "../js/numerics.js"));
const A = require(path.join(__dirname, "../js/auto.js"));

const e = N.E_CHARGE, me = N.M_E;
const D_MM = 0.15, L_MM = 10;
const AREA = Math.PI * D_MM * 1e-3 * L_MM * 1e-3;
const AR = 39.948;
const GASES = [["Ar⁺", 39.948], ["He⁺", 4.0026], ["Kr⁺", 83.798]];

function rng(seed) {
  let s = seed >>> 0;
  const u = () => { s = (s * 1664525 + 1013904223) % 4294967296; return s / 4294967296; };
  const g = () => { let t = 0; for (let k = 0; k < 12; k++) t += u(); return t - 6; };
  return { u, g, pick: (a, b) => a + (b - a) * u() };
}

function curve(r, mass = AR) {
  const Te = r.pick(1, 8), Vp = r.pick(5, 25), n = 10 ** r.pick(15.3, 16.7);
  const vmin = Vp - r.pick(45, 80), vmax = Vp + r.pick(8, 20), npts = Math.round(r.pick(300, 1500));
  const mi = mass * N.AMU, Ie0 = AREA * n * e * Math.sqrt((e * Te) / (2 * Math.PI * me));
  const sigma = Ie0 * 10 ** r.pick(-4, -2.3);
  const V = N.linspace(vmin, vmax, npts);
  const I = V.map((v) => -AREA * n * e * (Math.SQRT2 / Math.PI) * Math.sqrt(Math.max((e * (Vp - v)) / mi, 0))
    + (v < Vp ? Ie0 * Math.exp((v - Vp) / Te) : Ie0 * (1 + 0.004 * (v - Vp))) + sigma * r.g());
  return { V, I, truth: { Te, Vp, n } };
}

/** One reviewed sample in the .ivtrain format, or null if the rules cannot handle the curve. mixed: Ar⁺/He⁺/Kr⁺ in turn. */
function sample(index, seed = 1000, { mixed = false } = {}) {
  const r = rng(seed + index * 7919);
  const [species, mass] = mixed ? GASES[index % GASES.length] : GASES[0];
  const c = curve(r, mass);
  let rule;
  try { rule = A.proposeOML(c.V, c.I, AREA); } catch (_) { return null; }
  const { Te, Vp } = c.truth;
  const Vf = rule.results.Vf, vMax = rule.results.diag.vMax;
  const p = JSON.parse(JSON.stringify(rule.params));
  p.vp1 = Vp;
  p.ion.vmax = Math.max(p.ion.vmin + 1, Vf - 4 * Te);
  p.log.tmin = Vf + 0.5 * Te;
  p.log.tmax = Vp - Te;
  p.log.smin = Math.min(Vp + 1.5 * Te, vMax - 1);
  p.log.smax = Math.min(Vp + 6 * Te, vMax);
  let human;
  try {
    const full = A.withIntersection(c.V, c.I, p);
    human = { params: full, results: A.runOMLSteps(c.V, c.I, AREA, full) };
  } catch (_) { return null; }
  const pick = (o) => ({ Te_eV: o.Te_eV, Vp: o.Vp, Vf: o.Vf, ne_m3: o.ne_m3, Vp_dIdV: o.Vp_dIdV, Vp_intersection: o.Vp_intersection });
  return {
    format: "ivcurve-training-sample", format_version: 1, id: `synthetic-${seed}-${index}`, added_at: new Date().toISOString(),
    app_version: "synthetic",
    source: { file: `synthetic_${index}.lda`, xkey: "VData", synthetic: true, truth: c.truth,
      probe: { diameter_mm: D_MM, length_mm: L_MM, area_m2: AREA }, ion: { species, mass_amu: mass } },
    curve: { V: Array.from(c.V), I: Array.from(c.I) },
    human: { params: human.params, results: pick(human.results) },
  };
}

function samples(count, seed, opts) {
  const out = [];
  for (let i = 0; out.length < count && i < count * 3; i++) { const s = sample(i, seed, opts); if (s) out.push(s); }
  return out;
}

module.exports = { samples, sample, AREA };

if (require.main === module) {
  const count = parseInt(process.argv[2] || "200", 10);
  process.stdout.write(JSON.stringify({ format: "ivcurve-training-set", format_version: 1, exported_at: new Date().toISOString(),
    app_version: "synthetic", samples: samples(count, 1000) }));
}
