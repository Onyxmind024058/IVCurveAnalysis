# Langmuir Probe IV Analyser UB

A Python/PySide6 graphical application for loading `.lda` Langmuir probe files, plotting individual and averaged I–V curves, and extracting plasma parameters using automatic OML-style analysis, manual OML analysis, EEDF/EEPF calculation, and an EPFL two-fluid model.

The program is designed for interactive analysis of Langmuir probe measurements, especially when automatic fitting is not sufficient and the user needs to manually select fit regions.

To use the software, you can either download the last release and follow the setup instruction.
Or compile this code using pyinstaller: 
```bash
pyinstaller --onefile --windowed --name Langmuir_Probe_IV_Analyser_UB --icon=icon.ico --add-data "splash.png;." --add-data "icon.ico;." main.py
```
### Browser version (no installation)

The `web/` folder contains a browser edition of the same analyser, in the spirit of ImageJ.js:

- **Run it:** open `web/index.html` in any modern browser (double-click it). No Python, no install, no internet required, as all libraries are bundled.
- **Private:** `.lda` files are read locally by the browser and never uploaded.
- **Same maths:** `web/js/numerics.js` is a line-by-line port of the analysis functions in `main.py`, and gives the same Vf, Vp, Te, Ies, ne and EEDF/EEPF values as the Python app.
- **Data files:** opens `.lda` files and CSV/text files. The CSV importer detects the separator (comma, semicolon, tab or spaces) and decimal commas, skips header/metadata lines, and lets you pick the voltage column, the current column(s) (one scan each) and the current unit (A, mA, µA, nA), with a live preview. Files exported by this app can be opened again.
- **Data range:** in the *Data range* panel, the curve can be reduced before any analysis: skip the first/last N points of every sweep (e.g. start-up transients) and/or keep only a voltage window, set by typing or by dragging the lines on the main plot. All analyses and exports use the reduced curve.
- **Theme:** University of Basel light/dark theme (switch in the top-right corner).
- **Host it (optional):** the folder is static, so it can also be served from GitHub Pages or any web server.

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

The program requires Python 3 and the following packages:

```bash
pip install numpy matplotlib PySide6 scipy
```

`scipy` is only required for the nonlinear EPFL two-fluid fit. Most of the program works without it, but the nonlinear EPFL fit will fail if `scipy` is missing.

---

## 3. Running the Program

From a terminal:

```bash
python langmuir_probe_analyser.py
```

The main window will open.

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
├── langmuir_probe_analyser.py
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

## 12. Building an Executable

The program can be packaged with PyInstaller.

Example:

```bash
pip install pyinstaller
pyinstaller --onefile --windowed langmuir_probe_analyser.py
```

The executable will be created in the `dist/` folder.

For debugging, build without `--windowed` so that terminal errors remain visible:

```bash
pyinstaller --onefile langmuir_probe_analyser.py
```

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

1. load `.lda` files
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
