/* =============================================================================
   Installable app / offline support (Progressive Web App).
   Only active when served over http(s), e.g. GitHub Pages; opening
   index.html from disk keeps working as a plain page.
   ============================================================================= */
(function (IV) {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const isHttp = location.protocol === "https:" || location.protocol === "http:";
  const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;

  // ----- offline copy -------------------------------------------------------
  if (isHttp && "serviceWorker" in navigator) {
    const firstInstall = !navigator.serviceWorker.controller;
    navigator.serviceWorker.register("sw.js").then((reg) => {
      const worker = reg.installing;
      if (!worker || !firstInstall) return;
      worker.addEventListener("statechange", () => {
        if (worker.state === "activated") IV.ui.toast("The app is saved on this computer and now also works offline.");
      });
    }).catch(() => { /* not fatal: the app simply has no offline copy */ });
  }

  // ----- "Install app" button (Chrome / Edge) -------------------------------
  let installPrompt = null;
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    if (!standalone()) $("installBtn").classList.remove("hidden");
  });
  window.addEventListener("appinstalled", () => {
    installPrompt = null;
    $("installBtn").classList.add("hidden");
    IV.ui.toast("Installed — the IV Analyser now has its own icon and window.");
  });

  document.addEventListener("DOMContentLoaded", () => {
    $("installBtn").addEventListener("click", async () => {
      if (!installPrompt) return;
      installPrompt.prompt();
      await installPrompt.userChoice;
      installPrompt = null;
      $("installBtn").classList.add("hidden");
    });

    // ----- online / offline indicator ---------------------------------------
    const badge = $("offlineBadge");
    const paint = () => badge.classList.toggle("hidden", navigator.onLine);
    window.addEventListener("online", paint);
    window.addEventListener("offline", paint);
    paint();

    // ----- files opened with "Open with → IV Analyser" (installed app) --------
    if ("launchQueue" in window) {
      window.launchQueue.setConsumer(async (params) => {
        if (!params.files || !params.files.length) return;
        IV.openFile(await params.files[0].getFile());
      });
    }
  });
})(window.IV = window.IV || {});
