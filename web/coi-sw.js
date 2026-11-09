// CompoundLab 앱 서비스 워커. 두 가지 일을 한다:
//  1) COOP/COEP 헤더를 같은 오리진 응답에 추가해 ONNX Runtime Web의 멀티스레드 WASM을 가능하게 한다
//     (GitHub Pages 같은 정적 호스트는 헤더를 보내지 못한다 → cross-origin isolation).
//  2) same-origin 정적 자산(앱 셸, 벤더, 코퍼스 JSON)을 캐싱해 설치형 웹앱(PWA)으로 오프라인에서도 열리게 한다.
//     모델 파일(Laya, 임베더)은 model.js/embedder.js가 이미 Cache Storage에 해시 키로 캐싱하고, 벡터와 실행 결과는
//     IndexedDB에 있으므로 첫 방문 한 번만 네트워크가 필요하다.
//
// 캐싱 정책:
//   문서(HTML)·json·모듈(.mjs/.js) → network-first (배포 직후에도 첫 로드부터 새 코드, 오프라인이면 캐시로)
//   스타일·아이콘·manifest 등 드문 변경 자산 → stale-while-revalidate

const VERSION = "v3";
const CACHE = "compoundlab-" + VERSION;

const PRECACHE = [
  "./", "./index.html", "./chat.html", "./lab.html", "./production.html", "./rag-eval.html", "./router.html",
  "./styles.css", "./manifest.webmanifest", "./icons/icon-192.png", "./icons/icon-512.png",
  "./corpus.json", "./recorded.json", "./router.json", "./router-recorded.json",
  "./common.js", "./coi.js", "./store.js", "./rag.js", "./judge.js", "./metrics.js", "./pipeline.js",
  "./model.js", "./embedder.js", "./clef.js", "./gen.js", "./ingest.js", "./laya-core.js", "./router-core.js",
  "./verify.js", "./rag-eval.js", "./router.js", "./chat.js",
  "./chunkLab.js", "./prodLab.js", "./policyCorpus.js", "./lab.js", "./production.js",
  "./vendor/ort.min.mjs", "./vendor/tokenizers.min.mjs",
  "./vendor/pdf.min.mjs", "./vendor/pdf.worker.min.mjs",
];

self.addEventListener("install", (e) => {
  e.waitUntil((async () => { const c = await caches.open(CACHE); await c.addAll(PRECACHE).catch(() => {}); self.skipWaiting(); })());
});
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== CACHE) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (e) => {
  const r = e.request;
  if (r.method !== "GET") return;
  const url = new URL(r.url);
  if (url.origin !== location.origin) return; // 모델은 자체 캐싱(model.js/embedder.js), Ollama는 네트워크로
  if (r.cache === "only-if-cached" && r.mode !== "same-origin") return;
  const isDoc = r.mode === "navigate" || /\.(html|json|mjs|js)$/.test(url.pathname); // 배포 반영 즉시성: 코드와 데이터는 network-first

  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    if (isDoc) {
      // 문서: network-first — 업데이트를 빨리 받는다
      try {
        const res = await fetch(r);
        if (res.ok) await cache.put(r, res.clone());
        return res;
      } catch {
        const hit = (await cache.match(r)) || (url.pathname.endsWith(".html") ? await cache.match("./index.html") : null);
        return hit || Response.error();
      }
    }
    // 정적: stale-while-revalidate
    const hit = await cache.match(r);
    const revalidate = fetch(r).then((res) => { if (res.ok) cache.put(r, res.clone()); return res }).catch(() => null);
    if (hit) { e.waitUntil?.(revalidate); return withCOI(hit) }
    const res = await revalidate;
    if (!res) return Response.error();
    return withCOI(res);
  })());
});

/** COI 헤더 주입 (serve.py가 이미 헤더를 보내면 값이 같아 무해). */
function withCOI(res) {
  const h = new Headers(res.headers);
  h.set("Cross-Origin-Embedder-Policy", "require-corp");
  h.set("Cross-Origin-Opener-Policy", "same-origin");
  if (!/text\/html/.test(h.get("Content-Type") || "")) return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  return res;
}
