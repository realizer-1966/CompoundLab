// "질의응답" 페이지: 수집(브라우저 안) → 검색(하이브리드) → 생성(인용 단 답변) → 검증(문장별 판별 게이트).
// 검증 단계가 이 데모의 핵심: laya-rag-judge-ko의 판별기를 생성된 답변 자체에 적용한다.
import { $, esc, num, settings, M, onModelsReady, initModelCard, pillIdle } from "./common.js";
import { loadCorpus, retrieve } from "./pipeline.js";
import { PRESETS, DEFAULT_PRESET, DEFAULT_THRESHOLD, gate } from "./judge.js";
import { ingestFile, listUploads, removeUpload, uploadPool, kindOf, cfgOf } from "./ingest.js";
import * as db from "./store.js";
import { generate, verifyClaims, summarize, splitClaims, buildPrompt, GEN_DEFAULT_MODEL } from "./gen.js";

const LABEL_KO = { supported: "지지됨", not_supported: "미지 지지" };
const GATE_KO = { AUTO: "자동", BLOCK: "차단", HOLD: "보류" };

const S = { uploads: [], last: null, busy: false, corpus: null, trace: [],
  cutoff: settings.get("cutoff", 0.5), threshold: settings.get("threshold", DEFAULT_THRESHOLD) };

const rag = () => ({ sentencesPerChunk: 2, overlap: 0, k: +$("k").value, scope: "corpus", retriever: "hybrid", w: 0.6 });

// ---- ingestion -------------------------------------------------------------------------------------------

async function refreshUploads() {
  S.uploads = await listUploads();
  const list = $("uploadList");
  list.innerHTML = S.uploads.length
    ? `<ul class="uploadlist">${S.uploads.map((d) => `<li><span>${esc(d.name)}</span><span class="meta">${d.chunks} 구절 · ${Math.round(d.size / 1024)} KB</span><button data-doc="${esc(d.docId)}" class="ghost" aria-label="${esc(d.name)} 삭제">삭제</button></li>`).join("")}</ul>`
    : `<p class="hint" style="margin:0">업로드한 문서가 없습니다.</p>`;
  list.querySelectorAll("button[data-doc]").forEach((b) => b.addEventListener("click", async () => {
    if (!M.embedder) return;
    await removeUpload(b.dataset.doc, rag(), M.embedder);
    refreshUploads();
  }));
  $("clearUploadsBtn").disabled = !S.uploads.length || !M.embedder;
  const n = S.uploads.reduce((a, d) => a + d.chunks, 0);
  $("scopeHint").textContent = n ? `업로드한 문서 ${S.uploads.length}개 · 구절 ${n}개가 검색됩니다.` : "업로드한 문서가 없으면 예시 코퍼스를 고르세요.";
  S.uploadTotal = n;
}

async function ingest(files) {
  if (!M.embedder) { $("ingestHint").textContent = "먼저 모델을 로드하세요 — 수집에는 임베더가 필요합니다."; return; }
  const r = rag();
  for (const file of files) {
    if (!kindOf(file.name)) { $("ingestHint").textContent = `지원하지 않는 형식: ${file.name}`; continue; }
    $("ingestHint").textContent = `${file.name} 파싱 중…`;
    try {
      const res = await ingestFile(file, r, M.embedder, (i, n, msg) => { $("ingestHint").textContent = `${file.name}: ${msg || ""} (${i}/${n})`; });
      $("ingestHint").textContent = `${file.name}: 구절 ${res.chunks}개 수집 완료 (${res.reused ? "이전과 같은 내용 — 임베딩 재사용" : `${res.embedded}개 새로 임베딩`}, ${(res.ms / 1000).toFixed(1)}초).`;
    } catch (e) {
      console.error(e);
      $("ingestHint").textContent = `${file.name} 수집 실패: ${e?.message || e}`;
    }
    await refreshUploads();
  }
}

// ---- ask: retrieve → generate → judge the answer ---------------------------------------------------------

async function ask() {
  if (S.busy) return;
  const q = $("question").value.trim();
  if (!q) { $("runHint").textContent = "먼저 질문을 입력하세요."; return; }
  if (!M.embedder) { $("runHint").textContent = "먼저 모델을 로드하세요 (검색에는 임베더가 필요하고, 검증에는 판별기가 필요합니다)."; return; }
  if (!M.laya) { $("runHint").textContent = "판별기가 필요합니다: 모델 카드에서 판별기를 로드하세요 (Laya 또는 Clef)."; return; }
  S.busy = true; $("askBtn").disabled = true;
  $("placeholder").hidden = true;
  const hint = (m) => { $("runHint").textContent = m; };
  S.trace = [["0.00s", `질문: “${q.slice(0, 60)}” · 근거 범위 ${$("scope").value === "uploads" ? "업로드 문서" : "코퍼스 전체"}`]];
  const t0 = performance.now();
  const tr = (m) => S.trace.push([`${((performance.now() - t0) / 1000).toFixed(2)}s`, m]);
  try {
    const r = rag();
    let pool;
    if ($("scope").value === "uploads") {
      pool = await uploadPool(M.embedder, { sentencesPerChunk: 2, overlap: 0 });
      if (!pool.length) { hint("업로드한 문서가 없습니다. 문서를 수집하거나 근거 범위를 예시 코퍼스로 바꾸세요."); return; }
    } else {
      if (!S.corpus) S.corpus = await loadCorpus();
      pool = (await dbPassagesAll()).filter((p) => p.dataset !== "uploads");
      if (!pool.length) { hint("코퍼스 인덱스가 비어 있습니다. 주장 검증 페이지에서 한 번이라도 검증을 실행하면 인덱스가 만들어집니다."); return; }
    }
    hint("근거를 검색하는 중 (하이브리드: 벡터 w=0.60 + 한국어 BM25)…");
    const ret = await retrieve(M.embedder, q, { rag: r, pool });
    const passages = ret.passages;
    tr(`검색(하이브리드 w=0.60): 후보 ${ret.candidates} → top ${passages.length} · ${ret.searchMs.toFixed(0)} ms (${passages.map((p) => `#${p.chunk + 1}=${p.score.toFixed(2)}`).join(", ")})`);

    const mode = $("gsel").value;
    hint(mode === "mock" ? "Mock AI로 답변을 구성하는 중…" : `Ollama ${$("gmodel").value}로 답변을 생성하는 중…`);
    const g = await generate({ mode, model: ($("gmodel").value || GEN_DEFAULT_MODEL).trim(), question: q, passages });
    const sent = splitClaims(g.text).length;
    tr(`생성: ${g.model} · ${(g.ms / 1000).toFixed(2)} s${g.tokens ? ` · 프롬프트 ${g.tokens} 토큰` : ""} · 문장 ${sent}개`);

    hint(`답변의 문장을 판별하는 중 — 판별기: ${M.laya.kind === "clef" ? `Ollama Clef (${M.laya.variant})` : "브라우저 Laya"}…`);
    const presetId = $("preset").value;
    const claims = splitClaims(g.text);
    const verdicts = await verifyClaims(M.laya, claims, passages, { presetId, cutoff: S.cutoff, threshold: S.threshold,
      onProgress: (i, n, t) => hint(`문장 ${i} / ${n} 판별 중: “${t.slice(0, 40)}…”`) });

    tr(`검증: 판별기 ${M.laya.kind === "clef" ? `Ollama Clef (${M.laya.variant})` : "브라우저 Laya"} · 질문 ${presetId} · 문장 ${verdicts.length}개`);
    verdicts.forEach((v, i) => tr(`  문장 ${i + 1}: p=${v.pSupported.toFixed(3)} → ${GATE_KO[v.gate]} (${v.judgeMs.toFixed(0)} ms${v.tokens ? ` · ${v.tokens}tok` : ""}) — “${v.text.slice(0, 36)}…”`));
    const sm = summarize(verdicts);
    tr(`요약: ${sm.claims} 문장 · 자동 ${sm.AUTO} / 보류 ${sm.HOLD} / 차단 ${sm.BLOCK} · 인용 없음 ${sm.nocite}`);
    S.last = { question: q, passages, generation: g, verdicts, claimSummary: sm, presetId, rag: r, docIds: [...new Set(passages.map((p) => p.docId))], prompt: buildPrompt(q, passages), searchMs: ret.searchMs, candidates: ret.candidates };
    tr(`총 ${(performance.now() - t0).toFixed(2)} s`);
    show();
    hint("완료. 생성기·게이트 슬라이더를 바꾸면 즉시 재분류됩니다 (판별 재호출은 '질의응답'을 다시 누를 때).");
  } catch (e) {
    console.error(e);
    hint("오류: " + (e?.message || e));
  } finally {
    S.busy = false; $("askBtn").disabled = false;
  }
}

async function dbPassagesAll() {
  return await db.passages(cfgOf(M.embedder, { sentencesPerChunk: 2, overlap: 0 }), null);
}

// ---- rendering ---------------------------------------------------------------------------------------

function scoreLabel(p) {
  const parts = [];
  if (p.cosine != null) parts.push(`cos ${p.cosine.toFixed(3)}`);
  if (p.keyword != null && p.keyword > 0) parts.push(`kw ${p.keyword.toFixed(3)}`);
  if (p.proximity != null) parts.push(`근접 ${p.proximity.toFixed(3)}`);
  return (parts.length ? parts.join(" · ") : `cos ${p.score.toFixed(3)}`) + (parts.length ? ` → ${p.score.toFixed(3)}` : "");
}

function show() {
  const r = S.last;
  if (!r) return;
  $("placeholder").hidden = true; $("result").hidden = false;

  const bad = r.verdicts.filter((c) => c.gate === "BLOCK").length;
  const held = r.verdicts.filter((c) => c.gate === "HOLD").length;
  $("banner").innerHTML = bad ? `<div class="outcome block"><div class="k">경고 · 미지지 문장 ${bad}개</div><div class="t">이 답변에는 근거가 뒷받침하지 않는 문장이 있습니다</div><div class="d">아래에서 빨간 표시로 강조된 문장을 확인하세요. 이 문장들은 생성기의 환각일 가능성이 높습니다.</div></div>`
    : held ? `<div class="outcome human"><div class="k">보류 문장 ${held}개</div><div class="t">판별기가 확신하지 못한 문장이 있습니다</div><div class="d">신뢰도 기준선(${S.threshold.toFixed(2)}) 미만의 문장은 회색으로 표시됩니다. 사람이 확인하세요.</div></div>`
    : `<div class="outcome auto"><div class="k">모든 문장 지지됨</div><div class="t">판별기가 이 답변의 모든 문장을 근거로 지지합니다</div><div class="d">문장 ${r.verdicts.length}개 · 인용 누락 ${r.verdicts.filter((c) => !c.cites.length).length}개</div></div>`;

  $("genMeta").textContent = `${r.generation.model} · ${(r.generation.ms / 1000).toFixed(1)}초${r.generation.tokens ? ` · ${r.generation.tokens} 토큰(프롬프트)` : ""} · 검색 ${r.searchMs.toFixed(0)} ms`;
  $("answer").innerHTML = r.verdicts.map((c) => {
    const cls = c.gate === "AUTO" ? "ok" : c.gate === "BLOCK" ? "bad" : "warn";
    return `<p class="claim-sent ${c.gate.toLowerCase()}"><span class="tag ${cls}">${GATE_KO[c.gate]}</span> ${esc(c.text)}${c.cites.length ? ` <span class="cites">${c.cites.map((n) => `<sup>[${n}]</sup>`).join("")}</span>` : ' <span class="tag warn">인용 없음</span>'}</p>`;
  }).join("");

  $("verdictMeta").textContent = `판별기 ${M.laya.kind === "clef" ? `Ollama Clef (${M.laya.variant})` : "브라우저 Laya"} · 질문: ${PRESETS[r.presetId]?.name.split(":")[0] || r.presetId}`;
  $("claims").innerHTML = `<table class="grid"><thead><tr><th>문장</th><th>p(지지됨)</th><th>게이트</th><th class="r">ms</th></tr></thead><tbody>$
    ${r.verdicts.map((c) => `<tr><td>${esc(c.text.slice(0, 80))}${c.text.length > 80 ? "…" : ""}</td><td><span class="pbar"><i style="width:${(c.pSupported * 100).toFixed(0)}%"></i></span>${c.pSupported.toFixed(3)}</td><td><span class="tag ${c.gate === "AUTO" ? "ok" : c.gate === "BLOCK" ? "bad" : "warn"}">${GATE_KO[c.gate]}</span></td><td class="r">${c.judgeMs?.toFixed(0) ?? "–"}</td></tr>`).join("")}</tbody></table>`;

  $("retrMeta").textContent = `하이브리드 (벡터 w=0.60 + 한국어 BM25) top ${r.passages.length} / 후보 ${r.candidates ?? r.passages.length}개`;
  $("passages").innerHTML = r.passages.map((p, i) => `<li class="passage"><span class="rank">${i + 1}</span><div>
    <div class="src"><span>${esc(p.docId.startsWith("up:") ? "업로드 문서" : "코퍼스 문서")} · 구절 ${p.chunk + 1}</span><span class="score"><span class="tr"><span class="f" style="width:${Math.max(0, p.score) * 100}%"></span></span>${scoreLabel(p)}</span></div>
    <div class="txt">${esc(p.text)}</div></div></li>`).join("");
  $("prompt").textContent = r.prompt;
  $("trace").textContent = S.trace.map(([t, m]) => t.padStart(7) + "  " + m).join("\n");
}

function reclassify() { if (S.last) S.last.verdicts = S.last.verdicts.map((c) => ({ ...c, gate: gate(c.pSupported, c.confidence, { cutoff: S.cutoff, threshold: S.threshold }) })); show(); }

// ---- wiring ---------------------------------------------------------------------------------------

function wire() {
  const fileInput = $("file");
  fileInput.addEventListener("change", () => { if (fileInput.files.length) ingest([...fileInput.files]); fileInput.value = ""; });
  ["dragover", "drop"].forEach((ev) => $("file").closest(".field").addEventListener(ev, (e) => {
    e.preventDefault();
    if (ev === "drop" && e.dataTransfer?.files?.length) ingest([...e.dataTransfer.files]);
  }));
  $("clearUploadsBtn").addEventListener("click", async () => {
    if (!confirm("업로드한 모든 문서와 구절 인덱스를 삭제할까요? 코퍼스는 그대로입니다.")) return;
    for (const d of S.uploads) await removeUpload(d.docId, rag(), M.embedder);
    refreshUploads();
  });
  $("preset").innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.name.split(":")[0])}</option>`).join("");
  $("preset").value = settings.get("preset", DEFAULT_PRESET);
  $("preset").addEventListener("change", () => settings.set("preset", $("preset").value));
  $("gsel").value = settings.get("gsel", "ollama");
  $("gsel").addEventListener("change", () => { settings.set("gsel", $("gsel").value); $("gmodelField").hidden = $("gsel").value !== "ollama"; });
  $("gmodelField").hidden = $("gsel").value !== "ollama";
  $("gmodel").value = settings.get("gmodel", GEN_DEFAULT_MODEL);
  $("gmodel").addEventListener("change", () => settings.set("gmodel", $("gmodel").value));
  $("k").value = String(settings.get("chatK", 4));
  $("k").addEventListener("change", () => settings.set("chatK", +$("k").value));
  $("scope").value = settings.get("chatScope", "uploads");
  $("scope").addEventListener("change", () => settings.set("chatScope", $("scope").value));
  $("askBtn").addEventListener("click", ask);
  $("question").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") ask(); });
  const slider = (id, key, valId, after) => {
    $(id).value = S[key]; $(valId).textContent = (+S[key]).toFixed(2);
    $(id).addEventListener("input", () => { S[key] = +$(id).value; $(valId).textContent = S[key].toFixed(2); settings.set(key, S[key]); after?.(); });
  };
  slider("cutoff", "cutoff", "cutoffVal", reclassify);
  slider("thresh", "threshold", "threshVal", reclassify);
  onModelsReady(() => { $("ingestHint").textContent = "수집 준비 완료. 파일을 선택해 수집하세요."; refreshUploads(); });
}

window.__lrj = { state: S, models: M, ask };

(async () => {
  wire();
  initModelCard();
  try { await refreshUploads(); } catch { /* storage blocked */ }
  try { S.corpus = await loadCorpus(); } catch { /* corpus optional for uploads-only use */ }
  pillIdle(false);
})();
