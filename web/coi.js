// GitHub Pages and most static hosts cannot send the COOP/COEP headers that WebAssembly needs to use
// several CPU threads. coi-sw.js adds them, and doubles as the PWA app cache (offline shell). Register always —
// if the page is already cross-origin isolated (serve.py sends the headers) no reload is needed.
(() => {
  if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
  const reload = () => { sessionStorage.setItem("coi-reloaded", "1"); location.reload(); };
  if (!self.crossOriginIsolated && sessionStorage.getItem("coi-reloaded") === "1") return;
  navigator.serviceWorker.register(new URL("./coi-sw.js", document.currentScript.src)).then((reg) => {
    if (self.crossOriginIsolated) return; // 헤더가 이미 있음: 캐싱만
    if (reg.active && !navigator.serviceWorker.controller) return reload();
    const sw = reg.installing || reg.waiting;
    if (sw) sw.addEventListener("statechange", () => { if (sw.state === "activated") reload(); });
  }).catch((e) => console.warn("cross-origin isolation service worker not available:", e));
})();
