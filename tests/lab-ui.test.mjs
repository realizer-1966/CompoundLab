// 청킹 Lab UI 하네스: 가짜 DOM에서 web/lab.js를 실제로 실행해(브라우저-전용 결함을 여기서 잡는다)
// "실행 클릭 → runLab → render → 점수판/곡선/경계/인스펙터 그려짐 → 자동 스크롤" 전 경로를 검증한다.
// 과거 회귀 두 건이 바로 이 경로에서 발생: retrieve 미import (curve에서 ReferenceError), render() 누락 (성공 메시지 뒤 빈 화면).
// common.js의 임베더 체인(vendor의 ort/tokenizers)을 필요로 하므로, 테스트 내에서 web/를 tmpdir에 복사해 vendor를 채운다.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const webDir = path.resolve(root, "..", "web");
const nm = path.resolve(root, "..", "node_modules");

function makeSite() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "labui-"));
  fs.cpSync(webDir, tmp, { recursive: true, filter: (s) => !s.includes("vendor") });
  fs.mkdirSync(path.join(tmp, "vendor"));
  fs.copyFileSync(path.join(nm, "onnxruntime-web", "dist", "ort.min.mjs"), path.join(tmp, "vendor", "ort.min.mjs"));
  fs.copyFileSync(path.join(nm, "@huggingface", "tokenizers", "dist", "tokenizers.min.mjs"), path.join(tmp, "vendor", "tokenizers.min.mjs"));
  return tmp;
}

function fakeDom() {
  const els = {};
  const el = (id) => els[id] ??= {
    id, listeners: {}, innerHTML: "", textContent: "", value: "", disabled: false,
    addEventListener(t, fn) { (this.listeners[t] ??= []).push(fn) },
    click() { (this.listeners.click ?? []).forEach((fn) => fn()) },
    scrollIntoView() { els.__scrolledTo = id },
    closest() { return null },
  };
  globalThis.document = {
    getElementById: (id) => el(id),
    querySelectorAll: () => [], querySelector: () => null,
    currentScript: { src: "http://x/lab.js" },
  };
  globalThis.location = { search: "", href: "http://x/lab.html", origin: "http://x" };
  Object.defineProperty(globalThis, "navigator", { value: { hardwareConcurrency: 4 }, configurable: true });
  globalThis.localStorage = { getItem: () => null, setItem: () => {} };
  globalThis.sessionStorage = { getItem: () => null, setItem: () => {} };
  globalThis.CSS = { escape: (s) => s };
  globalThis.window = globalThis;
  return { el, els };
}

test("lab.js 실행 경로: 클릭 → runLab → render → 점수판·곡선·경계·인스펙터·자동 스크롤", async () => {
  const { LAB_TEXT, LAB_QE } = await import("file://" + path.join(webDir, "policyCorpus.js"));
  const tmp = makeSite();
  const { el, els } = fakeDom();
  for (const id of ["text", "qe", "L", "LVal", "budget", "budgetVal", "evalSplit", "runBtn", "runHint",
    "scoreboardWrap", "scoreboard", "labMeta", "curve", "boundaries", "qsel", "gsel2", "inspector"]) el(id);
  el("text").value = LAB_TEXT; el("qe").value = JSON.stringify(LAB_QE);
  el("L").value = "160"; el("budget").value = "30"; el("evalSplit").value = "all";

  await import(`file://${path.join(tmp, "lab.js")}`);
  el("runBtn").click();
  await new Promise((r) => setTimeout(r, 150));

  assert.match(el("runHint").textContent, /✔ 완료 \(\d+ ms, 빌드 /);
  assert.ok(el("scoreboard").innerHTML.length > 1000, "점수판 표가 그려진다");
  assert.ok(el("curve").innerHTML.includes("<svg"), "회수-예산 곡선 SVG");
  assert.ok(el("boundaries").innerHTML.length > 1000, "경계 지도");
  assert.ok((el("qsel").innerHTML.match(/<option/g) || []).length >= 5, "인스펙터 질문 목록");
  assert.ok(el("inspector").innerHTML.length > 500, "인스펙터 본문");
  assert.equal(els.__scrolledTo, "scoreboardWrap", "성공 시 점수판으로 자동 스크롤");
  assert.equal(el("runBtn").disabled, false);
  // tmpdir 정리는 프로세스 종료에 맡긴다 (tmp)
});
