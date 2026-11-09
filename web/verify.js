// "주장 검증" 페이지: 주장 하나를 전체 파이프라인에 통과시키고, 모든 중간 단계를 화면에 보여줍니다.
import { $, esc, num, settings, M, onModelsReady, initModelCard, loadRecorded, pillIdle, bars, GATE_TEXT, LABEL_KO } from "./common.js";
import { loadCorpus, indexCorpus, retrieve, judge, adHocPool, runKey, evidenceRetrieved, expandRecorded } from "./pipeline.js";
import { PRESETS, DEFAULT_PRESET, DEFAULT_THRESHOLD, gate, verdictOf } from "./judge.js";
import { chunkText } from "./rag.js";

const S = {
  corpus: null, recorded: null, last: null, busy: false, indexed: new Set(),
  cutoff: settings.get("cutoff", 0.5), threshold: settings.get("threshold", DEFAULT_THRESHOLD),
  selected: null, // claim object from the corpus, if the textarea still holds it
};

const rag = () => ({
  sentencesPerChunk: +$("spc").value, overlap: 0, k: +$("k").value, scope: source() === "corpus" ? "corpus" : "document",
  retriever: $("retr").value, w: +$("w").value, rerank: $("rerank").checked,
});
const source = () => document.querySelector("input[name=source]:checked").value;
const preset = () => $("preset").value;

// ---- setup ----------------------------------------------------------------------------------------

function fillControls() {
  const c = S.corpus;
  $("dataset").innerHTML = Object.entries(c.datasets).map(([k, v]) => `<option value="${k}">${esc(v)} (${c.claims.filter((x) => c.documents[x.docId].dataset === k).length})</option>`).join("");
  $("doc").innerHTML = Object.entries(c.datasets).map(([k, v]) => `<optgroup label="${esc(v)}">${Object.entries(c.documents).filter(([, d]) => d.dataset === k).map(([id, d]) => `<option value="${id}">${esc(d.title)}</option>`).join("")}</optgroup>`).join("");
  $("preset").innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.name.split(":")[0])}</option>`).join("");
  $("preset").value = settings.get("preset", DEFAULT_PRESET);
  $("spc").value = String(settings.get("spc", 2)); $("k").value = String(settings.get("k", 3));
  presetHint();
  $("dataset").value = settings.get("dataset", Object.keys(c.datasets)[0]);
  fillExamples();
}

function fillExamples() {
  const c = S.corpus, ds = $("dataset").value;
  settings.set("dataset", ds);
  const list = c.claims.filter((x) => c.documents[x.docId].dataset === ds);
  $("examples").innerHTML = "";
  for (const cl of list) {
    const b = document.createElement("button"); b.type = "button";
    b.textContent = cl.claim.length > 44 ? cl.claim.slice(0, 42) + "…" : cl.claim;
    b.title = `${c.documents[cl.docId].title}: ${cl.claim}`;
    b.dataset.id = cl.id;
    b.addEventListener("click", () => pick(cl));
    $("examples").appendChild(b);
  }
  markActive();
}

function pick(cl) {
  S.selected = cl;
  $("claim").value = cl.claim;
  $("doc").value = cl.docId;
  if (source() === "pasted") document.querySelector("input[name=source][value=document]").checked = true;
  sourceChanged();
  markActive(); hint();
  // Show a recorded result straight away when the models are not loaded yet.
  const r = !M.laya && recordedFor();
  if (r) show(r);
  else { S.last = null; $("placeholder").hidden = false; $("result").hidden = true; }
}

function markActive() { [...$("examples").children].forEach((b) => b.classList.toggle("active", b.dataset.id === S.selected?.id)); }
function presetHint() { $("presetHint").textContent = PRESETS[preset()].name + ". 평가 페이지에서 이 표현들의 차이를 비교합니다."; }
function sourceChanged() { const s = source(); $("docField").hidden = s !== "document"; $("pasteField").hidden = s !== "pasted"; hint(); }

function recordedFor() {
  const cl = S.selected;
  if (!cl || !S.recorded || source() === "pasted" || $("claim").value.trim() !== cl.claim) return null;
  const key = runKey({ modelVariant: S.recorded.model.variant, presetId: preset(), rag: rag() });
  const run = S.recorded.runs[key];
  const rec = run?.records.find((r) => r.id === cl.id);
  if (!rec || (source() === "document" && $("doc").value !== cl.docId)) return null;
  return { ...rec, source: "recorded", question: PRESETS[preset()].question, state: { claim: rec.claim, evidence: rec.passages.map((p) => p.text) }, rag: run.rag, docId: cl.docId, presetId: preset() };
}

function hint() {
  const h = $("runHint");
  if (S.busy) return;
  if (M.laya) h.textContent = "로드된 모델로 이 기기에서 실행합니다.";
  else if (recordedFor()) h.textContent = "모델이 로드되지 않았습니다: 이 예시 주장은 같은 설정으로 기록된 결과를 재생합니다.";
  else h.textContent = "이 주장에는 모델이 필요합니다 (직접 입력한 주장, 붙여넣은 텍스트, 또는 기록이 없는 설정). 위에서 모델을 로드하세요. 한 번 내려받은 뒤에는 캐시에 유지됩니다.";
}

// ---- running ---------------------------------------------------------------------------------------

async function verify() {
  if (S.busy) return;
  const claim = $("claim").value.trim();
  if (!claim) { $("runHint").textContent = "먼저 주장을 입력하세요."; return; }
  if (!M.laya) {
    const r = recordedFor();
    if (r) return show(r);
    $("runHint").textContent = "먼저 모델을 로드하세요 (위의 버튼). 기본 설정의 예시 주장은 모델 없이 기록된 결과를 재생합니다.";
    return;
  }
  S.busy = true; $("verifyBtn").disabled = true;
  try {
    const r = rag(), src = source();
    let pool = null, docId = null;
    if (src === "pasted") {
      const text = $("pasted").value.trim();
      if (!text) throw new Error("먼저 근거 텍스트를 붙여넣으세요.");
      $("runHint").textContent = "입력한 텍스트를 청크로 나누어 임베딩하는 중…";
      pool = await adHocPool(M.embedder, text, r);
    } else {
      docId = $("doc").value;
      const cfgKey = `${r.sentencesPerChunk}`;
      if (!S.indexed.has(cfgKey)) {
        await indexCorpus(S.corpus, M.embedder, r, (i, n) => { $("runHint").textContent = `코퍼스를 IndexedDB로 인덱싱하는 중: ${i} / ${n} 문서…`; });
        S.indexed.add(cfgKey);
      }
    }
    $("runHint").textContent = "근거를 검색하는 중…";
    const ret = await retrieve(M.embedder, claim, { rag: r, docId, pool });
    $("runHint").textContent = "Laya에 질문하는 중…";
    const j = await judge(M.laya, claim, ret.passages, preset());
    const cl = S.selected && S.selected.claim === claim ? S.selected : null;
    show({
      source: "model", claim, passages: ret.passages, ranked: ret.ranked, input: j.input, candidates: ret.candidates, embedMs: ret.embedMs, searchMs: ret.searchMs,
      pSupported: j.pSupported, confidence: j.confidence, probabilities: j.probabilities, layaMs: j.layaMs, tokens: j.tokens,
      question: j.question, state: j.state, rag: r, docId: src === "pasted" ? null : (r.scope === "corpus" ? null : docId), pasted: src === "pasted" ? $("pasted").value : null,
      gold: cl?.label, kind: cl?.kind, evidence: cl?.evidence, id: cl?.id, presetId: preset(),
    });
    $("runHint").textContent = "로드된 모델로 이 기기에서 실행합니다.";
  } catch (e) {
    console.error(e);
    $("runHint").textContent = "오류: " + (e?.message || e);
  } finally { S.busy = false; $("verifyBtn").disabled = false; }
}

// ---- rendering ---------------------------------------------------------------------------------------

function show(res) {
  S.last = res;
  $("placeholder").hidden = true; $("result").hidden = false;
  const c = S.corpus;
  const cl = res.id ? c.claims.find((x) => x.id === res.id) : null;
  const gold = res.gold ?? cl?.label, evidence = res.evidence ?? cl?.evidence;
  const g = gate(res.pSupported, res.confidence, { cutoff: S.cutoff, threshold: S.threshold });
  const verdict = verdictOf(res.pSupported, S.cutoff);
  const G = GATE_TEXT[g];
  const correct = gold ? verdict === gold : null;
  $("outcome").innerHTML = `<div class="outcome ${G.cls}"><div class="k">${G.k}</div><div class="t">${g === "HOLD" ? `“${LABEL_KO[verdict]}”로 기울지만 실행할 만큼 확신이 부족합니다` : esc(G.t)}</div>
    <div class="d">p(지지됨) ${num(res.pSupported)} ${verdict === "supported" ? "≥" : "<"} 컷오프 ${num(S.cutoff)} → <b>${LABEL_KO[verdict]}</b>; 신뢰도 ${num(res.confidence, 3)} ${res.confidence >= S.threshold ? "≥" : "<"} ${num(S.threshold)}. ${esc(G.d)}</div>
    ${gold ? `<div class="verdictline">정답 (예시 주장): <b>${LABEL_KO[gold] ?? gold.replace("_", " ")}</b> <span class="tag">${esc(res.kind || cl?.kind || "")}</span> ${correct ? '<span class="tag ok">판정이 정답과 일치합니다</span>' : '<span class="tag bad">판정이 틀렸습니다</span>'}${res.source === "recorded" ? ' <span class="tag warn">기록된 결과</span>' : ""}</div>` : res.source === "recorded" ? '<div class="verdictline"><span class="tag warn">기록된 결과</span></div>' : ""}
  </div>`;

  const hit = evidence ? evidenceRetrieved(res.passages, evidence) : null;
  const retrName = res.rag.retriever === "hybrid"
    ? `하이브리드 (벡터 w=${(res.rag.w ?? 0.6).toFixed(2)} + BM25)${res.rag.rerank ? " + 근접 리랭킹" : ""}`
    : `코사인 (벡터 전용)${res.rag.rerank ? " + 근접 리랭킹" : ""}`;
  $("retrMeta").textContent = `${retrName} 기준 top ${res.passages.length}${res.candidates ? ` / ${res.candidates}개 구절` : ""} · 청크당 ${res.rag.sentencesPerChunk}문장${res.embedMs == null ? "" : res.embedMs >= 1 ? ` · 주장 임베딩 ${res.embedMs.toFixed(0)} ms` : " · 주장 임베딩을 IndexedDB에서 재사용"}${hit == null ? "" : hit ? " · 골드 근거 검색됨 ✓" : " · 골드 근거 검색되지 않음"}`;
  $("passages").innerHTML = res.passages.map((p, i) => {
    const doc = c.documents[p.docId];
    const isGold = evidence && p.text.includes(evidence);
    return `<li class="passage${isGold ? " gold" : ""}"><span class="rank">${i + 1}</span><div>
      <div class="src"><span>${esc(doc ? doc.title : "직접 입력한 텍스트")} · 구절 ${p.chunk + 1}</span><span class="score"><span class="tr"><span class="f" style="width:${Math.max(0, p.score) * 100}%"></span></span>${scoreLabel(p)}</span>${isGold ? '<span class="tag ok">골드 근거 포함</span>' : ""}</div>
      <div class="txt">${highlight(p.text, evidence)}</div></div></li>`;
  }).join("");

  $("judgeMeta").textContent = `${PRESETS[res.presetId || preset()].name}${res.layaMs != null ? ` · ${res.layaMs.toFixed(0)} ms` : ""}${res.tokens ? ` · ${res.tokens} 토큰` : ""}`;
  const sel = Object.entries(res.probabilities).sort((a, b) => b[1] - a[1])[0][0];
  $("probs").innerHTML = bars(res.probabilities, sel);
  $("qjson").textContent = JSON.stringify({ question: res.question, state: res.state }, null, 2);
  renderInput(res);
  renderAll(res, evidence);

  // Source document with retrieved passages marked (one document, or each document that contributed).
  const docIds = res.pasted != null ? [] : [...new Set(res.passages.map((p) => p.docId))];
  if (res.pasted != null) {
    $("docview").innerHTML = res.passages.map((p, i) => `<mark>${esc(p.text)}<sup>${i + 1}</sup></mark>`).join(" … ");
  } else {
    $("docview").innerHTML = docIds.map((id) => {
      const d = c.documents[id];
      let html = esc(d.text);
      res.passages.forEach((p, i) => { if (p.docId === id) html = html.replace(esc(p.text), `<mark>${esc(p.text)}<sup>${i + 1}</sup></mark>`); });
      if (evidence && id === (cl?.docId || res.docId)) html = html.replace(esc(evidence), `<mark class="ev">${esc(evidence)}</mark>`);
      return `<div style="margin-bottom:8px"><b>${esc(d.title)}</b> <span class="tag">${esc(c.datasets[d.dataset])}</span><br>${html}</div>`;
    }).join("");
  }
  $("evNote").textContent = evidence ? "; 골드 근거 구간에 밑줄이 그어집니다" : "";
  markActive(); hint();
}

/** Every passage in the search pool, ranked, so you can see what the top-k was chosen from and where it was cut. */
function renderAll(res, evidence) {
  let list = res.passages, note;
  if (!res.ranked) {
    // recorded results store only the top-k; rebuild the document's passages (no scores for the rest)
    const docId = res.docId || res.passages[0]?.docId;
    const doc = docId && S.corpus.documents[docId];
    list = doc ? chunkText(doc.text, res.rag).map((c) => ({ docId, chunk: c.index, text: c.text, score: res.passages.find((p) => p.docId === docId && p.chunk === c.index)?.score ?? null })) : [];
    note = "기록된 결과: top-k 점수만 저장되어 있습니다. 모델을 로드하고 다시 검증하면 모든 점수를 볼 수 있습니다.";
  } else { list = res.ranked; note = `${res.rag.retriever === "hybrid" ? "융합 점수 (벡터·BM25)" : "코사인 유사도"}·${res.rag.rerank ? "근접성" : "1차 점수"} 순으로 정렬되었습니다. 처음 ${res.passages.length}개(구분선 위)가 Laya로 전송되었습니다.`; }
  $("allSum").textContent = `주장과 비교한 모든 구절 (${list.length})`;
  $("allNote").textContent = note;
  const k = res.passages.length, sent = new Set(res.passages.map((p) => `${p.docId}|${p.chunk}`));
  $("allPassages").innerHTML = list.slice(0, 40).map((p, i) => {
    const used = sent.has(`${p.docId}|${p.chunk}`);
    return `<li class="passage" style="${used ? "" : "opacity:.6"}${res.ranked && i === k ? ";border-top:2px dashed var(--accent)" : ""}"><span class="rank">${res.ranked ? i + 1 : p.chunk + 1}</span><div>
      <div class="src"><span>${esc(S.corpus.documents[p.docId]?.title || "직접 입력한 텍스트")} · 구절 ${p.chunk + 1}</span>${p.score != null ? `<span>${scoreLabel(p)}</span>` : ""}${used ? '<span class="tag ok">Laya로 전송됨</span>' : '<span class="tag">전송되지 않음</span>'}</div>
      <div class="txt">${highlight(p.text, evidence)}</div></div></li>`;
  }).join("") + (list.length > 40 ? `<li class="hint">…그 외 ${list.length - 40}개.</li>` : "");
}

/** The literal model input, with the special tokens that structure it called out. */
function renderInput(res) {
  const inp = res.input;
  if (!inp) {
    $("seqNote").textContent = res.source === "model"
      ? "Ollama Clef 판별기는 토큰 시퀀스를 노출하지 않습니다. 질문과 상태는 바로 위의 JSON에서 볼 수 있습니다."
      : "기록된 결과입니다. 디코딩된 토큰 시퀀스를 보려면 Laya의 토크나이저가 필요합니다: 모델을 로드하고 다시 검증하세요.";
    $("seqText").textContent = "";
    return;
  }
  $("seqNote").innerHTML = `${inp.ids.length} 토큰 (제한 ${inp.maxLen})${inp.truncated ? ' · <b>절단됨: 근거 끝부분이 잘렸습니다</b>' : ""}. 구성: <code>[CLS]</code> 질문 <code>[SEP]</code> 선택지마다 하나의 <code>[MASK]</code> (Laya는 각 선택지를 그 [MASK] 위치에서 채점합니다) <code>[SEP]</code> JSON 형식의 상태 <code>[SEP]</code>.`;
  $("seqText").textContent = inp.text.replace(/\s*(\[SEP\])\s*/g, "\n$1\n").replace(/\s*(\[MASK\])/g, "\n$1").trim();
}

function highlight(text, ev) {
  if (!ev || !text.includes(ev)) return esc(text);
  return esc(text).replace(esc(ev), `<mark class="ev">${esc(ev)}</mark>`);
}

/** Score labels for the current retriever mode: hybrid passages carry both parts, reranked ones the proximity. */
function scoreLabel(p) {
  const parts = [];
  if (p.cosine != null) parts.push(`cos ${p.cosine.toFixed(3)}`);
  if (p.keyword != null && p.keyword > 0) parts.push(`kw ${p.keyword.toFixed(3)}`);
  if (p.proximity != null) parts.push(`근접 ${p.proximity.toFixed(3)}`);
  return (parts.length ? parts.join(" · ") : `cos ${p.score.toFixed(3)}`) + (parts.length ? ` → ${p.score.toFixed(3)}` : "");
}

// ---- wiring ------------------------------------------------------------------------------------------

function wire() {
  $("dataset").addEventListener("change", fillExamples);
  $("verifyBtn").addEventListener("click", verify);
  $("claim").addEventListener("input", () => { if (S.selected && $("claim").value.trim() !== S.selected.claim) { S.selected = null; markActive(); } hint(); });
  $("claim").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") verify(); });
  document.querySelectorAll("input[name=source]").forEach((r) => r.addEventListener("change", sourceChanged));
  $("doc").addEventListener("change", hint);
  for (const [id, key] of [["spc", "spc"], ["k", "k"], ["preset", "preset"], ["retr", "retr"]]) $(id).addEventListener("change", () => {
    settings.set(key, ["spc", "k"].includes(key) ? +$(id).value : $(id).value);
    if (key === "preset") presetHint();
    hint();
  });
  $("w").value = String(settings.get("w", 0.6)); $("wVal").textContent = (+settings.get("w", 0.6)).toFixed(2);
  $("w").addEventListener("input", () => { $("wVal").textContent = (+$("w").value).toFixed(2); settings.set("w", +$("w").value); });
  $("rerank").checked = settings.get("rerank", false);
  $("rerank").addEventListener("change", () => settings.set("rerank", $("rerank").checked));
  const slider = (id, key, valId) => {
    $(id).value = S[key]; $(valId).textContent = (+S[key]).toFixed(2);
    $(id).addEventListener("input", () => { S[key] = +$(id).value; $(valId).textContent = S[key].toFixed(2); settings.set(key, S[key]); if (S.last) show(S.last); });
  };
  slider("cutoff", "cutoff", "cutoffVal");
  slider("thresh", "threshold", "threshVal");
  onModelsReady(hint);
}

window.__lrj = { state: S, models: M, verify };

(async () => {
  wire();
  initModelCard();
  try { S.corpus = await loadCorpus(); } catch (e) { $("runHint").textContent = "코퍼스를 불러오지 못했습니다: " + e.message; return; }
  S.recorded = expandRecorded(await loadRecorded(), S.corpus);
  pillIdle(!!S.recorded);
  fillControls();
  const first = S.corpus.claims.find((x) => S.corpus.documents[x.docId].dataset === $("dataset").value);
  if (first) pick(first);
})();
