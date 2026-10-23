# Langmuir Probe IV Analyser UB

### ▶ Open the app: **[onyxmind024058.github.io/IVCurveAnalysis/web/](https://onyxmind024058.github.io/IVCurveAnalysis/web/)**

🧪 Beta with the new **assisted batch review**: [onyxmind024058.github.io/IVCurveAnalysis/web-beta/](https://onyxmind024058.github.io/IVCurveAnalysis/web-beta/), see [Beta: assisted batch review](#beta-assisted-batch-review).

🔬 Pre-alpha for **collecting training data for machine learning**: [onyxmind024058.github.io/IVCurveAnalysis/web-alpha/](https://onyxmind024058.github.io/IVCurveAnalysis/web-alpha/), see [Pre-alpha: machine learning](#pre-alpha-machine-learning). Not for results.

A browser application for loading Langmuir probe measurements (`.lda` or CSV files), plotting individual and averaged I–V curves, and extracting plasma parameters using automatic OML-style analysis, manual OML analysis, EEDF/EEPF calculation, and an EPFL two-fluid model.

The program is designed for interactive analysis of Langmuir probe measurements, especially when automatic fitting is not sufficient and the user needs to manually select fit regions. It runs entirely in your browser: measurement files are read locally and **never uploaded**.

> The original Python/PySide6 desktop application is **no longer maintained**. It is kept for reference in [`archive/python-desktop/`](archive/python-desktop/). New features and fixes go into the browser version only.

## Getting started

- **Online:** open the link above in a recent browser (Chrome, Edge, Firefox or Safari). Nothing to install.
- **Without internet / from a copy:** download the repository and double-click `web/index.html`. All libraries are bundled, so this works offline too (but cannot be installed as an app, see below).
- Try it with **Example data** (synthetic curves with Te = 3 eV, Vp = 10 V) before opening your own files.

## Install as an app (PWA)

From the link above, the analyser can be installed like a normal program (a *Progressive Web App*). It then gets its own icon and window, **works without internet**, and updates itself.

| Browser / system | How to install |
|---|---|
| **Chrome or Edge** (Windows, macOS, Linux, ChromeOS) | Click **Install app** in the app's toolbar, or the install icon (a monitor with a down arrow) at the right end of the address bar, then **Install**. Edge also offers *⋯ → Apps → Install this site as an app*. |
| **Safari on macOS** (Sonoma 14 or newer) | Menu **File → Add to Dock…** (or the Share button → *Add to Dock*). |
| **Safari on iPhone / iPad** | Share button → **Add to Home Screen** → *Add*. |
| **Chrome on Android** | Menu **⋮ → Install app** (or *Add to Home screen*). |
| **Firefox** (desktop) | Firefox cannot install web apps. Use the page in a tab: it still works offline after the first visit. |

**After installing**

- Start it from the Start menu, Dock, Launchpad, home screen or desktop like any program.
- **Offline:** the first visit saves a copy of the app (about 1.7 MB) on your computer. Afterwards it opens without internet; the status bar then shows *Offline — using the saved copy*.
- **Updates:** whenever you open it with internet, the newest version is loaded automatically. The *What's new* window shows what changed.
- **Open files directly** (Chrome/Edge on desktop): right-click a `.lda`, `.csv` or `.ivsession` file → **Open with → IV Analyser**.
- **Uninstall:** Chrome/Edge: open the app → *⋮* (or *⋯*) menu → *Uninstall*. macOS: remove it from the Dock and from *Applications*. iPhone/iPad/Android: long-press the icon → *Remove*.

## What the app does

The app lives in the `web/` folder, in the spirit of ImageJ.js:

- **Data files:** opens `.lda` files and CSV/text files. In `.lda` files, `RefData` is optional; when it is empty, `VData` is used as x axis. The CSV importer detects the separator (comma, semicolon, tab or spaces) and decimal commas, skips header/metadata lines, and lets you pick the voltage column, the current column(s) (one scan each) and the current unit (A, mA, µA, nA), with a live preview. Files exported by this app can be opened again.
- **Data range:** in the *Data range* panel, the curve can be reduced before any analysis: skip the first/last N points of every sweep (e.g. start-up transients) and/or keep only a voltage window, set by typing or by dragging the lines on the main plot. All analyses and exports use the reduced curve.
- **Ion density:** nᵢ is calculated from the slope of the I² fit (OML theory for a cylindrical probe, nᵢ = (π/(A·e))·√(mᵢ·|a|/(2e))) for the ion species chosen in *Probe / OML settings*, and shown with nᵢ/nₑ.
- **Te from Vp − Vf:** a cross-check of Te from the potential difference, shown next to the fitted Te in every result: for a cylindrical probe in OML theory (e^(−x) = (2/√π)·√(x·mₑ/mᵢ) with x = (Vp − Vf)/Te; x ≈ 4.7 for Ar) and for a planar sheath with Bohm flux (x = ½ + ½·ln(mᵢ/(2π mₑ)); x ≈ 5.2 for Ar). The two bracket the usual thick/thin-sheath cases. If the fitted Te lies more than 30 % outside this range, the result shows a red warning.
  - *How to read it:* the method assumes Maxwellian electrons and a clean floating potential. With RF plasmas and a probe **without RF compensation**, Vf is pulled negative, so Te from Vp − Vf comes out **too high**. A mismatch is a reason to look again at Vp, Vf, the fit regions and the sheath regime.
- **Vp check (validation):** in the manual analysis, Vp from the dI/dV peak is compared with Vp from the intersection of the ln(Ie) fits: **≤ 2 V** is ✓ good; **2–5 V** is ok only if Te from Vp − Vf confirms the fitted Te (otherwise review); **> 5 V** means the curve should be reviewed by eye (red warning). Exported as `Vp_difference_V` / `Vp_check` (`good`, `ok`, `review`).
- **Saved analyses:** *Save / Export → Save analysis* (Ctrl+S) writes one `.ivsession` file with the data, settings, data range, fit regions of every window and the results. Opening it (like a data file) restores everything; the Manual OML window reopens on the step where you stopped.
- **Theme:** University of Basel light/dark theme (switch in the top-right corner).
- **What's new:** the *What's new* button lists the changes of each version; it opens by itself once after an update.
- **Analysis core:** `web/js/numerics.js`, ported from the Python app (`archive/python-desktop/main.py`), with these corrections (v2.0.0):
  - EEDF and EEPF were swapped. The Druyvesteyn expression `2·sqrt(2·mₑ)/(e³·A) · d²Iₑ/dV²` is the EEPF; EEDF = EEPF·sqrt(ε). Both are shown per eV (m⁻³ eV⁻¹, m⁻³ eV⁻³ᐟ²), and the EEPF window shows the density ∫EEDF dε next to the OML ne as a check.
  - Iis is the ion current from the I² fit evaluated at **Vf** (it was evaluated at 0 V).
  - EPFL two-fluid: the model is written relative to Vp so the exponentials cannot overflow.
  - Scans are averaged on an evenly spaced grid over their common voltage range; up/down (triangular) sweeps are split into separate branches.
  - Other fixes: EEDF is smoothed before clipping negatives, rebinning keeps the last point, smoothing windows are always odd, and corrupt `.lda` files give a clear error.

## Beta: assisted batch review

The beta (`web-beta/`, link at the top) adds **batch review** for a series of measurements (radial profile, pressure or power scan…). It is the stable app plus this feature; it can be installed next to the stable app and has its own offline copy. Feedback is welcome before it moves to the stable version.

1. Set the probe, ion species, x axis and data range in the main window as usual; the batch uses the same settings.
2. Click **Batch review β** → **Add files…** and select all `.lda`/`.csv` files of the series (or drop them on the window). For CSV files the column choice of the first file is reused for the others.
3. Enter the **parameter** of each file (a number in the file name is filled in automatically) and its name, e.g. *Position (mm)*.
4. For every curve the app **proposes fit regions** (the straightest part of ln(Ie) between Vf and Vp for Te, a saturation window above Vp, an ion region a few Te below Vf) and gives a status:
   - **✓ good**: the proposal passed every check;
   - **⚠ check**: something looks wrong; the reasons are listed (transition not straight, poor ion fit, no saturation region, Vp at the end of the sweep, the two Vp values differ by more than 5 V, or by 2–5 V without confirmation from Te from Vp − Vf, Te far from Te from Vp − Vf, nᵢ/nₑ far from 1, Te outside 0.2–30 eV);
   - **✗ failed**: no proposal possible; set the regions by hand.
5. **Review next ▶** opens each curve in the manual OML window, on the *Results* tab with an overview of ln(Ie) and both fits. Check it, adjust any step if needed, and press **Accept & next**. *Start review from* chooses whether a curve opens with its own proposal or with the regions of the previous accepted curve. *Skip for now* moves on without a decision; unticking *Analysable* marks the curve as skipped.
6. **Accept all good…** accepts the remaining ✓ curves without opening them. They are marked *✓ unreviewed* in the table and `reviewed_by_human = no` in the export, so this always stays visible.
7. The **summary plot** shows Te, nₑ, nᵢ, Vp, Vf… against the parameter (filled points: reviewed; open points: not yet). **Export table CSV** writes one row per file. **Save batch** writes one `.ivbatch` file (data, regions, results, statuses); **Open batch…** continues later. **↗** opens a file in the main window (for EEPF, EPFL…).

The proposals never replace the review: they only save the clicks. The quality limits are in `web-beta/js/auto.js` (`LIMITS`).

## Pre-alpha: machine learning

`web-alpha/` is the beta plus the groundwork for a **fit-region model**: a model that learns where people put the fit regions (Vf, ion range, dI/dV Vp line, transition and saturation windows) and proposes them for new curves. It is **trained once** on about **200 reviewed curves** and then **shipped with the app**, ready to use; users do not train anything. The physics (Te, ne, Vp…) is still computed by the normal analysis, and every curve is still reviewed.

**1. Collect (everyone, in the pre-alpha)**
- Every curve you **review and accept** in the batch review or the manual OML window is added to a local training set (curve + your regions + your results + probe/ion/data range). Curves accepted with *Accept all good* (no human look) are **not** added.
- **Training α** shows the progress towards 200, lists the curves, and **exports** them as one `.ivtrain` file (≈ 40 kB per curve). Send that file to the maintainer. Collection can be switched off in that window.
- The data stays in the browser on that computer until exported; nothing is uploaded.

**2. Train (once, maintainer)**
```bash
node web-alpha/ml/train.js data/*.ivtrain                   # writes web-alpha/model/regions-model.js + training-report.md
node web-alpha/ml/train.js data/*.ivtrain --out /tmp/try    # inspect first without replacing the shipped model
```
- Model: one ridge regression per boundary that learns the **corrections people make to the rule-based proposal**, in units of Te. It is small (a few kB) and explainable.
- The script validates by **cross-validation** (held-out curves) and corrects only the boundaries where the model beats the rules. `training-report.md` compares rules and model: distance of each boundary to the reviewers' choice, and the resulting Te and Vp errors. **Ship the model only if it is clearly better than the rules.**
- To try a model in the app before shipping: *Training α → Load model file for testing…* (until the page is reloaded).

**3. Use (after shipping)**
- In the batch review, *Proposals from: model*. If the model's proposal for a curve gets more quality warnings than the rules' proposal, the rules' one is used (and shown as such). The quality checks and the review are unchanged.

**Pipeline check with synthetic data:** `node web-alpha/ml/synthetic.js 200 > synthetic.ivtrain` makes curves labelled by a simulated reviewer with known habits. Trained on them, the model reduces the error of the dI/dV Vp line from ≈ 1.3 V to ≈ 0.05 V and the Te error against the reviewer from ≈ 0.6 % to ≈ 0.05 % on curves it never saw. Real curves will be harder; the report will tell.

## Checking the physics (automatic tests)

`web/tests/numerics.test.js` checks the analysis code on synthetic curves with known answers (Te, nₑ, nᵢ, Iis at Vf, EEDF density, Te from Vp − Vf, averaging, EPFL). With [Node.js](https://nodejs.org) 18 or newer, from the repository folder:

```bash
node --test web/tests/numerics.test.js
node --test web/tests/release.test.js
node --test web-beta/tests/numerics.test.js web-beta/tests/auto.test.js web-beta/tests/release.test.js   # beta
node --test web-alpha/tests/*.test.js                                                                        # pre-alpha, incl. the model
```

All tests should report `ok`. Run them after every change to the analysis code.

### Releasing a new version

1. In `web/js/app.js` (or `web-beta/js/app.js`): raise `APP_VERSION` and add a `CHANGELOG` entry at the top (shown in *What's new*).
2. In the same folder's `index.html`: replace the old `?v=…` after every script and stylesheet with the new version. The new file addresses make every browser load the complete new version on the next reload, instead of mixing a new page with old cached scripts.
3. Run `node --test web/tests/release.test.js` (and the other tests); it fails if a `?v=` or the What's new entry does not match `APP_VERSION`.

---

## 1. Main Features

### Data import

- Loads `.lda` files containing several voltage/current scans.
- Reads:
  - `VData`
  - `RefData`
  - `IData`
- Sorts scans by their scan ID.
- Allows the user to choose whether the x-axis is `VData` or `RefData`.

### I–V plotting

The main window can display:

- all individual scans
- the averaged I–V curve
- the standard deviation around the averaged curve

The averaged curve is used for the analysis routines.

### Automatic OML analysis

The automatic OML analysis estimates:

- floating potential, `Vf`
- plasma potential, `Vp`
- electron temperature, `Te`
- electron saturation current, `Ies`
- electron density, `ne`
- ion-current fit parameters

The ion current is fitted using a cylindrical OML-style relation based on the square of the ion current:

```text
Ii²(V) = aV + b
```

The ion current is then reconstructed as:

```text
Ii(V) = sign(Ii) sqrt(aV + b)
```

This allows the electron current to be estimated as:

```text
Ie = Imeasured - Ii
```

### Manual OML analysis

The manual OML analysis opens a separate dialog with several tabs.

The user can manually control:

1. smoothing of the raw I–V curve
2. floating potential selection
3. ion-current fit region
4. derivative smoothing
5. plasma potential from `dIe/dV`
6. transition-region fit
7. electron-saturation-region fit
8. final calculation of `Te`, `Vp`, `Ies`, and `ne`

Several vertical selection lines are draggable directly on the plots.

### EEDF / EEPF calculation

The program can calculate the electron energy distribution function and electron energy probability function from the OML result.

The calculation is based on a Druyvesteyn-style second derivative of the electron current:

```text
EEDF ∝ d²Ie / dV²
```

The energy axis is defined as:

```text
E = Vp - Vprobe
```

The EEPF is calculated from the EEDF using:

```text
EEPF = EEDF / sqrt(E)
```

The popup displays:

- electron current used for the derivative
- EEDF
- EEPF
- second derivative of the electron current

The EEDF and EEPF can be smoothed, and their y-axis can be changed to logarithmic scale.

### EPFL two-fluid model

The EPFL two-fluid model opens a separate dialog and performs an alternative electron current-density analysis.

It includes:

- rebinning of the I–V curve
- smoothing of the current
- derivative-based plasma potential estimate
- transition-region estimate
- logarithmic electron-temperature estimate
- optional nonlinear fitting using `scipy.optimize.curve_fit`

The nonlinear fit can use different modes:

- fit only `ne`
- fit `Vp` and `ne`
- fit `ne`, `Te`, `Vp`, and `Vf`

### Export tools

The program can export:

#### Mean I–V CSV

Contains:

- voltage axis
- mean current
- current standard deviation

#### Full analysis CSV

Contains:

- selected x-axis
- probe area
- scalar analysis results
- averaged I–V curve
- all individual scan currents
- EEDF and EEPF data, if calculated

The EEDF/EEPF export includes:

- energy in eV
- raw EEDF
- smoothed EEDF
- raw EEPF
- smoothed EEPF

### Plot copy tools

Most plots support right-click actions:

- copy plot image
- copy curve data as CSV

This is useful for quickly pasting plots or data into reports, notebooks, or spreadsheets.

---

## 2. Requirements

A recent browser: Chrome, Edge, Firefox or Safari. Nothing to install.

---

## 3. Running the Program

Open the GitHub Pages site, or open `web/index.html` from a downloaded copy of the repository. Files are read locally and never uploaded.

---

## 4. Typical Workflow

### Step 1 — Open an `.lda` file

Click:

```text
Open .lda file
```

The program reads all scans and displays the I–V curves.

---

### Step 2 — Choose the voltage axis

Select either:

```text
VData
```

or:

```text
RefData
```

This choice affects plotting and all analysis routines.

---

### Step 3 — Check the averaged curve

Use the plot options:

- `Show all scans`
- `Show mean ± std`

The averaged curve is the curve used for analysis.

---

### Step 4 — Enter probe geometry

In the probe settings, enter:

- probe diameter in mm
- probe length in mm

The program uses the cylindrical side area:

```text
A = pi d L
```

where `d` is the probe diameter and `L` is the probe length.

This area is used for density calculations.

---

### Step 5 — Run automatic OML analysis

Click:

```text
Analyse averaged I-V
```

This gives a first estimate of the plasma parameters.

Use this mode for quick inspection, but always verify the result manually when the curve is noisy, distorted, or RF affected.

---

### Step 6 — Run manual OML analysis

Click:

```text
Manual OML analysis
```

Use the tabs to adjust:

- smoothing
- ion-current fit region
- plasma-potential position
- transition-region fit
- saturation-region fit

At the end, click:

```text
Send results to main window and close
```

These manual results become the active OML results used by the EEDF/EEPF calculation.

---

### Step 7 — Calculate EEDF / EEPF

Click:

```text
Calculate EEPF / EEDF
```

This requires automatic or manual OML results first.

The EEDF/EEPF popup lets you change:

- second-derivative smoothing
- EEDF/EEPF smoothing
- minimum energy
- log y-axis display

---

### Step 8 — Export results

Use:

```text
Export mean CSV
```

or:

```text
Export all analysis CSV
```

The full export is recommended for post-processing because it includes both the I–V data and the analysis outputs.

---

## 5. Explanation of Important Parameters

### Ion fit fraction

The ion fit fraction is used only in the automatic OML analysis.

It defines the fraction of the low-voltage side of the curve used to fit the ion current.

For example:

```text
ion fit fraction = 0.2
```

means the program uses the first 20% of the voltage points for the ion-current fit.

This assumes that the beginning of the curve corresponds to the ion-saturation region, where electron current is negligible.

Typical values:

```text
0.10 to 0.20
```

A value that is too large may include the transition region and distort the electron current subtraction.

A value that is too small may make the fit unstable.

---

### Smoothing window

The smoothing window controls how many neighboring points are used for smoothing.

A larger value gives a smoother curve but may remove real physical features.

A smaller value preserves more detail but may leave numerical noise.

The program uses smoothing in several places:

- raw I–V smoothing
- derivative smoothing
- EEDF/EEPF smoothing
- EPFL two-fluid smoothing

Derivatives are much more sensitive to noise than the original curve, so derivative smoothing often needs to be stronger than visual I–V smoothing.

---

### Minimum energy for EEDF/EEPF

The EEDF/EEPF energy axis is:

```text
E = Vp - V
```

The minimum energy setting removes points below a selected energy.

This is useful because the very low-energy part can be unstable due to division by `sqrt(E)` in the EEPF.

---

### Log y-axis for EEDF/EEPF

The log-scale option changes the EEDF and EEPF plots to logarithmic scale.

This is useful for checking whether the distribution has a Maxwellian-like region.

Because logarithmic plots cannot display negative values, the EEDF/EEPF should be clipped to remove non-physical negative values before plotting.

---

## 6. Why Derivatives Can Look Noisy

The main I–V curve may look very smooth, but derivatives can still be noisy.

This is because numerical differentiation amplifies small point-to-point variations.

The first derivative approximately amplifies noise as:

```text
1 / ΔV
```

The second derivative approximately amplifies noise as:

```text
1 / ΔV²
```

The EEDF calculation uses the second derivative, so it is especially sensitive to small oscillations in the current or voltage spacing.

For this reason, it is normal for the derivative and EEDF/EEPF plots to require stronger smoothing than the original I–V curve.

---

## 7. Notes on EEDF and EEPF Positivity

Negative EEDF or EEPF values are non-physical.

They usually appear because the second derivative is noisy.

A practical treatment is to clip negative values to zero before plotting, smoothing, exporting, or applying log scale.

This does not create physical information, but it prevents numerical artifacts from being interpreted as negative particle populations.

---

## 8. Output Parameters

### Floating potential, `Vf`

The floating potential is the voltage where the probe current crosses zero.

### Plasma potential, `Vp`

The plasma potential can be estimated from:

- the maximum of `dIe/dV`
- the intersection of transition and saturation fits
- the average of both values in manual mode

### Electron temperature, `Te`

The electron temperature is extracted from the slope of the logarithmic electron-current fit:

```text
Te = 1 / slope
```

when voltage is in volts and temperature is expressed in electronvolts.

### Electron saturation current, `Ies`

The electron saturation current is the electron current evaluated near the plasma potential.

### Electron density, `ne`

The electron density is calculated from the electron saturation current, probe area, and electron temperature.

---

## 9. Recommended Good Practice

For reliable analysis:

1. Always inspect all scans before trusting the average.
2. Check whether the voltage axis should be `VData` or `RefData`.
3. Verify that the ion-current fit is made only in the ion-saturation region.
4. Prefer manual OML analysis for publication-quality results.
5. Use stronger smoothing for derivatives than for the I–V curve.
6. Check EEDF/EEPF both in linear scale and log scale.
7. Export the full CSV after each final analysis.
8. Keep track of the probe geometry used for each dataset.

---

## 10. Common Problems

### The automatic OML analysis fails

Possible reasons:

- not enough points in the electron-retarding region
- bad ion-current fit
- wrong voltage axis selected
- electron current becomes negative after ion subtraction
- plasma potential estimate is incorrect

Use manual OML mode.

---

### The EEDF/EEPF is very noisy

Possible reasons:

- second derivative amplifies noise
- smoothing window is too small
- voltage spacing is too small or irregular
- plasma potential is incorrect
- ion-current subtraction is poor

Increase smoothing and verify the manual OML result.

---

### The EEDF/EEPF contains negative values

This is usually a numerical artifact from the second derivative.

Clip negative EEDF/EEPF values to zero before plotting or exporting.

---

### The EPFL two-fluid model does not converge

Possible reasons:

- poor initial guesses
- wrong fit mode
- too many rebinned points
- noisy derivative
- insufficient positive current-density region
- missing `scipy`

Try fitting fewer parameters first, for example only `ne`, then gradually increase the fit complexity.

---

## 11. Suggested File Organization

A typical project folder can be:

```text
project/
│
├── data/
│   ├── measurement_01.lda
│   └── measurement_02.lda
│
├── exports/
│   ├── measurement_01_mean_iv.csv
│   └── measurement_01_full_analysis.csv
│
└── README.md
```

---

## 12. Building the Old Desktop Executable

The Python desktop app is archived and no longer maintained. Build instructions are in [`archive/python-desktop/README.md`](archive/python-desktop/README.md).

---

## 13. Limitations

This software provides practical Langmuir probe analysis tools, but the results still depend strongly on:

- probe geometry
- plasma conditions
- RF compensation
- sheath assumptions
- selected fit regions
- signal noise
- voltage calibration
- current offset correction

The automatic analysis should be treated as a first estimate.

Manual validation is recommended for final physical interpretation.

---

## 14. Summary

This program provides an interactive workflow for Langmuir probe analysis:

1. load `.lda` or CSV files
2. inspect individual and averaged I–V curves
3. run automatic OML analysis
4. refine the analysis manually
5. calculate EEDF and EEPF
6. optionally compare with an EPFL two-fluid model
7. export all results to CSV

It is intended to make Langmuir probe analysis more transparent by showing every intermediate step and allowing the user to manually adjust the most important fit regions.


## 15. Contact & Support

For questions, feedback, or bug reports, contact:

**Author:** Paul Hiret

**Email:** [paul.hiret@unibas.ch](mailto:paul.hiret@unibas.ch)

**Affiliation:** Universität Basel

License: <a href="https://github.com/Onyxmind024058/IEDF-Nanolino-">Langmuir Probe IV Analyser UB</a> © 2026 by <a href="https://github.com/Onyxmind024058">Paul Hiret from University of Basel</a> is licensed under <a href="https://creativecommons.org/licenses/by-nc/4.0/">Creative Commons Attribution-NonCommercial 4.0 International</a><img src="https://mirrors.creativecommons.org/presskit/icons/cc.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;"><img src="https://mirrors.creativecommons.org/presskit/icons/by.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;"><img src="https://mirrors.creativecommons.org/presskit/icons/nc.svg" alt="" style="max-width: 1em;max-height:1em;margin-left: .2em;">

---
