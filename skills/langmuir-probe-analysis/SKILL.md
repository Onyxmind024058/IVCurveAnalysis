---
name: |
  langmuir-probe-analysis
description: |
  Load this skill when the user asks to analyse Langmuir probe I-V curves, traces, or characteristics (single or batch), e.g. Impedans-style XML or .lda experiment files (.lda files are XML content with a different extension; the pipeline detects this by content), or when they mention plasma potential, floating potential, electron temperature, EEDF, or plasma density from probe data. Runs a validated Python pipeline with Vf, Vp (dI/dV peak and fit intersection, with the Vp check in volts), ion-current model and OML ion density, single vs two-temperature Maxwellian fits, Te cross-check from Vp − Vf, Druyvesteyn EEDF, density cross-checks, an RF compensation check, quality flags, and fit/EEDF plots.
---

# Langmuir Probe I–V Analysis

Analyse Langmuir probe traces with the pipeline in `langmuir_pipeline.py` (this directory). The quality rules are the same as in the IV Analyser UB app, so a curve judged here is judged the same way there.

## When to load

- Files matching `*Langmuir*`, Impedans-style `<Experiment>` XML (VData/IData blocks — including `.lda` exports, which are XML content with a different extension; the pipeline detects this by content), CSV/TSV with V,I columns, or user requests to "analyse probe data / I–V curves / get Te, ne, Vp, EEDF".
- The pipeline is stored here as `langmuir_pipeline.py.txt` (the registry only allows text files). Copy it to a run directory as Python first:
  1. Load the `data-analysis` skill for its Python environment.
  2. `mkdir -p /home/user/tool-results/data-analysis/langmuir-<run>/ && cp /home/user/skills/langmuir-probe-analysis/langmuir_pipeline.py.txt /home/user/tool-results/data-analysis/langmuir-<run>/langmuir_pipeline.py`
  3. Run with the data-analysis activation, always passing both output flags:
     `. /home/user/skills/data-analysis/python/library/activate.sh && python .../langmuir_pipeline.py <input> [more inputs...] --plots <run>/plots --npz <run>/npz [--mass <amu>] [--area <mm2>]`
     - `--mass`: ion mass in amu. Default: `MolecularWeight` from the XML, else 39.95 (Ar). Always pass it for CSV input or when the gas is not the one in the file (He 4.0, Ne 20.18, Ar 39.95, Kr 83.80, Xe 131.29, H₂⁺ 2.016, N₂⁺ 28.01, O₂⁺ 32.0).
     - `--area`: collecting area in mm². Overrides the file; required for CSV (otherwise 4.73 mm² is assumed and must be confirmed with the user).
- The script prints one JSON result block per trace to stdout (parse with the caller's code, not by eye).

## Outputs

- **stdout JSON**: all fit parameters and diagnostics per trace, among them
  - potentials: `Vf_V`, `Vp_V` (= `Vp_dIdV_V`), `Vp_intersection_V`, `Vp_difference_V`, `Vp_check` (`good` / `ok` / `review` / `not_checked`), `Vp_check_reason`;
  - temperatures: `Te_single_eV`, `two_T` {Tc_eV, Th_eV, nh_over_ne, ne_m3, chi2_dof}, `Te_VpVf_OML_eV`, `Te_VpVf_planar_eV`, `Te_check_ok`, `dVf_consistent`;
  - densities: `ne_m3`, `ne_edf_m3`, `ni_OML_m3`, `ni_over_ne`;
  - currents: `I_ion_at_Vf_A` (Iis), `I_is_at_Vmin_A`;
  - fit quality: `r2_transition`, `r2_ion`, `n_saturation_points`, `quality_flags` (list of reasons), `status` (`good` if no flag, else `check`);
  - RF compensation: `rf_knee_rounding_over_Te`, `rf_compensation` (`good` / `doubtful` / `poor` / `not_checked`), `VpVf_over_expected_OML`;
  - EEDF: `EEDF_reliable_to_eV`, `Te_eff_EEDF_eV`; and `lambda_D_um`.
- **`--plots DIR`**: one 3-panel PNG per trace: (1) I–V with ion model, Vf, Vp; (2) semilog Ie with 1-T and 2-T fit curves (χ² in legend — this is where the bi-Maxwellian slope break shows); (3) EEDF with 1-T/2-T Maxwellian overlays, noise floor, and reliable-energy limit. Files are named `<basename>_z<zpos>.png` (XML) or `<basename>.png` (CSV); the path is also returned in the JSON as `plot`.
- **`--npz DIR`**: per-trace arrays (V, I, Ii_model, Ie, sel_V, sel_Ie, fit curves, eedf_E, eedf_f, Maxwellian overlays, noise floor) for building inline charts.

## Pipeline (what the script does, and why)

1. **Parse**: XML (all `DataItem` blocks = Z-scan series) or CSV/TSV (V,I columns, µA/mA units auto-detected).
2. **Floating potential Vf**: linear interpolation of the I = 0 crossing.
3. **Noise level sigma**: residual std of a quadratic fit over the ion branch (sets fit weights and the EEDF noise floor).
4. **Plasma potential Vp (dI/dV)**: Savitzky-Golay dI/dV peak (~1 V window), parabolic refinement.
5. **Ion current model**: fit `I_ion = -c0*sqrt(v0-V)` (OML/thick-sheath cylindrical behaviour) over the ion-dominated region; subtract from I. Fall back to linear if the sqrt fit fails. The choice of ion model is the dominant systematic on the cold Te.
   - **Ion density (OML, cylindrical probe)**: from the same fit, I² = c0²(v0 − V), so `ni = π/(A·e) · c0 · sqrt(mi/(2e))` with the ion mass from `--mass`/XML. Reported as `ni_OML_m3` with `ni_over_ne`.
   - **Iis** is the ion current of the model **at Vf** (`I_ion_at_Vf_A`), not the current at the most negative bias.
6. **Electron temperature fits** on the retarded region (Ie from ~1.5 sigma to knee):
   - single Maxwellian, and
   - two-temperature Maxwellian `a_c*exp(-eps/Tc) + a_h*exp(-eps/Th)`,
   compared via reduced chi². A large single-temperature chi² or a measured Vp−Vf much smaller than `VpVf_factor_planar`·Te(single) (≈ 5.2 for Ar) means the EEDF is bi-Maxwellian — report both populations.
7. **Second Vp (fit intersection)**: straight lines on ln(Ie) over the transition (Vf + 0.5·Te … Vp − Te) and over the electron saturation (Vp + 1.5·Te … Vp + 6·Te); their intersection is `Vp_intersection_V`. Needs at least 5 saturation points and a knee (saturation flatter than the transition).
8. **Te cross-check from Vp − Vf** (gas dependent, uses the ion mass):
   - OML cylindrical probe (thick sheath): `Te = (Vp − Vf)/factor_OML` (≈ 4.7 for Ar);
   - planar sheath with Bohm flux (thin sheath): `Te = (Vp − Vf)/factor_planar` (≈ 5.2 for Ar).
   The fitted Te is **confirmed** (`Te_check_ok = true`) when it lies within [0.7 × the smaller, 1.3 × the larger] of the two; otherwise flag "Te differs by more than 30 % from Te from Vp − Vf".
9. **Vp check in volts** — the two Vp values (dI/dV peak, fit intersection) must agree:
   - **|ΔVp| ≤ 2 V → `good`**;
   - **2 V < |ΔVp| ≤ 5 V → `ok` only if the Te cross-check (step 8) confirms the fitted Te**, otherwise `review`;
   - **|ΔVp| > 5 V → `review`: the curve must be reviewed by eye** (regions placed by hand) before any result is used;
   - no fit-intersection Vp (no usable saturation region) → `not_checked`; say so and treat Vp as uncertain.
10. **Consistency check**: the 2-T model must predict the measured Vp−Vf within ~20%, else flag the result.
11. **Density**: ne from thermal electron flux at Vp (geometry-independent at V = Vp). Cross-check with the Druyvesteyn EEDF integral and with the OML ion density (ni/ne should be within 0.2–5, ideally near 1).
12. **EEDF**: `f(eps) = (4/A)*sqrt(me/2)/e^1.5 * sqrt(eps) * d²I/dV²`, eps in eV. The script self-tests this constant against a synthetic Maxwellian every run (recovered ne must be within 10% of injected, else abort with an error). Only energies with S/N above ~2 are trustworthy; eps < 0.6 eV is distorted by knee smoothing — exclude from plots/claims.
13. **Quality flags** (`quality_flags`, `status = check` if any), same limits as the app:
    - transition not straight on ln(Ie): R² < 0.995;
    - ion fit poor: R² < 0.9;
    - fewer than 5 electron-saturation points above Vp, or no knee (saturation as steep as the transition);
    - Vp at the end of the sweep (within the last 3 % of the voltage range);
    - Te outside 0.2–30 eV;
    - Vp check = `review` (step 9);
    - Te differs by more than 30 % from Te from Vp − Vf (step 8);
    - ni/ne outside 0.2–5;
    - RF compensation poor (step 14).
14. **RF compensation check** — always do it, and **always say in the report when RF compensation looks insufficient**. RF oscillation of the plasma potential (an RF ripple on the sheath voltage that the probe's compensation — RF chokes tuned to the driving frequency and its harmonics, compensation electrode — does not cancel) time-averages the I–V curve. The exponential part keeps its slope, but the knee at Vp is rounded, Vp and Vf shift, and fits that reach into the knee overestimate Te.
    - **Main indicator, knee rounding** (`rf_knee_rounding_over_Te`): above the dI/dV peak, a well-compensated curve drops quickly to the saturation slope. The pipeline measures the distance from the peak to where dI/dV has fallen halfway to the saturation level, minus half the smoothing window, in units of Te. Sharp knee ≈ 0.1–0.3; **< 0.4 good, 0.4–0.7 doubtful, > 0.7 poor** (poor corresponds to an RF ripple of about Te or more; it is a quality flag).
    - **Supporting signs** (each alone is not proof): a large ΔVp between the dI/dV peak and the fit intersection while the transition is straight; Vp − Vf inconsistent with the fitted Te (`VpVf_over_expected_OML` far from 1, Te check mismatch); no cold population below ~1 eV resolved where one is expected; Te rising when the transition window is moved closer to the knee.
    - **What to report** when `rf_compensation` is `doubtful` or `poor`, or when two or more supporting signs appear: start the trace's status with "RF compensation looks insufficient" (doubtful: "may be insufficient"), name the indicator values, and state the consequences — Vp and Vf are shifted (Vf usually too negative), ne (taken at Vp) and the Vp-based checks are uncertain, Te is reliable only from the straight exponential part well below the knee and is otherwise overestimated, and the EEDF is broadened. Recommend checking the RF compensation (filter resonance at the driving frequency and harmonics, compensation electrode, cabling) and re-measuring. For a batch, list the affected files and leave them out of trend statements.
15. **Diagnostics/caveats to report**:
    - ion saturation scaling: if I scales with sqrt(Vp−V), the sheath is thick/OML — do NOT quote ni from a Bohm/probe-area formula (it can be 10–30x too high); quote ne and the OML ni (`ni_OML_m3`) instead.
    - knee sharpness vs Tc: if a cold population (below 1 eV) is resolved, RF compensation is adequate; a smeared knee means RF ripple (step 14).
    - EEDF tail above the noise floor: with µA-level noise, tails beyond ~5 eV are usually not constrained by a single sweep.

## Reporting

- Report: the RF compensation verdict (step 14), Vf, Vp (both values, ΔVp and the Vp check level with its reason), Tc/Th with fractions (or single Te if 1-T wins), Te from Vp − Vf (OML and planar) and whether it confirms the fit, ne with ~30% systematic uncertainty, ni (OML) and ni/ne, lambda_D, Iis at Vf, plus the caveats above.
- **Status first**: start each trace with `good` or `check`, listing every quality flag, and the RF compensation verdict when it is not `good` (step 14). A trace with `Vp_check = review` (ΔVp > 5 V, or 2–5 V without Te confirmation) must be presented as **"needs review by eye"**: give the numbers only as provisional and never as final results; suggest which region to adjust (usually the saturation window or the transition window).
- Cross-checks to state: predicted vs measured Vp−Vf, ne(fit) vs ne(EEDF), ni(OML) vs ne.
- Always produce the plots (`--plots`) and reference them; for inline visuals in chat, load `rich-ui` and render from the `--npz` arrays: I–V curve, semilog Ie with fits (shows the two-slope structure), EEDF with Maxwellian overlay — the same three panels as the PNG. Subsample long series for charts and keep the full data in files.
- For a batch, run the script over all files, then build one comparison table (per-file: status, Vf, Vp, ΔVp, Vp check, Tc, Th, ne, ni/ne) — trends across power/pressure/position are usually what the user wants. Mark traces that need review in the table and leave them out of trend statements until reviewed.

## Assumptions/limits

- Geometry, gas and collecting area come from the XML `Parameters` block; for CSV, ask the user (A_p strongly scales ne and ni) and pass `--area` and `--mass`.
- Cylindrical probe in the OML regime for the ion model, the ion density and the OML Vp − Vf factor; collisionless sheath assumed; densities are ±30% systematic (ion-subtraction model + area).
- The Vp − Vf factors depend on the ion mass (≈ 4.7 OML / 5.2 planar for Ar); they are computed from `--mass` or the XML `MolecularWeight`, never assumed to be argon when the gas is known.
