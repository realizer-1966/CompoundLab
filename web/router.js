// Router page: Laya picks the knowledge base for a question, retrieval runs inside it, and Laya checks whether the
// passages answer the question. Routing decisions are re-derived from stored probabilities when a slider moves.
import { $, esc, pct, num, settings, M, onModelsReady, initModelCard, pillIdle, bars, yieldToBrowser } from "./common.js";
import { loadCorpus, indexCorpus, runRouter, ROUTER_RAG, compactRouterRecord, expandRouterRecorded } from "./pipeline.js";
import { routerQuestion, ANSWER_CHECK, outcome, routerMetrics, DEFAULT_DECLINE_AT, DEFAULT_KB_THRESHOLD, DEFAULT_ANSWER_CUTOFF } from "./router-core.js";
import { questionKey } from "./judge.js";
import * as db from "./store.js";

const S = {
  corpus: null, router: null, routes: [], fp: "", records: new Map(), sources: new Map(), last: null, selected: null,
  busy: false, stop: false, indexed: false,
  declineAt: settings.get("decl", DEFAULT_DECLINE_AT), kbThreshold: settings.get("kbt", DEFAULT_KB_THRESHOLD), cutoff: settings.get("acut", DEFAULT_ANSWER_CUTOFF),
};
const routeName = (id) => S.routes.find((r) => r.id === id)?.name || id;
const runKey = () => `router|${M.model?.variant || "q8e8"}|${S.fp}`;
const opts = () => ({ declineAt: S.declineAt, kbThreshold: S.kbThreshold, cutoff: S.cutoff });

// ---- setup -------------------------------------------------------------------------------------------

function fillSide() {
  $("routes").innerHTML = S.routes.map((r) => `<li><b>${esc(r.name)}</b><br>${esc(r.note)}</li>`).join("");
  $("examples").innerHTML = "";
  for (const q of S.router.questions) {
    const b = document.createElement("button"); b.type = "button"; b.dataset.id = q.id;
    b.textContent = `${q.question.length > 40 ? q.question.slice(0, 38) + "…" : q.question} [${routeName(q.route)}]`;
    b.title = `${q.question}\n올바른 라우트: ${routeName(q.route)}${q.route !== "none" ? (q.answerable ? " (답변이 들어 있습니다)" : " (답변이 들어 있지 않습니다)") : ""}`;
    b.addEventListener("click", () => pick(q));
    $("examples").appendChild(b);
  }
}

function pick(q) {
  S.selected = q; $("question").value = q.question;
  markActive(); hint();
  const rec = S.records.get(q.id);
  if (rec) show(rec); else { S.last = null; $("placeholder").hidden = false; $("result").hidden = true; }
}
function markActive() { [...$("examples").children].forEach((b) => b.classList.toggle("active", b.dataset.id === S.selected?.id)); }
function hint() {
  if (S.busy) return;
  const q = $("question").value.trim(), rec = S.selected && S.selected.question === q && S.records.get(S.selected.id);
  $("runHint").textContent = M.laya ? "로드된 모델로 이 기기에서 실행합니다."
    : rec ? `모델이 로드되지 않았습니다: 이 예시 질문에는 ${S.sources.get(S.selected.id) === "recorded" ? "기록된" : "저장된"} 결과가 표시됩니다.`
    : "이 질문에는 모델이 필요합니다. 위에서 로드하세요. 한 번 내려받은 뒤에는 캐시에 유지됩니다.";
}

// ---- running ---------------------------------------------------------------------------------------

async function ensureIndex() {
  if (S.indexed) return;
  await indexCorpus(S.corpus, M.embedder, ROUTER_RAG, (i, n) => { $("runHint").textContent = `지식 베이스를 IndexedDB로 인덱싱하는 중: ${i} / ${n} 문서…`; });
  S.indexed = true;
}

async function routeOne() {
  if (S.busy) return;
  const question = $("question").value.trim();
  if (!question) { $("runHint").textContent = "먼저 질문을 입력하세요."; return; }
  if (!M.laya) {
    const rec = S.selected && S.selected.question === question && S.records.get(S.selected.id);
    if (rec) return show(rec);
    $("runHint").textContent = "먼저 모델을 로드하세요 (위의 버튼). 예시 질문은 모델 없이 기록된 결과를 재생합니다.";
    return;
  }
  S.busy = true; $("routeBtn").disabled = true;
  try {
    await ensureIndex();
    const res = await runRouter({ laya: M.laya, embedder: M.embedder, routes: S.routes, question, onStep: (m) => { $("runHint").textContent = m; } });
    const gold = S.selected && S.selected.question === question ? S.selected : null;
    const rec = { ...(gold || { id: null }), ...res };
    if (gold) { S.records.set(gold.id, rec); S.sources.set(gold.id, "live"); await saveRun(); renderEval(); }
    show(rec);
    $("runHint").textContent = "로드된 모델로 이 기기에서 실행합니다.";
  } catch (e) { console.error(e); $("runHint").textContent = "오류: " + (e?.message || e); }
  finally { S.busy = false; $("routeBtn").disabled = false; }
}

async function runAll() {
  if (S.busy) return;
  if (!M.laya) { $("evalMeta").textContent = "질문을 직접 실행하려면 먼저 모델을 로드하세요."; return; }
  S.busy = true; S.stop = false; $("runAllBtn").disabled = true; $("stopBtn").disabled = false; $("routeBtn").disabled = true;
  const qs = S.router.questions;
  try {
    await ensureIndex();
    for (let i = 0; i < qs.length && !S.stop; i++) {
      const q = qs[i];
      if (S.sources.get(q.id) !== "live") {
        const res = await runRouter({ laya: M.laya, embedder: M.embedder, routes: S.routes, question: q.question });
        S.records.set(q.id, { ...q, ...res }); S.sources.set(q.id, "live");
      }
      $("evalBar").style.width = `${(100 * (i + 1) / qs.length).toFixed(1)}%`; $("evalCount").textContent = `${i + 1} / ${qs.length}`;
      if ((i + 1) % 4 === 0 || i === qs.length - 1) { renderEval(); await saveRun(); }
      await yieldToBrowser();
    }
  } catch (e) { console.error(e); $("evalMeta").textContent = "오류: " + (e?.message || e); }
  finally { S.busy = false; $("runAllBtn").disabled = false; $("stopBtn").disabled = true; $("routeBtn").disabled = false; await saveRun(); renderEval(); hint(); }
}

async function saveRun() {
  const live = [...S.records.values()].filter((r) => S.sources.get(r.id) === "live").map(({ routerInput, ...r }) => r);
  if (live.length) await db.putMany("runs", [{ key: runKey(), kind: "router", records: live, savedAt: new Date().toISOString() }]).catch(() => {});
}

// ---- rendering ---------------------------------------------------------------------------------------

const hl = (text, ev) => (ev && text.includes(ev) ? esc(text).replace(esc(ev), `<mark class="ev">${esc(ev)}</mark>`) : esc(text));

function show(rec) {
  S.last = rec;
  $("placeholder").hidden = true; $("result").hidden = false;
  const o = outcome(rec, opts());
  const src = rec.id ? S.sources.get(rec.id) : "live";
  // outcome box
  let cls, k, t, d;
  if (o.kind === "declined") { cls = "human"; k = "검색 없음"; t = "문서에 관한 질문이 아닙니다"; d = `p(검색 없음) ${num(o.pNone)} ≥ ${num(S.declineAt)} 이므로 아무것도 검색하지 않았습니다. 어시스턴트는 문서 없이 답하거나 답변을 거부할 것입니다.`; }
  else if (o.kind === "answered") { cls = "auto"; k = `답변 발견 · ${routeName(o.answer.route)}`; t = "구절이 질문에 답합니다"; d = `p(답변됨) ${num(o.answer.pAnswered)} ≥ ${num(S.cutoff)}. 아래 최상위 구절은 LLM이 답변의 근거로 삼을 근거입니다.`; }
  else if (o.smallTalk) { cls = "human"; k = "문서 안에 없음"; t = "문서가 답하지 않으며, 문서 없이도 처리될 수 있습니다"; d = `"검색 없음"이 라우터의 최상위 선택(p ${num(o.pNone)})이었지만 ${num(S.declineAt)} 기준선 미만이라, 안전을 위해 ${o.searched.map(routeName).join("과 ")}를 검색했습니다. 최고 p(답변됨) ${o.answer ? num(o.answer.pAnswered) : "–"} < ${num(S.cutoff)}: 문서의 구절이 제공되지 않습니다. 어시스턴트는 문서 없이 답하거나 모른다고 말해야 합니다.`; }
  else { cls = "block"; k = "찾지 못함"; t = "검색한 지식 베이스가 답하지 않습니다"; d = `${o.searched.map(routeName).join("과 ")}에서 최고 p(답변됨) ${o.answer ? num(o.answer.pAnswered) : "–"} < ${num(S.cutoff)}. 어시스턴트는 추측하지 말고 모른다고 말해야 합니다.`; }
  const gold = rec.route ? `<div class="verdictline">올바른 라우트: <b>${esc(routeName(rec.route))}</b>${rec.route !== "none" ? ` <span class="tag">${rec.answerable ? "답변이 들어 있음" : "답변이 들어 있지 않음"}</span>` : ""} ${o.correct ? '<span class="tag ok">라우터가 올바르게 판단했습니다</span>' : '<span class="tag bad">라우터가 잘못 판단했습니다</span>'}${src === "recorded" ? ' <span class="tag warn">기록된 결과</span>' : ""}</div>` : "";
  $("outcome").innerHTML = `<div class="outcome ${cls}"><div class="k">${esc(k)}</div><div class="t">${esc(t)}</div><div class="d">${esc(d)}</div>${gold}</div>`;

  // router
  $("routerMeta").textContent = `${o.declined ? `p(검색 없음) ${num(o.pNone)} ≥ ${num(S.declineAt)}: 검색 건너뜀` : `p(검색 없음) ${num(o.pNone)} < ${num(S.declineAt)}: 검색 실행. ${routeName(o.topKb)}가 지식 베이스 확률의 ${pct(o.share)}를 차지하며, ${o.confident ? `≥ ${pct(S.kbThreshold)}: 이 라우트만 검색` : `< ${pct(S.kbThreshold)}: 상위 두 개를 검색`}`}${rec.routerMs ? ` · ${Math.round(rec.routerMs)} ms` : ""}`;
  $("routeflow").innerHTML = S.routes.map((r) => {
    const c = o.declined && r.id === "none" ? "declined" : o.searched.includes(r.id) ? "searched" : "";
    return `<div class="rt ${c}${r.id === o.primary ? " top" : ""}"><b>${esc(r.name)}</b>${pct(rec.routeProbs[r.id])}${o.searched.includes(r.id) ? " · 검색됨" : o.declined && r.id === "none" ? " · 선택됨" : ""}</div>`;
  }).join("");
  $("routeProbs").innerHTML = bars(Object.fromEntries(S.routes.map((r) => [r.name, rec.routeProbs[r.id]])), routeName(o.primary));
  const inp = rec.routerInput;
  $("rseqNote").textContent = inp ? `${inp.ids.length} 토큰. 각 [MASK]가 라우트 하나이며, Laya는 네 라우트를 한 번에 채점합니다.` : "기록된 결과: 정확한 토큰 시퀀스를 보려면 모델을 로드하고 질문을 다시 라우팅하세요.";
  $("rseq").textContent = inp ? inp.text.replace(/\s*(\[SEP\])\s*/g, "\n$1\n").replace(/\s*(\[MASK\])/g, "\n$1").trim() : "";

  // retrieval + answer check per knowledge base (the two most likely ones are always computed)
  const ids = Object.keys(rec.perRoute).sort((a, b) => rec.routeProbs[b] - rec.routeProbs[a]);
  $("searchMeta").textContent = o.declined ? "검색하지 않음" : `검색한 라우트: ${o.searched.map(routeName).join(" + ")}`;
  $("searched").innerHTML = ids.map((id) => {
    const x = rec.perRoute[id], route = S.routes.find((r) => r.id === id), searched = o.searched.includes(id);
    const best = o.answer && o.answer.route === id && o.kind === "answered";
    const passages = x.passages.map((p, i) => `<li class="passage${rec.evidence && p.text.includes(rec.evidence) ? " gold" : ""}"><span class="rank">${i + 1}</span><div>
      <div class="src"><span>${esc(S.corpus.documents[p.docId]?.title || p.docId)} · 구절 ${p.chunk + 1}</span><span>cos ${num(p.cosine, 3)}</span>${p.keyword != null ? `<span>BM25 ${num(p.keyword, 2)}</span><span>하이브리드 ${num(p.score, 3)}</span>` : ""}${rec.evidence && p.text.includes(rec.evidence) ? '<span class="tag ok">답변 포함</span>' : ""}</div>
      <div class="txt">${hl(p.text, rec.evidence)}</div></div></li>`).join("");
    return `<div class="routecol${best ? " best" : ""}" style="${searched ? "" : "opacity:.55"}">
      <h4>${esc(route.name)} <span class="tag">${route.retriever === "hybrid" ? "하이브리드: 코사인 + BM25" : "밀집: 코사인"}</span>${searched ? '<span class="tag ok">검색됨</span>' : '<span class="tag">이 기준선에서는 검색하지 않음</span>'}${best ? '<span class="tag ok">답변을 여기서 가져옴</span>' : ""}</h4>
      <ol class="passages">${passages}</ol>
      <div style="margin-top:6px">${bars({ answered: x.pAnswered, not_answered: 1 - x.pAnswered }, x.pAnswered >= S.cutoff ? "answered" : "not_answered")}</div></div>`;
  }).join("") || '<p class="hint">검색된 지식 베이스가 없습니다.</p>';
  markActive();
}

function renderEval() {
  const recs = S.router.questions.map((q) => S.records.get(q.id)).filter(Boolean);
  const nLive = recs.filter((r) => S.sources.get(r.id) === "live").length;
  $("evalMeta").textContent = recs.length ? `${S.router.questions.length}개 질문 중 ${recs.length}개 · ${nLive === recs.length ? "모두 이 브라우저에서 실행" : nLive ? `이 브라우저에서 ${nLive}개 실행, 나머지는 기록된 결과` : "기록된 결과"}` : "결과가 없습니다. 모델을 로드하고 '전체 질문 실행'을 누르세요.";
  if (!recs.length) { for (const id of ["rkpis", "confusion", "perRoute", "rtable"]) $(id).innerHTML = ""; return; }
  const m = routerMetrics(recs, S.routes, opts());
  const kpi = (l, v, s = "") => `<div class="kpi"><div class="l">${l}</div><div class="v">${v}${s ? ` <small>${s}</small>` : ""}</div></div>`;
  $("rkpis").innerHTML = [
    kpi("최종 결과 일치", pct(m.endToEnd, 0), "올바른 최종 결과"),
    kpi("지식 베이스 선택", pct(m.kbChoiceAccuracy, 0), "최상위 지식 베이스가 정확"),
    kpi("옳은 지식 베이스 검색", pct(m.goldSearched, 0), `팬아웃 ${m.fanOut}개 포함`),
    kpi("잡담 처리", pct(m.smallTalkHandled, 0), `${m.smallTalkSkipped}개를 즉시 건너뜀`),
    kpi("답변 확인", pct(m.answerCheckAccuracy, 0), "답변 가능 여부 판정"),
    kpi("근거 회수율@3", pct(m.evidenceRecall, 0), "답변 검색됨"),
  ].join("");
  const ids = S.routes.map((r) => r.id);
  $("confusion").innerHTML = `<table class="grid"><thead><tr><th>정답 ↓ / 라우팅 →</th>${ids.map((id) => `<th class="r">${esc(routeName(id).replace(" RAG", ""))}</th>`).join("")}</tr></thead><tbody>${
    ids.map((g) => `<tr><td>${esc(routeName(g))}</td>${ids.map((p) => `<td class="r${g === p ? " diag" : ""}">${m.confusion[g][p] || (g === p ? 0 : "·")}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  $("perRoute").innerHTML = `<table class="grid"><thead><tr><th>올바른 라우트</th><th class="r">질문 수</th><th class="r">보내진 비율</th><th class="r">최종 결과 일치</th></tr></thead><tbody>${
    m.perRoute.map((r) => `<tr><td>${esc(routeName(r.id))}</td><td class="r">${r.n}</td><td class="r">${pct(r.routed, 0)}</td><td class="r">${pct(r.correct, 0)}</td></tr>`).join("")}</tbody></table>
    <p class="caption">답변 가능한 질문 중 올바른 구절에서 답한 비율: <b>${pct(m.answeredCorrectly, 0)}</b>. 답변 불가 질문을 '찾지 못함'으로 올바르게 보고한 비율: <b>${pct(m.notFoundCorrectly, 0)}</b>. 지식 질문을 잘못 건너뛴 횟수: ${m.wronglySkipped}. 잡담의 경우, "최종 결과 일치"는 문서 구절이 답변으로 제공되지 않았다는 뜻입니다.</p>`;
  $("rtable").innerHTML = `<thead><tr><th>질문</th><th>올바른 라우트</th><th>보냄</th><th>검색</th><th>결과</th><th></th></tr></thead><tbody>${
    m.outs.map(({ r, o }) => `<tr class="rrow" data-id="${r.id}" tabindex="0"><td>${esc(r.question)}</td><td>${esc(routeName(r.route))}${r.route !== "none" ? (r.answerable ? "" : " <span class=\"tag\">답변 없음</span>") : ""}</td>
      <td>${esc(routeName(o.primary))} <small>${o.declined ? num(o.pNone) : pct(o.share)}</small></td><td>${o.declined ? "–" : o.searched.map((id) => esc(routeName(id).replace(" RAG", ""))).join(" + ")}</td>
      <td>${o.kind === "answered" ? `답변됨 (${esc(routeName(o.answer.route))})` : o.kind === "declined" ? "검색 없음" : "찾지 못함"}</td><td><span class="tag ${o.correct ? "ok" : "bad"}">${o.correct ? "일치" : "불일치"}</span></td></tr>`).join("")}</tbody>`;
}

// ---- wiring -------------------------------------------------------------------------------------------

function wire() {
  $("routeBtn").addEventListener("click", routeOne);
  $("runAllBtn").addEventListener("click", runAll);
  $("stopBtn").addEventListener("click", () => { S.stop = true; });
  $("question").addEventListener("input", () => { if (S.selected && $("question").value.trim() !== S.selected.question) { S.selected = null; markActive(); } hint(); });
  $("question").addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.key === "Enter") routeOne(); });
  const slider = (id, key, valId) => {
    $(id).value = S[key]; $(valId).textContent = (+S[key]).toFixed(2);
    $(id).addEventListener("input", () => { S[key] = +$(id).value; $(valId).textContent = S[key].toFixed(2); settings.set(id, S[key]); if (S.last) show(S.last); renderEval(); });
  };
  slider("decl", "declineAt", "declVal");
  slider("kbt", "kbThreshold", "kbtVal");
  slider("acut", "cutoff", "acutVal");
  $("rtable").addEventListener("click", (e) => {
    const tr = e.target.closest(".rrow"); if (!tr) return;
    const q = S.router.questions.find((x) => x.id === tr.dataset.id); pick(q);
    $("resultCard").scrollIntoView({ behavior: "smooth", block: "start" });
  });
  $("rtable").addEventListener("keydown", (e) => { if ((e.key === "Enter" || e.key === " ") && e.target.classList.contains("rrow")) { e.preventDefault(); e.target.click(); } });
  onModelsReady(hint);
}

// Console hook: export the live run as router-recorded.json (see README).
window.__lrj = {
  state: S, models: M, routeOne, runAll,
  routerRecorded() {
    const recs = S.router.questions.map((q) => S.records.get(q.id)).filter((r) => r && S.sources.get(r.id) === "live");
    return { model: { variant: M.model?.variant || "q8e8", judge: "VishalMysore/layaForWebTrained", embedder: M.embedder?.id }, fingerprint: S.fp, createdAt: new Date().toISOString(), records: recs.map(compactRouterRecord) };
  },
};

(async () => {
  wire();
  initModelCard();
  try {
    S.corpus = await loadCorpus();
    S.router = await (await fetch("./router.json", { cache: "no-cache" })).json();
  } catch (e) { $("runHint").textContent = "데이터를 불러오지 못했습니다: " + e.message; return; }
  S.routes = S.router.routes;
  S.fp = questionKey({ router: routerQuestion(S.routes), check: ANSWER_CHECK });
  let recorded = null;
  try { const r = await fetch("./router-recorded.json", { cache: "no-cache" }); if (r.ok) recorded = await r.json(); } catch { /* optional */ }
  if (recorded && recorded.fingerprint === S.fp) {
    for (const rec of expandRouterRecorded(recorded, S.corpus, S.router).records) { S.records.set(rec.id, rec); S.sources.set(rec.id, "recorded"); }
  }
  try {
    const run = await db.get("runs", runKey());
    if (run) for (const rec of run.records) { const q = S.router.questions.find((x) => x.id === rec.id); if (q) { S.records.set(rec.id, { ...rec, ...q }); S.sources.set(rec.id, "live"); } }
  } catch { /* storage blocked */ }
  pillIdle(S.records.size > 0);
  fillSide();
  renderEval();
  pick(S.router.questions[0]);
})();
