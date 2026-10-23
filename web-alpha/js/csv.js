/* =============================================================================
   CSV / text import: delimiter + decimal sniffing, numeric block detection and
   a column-mapping window that turns columns into scans.
   ============================================================================= */
(function (IV) {
  "use strict";
  const { el } = IV.ui;

  const DELIMS = [
    { name: "tab", re: /\t/, label: "tab" },
    { name: ";", re: /;/, label: "semicolon" },
    { name: ",", re: /,/, label: "comma" },
    { name: "space", re: /\s+/, label: "whitespace" },
  ];

  const UNITS = { "A": 1, "mA": 1e-3, "µA": 1e-6, "nA": 1e-9 };

  function splitLine(line, delim) {
    const t = delim.name === "space" ? line.trim() : line;
    if (delim.name !== ",") return t.split(delim.re).map((c) => c.trim().replace(/^"(.*)"$/, "$1"));
    // comma: respect simple double-quoted cells
    const out = [];
    let cur = "", quoted = false;
    for (const ch of t) {
      if (ch === '"') quoted = !quoted;
      else if (ch === "," && !quoted) { out.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    out.push(cur.trim());
    return out;
  }

  function toNumber(cell, decimalComma) {
    if (cell === undefined) return NaN;
    let s = cell.trim();
    if (!s) return NaN;
    if (/^[-+]?(nan|inf(inity)?)$/i.test(s)) return /nan/i.test(s) ? NaN : (s.startsWith("-") ? -Infinity : Infinity);
    if (decimalComma) s = s.replace(",", ".");
    if (!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s)) return null;  // not a number at all
    return Number(s);
  }

  /**
   * Parse delimited text. Finds the longest run of numeric rows (so files
   * with a metadata preamble, or this app's own multi-section export, work)
   * and uses the row right above it as header when it is not numeric.
   */
  function parseTable(text) {
    const lines = text.replace(/^﻿/, "").split(/\r?\n/);
    const content = lines.filter((l) => l.trim() && !/^\s*[#%]/.test(l));
    if (!content.length) throw new Error("The file is empty.");

    // delimiter: the one giving the most rows with the same (>= 2) column count
    const sample = content.slice(0, 400);
    let best = null;
    for (const d of DELIMS) {
      const counts = new Map();
      for (const l of sample) {
        const n = splitLine(l, d).length;
        if (n >= 2) counts.set(n, (counts.get(n) || 0) + 1);
      }
      const top = Math.max(0, ...counts.values());
      if (!best || top > best.top) best = { d, top };
    }
    if (!best || best.top === 0) throw new Error("Could not find at least two columns in this file.");
    const delim = best.d;

    const rows = lines.map((l) => (l.trim() && !/^\s*[#%]/.test(l) ? splitLine(l, delim) : null));

    // decimal comma (e.g. "1,25;3,5"): only possible when comma is not the separator
    let decimalComma = false;
    if (delim.name !== ",") {
      let commaNums = 0, dotNums = 0;
      for (const r of rows.slice(0, 400)) {
        if (!r) continue;
        for (const c of r) {
          if (/^[-+]?\d+,\d+([eE][-+]?\d+)?$/.test(c)) commaNums++;
          if (/^[-+]?\d*\.\d+([eE][-+]?\d+)?$/.test(c)) dotNums++;
        }
      }
      decimalComma = commaNums > dotNums;
    }

    const isNumeric = (r) => {
      if (!r || r.length < 2) return false;
      let num = 0;
      for (const c of r) { const v = toNumber(c, decimalComma); if (v !== null && !Number.isNaN(v)) num++; }
      return num >= 2 && num >= r.length / 2;
    };

    // every run of numeric rows (blank lines break a run; comments are skipped)
    const runs = [];
    let runStart = -1;
    for (let k = 0; k <= rows.length; k++) {
      const ok = k < rows.length && isNumeric(rows[k]);
      const skip = k < rows.length && rows[k] === null && /^\s*[#%]/.test(lines[k]);
      if (ok) { if (runStart < 0) runStart = k; continue; }
      if (skip && runStart >= 0) continue;
      if (runStart >= 0) {
        const len = rows.slice(runStart, k).filter(Boolean).length;
        if (len >= 3) runs.push({ start: runStart, end: k, len });
        runStart = -1;
      }
    }
    if (!runs.length) throw new Error("No block of numeric data (at least 3 rows) was found.");

    const blocks = runs.map((run) => {
      const dataRows = rows.slice(run.start, run.end).filter(Boolean);
      const ncol = Math.max(...dataRows.map((r) => r.length));
      let header = null;
      for (let k = run.start - 1; k >= 0; k--) {
        if (rows[k] === null) { if (lines[k].trim()) continue; break; }
        if (!isNumeric(rows[k]) && rows[k].length >= 2) header = rows[k];
        break;
      }
      const names = Array.from({ length: ncol }, (_, j) => (header && header[j] ? header[j] : `Column ${j + 1}`));
      const columns = names.map((_, j) => Float64Array.from(dataRows, (r) => {
        const v = toNumber(r[j], decimalComma);
        return v === null ? NaN : v;
      }));
      return { names, columns, nrows: dataRows.length, hasHeader: !!header, preview: dataRows.slice(0, 6), firstLine: run.start + 1 };
    });

    // default: a block with a voltage-like header, else the longest one
    const score = (b) => (b.names.some((h) => /vdata|refdata|volt|bias|potential/i.test(h)) ? 1e9 : 0) + b.nrows;
    let defaultBlock = 0;
    blocks.forEach((b, k) => { if (score(b) > score(blocks[defaultBlock])) defaultBlock = k; });

    return { delimiter: delim.label, decimalComma, blocks, defaultBlock };
  }

  // ---------------------------------------------------------------------------
  // Column guessing
  // ---------------------------------------------------------------------------

  function guessMapping(t) {
    const n = t.names;
    const pairs = n.length >= 4 && n.length % 2 === 0 && n.every((h, j) => (j % 2 ? /_y$/i.test(h) : /_x$/i.test(h)));
    if (pairs) return { layout: "pairs", x: 0, ref: -1, currents: [] };

    let x = n.findIndex((h) => /^(vdata|v|u|volt|voltage|bias|potential|vprobe|v_?bias)\b/i.test(h.trim()));
    if (x < 0) x = n.findIndex((h) => /volt|bias|potential|vdata/i.test(h));
    if (x < 0) x = 0;
    const ref = n.findIndex((h, j) => j !== x && /refdata|^ref/i.test(h));

    const others = n.map((_, j) => j).filter((j) => j !== x && j !== ref);
    const scanCols = others.filter((j) => /scan|idata|sweep/i.test(n[j]));
    let currents = scanCols.length ? scanCols : others.filter((j) => !/std|sigma|err|unc/i.test(n[j]));
    if (!currents.length) currents = others.slice(0, 1);
    return { layout: "shared", x, ref, currents };
  }

  function buildScans(t, m, unitScale) {
    const scans = [];
    const make = (id, xCol, iCol, refCol) => {
      const X = [], R = [], I = [];
      for (let k = 0; k < t.nrows; k++) {
        const xv = t.columns[xCol][k], iv = t.columns[iCol][k];
        const rv = refCol >= 0 ? t.columns[refCol][k] : xv;
        if (Number.isFinite(xv) && Number.isFinite(iv) && Number.isFinite(rv)) { X.push(xv); I.push(iv * unitScale); R.push(rv); }
      }
      if (X.length < 5) throw new Error(`“${t.names[iCol]}” has fewer than 5 valid points.`);
      return { id, VData: Float64Array.from(X), RefData: Float64Array.from(R), IData: Float64Array.from(I), label: t.names[iCol] };
    };
    if (m.layout === "pairs") {
      for (let j = 0; j + 1 < t.names.length; j += 2) scans.push(make(scans.length + 1, j, j + 1, -1));
    } else {
      if (!m.currents.length) throw new Error("Select at least one current column.");
      for (const j of m.currents) scans.push(make(scans.length + 1, m.x, j, m.ref));
    }
    return scans;
  }

  // ---------------------------------------------------------------------------
  // Import window
  // ---------------------------------------------------------------------------

  /**
   * Shows the mapping window; resolves to scans, or null when cancelled.
   * The chosen mapping is attached as scans.mapping so other files with the
   * same layout can be read with applyMapping() (batch import).
   */
  function importCSV(text, fileName) {
    const parsed = parseTable(text);
    let t = parsed.blocks[parsed.defaultBlock];
    let m = guessMapping(t);
    let unit = "A";

    return new Promise((resolve) => {
      let result = null;
      const d = IV.ui.openDialog({ title: `Import CSV — ${fileName}`, onClose: () => resolve(result) });
      d.dlg.classList.add("medium");

      const info = el("p.muted", { style: "margin:0;font-size:12px" });
      const describe = () => {
        info.textContent = `Detected ${parsed.delimiter}-separated values${parsed.decimalComma ? " with decimal commas" : ""} · `
          + `${t.nrows} data rows from line ${t.firstLine} · ${t.names.length} columns · `
          + (t.hasHeader ? "header row found" : "no header row");
      };

      const opt = (v, label) => el("option", { value: v, text: label });
      const blockSel = el("select", {}, parsed.blocks.map((b, k) =>
        opt(k, `Line ${b.firstLine}: ${b.nrows} rows — ${b.names.slice(0, 3).join(", ")}${b.names.length > 3 ? ", …" : ""}`)));
      blockSel.value = parsed.defaultBlock;
      const layoutSel = el("select", {}, [opt("shared", "One voltage column + current column(s)"), opt("pairs", "Voltage / current column pairs")]);
      layoutSel.value = m.layout;
      const xSel = el("select"), refSel = el("select");
      const unitSel = el("select", {}, Object.keys(UNITS).map((u) => opt(u, u)));
      const checks = el("div", { style: "display:flex;flex-wrap:wrap;gap:6px 14px" });
      let boxes = [];

      function loadBlock() {
        xSel.replaceChildren(...t.names.map((nm, j) => opt(j, nm)));
        xSel.value = m.x;
        refSel.replaceChildren(opt(-1, "(same as voltage)"), ...t.names.map((nm, j) => opt(j, nm)));
        refSel.value = m.ref;
        layoutSel.value = m.layout;
        checks.replaceChildren();
        boxes = t.names.map((nm, j) => {
          const cb = el("input", { type: "checkbox" });
          cb.checked = m.currents.includes(j);
          cb.addEventListener("change", refresh);
          checks.append(el("label.check", {}, [cb, nm]));
          return cb;
        });
        describe();
      }

      const sharedRows = el("div.form", { style: "grid-column:1/-1" }, [
        el("label", { text: "Voltage column (VData)" }), xSel,
        el("label", { text: "Reference column (RefData)" }), refSel,
        el("label", { text: "Current columns (one per scan)", style: "align-self:start;padding-top:2px" }), checks,
      ]);
      const pairsNote = el("p.muted", { style: "grid-column:1/-1;margin:0;font-size:12px",
        text: "Columns are read in pairs (1–2, 3–4, …): voltage then current, one scan per pair." });

      const form = el("div.form", {}, [
        ...(parsed.blocks.length > 1 ? [el("label", { text: "Data block" }), blockSel] : []),
        el("label", { text: "Layout" }), layoutSel,
        sharedRows, pairsNote,
        el("label", { text: "Current unit in file" }), unitSel,
      ]);

      const thead = el("thead"), tbody = el("tbody");
      const table = el("table.data", {}, [thead, tbody]);
      const plotEl = el("div", { style: "height:240px" });
      const msg = el("span.hint", { style: "color:var(--red)" });

      const left = el("div", { style: "display:flex;flex-direction:column;gap:12px;min-width:0" }, [info, form]);
      const right = el("div", { style: "display:flex;flex-direction:column;gap:10px;min-width:0" }, [
        el("div.plot-cell", {}, [plotEl]),
        el("div", { style: "overflow:auto;border:1px solid var(--border);border-radius:6px" }, [table]),
      ]);
      d.body.classList.add("pad");
      d.body.style.overflow = "auto";
      d.body.append(el("div.import-grid", {}, [left, right]));

      const plot = new IV.Plot(plotEl, { filename: "csv_preview" });
      d.plots.push(plot);

      const importBtn = el("button.btn.primary", { text: "Import", onclick: doImport });
      d.foot.append(msg, el("span", { style: "flex:1" }), el("button.btn", { text: "Cancel", onclick: d.close }), importBtn);

      for (const s of [layoutSel, xSel, refSel, unitSel]) s.addEventListener("change", refresh);
      blockSel.addEventListener("change", () => {
        t = parsed.blocks[Number(blockSel.value)];
        m = guessMapping(t);
        loadBlock();
        refresh();
      });

      function mapping() {
        return {
          layout: layoutSel.value,
          x: Number(xSel.value),
          ref: Number(refSel.value),
          currents: boxes.map((b, j) => (b.checked && j !== Number(xSel.value) ? j : -1)).filter((j) => j >= 0),
        };
      }

      function refresh() {
        const mm = mapping();
        unit = unitSel.value;
        sharedRows.classList.toggle("hidden", mm.layout !== "shared");
        pairsNote.classList.toggle("hidden", mm.layout !== "pairs");

        const role = (j) => {
          if (mm.layout === "pairs") return j % 2 ? "I" : "V";
          if (j === mm.x) return "V";
          if (j === mm.ref) return "Ref";
          return mm.currents.includes(j) ? "I" : "";
        };
        thead.replaceChildren(el("tr", {}, t.names.map((nm, j) => el("th", {}, [nm, role(j) ? el("span.badge", { style: "margin-left:6px", text: role(j) }) : null]))));
        tbody.replaceChildren(...t.preview.map((r) => el("tr", {}, t.names.map((_, j) => el("td", {
          text: r[j] ?? "", style: role(j) ? "" : "opacity:.45",
        })))));

        try {
          const scans = buildScans(t, mm, UNITS[unit]);
          msg.textContent = "";
          importBtn.disabled = false;
          plot.render({
            title: `${scans.length} scan${scans.length > 1 ? "s" : ""} · ${scans[0].VData.length} points`,
            xlabel: "Voltage (V)", ylabel: "Current (A)",
            traces: scans.map((s) => ({ x: s.VData, y: s.IData, name: s.label, width: 1.2 })),
          });
        } catch (e) {
          msg.textContent = e.message;
          importBtn.disabled = true;
          plot.render({ traces: [], text: "Nothing to preview" });
        }
      }

      function doImport() {
        try {
          const mm = mapping();
          result = buildScans(t, mm, UNITS[unit]);
          result.mapping = { ...mm, block: parsed.blocks.indexOf(t), names: t.names, unit };
          d.close();
        } catch (e) {
          msg.textContent = e.message;
        }
      }

      loadBlock();
      refresh();
    });
  }

  /** Reads a CSV with the mapping chosen for another file; throws if the layout differs. */
  function applyMapping(text, mapping) {
    const parsed = parseTable(text);
    const t = parsed.blocks[mapping.block] || parsed.blocks[parsed.defaultBlock];
    if (t.names.length !== mapping.names.length || t.names.some((n, j) => n !== mapping.names[j])) {
      throw new Error("The columns differ from the first CSV file.");
    }
    return buildScans(t, mapping, UNITS[mapping.unit]);
  }

  IV.csv = { parseTable, guessMapping, buildScans, importCSV, applyMapping };
})(window.IV = window.IV || {});
