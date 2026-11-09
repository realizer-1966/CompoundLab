// Evaluation harness: run the pipeline over the labeled sample, score it against the gold labels, cache the run.
import { $, esc, pct, num, settings, M, onModelsReady, initModelCard, loadRecorded, pillIdle, download, yieldToBrowser, bars, LABEL_KO } from "./common.js";
import { loadCorpus, indexCorpus, retrieve, judge, runKey, evidenceRetrieved, expandRecorded, compactRun } from "./pipeline.js";
import { PRESETS, DEFAULT_PRESET, DEFAULT_THRESHOLD, gate, verdictOf } from "./judge.js";
import { evaluate } from "./metrics.js";
import * as db from "./store.js";

const GATE_KO = { AUTO: "자동", BLOCK: "차단", HOLD: "보류" };

const S = {
  corpus: null, runs: new Map(), current: null, running: false, runningSince: 0, stop: false, open: new Set(),
  cutoff: settings.get("cutoff", 0.5), threshold: settings.get("threshold", DEFAULT_THRESHOLD),
};

const rag = () => ({
  sentencesPerChunk: +$("spc").value, overlap: 0, k: +$("k").value, scope: $("scope").value,
  retriever: $("retr").value, w: +$("w").value, rerank: $("rerank").checked,
});

function subsetClaims(which) {
  const cl = S.corpus.claims;
  if (which === "all") return cl;
  if (which === "1") {
    const out = [];
    for (const docId of Object.keys(S.corpus.documents)) {
      const mine = cl.filter((c) => c.docId === docId);
      out.push(...["supported", "not_supported"].map((l) => mine.find((c) => c.label === l)).filter(Boolean));
    }
    return out;
  }
  // quick: 2 documents per dataset, 1 supported + 1 unsupported each -> 12 claims
  const out = [];
  for (const ds of Object.keys(S.corpus.datasets)) {
    for (const docId of Object.keys(S.corpus.documents).filter((d) => S.corpus.documents[d].dataset === ds).slice(0, 2)) {
      const mine = cl.filter((c) => c.docId === docId);
      out.push(mine.find((c) => c.label === "supported"), mine.find((c) => c.label === "not_supported" && c.kind !== "unverifiable") || mine.find((c) => c.label === "not_supported"));
    }
  }
  return out.filter(Boolean);
}

// ---- runs -------------------------------------------------------------------------------------------

const runLabel = (r) => {
  const rg = r.rag || {}; // 예전/orphan 행이 rag 없이 저장될 수 있다 — 방어
  const retr = rg.retriever === "hybrid" ? ` · 하이브리드 w=${(+rg.w || 0.6).toFixed(2)}${rg.rerank ? " + 근접리랭킹" : ""}` : rg.rerank ? " · 근접리랭킹" : "";
  const model = r.model?.variant || (r.kind === "router" ? "라우터" : "?");
  return `${r.source === "recorded" ? "기록됨 · " : ""}${model} · ${PRESETS[r.presetId]?.name.split(":")[0] || r.presetId || r.kind || "실행"} · ${rg.sentencesPerChunk ?? 2}문장/청크 · k=${rg.k ?? "?"} · ${(rg.scope === "corpus" ? "전체 코퍼스" : "문서")}${retr} · ${r.kind === "router" ? `라우팅 질문 ${r.records?.length ?? 0}개` : `주장 ${r.records.length}개`}${r.complete === false ? " (부분)" : ""}`;
};

// Browser runs and recorded runs can share a configuration key; list them separately so neither hides the other.
const runId = (r) => (r.source === "recorded" ? "rec|" : "") + r.key;

function fillRunSelect() {
  const sel = $("runSel"); const cur = S.current && runId(S.current);
  const list = [...S.runs.values()].sort((a, b) => (a.source === "recorded") - (b.source === "recorded") || String(b.createdAt).localeCompare(String(a.createdAt)));
  sel.innerHTML = list.length ? list.map((r) => `<option value="${esc(runId(r))}">${esc(runLabel(r))}</option>`).join("") : "<option value=''>저장된 실행 결과 없음</option>";
  if (cur && S.runs.has(cur)) sel.value = cur;
  $("exportBtn").disabled = !S.current;
}

function select(key) {
  const r = S.runs.get(key); if (!r) return;
  S.current = r; S.open.clear();
  // reflect the run's settings in the controls, so "Run evaluation" resumes / reproduces it
  $("preset").value = r.presetId; $("spc").value = String(r.rag.sentencesPerChunk); $("k").value = String(r.rag.k); $("scope").value = r.rag.scope;
  const rg = r.rag || {};
  $("retr").value = rg.retriever || "cosine"; $("w").value = String(+rg.w || 0.6); $("wVal").textContent = (+rg.w || 0.6).toFixed(2); $("rerank").checked = !!rg.rerank;
  fillRunSelect(); render();
}

/** A subset run never throws away claims a stored run with the same key already judged; merge them in. */
function withPrev(run, prev) {
  if (!prev || prev.source === "recorded") return run;
  const ids = new Set(run.records.map((x) => x.id));
  return { ...run, records: [...run.records, ...prev.records.filter((x) => !ids.has(x.id))], complete: run.complete || prev.complete };
}

async function runEval() {
  // 멈춘 실행 감시: running이 3분 넘게 지속되면 (await가 멈춘 case) 강제 해제해 버튼을 다시 살린다
  if (S.running || S.compareRunning) {
    if (Date.now() - (S.runningSince || 0) > 180000) { S.running = false; S.compareRunning = false; }
    else { $("runHint").textContent = `평가가 진행 중입니다 (${((Date.now() - (S.runningSince || Date.now())) / 1000).toFixed(0)}초 경과) — 진행 기록이 멈춘 것 같으면 중지 버튼을 누르거나 페이지를 새로고침하세요.`; return; }
  }
  if (!M.laya) { $("runHint").textContent = "먼저 모델을 로드하세요 (위의 버튼). 기록된 실행 결과는 '저장된 실행 결과' 아래 목록에 있습니다."; return; }
  // 코퍼스가 아직 로드 전(페이지 로드 직후 클릭)이면 subsetClaims가 조용히 예외를 던져 버튼이 죽은 것처럼 보인다 — 로드 or 안내
  if (!S.corpus) {
    try {
      $("runHint").textContent = "코퍼스를 불러오는 중…";
      S.corpus = await loadCorpus();
      $("fDataset").innerHTML = `<option value="">전체 데이터셋</option>` + Object.entries(S.corpus.datasets).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
    } catch (e) {
      console.error(e); $("runHint").textContent = "코퍼스를 불러오지 못했습니다: " + (e?.message || e) + " — 다시 눌러보세요."; return;
    }
  }
  const r = rag(), presetId = $("preset").value, subset = $("subset").value;
  const key = runKey({ modelVariant: M.model.variant, presetId, rag: r });
  let claims;
  try { claims = subsetClaims(subset); }
  catch (e) { console.error(e); $("runHint").textContent = "샘플을 구성하지 못했습니다: " + (e?.message || e); return; }
  // Resume: reuse any claim already judged under exactly this configuration (browser-made runs only).
  const prev = S.runs.get(key);
  const have = new Map(prev && prev.source !== "recorded" ? prev.records.map((x) => [x.id, x]) : []);
  const run = {
    key, source: "browser", createdAt: new Date().toISOString(), presetId, rag: r, subset,
    model: { variant: M.model.variant, backend: M.model.backend, threads: M.model.threads, embedder: M.embedder.id },
    records: [], complete: false,
  };
  S.runs.set(key, run); S.current = run; S.open.clear(); fillRunSelect();
  S.running = true; S.runningSince = Date.now(); S.stop = false; $("runBtn").disabled = true; $("stopBtn").disabled = false;
  const progress = (i, n, msg) => { $("evalBar").style.width = `${(100 * i / n).toFixed(1)}%`; $("evalCount").textContent = `${i} / ${n}`; if (msg) $("runHint").textContent = msg; };
  try {
    progress(0, claims.length, "코퍼스를 인덱싱하는 중 (청킹 + 임베딩, IndexedDB에 저장)…");
    const ix = await indexCorpus(S.corpus, M.embedder, r, (i, n) => { $("runHint").textContent = `코퍼스를 인덱싱하는 중: ${i} / ${n} 문서…`; });
    $("runHint").textContent = `인덱스 준비 완료: ${ix.chunks}개 구절 (${ix.embedded ? `${ix.embedded}개 새로 임베딩됨` : "모두 IndexedDB에서 가져옴"}). 판별 중…`;
    for (let i = 0; i < claims.length; i++) {
      if (S.stop) break;
      const c = claims[i];
      let rec = have.get(c.id);
      if (!rec) {
        const ret = await retrieve(M.embedder, c.claim, { rag: r, docId: c.docId });
        const j = await judge(M.laya, c.claim, ret.passages, presetId);
        const fp = (x) => +(+x).toFixed(4);
        rec = {
          id: c.id, dataset: S.corpus.documents[c.docId].dataset, docId: c.docId, kind: c.kind, gold: c.label, claim: c.claim,
          passages: ret.passages.map((p) => ({ docId: p.docId, chunk: p.chunk, text: p.text, score: fp(p.score),
            ...(p.keyword != null ? { cosine: fp(p.cosine), keyword: fp(p.keyword) } : {}),
            ...(p.proximity != null ? { proximity: fp(p.proximity) } : {}) })),
          pSupported: j.pSupported, confidence: j.confidence, probabilities: j.probabilities, layaMs: j.layaMs, embedMs: ret.embedMs,
          evidenceHit: evidenceRetrieved(ret.passages, c.evidence),
        };
      }
      run.records.push(rec);
      progress(i + 1, claims.length, `판별 완료 ${i + 1} / ${claims.length}: “${c.claim.slice(0, 60)}${c.claim.length > 60 ? "…" : ""}”`);
      if ((i + 1) % 4 === 0 || i === claims.length - 1) render();
      if ((i + 1) % 8 === 0) db.putMany("runs", [withPrev(run, prev)]).catch(() => {}); // checkpoint, so a closed tab can resume
      await yieldToBrowser(); // keep the tab responsive between model calls
    }
    run.complete = !S.stop && run.records.length === claims.length;
    Object.assign(run, withPrev(run, prev));
    await db.putMany("runs", [run]);
    $("runHint").textContent = S.stop ? `${run.records.length}개 주장 후 중지되었습니다 (저장됨; '평가 실행'을 누르면 이어서 진행).` : `완료. 주장 ${run.records.length}개를 판별해 이 브라우저에 저장했습니다.`;
  } catch (e) {
    console.error(e); $("runHint").textContent = "오류: " + (e?.message || e);
  } finally {
    S.running = false; $("runBtn").disabled = false; $("stopBtn").disabled = true;
    fillRunSelect(); render();
  }
}

// ---- rendering -------------------------------------------------------------------------------------

/** Score labels for the current retriever mode: hybrid passages carry both parts, reranked ones the proximity. */
function scoreLabel(p) {
  const parts = [];
  if (p.cosine != null) parts.push(`cos ${p.cosine.toFixed(3)}`);
  if (p.keyword != null && p.keyword > 0) parts.push(`kw ${p.keyword.toFixed(3)}`);
  if (p.proximity != null) parts.push(`근접 ${p.proximity.toFixed(3)}`);
  return (parts.length ? parts.join(" · ") : `cos ${p.score.toFixed(3)}`) + (parts.length ? ` → ${p.score.toFixed(3)}` : "");
}

function kpi(label, value, sub = "") { return `<div class="kpi"><div class="l">${label}</div><div class="v">${value}${sub ? ` <small>${sub}</small>` : ""}</div></div>`; }

function render() {
  const run = S.current;
  if (!run || !run.records.length) {
    $("runTitle").textContent = "실행 결과 없음"; $("runMeta").textContent = "모델을 로드하고 '평가 실행'을 누르거나, 기록된 실행 결과를 선택하세요.";
    for (const id of ["kpis", "strip", "gates", "coverage", "byDataset", "byKind", "claims"]) $(id).innerHTML = "";
    return;
  }
  const rs = run.records;
  const m = evaluate(rs, { cutoff: S.cutoff, threshold: S.threshold });
  $("runTitle").textContent = `${PRESETS[run.presetId]?.name || run.presetId}`;
  $("runMeta").textContent = `${run.source === "recorded" ? "기록된 결과" : "이 브라우저에서 실행"} · Laya ${run.model.variant}${run.model.backend ? ` (${run.model.backend})` : ""} · 청크당 ${run.rag?.sentencesPerChunk ?? 2}문장, top-${run.rag.k}, ${run.rag.scope === "corpus" ? "전체 코퍼스" : "주장의 문서"} · 주장 ${rs.length}개${run.complete ? "" : " (부분)"}`;
  $("kpis").innerHTML = [
    kpi("정확도", pct(m.accuracy, 1), `${m.confusion.tp + m.confusion.tn}/${m.n}`),
    kpi("균형 정확도", pct(m.balancedAccuracy, 1)),
    kpi("오검증률", pct(m.falseVerificationRate, 1), "미지 지지 → 지지"),
    kpi("AUROC", num(m.auroc), "임계값 무관"),
    kpi("근거 회수율@k", pct(m.evidenceRecall, 0), "골드 구간 검색"),
    kpi("자동 처리", pct(m.automatedShare, 0), `정확도 ${pct(m.automatedAccuracy, 0)}`),
    kpi("판별 지연", m.latency.median == null ? "–" : `${m.latency.median.toFixed(0)}`, `ms 중앙값 · p95 ${m.latency.p95?.toFixed(0)}`),
  ].join("");
  $("bestHint").textContent = m.bestCutoff.balancedAccuracy >= 0 ? `이 실행에서는 컷오프 ${m.bestCutoff.cutoff.toFixed(2)}가 가장 좋은 균형 정확도를 냅니다 (${pct(m.bestCutoff.balancedAccuracy, 1)}). 같은 주장들에 적합한 값이므로 낙관적인 편입니다.` : "";

  $("strip").innerHTML = strip(rs);
  const G = m.gates, n = rs.length;
  $("gates").innerHTML = bars({ AUTO: G.AUTO / n, BLOCK: G.BLOCK / n, HOLD: G.HOLD / n }, null).replace(/<span class="v">([\d.]+)<\/span>/g, (_, v) => `<span class="v">${Math.round(+v * n)}</span>`)
    + `<p class="caption">자동(AUTO) = "지지됨"에 대한 확신, 차단(BLOCK) = "미지 지지"에 대한 확신, 보류(HOLD) = 신뢰도 기준선(${S.threshold.toFixed(2)}) 미만, 사람에게 전달됨. 자동 판정의 정확도: <b>${pct(m.automatedAccuracy, 1)}</b>.</p>`;

  $("coverage").innerHTML = `<table class="grid"><thead><tr><th>신뢰도 ≥</th><th class="r">유지된 주장 수</th><th class="r">커버리지</th><th class="r">정확도</th><th class="r">오검증</th></tr></thead><tbody>${
    m.coverage.map((c) => `<tr${Math.abs(c.threshold - S.threshold) < 1e-9 ? ' class="cur"' : ""}><td>${c.threshold.toFixed(2)}</td><td class="r">${c.kept}</td><td class="r">${pct(c.coverage)}</td><td class="r">${pct(c.accuracy, 1)}</td><td class="r">${pct(c.falseVerificationRate, 1)}</td></tr>`).join("")}</tbody></table>`;
  const groupTable = (rows) => `<table class="grid"><thead><tr><th></th><th class="r">n</th><th class="r">정확도</th><th class="r">균형</th><th class="r">오검증</th></tr></thead><tbody>${
    rows.map((g) => `<tr><td>${esc(g.name)}</td><td class="r">${g.n}</td><td class="r">${pct(g.accuracy, 1)}</td><td class="r">${pct(g.balancedAccuracy, 1)}</td><td class="r">${pct(g.falseVerificationRate, 1)}</td></tr>`).join("")}</tbody></table>`;
  $("byDataset").innerHTML = groupTable(m.byDataset);
  const order = Object.keys(S.corpus.kinds);
  $("byKind").innerHTML = groupTable([...m.byKind].sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name)))
    + `<p class="caption">${order.map((k) => `<b>${k}</b>: ${esc(S.corpus.kinds[k].split(": ")[1])}`).join(" · ")}</p>`;
  renderClaims();
}

function strip(rs) {
  const W = 520, H = 116, L = 110, R = 12, T = 10, rowH = 34;
  const x = (p) => L + p * (W - L - R);
  const rows = [["supported", "골드: 지지됨", "var(--auto)"], ["not_supported", "골드: 미지 지지", "var(--block)"]];
  let s = `<svg viewBox="0 0 ${W} ${H}" class="strip" role="img" aria-label="골드 라벨별 p(지지됨) 분포">`;
  rows.forEach(([lab, name, col], ri) => {
    const cy = T + ri * rowH + rowH / 2;
    s += `<text x="0" y="${cy + 4}">${name}</text><line x1="${L}" x2="${W - R}" y1="${cy}" y2="${cy}" stroke="var(--line)"/>`;
    rs.filter((r) => r.gold === lab).forEach((r, i) => {
      const jitter = ((i * 7919) % 13 - 6) * 1.6;
      const wrong = verdictOf(r.pSupported, S.cutoff) !== r.gold;
      const sel = S.focus === r.id;
      s += `<circle class="dot" data-id="${r.id}" tabindex="0" role="button" aria-label="${esc(r.claim)}, p(지지됨) ${r.pSupported.toFixed(2)}${wrong ? ", 틀린 판정" : ""}. 상세 보기" cx="${x(r.pSupported).toFixed(1)}" cy="${(cy + jitter).toFixed(1)}" r="${sel ? 6 : 4.5}" fill="${col}" fill-opacity="${wrong ? 0.35 : 0.85}" stroke="${sel ? "var(--ink)" : wrong ? col : "none"}" stroke-width="${sel ? 2 : 1}"><title>${esc(r.claim)} — p ${r.pSupported.toFixed(3)} (클릭하면 상세 보기)</title></circle>`;
    });
  });
  const ay = T + 2 * rowH + 8;
  s += `<line x1="${x(S.cutoff)}" x2="${x(S.cutoff)}" y1="${T - 4}" y2="${ay - 4}" stroke="var(--ink)" stroke-dasharray="3 3"/>`;
  for (const t of [0, 0.25, 0.5, 0.75, 1]) s += `<text x="${x(t)}" y="${ay + 10}" text-anchor="middle">${t}</text>`;
  s += `<text x="${x(S.cutoff) + 4}" y="${T + 2}" style="fill:var(--ink)">컷오프 ${S.cutoff.toFixed(2)}</text></svg>`;
  return s;
}

function renderClaims() {
  const run = S.current; if (!run) return;
  const onlyWrong = $("onlyWrong").checked, ds = $("fDataset").value;
  const rows = run.records.filter((r) => (!ds || r.dataset === ds) && (!onlyWrong || verdictOf(r.pSupported, S.cutoff) !== r.gold));
  let html = `<thead><tr><th>주장</th><th>골드</th><th>유형</th><th>p(지지됨)</th><th>판정</th><th>게이트</th><th class="r">ms</th></tr></thead><tbody>`;
  for (const r of rows) {
    const v = verdictOf(r.pSupported, S.cutoff), ok = v === r.gold, g = gate(r.pSupported, r.confidence, { cutoff: S.cutoff, threshold: S.threshold });
    html += `<tr class="claimrow${S.focus === r.id ? " focus" : ""}" data-id="${r.id}" tabindex="0" aria-expanded="${S.open.has(r.id)}"><td class="claim">${esc(r.claim)}</td><td>${LABEL_KO[r.gold] ?? r.gold}</td><td><span class="tag">${esc(r.kind)}</span></td>
      <td><span class="pbar"><i style="width:${(r.pSupported * 100).toFixed(0)}%"></i></span>${r.pSupported.toFixed(3)}</td>
      <td><span class="tag ${ok ? "ok" : "bad"}">${LABEL_KO[v] ?? v}</span></td><td><span class="tag ${g === "AUTO" ? "ok" : g === "BLOCK" ? "bad" : "warn"}">${GATE_KO[g]}</span></td><td class="r">${r.layaMs != null ? r.layaMs.toFixed(0) : "–"}</td></tr>`;
    if (S.open.has(r.id)) {
      const ev = S.corpus.claims.find((c) => c.id === r.id)?.evidence;
      html += `<tr class="detailrow"><td colspan="7"><div style="font-size:12.5px;color:var(--ink2);margin-bottom:4px">${esc(S.corpus.documents[r.docId].title)} · 골드 근거 ${r.evidenceHit == null ? "해당 없음 (검증 불가한 주장)" : r.evidenceHit ? "검색됨 ✓" : "검색되지 않음"} · 신뢰도 ${r.confidence.toFixed(3)}</div>
        <ol class="passages">${r.passages.map((p, i) => `<li class="passage${ev && p.text.includes(ev) ? " gold" : ""}"><span class="rank">${i + 1}</span><div><div class="src">${esc(S.corpus.documents[p.docId]?.title || p.docId)} · 구절 ${p.chunk + 1} · ${scoreLabel(p)}</div><div class="txt">${ev && p.text.includes(ev) ? esc(p.text).replace(esc(ev), `<mark class="ev">${esc(ev)}</mark>`) : esc(p.text)}</div></div></li>`).join("")}</ol>
        ${bars(r.probabilities, Object.entries(r.probabilities).sort((a, b) => b[1] - a[1])[0][0])}</td></tr>`;
    }
  }
  $("claims").innerHTML = html + (rows.length ? "" : `<tr><td colspan="7" class="placeholder">일치하는 주장이 없습니다.</td></tr>`) + "</tbody>";
}

// ---- retrieval comparison (no Laya calls) ---------------------------------------------------------

// The three retrieval modes of the comparison, plus proximity reranking on top — every advancedRagDemo variant,
// each scored on whether the gold evidence span lands in the top-k. Claim embeddings are cached, so all rows share it.
function compareConfigs(r) {
  const base = { sentencesPerChunk: r.sentencesPerChunk, overlap: 0, k: r.k, scope: r.scope };
  return [
    { id: "vector", name: "벡터 전용", rag: { ...base, retriever: "cosine" } },
    { id: "keyword", name: "키워드 전용 (BM25)", rag: { ...base, retriever: "hybrid", w: 0, rerank: false } },
    { id: "hybrid", name: `하이브리드 w=${(+r.w).toFixed(2)}`, rag: { ...base, retriever: "hybrid", w: +r.w, rerank: false } },
    { id: "hybridrr", name: "하이브리드 + 근접 리랭킹", rag: { ...base, retriever: "hybrid", w: +r.w, rerank: true } },
  ];
}

async function runCompare() {
  if (S.compareRunning || S.running) return;
  if (!M.embedder) { $("retrHint").textContent = "임베더가 필요합니다: 위에서 모델을 로드하세요 (판별기 없이 임베더만 내려받게 되는 버전 없음 — 모델 카드의 로드 버튼을 누르세요)."; return; }
  const r = rag();
  S.compareRunning = true; $("retrBtn").disabled = true; S.stop = false;
  $("stopBtn").disabled = false;
  const btn = $("retrBtn");
  try {
    $("retrHint").textContent = "코퍼스를 인덱싱하는 중…";
    await indexCorpus(S.corpus, M.embedder, r, (i, n) => { $("retrHint").textContent = `코퍼스를 인덱싱하는 중: ${i} / ${n} 문서…`; });
    const claims = S.corpus.claims.filter((c) => c.evidence);
    const rows = [];
    for (const cfg of compareConfigs(r)) {
      let hits = 0, rankSum = 0, ms = 0;
      const progress = (i) => { $("retrHint").textContent = `${cfg.name}: ${i} / ${claims.length} 주장 검색 중…`; };
      for (let i = 0; i < claims.length && !S.stop; i++) {
        const ret = await retrieve(M.embedder, claims[i].claim, { rag: cfg.rag, docId: claims[i].docId });
        ms += ret.searchMs;
        const idx = ret.passages.findIndex((p) => p.text.includes(claims[i].evidence));
        if (idx >= 0) { hits++; rankSum += idx + 1; }
        progress(i + 1);
        await yieldToBrowser();
      }
      if (S.stop) { $("retrHint").textContent = "중지되었습니다."; return; }
      rows.push({ ...cfg, n: claims.length, recall: hits / claims.length, avgRank: hits ? rankSum / hits : null, ms: ms / claims.length });
      renderCompare(rows, r.k);
    }
    $("retrHint").textContent = `완료 — 근거가 있는 주장 ${claims.length}개, k=${r.k}, 범위 ${r.scope === "corpus" ? "전체 코퍼스" : "주장의 문서"}. 모든 행이 같은 주장 임베딩을 재사용합니다.`;
  } catch (e) {
    console.error(e); $("retrHint").textContent = "오류: " + (e?.message || e);
  } finally {
    S.compareRunning = false; btn.disabled = false; $("stopBtn").disabled = true;
  }
}

function renderCompare(rows, k) {
  const best = Math.max(...rows.map((r) => r.recall));
  $("retrTable").innerHTML = `<table class="grid"><thead><tr><th>검색기</th><th class="r">근거 회수율@${k}</th><th class="r">평균 골드 순위</th><th class="r">ms/주장</th></tr></thead><tbody>$
    ${rows.map((r) => `<tr${r.recall === best ? ' class="cur"' : ""}><td>${esc(r.name)}</td><td class="r"><b>${pct(r.recall, 1)}</b></td><td class="r">${r.avgRank == null ? "–" : r.avgRank.toFixed(1)}</td><td class="r">${r.ms.toFixed(0)}</td></tr>`).join("")}</tbody></table>`;
}

// ---- wiring ------------------------------------------------------------------------------------------

function wire() {
  $("preset").innerHTML = Object.entries(PRESETS).map(([k, p]) => `<option value="${k}">${esc(p.name)}</option>`).join("");
  $("preset").value = settings.get("preset", DEFAULT_PRESET);
  $("spc").value = String(settings.get("spc", 2)); $("k").value = String(settings.get("k", 3)); $("scope").value = settings.get("scope", "document");
  $("retr").value = settings.get("retr", "cosine"); $("rerank").checked = settings.get("rerank", false);
  $("w").value = String(settings.get("w", 0.6)); $("wVal").textContent = (+settings.get("w", 0.6)).toFixed(2);
  for (const id of ["preset", "spc", "k", "scope", "retr"]) $(id).addEventListener("change", () => settings.set(id, ["spc", "k"].includes(id) ? +$(id).value : $(id).value));
  $("w").addEventListener("input", () => { $("wVal").textContent = +$("w").value === 0 || +$("w").value === 1 ? $("w").value : (+$("w").value).toFixed(2); settings.set("w", +$("w").value); });
  $("rerank").addEventListener("change", () => settings.set("rerank", $("rerank").checked));
  // 클릭은 언제나 피드백을 남긴다 — 조용한 무반응 방지 (runEval 자체도 내부에서 안내를 남긴다)
  // 클릭은 언제나 runEval로 — 진행 중/멈춤 판단(3분 경과 강제 해제 포함)과 안내는 runEval이 남긴다
  $("runBtn").addEventListener("click", () => {
  });
  $("stopBtn").addEventListener("click", () => { S.stop = true; $("runHint").textContent = "현재 주장을 처리한 뒤 중지합니다…"; });
  $("runSel").addEventListener("change", (e) => select(e.target.value));
  $("exportBtn").addEventListener("click", () => { const r = S.current; if (r) download(`laya-rag-judge-${r.presetId}-s${r.rag.sentencesPerChunk}k${r.rag.k}-${r.rag.scope}.json`, JSON.stringify(r, null, 2)); });
  $("clearBtn").addEventListener("click", async () => {
    if (!confirm("이 브라우저에 저장된 구절 인덱스, 주장 임베딩, 평가 실행 결과를 삭제할까요? 기록된 실행 결과는 유지됩니다.")) return;
    await db.clearAll();
    for (const [k, r] of S.runs) if (r.source !== "recorded") S.runs.delete(k);
    S.current = [...S.runs.values()][0] || null; fillRunSelect(); render();
  });
  const slider = (id, key, valId) => {
    $(id).value = S[key]; $(valId).textContent = (+S[key]).toFixed(2);
    $(id).addEventListener("input", () => { S[key] = +$(id).value; $(valId).textContent = S[key].toFixed(2); settings.set(key, S[key]); render(); });
  };
  slider("cutoff", "cutoff", "cutoffVal");
  slider("thresh", "threshold", "threshVal");
  $("retrBtn").addEventListener("click", runCompare);
  $("onlyWrong").addEventListener("change", renderClaims);
  $("fDataset").addEventListener("change", renderClaims);
  // Clicking a dot opens that claim's details in the table below and scrolls to it.
  const openDot = (id) => {
    const r = S.current?.records.find((x) => x.id === id); if (!r) return;
    // clear filters that would hide the row
    if ($("fDataset").value && $("fDataset").value !== r.dataset) $("fDataset").value = "";
    if ($("onlyWrong").checked && verdictOf(r.pSupported, S.cutoff) === r.gold) $("onlyWrong").checked = false;
    S.focus = id; S.open.add(id);
    $("strip").innerHTML = strip(S.current.records); renderClaims();
    const tr = document.querySelector(`#claims .claimrow[data-id="${CSS.escape(id)}"]`);
    tr?.scrollIntoView({ behavior: "smooth", block: "center" }); tr?.focus({ preventScroll: true });
  };
  $("strip").addEventListener("click", (e) => { const d = e.target.closest(".dot"); if (d) openDot(d.dataset.id); });
  $("strip").addEventListener("keydown", (e) => { const d = e.target.closest(".dot"); if (d && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); openDot(d.dataset.id); } });
  $("claims").addEventListener("click", (e) => { const tr = e.target.closest(".claimrow"); if (!tr) return; const id = tr.dataset.id; S.open.has(id) ? S.open.delete(id) : S.open.add(id); renderClaims(); });
  $("claims").addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("claimrow")) { e.preventDefault(); e.target.click(); } });
  globalThis.__lrjBuild = "2026-11-09.5";
  $("runHint").textContent = `빌드 ${globalThis.__lrjBuild} · "평가 실행"을 누르면 주장 ${S.corpus ? "을 판별합니다" : " 데이터를 불러온 뒤 판별합니다"}.`;
  onModelsReady(() => {
    // 평가가 진행 중이면 진행 메시지를 덮어쓰지 않는다 (모델 로드 완료 직후 클릭했을 때 진행 표시가 가려지던 결함)
    if (!S.running && !S.compareRunning)
      $("runHint").textContent = "모델 준비 완료. 설정을 고르고 '평가 실행'을 누르세요.";
  });
}

// Console hook: export every browser run as a recorded.json (see README, "Re-recording").
window.__lrj = {
  state: S, models: M, runEval,
  recorded() {
    const runs = [...S.runs.values()].filter((r) => r.source !== "recorded" && r.complete);
    if (!runs.length) throw new Error("이 브라우저에 완료된 실행 결과가 없습니다");
    const variant = runs[0].model.variant;
    return { model: { variant, judge: M.laya?.kind === "clef" ? `ollama:${M.model.variant}` : "convaiinnovations/laya-multilingual", embedder: runs[0].model.embedder }, createdAt: new Date().toISOString(),
      runs: Object.fromEntries(runs.filter((r) => r.model.variant === variant).map((r) => [r.key, compactRun(r)])) };
  },
};

(async () => {
  wire();
  initModelCard();
  try { S.corpus = await loadCorpus(); } catch (e) { $("runHint").textContent = "코퍼스를 불러오지 못했습니다: " + e.message; return; }
  $("fDataset").innerHTML = `<option value="">전체 데이터셋</option>` + Object.entries(S.corpus.datasets).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  const recorded = expandRecorded(await loadRecorded(), S.corpus);
  if (recorded) for (const r of Object.values(recorded.runs)) S.runs.set("rec|" + r.key, { ...r, source: "recorded" });
  pillIdle(!!recorded);
  try {
    const rows = await db.getAll("runs");
    const broken = rows.filter((r) => !r?.rag || !r?.key);
    if (broken.length) {
      for (const r of broken) await db.del("runs", r.key);
    }
    for (const r of rows) if (r?.rag && r?.key) S.runs.set(r.key, r);
  } catch { /* storage blocked */ }
  const want = runKey({ modelVariant: recorded?.model.variant || "q8e8", presetId: $("preset").value, rag: rag() });
  S.current = S.runs.get(want) || S.runs.get("rec|" + want) || [...S.runs.values()][0] || null;
  if (S.current) select(runId(S.current)); else { fillRunSelect(); render(); }
})();
