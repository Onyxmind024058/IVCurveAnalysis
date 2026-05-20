import sys
import xml.etree.ElementTree as ET
import numpy as np

import webbrowser
import json
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

from PySide6.QtCore import Qt, Signal, QTimer
from PySide6.QtWidgets import (
    QApplication, QMainWindow, QWidget, QFileDialog, QVBoxLayout, QHBoxLayout,
    QPushButton, QLabel, QComboBox, QTextEdit, QDoubleSpinBox, QSpinBox,
    QGroupBox, QFormLayout, QMessageBox, QCheckBox, QDialog, QTabWidget,
    QSlider, QTableWidget, QTableWidgetItem, QGridLayout, QMenu, QSplashScreen
)
from PySide6.QtGui import QGuiApplication, QImage, QPixmap, QIcon

import csv
import io

from matplotlib.backends.backend_qtagg import FigureCanvasQTAgg, NavigationToolbar2QT
from matplotlib.figure import Figure


E_CHARGE = 1.602176634e-19
M_E = 9.10938356e-31
K_B = 1.380649e-23
EV_TO_K = 11604.51812


# ============================================================
# App / GitHub release settings
# ============================================================
APP_VERSION = "0.9a"
GITHUB_OWNER = "Onyxmind024058"
GITHUB_REPO = "IVcurveAnalysis"
PREFERRED_ASSET_EXTENSIONS = [".exe", ".msi", ".zip"]

def resource_path(rel_path: str) -> str:
    base = getattr(sys, "_MEIPASS", os.path.abspath("."))
    return os.path.join(base, rel_path)


def normalize_version(v: str) -> str:
    return (v or "").strip().lstrip("v").strip()


def parse_version_tuple(v: str) -> tuple[int, ...]:
    v = normalize_version(v)
    if not v:
        return (0,)

    parts = []
    for chunk in v.split("."):
        digits = ""
        for ch in chunk:
            if ch.isdigit():
                digits += ch
            else:
                break
        parts.append(int(digits) if digits else 0)
    return tuple(parts) if parts else (0,)


def is_newer_version(latest_tag: str, current_version: str) -> bool:
    return parse_version_tuple(latest_tag) > parse_version_tuple(current_version)


def get_latest_github_release(owner: str, repo: str) -> dict:
    url = f"https://api.github.com/repos/{owner}/{repo}/releases/latest"
    headers = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": f"{repo}-update-checker",
    }
    req = Request(url, headers=headers, method="GET")
    with urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def choose_best_asset(release: dict) -> str | None:
    assets = release.get("assets", [])
    if not isinstance(assets, list):
        return None

    for ext in PREFERRED_ASSET_EXTENSIONS:
        for asset in assets:
            name = str(asset.get("name", "")).lower()
            url = asset.get("browser_download_url")
            if name.endswith(ext) and url:
                return url

    for asset in assets:
        url = asset.get("browser_download_url")
        if url:
            return url
    return None


# -----------------------------------------------------------------------------
# Data loading
# -----------------------------------------------------------------------------

def parse_series(item, tag):
    node = item.find(tag)
    if node is None:
        raise ValueError(f"Missing tag: {tag}")
    return np.array([float(d.text) for d in node.findall("Data")])


def load_lda(path):
    tree = ET.parse(path)
    root = tree.getroot()

    dm = root.find("DataManager")
    if dm is None:
        raise ValueError("No <DataManager> found")

    scans = []
    for item in dm.findall("DataItem"):
        sid = int(item.findtext("ID", default="-1"))
        scans.append({
            "id": sid,
            "VData": parse_series(item, "VData"),
            "RefData": parse_series(item, "RefData"),
            "IData": parse_series(item, "IData"),
        })

    if not scans:
        raise ValueError("No scans found")

    scans.sort(key=lambda x: x["id"])
    return scans


def average_scans(scans, xkey):
    xgrid = scans[0][xkey]
    currents = []

    for s in scans:
        x = s[xkey]
        i = s["IData"]
        order = np.argsort(x)
        currents.append(np.interp(xgrid, x[order], i[order]))

    currents = np.vstack(currents)

    imean = currents.mean(axis=0)

    if currents.shape[0] >= 2:
        istd = currents.std(axis=0, ddof=1)
    else:
        istd = np.zeros_like(imean)

    return xgrid, imean, istd, currents


# -----------------------------------------------------------------------------
# Numerical helpers
# -----------------------------------------------------------------------------

def make_odd(n, minimum=3):
    n = int(round(n))
    n = max(minimum, n)
    if n % 2 == 0:
        n += 1
    return n


def moving_average(y, w):
    w = make_odd(w)
    if w < 3:
        return y.copy()
    pad = w // 2
    yp = np.pad(y, (pad, pad), mode="edge")
    return np.convolve(yp, np.ones(w) / w, mode="valid")


def polynomial_smooth(y, window=13, order=2):
    """
    Local polynomial smoother, used as a SciPy-free Savitzky-Golay-like fallback.
    It is slower than scipy.signal.savgol_filter but avoids adding a dependency.
    """
    y = np.asarray(y, dtype=float)
    window = make_odd(window)
    order = int(max(1, min(order, window - 1)))
    half = window // 2
    out = np.empty_like(y)

    for idx in range(len(y)):
        lo = max(0, idx - half)
        hi = min(len(y), idx + half + 1)
        xx = np.arange(lo, hi, dtype=float) - idx
        yy = y[lo:hi]
        deg = min(order, len(yy) - 1)
        coeff = np.polyfit(xx, yy, deg)
        out[idx] = np.polyval(coeff, 0.0)

    return out


def smooth_signal(y, method="Moving average", window=21, order=2):
    if method == "Polynomial / SG-like":
        return polynomial_smooth(y, window=window, order=order)
    return moving_average(y, window)


def finite_crossing_x(x, y):
    zc = np.where(np.diff(np.sign(y)) != 0)[0]
    if len(zc):
        k = zc[0]
        if y[k + 1] == y[k]:
            return x[k]
        return x[k] - y[k] * (x[k + 1] - x[k]) / (y[k + 1] - y[k])
    return np.nan


def fit_line_region(x, y, vmin, vmax, require_positive=False, log_y=False):
    x = np.asarray(x, dtype=float)
    y = np.asarray(y, dtype=float)
    mask = (x >= min(vmin, vmax)) & (x <= max(vmin, vmax)) & np.isfinite(x) & np.isfinite(y)
    if require_positive:
        mask &= y > 0
    if mask.sum() < 2:
        raise RuntimeError("Not enough points in selected fit region.")

    yy = np.log(y[mask]) if log_y else y[mask]
    coeff = np.polyfit(x[mask], yy, 1)
    return coeff, mask


# -----------------------------------------------------------------------------
# Automatic first-pass OML analysis
# -----------------------------------------------------------------------------

def analyse_oml(x, i, probe_area, ion_fraction=0.2, smooth_window=21):
    order = np.argsort(x)
    x = np.asarray(x, dtype=float)[order]
    i = np.asarray(i, dtype=float)[order]

    vf = finite_crossing_x(x, i)

    ismooth = moving_average(i, smooth_window)
    didv = np.gradient(ismooth, x)
    vp = x[np.argmax(didv)]

    nfit = max(10, int(len(x) * ion_fraction))

    # Automatic ion fit now follows the manual Basel-style approach:
    # linear fit of I_i^2(V), then signed sqrt reconstruction of I_i(V).
    sign_i = np.sign(np.nanmedian(ismooth[:nfit]))
    if sign_i == 0:
        sign_i = -1.0
    ion_i2_a, ion_i2_b = np.polyfit(x[:nfit], ismooth[:nfit] ** 2, 1)
    i2_eval = np.polyval([ion_i2_a, ion_i2_b], x)
    i2_eval = np.clip(i2_eval, 0.0, None)
    i_ion = sign_i * np.sqrt(i2_eval)

    ie = ismooth - i_ion

    vmin = vf if np.isfinite(vf) else x[0]
    vmax = vp - 0.2 * (vp - vmin)

    mask = (x >= vmin) & (x <= vmax) & (ie > 0)

    if mask.sum() < 10:
        raise RuntimeError("Not enough points for ln(Ie) fit. Try manual mode.")

    m, c = np.polyfit(x[mask], np.log(ie[mask]), 1)

    if m <= 0:
        raise RuntimeError("Bad ln(Ie) slope. Try manual mode.")

    te_ev = 1 / m
    ies = float(np.interp(vp, x, ie))

    te_joule = te_ev * E_CHARGE
    ne = ies / (E_CHARGE * probe_area) * np.sqrt((2 * np.pi * M_E) / te_joule)

    return {
        "Vf": vf,
        "Vp": vp,
        "Te_eV": te_ev,
        "Ies_A": ies,
        "ne_m3": ne,
        "ion_i2_a": ion_i2_a,
        "ion_i2_b": ion_i2_b,
        "x": x,
        "I_raw": i,
        "I_smooth": ismooth,
        "Iion": i_ion,
        "Ie": ie,
    }


# -----------------------------------------------------------------------------
# Matplotlib widget
# -----------------------------------------------------------------------------

class MplWidget(QWidget):
    def __init__(self, parent=None):
        super().__init__(parent)
        layout = QVBoxLayout(self)
        self.fig = Figure(figsize=(7, 5))
        self.canvas = FigureCanvasQTAgg(self.fig)
        self.canvas.setContextMenuPolicy(Qt.CustomContextMenu)
        self.canvas.customContextMenuRequested.connect(self.open_context_menu)

        self.toolbar = NavigationToolbar2QT(self.canvas, self)
        self.ax = self.fig.add_subplot(111)
        layout.addWidget(self.toolbar)
        layout.addWidget(self.canvas)

    def redraw(self):
        self.fig.tight_layout()
        self.canvas.draw()

    def open_context_menu(self, pos):
        menu = QMenu(self)
        copy_img = menu.addAction("Copy plot image")
        copy_data = menu.addAction("Copy curve data as CSV")
        action = menu.exec(self.canvas.mapToGlobal(pos))

        if action == copy_img:
            self.copy_plot_image()
        elif action == copy_data:
            self.copy_curve_data()

    def copy_plot_image(self):
        buf = io.BytesIO()
        self.fig.savefig(buf, format="png", dpi=200)
        img = QImage.fromData(buf.getvalue(), "PNG")
        QGuiApplication.clipboard().setImage(img)

    def copy_curve_data(self):
        lines = self.ax.get_lines()
        if not lines:
            return

        rows = []
        header = []

        max_len = max(len(line.get_xdata()) for line in lines)

        for line in lines:
            label = line.get_label()
            if label.startswith("_"):
                label = "curve"
            header += [f"{label}_x", f"{label}_y"]

        for k in range(max_len):
            row = []
            for line in lines:
                x = line.get_xdata()
                y = line.get_ydata()
                if k < len(x):
                    row += [x[k], y[k]]
                else:
                    row += ["", ""]
            rows.append(row)

        out = io.StringIO()
        writer = csv.writer(out)
        writer.writerow(header)
        writer.writerows(rows)
        QGuiApplication.clipboard().setText(out.getvalue())


class DraggableVLine:
    """Simple draggable vertical line linked to a QDoubleSpinBox."""
    def __init__(self, canvas, ax, spinbox, on_changed=None, **line_kwargs):
        self.canvas = canvas
        self.ax = ax
        self.spinbox = spinbox
        self.on_changed = on_changed
        self.press = False
        self.line = ax.axvline(spinbox.value(), picker=8, **line_kwargs)
        self.cid_press = canvas.mpl_connect("button_press_event", self.on_press)
        self.cid_motion = canvas.mpl_connect("motion_notify_event", self.on_motion)
        self.cid_release = canvas.mpl_connect("button_release_event", self.on_release)

    def on_press(self, event):
        if event.inaxes != self.ax or event.xdata is None:
            return
        contains, _ = self.line.contains(event)
        if contains:
            self.press = True

    def on_motion(self, event):
        if not self.press or event.inaxes != self.ax or event.xdata is None:
            return
        value = float(event.xdata)
        self.line.set_xdata([value, value])
        self.spinbox.blockSignals(True)
        self.spinbox.setValue(value)
        self.spinbox.blockSignals(False)
        self.canvas.draw_idle()

    def on_release(self, event):
        if not self.press:
            return
        self.press = False
        if event.xdata is not None:
            value = float(event.xdata)
            self.spinbox.blockSignals(True)
            self.spinbox.setValue(value)
            self.spinbox.blockSignals(False)
        if self.on_changed is not None:
            self.on_changed()

    def disconnect(self):
        self.canvas.mpl_disconnect(self.cid_press)
        self.canvas.mpl_disconnect(self.cid_motion)
        self.canvas.mpl_disconnect(self.cid_release)


# -----------------------------------------------------------------------------
# EEPF / EEDF helpers and popup
# -----------------------------------------------------------------------------

def compute_eepf_from_oml(V, I, probe_area, oml_results,
                          smooth_window=21, e_min_ev=0.0,
                          distribution_smooth_window=9):
    """
    Druyvesteyn-style EEPF/EEDF estimate from the second derivative of electron current.

    The MATLAB reference used:
        EEDFs = (2*sqrt(2*m_e))/(q^3*Aprobe) * d2Ie/dV^2

    Here energy is defined as E = Vp - Vprobe, in eV for a negatively biased probe
    relative to the plasma potential. Only E >= e_min_ev is returned.
    """
    order = np.argsort(V)
    V = np.asarray(V, dtype=float)[order]
    I = np.asarray(I, dtype=float)[order]

    Vp = float(oml_results.get("Vp", np.nan))
    if not np.isfinite(Vp):
        raise RuntimeError("A valid Vp is required before calculating EEPF/EEDF.")

    if "Ie" in oml_results and oml_results["Ie"] is not None:
        Ie = np.asarray(oml_results["Ie"], dtype=float)
        if len(Ie) != len(V):
            Ie = Ie[order]
    else:
        Ismooth = moving_average(I, smooth_window)
        if "Iion" in oml_results and oml_results["Iion"] is not None:
            Iion = np.asarray(oml_results["Iion"], dtype=float)
            if len(Iion) != len(V):
                Iion = Iion[order]
        elif "ion_i2_a" in oml_results and "ion_i2_b" in oml_results:
            i2_eval = np.polyval([oml_results["ion_i2_a"], oml_results["ion_i2_b"]], V)
            i2_eval = np.clip(i2_eval, 0.0, None)
            sign_i = -1.0
            Iion = sign_i * np.sqrt(i2_eval)
        elif "ion_a" in oml_results and "ion_b" in oml_results:
            Iion = oml_results["ion_a"] * V + oml_results["ion_b"]
        else:
            raise RuntimeError("Ion-current fit is missing. Run automatic or manual OML first.")
        Ie = Ismooth - Iion

    # Smooth before differentiating twice to reduce noise amplification.
    Ie_smooth = moving_average(Ie, smooth_window)
    dIe_dV = np.gradient(Ie_smooth, V)
    d2Ie_dV2 = np.gradient(dIe_dV, V)

    energy_ev = Vp - V
    eedf = (2.0 * np.sqrt(2.0 * M_E)) / (E_CHARGE ** 3 * probe_area) * d2Ie_dV2

    # Remove non-physical negative values
    eedf = np.clip(eedf, 0.0, None)

    # EEPF
    with np.errstate(divide="ignore", invalid="ignore"):
        eepf = eedf / np.sqrt(np.maximum(energy_ev, np.finfo(float).eps))

    # Remove possible residual negatives / NaNs
    eepf = np.clip(eepf, 0.0, None)

    mask = (
        np.isfinite(energy_ev)
        & np.isfinite(eedf)
        & np.isfinite(eepf)
        & (energy_ev >= e_min_ev)
    )

    # Sort by increasing energy for plotting.
    idx = np.argsort(energy_ev[mask])
    eedf_sorted = eedf[mask][idx]
    eepf_sorted = eepf[mask][idx]

    eedf_smooth = moving_average(eedf_sorted, distribution_smooth_window)
    eepf_smooth = moving_average(eepf_sorted, distribution_smooth_window)

    # Keep distributions physical after smoothing
    eedf_smooth = np.clip(eedf_smooth, 0.0, None)
    eepf_smooth = np.clip(eepf_smooth, 0.0, None)
    return {
        "E_eV": energy_ev[mask][idx],
        "EEDF": eedf_sorted,
        "EEPF": eepf_sorted,
        "EEDF_smooth": eedf_smooth,
        "EEPF_smooth": eepf_smooth,
        "Ie": Ie,
        "Ie_smooth": Ie_smooth,
        "d2Ie_dV2": d2Ie_dV2,
        "Vp": Vp,
    }


class EEPFDialog(QDialog):
    def __init__(self, parent, V, I, probe_area, oml_results, title="EEPF / EEDF"):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(1100, 750)
        self.V = np.asarray(V, dtype=float)
        self.I = np.asarray(I, dtype=float)
        self.probe_area = probe_area
        self.oml_results = oml_results

        root = QVBoxLayout(self)
        controls = QHBoxLayout()
        root.addLayout(controls)

        self.smooth_spin = QSpinBox()
        self.smooth_spin.setRange(3, 501)
        self.smooth_spin.setSingleStep(2)
        self.smooth_spin.setValue(31)
        self.smooth_spin.valueChanged.connect(self.update_plots)
        self.dist_smooth_spin = QSpinBox()
        self.dist_smooth_spin.setRange(3, 501)
        self.dist_smooth_spin.setSingleStep(2)
        self.dist_smooth_spin.setValue(9)
        self.dist_smooth_spin.valueChanged.connect(self.update_plots)
        controls.addWidget(QLabel("EEDF/EEPF smoothing:"))
        controls.addWidget(self.dist_smooth_spin)

        self.logscale_box = QCheckBox("Log y-axis")
        self.logscale_box.stateChanged.connect(self.update_plots)
        controls.addWidget(self.logscale_box)

        self.current_data = None

        controls.addWidget(QLabel("2nd-derivative smoothing:"))
        controls.addWidget(self.smooth_spin)

        self.emin_spin = QDoubleSpinBox()
        self.emin_spin.setRange(0.0, 1e6)
        self.emin_spin.setDecimals(3)
        self.emin_spin.setSingleStep(0.5)
        self.emin_spin.setValue(0.0)
        self.emin_spin.valueChanged.connect(self.update_plots)
        controls.addWidget(QLabel("Min energy (eV):"))
        controls.addWidget(self.emin_spin)

        close_btn = QPushButton("Close")
        close_btn.clicked.connect(self.accept)
        controls.addStretch()
        controls.addWidget(close_btn)

        grid = QGridLayout()
        root.addLayout(grid, 1)

        self.plot_iv = MplWidget()
        self.plot_eedf = MplWidget()
        self.plot_eepf = MplWidget()
        self.plot_d2 = MplWidget()
        grid.addWidget(self.plot_iv, 0, 0)
        grid.addWidget(self.plot_eedf, 0, 1)
        grid.addWidget(self.plot_eepf, 1, 0)
        grid.addWidget(self.plot_d2, 1, 1)

        self.update_plots()

    def update_plots(self):
        try:
            data = compute_eepf_from_oml(
                self.V,
                self.I,
                self.probe_area,
                self.oml_results,
                smooth_window=self.smooth_spin.value(),
                e_min_ev=self.emin_spin.value(),
                distribution_smooth_window=self.dist_smooth_spin.value(),
            )
            self.current_data = data
        except Exception as exc:
            QMessageBox.warning(self, "EEPF calculation failed", str(exc))
            return

        ax = self.plot_iv.ax
        ax.clear()
        ax.plot(self.V, self.I, label="raw I")
        ax.plot(self.V, data["Ie_smooth"], label="smoothed Ie")
        ax.axvline(data["Vp"], linestyle="--", label="Vp")
        ax.set_xlabel("Probe voltage (V)")
        ax.set_ylabel("Current (A)")
        ax.set_title("Electron current used for derivatives")
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
        self.plot_iv.redraw()

        ax = self.plot_eedf.ax
        ax.clear()
        ax.plot(data["E_eV"], data["EEDF"], label="EEDF raw")
        ax.plot(data["E_eV"], data["EEDF_smooth"], label="EEDF smoothed")
        ax.set_xlabel("Energy (eV)")
        ax.set_ylabel("EEDF")
        ax.set_title("EEDF")
        if self.logscale_box.isChecked():
            ax.set_yscale("log")
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
        self.plot_eedf.redraw()

        ax = self.plot_eepf.ax
        ax.clear()
        ax.plot(data["E_eV"], data["EEPF"], label="EEPF raw")
        ax.plot(data["E_eV"], data["EEPF_smooth"], label="EEPF smoothed")
        ax.set_xlabel("Energy (eV)")
        ax.set_ylabel("EEPF")
        ax.set_title("EEPF")
        if self.logscale_box.isChecked():
            ax.set_yscale("log")
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
        self.plot_eepf.redraw()

        ax = self.plot_d2.ax
        ax.clear()
        ax.plot(self.V, data["d2Ie_dV2"])
        ax.axvline(data["Vp"], linestyle="--", label="Vp")
        ax.set_xlabel("Probe voltage (V)")
        ax.set_ylabel("d²Ie/dV²")
        ax.set_title("Second derivative")
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
        self.plot_d2.redraw()


# -----------------------------------------------------------------------------
# Manual OML popup
# -----------------------------------------------------------------------------

class ManualOMLDialog(QDialog):
    results_ready = Signal(dict)

    def __init__(self, parent, V, I, probe_area, cycle_label="Mean curve"):
        super().__init__(parent)
        self.setWindowTitle("Manual OML analysis")
        self.resize(1150, 780)

        order = np.argsort(V)
        self.V = np.asarray(V, dtype=float)[order]
        self.I = np.asarray(I, dtype=float)[order]
        self.probe_area = probe_area
        self.cycle_label = cycle_label

        self.Ismooth = self.I.copy()
        self.dIdV = None
        self.dIdVsmooth = None
        self.Vf = finite_crossing_x(self.V, self.I)
        self.Vp1 = np.nan
        self.Vp2 = np.nan
        self.Vp = np.nan
        self.Te_eV = np.nan
        self.ne_m3 = np.nan
        self.Iis_A = np.nan
        self.Ies_A = np.nan
        self.ion_coeff = None
        self.Iion = None
        self.Ie = None
        self.transition_coeff = None
        self.saturation_coeff = None
        self._drag_lines = []

        root = QVBoxLayout(self)
        self.tabs = QTabWidget()
        self.tabs.setTabPosition(QTabWidget.South)
        root.addWidget(self.tabs)

        self._build_tab_smooth_iv()
        self._build_tab_ion_fit()
        self._build_tab_didv_smooth()
        self._build_tab_vp_didv()
        self._build_tab_log_fit()
        self._build_tab_results()

        self.update_smooth_iv()

    # ----- UI builders --------------------------------------------------------

    def _build_tab_smooth_iv(self):
        tab = QWidget()
        layout = QVBoxLayout(tab)
        self.plot_smooth = MplWidget()
        layout.addWidget(self.plot_smooth)

        controls = QHBoxLayout()
        layout.addLayout(controls)

        self.smooth_method = QComboBox()
        self.smooth_method.addItems(["Moving average", "Polynomial / SG-like"])
        self.smooth_method.currentTextChanged.connect(self.update_smooth_iv)
        controls.addWidget(QLabel("Smooth method:"))
        controls.addWidget(self.smooth_method)

        self.smooth_window = QSlider(Qt.Horizontal)
        self.smooth_window.setRange(3, max(5, min(len(self.V), 501)))
        self.smooth_window.setValue(min(21, max(3, len(self.V) // 10)))
        self.smooth_window.valueChanged.connect(self.update_smooth_iv)
        controls.addWidget(QLabel("Window:"))
        controls.addWidget(self.smooth_window, 1)

        self.smooth_order = QSpinBox()
        self.smooth_order.setRange(1, 7)
        self.smooth_order.setValue(2)
        self.smooth_order.valueChanged.connect(self.update_smooth_iv)
        controls.addWidget(QLabel("Poly order:"))
        controls.addWidget(self.smooth_order)

        self.analysable_box = QCheckBox("Analysable")
        self.analysable_box.setChecked(True)
        controls.addWidget(self.analysable_box)

        next_btn = QPushButton("Next")
        next_btn.clicked.connect(self.next_from_smooth)
        controls.addWidget(next_btn)

        self.tabs.addTab(tab, "Smooth IV")

    def _build_tab_ion_fit(self):
        tab = QWidget()
        layout = QVBoxLayout(tab)
        self.plot_ion = MplWidget()
        layout.addWidget(self.plot_ion)

        controls = QHBoxLayout()
        layout.addLayout(controls)

        self.vf_spin = QDoubleSpinBox()
        self._configure_voltage_spin(self.vf_spin)
        self.vf_spin.valueChanged.connect(self.update_ion_fit)
        controls.addWidget(QLabel("Vf:"))
        controls.addWidget(self.vf_spin)

        self.ion_vmin_spin = QDoubleSpinBox()
        self._configure_voltage_spin(self.ion_vmin_spin)
        self.ion_vmin_spin.valueChanged.connect(self.update_ion_fit)
        controls.addWidget(QLabel("Ion Vmin:"))
        controls.addWidget(self.ion_vmin_spin)

        self.ion_vmax_spin = QDoubleSpinBox()
        self._configure_voltage_spin(self.ion_vmax_spin)
        self.ion_vmax_spin.valueChanged.connect(self.update_ion_fit)
        controls.addWidget(QLabel("Ion Vmax:"))
        controls.addWidget(self.ion_vmax_spin)

        next_btn = QPushButton("Next")
        next_btn.clicked.connect(self.next_from_ion)
        controls.addWidget(next_btn)

        self.tabs.addTab(tab, "Vf + ion fit")

    def _build_tab_didv_smooth(self):
        tab = QWidget()
        layout = QVBoxLayout(tab)
        self.plot_didv_smooth = MplWidget()
        layout.addWidget(self.plot_didv_smooth)

        controls = QHBoxLayout()
        layout.addLayout(controls)

        self.dmooth_method = QComboBox()
        self.dmooth_method.addItems(["Moving average", "Polynomial / SG-like"])
        self.dmooth_method.currentTextChanged.connect(self.update_didv_smooth)
        controls.addWidget(QLabel("dI/dV smooth method:"))
        controls.addWidget(self.dmooth_method)

        self.dmooth_window = QSlider(Qt.Horizontal)
        self.dmooth_window.setRange(3, max(5, min(len(self.V), 501)))
        self.dmooth_window.setValue(min(21, max(3, len(self.V) // 10)))
        self.dmooth_window.valueChanged.connect(self.update_didv_smooth)
        controls.addWidget(QLabel("Window:"))
        controls.addWidget(self.dmooth_window, 1)

        self.dmooth_order = QSpinBox()
        self.dmooth_order.setRange(1, 7)
        self.dmooth_order.setValue(2)
        self.dmooth_order.valueChanged.connect(self.update_didv_smooth)
        controls.addWidget(QLabel("Poly order:"))
        controls.addWidget(self.dmooth_order)

        next_btn = QPushButton("Next")
        next_btn.clicked.connect(self.next_from_didv_smooth)
        controls.addWidget(next_btn)

        self.tabs.addTab(tab, "dI/dV smooth")

    def _build_tab_vp_didv(self):
        tab = QWidget()
        layout = QVBoxLayout(tab)
        self.plot_vp = MplWidget()
        layout.addWidget(self.plot_vp)

        controls = QHBoxLayout()
        layout.addLayout(controls)

        self.vp1_spin = QDoubleSpinBox()
        self._configure_voltage_spin(self.vp1_spin)
        self.vp1_spin.valueChanged.connect(self.update_vp_plot)
        controls.addWidget(QLabel("Vp from dI/dV:"))
        controls.addWidget(self.vp1_spin)

        next_btn = QPushButton("Next")
        next_btn.clicked.connect(self.next_from_vp)
        controls.addWidget(next_btn)

        self.tabs.addTab(tab, "dI/dV Vp")

    def _build_tab_log_fit(self):
        tab = QWidget()
        layout = QVBoxLayout(tab)
        self.plot_log = MplWidget()
        layout.addWidget(self.plot_log)

        controls = QHBoxLayout()
        layout.addLayout(controls)

        self.trans_min_spin = QDoubleSpinBox()
        self._configure_voltage_spin(self.trans_min_spin)
        self.trans_min_spin.valueChanged.connect(self.update_log_fit)
        controls.addWidget(QLabel("Transition min:"))
        controls.addWidget(self.trans_min_spin)

        self.trans_max_spin = QDoubleSpinBox()
        self._configure_voltage_spin(self.trans_max_spin)
        self.trans_max_spin.valueChanged.connect(self.update_log_fit)
        controls.addWidget(QLabel("Transition max:"))
        controls.addWidget(self.trans_max_spin)

        self.sat_min_spin = QDoubleSpinBox()
        self._configure_voltage_spin(self.sat_min_spin)
        self.sat_min_spin.valueChanged.connect(self.update_log_fit)
        controls.addWidget(QLabel("Saturation min:"))
        controls.addWidget(self.sat_min_spin)

        self.sat_max_spin = QDoubleSpinBox()
        self._configure_voltage_spin(self.sat_max_spin)
        self.sat_max_spin.valueChanged.connect(self.update_log_fit)
        controls.addWidget(QLabel("Saturation max:"))
        controls.addWidget(self.sat_max_spin)

        self.vp2_spin = QDoubleSpinBox()
        self._configure_voltage_spin(self.vp2_spin)
        self.vp2_spin.valueChanged.connect(self.update_log_fit_manual_vp2)
        controls.addWidget(QLabel("Vp intersection:"))
        controls.addWidget(self.vp2_spin)

        finish_btn = QPushButton("Finish")
        finish_btn.clicked.connect(self.finish_analysis)
        controls.addWidget(finish_btn)

        self.tabs.addTab(tab, "log(Ie) fits")

    def _build_tab_results(self):
        tab = QWidget()
        layout = QVBoxLayout(tab)
        self.results_table = QTableWidget(1, 6)
        self.results_table.setHorizontalHeaderLabels(["Vp", "Vf", "Te_eV", "ne_m^-3", "Iis_A", "Ies_A"])
        layout.addWidget(self.results_table)

        controls = QHBoxLayout()
        layout.addLayout(controls)
        send_btn = QPushButton("Send results to main window and close")
        send_btn.clicked.connect(self.send_results_and_close)
        controls.addStretch()
        controls.addWidget(send_btn)

        self.tabs.addTab(tab, "Results")

    def _configure_voltage_spin(self, spin):
        spin.setRange(float(np.nanmin(self.V)) - 1000.0, float(np.nanmax(self.V)) + 1000.0)
        spin.setDecimals(4)
        spin.setSingleStep(0.1)

    # ----- Tab logic ----------------------------------------------------------

    def update_smooth_iv(self):
        method = self.smooth_method.currentText()
        window = make_odd(self.smooth_window.value())
        order = self.smooth_order.value()
        self.Ismooth = smooth_signal(self.I, method=method, window=window, order=order)

        ax = self.plot_smooth.ax
        ax.clear()
        ax.plot(self.V, self.I, "-", label="raw")
        ax.plot(self.V, self.Ismooth, "-", label="smoothed")
        ax.set_title(self.cycle_label)
        ax.set_xlabel("Potential (V)")
        ax.set_ylabel("Current (A)")
        ax.grid(True, alpha=0.3)
        ax.legend()
        self.plot_smooth.redraw()

    def next_from_smooth(self):
        if not self.analysable_box.isChecked():
            self.Vp = self.Vf = self.Te_eV = self.ne_m3 = self.Iis_A = self.Ies_A = np.nan
            self.update_results_table()
            self.tabs.setCurrentIndex(5)
            return

        self.Vf = finite_crossing_x(self.V, self.Ismooth)
        if not np.isfinite(self.Vf):
            self.Vf = float(self.V[np.argmin(np.abs(self.Ismooth))])

        vmin_default = float(self.V[min(5, len(self.V) - 1)])
        vmax_default = min(float(self.Vf), vmin_default + 0.25 * (float(np.max(self.V)) - vmin_default))
        if vmax_default <= vmin_default:
            vmax_default = vmin_default + 0.1 * (float(np.max(self.V)) - vmin_default)

        self.vf_spin.blockSignals(True)
        self.ion_vmin_spin.blockSignals(True)
        self.ion_vmax_spin.blockSignals(True)
        self.vf_spin.setValue(float(self.Vf))
        self.ion_vmin_spin.setValue(vmin_default)
        self.ion_vmax_spin.setValue(vmax_default)
        self.vf_spin.blockSignals(False)
        self.ion_vmin_spin.blockSignals(False)
        self.ion_vmax_spin.blockSignals(False)

        self.update_ion_fit()
        self.tabs.setCurrentIndex(1)

    def update_ion_fit(self):
        if not hasattr(self, "ion_vmin_spin"):
            return
        try:
            self.Vf = self.vf_spin.value()

            # Basel OML style for a cylindrical probe: fit I_i^2 versus V
            # in the ion-current region, then reconstruct I_i(V).
            # The sign is taken from the local ion-current region so that
            # negative ion current remains negative after sqrt().
            ion_mask = (
                (self.V >= min(self.ion_vmin_spin.value(), self.ion_vmax_spin.value()))
                & (self.V <= max(self.ion_vmin_spin.value(), self.ion_vmax_spin.value()))
                & np.isfinite(self.Ismooth)
            )
            if ion_mask.sum() < 2:
                raise RuntimeError("Not enough points in selected ion fit region.")

            sign_i = np.sign(np.nanmedian(self.Ismooth[ion_mask]))
            if sign_i == 0:
                sign_i = -1.0

            coeff = np.polyfit(self.V[ion_mask], self.Ismooth[ion_mask] ** 2, 1)
            i2_eval = np.polyval(coeff, self.V)
            i2_eval = np.clip(i2_eval, 0.0, None)

            self.ion_coeff = coeff
            self.Iion = sign_i * np.sqrt(i2_eval)
            self.Iis_A = float(sign_i * np.sqrt(max(np.polyval(coeff, 0.0), 0.0)))
        except Exception:
            self.ion_coeff = None
            self.Iion = np.full_like(self.V, np.nan)
            self.Iis_A = np.nan

        ax = self.plot_ion.ax
        ax.clear()
        upto_vf = self.V <= self.Vf if np.isfinite(self.Vf) else np.ones_like(self.V, dtype=bool)

        ax.plot(self.V[upto_vf], self.I[upto_vf] ** 2, "-", label="raw I²")
        ax.plot(self.V[upto_vf], self.Ismooth[upto_vf] ** 2, "-", label="smoothed I²")

        if self.ion_coeff is not None:
            ax.plot(self.V[upto_vf], self.Iion[upto_vf] ** 2, "-", label="linear fit on I²")

        ax.set_xlim(float(np.nanmin(self.V[upto_vf])), float(self.Vf))
        ax.set_ylabel("Current squared (A²)")
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
        self.plot_ion.redraw()
        self._install_ion_draggable_lines()

    def _clear_drag_lines(self):
        for line in self._drag_lines:
            try:
                line.disconnect()
            except Exception:
                pass
        self._drag_lines = []

    def _install_ion_draggable_lines(self):
        self._clear_drag_lines()
        canvas = self.plot_ion.canvas
        ax = self.plot_ion.ax
        self._drag_lines = [
            DraggableVLine(canvas, ax, self.vf_spin, self.update_ion_fit, linestyle="--", label="drag Vf"),
            DraggableVLine(canvas, ax, self.ion_vmin_spin, self.update_ion_fit, linestyle=":"),
            DraggableVLine(canvas, ax, self.ion_vmax_spin, self.update_ion_fit, linestyle=":"),
        ]
        self.plot_ion.redraw()

    def _install_didv_smooth_draggable_line(self):
        # The dI/dV smoothing tab has no region spinboxes, but once Vp exists,
        # the same Vp line can be adjusted here too.
        if not hasattr(self, "vp1_spin") or not np.isfinite(self.Vp1):
            return
        self._clear_drag_lines()
        canvas = self.plot_didv_smooth.canvas
        ax = self.plot_didv_smooth.ax
        self._drag_lines = [
            DraggableVLine(canvas, ax, self.vp1_spin, self.update_didv_smooth, linestyle="--"),
        ]
        self.plot_didv_smooth.redraw()

    def _install_vp_draggable_line(self):
        self._clear_drag_lines()
        canvas = self.plot_vp.canvas
        ax = self.plot_vp.ax
        self._drag_lines = [
            DraggableVLine(canvas, ax, self.vp1_spin, self.update_vp_plot, linestyle="--"),
        ]
        self.plot_vp.redraw()

    def _install_log_draggable_lines(self):
        self._clear_drag_lines()
        canvas = self.plot_log.canvas
        ax = self.plot_log.ax
        self._drag_lines = [
            DraggableVLine(canvas, ax, self.trans_min_spin, self.update_log_fit, linestyle=":"),
            DraggableVLine(canvas, ax, self.trans_max_spin, self.update_log_fit, linestyle=":"),
            DraggableVLine(canvas, ax, self.sat_min_spin, self.update_log_fit, linestyle="--"),
            DraggableVLine(canvas, ax, self.sat_max_spin, self.update_log_fit, linestyle="--"),
            DraggableVLine(canvas, ax, self.vp2_spin, self.update_log_fit_preserve_vp2, linestyle="-"),
        ]
        self.plot_log.redraw()

    def next_from_ion(self):
        if self.ion_coeff is None:
            QMessageBox.warning(self, "Missing fit", "Please choose a valid ion fit region first.")
            return

        # Electron current after ion-current subtraction.
        self.Ie = self.Ismooth - self.Iion
        self.dIdV = np.gradient(self.Ie, self.V)
        self.update_didv_smooth()
        self.tabs.setCurrentIndex(2)

    def update_didv_smooth(self):
        if self.dIdV is None:
            return
        method = self.dmooth_method.currentText()
        window = make_odd(self.dmooth_window.value())
        order = self.dmooth_order.value()
        self.dIdVsmooth = smooth_signal(self.dIdV, method=method, window=window, order=order)

        ax = self.plot_didv_smooth.ax
        ax.clear()
        ax.plot(self.V, self.dIdV, "-", label="raw dIe/dV")
        ax.plot(self.V, self.dIdVsmooth, "-", label="smoothed dIe/dV")
        ax.set_title("Derivative smoothing")
        ax.set_xlabel("Potential (V)")
        ax.set_ylabel("dIe/dV (A/V)")
        ax.grid(True, alpha=0.3)
        ax.legend()
        if np.isfinite(self.Vp1):
            ax.axvline(self.Vp1, linestyle="--", label="current Vp")
            ax.legend()
        self.plot_didv_smooth.redraw()
        self._install_didv_smooth_draggable_line()

    def next_from_didv_smooth(self):
        if self.dIdVsmooth is None:
            return
        margin = 5 if len(self.V) > 10 else 0
        local = self.dIdVsmooth[margin:len(self.V) - margin]
        if len(local) == 0:
            local = self.dIdVsmooth
            margin = 0
        idx = int(np.nanargmax(local)) + margin
        self.Vp1 = float(self.V[idx])

        self.vp1_spin.blockSignals(True)
        self.vp1_spin.setValue(self.Vp1)
        self.vp1_spin.blockSignals(False)
        self.update_didv_smooth()
        self.update_vp_plot()
        self.tabs.setCurrentIndex(3)

    def update_vp_plot(self):
        if self.dIdVsmooth is None:
            return
        self.Vp1 = self.vp1_spin.value()
        ax = self.plot_vp.ax
        ax.clear()
        ax.plot(self.V, self.dIdVsmooth, "-", label="smoothed dIe/dV")
        ax.axvline(self.Vp1, linestyle="--", label="Vp from dI/dV")
        ax.set_title("Manual plasma potential from derivative")
        ax.set_xlabel("Potential (V)")
        ax.set_ylabel("dIe/dV (A/V)")
        ax.grid(True, alpha=0.3)
        ax.legend()
        self.plot_vp.redraw()

    def next_from_vp(self):
        self.Vp1 = self.vp1_spin.value()
        span = float(np.max(self.V) - np.min(self.V))
        trans_min = self.Vp1 - 0.30 * span
        trans_max = self.Vp1 - 0.10 * span
        sat_min = self.Vp1 + 0.05 * span
        sat_max = self.Vp1 + 0.25 * span

        trans_min = float(np.clip(trans_min, np.min(self.V), np.max(self.V)))
        trans_max = float(np.clip(trans_max, np.min(self.V), np.max(self.V)))
        sat_min = float(np.clip(sat_min, np.min(self.V), np.max(self.V)))
        sat_max = float(np.clip(sat_max, np.min(self.V), np.max(self.V)))

        self.trans_min_spin.blockSignals(True)
        self.trans_max_spin.blockSignals(True)
        self.sat_min_spin.blockSignals(True)
        self.sat_max_spin.blockSignals(True)
        self.vp2_spin.blockSignals(True)
        self.trans_min_spin.setValue(trans_min)
        self.trans_max_spin.setValue(trans_max)
        self.sat_min_spin.setValue(sat_min)
        self.sat_max_spin.setValue(sat_max)
        self.vp2_spin.setValue(self.Vp1)
        self.trans_min_spin.blockSignals(False)
        self.trans_max_spin.blockSignals(False)
        self.sat_min_spin.blockSignals(False)
        self.sat_max_spin.blockSignals(False)
        self.vp2_spin.blockSignals(False)

        self.update_log_fit()
        self.tabs.setCurrentIndex(4)

    def update_log_fit(self):
        if self.Ie is None:
            return

        valid = self.Ie > 0
        xfit = np.linspace(float(np.min(self.V)), float(np.max(self.V)), 1000)
        try:
            self.transition_coeff, _ = fit_line_region(
                self.V, self.Ie,
                self.trans_min_spin.value(), self.trans_max_spin.value(),
                require_positive=True, log_y=True,
            )
            self.saturation_coeff, _ = fit_line_region(
                self.V, self.Ie,
                self.sat_min_spin.value(), self.sat_max_spin.value(),
                require_positive=True, log_y=True,
            )

            y_trans = np.polyval(self.transition_coeff, xfit)
            y_sat = np.polyval(self.saturation_coeff, xfit)
            idx = int(np.argmin(np.abs(y_sat - y_trans)))
            self.Vp2 = float(xfit[idx])
            self.vp2_spin.blockSignals(True)
            self.vp2_spin.setValue(self.Vp2)
            self.vp2_spin.blockSignals(False)
        except Exception:
            self.transition_coeff = None
            self.saturation_coeff = None
            y_trans = None
            y_sat = None

        self._draw_log_fit(xfit, y_trans, y_sat, valid)

    def update_log_fit_manual_vp2(self):
        self.Vp2 = self.vp2_spin.value()
        self.update_log_fit_preserve_vp2()

    def update_log_fit_preserve_vp2(self):
        if self.Ie is None:
            return
        valid = self.Ie > 0
        xfit = np.linspace(float(np.min(self.V)), float(np.max(self.V)), 1000)
        y_trans = None
        y_sat = None
        try:
            self.transition_coeff, _ = fit_line_region(
                self.V, self.Ie,
                self.trans_min_spin.value(), self.trans_max_spin.value(),
                require_positive=True, log_y=True,
            )
            self.saturation_coeff, _ = fit_line_region(
                self.V, self.Ie,
                self.sat_min_spin.value(), self.sat_max_spin.value(),
                require_positive=True, log_y=True,
            )
            y_trans = np.polyval(self.transition_coeff, xfit)
            y_sat = np.polyval(self.saturation_coeff, xfit)
        except Exception:
            pass
        self._draw_log_fit(xfit, y_trans, y_sat, valid)

    def _draw_log_fit(self, xfit, y_trans, y_sat, valid):
        if hasattr(self, "vp2_spin") and np.isfinite(self.vp2_spin.value()):
            self.Vp2 = self.vp2_spin.value()
        ax = self.plot_log.ax
        ax.clear()
        ax.plot(self.V[valid], np.log(self.Ie[valid]), "-", label="log(Ie)")
        if y_sat is not None:
            ax.plot(xfit, y_sat, "-", label="saturation fit")
        if y_trans is not None:
            ax.plot(xfit, y_trans, "-", label="transition fit")
        ax.axvline(self.trans_min_spin.value(), linestyle=":", label="transition range")
        ax.axvline(self.trans_max_spin.value(), linestyle=":")
        ax.axvline(self.sat_min_spin.value(), linestyle="--", label="saturation range")
        ax.axvline(self.sat_max_spin.value(), linestyle="--")
        ax.axvline(self.Vp1, linestyle="-.", label="Vp dI/dV")
        ax.axvline(self.Vp2, linestyle="-", label="Vp intersection")
        ax.set_title("Transition and saturation fits")
        ax.set_xlabel("Potential (V)")
        ax.set_ylabel("ln(Ie [A])")
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
        self.plot_log.redraw()
        self._install_log_draggable_lines()

    def finish_analysis(self):
        if self.transition_coeff is None:
            QMessageBox.warning(self, "Missing transition fit", "Please choose a valid transition fit region.")
            return

        slope = float(self.transition_coeff[0])
        if slope <= 0:
            QMessageBox.warning(self, "Invalid Te", "Transition fit slope must be positive for Te = 1/slope.")
            return

        self.Te_eV = 1.0 / slope
        self.Vp2 = self.vp2_spin.value()

        if np.isfinite(self.Vp1) and np.isfinite(self.Vp2):
            self.Vp = 0.5 * (self.Vp1 + self.Vp2)
        elif np.isfinite(self.Vp1):
            self.Vp = self.Vp1
        else:
            self.Vp = self.Vp2

        if self.Ie is not None and np.isfinite(self.Vp):
            self.Ies_A = float(np.interp(self.Vp, self.V, self.Ie))
        else:
            self.Ies_A = np.nan

        if self.Ies_A > 0 and self.probe_area > 0 and self.Te_eV > 0:
            te_joule = self.Te_eV * E_CHARGE
            self.ne_m3 = self.Ies_A / (E_CHARGE * self.probe_area) * np.sqrt((2 * np.pi * M_E) / te_joule)
        else:
            self.ne_m3 = np.nan

        self.update_results_table()
        self.tabs.setCurrentIndex(5)

    def update_results_table(self):
        values = [self.Vp, self.Vf, self.Te_eV, self.ne_m3, self.Iis_A, self.Ies_A]
        for col, value in enumerate(values):
            text = f"{value:.6g}" if np.isfinite(value) else "NaN"
            self.results_table.setItem(0, col, QTableWidgetItem(text))

    def send_results_and_close(self):
        results = {
            "Vp": self.Vp,
            "Vf": self.Vf,
            "Te_eV": self.Te_eV,
            "ne_m3": self.ne_m3,
            "Iis_A": self.Iis_A,
            "Ies_A": self.Ies_A,
            "ion_i2_a": self.ion_coeff[0] if self.ion_coeff is not None else np.nan,
            "ion_i2_b": self.ion_coeff[1] if self.ion_coeff is not None else np.nan,
            "Vp_dIdV": self.Vp1,
            "Vp_intersection": self.Vp2,
        }
        self.results_ready.emit(results)
        self.accept()


# -----------------------------------------------------------------------------
# EPFL two-fluid model popup
# -----------------------------------------------------------------------------

def rebin_curve(V, I, npt=1000):
    """Rebin I(V) on a regular voltage grid, following the MATLAB EPFL-TF app idea."""
    order = np.argsort(V)
    V = np.asarray(V, dtype=float)[order]
    I = np.asarray(I, dtype=float)[order]
    vmin = float(np.nanmin(V))
    vmax = float(np.nanmax(V))
    if vmax <= vmin:
        raise RuntimeError("Invalid voltage range for EPFL two-fluid analysis.")
    bins = np.linspace(vmin, vmax, int(npt) + 1)
    centers = 0.5 * (bins[:-1] + bins[1:])
    inds = np.digitize(V, bins) - 1
    out_v = []
    out_i = []
    for k in range(len(centers)):
        mask = inds == k
        if np.any(mask):
            out_v.append(centers[k])
            out_i.append(float(np.nanmean(I[mask])))
    return np.asarray(out_v), np.asarray(out_i)


def fit_epfl_two_fluid(V, J, fit_mode, ne0, Te0, Vp0, Vf0):
    """
    Fit EPFL two-fluid electron current-density model.

    MATLAB model after scaling:
        J = q*sqrt(q/me)*sqrt(Te)*ne*exp(-1/2 - Vp/Te)
            * (exp(V/Te) - exp(Vf/Te))

    Te is in eV, V in V, ne in m^-3, J in A/m^2.
    """
    try:
        from scipy.optimize import curve_fit
    except Exception as exc:
        raise RuntimeError("scipy is required for the EPFL two-fluid nonlinear fit.") from exc

    V = np.asarray(V, dtype=float)
    J = np.asarray(J, dtype=float)
    valid = np.isfinite(V) & np.isfinite(J)
    V = V[valid]
    J = J[valid]
    if len(V) < 5:
        raise RuntimeError("Not enough points for EPFL two-fluid fit.")

    def model_all(v, ne, Te, Vp, Vf):
        Te = np.maximum(Te, 1e-6)
        return (E_CHARGE * np.sqrt(E_CHARGE / M_E) * np.sqrt(Te) * ne
                * np.exp(-0.5 - Vp / Te)
                * (np.exp(v / Te) - np.exp(Vf / Te)))

    def model_vp_ne(v, ne, Vp):
        return model_all(v, ne, Te0, Vp, Vf0)

    def model_ne(v, ne):
        return model_all(v, ne, Te0, Vp0, Vf0)

    if fit_mode == "all":
        p0 = [max(ne0, 1e12), max(Te0, 0.05), Vp0, Vf0]
        lower = [0.0, 1e-4, np.nanmin(V) - 100.0, np.nanmin(V) - 100.0]
        upper = [np.inf, np.inf, np.nanmax(V) + 100.0, np.nanmax(V) + 100.0]
        popt, _ = curve_fit(model_all, V, J, p0=p0, bounds=(lower, upper), maxfev=20000)
        ne, Te, Vp, Vf = popt
    elif fit_mode == "Vp, ne":
        p0 = [max(ne0, 1e12), Vp0]
        lower = [0.0, np.nanmin(V) - 100.0]
        upper = [np.inf, np.nanmax(V) + 100.0]
        popt, _ = curve_fit(model_vp_ne, V, J, p0=p0, bounds=(lower, upper), maxfev=20000)
        ne, Vp = popt
        Te, Vf = Te0, Vf0
    else:
        p0 = [max(ne0, 1e12)]
        popt, _ = curve_fit(model_ne, V, J, p0=p0, bounds=([0.0], [np.inf]), maxfev=20000)
        ne = float(popt[0])
        Te, Vp, Vf = Te0, Vp0, Vf0

    Jfit = model_all(V, ne, Te, Vp, Vf)
    return {"ne_m3": float(ne), "Te_eV": float(Te), "Vp": float(Vp), "Vf": float(Vf), "V_fit": V, "J_fit": Jfit}


class EPFLTwoFluidDialog(QDialog):
    results_ready = Signal(dict)

    def __init__(self, parent, V, I, probe_area, title="EPFL two-fluid model"):
        super().__init__(parent)
        self.setWindowTitle(title)
        self.resize(1250, 850)
        self.probe_area = probe_area

        self.V_raw = np.asarray(V, dtype=float)
        self.I_raw = np.asarray(I, dtype=float)
        self.V, self.I = rebin_curve(self.V_raw, self.I_raw, npt=len(self.I_raw))
        self.Vsmooth = self.V.copy()
        self.Ismooth = self.I.copy()
        self.J = np.full_like(self.I, np.nan)
        self.dIdV = None
        self.dIdVsmooth = None
        self.Vp = np.nan
        self.Vf = np.nan
        self.Te_eV = np.nan
        self.ne_m3 = np.nan
        self.EfVa = None
        self.EfJa = None
        self.fit_result = None
        self._drag_lines = []

        root = QVBoxLayout(self)

        controls = QGroupBox("EPFL two-fluid controls")
        form = QFormLayout(controls)
        root.addWidget(controls)

        self.smooth_spin = QSpinBox()
        self.smooth_spin.setRange(1, 501)
        self.smooth_spin.setSingleStep(1)
        self.smooth_spin.setValue(10)
        self.smooth_spin.valueChanged.connect(self.recalculate_all)
        form.addRow("Smooth window:", self.smooth_spin)

        self.vp_spin = QDoubleSpinBox()
        self.vp_spin.setRange(float(np.nanmin(self.V)) - 100, float(np.nanmax(self.V)) + 100)
        self.vp_spin.setDecimals(2)
        self.vp_spin.setSingleStep(0.1)
        self.vp_spin.valueChanged.connect(self.recalculate_all)
        form.addRow("Vp:", self.vp_spin)

        self.transition_points_spin = QSpinBox()
        self.transition_points_spin.setRange(2, 500)
        self.transition_points_spin.setValue(5)
        self.transition_points_spin.valueChanged.connect(self.recalculate_all)
        form.addRow("Transition fit half-width points:", self.transition_points_spin)

        self.va_spin = QDoubleSpinBox()
        self.va_spin.setRange(float(np.nanmin(self.V)) - 1000, float(np.nanmax(self.V)) + 1000)
        self.va_spin.setDecimals(4)
        self.va_spin.setSingleStep(0.1)
        self.va_spin.valueChanged.connect(self.recalculate_all)
        form.addRow("Va upper limit for Te fit:", self.va_spin)

        self.offset_spin = QDoubleSpinBox()
        self.offset_spin.setRange(0.0, 1e6)
        self.offset_spin.setDecimals(4)
        self.offset_spin.setSingleStep(0.1)
        self.offset_spin.setValue(1.0)
        self.offset_spin.valueChanged.connect(self.recalculate_all)
        form.addRow("Log offset factor:", self.offset_spin)

        self.fit_mode_box = QComboBox()
        self.fit_mode_box.addItems(["ne", "Vp, ne", "all"])
        self.fit_mode_box.currentTextChanged.connect(self.recalculate_all)
        form.addRow("Exponential fitting:", self.fit_mode_box)

        button_row = QHBoxLayout()
        root.addLayout(button_row)
        reset_btn = QPushButton("Reset automatic guesses")
        reset_btn.clicked.connect(self.reset_guesses)
        self.run_fit_btn = QPushButton("Run EPFL nonlinear fit")
        self.run_fit_btn.clicked.connect(self.run_nonlinear_fit)
        finish_btn = QPushButton("Send results to main window and close")
        finish_btn.clicked.connect(self.send_results_and_close)
        button_row.addWidget(reset_btn)
        button_row.addWidget(self.run_fit_btn)
        button_row.addStretch()
        button_row.addWidget(finish_btn)

        grid = QGridLayout()
        root.addLayout(grid, 1)
        self.plot_iv = MplWidget()
        self.plot_didv = MplWidget()
        self.plot_transition = MplWidget()
        self.plot_te = MplWidget()
        self.plot_exp = MplWidget()
        self.results_table = QTableWidget(1, 4)
        self.results_table.setHorizontalHeaderLabels(["Vp", "Vf", "Te_eV", "ne_m^-3"])
        grid.addWidget(self.plot_iv, 0, 0)
        grid.addWidget(self.plot_didv, 0, 1)
        grid.addWidget(self.plot_transition, 1, 0)
        grid.addWidget(self.plot_te, 1, 1)
        grid.addWidget(self.plot_exp, 2, 0)
        grid.addWidget(self.results_table, 2, 1)

        self.reset_guesses()

    def reset_guesses(self):
        self.Vsmooth = self.V.copy()
        self.Ismooth = moving_average(self.I, self.smooth_spin.value())
        d = np.gradient(self.Ismooth, self.V)
        ds = moving_average(d, self.smooth_spin.value())
        idx = int(np.nanargmax(ds))
        self.Vp = float(self.V[idx])
        self.vp_spin.blockSignals(True)
        self.va_spin.blockSignals(True)
        self.vp_spin.setValue(self.Vp)
        self.va_spin.setValue(self.Vp)
        self.vp_spin.blockSignals(False)
        self.va_spin.blockSignals(False)
        self.recalculate_all()

    def recalculate_all(self):
        try:
            self.Vsmooth = self.V.copy()
            self.Ismooth = moving_average(self.I, self.smooth_spin.value())
            self.J = self.Ismooth / self.probe_area
            self.dIdV = np.gradient(self.Ismooth, self.Vsmooth)
            self.dIdVsmooth = moving_average(self.dIdV, self.smooth_spin.value())
            self.Vp = float(self.vp_spin.value())
            self.fit_result = None
            self._transition_linear_estimate()
            self._te_log_estimate()
            self._update_table()
            self._draw_all()
        except Exception as exc:
            QMessageBox.warning(self, "EPFL two-fluid calculation failed", str(exc))

    def run_nonlinear_fit(self):
        try:
            self.run_fit_btn.setEnabled(False)
            self.run_fit_btn.setText("Fitting...")
            QApplication.processEvents()
            self._exponential_fit()
            self._update_table()
            self._draw_all()
        except Exception as exc:
            QMessageBox.warning(self, "EPFL nonlinear fit failed", str(exc))
        finally:
            self.run_fit_btn.setText("Run EPFL nonlinear fit")
            self.run_fit_btn.setEnabled(True)

    def _transition_linear_estimate(self):
        idx = int(np.argmin(np.abs(self.Vsmooth - self.Vp)))
        half = int(self.transition_points_spin.value())
        lo = max(0, idx - half)
        hi = min(len(self.Vsmooth), idx + half + 1)
        if hi - lo < 3:
            raise RuntimeError("Transition fit window is too small.")
        Vfit = self.Vsmooth[lo:hi]
        Jfit = self.J[lo:hi]
        kp, offp = np.polyfit(Vfit, Jfit, 1)
        Jap = float(np.interp(self.Vp, self.Vsmooth, self.J))
        if kp == 0:
            raise RuntimeError("Transition slope is zero; cannot estimate Te.")
        self.Te_eV = float(Jap / kp)
        if self.Te_eV <= 0:
            self.Te_eV = abs(self.Te_eV)
        self.ne_m3 = float(np.exp(0.5) * Jap / E_CHARGE / np.sqrt(E_CHARGE * self.Te_eV / M_E))
        self._trans_line = (Vfit, kp * Vfit + offp)

    def _te_log_estimate(self):
        positive = np.where(self.J > 0)[0]
        if len(positive) == 0:
            raise RuntimeError("No positive current-density region for Te log fit.")
        p0 = int(positive[0])
        upper_v = float(self.va_spin.value())
        p1 = int(np.argmin(np.abs(self.Vsmooth - upper_v)))
        if p1 <= p0 + 2:
            p1 = min(len(self.Vsmooth) - 1, p0 + 10)
        self.EfVa = self.Vsmooth[p0:p1 + 1]
        self.EfJa = self.J[p0:p1 + 1]
        self.Vf = float(self.Vsmooth[p0])

        offJ = abs(float(np.nanmin(self.J)) * self.offset_spin.value())
        y = np.log(self.EfJa + offJ)
        valid = np.isfinite(self.EfVa) & np.isfinite(y)
        if valid.sum() >= 3:
            slope, intercept = np.polyfit(self.EfVa[valid], y[valid], 1)
            if slope > 0:
                self.Te_eV = float(1.0 / slope)
            self._te_line = (self.EfVa[valid], slope * self.EfVa[valid] + intercept, y[valid])
        else:
            self._te_line = None

    def _exponential_fit(self):
        if self.EfVa is None or self.EfJa is None:
            return
        valid = np.isfinite(self.EfVa) & np.isfinite(self.EfJa) & (self.EfJa > 0)
        if valid.sum() < 5:
            raise RuntimeError("Not enough positive current-density points for EPFL nonlinear fit.")

        vf = self.EfVa[valid]
        jf = self.EfJa[valid]
        if len(vf) > 300:
            take = np.linspace(0, len(vf) - 1, 300).astype(int)
            vf = vf[take]
            jf = jf[take]

        self.fit_result = fit_epfl_two_fluid(
            vf,
            jf,
            self.fit_mode_box.currentText(),
            ne0=max(abs(self.ne_m3), 1e12),
            Te0=max(abs(self.Te_eV), 0.05),
            Vp0=self.Vp,
            Vf0=self.Vf,
        )
        self.ne_m3 = self.fit_result["ne_m3"]
        self.Te_eV = self.fit_result["Te_eV"]
        self.Vp = self.fit_result["Vp"]
        self.Vf = self.fit_result["Vf"]

    def _update_table(self):
        for col, val in enumerate([self.Vp, self.Vf, self.Te_eV, self.ne_m3]):
            self.results_table.setItem(0, col, QTableWidgetItem(f"{val:.6g}" if np.isfinite(val) else "NaN"))

    def _clear_drag_lines(self):
        for line in self._drag_lines:
            try:
                line.disconnect()
            except Exception:
                pass
        self._drag_lines = []

    def _draw_all(self):
        self._clear_drag_lines()

        ax = self.plot_iv.ax
        ax.clear()
        ax.plot(self.V, self.I, label="rebinned raw")
        ax.plot(self.Vsmooth, self.Ismooth, label="smoothed")
        ax.axvline(self.Vp, linestyle="--", label="Vp")
        ax.axvline(self.Vf, linestyle=":", label="Vf")
        ax.set_title("I-V curve")
        ax.set_xlabel("V (V)")
        ax.set_ylabel("I (A)")
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
        self.plot_iv.redraw()

        ax = self.plot_didv.ax
        ax.clear()
        ax.plot(self.Vsmooth, self.dIdV, label="dI/dV")
        ax.plot(self.Vsmooth, self.dIdVsmooth, label="smoothed dI/dV")
        ax.axvline(self.Vp, linestyle="--", label="Vp")
        ax.set_title("dI/dV and Vp")
        ax.set_xlabel("V (V)")
        ax.set_ylabel("dI/dV (A/V)")
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
        self.plot_didv.redraw()
        self._drag_lines.append(DraggableVLine(self.plot_didv.canvas, ax, self.vp_spin, self.recalculate_all, linestyle="--", linewidth=2))

        ax = self.plot_transition.ax
        ax.clear()
        ax.plot(self.Vsmooth, self.J, label="J")
        if hasattr(self, "_trans_line"):
            ax.plot(self._trans_line[0], self._trans_line[1], label="linear transition fit")
        ax.axvline(self.Vp, linestyle="--", label="Vp")
        ax.set_title("Transition-region linear estimate")
        ax.set_xlabel("V (V)")
        ax.set_ylabel("J (A/m²)")
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
        self.plot_transition.redraw()

        ax = self.plot_te.ax
        ax.clear()
        if self._te_line is not None:
            ax.plot(self._te_line[0], self._te_line[2], label="log(J + offset)")
            ax.plot(self._te_line[0], self._te_line[1], label="Te log fit")
        ax.axvline(self.va_spin.value(), linestyle="--", label="Va")
        ax.set_title("Exponential-growth Te fit")
        ax.set_xlabel("V (V)")
        ax.set_ylabel("log(J + offset)")
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
        self.plot_te.redraw()
        self._drag_lines.append(DraggableVLine(self.plot_te.canvas, ax, self.va_spin, self.recalculate_all, linestyle="--", linewidth=2))

        ax = self.plot_exp.ax
        ax.clear()
        ax.plot(self.EfVa, self.EfJa, label="J measured")
        if self.fit_result is not None:
            ax.plot(self.fit_result["V_fit"], self.fit_result["J_fit"], label="EPFL TF fit")
        else:
            ax.text(0.05, 0.9, "Click 'Run EPFL nonlinear fit'", transform=ax.transAxes)
        ax.set_title("EPFL two-fluid exponential fit")
        ax.set_xlabel("V (V)")
        ax.set_ylabel("J (A/m²)")
        ax.grid(True, alpha=0.3)
        ax.legend(fontsize=8)
        self.plot_exp.redraw()

    def send_results_and_close(self):
        results = {
            "method": "EPFL two-fluid",
            "Vp": self.Vp,
            "Vf": self.Vf,
            "Te_eV": self.Te_eV,
            "ne_m3": self.ne_m3,
            "fit_mode": self.fit_mode_box.currentText(),
        }
        self.results_ready.emit(results)
        self.accept()


# -----------------------------------------------------------------------------
# Main app
# -----------------------------------------------------------------------------

class LDAApp(QMainWindow):
    def __init__(self):
        super().__init__()

        self.setWindowTitle("Langmuir Probe IV Analyser UB")
        self.resize(1200, 750)

        self.scans = None
        self.file_path = None
        self.manual_dialog = None
        self.last_oml_results = None

        central = QWidget()
        self.setCentralWidget(central)

        main_layout = QHBoxLayout(central)

        controls = QVBoxLayout()
        main_layout.addLayout(controls, 0)

        plot_layout = QVBoxLayout()
        main_layout.addLayout(plot_layout, 1)

        # File
        self.open_button = QPushButton("Open .lda file")
        self.open_button.clicked.connect(self.open_file)
        controls.addWidget(self.open_button)

        self.file_label = QLabel("No file loaded")
        self.file_label.setWordWrap(True)
        controls.addWidget(self.file_label)

        # Plot controls
        plot_box = QGroupBox("Plot")
        plot_form = QFormLayout(plot_box)

        self.xaxis_box = QComboBox()
        self.xaxis_box.addItems(["VData", "RefData"])
        self.xaxis_box.currentTextChanged.connect(self.plot_data)
        plot_form.addRow("X axis:", self.xaxis_box)

        self.show_all = QCheckBox("Show all scans")
        self.show_all.setChecked(True)
        self.show_all.stateChanged.connect(self.plot_data)
        plot_form.addRow(self.show_all)

        self.show_mean = QCheckBox("Show mean ± std")
        self.show_mean.setChecked(True)
        self.show_mean.stateChanged.connect(self.plot_data)
        plot_form.addRow(self.show_mean)

        controls.addWidget(plot_box)

        # Probe settings
        probe_box = QGroupBox("Probe / OML settings")
        probe_form = QFormLayout(probe_box)

        self.diameter = QDoubleSpinBox()
        self.diameter.setRange(0.001, 100)
        self.diameter.setValue(0.15)
        self.diameter.setSuffix(" mm")
        probe_form.addRow("Diameter:", self.diameter)

        self.length = QDoubleSpinBox()
        self.length.setRange(0.001, 1000)
        self.length.setValue(10.0)
        self.length.setSuffix(" mm")
        probe_form.addRow("Length:", self.length)

        self.ion_fraction = QDoubleSpinBox()
        self.ion_fraction.setRange(0.01, 0.5)
        self.ion_fraction.setSingleStep(0.01)
        self.ion_fraction.setValue(0.2)
        probe_form.addRow("Ion fit fraction:", self.ion_fraction)

        self.smooth_window = QSpinBox()
        self.smooth_window.setRange(1, 501)
        self.smooth_window.setSingleStep(1)
        self.smooth_window.setValue(21)
        probe_form.addRow("Smoothing window:", self.smooth_window)

        controls.addWidget(probe_box)

        self.analyse_button = QPushButton("Analyse averaged I-V")
        self.analyse_button.clicked.connect(self.run_analysis)
        controls.addWidget(self.analyse_button)

        self.manual_button = QPushButton("Manual OML analysis")
        self.manual_button.clicked.connect(self.open_manual_oml)
        controls.addWidget(self.manual_button)

        self.eepf_button = QPushButton("Calculate EEPF / EEDF")
        self.eepf_button.clicked.connect(self.open_eepf_dialog)
        controls.addWidget(self.eepf_button)

        self.epfl_tf_button = QPushButton("EPFL two-fluid model")
        self.epfl_tf_button.clicked.connect(self.open_epfl_two_fluid)
        controls.addWidget(self.epfl_tf_button)

        self.last_eepf_data = None

        self.export_button = QPushButton("Export mean CSV")
        self.export_button.clicked.connect(self.export_mean_csv)
        controls.addWidget(self.export_button)

        self.export_all_button = QPushButton("Export all analysis CSV")
        self.export_all_button.clicked.connect(self.export_all_analysis_csv)
        controls.addWidget(self.export_all_button)

        self.btn_check_updates = QPushButton("Check for updates")
        controls.addWidget(self.btn_check_updates)
        self.btn_about = QPushButton("About")
        controls.addWidget(self.btn_about)
        self.btn_check_updates.clicked.connect(lambda: self.check_for_updates(silent=False))
        self.btn_about.clicked.connect(self.show_about)

        controls.addStretch()

        # Output text
        self.output = QTextEdit()
        self.output.setReadOnly(True)
        self.output.setMinimumWidth(340)
        controls.addWidget(self.output)

        # Matplotlib figure
        self.fig = Figure(figsize=(7, 5))
        self.canvas = FigureCanvasQTAgg(self.fig)
        self.ax = self.fig.add_subplot(111)

        self.toolbar = NavigationToolbar2QT(self.canvas, self)

        plot_layout.addWidget(self.toolbar)
        plot_layout.addWidget(self.canvas)

        QTimer.singleShot(1200, lambda: self.check_for_updates(silent=True))



    def log(self, text):
        self.output.append(text)

    def open_file(self):
        path, _ = QFileDialog.getOpenFileName(
            self,
            "Open LDA file",
            "",
            "LDA files (*.lda);;All files (*)"
        )

        if not path:
            return

        try:
            self.scans = load_lda(path)
            self.file_path = path
            self.file_label.setText(path)

            self.log(f"Loaded: {path}")
            self.log(f"Number of scans: {len(self.scans)}")
            self.log(f"Points per scan: {len(self.scans[0]['IData'])}")

            self.plot_data()

        except Exception as e:
            QMessageBox.critical(self, "Error loading file", str(e))

    def plot_data(self):
        if self.scans is None:
            return

        xkey = self.xaxis_box.currentText()
        x, imean, istd, iall = average_scans(self.scans, xkey)

        self.ax.clear()

        if self.show_all.isChecked():
            for k, s in enumerate(self.scans):
                self.ax.plot(x, iall[k], linewidth=1, label=f"scan {s['id']}")

        if self.show_mean.isChecked():
            self.ax.plot(x, imean, linewidth=2.5, label="mean")
            self.ax.fill_between(x, imean - istd, imean + istd, alpha=0.25, label="±1σ")

        self.ax.set_xlabel(xkey)
        self.ax.set_ylabel("Current (A)")
        self.ax.set_title("Langmuir probe I-V curves")
        self.ax.legend(fontsize=8)
        self.ax.grid(True, alpha=0.3)

        self.fig.tight_layout()
        self.canvas.draw()

    def probe_area(self):
        d = self.diameter.value() * 1e-3
        L = self.length.value() * 1e-3

        # Cylindrical probe side area: A = pi d L
        return np.pi * d * L

    def get_mean_curve(self):
        if self.scans is None:
            raise RuntimeError("Please load a .lda file first.")
        xkey = self.xaxis_box.currentText()
        x, imean, _, _ = average_scans(self.scans, xkey)
        return xkey, x, imean

    def run_analysis(self):
        if self.scans is None:
            QMessageBox.warning(self, "No data", "Please load a .lda file first.")
            return

        try:
            xkey, x, imean = self.get_mean_curve()
            area = self.probe_area()

            results = analyse_oml(
                x,
                imean,
                probe_area=area,
                ion_fraction=self.ion_fraction.value(),
                smooth_window=self.smooth_window.value()
            )

            self.log("")
            self.log("===== Automatic OML-style analysis on averaged I-V =====")
            self.log(f"X axis used: {xkey}")
            self.log(f"Probe area: {area:.4e} m²")
            self.log(f"Floating potential Vf: {results['Vf']:.5g}")
            self.log(f"Plasma potential Vp:   {results['Vp']:.5g}")
            self.log(f"Electron temperature Te: {results['Te_eV']:.5g} eV")
            self.log(f"Electron saturation current Ies: {results['Ies_A']:.5e} A")
            self.log(f"Electron density ne: {results['ne_m3']:.5e} m⁻³")
            self.last_oml_results = results
            self.log(f"Ion-current square fit: Iion² = {results['ion_i2_a']:.4e} V + {results['ion_i2_b']:.4e}")
            self.log("Note: automatic OML fit is a first-pass estimate; use manual mode to check fit regions.")

        except Exception as e:
            QMessageBox.critical(self, "Analysis failed", str(e))

    def open_manual_oml(self):
        if self.scans is None:
            QMessageBox.warning(self, "No data", "Please load a .lda file first.")
            return

        try:
            xkey, x, imean = self.get_mean_curve()
            area = self.probe_area()
            self.manual_dialog = ManualOMLDialog(
                self,
                x,
                imean,
                probe_area=area,
                cycle_label=f"Manual OML on averaged I-V ({xkey})",
            )
            self.manual_dialog.results_ready.connect(self.receive_manual_results)
            self.manual_dialog.exec()
        except Exception as e:
            QMessageBox.critical(self, "Manual analysis failed", str(e))

    def receive_manual_results(self, results):
        self.log("")
        self.log("===== Manual OML analysis on averaged I-V =====")
        self.log(f"Floating potential Vf: {results['Vf']:.5g}")
        self.log(f"Vp from dI/dV: {results['Vp_dIdV']:.5g}")
        self.log(f"Vp from log-fit intersection: {results['Vp_intersection']:.5g}")
        self.log(f"Final plasma potential Vp: {results['Vp']:.5g}")
        self.log(f"Electron temperature Te: {results['Te_eV']:.5g} eV")
        self.log(f"Ion saturation current Iis: {results['Iis_A']:.5e} A")
        self.log(f"Electron saturation current Ies: {results['Ies_A']:.5e} A")
        self.log(f"Electron density ne: {results['ne_m3']:.5e} m⁻³")
        self.log(f"Ion-current square fit: Iion² = {results['ion_i2_a']:.4e} V + {results['ion_i2_b']:.4e}")
        self.last_oml_results = results

    def open_eepf_dialog(self):
        if self.scans is None:
            QMessageBox.warning(self, "No data", "Please load a .lda file first.")
            return
        if self.last_oml_results is None:
            QMessageBox.warning(self, "No OML results", "Run automatic or manual OML analysis first.")
            return
        try:
            xkey, x, imean = self.get_mean_curve()
            dialog = EEPFDialog(
                self,
                x,
                imean,
                self.probe_area(),
                self.last_oml_results,
                title=f"EEPF / EEDF from {xkey} curve",
            )
            dialog.exec()
            self.last_eepf_data = dialog.current_data
        except Exception as e:
            QMessageBox.critical(self, "EEPF/EEDF failed", str(e))

    def open_epfl_two_fluid(self):
        if self.scans is None:
            QMessageBox.warning(self, "No data", "Please load a .lda file first.")
            return
        try:
            xkey, x, imean = self.get_mean_curve()
            dialog = EPFLTwoFluidDialog(
                self,
                x,
                imean,
                self.probe_area(),
                title=f"EPFL two-fluid model from {xkey} curve",
            )
            dialog.results_ready.connect(self.receive_epfl_tf_results)
            dialog.exec()
        except Exception as e:
            QMessageBox.critical(self, "EPFL two-fluid model failed", str(e))

    def receive_epfl_tf_results(self, results):
        self.log("")
        self.log("===== EPFL two-fluid model analysis =====")
        self.log(f"Fit mode: {results['fit_mode']}")
        self.log(f"Floating potential Vf: {results['Vf']:.5g}")
        self.log(f"Plasma potential Vp: {results['Vp']:.5g}")
        self.log(f"Electron temperature Te: {results['Te_eV']:.5g} eV")
        self.log(f"Electron density ne: {results['ne_m3']:.5e} m⁻³")
        self.last_oml_results = results

    def export_mean_csv(self):
        if self.scans is None:
            QMessageBox.warning(self, "No data", "Please load a .lda file first.")
            return

        path, _ = QFileDialog.getSaveFileName(
            self,
            "Save mean I-V",
            "mean_iv.csv",
            "CSV files (*.csv)"
        )

        if not path:
            return

        xkey = self.xaxis_box.currentText()
        x, imean, istd, _ = average_scans(self.scans, xkey)

        data = np.column_stack([x, imean, istd])
        header = f"{xkey},I_mean_A,I_std_A"

        np.savetxt(path, data, delimiter=",", header=header, comments="")
        self.log(f"Saved mean curve: {path}")

    def export_all_analysis_csv(self):
        if self.scans is None:
            QMessageBox.warning(self, "No data", "Please load a .lda file first.")
            return

        path, _ = QFileDialog.getSaveFileName(
            self,
            "Save all analysis data",
            "langmuir_full_analysis.csv",
            "CSV files (*.csv)"
        )

        if not path:
            return

        try:
            xkey, x, imean = self.get_mean_curve()
            _, _, istd, iall = average_scans(self.scans, xkey)

            if self.last_eepf_data is None and self.last_oml_results is not None:
                self.last_eepf_data = compute_eepf_from_oml(
                    x,
                    imean,
                    self.probe_area(),
                    self.last_oml_results,
                    smooth_window=self.smooth_window.value(),
                    distribution_smooth_window=9,
                )

            with open(path, "w", newline="") as f:
                writer = csv.writer(f)

                writer.writerow(["Langmuir probe full export"])
                writer.writerow(["x axis", xkey])
                writer.writerow(["probe area m2", self.probe_area()])
                writer.writerow([])

                writer.writerow(["Analysis results"])
                if self.last_oml_results is not None:
                    for key, value in self.last_oml_results.items():
                        if np.isscalar(value):
                            writer.writerow([key, value])
                else:
                    writer.writerow(["No OML / EPFL analysis results available"])
                writer.writerow([])

                writer.writerow(["IV curve"])
                header = [xkey, "I_mean_A", "I_std_A"]
                for k, s in enumerate(self.scans):
                    header.append(f"scan_{s['id']}_I_A")
                writer.writerow(header)

                for n in range(len(x)):
                    row = [x[n], imean[n], istd[n]]
                    for k in range(iall.shape[0]):
                        row.append(iall[k, n])
                    writer.writerow(row)

                writer.writerow([])

                if self.last_eepf_data is not None:
                    writer.writerow(["EEDF / EEPF"])
                    writer.writerow([
                        "E_eV",
                        "EEDF_raw",
                        "EEDF_smooth",
                        "EEPF_raw",
                        "EEPF_smooth",
                    ])

                    e = self.last_eepf_data["E_eV"]
                    for n in range(len(e)):
                        writer.writerow([
                            e[n],
                            self.last_eepf_data["EEDF"][n],
                            self.last_eepf_data["EEDF_smooth"][n],
                            self.last_eepf_data["EEPF"][n],
                            self.last_eepf_data["EEPF_smooth"][n],
                        ])
                else:
                    writer.writerow(["EEDF / EEPF"])
                    writer.writerow(["No EEDF / EEPF data available. Run OML then EEPF first."])

            self.log(f"Saved full analysis CSV: {path}")

        except Exception as e:
            QMessageBox.critical(self, "Export failed", str(e))


    def check_for_updates(self, silent: bool = False):
        if not GITHUB_OWNER or not GITHUB_REPO or GITHUB_OWNER == "your-github-name" or GITHUB_REPO == "your-repo-name":
            if not silent:
                QMessageBox.information(
                    self,
                    "Updates not configured",
                    "Please set GITHUB_OWNER and GITHUB_REPO in the code first."
                )
            return

        try:
            release = get_latest_github_release(GITHUB_OWNER, GITHUB_REPO)
        except HTTPError as e:
            if not silent:
                QMessageBox.warning(self, "Update check failed", f"GitHub returned an error:\nHTTP {e.code} - {e.reason}")
            return
        except URLError as e:
            if not silent:
                QMessageBox.warning(self, "Update check failed", f"Could not reach GitHub:\n{e}")
            return
        except Exception as e:
            if not silent:
                QMessageBox.warning(self, "Update check failed", f"Unexpected error:\n{e}")
            return

        latest_tag = str(release.get("tag_name", "")).strip()
        release_name = str(release.get("name", "")).strip()
        release_page = str(release.get("html_url", "")).strip()
        release_notes = str(release.get("body", "")).strip()

        if not latest_tag:
            if not silent:
                QMessageBox.information(self, "Updates", "No valid release tag found on GitHub.")
            return

        if not is_newer_version(latest_tag, APP_VERSION):
            if not silent:
                QMessageBox.information(self, "No update available", f"You already have the latest version ({APP_VERSION}).")
            return

        latest_version = normalize_version(latest_tag)
        asset_url = choose_best_asset(release)

        msg = QMessageBox(self)
        msg.setWindowTitle("Update available")
        msg.setIcon(QMessageBox.Information)
        msg.setText(
            f"A newer version is available.\n\n"
            f"Current version: {APP_VERSION}\n"
            f"Latest version: {latest_version}"
        )

        if release_name:
            msg.setInformativeText(release_name)

        if release_notes:
            notes = release_notes[:3000]
            if len(release_notes) > 3000:
                notes += "\n\n[Release notes truncated]"
            msg.setDetailedText(notes)

        btn_download = None
        if asset_url:
            btn_download = msg.addButton("Download update", QMessageBox.AcceptRole)

        btn_release = None
        if release_page:
            btn_release = msg.addButton("Open release page", QMessageBox.ActionRole)

        msg.addButton(QMessageBox.Cancel)
        msg.exec()

        clicked = msg.clickedButton()
        if btn_download is not None and clicked == btn_download:
            webbrowser.open(asset_url)
        elif btn_release is not None and clicked == btn_release:
            webbrowser.open(release_page)

    def show_about(self):
        name = "Langmuir Probe IV Analyser UB by P. Hiret"
        company = "Universität Basel"
        email = "paul.hiret@unibas.ch"
        version = APP_VERSION

        text = (
            f"<b>{name}</b> <span style='color:gray'>(v{version})</span><br>"
            f"{company}<br>"
            f"<a href='mailto:{email}'>{email}</a>"
        )

        box = QMessageBox(self)
        box.setWindowTitle("About")
        box.setTextFormat(Qt.RichText)
        box.setText(text)
        box.setStandardButtons(QMessageBox.Ok)
        box.exec()

if __name__ == "__main__":

    app = QApplication(sys.argv)

    # -------------------------------------------------
    # Application icon
    # -------------------------------------------------

    from PySide6.QtGui import QPixmap, QIcon
    from PySide6.QtWidgets import QSplashScreen, QProgressBar, QLabel
    from PySide6.QtCore import Qt, QTimer

    app.setWindowIcon(QIcon("icon.ico"))

    # -------------------------------------------------
    # Splash screen
    # -------------------------------------------------

    pixmap = QPixmap("splash.png")

    splash = QSplashScreen(
        pixmap,
        Qt.WindowStaysOnTopHint | Qt.FramelessWindowHint
    )

    splash.setAttribute(Qt.WA_TranslucentBackground)

    # -------------------------------------------------
    # Progress bar
    # -------------------------------------------------

    progress = QProgressBar(splash)

    progress.setGeometry(
        70,
        pixmap.height() - 120,
        pixmap.width() - 140,
        20
    )

    progress.setRange(0, 100)

    progress.setStyleSheet("""
    QProgressBar {
        background-color: rgba(255,255,255,40);
        border-radius: 10px;
        text-align: center;
        color: white;
        font-size: 10px;
        border: none;
    }

    QProgressBar::chunk {
        border-radius: 10px;
        background-color: #2F80FF;
    }
    """)

    # -------------------------------------------------
    # Loading text
    # -------------------------------------------------

    label = QLabel("Initializing...", splash)

    label.setGeometry(
        70,
        pixmap.height() - 155,
        400,
        30
    )

    label.setStyleSheet("""
    color: black;
    font-size: 13px;
    font-weight: 500;
    background: transparent;
    """)

    # -------------------------------------------------
    # Loading animation
    # -------------------------------------------------

    messages = [
        "Loading UI...",
        "Loading plotting engine...",
        "Loading OML analysis...",
        "Loading EEDF / EEPF tools...",
        "Loading EPFL two-fluid model...",
        "Starting application..."
    ]

    value = 0

    # -------------------------------------------------
    # Version text
    # -------------------------------------------------

    lversion = QLabel("Version 0.9a © 2026 by Paul Hiret from University of Basel is licensed under Creative Commons Attribution-NonCommercial 4.0 International", splash)

    lversion.setGeometry(
        70,
        pixmap.height() - 55,
        400,
        30
    )

    lversion.setStyleSheet("""
        color: gray;
        font-size: 13px;
        font-weight: 500;
        background: transparent;
        """)

    splash.show()

    def update_progress():
        global value

        value += 2

        progress.setValue(value)

        idx = min(value // 20, len(messages) - 1)
        label.setText(messages[idx])

        if value >= 100:

            timer.stop()

            win = LDAApp()
            win.show()

            splash.finish(win)


    timer = QTimer()
    timer.timeout.connect(update_progress)
    timer.start(40)

    sys.exit(app.exec())


# pyinstaller --onefile --windowed --name Langmuir_Probe_IV_Analyser_UB --icon=icon.ico --add-data "splash.png;." --add-data "icon.ico;." main.py