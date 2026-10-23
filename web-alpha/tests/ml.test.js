/* =============================================================================
   Checks for the fit-region model (pre-alpha), on synthetic curves labelled by
   a simulated reviewer with known habits (ml/synthetic.js).
       node --test web-alpha/tests/ml.test.js
   ============================================================================= */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const ML = require("../js/ml.js");
const S = require("../ml/synthetic.js");

const trainSet = S.samples(100, 1000);
const freshSet = S.samples(40, 4242);
const model = ML.train(trainSet);

test("the model learns the reviewer's habits and beats the rules on fresh curves", () => {
  const { rows } = ML.prepare(freshSet);
  const score = ML.scoreRows(rows, (r) => ML.predictRidge(model.fit, r.x).map((d, t) => (model.fit.use[t] ? d : 0)));
  assert.equal(score.model_failed, 0);
  assert.ok(score.te_error_pct.model_median < 0.5 * score.te_error_pct.rules_median, JSON.stringify(score.te_error_pct));
  assert.ok(score.vp_error_V.model_median < 0.5 * score.vp_error_V.rules_median, JSON.stringify(score.vp_error_V));
  const vp = score.boundaries.find((b) => b.name === "vp_didv");
  assert.ok(vp.model_mae_V < 0.3 && vp.rules_mae_V > 0.8, JSON.stringify(vp));
});

test("only boundaries the model improves are corrected", () => {
  for (const b of model.validation.boundaries) {
    if (model.validation.corrected.includes(b.name)) assert.ok(b.model_mae_V < b.rules_mae_V, b.name);
    else assert.equal(b.model_mae_V, b.rules_mae_V, b.name);
  }
});

test("a model file is checked before use", () => {
  assert.equal(ML.checkModel(JSON.parse(JSON.stringify(model))).format, ML.MODEL_FORMAT);
  assert.throws(() => ML.checkModel({ format: "something else" }));
  assert.throws(() => ML.checkModel({ ...model, features: model.features.slice(1) }));
});

test("corrected regions stay ordered and inside the sweep", () => {
  const s = freshSet[0];
  const rule = require("../js/auto.js").proposeOML(Float64Array.from(s.curve.V), Float64Array.from(s.curve.I), S.AREA);
  const p = ML.correctedParams(rule, ML.TARGETS.map(() => 50));   // absurd corrections
  const d = rule.results.diag;
  assert.ok(p.log.tmin < p.log.tmax && p.log.tmax <= p.vp1 && p.vp1 <= p.log.smin && p.log.smin < p.log.smax);
  assert.ok(p.log.smax <= d.vMax && p.log.tmin >= d.vMin);
});

test("proposals from the model run the normal analysis", () => {
  const s = freshSet[1];
  const out = ML.proposeWithModel(model, Float64Array.from(s.curve.V), Float64Array.from(s.curve.I), S.AREA);
  assert.equal(out.source, "model");
  assert.ok(Math.abs(out.results.Te_eV / s.human.results.Te_eV - 1) < 0.05);
  assert.ok(Number.isFinite(out.params.log.vp2));
});

test("ml/train.js writes a loadable model and a report", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ivtrain-"));
  const file = path.join(dir, "set.ivtrain");
  fs.writeFileSync(file, JSON.stringify({ format: "ivcurve-training-set", format_version: 1, exported_at: "test", samples: trainSet.slice(0, 40) }));
  execFileSync(process.execPath, [path.join(__dirname, "../ml/train.js"), file, "--out", dir], { stdio: "pipe" });
  const shipped = require(path.join(dir, "regions-model.js"));
  assert.equal(shipped.trained_on, 40);
  assert.ok(fs.readFileSync(path.join(dir, "training-report.md"), "utf8").includes("| vp_didv |"));
  fs.rmSync(dir, { recursive: true });
});
