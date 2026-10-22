# Python desktop app (archived)

This is the original Python/PySide6 version of the Langmuir Probe IV Analyser UB (v0.9a / installer 1.1.2).

**It is no longer maintained.** Use the browser version in [`web/`](../../web/). The browser version also corrects several issues that remain in this code (see the main README), so results from the two versions differ.

## Running

```bash
pip install numpy matplotlib PySide6 scipy
python main.py
```

## Building the Windows executable

Run these commands from this folder:

```bash
pyinstaller --onefile --windowed --name Langmuir_Probe_IV_Analyser_UB --icon=icon.ico --add-data "splash.png;." --add-data "icon.ico;." main.py
```

or `pyinstaller Langmuir_Probe_IV_Analyser_UB.spec`. Then build the installer with Inno Setup from `LangmuirProbeIVAnalyserUB.iss`.
