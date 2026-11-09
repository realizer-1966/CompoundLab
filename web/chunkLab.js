// chunkLab.js — Chunking Lab 엔진 (Phase 3, advancedRagDemo 원본의 한국어 대응 포트:
// • 고정 윈도 / 문장 윈도 (베이스라인, rag.js chunkText와 같은 알고리즘)
// • StrucChunk류 구조 인식 청킹 (arXiv 2610.26313): provision 경계, 제목 경로, 상호 참조 해결 — "3.1절" 표기
// • QESChunker (arXiv 2610.36557): question–evidence 쌍으로 지도 최적화. 비겹침 → 정확 동적 계획법,
//   겹침 → 단조 부모듈러 커버리지 목적 함수의 탐욕 근사
// • SpectRAG-lite (arXiv 2610.36991): 가중 청크 그래프 + 개인화 PageRank + 토큰 예산 조립, flat top-k와 비교
// • 완전 근거 회수(complete-evidence recall): 컨텍스트가 질문에 필요한 모든 증거를 담았는가 (arXiv 2610.26951)
// 순수 JS — IndexedDB도 모델 다운로드도 없어 Node 테스트가 가능하다. 토크나이저는 rag.js의 한국어 인식 terms()를 그대로 쓴다
// (원본은 영어 공백 토큰이라 한국어에서 BM25가 0점이 되는 문제를 이식 과정에서 고쳤다).

import { terms as tokenize } from "./rag.js";

// 상호 참조 표기: "3.1절" (원본은 "Section 3.1")
const XREF = /(\d+(?:\.\d+)+)\s*절/g;

// ── 텍스트 단위 ────────────────────────────────────────────────────────────────

/** 문장 경계를 캐릭터 오프셋으로. 한국어도 ".!? + 공백" 규칙은 같다 (rag.js splitSentences와 동일 규칙). */
function sentenceSpans(line, base) {
  const out = [];
  let s = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if ((c === "." || c === "!" || c === "?") && (i + 1 === line.length || /\s/.test(line[i + 1]))) {
      let j = i + 1;
      if (line[j] === ")") j++;
      out.push([s, j]);
      while (j < line.length && /\s/.test(line[j])) j++;
      s = j;
      i = j - 1;
    }
  }
  if (s < line.length && line.slice(s).trim()) out.push([s, line.length]);
  return out.map(([a, b]) => ({ start: base + a, end: base + b }));
}

/** 마크다운 문서를 단위(제목과 문장, 캐릭터 오프셋)와 provision("### x.y ..." 제목과 본문)으로 분해. */
export function parseDocument(text) {
  const C = text.replace(/\r\n/g, "\n");
  const units = [];
  const provisions = [];
  const path = [];
  let offset = 0, current = null;
  for (const line of C.split("\n")) {
    const lineStart = offset;
    offset += line.length + 1;
    if (!line.trim()) continue;
    const lead = line.length - line.trimStart().length;
    const h = line.trim().match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length, title = h[2].trim();
      const idm = title.match(/^(\d+(?:\.\d+)*)\s+(.*)$/);
      while (path.length && path[path.length - 1].level >= level) path.pop();
      const node = { level, title, id: idm ? idm[1] : null, name: idm ? idm[2] : title };
      path.push(node);
      const u = { start: lineStart + lead, end: lineStart + line.length, type: "heading", level };
      units.push(u);
      // provision은 가장 깊은 제목(level ≥ 3)이나 번호 매겨진 x.y 제목이 연다
      if (level >= 3 || (node.id && node.id.includes("."))) {
        current = {
          id: node.id || title, title: node.name, heading: u,
          path: path.slice(0, -1).filter((p) => p.level > 1).map((p) => p.title).concat(title),
          unitIdx: [units.length - 1], start: u.start, end: u.end,
        };
        provisions.push(current);
      } else current = null;
      continue;
    }
    for (const sp of sentenceSpans(line.slice(lead), lineStart + lead)) {
      const u = { ...sp, type: "sentence" };
      units.push(u);
      if (current) { current.unitIdx.push(units.length - 1); current.end = u.end }
    }
  }
  units.forEach((u, i) => { u.i = i; u.text = C.slice(u.start, u.end) });
  provisions.forEach((p, pi) => p.unitIdx.forEach((ui) => { units[ui].prov = pi }));
  return { C, units, provisions };
}

const norm = (s) => s.replace(/\s+/g, " ").trim();
const words = (s) => (s.match(/\S+/g) || []).length;

function mkChunk(doc, start, end, extra = {}) {
  const text = extra.text ?? doc.C.slice(start, end);
  return { start, end, text, words: words(text), ...extra };
}

// ── 청커 ──────────────────────────────────────────────────────────────────────

/** 1. 고정 크기 캐릭터 윈도 (대부분의 튜토리얼 기본값). */
export function chunkFixed(doc, L, overlap = 50) {
  const out = [];
  const step = Math.max(1, L - overlap);
  for (let s = 0; s < doc.C.length; s += step) {
    const e = Math.min(doc.C.length, s + L);
    if (doc.C.slice(s, e).trim()) out.push(mkChunk(doc, s, e));
    if (e >= doc.C.length) break;
  }
  return out;
}

/** 2. 문장 윈도(겹침 포함) — rag.js chunkText와 같은 알고리즘 (문장 목록 기준으로 붙이는 방식). */
export function chunkSentence(doc, L, overlap = 50) {
  const out = [];
  const U = doc.units;
  let cur = [];
  const len = (arr) => (arr.length ? U[arr[arr.length - 1]].end - U[arr[0]].start : 0);
  for (let i = 0; i < U.length; i++) {
    const trial = cur.concat(i);
    if (len(trial) > L && cur.length) {
      out.push(mkChunk(doc, U[cur[0]].start, U[cur[cur.length - 1]].end));
      // 겹침 예산이 채워질 때까지 문장을 되돌아간다
      const keep = [];
      for (let j = cur.length - 1; j >= 0; j--) {
        const k = [cur[j], ...keep];
        if (len(k) <= overlap) keep.unshift(cur[j]); else break;
      }
      cur = keep;
    }
    cur.push(i);
  }
  if (cur.length) out.push(mkChunk(doc, U[cur[0]].start, U[cur[cur.length - 1]].end));
  return out;
}

/** 3. 구조 인식 (StrucChunk류): provision당 청크 하나, provision 경계를 절대 넘지 않고,
 *  청크 앞에 제목 경로를 붙인 뒤 "x.y절" 상호 참조를 참조 provision 본문으로 해결해 인덱싱한다. */
export function chunkStructure(doc, L, { resolveRefs = true, refChars = 320 } = {}) {
  const { C, units, provisions } = doc;
  const byId = new Map(provisions.map((p, i) => [p.id, i]));
  const bodyText = (p, maxChars) => {
    let t = "";
    for (const ui of p.unitIdx.slice(1)) {
      const s = units[ui].text;
      if (t && (t + " " + s).length > maxChars) break;
      t += (t ? " " : "") + s;
    }
    return t;
  };
  const out = [];
  provisions.forEach((p, pi) => {
    const prefix = "[" + p.path.join(" › ") + "]";
    const body = p.unitIdx.slice(1);
    const pieces = [];
    let cur = [];
    for (const ui of body) {
      const t = cur.concat(ui);
      if (cur.length && units[t[t.length - 1]].end - units[t[0]].start > L) { pieces.push(cur); cur = [] }
      cur.push(ui);
    }
    if (cur.length || !pieces.length) pieces.push(cur);
    pieces.forEach((piece, k) => {
      const start = k === 0 ? p.heading.start : units[piece[0]].start;
      const end = piece.length ? units[piece[piece.length - 1]].end : p.heading.end;
      const raw = piece.map((ui) => units[ui].text).join(" ");
      let refs = [];
      if (resolveRefs) {
        const seen = new Set();
        for (const m of C.slice(start, end).matchAll(XREF)) {
          const ti = byId.get(m[1]);
          if (ti === undefined || ti === pi || seen.has(ti)) continue;
          seen.add(ti);
          refs.push({ id: m[1], prov: ti, text: bodyText(provisions[ti], refChars) });
        }
      }
      const refText = refs.map((r) => `\n↳ ${r.id}절 ${provisions[r.prov].title}: ${r.text}`).join("");
      out.push(mkChunk(doc, start, end, {
        text: `${prefix}\n${raw}${refText}`, prov: pi, refs: refs.map((r) => r.prov),
      }));
    });
  });
  return out;
}

/** evidence 문자열 → 문서 단위 범위로 매핑. 찾지 못하면 s=-1. */
export function locateEvidence(doc, qe) {
  const { C, units } = doc;
  const unitAt = (pos) => {
    let lo = 0, hi = units.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (units[m].start <= pos) lo = m; else hi = m - 1 }
    return lo;
  };
  return qe.map((item, qi) => ({
    ...item, qi,
    ev: item.evidence.map((text) => {
      const s = C.indexOf(text);
      if (s < 0) return { text, s: -1, e: -1, ua: -1, ub: -1 };
      const e = s + text.length;
      return { text, s, e, ua: unitAt(s), ub: unitAt(e - 1) };
    }),
  }));
}

/** 4. QES, 비겹침: 단위열을 ≤ L 캐릭터 연속 청크로 나누는 모든 분할 중 question–evidence 효용 최대.
 *  목적 함수가 청크에 분해되므로 정확한 O(n·w) 동적 계획법으로 푼다.
 *  u(chunk) = Σ_evidence [span이 청크 안에] + Σ_question [그 질문의 모든 증거가 안에] − μ */
export function chunkQESDP(doc, L, trainEv, mu = 0.05) {
  const U = doc.units, n = U.length;
  const spans = trainEv.flatMap((q) => q.ev.filter((e) => e.ua >= 0));
  const qs = trainEv.map((q) => q.ev.filter((e) => e.ua >= 0)).filter((a) => a.length);
  const util = (j, i) => { // 단위 j..i-1
    let u = -mu;
    for (const e of spans) if (e.ua >= j && e.ub < i) u += 1;
    for (const q of qs) if (q.length > 1 && q.every((e) => e.ua >= j && e.ub < i)) u += 1;
    return u;
  };
  const best = new Array(n + 1).fill(-Infinity), arg = new Array(n + 1).fill(-1);
  best[0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = i - 1; j >= 0; j--) {
      const span = U[i - 1].end - U[j].start;
      if (span > L && j < i - 1) break;
      const v = best[j] + util(j, i);
      if (v > best[i]) { best[i] = v; arg[i] = j }
    }
  }
  const cuts = [];
  for (let i = n; i > 0; i = arg[i]) cuts.unshift([arg[i], i]);
  return { chunks: cuts.map(([j, i]) => mkChunk(doc, U[j].start, U[i - 1].end, { units: [j, i] })), objective: best[n] };
}

/** 5. QES, 겹침: 총 크기 예산 아래에서 (겹칠 수 있는) 윈도 집합을 고른다. 증거 span / 완전 질문 / 문서 단위의
 *  커버리지는 단조 부모듈러라 비용-효익 탐욕이 (1 − 1/√e) 보장을 준다. 예산이 소진된 뒤에도 안 덮인 단위는
 *  gap 청크로 채워 문서 전체가 검색 가능하게 유지한다. */
export function chunkQESOverlap(doc, L, trainEv, budgetRatio = 1.35, alpha = 0.02, minFrac = 0.5) {
  const U = doc.units, n = U.length;
  const spans = trainEv.flatMap((q) => q.ev.filter((e) => e.ua >= 0));
  const qs = trainEv.map((q) => q.ev.filter((e) => e.ua >= 0)).filter((a) => a.length > 1);
  const cands = [];
  for (let j = 0; j < n; j++) for (let i = j + 1; i <= n; i++) {
    const cost = U[i - 1].end - U[j].start;
    if (cost > L && i > j + 1) break;
    if (cost < minFrac * L && i < n) continue; // 너무 짧은 윈도 금지(끝 제외): 탐욕이 한 문장 청크로 붕괴하는 걸 막는다
    cands.push({ j, i, cost: Math.max(cost, 1) });
  }
  const spanDone = new Array(spans.length).fill(false);
  const qDone = new Array(qs.length).fill(false);
  const unitDone = new Array(n).fill(false);
  const gain = (c) => {
    let g = 0;
    spans.forEach((e, k) => { if (!spanDone[k] && e.ua >= c.j && e.ub < c.i) g += 1 });
    qs.forEach((q, k) => { if (!qDone[k] && q.every((e) => e.ua >= c.j && e.ub < c.i)) g += 1 });
    for (let u = c.j; u < c.i; u++) if (!unitDone[u]) g += alpha;
    return g;
  };
  const budget = budgetRatio * doc.C.length;
  let spent = 0;
  const chosen = [];
  for (;;) {
    let bestC = null, bestR = 0;
    for (const c of cands) {
      if (spent + c.cost > budget) continue;
      const g = gain(c);
      if (g <= 0) continue;
      const r = g / c.cost;
      if (r > bestR) { bestR = r; bestC = c }
    }
    if (!bestC) break;
    chosen.push(bestC); spent += bestC.cost;
    spans.forEach((e, k) => { if (e.ua >= bestC.j && e.ub < bestC.i) spanDone[k] = true });
    qs.forEach((q, k) => { if (q.every((e) => e.ua >= bestC.j && e.ub < bestC.i)) qDone[k] = true });
    for (let u = bestC.j; u < bestC.i; u++) unitDone[u] = true;
  }
  let gap = [];
  const flush = () => {
    if (!gap.length) return;
    let cur = [];
    for (const u of gap) {
      if (cur.length && U[u].end - U[cur[0]].start > L) { chosen.push({ j: cur[0], i: cur[cur.length - 1] + 1, gap: true }); cur = [] }
      cur.push(u);
    }
    if (cur.length) chosen.push({ j: cur[0], i: cur[cur.length - 1] + 1, gap: true });
    gap = [];
  };
  for (let u = 0; u < n; u++) { if (!unitDone[u]) gap.push(u); else flush() }
  flush();
  chosen.sort((a, b) => a.j - b.j || a.i - b.i);
  return chosen.map((c) => mkChunk(doc, U[c.j].start, U[c.i - 1].end, { units: [c.j, c.i], gap: !!c.gap }));
}

// ── 검색 ──────────────────────────────────────────────────────────────────────

/** 한국어 bigram 토큰에는 영어 접미사가 없고, 영어 토큰에는 여전히 유효하다. 모든 전략에 동일 적용되어 공평하다. */
const stem = (t) => (t.length > 4 ? t.replace(/(ings|ing|edly|ed|es|s)$/, "") : t);
const toks = (text) => tokenize(text).map(stem);

export class MiniBM25 {
  constructor(chunks, k1 = 1.2, b = 0.75) {
    this.k1 = k1; this.b = b;
    this.docs = chunks.map((c) => toks(c.text));
    this.avg = this.docs.reduce((a, d) => a + d.length, 0) / Math.max(1, this.docs.length);
    this.df = new Map();
    this.tf = this.docs.map((d) => {
      const m = new Map();
      d.forEach((t) => m.set(t, (m.get(t) || 0) + 1));
      m.forEach((_, t) => this.df.set(t, (this.df.get(t) || 0) + 1));
      return m;
    });
  }
  score(query) {
    const N = this.docs.length;
    const q = [...new Set(toks(query))];
    return this.tf.map((m, i) => {
      let s = 0;
      for (const t of q) {
        const f = m.get(t); if (!f) continue;
        const df = this.df.get(t);
        const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
        s += idf * (f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + this.b * this.docs[i].length / this.avg));
      }
      return s;
    });
  }
}

/** 가중 청크 그래프: 인접, 같은 provision, 해결된 상호 참조, 어휘 겹침. */
export function buildChunkGraph(doc, chunks) {
  const n = chunks.length;
  const sets = chunks.map((c) => new Set(toks(c.text)));
  const provOf = (c) => {
    const u = doc.units.find((u) => u.end > c.start);
    return u ? u.prov : undefined;
  };
  const prov = chunks.map(provOf);
  const covers = (c, p) => { const P = doc.provisions[p]; return c.start < P.end && c.end > P.start };
  const edges = [];
  const add = (a, b, w, type) => { if (a !== b) edges.push({ a, b, w, type }) };
  const order = chunks.map((c, i) => i).sort((x, y) => chunks[x].start - chunks[y].start);
  for (let k = 1; k < order.length; k++) add(order[k - 1], order[k], 1, "adjacent");
  for (let a = 0; a < n; a++) {
    for (const m of doc.C.slice(chunks[a].start, chunks[a].end).matchAll(XREF)) {
      const p = doc.provisions.findIndex((P) => P.id === m[1]);
      if (p < 0) continue;
      for (let b = 0; b < n; b++) if (b !== a && covers(chunks[b], p) && !covers(chunks[a], p)) add(a, b, 1, "xref");
    }
    for (let b = a + 1; b < n; b++) {
      if (prov[a] !== undefined && prov[a] === prov[b] && Math.abs(order.indexOf(a) - order.indexOf(b)) > 1) add(a, b, 0.5, "section");
      let inter = 0;
      sets[a].forEach((t) => { if (sets[b].has(t)) inter++ });
      const jac = inter / (sets[a].size + sets[b].size - inter || 1);
      if (jac >= 0.18) add(a, b, jac * 2, "lexical");
    }
  }
  const adj = Array.from({ length: n }, () => []);
  for (const e of edges) { adj[e.a].push([e.b, e.w]); adj[e.b].push([e.a, e.w]) }
  return { edges, adj };
}

/** 점수 순으로 단어 예산을 채우되, 거의 중복인 청크는 건너뛴다. */
function assemble(chunks, order, budget) {
  const picked = [], seen = new Set();
  let used = 0;
  for (const i of order) {
    const c = chunks[i];
    if (used + c.words > budget) continue;
    const t = toks(c.text);
    const novel = t.filter((x) => !seen.has(x)).length / Math.max(1, t.length);
    if (picked.length && novel < 0.3) continue;
    picked.push(i); used += c.words;
    t.forEach((x) => seen.add(x));
  }
  return { picked, used };
}

const normalise = (arr) => { const m = Math.max(...arr, 1e-9); return arr.map((v) => v / m) };

export function retrieve(chunks, bm25, graph, query, budget, mode = "flat", seeds = 3) {
  const s = bm25.score(query);
  const rank = s.map((v, i) => i).filter((i) => s[i] > 0).sort((a, b) => s[b] - s[a]);
  if (mode === "flat") return { ...assemble(chunks, rank, budget), scores: s, seeds: rank.slice(0, seeds), rank };
  // SpectRAG-lite: BM25 시드에서 가중 청크 그래프 위로 개인화 PageRank
  const n = chunks.length;
  const seedSet = rank.slice(0, seeds);
  const p0 = new Array(n).fill(0);
  const tot = seedSet.reduce((a, i) => a + s[i], 0) || 1;
  seedSet.forEach((i) => { p0[i] = s[i] / tot });
  let p = p0.slice();
  const deg = graph.adj.map((l) => l.reduce((a, [, w]) => a + w, 0) || 1);
  for (let it = 0; it < 25; it++) {
    const nxt = p0.map((v) => 0.5 * v);
    p.forEach((v, i) => { if (v) graph.adj[i].forEach(([j, w]) => { nxt[j] += 0.5 * v * w / deg[i] }) });
    p = nxt;
  }
  const ns = normalise(s), np = normalise(p);
  const combined = ns.map((v, i) => 0.6 * v + 0.4 * np[i]);
  const order = combined.map((v, i) => i).filter((i) => combined[i] > 0).sort((a, b) => combined[b] - combined[a]);
  return { ...assemble(chunks, order, budget), scores: combined, seeds: seedSet, ppr: p, rank };
}

// ── 지표 ──────────────────────────────────────────────────────────────────────

export function contextHas(chunks, picked, evidenceText) {
  const t = norm(evidenceText);
  return picked.some((i) => norm(chunks[i].text).includes(t));
}

export function evaluateStrategy(doc, chunks, evSet, budget) {
  const bm25 = new MiniBM25(chunks);
  const graph = buildChunkGraph(doc, chunks);
  const starts = chunks.slice().sort((a, b) => a.start - b.start).slice(1);
  const headingStarts = new Set(doc.units.filter((u) => u.type === "heading").map((u) => u.start));
  const clean = starts.filter((c) => headingStarts.has(c.start + (doc.C.slice(c.start).length - doc.C.slice(c.start).trimStart().length))).length;
  const allEv = evSet.flatMap((q) => q.ev.filter((e) => e.s >= 0));
  const intact = allEv.filter((e) => chunks.some((c) => c.start <= e.s && c.end >= e.e)).length;
  // 상호 참조: "3.1절"을 담은 청크가 3.1절의 첫 문장도 담는가
  let xrefTotal = 0, xrefOk = 0;
  for (const m of doc.C.matchAll(XREF)) {
    const P = doc.provisions.find((p) => p.id === m[1]); if (!P || P.unitIdx.length < 2) continue;
    xrefTotal++;
    const target = norm(doc.units[P.unitIdx[1]].text);
    const holders = chunks.filter((c) => c.start <= m.index && c.end >= m.index + m[0].length);
    if (holders.some((c) => norm(c.text).includes(target))) xrefOk++;
  }
  const perQ = evSet.map((q) => {
    const out = {};
    for (const mode of ["flat", "graph"]) {
      const r = retrieve(chunks, bm25, graph, q.q, budget, mode);
      const found = q.ev.map((e) => contextHas(chunks, r.picked, e.text));
      out[mode] = { ...r, found, complete: found.every(Boolean), partial: found.some(Boolean) };
    }
    return out;
  });
  const frac = (k, mode) => perQ.filter((p) => p[mode][k]).length / Math.max(1, perQ.length);
  return {
    chunks, bm25, graph, perQ,
    count: chunks.length,
    avgChars: Math.round(chunks.reduce((a, c) => a + c.text.length, 0) / Math.max(1, chunks.length)),
    indexRatio: chunks.reduce((a, c) => a + c.text.length, 0) / doc.C.length,
    cleanBoundaries: starts.length ? clean / starts.length : 1,
    evidenceIntact: allEv.length ? intact / allEv.length : 1,
    xrefResolved: xrefTotal ? xrefOk / xrefTotal : 1,
    partialFlat: frac("partial", "flat"), completeFlat: frac("complete", "flat"),
    partialGraph: frac("partial", "graph"), completeGraph: frac("complete", "graph"),
    avgWordsFlat: perQ.reduce((a, p) => a + p.flat.used, 0) / Math.max(1, perQ.length),
    avgWordsGraph: perQ.reduce((a, p) => a + p.graph.used, 0) / Math.max(1, perQ.length),
  };
}

export const STRATEGIES = [
  { key: "fixed", name: "고정 윈도", tag: "베이스라인", color: "#8b949e", paper: null },
  { key: "sentence", name: "문장 윈도", tag: "베이스라인 · rag.js", color: "#58a6ff", paper: null },
  { key: "struct", name: "구조 인식", tag: "StrucChunk · 2610.26313", color: "#d29922", paper: "https://arxiv.org/abs/2610.26313" },
  { key: "qesdp", name: "QES · 정확 DP", tag: "QESChunker · 2610.36557", color: "#3fb950", paper: "https://arxiv.org/abs/2610.36557" },
  { key: "qesov", name: "QES · 겹침 탐욕", tag: "QESChunker · 2610.36557", color: "#bc8cff", paper: "https://arxiv.org/abs/2610.36557" },
];

/** 컨텍스트 헤더: 청크가 닿는 provision의 제목 경로를 접두어로 붙인다. */
export function withHeadingPath(doc, chunks) {
  return chunks.map((c) => {
    const provs = [...new Set(doc.units.filter((u) => u.end > c.start && u.start < c.end && u.prov !== undefined).map((u) => u.prov))];
    if (!provs.length) return c;
    const first = doc.provisions[provs[0]];
    const rest = provs.slice(1).map((p) => doc.provisions[p].title);
    const prefix = "[" + first.path.join(" › ") + (rest.length ? " | " + rest.join(" | ") : "") + "]";
    const text = prefix + "\n" + c.text;
    return { ...c, text, words: words(text), headed: true };
  });
}

export function runLab(text, qe, { L = 450, budget = 120, evalSplit = "test", headers = false, resolveRefs = true } = {}) {
  const doc = parseDocument(text);
  const all = locateEvidence(doc, qe);
  const train = all.filter((q) => q.split === "train");
  const evSet = evalSplit === "all" ? all : all.filter((q) => q.split === evalSplit);
  const chunkSets = {
    fixed: chunkFixed(doc, L),
    sentence: chunkSentence(doc, L),
    struct: chunkStructure(doc, L, { resolveRefs }),
    qesdp: chunkQESDP(doc, L, train).chunks,
    qesov: chunkQESOverlap(doc, L, train),
  };
  if (headers) for (const k of ["fixed", "sentence", "qesdp", "qesov"]) chunkSets[k] = withHeadingPath(doc, chunkSets[k]);
  const results = {};
  for (const s of STRATEGIES) results[s.key] = evaluateStrategy(doc, chunkSets[s.key], evSet, budget);
  return { doc, evSet, all, train, results, missing: all.flatMap((q) => q.ev.filter((e) => e.s < 0).map((e) => e.text)) };
}
