// rag-eval UI 하네스: 가짜 DOM + 가짜 임베더/판별기로 "평가 실행" 클릭 전 경로를 실제로 실행한다.
// 회귀 경험: (1) 페이지 로드 직후(코퍼스 fetch 완료 전) 클릭하면 subsetClaims가 조용히 예외를 던져 버튼이
// 죽은 것처럼 보였다 → 이제 runEval이 코퍼스를 스스로 로드하고, 실패 시엔 화면 안내를 남긴다.
// (2) MessageChannel 기반 yieldToBrowser는 Node에서 응답하지 않으므로 임시 사본에서 무력화한다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(root, "..", "web");
const nm = path.resolve(root, "..", "node_modules");

function makeSite({ slowCorpusMs = 150 } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "evalui-"));
  fs.cpSync(webDir, tmp, { recursive: true, filter: (s) => !s.includes("vendor") });
  fs.mkdirSync(path.join(tmp, "vendor"));
  fs.copyFileSync(path.join(nm, "onnxruntime-web", "dist", "ort.min.mjs"), path.join(tmp, "vendor", "ort.min.mjs"));
  fs.copyFileSync(path.join(nm, "@huggingface", "tokenizers", "dist", "tokenizers.min.mjs"), path.join(tmp, "vendor", "tokenizers.min.mjs"));
  const common = fs.readFileSync(path.join(tmp, "common.js"), "utf8")
    .replace('export const yieldToBrowser = () => new Promise((r) => { const ch = new MessageChannel(); ch.port1.onmessage = () => r(); ch.port2.postMessage(0); });',
             'export const yieldToBrowser = async () => { await 0 };');
  fs.writeFileSync(path.join(tmp, "common.js"), common);

  // 상대 URL fetch → 로컬 파일 (corpus.json은 느리게 응답해 '로드 전 클릭'을 재현)
  const real = globalThis.fetch;
  globalThis.fetch = async (url, o) => {
    const u = String(url);
    if (u.startsWith("./") && !u.match(/^https?:/)) {
      const rel = u.slice(2).split("?")[0];
      const file = path.join(tmp, rel);
      if (fs.existsSync(file)) {
        if (rel === "corpus.json" && slowCorpusMs) await new Promise((r) => setTimeout(r, slowCorpusMs));
        return new Response(fs.readFileSync(file), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }
    return real(url, o);
  };
  return { tmp, restore: () => { globalThis.fetch = real } };
}

function fakeDom() {
  const els = {};
  const el = (id) => els[id] ??= {
    id, listeners: {}, className: "", innerHTML: "", textContent: "", value: "", disabled: false, hidden: false,
    style: {}, classList: { toggle() {}, add() {}, remove() {} },
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn) },
    click() { (this.listeners.click ?? []).forEach((fn) => fn()) },
    appendChild() {}, scrollIntoView() {}, focus() {},
  };
  globalThis.document = {
    getElementById: (id) => el(id),
    querySelectorAll: () => [], querySelector: () => null, createElement: () => ({ style: {}, className: "", textContent: "" }),
    currentScript: { src: "http://x/x.js" },
  };
  globalThis.location = { search: "", origin: "http://x" };
  Object.defineProperty(globalThis, "navigator", { value: { hardwareConcurrency: 4 }, configurable: true });
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };
  globalThis.CSS = { escape: (s) => s };
  globalThis.addEventListener ||= () => {};
  globalThis.removeEventListener ||= () => {};
  globalThis.matchMedia ||= () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  globalThis.window = globalThis;
  return { el, els };
}

test("rag 없는 유령 실행 행이 있어도 페이지 로드·평가 실행이 죽지 않고 폐기한다", async () => {
  const { tmp, restore } = makeSite({ slowCorpusMs: 0 });
  const { el } = fakeDom();
  try {
    const { M } = await import(`file://${path.join(tmp, "common.js")}`);
    const db = await import(`file://${path.join(tmp, "store.js")}`);
    // 유령 행: 예전 버전이 남긴 rag 없는 실행
    await db.putMany("runs", [{ key: "orphan|broken", source: "browser", records: [] }]);
    M.laya = { kind: "fake", variant: "fake-test", systemOne: async () => ({ answers: { verdict: { type: "choice", probabilities: { supported: 0.8, not_supported: 0.2 } } }, latency_ms: 4, usage: {} }) };
    M.embedder = { id: "fake-hash", embed: async (ts) => ts.map(() => new Float32Array(8).fill(0.1)) };
    M.model = { variant: "fake-test", backend: "fake", threads: 1 };
    await import(`file://${path.join(tmp, "rag-eval.js")}`);
    for (let i = 0; i < 50 && !(globalThis.window.__diagLog || []).length; i++) await new Promise((r) => setTimeout(r, 20));
    // rag 없는 유령 행: 로드 시 폐기되어 오류 재현이 없어야 한다 — 페이지 로드가 죽으면 이하 await에서 멈춘다
    el("subset").value = "quick";
    el("runBtn").click();
    const S = globalThis.window.__lrj.state;
    for (let i = 0; i < 200 && !(S.current?.complete && !S.running); i++) await new Promise((r) => setTimeout(r, 25));
    assert.match(el("runHint").textContent, /완료/, `runHint = ${el("runHint").textContent}`);
  } finally { restore(); }
});

test("평가 실행: 코퍼스 로드 직전의 클릭으로도 조용히 죽지 않고 실행을 완료한다", async () => {
  const { tmp, restore } = makeSite();
  const { el } = fakeDom();
  try {
    // 1) common만 먼저 로드하고 가짜 모델을 꽂는다 (rag-eval보다 먼저)
    const { M } = await import(`file://${path.join(tmp, "common.js")}`);
    // 결정적 가짜 판별기: p(supported)만 의미하면 파이프라인 전부가 돈다
    M.laya = { kind: "fake", variant: "fake-test", systemOne: async (state, q) => ({
      answers: { verdict: { type: "choice", probabilities: { supported: 0.72, not_supported: 0.28 } } },
      latency_ms: 5, usage: { input_tokens: 17 },
    }) };
    M.embedder = { id: "fake-hash", embed: async (ts) => ts.map(() => new Float32Array(8).fill(0.1)) };
    M.model = { variant: "fake-test", backend: "fake", threads: 1 };

    // 2) rag-eval 로드 → IIFE가 코퍼스 fetch를 시작하지만 완료 전이다
    await import(`file://${path.join(tmp, "rag-eval.js")}`);
    const S = globalThis.window.__lrj.state; // 모듈 로드 직후: S.corpus가 아직 null일 수 있다
    el("subset").value = "quick";
    el("runBtn").click();          // 코퍼스 로드 전 클릭 (재현)

    // 3) 완료까지 대기 (코퍼스 지연 로딩 + 12주장 가짜 판별)
    for (let i = 0; i < 200 && !(S.current?.complete || /완료|오류/.test(el("runHint").textContent)); i++) {
      await new Promise((r) => setTimeout(r, 25));
      // 페이지가 요구하는 DOM 이벤트를 수동으로 발화: 진행 렌더 등
    }
    assert.match(el("runHint").textContent, /완료/, `runHint = ${el("runHint").textContent}`);
    assert.equal(S.current.records.length, 12, "quick 12주장 전부 판별됨");
    assert.equal(S.current.complete, true);
    assert.ok(el("kpis").innerHTML.length > 100, "KPI 렌더");
    assert.ok(el("claims").innerHTML.length > 500, "주장 표 렌더");
    assert.equal(S.running, false, "버튼 상태 회복");

    // 회귀 방어: 실행이 멈춘 채로 S.running이 true로 고정되면 클릭이 조용히 무시되선 안 된다
    S.running = true; S.runningSince = Date.now();
    el("runBtn").click();
    assert.match(el("runHint").textContent, /진행 중/, "잠긴 상태 클릭도 안내를 남긴다");
    S.runningSince = Date.now() - 190000; // 3분 초과 → 강제 해제 경로
    el("runBtn").click();
    for (let i = 0; i < 200 && !(/완료|진행 중/.test(el("runHint").textContent) && !S.running); i++)
      await new Promise((r) => setTimeout(r, 25));
    assert.match(el("runHint").textContent, /완료/, `3분 경과 시 클릭으로 실행 재개 (runHint = ${el("runHint").textContent})`);
    assert.ok(el("runBtn").disabled === false || S.running === false);
  } finally { restore(); }
});
