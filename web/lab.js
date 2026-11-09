// "청킹 Lab" 페이지: runLab()을 돌리고 점수판·예산 곡선·경계 지도·질문 인스펙터를 그린다. 모든 계산은 로컬, 순수.
import { $, esc, settings } from "./common.js";
import { runLab, STRATEGIES, retrieve } from "./chunkLab.js";
import { LAB_TEXT, LAB_QE } from "./policyCorpus.js";

const S = { lab: null, L: settings.get("labL", 160), budget: settings.get("labBudget", 30), evalSplit: settings.get("labSplit", "test"), qi: 0, mode: settings.get("labMode", "flat") };

// 실행마다 표시되는 빌드 식별자: "옛 코드가 캐시되었나"를 아는 열쇠 (coi-sw 캐시 세대와 함께 본다)
const LAB_BUILD = "2026-11-09.2";

const pct = (p) => (p * 100).toFixed(0) + "%";

// ---- 실행 -------------------------------------------------------------------------

function run() {
  ("__labBuild" in window) || (window.__labBuild = LAB_BUILD);
  console.info(`[청킹 Lab] 빌드 ${LAB_BUILD} · SW 캐시 세대 coi-sw.js의 VERSION 확인`);
  $("runBtn").disabled = true; $("runBtn").textContent = "계산 중…";
  // runLab은 동기 계산이라 setTimeout으로 한 프레임 내여서 버튼 상태가 일단 그려진다
  setTimeout(() => {
    const t0 = performance.now();
    let qe;
    try { qe = JSON.parse($("qe").value); }
    catch (e) { done(`질문 JSON을 읽지 못했습니다: ${e.message}`); return; }
    if (!Array.isArray(qe) || !qe.length) { done("질문–근거 JSON은 [{q, evidence:[...], split}] 배열이어야 합니다."); return; }
    try {
      S.lab = runLab($("text").value, qe, { L: S.L, budget: S.budget, evalSplit: $("evalSplit").value });
      settings.set("labL", S.L); settings.set("labBudget", S.budget); settings.set("labSplit", $("evalSplit").value);
      const missingNote = S.lab.missing.length ? ` · ⚠ 미발견 근거 ${S.lab.missing.length}개: ${S.lab.missing.map((m) => `“${m.slice(0, 20)}…”`).join(", ")}` : "";
      // done() 전에 render: 렌더 오류 catch가 메시지를 뒤집을 수 있으므로, 성공 시점 순서는 render → done → 스크롤
      render();
      done(`✔ 완료 (${(performance.now() - t0).toFixed(0)} ms, 빌드 ${LAB_BUILD}) — 문서 ${S.lab.doc.C.length}자 · 단위 ${S.lab.doc.units.length}개 · provision ${S.lab.doc.provisions.length}개 · 청킹 전략 5종 점수판이 그려졌습니다${missingNote}.`);
      $("scoreboardWrap").scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (e) {
      console.error(e);
      done(`✖ 실행 실패 (${(performance.now() - t0).toFixed(0)} ms, 빌드 ${LAB_BUILD}): ` + (e?.message || e));
    }
  }, 10);
}

function done(msg) {
  $("runHint").textContent = msg;
  $("runBtn").disabled = false; $("runBtn").textContent = "실행 (모델 없이)";
}

// ---- 렌더 -------------------------------------------------------------------------

function render() {
  const lab = S.lab; if (!lab) return;
  $("labMeta").textContent = `L=${S.L}자 · 예산 ${S.budget} 단어 · ${$("evalSplit").value === "all" ? "전체" : "test"} 질문 ${lab.evSet.length}개`;
  const best = (pick) => Math.max(...STRATEGIES.map((s) => pick(lab.results[s.key])));
  $("scoreboard").innerHTML = `<table class="grid"><thead><tr><th>전략</th><th class="r">청크</th><th class="r">평균 자수</th><th class="r">인덱스 비율</th><th class="r">깨끗한 경계</th><th class="r">증거 온전</th><th class="r">xref 해결</th><th class="r">부분 flat/graph</th><th class="r">완전 flat/graph</th></tr></thead><tbody>${
    STRATEGIES.map((s) => {
      const m = lab.results[s.key];
      const hl = (v, isBest) => isBest ? " ok" : "";
      const paper = s.paper ? ` <a href="${s.paper}" target="_blank" rel="noopener">📄</a>` : "";
      return `<tr><td><b style="color:${s.color}">${esc(s.name)}</b> <span class="tag">${esc(s.tag)}</span>${paper}</td>
        <td class="r">${m.count}</td><td class="r">${m.avgChars}</td><td class="r">${m.indexRatio.toFixed(2)}</td>
        <td class="r${hl(m.cleanBoundaries, m.cleanBoundaries === best((x) => x.cleanBoundaries))}">${pct(m.cleanBoundaries)}</td>
        <td class="r">${pct(m.evidenceIntact)}</td>
        <td class="r${hl(m.xrefResolved, m.xrefResolved === best((x) => x.xrefResolved))}">${pct(m.xrefResolved)}</td>
        <td class="r">${pct(m.partialFlat)} / ${pct(m.partialGraph)}</td>
        <td class="r${hl(m.completeFlat, m.completeFlat === best((x) => x.completeFlat))}"><b>${pct(m.completeFlat)}</b> / <b>${pct(m.completeGraph)}</b></td></tr>`;
    }).join("")}</tbody></table>`;

  $("curve").innerHTML = curve();
  $("boundaries").innerHTML = boundaryMap();
  $("qsel").innerHTML = lab.evSet.map((q, i) => `<option value="${i}"${i === S.qi ? " selected" : ""}>${esc(q.q)}</option>`).join("");
  renderInspector();
}

function curve() {
  const lab = S.lab;
  const budgets = [];
  for (let b = 10; b <= 160; b += 15) budgets.push(b);
  const W = 470, H = 170, PL = 30, PB = 20;
  const x = (b) => PL + (b - 10) / 150 * (W - PL - 8);
  const y = (p) => H - PB - p * (H - PB - 8);
  let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="완전 회수 대 예산">`;
  for (const b of [10, 60, 110, 160]) svg += `<text x="${x(b) + 4}" y="${H - 5}" style="fill:var(--ink2)">${b}</text>`;
  for (const t of [0, 0.5, 1]) svg += `<text x="2" y="${y(t) + 4}" style="fill:var(--ink2)">${t}</text>`;
  // per-budget recall: 청크 집합은 예산과 무관하므로 retrieve만 반복 (저렴)
  const res = {};
  for (const s of STRATEGIES) {
    const m = lab.results[s.key];
    const bm25 = m.bm25, graph = m.graph, chunks = m.chunks;
    res[s.key] = budgets.map((b) => {
      let c = 0, cg = 0;
      for (const q of lab.evSet) {
        const rf = retrieve(chunks, bm25, graph, q.q, b, "flat");
        const rg = retrieve(chunks, bm25, graph, q.q, b, "graph");
        if (q.ev.every((e) => rf.picked.some((i) => chunks[i].text.replace(/\s+/g, " ").toLowerCase().includes(e.text.replace(/\s+/g, " ").toLowerCase())))) c++;
        if (q.ev.every((e) => rg.picked.some((i) => chunks[i].text.replace(/\s+/g, " ").toLowerCase().includes(e.text.replace(/\s+/g, " ").toLowerCase())))) cg++;
      }
      return { flat: c / Math.max(1, lab.evSet.length), graph: cg / Math.max(1, lab.evSet.length) };
    });
  }
  for (const s of STRATEGIES) {
    for (const [mode, off] of [["flat", 0], ["graph", 3.5]]) {
      const pts = res[s.key].map((p, i) => `${x(budgets[i]).toFixed(1)},${y(p[mode]).toFixed(1)}`).join(" ");
      svg += `<polyline points="${pts}" fill="none" stroke="${s.color}" stroke-width="${mode === "graph" ? 1.4 : 2.4}" stroke-dasharray="${mode === "graph" ? "3 3" : ""}" opacity="${mode === "graph" ? 0.75 : 1}"><title>${esc(s.name)} · ${mode}</title></polyline>`;
    }
  }
  svg += `<text x="${W - 60}" y="12" style="fill:var(--ink2)">실선=flat 점선=graph</text></svg>`;
  return svg += `<p class="caption">${STRATEGIES.map((s) => `<b style="color:${s.color}">■</b> ${esc(s.name)}`).join(" · ")}</p>`;
}

function boundaryMap() {
  const lab = S.lab, C = lab.doc.C.length;
  let html = `<div class="bmap">`;
  for (const s of STRATEGIES) {
    const chunks = lab.results[s.key].chunks;
    const rows = chunks.map((c, i) => `<div style="left:${(c.start / C * 100).toFixed(1)}%;width:${Math.max(0.4, ((c.end - c.start) / C * 100)).toFixed(1)}%" title="${esc(c.text.slice(0, 60).replace(/\n/g, " "))}…" data-i="${i}"></div>`).join("");
    html += `<div class="brow"><b style="color:${STRATEGIES.find((x) => x.key === s.key).color}">${esc(STRATEGIES.find((x) => x.key === s.key).name)}</b><div class="blane">${rows}</div><span class="meta">${chunks.length}</span></div>`;
  }
  html += `</div>`;
  return html;
}

function renderInspector() {
  const lab = S.lab;
  const q = lab.evSet[S.qi] || lab.evSet[0]; if (!q) { $("inspector").innerHTML = ""; return }
  let html = `<table class="grid"><thead><tr><th>전략 / 모드</th><th>집어 넣은 청크</th><th>근거</th></tr></thead><tbody>`;
  for (const s of STRATEGIES) {
    // perQ는 evSet과 같은 순서다 (chunkLab.evaluateStrategy는 qi를 붙이지 않는다)
    const q2 = lab.results[s.key].perQ[S.qi];
    if (!q2) continue;
    for (const mode of ["flat", "graph"]) {
      const r = q2[mode];
      html += `<tr><td><b style="color:${s.color}">${esc(s.name)}</b> <span class="tag">${mode}</span> <span class="meta">${r.used} 단어 · ${r.picked.length} 청크</span></td>
        <td>${r.picked.map((i) => `<mark class="pick" title="${esc(lab.results[s.key].chunks[i].text.slice(0, 80))}…">#${i + 1}</mark>`).join(" ")}</td>
        <td>${q.ev.map((e, k) => `<span class="tag ${r.found[k] ? "ok" : "bad"}">${r.found[k] ? "✓" : "✗"} ${esc(e.text.slice(0, 22))}${e.text.length > 22 ? "…" : ""}</span>`).join(" ")}</td></tr>`;
    }
  }
  $("inspector").innerHTML = html + "</tbody></table>";
}

// ---- wiring ------------------------------------------------------------------------

function wire() {
  $("text").value = settings.get("labText", LAB_TEXT);
  $("qe").value = settings.get("labQE", JSON.stringify(LAB_QE, null, 1));
  $("L").value = S.L; $("LVal").textContent = S.L;
  $("budget").value = S.budget; $("budgetVal").textContent = S.budget;
  $("evalSplit").value = S.evalSplit;
  $("runBtn").addEventListener("click", run);
  $("L").addEventListener("input", () => { S.L = +$("L").value; $("LVal").textContent = S.L; settings.set("labL", S.L); run(); });
  $("budget").addEventListener("input", () => { S.budget = +$("budget").value; $("budgetVal").textContent = S.budget; settings.set("labBudget", S.budget); run(); });
  $("evalSplit").addEventListener("change", run);
  $("qsel").addEventListener("change", () => { S.qi = +$("qsel").value; settings.set("labQi", S.qi); renderInspector(); });
  $("gsel2").addEventListener("change", (e) => { S.mode = e.target.value; settings.set("labMode", S.mode); });
  run();
}

wire();
