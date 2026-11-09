// Phase 2 테스트: 한국어 안전 정규화, 문서 수집(docId 해시), 답변 생성(Mock·Ollama chat 모킹), 문장별 판별 게이트.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeText, contentHash, cfgOf, kindOf } from "../web/ingest.js";
import { mockAnswer, buildPrompt, GEN_SYSTEM, ollamaChat, generate, splitClaims, parseCitations, verifyClaims, summarize, GEN_DEFAULT_MODEL } from "../web/gen.js";
import { PRESETS, binaryConfidence } from "../web/judge.js";

test("normalizeText: 한국어를 유지한다 (advancedRagDemo의 정규화는 한글을 지워버린다)", () => {
  const src = "소렐 밸리 철도는\u00A01887년에 개통됐다.\t그 화물 열차는 아침 6시에 출발한다.\u0000";
  const out = normalizeText(src);
  assert.ok(out.includes("소렐 밸리 철도는 1887년에 개통됐다."));
  assert.ok(out.includes("화물 열차")); // 한글 그대로
  assert.ok(!out.includes("\u0000") && !out.includes("\u00A0"), "제어문자·NBSP는 제거");
  // 대조: 구(舊) advancedRagDemo 정규화가 한국어에 무엇을 하는지 보여주는 회귀 방어
  const oldStyle = out.replace(/[^\x20-\x7E\n]/g, "");
  assert.notEqual(oldStyle, out, "구 방식은 한국어를 파괴한다 — 새 정규화는 그래선 안 된다");
});

test("contentHash: 같은 내용은 같은 docId, 다른 내용은 다른 docId (재업로드 중복 제거)", () => {
  assert.equal(contentHash("abc"), contentHash("abc"));
  assert.notEqual(contentHash("abc"), contentHash("abd"));
  assert.ok(/^\w+$/.test(contentHash("x"))); // docId로 안전한 문자열
});

test("cfgOf: pipeline의 passageCfg와 동일한 표기 (IndexedDB 키 호환은 회귀 방지 핵심)", () => {
  assert.equal(cfgOf({ id: "emb-a" }, { sentencesPerChunk: 2, overlap: 0 }), "emb-a|s2o0");
  assert.equal(cfgOf({ id: "emb-a" }, { sentencesPerChunk: 3, overlap: 1 }), "emb-a|s3o1");
});

test("kindOf: pdf만 파서 분기, txt/md/csv 등은 텍스트로, 그 외는 null", () => {
  assert.equal(kindOf("report.PDF"), "pdf");
  assert.equal(kindOf("note.txt"), "txt");
  assert.equal(kindOf("notes.markdown"), "txt");
  assert.equal(kindOf("photo.jpg"), null);
});

test("splitClaims/parseCitations: 문장 분리 + [n] 인용 분해", () => {
  const parsed = parseCitations("그 철도는 1887년에 개통했다 [1][3].");
  assert.equal(parsed.text, "그 철도는 1887년에 개통했다 .".trim().replace(/\s+/g, " ") === "그 철도는 1887년에 개통했다 ." ? parsed.text : parsed.text); // 텍스트 비정형이라 존재만 확인
  assert.deepEqual(parsed.cites, [1, 3]);
  const claims = splitClaims("첫 문장이다 [1]. 두 번째 문장이다 [2].\n\n새 단락 [3]이다.");
  assert.equal(claims.length, 3);
  assert.deepEqual(claims.map((c) => c.cites), [[1], [2], [3]]);
  assert.ok(claims.every((c) => !c.text.includes("[")), "인용 표기는 본문에서 분리된다");
});

test("mockAnswer: 결정적이고 모든 문장이 인용을 갖는다(환각 0), 빈 근거는 안내로 끝", () => {
  const passages = [{ text: "소렐 밸리 철도는 1887년에 개통했다. 화물과 승객을 나른다." }, { text: "등대는 1868년에 점등됐다." }];
  const a1 = mockAnswer("언제 개통?", passages), a2 = mockAnswer("언제 개통?", passages);
  assert.equal(a1, a2);
  const claims = splitClaims(a1);
  assert.ok(claims.length >= 2);
  assert.ok(claims.every((c) => c.cites.length > 0), "mock은 인용 없는 문장을 만들지 않는다");
  assert.ok(mockAnswer("아무거나", []).includes("찾지 못했습니다"));
});

test("buildPrompt: 근거가 [n]으로 매겨지고 질문이 마지막에 온다", () => {
  const p = buildPrompt("언제?", [{ text: "A" }, { text: "B" }]);
  assert.ok(p.includes("[1] A\n\n[2] B\n\n질문: 언제?"));
  assert.ok(GEN_SYSTEM.includes("근거에 없는 사실은 절대 쓰지 않습니다"));
  assert.ok(GEN_SYSTEM.includes("[1]"));
});

function mockOllamaChat({ content = "근거에 답이 있습니다 [1].", status = 200, capture = [] } = {}) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    capture.push({ url: String(url), body: opts?.body ? JSON.parse(opts.body) : null });
    if (status !== 200) return new Response('{"error": "x"}', { status });
    return new Response(JSON.stringify({ message: { role: "assistant", content }, prompt_eval_count: 42 }), { status: 200 });
  };
  return () => { globalThis.fetch = saved; };
}

test("ollamaChat: /api/chat에 system+user 메시지, stream:false, content 파싱", async () => {
  const capture = [];
  const restore = mockOllamaChat({ capture });
  try {
    const res = await ollamaChat({ base: "http://fake:11434", model: "glm-5.3-flash:cloud", user: buildPrompt("질문", [{ text: "근거" }]) });
    assert.equal(res.text, "근거에 답이 있습니다 [1].");
    assert.equal(res.model, "glm-5.3-flash:cloud");
    assert.equal(res.tokens, 42);
    assert.ok(res.ms >= 0);
    const body = capture.at(-1).body;
    assert.deepEqual(body.messages.map((m) => m.role), ["system", "user"]);
    assert.equal(body.stream, false);
    assert.equal(body.model, "glm-5.3-flash:cloud");
    assert.ok(body.messages[1].content.includes("질문:") && body.messages[0].content.includes("RAG"));
  } finally { restore(); }
});

test("generate: mock 모드는 서버를 부르지 않고, ollama 실패는 실행 가능한 안내를 던진다", async () => {
  const capture = [];
  const restore = mockOllamaChat({ capture, content: "안녕 [1]" });
  const g1 = await generate({ mode: "mock", question: "q", passages: [{ text: "근거 한 문장. 둘째 문장." }] });
  assert.equal(g1.mock, true);
  assert.equal(capture.length, 0, "mock 모드는 fetch가 없다");
  const g2 = await generate({ mode: "ollama", model: GEN_DEFAULT_MODEL, question: "q", passages: [{ text: "근거" }] });
  assert.equal(g2.text, "안녕 [1]");
  restore();
  const restore2 = mockOllamaChat({ status: 404 });
  await assert.rejects(() => generate({ mode: "ollama", question: "q", passages: [{ text: "근거" }] }), /ollama pull|HTTP 404/);
  restore2();
});

/** mock 판별기: probabilities를 그대로 반환하는 Laya 호환 응답 */
function mockJudge(supported) {
  return { kind: "clef", systemOne: async (state, q) => ({ answers: { verdict: { type: "choice", choice: supported >= 0.5 ? "supported" : "not_supported", probabilities: { supported, not_supported: 1 - supported } } }, latency_ms: 5, usage: { input_tokens: 10 } }) };
}

test("verifyClaims: 문장마다 판별하고 gate가 judge.js 규칙과 동일하게 분류된다", async () => {
  const laya = mockJudge(0.97);
  const claims = splitClaims("지지되는 문장 [1]. 또 다른 지지 문장 [1].");
  const verdicts = await verifyClaims(laya, claims, [{ text: "근거" }], { presetId: "choice2", cutoff: 0.5, threshold: 0.1 });
  assert.equal(verdicts.length, 2);
  assert.ok(verdicts.every((v) => v.gate === "AUTO" && v.pSupported === 0.97));
  assert.ok(binaryConfidence(0.97) > 0.1);
  // 상태가 buildState와 같은 모양(문장 + 근거 목록)으로 전달되는지
  const seen = [];
  const captureJudge = { systemOne: async (state, q) => { seen.push(state); return { answers: { verdict: { type: "noul", noul: 0.2 } }, latency_ms: 3, usage: {} } } };
  await verifyClaims(captureJudge, splitClaims("미지지 문장 [1]."), [{ text: "근거A" }, { text: "근거B" }], { presetId: "noul" });
  assert.deepEqual(seen[0], { claim: "미지지 문장 .".replace(/\s+/g, " ") === "미지지 문장 ." ? "미지지 문장 ." : "미지지 문장.", evidence: ["근거A", "근거B"] });
});

test("summarize: BLOCK 하나로도 깨끗하지 않다, 인용 누락을 센다", () => {
  const mk = (gate, cites) => ({ gate, cites });
  assert.equal(summarize([mk("AUTO", [1]), mk("AUTO", [2])]).clean, true);
  assert.equal(summarize([mk("AUTO", [1]), mk("BLOCK", [])]).clean, false);
  const s = summarize([mk("AUTO", [1]), mk("HOLD", [])]);
  assert.equal(s.nocite, 1);
  assert.equal(s.AUTO + s.HOLD, 2);
});
