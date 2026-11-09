// Phase-1 검색 고도화 테스트: 한국어 BM25 토크나이저, 하이브리드 융합, 근접성 리랭킹 (advancedRagDemo 병합).
// 기존 영어 동작도 회귀 테스트로 함께 검증한다 (router.test.mjs의 bm25 테스트와 겹치는 부분 포함).
import { test } from "node:test";
import assert from "node:assert/strict";
import { terms, bm25, hybridTopK, proximityScore, proximityRerank, chunkText, evidenceRetrieved } from "../web/rag.js";

test("terms: 한글 run은 겹치는 2-gram으로, 영어 단어·숫자는 통째로, 영어 불용어는 제거", () => {
  assert.deepEqual(terms("백과사전"), ["백과", "과사", "사전"]); // 양끝까지 커버
  const t = terms("소렐 밸리 철도 2026년 HTTP 429");
  for (const want of ["소렐", "밸리", "철도", "2026", "http", "429"]) assert.ok(t.includes(want), `${want} missing in ${t}`);
  assert.ok(t.includes("년")); // 한글 run이면 1글자도 토큰
  assert.deepEqual(terms("the museum is open"), ["museum", "open"]); // 기존 영어 동작
  assert.deepEqual(terms(""), []);
  assert.deepEqual(terms("가나"), ["가나"]); // 2글자 run은 통째로
});

test("terms: 문장부호·숫자·공백 경계에도 한글이 사라지지 않는다 (구 영어 전용 구현에서는 토큰이 0개였다)", () => {
  const text = "소렐 밸리 철도의 화물 열차는 아침 6시에 출발한다.";
  assert.ok(terms(text).length > 5);
});

test("bm25: 한국어 키워드 질의가 해당 구절만 높인다", () => {
  const s = bm25("밸리 철도의 화물", ["소렐 밸리 철도는 화물과 승객을 나른다.", "등대 회전 속도는 초당 0.5회다."]);
  assert.ok(s[0] > 0);
  assert.equal(s[1], 0);
});

test("bm25: 첨자(조사)가 붙은 단어도 2-gram으로 잡힌다", () => {
  const s = bm25("백과사전", ["바른홀트 등대 백과사전의 편집자는 소렐 밸리였다."]);
  assert.ok(s[0] > 0);
});

test("bm25: 기존 영어 회귀 — 정확한 용어를 높인다 (라우터 테스트와 동일)", () => {
  const s = bm25("HTTP 429 limit", ["Requests receive an HTTP 429 response.", "The museum is open in May."]);
  assert.ok(s[0] > 0 && s[1] === 0);
});

test("hybridTopK: 한국어 키워드 우세 질의는 낮은 벡터 가중치에서 키워드가 이긴다", () => {
  const items = [{ text: "소렐 밸리 철도는 화물을 나른다", vec: [0, 1] }, { text: "등대 회전 속도", vec: [1, 0] }];
  assert.equal(hybridTopK("밸리 철도 화물", [1, 0], items, 1, 0.2)[0].item.text, items[0].text, "keywords win at low cosine weight");
  assert.equal(hybridTopK("밸리 철도 화물", [1, 0], items, 1, 1)[0].item.text, items[1].text, "cosine wins at weight 1");
  assert.ok(hybridTopK("밸리 철도 화물", [1, 0], items, 1, 0.2)[0].keyword > 0);
});

test("proximityScore: 키워드가 뭉쳐 있으면 높고, 떨어져 있으면 낮다", () => {
  const clustered = proximityScore("밸리 철도", "소렐 밸리 철도가 화물을 나른다");
  const scattered = proximityScore("밸리 철도", "밸리의 등대는 철도역에서 볼 수 있다");
  assert.ok(clustered != null && clustered > 0);
  assert.ok(scattered != null && scattered > 0);
  assert.ok(clustered > scattered, `clustered ${clustered} should beat scattered ${scattered}`);
  // 질의 용어가 1개뿐이면 근접성은 성립하지 않는다
  assert.equal(proximityScore("밸리", "밸리 밸리 밸리"), null);
  // 근거가 하나라도 빠지면 낮아진다 (커버리지 0.5)
  const partial = proximityScore("밸리 철도", "밸리의 등대는 아름답다");
  assert.ok(partial != null && partial < clustered);
});

test("proximityRerank: 코사인이 낮아도 키워드가 뭉친 구절이 1위로 올라온다", () => {
  const items = [
    { docId: "a", chunk: 0, text: "등대 회전 속도", score: 0.9 },
    { docId: "b", chunk: 0, text: "소렐 밸리 철도가 화물을 나른다", score: 0.5 },
  ];
  const reranked = proximityRerank("밸리 철도 화물", items);
  assert.equal(reranked[0].docId, "b");
  assert.ok(reranked[0].proximity > 0);
  assert.ok(reranked[0].rerankScore >= reranked[1].rerankScore);
  assert.equal(reranked[1].proximity, null); // 키워드가 매칭되지 않았다 → 근접성 없음
});

test("proximityRerank: 질의 용어가 1개뿐이면 순서를 바꾸지 않는다", () => {
  const items = [{ docId: "a", chunk: 0, text: "밸리", score: 1 }, { docId: "b", chunk: 0, text: "철도", score: 0.5 }];
  const reranked = proximityRerank("밸리", items);
  assert.deepEqual(reranked.map((r) => r.docId), ["a", "b"]);
  assert.ok(reranked.every((r) => r.proximity === null));
});

test("한국어 청킹과 근접 리랭킹이 함께 동작한다 (evidence span이 리랭킹 후 top-k에 유지된다)", () => {
  const doc = "소렐 밸리 철도는 1887년에 개통했다. 그 화물 열차는 아침 6시에 출발한다. 등대 회전 속도는 초당 0.5회다. 편집자는 백과사전을 만들었다.";
  const chunks = chunkText(doc, { sentencesPerChunk: 1 });
  const evidence = "그 화물 열차는 아침 6시에 출발한다.";
  assert.equal(evidenceRetrieved(chunks, evidence), true);
  // 가짜 코사인 점수로 리랭킹: 골드 구절(2번째)에 높은 근접성이 붙어야 1위로 올라온다
  const ranked = chunks.map((c, i) => ({ ...c, score: 1 - i * 0.3 }));
  const reranked = proximityRerank("밸리 철도 화물 열차", ranked);
  assert.ok(reranked.some((c) => evidenceRetrieved([c], evidence)));
});
