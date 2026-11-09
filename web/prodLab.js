// prodLab.js — Production Problems in RAG: 계속 바뀌는 문서에 벡터 인덱스를 맞춰두는 일을 결정론적으로 시뮬레이션한다
// (Phase 3, advancedRagDemo 원본의 한국어 대응 포트). 9개의 장애 모드가 각각 fix 없이 / fix와 함께 두 번 실행된다.
// 모델 다운로드도 서버도 없다: 임베딩은 feature-hash bag-of-words 벡터라, 다른 시드의 두 "모델"은 서로
// 호환되지 않는 벡터 공간에 산다 — 실제 임베딩 모델 업그레이드와 정확히 같은 상황을 만든다.
// 토크나이저는 rag.js의 한국어 인식 terms() (원본은 영어 공백 토큰).
import { terms as tokenize } from "./rag.js";
import { HANDBOOK, KB, QUESTIONS, cloneDoc } from "./policyCorpus.js";

// ── primitives ────────────────────────────────────────────────────────────────
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, "0");
}
export function rng(seed) { // mulberry32
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 };
}

export const MODELS = { v1: { id: "embed-v1", seed: "v1|" }, v2: { id: "embed-v2", seed: "v2|" } };
const DIM = 1024;
export function embed(text, model = MODELS.v1) {
  const v = new Float32Array(DIM);
  for (const tok of tokenize(text)) {
    const h = parseInt(fnv1a(model.seed + tok), 16);
    v[h % DIM] += (h & 0x10000) ? 1 : -1;
  }
  let n = 0; for (let i = 0; i < DIM; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1; for (let i = 0; i < DIM; i++) v[i] /= n;
  return v;
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s };

// ── 문서와 청커 ────────────────────────────────────────────────────────────────
export function render(doc) {
  return doc.sections.map((s) => `## ${s.title}\n\n${s.paras.join("\n\n")}`).join("\n\n");
}
// 고정 캐릭터 윈도: 많은 튜토리얼의 기본값.
export function fixedChunks(doc, size = 200) {
  const text = render(doc), out = [];
  const starts = []; let off = 0;
  doc.sections.forEach((s) => { const t = `## ${s.title}\n\n${s.paras.join("\n\n")}`; starts.push([off, s.id]); off += t.length + 2 });
  const secAt = (p) => { let id = starts[0][1]; for (const [o, sid] of starts) if (o <= p) id = sid; return id };
  for (let p = 0; p < text.length; p += size) out.push({ text: text.slice(p, p + size), section: secAt(p), pos: p });
  return out;
}
// 안정 청커: 문단 하나 = 청크 하나, 제목 경로에 고정. 국소 편집은 국소에 머문다.
export function stableChunks(doc) {
  const out = [];
  doc.sections.forEach((s) => s.paras.forEach((p, i) => out.push({ text: `${doc.title} › ${s.title}\n${p}`, section: s.id, pos: i })));
  return out;
}

// ── 작은 벡터 스토어 ───────────────────────────────────────────────────────────
export class Store {
  constructor() { this.rows = new Map(); this.active = new Map(); this.seq = 0; this.embedCalls = 0 }
  add(row) { const id = ++this.seq; this.rows.set(id, { visible: true, ...row, id }); return id }
  embedRow(chunk, docId, extra = {}, model = MODELS.v1) {
    this.embedCalls++;
    return this.add({ docId, text: chunk.text, section: chunk.section, hash: fnv1a(chunk.text), vec: embed(chunk.text, model), model: model.id, ...extra });
  }
  deleteWhere(fn) { let n = 0; for (const [id, r] of this.rows) if (fn(r)) { this.rows.delete(id); n++ } return n }
  count(fn = () => true) { let n = 0; for (const r of this.rows.values()) if (fn(r)) n++; return n }
  search(query, { k = 5, model = MODELS.v1, filter = () => true } = {}) {
    const q = embed(query, model), hits = [];
    for (const r of this.rows.values()) if (r.visible && filter(r)) hits.push({ r, s: dot(q, r.vec) });
    hits.sort((a, b) => b.s - a.s);
    return hits.slice(0, k);
  }
}

export function indexAll(docs, { chunker = stableChunks, model = MODELS.v1, version = 1 } = {}) {
  const st = new Store();
  for (const d of docs) { for (const c of chunker(d)) st.embedRow(c, d.id, { version }, model); st.active.set(d.id, version) }
  return st;
}
const corpus = () => [cloneDoc(HANDBOOK), ...KB.map(cloneDoc)];
const isActive = (st) => (r) => st.active.get(r.docId) === r.version;

// 결정적 편집들
export const EDIT_SENTENCE = { section: 2, para: 0, text: " 초과 근무를 동반한 휴가는 그 전에 팀장과 시즌 일정을 조율해야 한다." }; // 3절 휴가
function editOneSentence(doc) { const d = cloneDoc(doc); d.sections[EDIT_SENTENCE.section].paras[EDIT_SENTENCE.para] += EDIT_SENTENCE.text; return d }
// v13 규정 변경: 네 절의 네 문단을 건드린다
export const POLICY_EDITS = [
  { s: 0, p: 2, from: "주 2일", to: "주 3일" },
  { s: 2, p: 0, from: "유급 연차 15일", to: "유급 연차 20일" },
  { s: 3, p: 0, from: "주 2일", to: "주 3일" },
  { s: 7, p: 1, from: "연차는 1년에 15일", to: "연차는 1년에 20일" },
]
function applyPolicy(doc) { const d = cloneDoc(doc); for (const e of POLICY_EDITS) d.sections[e.s].paras[e.p] = d.sections[e.s].paras[e.p].replace(e.from, e.to); return d }

const PROJ_VECTORS = 20_000_000, EMBEDS_PER_SEC = 2000;
const fmtDur = (s) => (s < 1 ? "<1 s" : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

// ── Rung 1: 한 번의 편집이 전체 재인덱스를 일으킨다 → 문서 ID ────────────────────
export function rung1() {
  const docs = corpus(), total = docs.reduce((n, d) => n + fixedChunks(d).length, 0);
  const st = indexAll(docs, { chunker: fixedChunks });
  const edited = editOneSentence(docs[0]);
  // 문서 ID가 있으면: 이 문서의 벡터를 지우고, 다시 청킹, 이 문서만 다시 임베딩
  st.embedCalls = 0;
  const deleted = st.deleteWhere((r) => r.docId === "handbook");
  for (const c of fixedChunks(edited)) st.embedRow(c, "handbook", { version: 1 });
  return {
    total, docs: docs.length,
    without: { embeds: total, deleted: total, projected: fmtDur(PROJ_VECTORS / EMBEDS_PER_SEC), projectedEmbeds: PROJ_VECTORS },
    with: { embeds: st.embedCalls, deleted, projected: fmtDur(st.embedCalls / EMBEDS_PER_SEC), projectedEmbeds: st.embedCalls },
  };
}

// diff 도우미: 새 청크 중 해시가 이전에 있었던 것은?
function hashDiff(oldChunks, newChunks) {
  const pool = new Map();
  for (const c of oldChunks) { const h = fnv1a(c.text); pool.set(h, (pool.get(h) || 0) + 1) }
  return newChunks.map((c) => { const h = fnv1a(c.text), n = pool.get(h) || 0; if (n) pool.set(h, n - 1); return { ...c, hash: h, reused: n > 0 } });
}

// ── Rung 2: 한 문장 편집이 문서 전체를 다시 임베딩한다 → 콘텐츠 해시 ─────────────
export function rung2() {
  const before = fixedChunks(HANDBOOK), after = fixedChunks(editOneSentence(HANDBOOK));
  const strip = hashDiff(before, after);
  const changed = strip.filter((c) => !c.reused).length;
  const firstChange = strip.findIndex((c) => !c.reused);
  return {
    chunks: after.length,
    without: { embeds: after.length, strip: strip.map((c) => ({ ...c, reused: false })) },
    with: { embeds: changed, strip, firstChange, cascade: strip.length - firstChange },
  };
}

// ── Rung 3: 경계가 밀려 이후의 모든 해시가 바뀐다 → 안정 청킹 ────────────────────
export function rung3() {
  const r2 = rung2();
  const before = stableChunks(HANDBOOK), after = stableChunks(editOneSentence(HANDBOOK));
  const strip = hashDiff(before, after);
  return {
    without: { embeds: r2.with.embeds, strip: r2.with.strip, chunks: r2.chunks, label: "고정 200자 윈도 + 해싱" },
    with: { embeds: strip.filter((c) => !c.reused).length, strip, chunks: strip.length, label: "제목 경로 아래 문단 청크 + 해싱" },
  };
}

// hit 보기
const hitView = (h) => ({ docId: h.r.docId, section: h.r.section, version: h.r.version, model: h.r.model, text: h.r.text, score: +h.s.toFixed(3), tag: h.r.tag });

// ── Rung 4: 갱신 중 크래시가 v12와 v13을 섞는다 → 문서 버저닝 ────────────────────
export function rung4({ crashAt = 0.5 } = {}) {
  const v12 = HANDBOOK, v13 = applyPolicy(HANDBOOK);
  const oldC = stableChunks(v12), newC = stableChunks(v13);
  const changedNew = hashDiff(oldC, newC).filter((c) => !c.reused);
  const goneOld = hashDiff(newC, oldC).filter((c) => !c.reused);
  const Q = "유급 연차는 1년에 며칠인가요";

  // 버저닝 없음: 바뀐 문단마다 자리에서 삭제+삽입, 절반쯤 크래시
  const a = indexAll([cloneDoc(v12), ...KB], { version: 12 });
  for (const r of a.rows.values()) if (r.docId === "handbook") r.tag = "v12";
  const ops = changedNew.map((c, i) => ({ del: goneOld[i], ins: c }));
  const done = Math.floor(ops.length * crashAt);
  ops.slice(0, done).forEach((op) => { a.deleteWhere((r) => r.docId === "handbook" && r.hash === fnv1a(op.del.text)); a.embedRow(op.ins, "handbook", { version: 12, tag: "v13" }) });
  const hitsA = a.search(Q, { k: 8, filter: (r) => r.docId === "handbook" }).map(hitView);

  // 버저닝 있음: v13을 v12 옆에 만들고, 활성화 전에 크래시, 읽기는 v12에 머문다
  const b = indexAll([cloneDoc(v12), ...KB], { version: 12 });
  for (const r of b.rows.values()) if (r.docId === "handbook") r.tag = "v12";
  const reuse = new Map([...b.rows.values()].filter((r) => r.docId === "handbook").map((r) => [r.hash, r]));
  let written = 0;
  const plan = hashDiff(oldC, newC);
  for (const c of plan) {
    if (written >= Math.floor(plan.length * crashAt)) break;
    const old = c.reused && reuse.get(c.hash);
    if (old) b.add({ ...old, id: undefined, version: 13, tag: "v13" }); else b.embedRow(c, "handbook", { version: 13, tag: "v13" });
    written++;
  }
  const hitsB = b.search(Q, { k: 8, filter: (r) => r.docId === "handbook" && isActive(b)(r) }).map(hitView);

  const facts = (hits) => [...new Set(hits.map((h) => ((h.text.match(/유급 연차\s*(\d+)일|연차는 1년에\s*(\d+)일/) || []).slice(1).find(Boolean))).filter(Boolean))];
  return {
    query: Q, edits: POLICY_EDITS.length, crashAt,
    without: { applied: done, of: ops.length, hits: hitsA, facts: facts(hitsA), sections: summarizeVersions(a) },
    with: { written, of: plan.length, hits: hitsB, facts: facts(hitsB), active: 12, pending: 13 },
  };
}
function summarizeVersions(st) {
  const m = {};
  for (const r of st.rows.values()) if (r.docId === "handbook") { (m[r.section] ||= new Set()).add(r.tag) }
  return Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v]]));
}

// ── Rung 5: 모든 쓰기가 끝나기 전에 새 버전이 활성화된다 → 원자적 전환 ────────────
// 쓰기는 비동기 upsert 큐로 간다(관리형 벡터 DB 대부분과 같음). 큐가 progress까지 drained될 동안 검색한다.
export function rung5({ progress = 0.45 } = {}) {
  const v13 = applyPolicy(HANDBOOK);
  const Q = "주 몇 일까지 재택근무가 가능한가요";
  function deploy(atomic) {
    const st = indexAll([cloneDoc(HANDBOOK), ...KB], { version: 12 });
    const newC = stableChunks(v13);
    const r = rng(7), ids = [];
    for (const c of newC) ids.push(st.embedRow(c, "handbook", { version: 13 }));
    for (const id of ids) st.rows.get(id).visible = false;
    // 배치 인덱서처럼 큐가 순서 없이 비워진다
    const order = ids.map((id) => [r(), id]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
    const landed = Math.floor(order.length * progress);
    order.slice(0, landed).forEach((id) => { st.rows.get(id).visible = true });
    const allLanded = landed === order.length;
    if (!atomic || allLanded) st.active.set("handbook", 13); // 비원자: 쓰기가 큐에 들어가자마자 뒤집는다
    const act = st.active.get("handbook");
    const visibleActive = [...st.rows.values()].filter((x) => x.docId === "handbook" && x.version === act && x.visible);
    const coverage = newC.map((c) => ({ section: c.section, para: c.pos, present: visibleActive.some((x) => x.section === c.section && x.text.split("\n")[1] === c.text.split("\n")[1]) || (act === 12) }));
    const hits = st.search(Q, { k: 3, filter: (x) => (x.docId !== "handbook") || x.version === act }).map(hitView);
    return { activeVersion: act, landed, of: order.length, coverage, coveragePct: coverage.filter((c) => c.present).length / coverage.length, hits };
  }
  return { query: Q, progress, without: deploy(false), with: deploy(true) };
}

// ── Rung 6: 옛 버전이 쌓인다 → 가비지 컬렉션 ─────────────────────────────────────
export function rung6({ edits = 300, every = 10, keep = 1 } = {}) {
  const r = rng(42);
  function run(gc) {
    const st = indexAll([cloneDoc(HANDBOOK), ...KB], { version: 1 });
    let doc = cloneDoc(HANDBOOK), v = 1;
    const series = [[0, st.rows.size, 0]];
    for (let e = 1; e <= edits; e++) {
      const s = Math.floor(r() * doc.sections.length), p = Math.floor(r() * doc.sections[s].paras.length);
      doc = cloneDoc(doc); doc.sections[s].paras[p] = doc.sections[s].paras[p].replace(/\s*\(rev \d+\)$/, "") + ` (rev ${e})`;
      const prev = new Map([...st.rows.values()].filter((x) => x.docId === "handbook" && x.version === v).map((x) => [x.hash, x]));
      v++;
      for (const c of stableChunks(doc)) { const h = fnv1a(c.text), old = prev.get(h); if (old) st.add({ ...old, id: undefined, version: v }); else st.embedRow(c, "handbook", { version: v }) }
      st.active.set("handbook", v);
      if (gc) st.deleteWhere((x) => x.docId === "handbook" && x.version < v - keep);
      if (e % every === 0) series.push([e, st.rows.size, st.count((x) => !isActive(st)(x))]);
    }
    const total = st.rows.size, stale = st.count((x) => !isActive(st)(x));
    return { series, total, stale, stalePct: stale / total };
  }
  return { edits, keep, without: run(false), with: run(true) };
}

// ── Rung 7: 임베딩 모델 업그레이드가 벡터 공간을 섞는다 → 임베딩 버저닝 ────────────
export function recallAt(st, { k = 5, model = MODELS.v1, filter = () => true } = {}) {
  let hit = 0;
  for (const q of QUESTIONS) if (st.search(q.q, { k, model, filter }).some((h) => h.r.docId === q.docId)) hit++;
  return hit / QUESTIONS.length;
}
export function rung7({ editedShare = 0.25 } = {}) {
  const docs = corpus();
  const base = indexAll(docs, { model: MODELS.v1 });
  const before = recallAt(base, { model: MODELS.v1 });
  const r = rng(99), edited = new Set(docs.filter(() => r() < editedShare).map((d) => d.id));

  // 없음: 파이프라인이 v2로 전환되고, 편집된 문서만 v2로 다시 임베딩, 질의는 이제 v2
  const a = indexAll(docs, { model: MODELS.v1 });
  for (const d of docs) if (edited.has(d.id)) { a.deleteWhere((x) => x.docId === d.id); for (const c of stableChunks(d)) a.embedRow(c, d.id, { version: 1 }, MODELS.v2) }
  const mixedV2 = recallAt(a, { model: MODELS.v2 });
  const mixedV1 = recallAt(a, { model: MODELS.v1 });

  // 있음: 벡터마다 모델 id를 기록; serving은 v1에 고정되고 v2 섀도 인덱스를 의도적으로 만든다;
  // 편집은 이중 기록; 섀도 인덱스가 완성되는 순간 전환한다.
  const b = indexAll(docs, { model: MODELS.v1 });
  const during = recallAt(b, { model: MODELS.v1, filter: (x) => x.model === MODELS.v1.id });
  for (const d of docs) for (const c of stableChunks(d)) b.embedRow(c, d.id, { version: 1 }, MODELS.v2);
  const after = recallAt(b, { model: MODELS.v2, filter: (x) => x.model === MODELS.v2.id });
  b.deleteWhere((x) => x.model === MODELS.v1.id);

  const mix = (st) => ({ v1: st.count((x) => x.model === MODELS.v1.id), v2: st.count((x) => x.model === MODELS.v2.id) });
  return {
    questions: QUESTIONS.length, editedDocs: edited.size, before,
    without: { recall: mixedV2, recallOldQueries: mixedV1, mix: mix(a) },
    with: { recallDuring: during, recall: after, mix: mix(b), reembedded: b.rows.size },
  };
}

// ── Rung 8: 갱신 이벤트가 도착하지 않는다 → outbox + 재조정 스윕 ──────────────────
export function rung8({ events = 40, drop = [6, 23] } = {}) {
  const Q = "노트북은 몇 년마다 교체되나요";
  function run(reconcile) {
    const r = rng(5);
    const source = new Map(corpus().map((d) => [d.id, d]));
    const st = indexAll([...source.values()], { version: 1 });
    const indexed = new Map([...source.keys()].map((id) => [id, fnv1a(render(source.get(id)))]));
    const log = [];
    const ids = [...source.keys()];
    for (let e = 0; e < events; e++) {
      const id = e === drop[0] ? "handbook" : ids[1 + Math.floor(r() * (ids.length - 1))];
      let d = cloneDoc(source.get(id));
      if (id === "handbook") d.sections[4].paras[0] = d.sections[4].paras[0].replace("3년마다", "4년마다");
      else d.sections[0].paras[0] += ` 갱신 ${e + 1}.`;
      source.set(id, d);
      const dropped = drop.includes(e);
      if (!dropped) { st.deleteWhere((x) => x.docId === id); for (const c of stableChunks(d)) st.embedRow(c, id, { version: 1 }); indexed.set(id, fnv1a(render(d))) }
      log.push({ e: e + 1, docId: id, dropped });
    }
    let drift = [], repaired = [];
    if (reconcile) {
      drift = [...source.keys()].filter((id) => indexed.get(id) !== fnv1a(render(source.get(id))));
      for (const id of drift) { st.deleteWhere((x) => x.docId === id); for (const c of stableChunks(source.get(id))) st.embedRow(c, id, { version: 1 }); indexed.set(id, fnv1a(render(source.get(id)))); repaired.push(id) }
    }
    const stale = [...source.keys()].filter((id) => indexed.get(id) !== fnv1a(render(source.get(id))));
    const hits = st.search(Q, { k: 3, filter: (x) => x.docId === "handbook" }).map(hitView);
    return { log, stale, drift, repaired, hits, answer: refreshYears(hits.map((h) => h.text)) };
  }
  return { query: Q, truth: "4", events, without: run(false), with: run(true) };
}

// ── Rung 9: 답변 캐시가 어제의 답을 제공한다 → 버전 인식 캐시 ─────────────────────
export function rung9() {
  const Q = "노트북은 몇 년마다 교체되나요";
  function run(versionAware) {
    const st = indexAll([cloneDoc(HANDBOOK), ...KB], { version: 1 });
    const cache = new Map(), log = [];
    const ask = () => {
      const key = Q.toLowerCase().trim(), hit = cache.get(key);
      if (hit && (!versionAware || Object.entries(hit.sources).every(([d, v]) => st.active.get(d) === v))) { log.push({ step: "ask", cached: true, answer: hit.answer }); return hit.answer }
      if (hit) log.push({ step: "invalidate", reason: "출처 버전이 바뀜" });
      const hs = st.search(Q, { k: 3, filter: (x) => x.docId === "handbook" && isActive(st)(x) });
      const answer = refreshYears(hs.map((h) => h.r.text));
      cache.set(key, { answer, sources: { handbook: hs[0].r.version } });
      log.push({ step: "ask", cached: false, answer }); return answer;
    };
    ask();
    // 새 교체 주기를 밝히는 v2 공개; 인덱스는 올바르게 갱신된다
    const d = cloneDoc(HANDBOOK); d.sections[4].paras[0] = d.sections[4].paras[0].replace("3년마다", "4년마다");
    for (const c of stableChunks(d)) st.embedRow(c, "handbook", { version: 2 });
    st.active.set("handbook", 2); st.deleteWhere((x) => x.docId === "handbook" && x.version === 1);
    log.push({ step: "publish", version: 2 });
    const answer = ask();
    return { log, answer };
  }
  return { query: Q, truth: "4", without: run(false), with: run(true) };
}

/*/ 사실 추출: 콘솔 히트 텍스트에서 노트북 교체 주기를 읽는다 */
function refreshYears(texts) {
  for (const t of texts) { const m = ("" + t).match(/(\d+)년마다/); if (m) return m[1] }
}

// ── 사다리 ────────────────────────────────────────────────────────────────────
export const RUNGS = [
  { n: 1, key: "docIds", problem: "하나의 편집이 코퍼스 전체를 다시 임베딩한다", fix: "모든 청크에 문서 ID를 저장한다", run: rung1 },
  { n: 2, key: "hashing", problem: "한 문장 편집이 문서 전체를 다시 임베딩한다", fix: "모든 청크에 콘텐츠 해시를 찍는다", run: rung2 },
  { n: 3, key: "stable", problem: "편집이 이후 모든 청크 경계를 밀어낸다", fix: "안정적, 구조에 고정된 청킹", run: rung3 },
  { n: 4, key: "versioning", problem: "크래시가 v12와 v13을 섞어 놓는다", fix: "갱신을 새 문서 버전으로 기록한다", run: rung4 },
  { n: 5, key: "atomic", problem: "배포 중 검색이 문서 반쪽을 반환한다", fix: "모든 쓰기가 착지한 뒤 원자적으로 전환", run: rung5 },
  { n: 6, key: "gc", problem: "옛 버전이 인덱스에 쌓인다", fix: "대체된 버전을 가비지 컬렉션한다", run: rung6 },
  { n: 7, key: "embedVersion", problem: "모델 업그레이드가 두 벡터 공간을 섞는다", fix: "벡터마다 임베딩 모델을 기록한다", run: rung7 },
  { n: 8, key: "reconcile", problem: "갱신 이벤트가 인덱서에 도달하지 않는다", fix: "트랜잭션 outbox + 재조정 스윕", run: rung8 },
  { n: 9, key: "cache", problem: "답변 캐시가 어제의 답을 제공한다", fix: "캐시된 답변을 출처 버전에 묶는다", run: rung9 },
];

let _cache = null;
export function runAll() {
  if (_cache) return _cache;
  const t0 = performance.now();
  const out = {};
  for (const r of RUNGS) out[r.n] = r.run();
  out.ms = Math.round(performance.now() - t0);
  return (_cache = out);
}

// ── Chaos week: 스크립트화된 프로덕션 한 주를, 켠 fix에 따라 채점한다 ──────────────
export const REQUIRES = { atomic: ["versioning"], gc: ["versioning"], stable: ["hashing"], hashing: ["docIds"] };
export function chaosWeek(fixes) {
  const R = runAll(), f = (k) => !!fixes[k];
  const edits = 100;
  const perEdit = !f("docIds") ? R[1].without.embeds : !f("hashing") ? R[1].with.embeds : !f("stable") ? R[3].without.embeds : R[3].with.embeds;
  const incidents = [
    { day: "월", what: `${edits}개 문서 편집`, ok: perEdit <= R[3].with.embeds * 2,
      impact: `한 주에 ${(perEdit * edits).toLocaleString()}회 임베딩 (편집당 ${perEdit.toLocaleString()})`, rungs: [1, 2, 3] },
    { day: "화", what: "인덱서가 갱신 중 크래시", ok: f("versioning"),
      impact: f("versioning") ? "판독기는 마지막 완전한 버전에 머뀄다" : `인덱스가 “${R[4].without.facts.join("일과 “")}일”의 연차를 섞어 답한다`, rungs: [4] },
    { day: "수", what: "배포 중 사용자 검색", ok: f("versioning") && f("atomic"),
      impact: f("versioning") && f("atomic") ? "규정이 내내 100% 검색 가능했다" : `규정의 ${Math.round(R[5].without.coveragePct * 100)}%만 검색 가능했다`, rungs: [5] },
    { day: "목", what: "300개 편집 누적", ok: !f("versioning") || f("gc"),
      impact: !f("versioning") ? "버전을 안 남겨서 수거할 것도 없다" : f("gc") ? `인덱스가 ${R[6].with.total.toLocaleString()} 벡터에 머문다` : `${R[6].without.total.toLocaleString()} 벡터 중 ${Math.round(R[6].without.stalePct * 100)}%가 부패(stale)`, rungs: [6] },
    { day: "금", what: "임베딩 모델 업그레이드", ok: f("embedVersion"),
      impact: f("embedVersion") ? `recall@5가 ${Math.round(R[7].with.recall * 100)}% 유지` : `recall@5가 ${Math.round(R[7].before * 100)}%에서 ${Math.round(R[7].without.recall * 100)}%로 하락`, rungs: [7] },
    { day: "토", what: "갱신 이벤트 2건 소실", ok: f("reconcile"),
      impact: f("reconcile") ? `스윕이 부패한 문서 ${R[8].with.repaired.length}개를 찾아 복구` : `문서 ${R[8].without.stale.length}개가 조용히 부패(캐시 답 “${R[8].without.answer}년마다”)`, rungs: [8] },
    { day: "일", what: "인기 질문 다시 물어봄", ok: f("cache"),
      impact: f("cache") ? "캐시 무효화; 새 답변 제공" : `캐시가 옛 답을 제공 (“${R[9].without.answer}년마다”)`, rungs: [9] },
  ];
  const passed = incidents.filter((i) => i.ok).length;
  return { incidents, passed, grade: ["F", "F", "E", "D", "C", "C", "B", "A"][passed] };
}
