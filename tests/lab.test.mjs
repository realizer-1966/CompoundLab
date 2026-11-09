// Phase 3 엔진 테스트: chunkLab(한국어 마크다운 청킹 전략 5종)·prodLab(9개 장애 모드 시뮬레이션, chaos week).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDocument, chunkFixed, chunkSentence, chunkStructure, chunkQESDP, chunkQESOverlap, locateEvidence, runLab, STRATEGIES, MiniBM25, withHeadingPath } from "../web/chunkLab.js";
import { runAll, chaosWeek, REQUIRES, RUNGS, fnv1a, stableChunks } from "../web/prodLab.js";
import { LAB_TEXT, LAB_QE, HANDBOOK, KB, QUESTIONS, cloneDoc } from "../web/policyCorpus.js";

// ── parseDocument & 청커 ─────────────────────────────────────────────

test("parseDocument: 한국어 마크다운에서 제목/문장/x.y provision을 오프셋과 함께 파싱한다", () => {
  const doc = parseDocument(LAB_TEXT);
  assert.ok(doc.units.length > 30);
  const provisions = doc.provisions;
  assert.ok(provisions.length >= 10, "x.y 소제목이 provision이 된다");
  for (const p of provisions) {
    assert.ok(p.id.match(/^\d+\.\d+$/), `provision id는 x.y 형태: ${p.id}`);
    assert.ok(p.heading.type === "heading" && p.unitIdx.length >= 1);
    assert.ok(p.path.some((t) => /장/.test(t)), "제목 경로에 장이 포함된다");
  }
  for (const u of doc.units) assert.equal(u.text, doc.C.slice(u.start, u.end));
});

test("5종 청커가 모두 문서를 커버하고, 구조 인식은 provision 경계를 넘지 않는다", () => {
  const doc = parseDocument(LAB_TEXT);
  const all = [
    ["fixed", chunkFixed(doc, 160)],
    ["sentence", chunkSentence(doc, 160)],
    ["struct", chunkStructure(doc, 160)],
    ["qesdp", chunkQESDP(doc, 160, locateEvidence(doc, LAB_QE).filter((q) => q.split === "train")).chunks],
    ["qesov", chunkQESOverlap(doc, 160, locateEvidence(doc, LAB_QE).filter((q) => q.split === "train"))],
  ];
  for (const [k, chunks] of all) {
    assert.ok(chunks.length >= 2, `${k}: 청크가 있음`);
    assert.ok(chunks.reduce((a, c) => a + c.words, 0) > 40, `${k}: 토큰을 잃지 않는다`);
    // 연속성: 청크들 사이에 빈틈이 없는 커버리지(고정/문장은 겹침, 구조는 provision 경계 기준)
    const spans = chunks.map((c) => [c.start, c.end]).sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i][0] <= spans[i - 1][1] + 40, `${k}: 커버리지 붕괴 없음`);
  }
  const doc2 = parseDocument(LAB_TEXT), provs = doc2.provisions;
  for (const c of chunkStructure(doc2, 400)) {
    const pi = c.prov;
    assert.ok(c.start >= provs[pi].heading.start && c.end <= provs[pi].end + 1, "provision 경계 안");
    assert.ok(c.text.startsWith("["), "제목 경로 접두어");
  }
});

test("runLab: 5 전략 전부 평가되고 구조·QES의 질적 차이가 재현된다", () => {
  const r = runLab(LAB_TEXT, LAB_QE, { L: 160, budget: 30, evalSplit: "all" });
  assert.equal(r.missing.length, 0, "모든 evidence가 문서에서 찾아진다");
  assert.equal(Object.keys(r.results).length, STRATEGIES.length);
  const { struct, qesov, sentence } = r.results;
  assert.equal(struct.xrefResolved, 1, "구조 인식은 모든 'x.y절' 참조를 해결한다");
  assert.equal(struct.cleanBoundaries, 1, "구조 인식은 경계가 모두 제목에 닿는다");
  assert.ok(qesov.completeFlat >= sentence.completeFlat, "QES(지도) ≥ 문장 윈도의 완전 회수");
  assert.ok(struct.evidenceIntact === 1 && sentence.evidenceIntact === 1, "모든 증거는 어딘가 인덱스에 온전하다");
  // 그래프 모드는 flat만큼은 넘는 게 아니라 같거나 나아야 한다 (SpectRAG-lite의 목적)
  for (const s of Object.values(r.results)) assert.ok(s.completeGraph >= s.completeFlat - 0.34, "graph ≥ flat(허용 오차 내)");
});

test("문장 윈도가 한국어에서 근거를 청크 경계로 쪼개지 않는다 (evidence 유지)", () => {
  const doc = parseDocument(LAB_TEXT);
  const ev = locateEvidence(doc, LAB_QE);
  for (const q of ev) for (const e of q.ev) {
    const hit = [...chunkSentence(doc, 400), ...chunkFixed(doc, 400)].filter((c) => c.start <= e.s && c.end >= e.e);
    assert.ok(hit.length > 0, `evidence가 청크 안에 온전히: ${e.text.slice(0, 30)}`);
  }
});

test("컨텍스트 헤더와 MiniBM25가 한국어 토큰으로 동작한다", () => {
  const doc = parseDocument(LAB_TEXT);
  const chunks = withHeadingPath(doc, chunkSentence(doc, 200));
  assert.ok(chunks.some((c) => c.headed && /^\[.+장/.test(c.text)), "제목 경로가 접두어로");
  const bm = new MiniBM25(chunks);
  const s = bm.score("유급 연차는 며칠?");
  assert.ok(Math.max(...s) > 0, "한국어 검색에서 BM25 점수 > 0");
});

// ── prodLab ──────────────────────────────────────────────────────────

test("policyCorpus: 구조·질문·증거의 불변식", () => {
  assert.ok(HANDBOOK.sections.length >= 10);
  for (const s of HANDBOOK.sections) assert.ok(s.paras.length >= 4, `${s.id} 절에 문단이 충분`);
  const render = (doc) => doc.sections.map((s) => `## ${s.title}\n\n${s.paras.join("\n\n")}`).join("\n\n");
  const text = render(HANDBOOK);
  assert.ok(text.includes("3년마다") && text.includes("유급 연차 15일"), "편집이 찾을 표현이 있다");
  assert.ok(KB.length >= 30 && new Set(KB.map((d) => d.id)).size === KB.length);
  for (const q of QUESTIONS) assert.ok(KB.some((d) => d.id === q.docId) || q.docId === "handbook");
});

test("runAll: 9개 rung, 각각 fix가 실제로 개선한다", () => {
  const R = runAll();
  assert.equal(Object.keys(R).filter((k) => k !== "ms").length, RUNGS.length);
  assert.ok(R[1].with.embeds < R[1].without.embeds / 2, "rung1: 문서 ID로 재임베딩이 급감");
  assert.ok(R[2].with.embeds < R[2].without.embeds, "rung2: 해시로 대부분 재사용");
  assert.ok(R[3].with.embeds <= 3, "rung3: 안정 청킹에서 편집은 국소");
  assert.deepEqual(R[4].with.facts, ["15"], "버저닝 있음: 읽기는 v12(15일)에 머문다");
  assert.ok(R[5].with.coveragePct > R[5].without.coveragePct, "rung5: 원자 전환이 커버리지를 지킨다");
  assert.ok(R[6].without.stale > R[6].with.stale * 50, "rung6: GC가 부패 벡터를 제거");
  assert.ok(R[7].without.recall < R[7].before && R[7].with.recall > 0.9, "rung7: 모델 버저닝이 recall을 지킨다");
  assert.notEqual(R[8].without.answer, "4", "rung8: 이벤트 소실은 옛 답을 준다");
  assert.ok(R[8].with.repaired.includes("handbook"), "재조정 스윕이 복구한다");
  assert.notEqual(R[9].without.answer, "4", "rung9: 캐시가 옛 답을");
  assert.equal(R[9].with.answer, "4", "버전 인식 캐시는 새 답을");
});

test("chaosWeek: grade가 fix 개수를 따라간다", () => {
  const none = chaosWeek({});
  const all = chaosWeek(Object.fromEntries([...["docIds", "hashing", "stable", "versioning", "atomic", "gc", "embedVersion", "reconcile", "cache"].map((k) => [k, true])]));
  assert.ok(none.passed < all.passed);
  assert.ok(["F", "E", "D"].includes(none.grade) && ["A", "B", "C"].includes(all.grade));
  assert.equal(all.incidents.length, 7);
  // 의존성: atomic은 versioning, hashing은 docIds를 요구한다
  assert.deepEqual(REQUIRES.atomic, ["versioning"]);
  // 화요일 크래시: versioning 없으면 facts가 섞인다고 본다
  const noVer = chaosWeek(Object.fromEntries(["docIds", "hashing", "stable", "gc", "embedVersion", "reconcile", "cache"].map((k) => [k, true])));
  assert.ok(noVer.incidents[1].impact.includes("섞어") || !noVer.incidents[1].ok);
});

test("fnv1a와 stableChunks의 안정성", () => {
  assert.equal(fnv1a("abc"), fnv1a("abc"));
  assert.notEqual(fnv1a("abc"), fnv1a("abd"));
  const before = stableChunks(HANDBOOK).map((c) => c.text);
  const doc = cloneDoc(HANDBOOK);
  doc.sections[2].paras[0] += " 한 문장 추가.";
  const after = stableChunks(doc).map((c) => c.text);
  assert.equal(before.filter((t, i) => t === after[i]).length, before.length - 1, "편집된 문단 하나만 바뀐다 (안정 청킹)");
});
