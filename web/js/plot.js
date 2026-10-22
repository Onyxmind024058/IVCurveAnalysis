/* =============================================================================
   Plot wrapper: Plotly with the Basel theme, draggable vertical lines
   (replacement for DraggableVLine) and copy-image / copy-CSV buttons
   (replacement for the Matplotlib right-click menu).
   ============================================================================= */
(function (IV) {
  "use strict";

  const registry = new Set();
  const HIT_PX = 7;

  function themeTokens() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name) => cs.getPropertyValue(name).trim();
    return {
      panel: v("--panel"), text: v("--text"), textLo: v("--text-lo"),
      grid: v("--grid"), border: v("--border"), mint: v("--mint"), mintHover: v("--mint-hover"),
      band: v("--plot-band"), font: v("--font"),
      colorway: [1, 2, 3, 4, 5, 6].map((k) => v(`--plot-${k}`)),
    };
  }

  const ICON_CSV = {
    width: 24, height: 24,
    path: "M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 15h8M8 18h5",
  };
  const ICON_COPY = {
    width: 24, height: 24,
    path: "M8 8h11v13H8zM5 16V3h11",
  };

  class Plot {
    constructor(el, opts = {}) {
      this.el = el;
      this.el.classList.add("plot");
      this.opts = opts;
      this.spec = null;
      this.lines = [];         // draggable line descriptors currently drawn
      this.onDrag = null;      // (id, value, final) => void
      this._drag = null;
      registry.add(this);

      el.addEventListener("pointerdown", (e) => this._pointerDown(e), true);
      el.addEventListener("mousedown", (e) => { if (this._drag) e.stopPropagation(); }, true);
      el.addEventListener("touchstart", (e) => { if (this._drag) e.stopPropagation(); }, { capture: true, passive: true });
      el.addEventListener("pointermove", (e) => this._pointerMove(e));
      el.addEventListener("pointerup", (e) => this._pointerUp(e));
      el.addEventListener("pointercancel", (e) => this._pointerUp(e));
      el.addEventListener("pointerleave", () => { if (!this._drag) el.classList.remove("drag-hover"); });
    }

    destroy() {
      registry.delete(this);
      try { Plotly.purge(this.el); } catch (_) { /* already gone */ }
    }

    /**
     * spec = {
     *   traces: [{x, y, name, width, dash, fill: {lower, upper}, color, mode}],
     *   vlines: [{x, label, dash, drag: "id"}],
     *   title, xlabel, ylabel, logy, xrange, yrange, text
     * }
     */
    render(spec) {
      this.spec = spec;
      const t = themeTokens();
      const data = [];
      let colorIdx = 0;
      const nextColor = () => t.colorway[colorIdx++ % t.colorway.length];

      for (const tr of spec.traces || []) {
        const color = tr.color || nextColor();
        if (tr.band) {
          // ±σ band: lower edge invisible, upper edge filled to it
          data.push({ x: Array.from(tr.x), y: Array.from(tr.band.lower), mode: "lines", line: { width: 0 },
            hoverinfo: "skip", showlegend: false, type: "scatter" });
          data.push({ x: Array.from(tr.x), y: Array.from(tr.band.upper), mode: "lines", line: { width: 0 },
            fill: "tonexty", fillcolor: t.band, name: tr.name, hoverinfo: "skip", type: "scatter" });
          continue;
        }
        data.push({
          type: "scatter",
          x: Array.from(tr.x), y: Array.from(tr.y),
          mode: tr.mode || "lines",
          name: tr.name,
          showlegend: tr.name !== undefined && !tr.hideLegend,
          line: { color, width: tr.width || 1.6, dash: tr.dash || "solid" },
          marker: { color, size: 4 },
          hovertemplate: `${tr.name || ""}<br>x=%{x:.4g}<br>y=%{y:.4g}<extra></extra>`,
        });
      }

      this.lines = [];
      const shapes = (spec.vlines || []).filter((l) => Number.isFinite(l.x)).map((l, k) => {
        if (l.drag) this.lines.push({ id: l.drag, index: k, x: l.x });
        const color = l.color || (l.drag ? t.mintHover : t.textLo);
        return {
          type: "line", xref: "x", yref: "paper", x0: l.x, x1: l.x, y0: 0, y1: 1,
          line: { color, width: l.drag ? 2.2 : 1.4, dash: l.dash || "dash" },
          label: l.label ? {
            text: l.label, textposition: "end", textangle: -90, xanchor: "right",
            font: { color: t.textLo, size: 10.5 },
          } : undefined,
        };
      });

      const axis = (title, extra = {}) => ({
        title: { text: title || "", font: { size: 12 } },
        gridcolor: t.grid, zerolinecolor: t.border, linecolor: t.border,
        tickfont: { size: 11 }, automargin: true, exponentformat: "e", showline: true, mirror: false,
        ...extra,
      });

      const layout = {
        paper_bgcolor: t.panel, plot_bgcolor: t.panel,
        font: { family: t.font, color: t.text, size: 12 },
        colorway: t.colorway,
        margin: { l: 64, r: 16, t: 58, b: 48 },
        title: spec.title ? { text: spec.title, font: { family: "Georgia, serif", size: 14 }, x: 0, xref: "paper", xanchor: "left", y: 1, yref: "container", yanchor: "top", pad: { t: 10, l: 4 } } : undefined,
        xaxis: axis(spec.xlabel, spec.xrange ? { range: spec.xrange, autorange: false } : {}),
        yaxis: axis(spec.ylabel, {
          type: spec.logy ? "log" : "linear",
          ...(spec.yrange ? { range: spec.yrange, autorange: false } : {}),
        }),
        // legend above the plot area (right of the title) so it never hides data
        legend: { bgcolor: "rgba(0,0,0,0)", font: { size: 11 }, orientation: "h", traceorder: "normal",
          x: 1, y: 1.01, xanchor: "right", yanchor: "bottom" },
        shapes,
        annotations: spec.text ? [{ text: spec.text, xref: "paper", yref: "paper", x: 0.5, y: 0.5,
          showarrow: false, font: { color: t.textLo, size: 13 }, xanchor: "center" }] : [],
        hovermode: "closest",
        hoverlabel: { bgcolor: t.panel, bordercolor: t.mint, font: { color: t.text } },
        modebar: { bgcolor: "rgba(0,0,0,0)", color: t.textLo, activecolor: t.mintHover },
        uirevision: spec.uirevision || "keep",
        dragmode: "zoom",
      };

      const config = {
        responsive: true, displaylogo: false, scrollZoom: false,
        modeBarButtonsToRemove: ["select2d", "lasso2d", "autoScale2d"],
        toImageButtonOptions: { format: "png", scale: 2, filename: this.opts.filename || "plot" },
        modeBarButtonsToAdd: [
          { name: "Copy plot image", icon: ICON_COPY, click: () => this.copyImage() },
          { name: "Copy curve data as CSV", icon: ICON_CSV, click: () => this.copyCSV() },
        ],
      };
      Plotly.react(this.el, data, layout, config);
    }

    rerender() { if (this.spec) this.render(this.spec); }

    // ----- copy helpers ------------------------------------------------------

    curvesCSV() {
      const traces = (this.spec?.traces || []).filter((tr) => !tr.band && tr.x && tr.y);
      if (!traces.length) return "";
      const header = [];
      for (const tr of traces) {
        const label = (tr.name || "curve").replace(/[,\n]/g, " ");
        header.push(`${label}_x`, `${label}_y`);
      }
      const n = Math.max(...traces.map((tr) => tr.x.length));
      const rows = [header.join(",")];
      for (let k = 0; k < n; k++) {
        rows.push(traces.map((tr) => (k < tr.x.length ? `${tr.x[k]},${tr.y[k]}` : ",")).join(","));
      }
      return rows.join("\n") + "\n";
    }

    async copyCSV() {
      const csv = this.curvesCSV();
      if (!csv) return;
      try {
        await navigator.clipboard.writeText(csv);
        IV.ui.toast("Curve data copied to clipboard as CSV.");
      } catch (_) {
        IV.ui.download(`${this.opts.filename || "curves"}.csv`, csv, "text/csv");
        IV.ui.toast("Clipboard not available — CSV downloaded instead.");
      }
    }

    async copyImage() {
      const url = await Plotly.toImage(this.el, { format: "png", scale: 2 });
      try {
        const blob = await (await fetch(url)).blob();
        await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
        IV.ui.toast("Plot image copied to clipboard.");
      } catch (_) {
        const a = document.createElement("a");
        a.href = url; a.download = `${this.opts.filename || "plot"}.png`; a.click();
        IV.ui.toast("Clipboard not available — PNG downloaded instead.");
      }
    }

    // ----- draggable vertical lines ------------------------------------------

    _geom() {
      const fl = this.el._fullLayout;
      if (!fl || !fl.xaxis || !fl._size) return null;
      const rect = this.el.getBoundingClientRect();
      return { xa: fl.xaxis, size: fl._size, rect };
    }

    _hit(e) {
      if (!this.lines.length) return null;
      const g = this._geom();
      if (!g) return null;
      const px = e.clientX - g.rect.left - g.size.l;
      const py = e.clientY - g.rect.top - g.size.t;
      if (py < 0 || py > g.size.h || px < -HIT_PX || px > g.size.w + HIT_PX) return null;
      let best = null;
      for (const line of this.lines) {
        const lp = g.xa.l2p(line.x);
        const d = Math.abs(lp - px);
        if (d <= HIT_PX && (!best || d < best.d)) best = { line, d };
      }
      return best ? best.line : null;
    }

    _pointerDown(e) {
      if (e.button !== 0) return;
      const line = this._hit(e);
      if (!line) return;
      e.preventDefault();
      e.stopPropagation();
      this._drag = line;
      try { this.el.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
    }

    _pointerMove(e) {
      if (!this._drag) {
        this.el.classList.toggle("drag-hover", !!this._hit(e));
        return;
      }
      const g = this._geom();
      if (!g) return;
      const px = Math.min(g.size.w, Math.max(0, e.clientX - g.rect.left - g.size.l));
      const x = g.xa.p2l(px);
      this._drag.x = x;
      const k = this._drag.index;
      Plotly.relayout(this.el, { [`shapes[${k}].x0`]: x, [`shapes[${k}].x1`]: x });
      if (this.onDrag) this.onDrag(this._drag.id, x, false);
    }

    _pointerUp(e) {
      if (!this._drag) return;
      const line = this._drag;
      this._drag = null;
      try { this.el.releasePointerCapture(e.pointerId); } catch (_) { /* ignore */ }
      if (this.onDrag) this.onDrag(line.id, line.x, true);
    }
  }

  Plot.rerenderAll = () => { for (const p of registry) p.rerender(); };

  IV.Plot = Plot;
})(window.IV = window.IV || {});
