/* =============================================================================
   Small DOM helpers: element builder, dialogs, form fields, toasts, downloads.
   ============================================================================= */
(function (IV) {
  "use strict";

  /** el("div.cls#id", {attr: v, onclick: fn}, [children]) */
  function el(spec, attrs = {}, children = []) {
    const [, tag = "div", rest = ""] = spec.match(/^([a-z0-9-]*)(.*)$/i);
    const node = document.createElement(tag || "div");
    for (const part of rest.match(/[.#][^.#]+/g) || []) {
      if (part[0] === ".") node.classList.add(part.slice(1));
      else node.id = part.slice(1);
    }
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
      else if (k === "text") node.textContent = v;
      else if (k === "html") node.innerHTML = v;
      else node.setAttribute(k, v === true ? "" : v);
    }
    for (const c of [].concat(children)) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  // ---------------------------------------------------------------------------
  // Formatting
  // ---------------------------------------------------------------------------

  /** Python-like "%.<p>g" */
  function fmtG(v, p = 6) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return "NaN";
    v = Number(v);
    if (v === 0) return "0";
    const exp = Math.floor(Math.log10(Math.abs(v)));
    if (exp < -4 || exp >= p) {
      const [m, e] = v.toExponential(p - 1).split("e");
      const mm = m.includes(".") ? m.replace(/\.?0+$/, "") : m;
      const n = parseInt(e, 10);
      return `${mm}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
    }
    const s = v.toPrecision(p);
    return s.includes(".") ? s.replace(/\.?0+$/, "") : s;
  }

  function fmtE(v, d = 4) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return "NaN";
    const [m, e] = Number(v).toExponential(d).split("e");
    const n = parseInt(e, 10);
    return `${m}e${n < 0 ? "-" : "+"}${String(Math.abs(n)).padStart(2, "0")}`;
  }

  // ---------------------------------------------------------------------------
  // Toasts / downloads
  // ---------------------------------------------------------------------------

  function toast(message, kind = "info", title) {
    const box = document.querySelector(".toasts") || document.body.appendChild(el("div.toasts", { "aria-live": "polite" }));
    const node = el(`div.toast${kind === "error" ? ".error" : ""}`, { role: kind === "error" ? "alert" : "status" },
      [title ? el("strong", { text: title }) : null, message]);
    box.append(node);
    setTimeout(() => node.remove(), kind === "error" ? 7000 : 3500);
  }

  function download(filename, content, mime = "text/plain") {
    const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ---------------------------------------------------------------------------
  // Dialogs
  // ---------------------------------------------------------------------------

  /**
   * Opens a modal window. Returns {dlg, body, foot, close, plots}.
   * Plots registered in `plots` are destroyed when the window closes.
   */
  function openDialog({ title, small = false, padded = false, onClose } = {}) {
    const closeBtn = el("button.btn.ghost.icon", { "aria-label": "Close", title: "Close", html:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>' });
    const body = el(`div.win-body${padded ? ".pad" : ""}`);
    const foot = el("div.win-foot");
    const dlg = el(`dialog.win${small ? ".small" : ""}`, {}, [
      el("div.win-head", {}, [el("h2", { text: title }), closeBtn]),
      body,
      foot,
    ]);
    const handle = { dlg, body, foot, plots: [] };
    handle.close = () => dlg.close();
    closeBtn.addEventListener("click", handle.close);
    dlg.addEventListener("close", () => {
      for (const p of handle.plots) p.destroy();
      dlg.remove();
      if (onClose) onClose();
    });
    document.body.append(dlg);
    dlg.showModal();
    return handle;
  }

  function message(title, html, buttons = [{ label: "OK", primary: true }]) {
    return new Promise((resolve) => {
      let result = null;
      const d = openDialog({ title, small: true, padded: true, onClose: () => resolve(result) });
      d.body.append(el("div", { html }));
      for (const b of buttons) {
        d.foot.append(el(`button.btn${b.primary ? ".primary" : ""}`, {
          text: b.label, onclick: () => { result = b.value ?? b.label; d.close(); },
        }));
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Form fields (QDoubleSpinBox / QSpinBox / QSlider / QCheckBox / QComboBox)
  // ---------------------------------------------------------------------------

  /** Numeric input. onChange fires on user edits only (like Qt valueChanged with signals unblocked). */
  function numberField(label, { value = 0, step = 0.1, min, max, decimals = 4, width, onChange, title, odd = false } = {}) {
    const input = el("input", { type: "number", step, min, max, title });
    if (width) input.style.width = width;
    const field = el("div.field", {}, [el("label", { text: label }), input]);
    const clamp = (v) => {
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      return v;
    };
    // odd: smoothing windows must be odd; show the value that is really used
    const round = (v) => {
      v = decimals === 0 ? Math.round(v) : Number(v.toFixed(decimals));
      if (odd && v % 2 === 0) v = max !== undefined && v + 1 > max ? v - 1 : v + 1;
      return v;
    };
    let current = round(clamp(value));
    input.value = current;
    const api = {
      field, input,
      get value() { return current; },
      set(v, silent = true) {
        if (!Number.isFinite(v)) return;
        current = round(clamp(v));
        input.value = current;
        if (!silent && onChange) onChange(current);
      },
    };
    input.addEventListener("change", () => {
      const v = parseFloat(input.value);
      if (!Number.isFinite(v)) { input.value = current; return; }
      api.set(v, false);
    });
    input.addEventListener("input", () => {
      // live update for spinner arrows / typing a complete number
      const v = parseFloat(input.value);
      if (Number.isFinite(v) && round(clamp(v)) !== current && document.activeElement === input) {
        current = round(clamp(v));
        if (onChange) onChange(current);
      }
    });
    return api;
  }

  function sliderField(label, { value, min, max, step = 1, onChange } = {}) {
    const input = el("input", { type: "range", min, max, step });
    const out = el("span.mono", { style: "min-width:3ch;text-align:right" });
    const field = el("div.field.grow", {}, [el("label", { text: label }), input, out]);
    const paint = () => {
      out.textContent = input.value;
      const f = ((input.value - min) / Math.max(1, max - min)) * 100;
      input.style.setProperty("--fill", `${f}%`);
    };
    input.value = value;
    paint();
    let timer = null;
    input.addEventListener("input", () => {
      paint();
      // light debounce so heavy smoothers stay responsive while dragging
      clearTimeout(timer);
      timer = setTimeout(() => onChange && onChange(Number(input.value)), 30);
    });
    return {
      field, input,
      get value() { return Number(input.value); },
      set(v) { input.value = v; paint(); },
    };
  }

  function checkField(label, { checked = false, onChange } = {}) {
    const input = el("input", { type: "checkbox" });
    input.checked = checked;
    const field = el("label.check", {}, [input, label]);
    input.addEventListener("change", () => onChange && onChange(input.checked));
    return { field, input, get value() { return input.checked; }, set(v) { input.checked = !!v; } };
  }

  function selectField(label, options, { value, onChange } = {}) {
    const select = el("select", {}, options.map((o) => el("option", { value: o, text: o })));
    if (value !== undefined) select.value = value;
    const field = el("div.field", {}, [el("label", { text: label }), select]);
    select.addEventListener("change", () => onChange && onChange(select.value));
    return { field, select, get value() { return select.value; }, set(v) { if (v !== undefined) select.value = v; } };
  }

  /** Simple tab strip; returns {strip, panels[], select(i), current} */
  function tabs(labels, onSelect) {
    const strip = el("div.tabs", { role: "tablist" });
    const panels = [];
    const buttons = labels.map((label, i) => {
      const b = el("button", { role: "tab", type: "button", "aria-selected": "false" },
        [el("span.step", { text: String(i + 1) }), label]);
      b.addEventListener("click", () => api.select(i));
      strip.append(b);
      panels.push(el("div.tab-panel", { role: "tabpanel" }));
      return b;
    });
    const api = {
      strip, panels, current: 0,
      select(i) {
        api.current = i;
        buttons.forEach((b, k) => b.setAttribute("aria-selected", String(k === i)));
        panels.forEach((p, k) => p.classList.toggle("active", k === i));
        if (onSelect) onSelect(i);
      },
    };
    return api;
  }

  IV.ui = { el, fmtG, fmtE, toast, download, openDialog, message, numberField, sliderField, checkField, selectField, tabs };
})(window.IV = window.IV || {});
