// Shared by both pages: the model card (Laya + the embedding model), small DOM helpers and per-browser settings.
import { loadEmbedder, embedderCached, EMBED_MODEL } from "./embedder.js";

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
export const pct = (p, d = 0) => (p == null ? "–" : `${(p * 100).toFixed(d)}%`);
export const num = (x, d = 2) => (x == null || !Number.isFinite(x) ? "–" : x.toFixed(d));
// Yield a macrotask so the page can paint and handle input. MessageChannel, not setTimeout: background tabs clamp
// setTimeout to >= 1 s, which would stall a batch run whenever the tab is not in front.
export const yieldToBrowser = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });

export const settings = {
  get(k, d) { try { const v = localStorage.getItem("lrj." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("lrj." + k, JSON.stringify(v)); } catch { /* fine */ } },
};

export const M = { laya: null, embedder: null, model: null, manifest: null, loading: false, listeners: [] };
export const onModelsReady = (fn) => M.listeners.push(fn);

let modelMod = null;
const modelApi = () => (modelMod ||= import("./model.js"));

// 사용자 표시용 라벨 매핑 (데이터 키는 영문 그대로 유지)
export const LABEL_KO = { supported: "지지됨", not_supported: "미지 지지", answered: "답변됨", not_answered: "답변 안 됨" };

function setPill(kind, text) { const p = $("modelPill"); p.className = "modelpill " + kind; $("modelPillText").textContent = text; }
export function setStatus(msg, warn = false) { const s = $("status"); s.textContent = msg; s.classList.toggle("warn", warn); }
function setProgress(f) { $("progress").hidden = f == null; if (f != null) $("progressBar").style.width = (f * 100).toFixed(1) + "%"; }
export function pillIdle(recorded) { if (!M.laya) setPill(recorded ? "replay" : "", recorded ? "기록된 결과 · 모델을 로드하면 직접 실행할 수 있습니다" : "모델이 로드되지 않았습니다"); }

export async function initModelCard() {
  $("loadBtn").addEventListener("click", loadModels);
  $("embedLink").href = EMBED_MODEL.page; $("embedLink").textContent = EMBED_MODEL.id;
  const m = await modelApi();
  const base = m.modelBase();
  const link = $("modelLink"); link.href = base === m.DEFAULT_MODEL_BASE ? m.MODEL_PAGE : base; link.textContent = base === m.DEFAULT_MODEL_BASE ? "VishalMysore/layaForWebTrained" : base;
  try {
    M.manifest = await m.fetchManifest(base);
    const sel = $("variant"); sel.innerHTML = "";
    const saved = settings.get("variant", "q8e8");
    for (const [k, v] of Object.entries(M.manifest.variants)) {
      const cached = await m.cachedParts(base, v.data);
      const tag = cached === v.data.parts.length ? ", 캐시됨" : cached ? `, ${cached}/${v.data.parts.length}개 파트 캐시됨` : "";
      sel.add(new Option(`${k === "q8e8" ? "int8 (권장)" : k === "q4e8" ? "int4 (더 작음, WebGPU)" : v.label} · ${Math.round(v.data.size / 1048576)} MB${tag}`, k));
    }
    if (M.manifest.variants[saved]) sel.value = saved;
    const e = await embedderCached();
    $("embedState").textContent = e ? " (캐시됨)" : " (약 23 MB)";
    $("loadBtn").disabled = false;
  } catch (e) {
    setStatus(`${base}에서 모델 매니페스트를 읽지 못했습니다 (${e.message}). 기록된 결과는 계속 사용할 수 있습니다.`, true);
  }
}

export async function loadModels() {
  if (M.loading) return;
  M.loading = true; $("loadBtn").disabled = true; $("badges").innerHTML = "";
  setPill("busy", "모델 로드 중…");
  settings.set("variant", $("variant").value);
  try {
    const m = await modelApi();
    if (!M.embedder) M.embedder = await loadEmbedder({ onStatus: setStatus, onProgress: setProgress });
    const { laya, backend, info } = await m.loadLaya({
      base: m.modelBase(), manifest: M.manifest, variant: $("variant").value, backend: $("backend").value,
      onStatus: setStatus, onProgress: setProgress,
    });
    M.laya = laya; M.model = { backend, ...info };
    setStatus(`준비 완료. Laya: 내려받기 ${(info.downloadMs / 1000).toFixed(1)}초${info.fromCache ? ` (캐시에서 ${info.fromCache}/${info.parts}개 파트)` : ""}, 세션 초기화 ${(info.initMs / 1000).toFixed(1)}초. 검색기 ${(M.embedder.info.loadMs / 1000).toFixed(1)}초${M.embedder.info.fromCache ? " (캐시됨)" : ""}.`);
    const badge = (t, ok) => { const b = document.createElement("span"); b.className = "badge" + (ok ? " ok" : ""); b.textContent = t; $("badges").appendChild(b); };
    badge(backend === "webgpu" ? "WebGPU" : `WASM · 스레드 ${info.threads}개`, true);
    badge(`판별기: ${info.model || info.source} · ${info.variant}`); badge(`검색기: ${EMBED_MODEL.id} · ${EMBED_MODEL.dim}차원`);
    badge(`컨텍스트 ${info.maxLen} 토큰`);
    setPill("ready", `모델 준비 완료 · ${backend === "webgpu" ? "WebGPU" : "WASM"}`);
    $("loadBtn").textContent = "모델 다시 로드";
    for (const fn of M.listeners) fn();
  } catch (e) {
    console.error(e);
    setStatus("모델을 로드하지 못했습니다: " + (e?.message || e), true);
    pillIdle(false);
  } finally { M.loading = false; $("loadBtn").disabled = false; setProgress(null); }
}

/** Recorded results (produced by the same models) so the pages show something before anything is downloaded. */
export async function loadRecorded() {
  try { const r = await fetch("./recorded.json", { cache: "no-cache" }); if (r.ok) return await r.json(); } catch { /* optional */ }
  return null;
}

export function download(name, text, type = "application/json") {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement("a"), { href: url, download: name });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Probability bars (reuses the .bar styles). */
export function bars(probs, selected) {
  return `<div class="bars">${Object.entries(probs).map(([k, v]) => `<div class="bar${k === selected ? " sel" : ""}"><span class="n">${esc(LABEL_KO[k] ?? k.replace(/_/g, " "))}</span><span class="tr"><span class="f" style="width:${(v * 100).toFixed(1)}%"></span></span><span class="v">${v.toFixed(2)}</span></div>`).join("")}</div>`;
}

export const GATE_TEXT = {
  AUTO: { cls: "auto", k: "자동 판정 · 지지됨", t: "근거가 주장을 지지합니다", d: "출처와 함께 답변을 보여줄 만큼 확신이 있습니다." },
  BLOCK: { cls: "block", k: "차단 · 미지 지지", t: "근거가 주장을 지지하지 않습니다", d: "답변을 보류하거나 다시 생성할 만큼 확신이 있습니다." },
  HOLD: { cls: "human", k: "보류 · 사람 검토", t: "실행하기에 확신이 부족합니다", d: "신뢰도 기준선 미만이라 사람이 검토합니다." },
};
