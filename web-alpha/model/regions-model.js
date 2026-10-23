/* Fit-region model for the IV Analyser (pre-alpha).
   No model is shipped yet: reviewed curves are being collected (goal: 200).
   When they are, run `node web-alpha/ml/train.js data/*.ivtrain` — it replaces
   this file with the trained model. */
(function (root) {
  "use strict";
  const model = null;
  if (root.IV) root.IV.REGION_MODEL = model;
  if (typeof module !== "undefined" && module.exports) module.exports = model;
})(typeof window !== "undefined" ? window : globalThis);
