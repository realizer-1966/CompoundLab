// Answer generation + per-sentence judging (Phase 2, the merge's core): given a question and retrieved passages,
// generate a grounded answer with [n] citations, then point the claim-verification judge (Laya in-browser, or Ollama
// Clef) at every sentence of the answer. Gates decide which sentences are shown as supported / flagged / withheld —
// advancedRagDemo answers questions with its retrieved chunks; this pipeline then answers questions about that answer.
import { splitSentences } from "./rag.js";
import { PRESETS, buildState, interpret, gate } from "./judge.js";
import { clefBase, CLEF_DEFAULT_MODEL } from "./clef.js";

export const GEN_DEFAULT_MODEL = "glm-5.3-flash:cloud";
export const DEFAULT_GEN_THRESHOLD = 0.1;

// ---- generation --------------------------------------------------------------------------------------

export const GEN_SYSTEM = [
  "당신은 제공된 근거 구절만 근거로 사용하는 RAG 어시스턴트입니다.",
  "규칙:", "1. 근거 구절에 있는 내용으로만 답합니다. 근거에 없는 사실은 절대 쓰지 않습니다.",
  "2. 답변의 각 문장이 어느 근거에서 나왔는지 문장 끝에 [1] 형식으로 표시합니다. 여러 근거면 [1][3]처럼 나란히 씁니다.",
  "3. 근거만으로 답할 수 없으면 추측하지 말고 '근거에 답이 없습니다'라고 말합니다.",
  "4. 한국어로 간결하게 답합니다. 근거를 그대로 베끼지 말고 문장으로 서술합니다.",
].join("\n");

export function buildPrompt(question, passages) {
  return `${passages.map((p, i) => `[${i + 1}] ${p.text}`).join("\n\n")}\n\n질문: ${question}`;
}

/** Ollama /api/chat, non-streaming. Base defaults to the judge's Ollama server. */
export async function ollamaChat({ model = GEN_DEFAULT_MODEL, base = clefBase(), system = GEN_SYSTEM, user, timeoutMs = 120000 } = {}) {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/api/chat`, {
      method: "POST", headers: { "Content-Type": "application/json" }, cache: "no-store",
      signal: ctrl.signal,
      body: JSON.stringify({ model, messages: [
        { role: "system", content: system }, { role: "user", content: user },
      ], stream: false }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Ollama chat 실패 (HTTP ${res.status}): ${body.slice(0, 200) || "응답 없음"} — 'ollama pull ${model}'로 모델을 확인하거나 Mock AI를 쓰세요.`);
    }
    const data = await res.json();
    const text = data?.message?.content?.trim();
    if (!text) throw new Error("Ollama chat이 빈 답변을 반환했습니다.");
    return { text, ms: performance.now() - t0, tokens: data?.prompt_eval_count ?? null, model };
  } finally { clearTimeout(timer); }
}

/**
 * Mock AI — fully offline extractive generation (advancedRagDemo's grounded mock): every sentence comes from one of
 * the retrieved passages, citation included, nothing is invented. Deterministic, so it is testable and the whole
 * pipeline (retrieve → generate → judge the answer) runs with zero model calls for generation.
 */
export function mockAnswer(question, passages) {
  if (!passages.length) return "근거를 찾지 못했습니다. 질문과 일치하는 구절이 없습니다.";
  const out = [];
  for (const p of passages.slice(0, Math.min(3, passages.length))) {
    const n = passages.indexOf(p) + 1;
    const sents = splitSentences(p.text);
    // citation inside the sentence, before the final period: "...했다 [1]." — appended after the period it would
    // separate into its own no-text fragment when the answer is split into claims (and lose the citation).
    out.push(`${(sents[0]?.trim() || p.text).replace(/[.!?]+$/, "")} [${n}].`);
    if (sents[1]) out.push(`${sents[1].trim().replace(/[.!?]+$/, "")} [${n}].`);
  }
  return out.join(" ");
}

/**
 * @param { "ollama" | "mock" } mode   mode "ollama" needs a reachable Ollama server and a chat model tag;
 *                                     mode "mock" never calls a server.
 */
export async function generate({ mode = "ollama", model = GEN_DEFAULT_MODEL, question, passages } = {}) {
  if (mode === "mock") {
    const mockT0 = performance.now();
    const text = mockAnswer(question, passages);
    return { text, ms: performance.now() - mockT0, model: "mock", mock: true };
  }
  return await ollamaChat({ model, user: buildPrompt(question, passages) });
}

// ---- per-sentence judging -----------------------------------------------------------------------------

/** Extract citations like [1] / [1][3] from a sentence: { text, cites }. */
export function parseCitations(sentence) {
  const s = String(sentence || "");
  const cites = [...s.matchAll(/\[(\d+)\]/g)].map((m) => +m[1]);
  return { text: s.replace(/\s*\[(\d+)\]\s*/g, " ").replace(/\s+/g, " ").trim(), cites: [...new Set(cites)] };
}

/** Split a generated answer into judgeable claims (sentences), keeping blank lines as structure. */
export function splitClaims(answerText) {
  const paragraphs = String(answerText || "").split(/\n{2,}|\n(?=#{|##|- |·)/);
  const out = [];
  for (const para of paragraphs) {
    for (const s of splitSentences(para)) {
      const parsed = parseCitations(s);
      if (parsed.text) out.push(parsed);
    }
  }
  return out;
}

/**
 * Judge every claim of the answer against the retrieved passages with the claim-verification judge — the same
 * typed question the eval page scores (choice2 by default), so the thresholds mean the same thing in both places.
 * @returns [{ text, cites, pSupported, confidence, gate, judgeMs }]
 */
export async function verifyClaims(laya, claims, passages, { presetId = "choice2", cutoff = 0.5, threshold = DEFAULT_GEN_THRESHOLD, onProgress = () => {} } = {}) {
  const preset = PRESETS[presetId];
  const evidence = passages.map((p) => p.text);
  const out = [];
  for (let i = 0; i < claims.length; i++) {
    const claim = claims[i];
    onProgress(i + 1, claims.length, claim.text);
    const res = await laya.systemOne(buildState(claim.text, evidence), { verdict: preset.question });
    const it = interpret(res.answers.verdict, presetId);
    out.push({
      ...claim, pSupported: it.pSupported, confidence: it.confidence,
      gate: gate(it.pSupported, it.confidence, { cutoff, threshold }),
      judgeMs: res.latency_ms, tokens: res.usage?.input_tokens ?? null,
    });
  }
  return out;
}

/** Unsupported claims in an answer with a real citation should block it; missing citations are their own warning. */
export function summarize(claims) {
  const g = { AUTO: 0, BLOCK: 0, HOLD: 0, nocite: 0 };
  for (const c of claims) {
    g[c.gate] = (g[c.gate] || 0) + 1;
    if (!c.cites.length) g.nocite++;
  }
  return { claims: claims.length, ...g, clean: (g.BLOCK || 0) === 0 };
}
