// Ollama Clef 판별기 백엔드 어댑터 테스트. 실제 /v1/systemone 응답 형태(2026-11 실측 캡처)를 그대로 재현해,
// Laya의 systemOne 인터페이스와 interpret() 계약을 그대로 채우는지 검증한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createClef, clefHealth } from "../web/clef.js";
import { PRESETS, interpret, binaryConfidence } from "../web/judge.js";

// --- 실측 응답 (curl http://localhost:11434/v1/systemone, 2026-11-09) -------------------------------
const NOUL_RES = { model: "clef", answers: { verdict: { type: "noul", noul: 0.9765 } }, usage: { input_tokens: 163, output_tokens: 0 } };
const CHOICE_RES = { model: "clef", answers: {
  verdict: { type: "choice", choice: "not_supported", confidence: 0.9591, probabilities: { supported: 0.0103, not_supported: 0.9897 } },
  answer: { type: "choice", choice: "not_answered", confidence: 0.2688, probabilities: { answered: 0.2408, not_answered: 0.7592 } },
}, usage: { input_tokens: 309, output_tokens: 0 } };

const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Install a fake Ollama server: /api/tags + /v1/systemone over the request body the adapter sends. */
function mockOllama({ systemoneBody = null, systemoneStatus = 200, tags = { models: [{ name: "clef:cloud" }] }, fail = false, capture = [] } = {}) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    const u = String(url);
    if (fail) throw new Error("net down");
    capture.push({ url: u, body: opts && opts.body ? JSON.parse(opts.body) : null });
    if (u.endsWith("/api/tags")) return jsonResponse(tags, fail ? 500 : 200);
    if (u.endsWith("/v1/systemone")) {
      if (systemoneStatus !== 200) return jsonResponse({ error: "boom" }, systemoneStatus);
      // 기본 값: 요청의 질문 이름마다 CHOICE_RES.answers.verdict 형태를 그대로 에코
      const qnames = (capture.at(-1)?.body?.questions && Object.keys(capture.at(-1).body.questions).length && Object.keys(capture.at(-1).body.questions)) || ["verdict"];
      const body = systemoneBody ?? { model: "clef", answers: Object.fromEntries(qnames.map((k) => [k, CHOICE_RES.answers.verdict])), usage: { input_tokens: 309, output_tokens: 0 } };
      return jsonResponse(body);
    }
    return jsonResponse({ error: "unknown" }, 404);
  };
  return () => { globalThis.fetch = saved; };
}

test("clef 어댑터가 systemOne 계약(answers + latency_ms + usage)을 채운다", async () => {
  const capture = [];
  const restore = mockOllama({ systemoneBody: CHOICE_RES, capture });
  try {
    const clef = await createClef({ model: "clef:cloud", base: "http://fake:11434" });
    assert.equal(clef.variant, "clef:cloud");
    assert.equal(clef.tok, undefined, "토크나이저 없음 → modelInput이 null을 반환하는 힌트");
    const res = await clef.systemOne({ claim: "x", evidence: ["y"] }, { verdict: PRESETS.choice2.question });
    assert.equal(res.answers.verdict.probabilities.supported, 0.0103);
    assert.ok(res.latency_ms > 0, "latency_ms는 어댑터가 측정해 채운다");
    assert.equal(res.usage.input_tokens, 309);
    // 전송된 질문 스키마는 Laya의 것 그대로여야 한다
    assert.equal(capture.at(-1).body.questions.verdict.type, "choice");
    assert.deepEqual(Object.keys(capture.at(-1).body.questions.verdict.criteria), ["supported", "not_supported"]);
    assert.equal(capture.at(-1).body.model, "clef:cloud");
  } finally { restore(); }
});

test("clef 응답이 interpret()/게이트 흐름과 호환된다 (choice · choice3 · noul)", async () => {
  const restore = mockOllama({});
  try {
    const clef = await createClef({ model: "clef:cloud", base: "http://fake:11434" });
    // 두 선택지
    const c2 = await clef.systemOne({}, { q: PRESETS.choice2.question });
    const i2 = interpret(c2.answers.q, "choice2");
    assert.ok(Math.abs(i2.pSupported - 0.0103) < 1e-9);
    assert.equal(Math.abs(i2.confidence - binaryConfidence(0.0103)) < 1e-9, true);
    // 세 선택지 — probabilities 키가 criteria 이름 그대로 올 때 interpret가 그대로 동작한다
    const choice3 = { type: "choice", choice: "contradicted", confidence: 0.8, probabilities: { supported: 0.05, contradicted: 0.9, not_mentioned: 0.05 } };
    const i3 = interpret(choice3, "choice3");
    assert.equal(i3.pSupported, 0.05);
    // 예/아니오 — Laya와 동일하게 answer.noul을 읽는다
    const noulRes = { answers: { q: { type: "noul", noul: 0.9765 } }, usage: { input_tokens: 10 } };
    const restore2 = mockOllama({ systemoneBody: noulRes });
    const res2 = await clef.systemOne({}, { q: PRESETS.noul.question, other: PRESETS.choice2.question });
    const in2 = interpret(res2.answers.q, "noul");
    restore2();
    assert.ok(in2.pSupported > 0.97);
    assert.ok(Math.abs(in2.probabilities.supported - 0.9765) < 1e-9);
    assert.ok(Math.abs(in2.probabilities.not_supported - 0.0235) < 1e-9);
  } finally { restore(); }
});

test("헬스체크: 서버를 찾지 못하거나 clef 미설치 또는 HTTP 오류를 한국어로 안내한다", async () => {
  const restore = mockOllama({});
  try {
    assert.equal(await clefHealth("http://fake:11434", "clef:cloud"), null, "정상이면 null");
  } finally { restore(); }
  const restore2 = mockOllama({ tags: { models: [{ name: "glm-5.3-flash:cloud" }] }, systemoneStatus: 404 });
  try {
    const msg = await clefHealth("http://fake:11434", "clef:cloud");
    assert.ok(msg && msg.includes("ollama pull clef:cloud"));
    await assert.rejects(() => createClef({ model: "clef:cloud", base: "http://fake:11434" }), /ollama pull clef:cloud/);
    await assert.rejects(() => createClef({ model: "clef:cloud", base: "http://fake:11434" }), /clef 모델이 없습니다/);
  } finally { restore2(); }
  const restore3 = mockOllama({ systemoneStatus: 403 });
  try {
    await assert.rejects(() => createClef({ model: "clef:cloud", base: "http://fake:11434" }), /HTTP 403/);
  } finally { restore3(); }
  const restore4 = mockOllama({ fail: true });
  try {
    await assert.rejects(() => createClef({ model: "clef:cloud", base: "http://fake:11434" }), /접속하지 못했습니다/);
    const clef = await createClef({ model: "clef:cloud", base: "http://fake:11434" }).catch(() => null);
    assert.equal(clef, null);
  } finally { restore4(); }
});

test("clef 미실행 시 systemOne도 실행 가능한 안내를 던진다", async () => {
  const restore = mockOllama({});
  const clef = await createClef({ model: "clef:cloud", base: "http://fake:11434" });
  restore();
  const restore2 = mockOllama({ fail: true });
  try {
    await assert.rejects(() => clef.systemOne({}, { q: PRESETS.choice2.question }), /접속하지 못했습니다/);
  } finally { restore2(); }
});
