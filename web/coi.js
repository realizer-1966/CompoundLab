// GitHub Pages and most static hosts cannot send the COOP/COEP headers that WebAssembly needs to use
// several CPU threads. coi-sw.js adds them, and doubles as the PWA app cache (offline shell). Register always —
// if the page is already cross-origin isolated (serve.py sends the headers) no reload is needed.
(() => {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  const reload = () => { sessionStorage.setItem("coi-reloaded", "1"); location.reload(); };
  if (!self.crossOriginIsolated && sessionStorage.getItem("coi-reloaded") === "1") return;
  navigator.serviceWorker.register(new URL("./coi-sw.js", document.currentScript.src), { updateViaCache: "none" }).then((reg) => {
    // SW 갱신을 방문마다 강제한다 — 아니면 SW 스크립트가 호스트의 ~10분 HTTP 캐시에 묶여 늦어진다
    return reg.update().then((r) => {
      if (!self.crossOriginIsolated) {
        if (reg.active && !navigator.serviceWorker.controller) return reload();
        const sw = reg.installing || reg.waiting;
        if (sw) sw.addEventListener("statechange", () => { if (sw.state === "activated") reload(); });
      }
    });
  }).catch((e) => console.warn("cross-origin isolation service worker not available:", e));
})();
