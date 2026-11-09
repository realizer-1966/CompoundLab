// Retrieval primitives: sentence-aware chunking and brute-force cosine top-k. Pure functions, no DOM or model,
// so they run unchanged in Node for the unit tests.

export const RAG_DEFAULTS = { sentencesPerChunk: 2, overlap: 0, k: 3, scope: "document" };

// Tokens that end in a period but do not end a sentence.
const ABBREV = new Set(["dr", "mr", "mrs", "ms", "st", "no", "vs", "etc", "e.g", "i.e", "approx", "inc", "ltd", "co", "prof", "jr", "sr"]);

/** Split prose into sentences. Handles decimals ("6.5"), common abbreviations ("Dr. Lindqvist") and quotes.
 *  한국어처럼 문장 시작이 대문자가 아닌 언어도 다루도록, 뒤에 공백이 오면 문장 경계로 본다. */
export function splitSentences(text) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (!src) return [];
  const out = [];
  let start = 0;
  const re = /[.!?]["'”’)]*(?=\s+[^\s])/g;
  let m;
  while ((m = re.exec(src))) {
    const end = m.index + m[0].length;
    const before = src.slice(start, m.index);
    const lastWord = (before.match(/(?:^|\s)(\S+)$/) || [, ""])[1];
    if (m[0][0] === "." && ABBREV.has(lastWord.toLowerCase())) continue;
    if (m[0][0] === "." && /^[A-Z]$/.test(lastWord)) continue; // initials: "J. Smith"
    out.push(src.slice(start, end).trim());
    start = end;
  }
  const tail = src.slice(start).trim();
  if (tail) out.push(tail);
  return out;
}

/**
 * Split a document into passages of `sentencesPerChunk` sentences, sliding by (sentencesPerChunk - overlap).
 * @returns [{ index, text, firstSentence, sentences }]
 */
export function chunkText(text, { sentencesPerChunk = RAG_DEFAULTS.sentencesPerChunk, overlap = RAG_DEFAULTS.overlap } = {}) {
  const sents = splitSentences(text);
  const size = Math.max(1, sentencesPerChunk | 0);
  const step = Math.max(1, size - Math.max(0, Math.min(overlap | 0, size - 1)));
  const chunks = [];
  for (let i = 0; i < sents.length; i += step) {
    const part = sents.slice(i, i + size);
    chunks.push({ index: chunks.length, text: part.join(" "), firstSentence: i, sentences: part.length });
    if (i + size >= sents.length) break;
  }
  return chunks;
}

/** A stable key for a chunking configuration (part of every stored passage's key). */
export const chunkConfigKey = ({ sentencesPerChunk, overlap }) => `s${sentencesPerChunk}o${overlap || 0}`;

export function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** Brute-force scan: score every item's `vec` against `query`, return the best k as [{ item, score }], best first. */
export function topK(query, items, k = RAG_DEFAULTS.k) {
  return items
    .map((item) => ({ item, score: cosine(query, item.vec) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, k));
}

// English stopwords. Korean has none to speak of — particles attach inside the word ("에서는"), so a stop list there
// does not make sense; char n-grams take care of it instead.
const STOP = new Set("a an and are as at be but by can could did do does for from had has have how i if in is it its many much of on or our so that the their them then there these they this to was we were what when where which who why will with would you your".split(" "));

/**
 * Keyword terms for BM25 and the proximity reranker, bilingual on purpose. Latin words and numbers stay whole
 * tokens (English stopwords removed); every Hangul run is split into overlapping character 2-grams, because Korean
 * carries no spaces between words and a space-tokenised BM25 would score it 0. Runs of 1-2 characters are kept whole.
 * Overlapping bigrams cover both ends of a run — "백과사전" gives 백과/과사/사전 — and short queries like "소렐 밸리
 * 철도" produce tokens that match the document's runs exactly (advancedRagDemo's custom BM25, made Korean-aware).
 */
export function terms(s) {
  const src = String(s || "").toLowerCase();
  const out = [];
  for (const t of src.match(/[a-z0-9]+(?:'[a-z]+)?/g) || []) if (!STOP.has(t)) out.push(t);
  for (const run of src.match(/[가-힣ㄱ-ㅎㅏ-ㅣ]+/g) || []) {
    if (run.length <= 2) out.push(run);
    else for (let i = 0; i + 1 < run.length; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** BM25 keyword scores of `query` against each text (k1 = 1.2, b = 0.75). Exact terms and numbers count here. */
export function bm25(query, texts, { k1 = 1.2, b = 0.75 } = {}) {
  const docs = texts.map(terms);
  const N = docs.length, avg = docs.reduce((a, d) => a + d.length, 0) / Math.max(1, N);
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  const q = [...new Set(terms(query))];
  return docs.map((d) => {
    const tf = new Map(); for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t); if (!f) continue;
      const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5));
      s += idf * (f * (k1 + 1)) / (f + k1 * (1 - b + b * d.length / (avg || 1)));
    }
    return s;
  });
}

/**
 * Hybrid ranking: cosine and BM25, each min-max normalized over the candidates, mixed with weight `w` on cosine.
 * @returns [{ item, score, cosine, keyword }] best first
 */
export function hybridTopK(query, qvec, items, k, w = 0.6) {
  const cos = items.map((it) => cosine(qvec, it.vec));
  const kw = bm25(query, items.map((it) => it.text));
  const norm = (xs) => { const lo = Math.min(...xs), hi = Math.max(...xs); return xs.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 0)); };
  const nc = norm(cos), nk = norm(kw);
  return items.map((item, i) => ({ item, score: w * nc[i] + (1 - w) * nk[i], cosine: cos[i], keyword: kw[i] }))
    .sort((a, b) => b.score - a.score).slice(0, Math.max(1, k));
}

/**
 * Stage-2 proximity reranking, adapted from advancedRagDemo's syntactic-proximity reranker: passages where the
 * query's keywords cluster tightly rank higher. Bilingual via terms() — for Korean the overlapping bigrams stand
 * in for words, so "밸리 철도" rewards passages where those characters appear together.
 *
 * @returns a score in 0..1: 60% how many of the query's terms are present, 40% how tightly they cluster
 *   (1/(1 + span/5) decay). null when nothing matches — there is nothing to be close to.
 */
export function proximityScore(query, text) {
  const q = [...new Set(terms(query))];
  if (q.length < 2) return null;
  const toks = terms(text);
  const pos = new Map(q.map((t) => [t, []]));
  for (let i = 0; i < toks.length; i++) if (pos.has(toks[i])) pos.get(toks[i]).push(i);
  const present = [...pos.values()].filter((l) => l.length);
  const coverage = present.length / q.length;
  if (!present.length) return null;
  if (present.length === 1) return coverage * 0.6; // one term only: nothing to be close to, but partial credit counts
  // Smallest token window covering one occurrence of every matching term: a k-list minimal-window sweep over
  // sorted positions (same smallest-word-gap idea as advancedRagDemo, without its Cartesian-combination cap).
  const events = [];
  present.forEach((list, gi) => { for (const p of list) events.push([p, gi]); });
  events.sort((a, b) => a[0] - b[0]);
  const seen = new Map();
  let covered = 0, lo = 0, minWindow = Infinity;
  for (let hi = 0; hi < events.length; hi++) {
    const [p, gi] = events[hi];
    seen.set(gi, (seen.get(gi) || 0) + 1);
    if (seen.get(gi) === 1) covered++;
    while (covered === present.length) {
      minWindow = Math.min(minWindow, p - events[lo][0]);
      const lgi = events[lo][1];
      if (seen.get(lgi) === 1) { covered--; seen.delete(lgi); } else seen.set(lgi, seen.get(lgi) - 1);
      lo++;
    }
  }
  return coverage * 0.6 + (1 / (1 + minWindow / 5)) * 0.4;
}

/**
 * Re-sort a ranked list by blending each passage's stage-1 score with its proximity bonus (40% stage-1, 60%
 * proximity — near advancedRagDemo's reranker, where proximity effectively leads stage 2), both min-max
 * normalised over the candidates. Passages with no keyword match count 0; a query with fewer than two terms
 * leaves the list unchanged. Each item gains `proximity`, and the sort key `rerankScore`.
 *
 * @returns a new array, best first
 */
export function proximityRerank(query, ranked) {
  const prox = ranked.map((r) => proximityScore(query, r.text));
  if (prox.every((p) => p == null)) return ranked.map((r) => ({ ...r, proximity: null }));
  const norm = (xs) => { const lo = Math.min(...xs), hi = Math.max(...xs); return xs.map((x) => (hi > lo ? (x - lo) / (hi - lo) : 0)); };
  const ns = norm(ranked.map((r) => r.score)), np = norm(prox.map((p) => p ?? 0));
  return ranked.map((r, i) => ({ ...r, proximity: prox[i], rerankScore: 0.4 * ns[i] + 0.6 * np[i] }))
    .sort((a, b) => b.rerankScore - a.rerankScore || b.score - a.score);
}

/** True if any retrieved passage contains the gold evidence span (a verbatim substring of the document). */
export function evidenceRetrieved(passages, evidence) {
  if (!evidence) return null;
  const norm = (s) => s.replace(/\s+/g, " ").toLowerCase();
  const e = norm(evidence);
  return passages.some((p) => norm(p.text).includes(e));
}
