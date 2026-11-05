// The Laya "judge": the claim plus its retrieved passages become the state of ONE typed question, and the answer is
// reduced to p(supported). Several phrasings ("presets") are available because this checkpoint's probabilities are
// sensitive to wording; the evaluation page measures each against the gold labels.

export const LABELS = ["supported", "not_supported"];

export const PRESETS = {
  choice2: {
    name: "두 선택지: 지지함 / 지지하지 않음",
    question: {
      type: "choice",
      instructions: "주어진 근거 문장들이 이 주장을 지지합니까?",
      criteria: {
        supported: "지지함 — 근거 문장들이 주장을 그대로 서술하거나 명확하게 뒷받침한다",
        not_supported: "지지하지 않음 — 근거 문장들이 주장과 다른 내용을 말하거나 주장에 대해 아무 말도 하지 않는다",
      },
    },
    pSupported: (a) => a.probabilities.supported,
  },
  choice3: {
    name: "세 선택지: 지지함 / 반박함 / 언급 없음",
    question: {
      type: "choice",
      instructions: "근거 문장들은 이 주장에 대해 무엇이라고 말하고 있습니까?",
      criteria: {
        supported: "지지함 — 근거 문장들이 주장을 그대로 서술하거나 명확하게 뒷받침한다",
        contradicted: "반박함 — 근거 문장들이 주장과 다른 내용을 말한다",
        not_mentioned: "언급 없음 — 근거 문장들이 주장이 사실인지 아닌지를 말하지 않는다",
      },
    },
    pSupported: (a) => a.probabilities.supported,
  },
  noul: {
    name: "예 / 아니오: 근거가 주장을 완전히 지지한다",
    question: { type: "noul", instructions: "근거 문장들이 이 주장을 완전히 지지한다" },
    pSupported: (a) => a.noul,
  },
};
export const DEFAULT_PRESET = "choice2";

// Default confidence bar for acting automatically. This checkpoint's probabilities are compressed (a verdict of
// p = 0.83 has confidence 0.34), so the 0.90 used elsewhere would hold every claim for review. Measured on the
// sample with the two-option question: confidence >= 0.10 keeps ~44% of claims at ~84% accuracy (see README).
export const DEFAULT_THRESHOLD = 0.1;

/** The state Laya sees. Kept as a plain object; laya-core serializes it the way the Python original does. */
export function buildState(claim, passages) {
  return { claim: String(claim).trim(), evidence: passages.map((p) => (typeof p === "string" ? p : p.text)) };
}

/** 1 - normalized binary entropy of p (the layaForWeb confidence convention, applied to the supported split). */
export function binaryConfidence(p) {
  const q = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
  const h = -(q * Math.log(q) + (1 - q) * Math.log(1 - q));
  return Math.min(Math.max(1 - h / Math.log(2), 0), 1);
}

/** Reduce a Laya answer to { pSupported, confidence, probabilities }. */
export function interpret(answer, presetId = DEFAULT_PRESET) {
  const preset = PRESETS[presetId];
  const p = preset.pSupported(answer);
  const probabilities = answer.type === "noul" ? { supported: p, not_supported: 1 - p } : answer.probabilities;
  return { pSupported: p, confidence: binaryConfidence(p), probabilities };
}

export const verdictOf = (pSupported, cutoff = 0.5) => (pSupported >= cutoff ? "supported" : "not_supported");

/**
 * Confidence gating, same idea as the workflows page: act automatically only when the judge is sure.
 *   AUTO  = confident "supported"      -> answer can be shown with its citation
 *   BLOCK = confident "not supported"  -> answer is withheld / regenerated
 *   HOLD  = below the threshold        -> flagged for a person to review
 */
export function gate(pSupported, confidence, { cutoff = 0.5, threshold = 0.5 } = {}) {
  if (confidence < threshold) return "HOLD";
  return verdictOf(pSupported, cutoff) === "supported" ? "AUTO" : "BLOCK";
}

/** Fingerprint of a question, so cached/recorded results are only reused if the wording is unchanged. */
export function questionKey(q) {
  const s = JSON.stringify(q);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
