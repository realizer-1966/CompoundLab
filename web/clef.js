// Ollama-backed judge backend adapter. The web pages talk to the judge through Laya's
// systemOne(state, questions) -> { answers, latency_ms, usage } interface; this adapter forwards the exact same
// schema to an Ollama server's /v1/systemone endpoint, hosted either locally or on Ollama's cloud.
//
// Clef (Cloudflare) is a decision model that already speaks the System One API, so the answer shapes match Laya's:
//   choice -> { type: "choice", choice, confidence, probabilities: { ...criteria names... } }
//   noul   -> { type: "noul", noul: p }
// judge.js's interpret() reads those unchanged. The adapter only adds latency_ms (measured here — Ollama omits it)
// and translates network failures into actionable Korean messages.
//
// Privacy & hosting: with the browser Laya build nothing ever leaves the page. With Ollama Clef the judge state
// (claim + evidence passages) goes to the Ollama server at this URL; with a :cloud model tag it is then forwarded to
// Ollama's cloud (a paid API). The retriever (MiniLM, in-browser) stays local either way, so the corpus and vectors
// never leave the device — only the judged claims do.

export const CLEF_DEFAULT_MODEL = "clef:cloud";
export const CLEF_PAGE = "https://ollama.com/library/clef";
const DEFAULT_BASE = "http://localhost:11434";

// Same per-browser setting convention as common.js, read inline to avoid an import cycle.
const readSetting = (k, d) => { try { const v = localStorage.getItem("lrj." + k); return v == null ? d : JSON.parse(v); } catch { return d; } };

/** Judge endpoint base: override with ?clefBase=... (full, no trailing slash), else the persisted setting, else
 *  localhost — the same server `ollama pull clef:cloud` was typed into. Node-safe: no location/localStorage there. */
export function clefBase() {
  const q = typeof location !== "undefined" && location.search ? new URLSearchParams(location.search).get("clefBase") : null;
  return (q || readSetting("clefBase", DEFAULT_BASE)).replace(/\/+$/, "");
}

/** Health probe: is anything answering at all (and does it know the model tag)? Returns an error message on failure. */
export async function clefHealth(base = clefBase(), model = readSetting("clefModel", CLEF_DEFAULT_MODEL)) {
  let tags;
  try {
    const r = await fetch(`${base}/api/tags`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    tags = await r.json();
  } catch (e) {
    throw new Error(`${base}에 접속하지 못했습니다 (${e?.message || e}). Ollama가 실행 중인지, CORS가 허용됐는지 확인하세요 (GitHub Pages에서는 OLLAMA_ORIGINS 설정 필요).`);
  }
  const names = (tags.models || []).map((m) => m.name);
  if (names.length && !names.some((n) => n === model || n.startsWith(model.split(":")[0] + ":") || model.startsWith(n.split(":")[0] + ":"))) {
    return `${base}에는 clef 모델이 없습니다 (설치됨: ${names.join(", ")}). 'ollama pull clef:cloud'로 내려받으세요.`;
  }
  return null;
}

/**
 * @returns a judge object with the same interface the pages expect from browser Laya:
 *   { kind: "clef", variant, model, systemOne(state, questions), info }
 */
export async function createClef({ model = CLEF_DEFAULT_MODEL, base = clefBase(), onStatus = () => {} } = {}) {
  onStatus(`${base}에서 Clef (${model})를 확인하는 중…`);
  const health = await clefHealth(base, model);
  if (health) throw new Error(health);
  // Fail fast on a real decision call too, so "모델 로드" surfaces auth/quota problems immediately.
  const t0 = performance.now();
  const r = await fetch(`${base}/v1/systemone`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ model, state: "헬스체크", questions: { check: { type: "noul", instructions: "이 텍스트는 헬스체크다" } } }),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    throw new Error(`Clef 호출 실패 (HTTP ${r.status}): ${body.slice(0, 200) || "응답 없음"}`);
  }
  await r.json();
  const ms = performance.now() - t0;
  onStatus(`Clef 준비 완료 (${model}): 헬스체크 ${ms.toFixed(0)} ms. 검색기는 이 브라우저에서 실행됩니다.`);
  return {
    kind: "clef",
    model,
    variant: model, // runKey / badges use the same field as Laya's variant id
    info: { model: "clef", source: base, variant: model },
    async systemOne(state, questions) {
      const start = performance.now();
      let res;
      try {
        res = await fetch(`${base}/v1/systemone`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          cache: "no-store",
          body: JSON.stringify({ model, state, questions }),
        });
      } catch (e) {
        throw new Error(`${base}에 접속하지 못했습니다 (${e?.message || e}). Ollama가 실행 중인지 확인하세요.`);
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Clef 호출 실패 (HTTP ${res.status}): ${body.slice(0, 200) || "응답 없음"}`);
      }
      const data = await res.json();
      if (!data.answers) throw new Error("Clef 응답에 answers가 없습니다: " + JSON.stringify(data).slice(0, 200));
      return { ...data, latency_ms: performance.now() - start };
    },
  };
}
